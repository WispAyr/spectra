#!/usr/bin/env python3
"""Four-channel NFM from the nRSP Full-IQ stream → Broadnet txsched.

Ground (busiest) is taken from the hardware NFM at device_center 455.625 —
that path already captured 6–9 s overs. IQ is only ~2 MB/s vs 8 MB/s, so
DDC audio was ~4× too short (2–4 s clips, STT failed). Fire / 455.75 stay
on IQ DDC inside the 2 MHz window. 456.7 sits on the edge and may be weak.

Keep uhf-watch stopped. Relay auto_rearm false / armed false so it does
not double-key when we park on 455.625.
"""
from __future__ import annotations

import base64
import json
import math
import threading
import time
import urllib.request

import os

import numpy as np
from scipy.signal import lfilter, sosfilt
from websocket import WebSocketApp
from websockets.sync.server import serve as ws_serve

# 10 Oct 2026: take the bridge's ÷2 halfband tap (1 Msps, ±500 kHz). The tower channels sit
# within +125 kHz of the 455.625 centre; at 2 Msps this reader fell 15 MB behind (the Python
# DDC could not keep up) and moved 64 Mbps over loopback. UHF_IQ_DECIM=1 restores full rate.
IQ_DECIM = int(os.environ.get("UHF_IQ_DECIM", "2"))
IQ_WS = "ws://127.0.0.1:3334/ws/iq" + (f"?decim={IQ_DECIM}" if IQ_DECIM > 1 else "")
HW_WS = "ws://127.0.0.1:3334/ws/audio"
RADIO = "http://127.0.0.1:3943/api/radio"
CONFIG = "http://127.0.0.1:3943/api/nrsp/config"
FFT = "http://127.0.0.1:3943/api/spectrum/fft"
SUBMIT = "http://10.200.0.29:4979/api/tx/submit"
WATCH_HZ = 455625000          # park on ground; hardware demod is this channel
FS = 2_000_000 // max(1, IQ_DECIM)      # until the hello says otherwise
AUDIO_FS = 8000                         # boxcar FS → 8 kHz (R = FS // AUDIO_FS)
R = FS // AUDIO_FS
# A channel further than this fraction of FS from the centre is outside the IQ span (or in the
# filter skirt) and is skipped. 456.7 MHz is 1.075 MHz off a 455.625 centre: even at 2 Msps
# (±1 MHz) it was aliased — its DDC was really listening to ~454.7 MHz.
SPAN_FRAC = 0.45
LO_MAX_PERIOD = 1 << 16
FRAME = 160                             # 20 ms at 8 kHz
# Gate on FFT bin power (carrier), NOT audio RMS. Unsquelched NFM noise is
# loud (~-14 dBFS) and would key hiss. Idle bins sit ~-103, live ground was
# -62 (measured 2026-09-02).
MARGIN_DB = 12.0
ABS_DB = -75.0          # open threshold (absolute floor)
ABS_HOLD = -88.0        # stay-open floor — ground speech dips below -75
HOLD_MARGIN = 6.0
HITS_NEEDED = 3
HANG_S = 2.5            # default; ground overrides via spec hang_s
STITCH_S = 2.8          # reopen inside this → same over, not a new clip
MAX_S = 90.0
MIN_S = 1.2
AUDIO_SCALE = 9000.0
MIX_PORT = 3944
# Listen mix is the hardware NFM clock (24 kHz). Broadnet stays 8 kHz.
# Mean-decimating 24→8 for the player aliased hiss into the voice band
# and the IQ thread was also stuffing 8 kHz frames onto the same socket.
MIX_SR = 24000
# 24 kHz → 8 kHz for Broadnet. Mean-of-3 folds 4–12 kHz hiss into the
# voice band (relay.py already documented this). 4th-order Butterworth
# at 3.4 kHz, then take every 3rd sample, state carried across chunks.
AA_FC = 3400.0


def _biquad_lp(fc, fs, q):
    w0 = 2.0 * math.pi * fc / fs
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2.0 * q)
    b0 = (1.0 - cw) / 2.0
    b1 = 1.0 - cw
    b2 = (1.0 - cw) / 2.0
    a0 = 1.0 + alpha
    a1 = -2.0 * cw
    a2 = 1.0 - alpha
    return (b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)


class BiquadCascade:
    def __init__(self, fs: int):
        self.fs = fs
        self.s = [_biquad_lp(AA_FC, fs, 0.54120), _biquad_lp(AA_FC, fs, 1.30656)]
        self.z = [[0.0, 0.0], [0.0, 0.0]]

    def set_fs(self, fs: int):
        if int(fs) == self.fs:
            return
        self.fs = int(fs)
        self.s = [_biquad_lp(AA_FC, self.fs, 0.54120), _biquad_lp(AA_FC, self.fs, 1.30656)]
        self.z = [[0.0, 0.0], [0.0, 0.0]]

    def run(self, xs: np.ndarray) -> np.ndarray:
        # Same transposed direct-form II as the per-sample loop it replaced (sosfilt's zi is
        # exactly [z1, z2] per section), ~50× cheaper at 24 kHz. test_uhf_iq.py checks equality.
        out = np.asarray(xs, dtype=np.float64)
        if out.size == 0:
            return out
        sos = np.array([[b0, b1, b2, 1.0, a1, a2] for (b0, b1, b2, a1, a2) in self.s])
        zi = np.array(self.z, dtype=np.float64)
        y, zf = sosfilt(sos, out, zi=zi)
        self.z = [list(map(float, row)) for row in zf]
        return y
# Live mix headline: ground is the busy ops channel, so it stays the
# labelled frequency whenever it is open. Fire still outranks ground on
# Broadnet (txsched prio 20 vs 30) so a fire call is not stuck behind a
# queue of ground overs.
KIND_PRIO = {"tower": 0, "fire": 1, "pikops": 2, "other": 9}

CHANNELS = [
    {"hz": 455625000, "kind": "tower",  "label": "EGPK ground", "hang_s": 6.0, "preroll_s": 1.0},
    {"hz": 455700000, "kind": "fire",   "label": "airport fire", "hang_s": 3.0, "preroll_s": 0.7},
    {"hz": 455750000, "kind": "pikops", "label": "PIK OPS 455.75", "hang_s": 2.5, "preroll_s": 0.5},
    {"hz": 456700000, "kind": "pikops", "label": "PIK OPS 456.7", "hang_s": 2.5, "preroll_s": 0.5},
]

# Same ident as sdr-broadnet-relay. Store-and-forward no longer keys that
# path, so the beeps have to ride on submit + the listen mix or every
# over sounds like CTL with no channel.
IDENT_TONES = {
    455625000: [(1000.0, 120)],
    455700000: [(1400.0, 90), (0.0, 70), (1400.0, 90)],
    455750000: [(1200.0, 90), (0.0, 70), (900.0, 90)],
    456700000: [(900.0, 90), (0.0, 70), (1200.0, 90)],
}
IDENT_AMP = 0.22
IDENT_FADE_MS = 8


def ident_pcm(hz: int, rate: int) -> np.ndarray:
    spec = IDENT_TONES.get(int(hz))
    if not spec:
        return np.zeros(0, dtype=np.int16)
    parts = []
    for freq, ms in spec:
        n = max(1, int(rate * ms / 1000.0))
        fade = max(1, min(n // 2, int(rate * IDENT_FADE_MS / 1000.0)))
        t = np.arange(n, dtype=np.float64)
        g = np.ones(n, dtype=np.float64)
        g[:fade] = np.linspace(0.0, 1.0, fade, endpoint=False)
        g[-fade:] = np.linspace(1.0, 0.0, fade, endpoint=False)
        if freq <= 0:
            parts.append(np.zeros(n, dtype=np.int16))
            continue
        v = np.sin(2.0 * np.pi * freq * t / rate) * IDENT_AMP * g
        parts.append(np.clip(v * 32767.0, -32767, 32767).astype(np.int16))
    return np.concatenate(parts)


class MixOverlay:
    """Ident tones + open IQ channels, mixed onto the hardware 24 kHz clock."""

    def __init__(self):
        self._lock = threading.Lock()
        self._tone = np.zeros(0, dtype=np.int16)
        self._iq = np.zeros(0, dtype=np.int16)

    def queue_tone(self, hz: int, rate: int = MIX_SR):
        t = ident_pcm(hz, rate)
        if t.size == 0:
            return
        with self._lock:
            self._tone = np.concatenate([self._tone, t]) if self._tone.size else t

    def push_iq(self, smp: np.ndarray):
        if smp is None or smp.size == 0:
            return
        with self._lock:
            self._iq = np.concatenate([self._iq, smp]) if self._iq.size else smp.copy()
            cap = AUDIO_FS * 2
            if self._iq.size > cap:
                self._iq = self._iq[-cap:]

    def mix_into(self, hw: np.ndarray, hw_rate: int) -> np.ndarray:
        out = hw.astype(np.int32)
        n24 = out.size
        ratio = max(1, int(round(hw_rate / AUDIO_FS)))
        n8 = n24 // ratio
        with self._lock:
            if self._tone.size:
                take = min(self._tone.size, n24)
                out[:take] += self._tone[:take]
                self._tone = self._tone[take:]
            if n8 and self._iq.size:
                take = min(self._iq.size, n8)
                up = np.repeat(self._iq[:take], ratio)
                self._iq = self._iq[take:]
                m = min(up.size, n24)
                out[:m] += up[:m]
        return np.clip(out, -32767, 32767).astype(np.int16)


MIX_OVERLAY = MixOverlay()


def _discover_submit():
    # Prefer loopback if we are on stream-server; else WG IP of stream-server.
    for url in (
        "http://127.0.0.1:4979/api/tx/submit",
        "http://10.200.0.29:4979/api/tx/submit",
        "http://81.88.19.220:4979/api/tx/submit",
    ):
        try:
            urllib.request.urlopen(url.replace("/submit", "/queue"), timeout=2)
            return url
        except Exception:
            continue
    return "http://10.200.0.29:4979/api/tx/submit"


def get(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def post_json(url, body, timeout=8):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def park():
    try:
        st = get(RADIO)
        if st.get("frequency") != WATCH_HZ:
            post_json(CONFIG, {"frequency": WATCH_HZ})
            time.sleep(1.2)
            print("[uhf-iq] parked", get(RADIO).get("frequency"), flush=True)
    except Exception as e:
        print(f"[uhf-iq] park: {e}", flush=True)


def bin_peak(fft, freq):
    bins = fft.get("bins") or []
    center = fft.get("frequency")
    span = fft.get("spanHz") or 2e6
    if not bins or not center:
        return None
    lo = center - span / 2.0
    frac = (freq - lo) / span
    if frac < 0.02 or frac > 0.98:
        return None
    mid = round(frac * (len(bins) - 1))
    half = max(1, round((12500 / span) * len(bins) / 2))
    sl = bins[max(0, mid - half): min(len(bins) - 1, mid + half) + 1]
    return max(sl) if sl else None


def fft_loop(chans, stop):
    while not stop.is_set():
        try:
            fft = get(FFT)
            bins = fft.get("bins") or []
            if bins:
                s = sorted(bins)
                nf = s[len(s) // 2]
                open_th = max(nf + MARGIN_DB, ABS_DB)
                hold_th = max(nf + HOLD_MARGIN, ABS_HOLD)
                for c in chans:
                    p = bin_peak(fft, c.spec["hz"])
                    c.fft_db = p if p is not None else -120.0
                    th = hold_th if c.open else open_th
                    c.fft_hot = p is not None and p >= th
        except Exception:
            pass
        stop.wait(0.15)


def lo_table(offset_hz: int, fs: int):
    """Exact periodic local oscillator exp(-j·2π·off·n/fs) when it repeats within
    LO_MAX_PERIOD samples (off/fs rational with a small denominator — every channel here is a
    multiple of 25 kHz), else None and the caller falls back to np.exp per chunk."""
    off, fs = int(offset_hz), int(fs)
    if fs <= 0:
        return None
    period = fs // math.gcd(abs(off), fs) if off else 1
    if period > LO_MAX_PERIOD:
        return None
    n = np.arange(period, dtype=np.float64)
    return np.exp(-2j * np.pi * off * n / fs).astype(np.complex64)


def discriminator_iir(st, ang: np.ndarray) -> np.ndarray:
    """dc strip + de-emphasis + LPF on the FM discriminator output, state on `st`
    (.dc .deemph .lpf = last outputs). Identical to the original per-sample loop:
        dc = 0.9995·dc + 0.0005·a;  x = a − dc;  de += 0.45·(x − de);  lp += 0.6·(de − lp)
    as three first-order lfilters (zi = −a1·y[n−1])."""
    if ang.size == 0:
        return ang.astype(np.float64)
    dc, zf = lfilter([0.0005], [1.0, -0.9995], ang, zi=[0.9995 * st.dc])
    x = ang - dc
    de, zf2 = lfilter([0.45], [1.0, -0.55], x, zi=[0.55 * st.deemph])
    lp, zf3 = lfilter([0.6], [1.0, -0.4], de, zi=[0.4 * st.lpf])
    st.dc, st.deemph, st.lpf = float(dc[-1]), float(de[-1]), float(lp[-1])
    return lp


class Chan:
    def __init__(self, spec, center, fs: int = FS):
        self.spec = spec
        self.center = int(center)
        self.fs = int(fs)
        self.r = max(1, self.fs // AUDIO_FS)
        self.w = 2 * np.pi * (spec["hz"] - center) / self.fs
        self.lo = None
        self.lo_i = 0
        self.in_span = True
        self._retable()
        self.phi = 0.0
        self.prev = 0 + 0j
        self.dc = 0.0
        self.deemph = 0.0
        self.lpf = 0.0
        self.pcm = bytearray()
        self.pcm24 = np.zeros(0, dtype=np.int16)
        self.preroll = bytearray()
        self.above = 0
        self.open = False
        self.fft_hot = False
        self.fft_db = -120.0
        self.last_hot = 0.0
        self.opened_at = 0.0
        self._rem = np.zeros(0, dtype=np.complex64)
        self.tick_frames: list[np.ndarray] = []
        self._hold_pcm = None
        self._hold_pcm24 = None
        self._hold_at = 0.0
        self._flush_timer = None
        self.hang_s = float(spec.get("hang_s") or HANG_S)
        self.preroll_bytes = int(FRAME * 2 * (spec.get("preroll_s") or 0.5) / 0.02)
        self.mag = 0.0
        self.mag_floor = None
        self.mag_hot = False
        self.radio_hot = False

    def _retable(self):
        off = int(self.spec["hz"]) - self.center
        was = self.in_span
        self.in_span = abs(off) <= SPAN_FRAC * self.fs
        if not self.in_span and was and self.spec.get("kind") != "tower":  # ground rides the hardware NFM path
            print(f"[uhf-iq] {self.spec['label']} is {off/1e3:+.0f} kHz off centre, outside ±{SPAN_FRAC*self.fs/1e3:.0f} kHz of the "
                  f"{self.fs/1e6:g} Msps tap — skipped", flush=True)
        self.w = 2 * np.pi * off / self.fs
        self.lo = lo_table(off, self.fs)
        self.lo_i = 0
        self.phi = 0.0
        self._rem = np.zeros(0, dtype=np.complex64)

    def set_center(self, center):
        self.center = int(center)
        self._retable()

    def set_rate(self, fs: int):
        fs = int(fs)
        if fs == self.fs:
            return
        self.fs = fs
        self.r = max(1, fs // AUDIO_FS)
        self._retable()

    def _mix(self, iq: np.ndarray) -> np.ndarray:
        n = iq.shape[0]
        if self.lo is not None:
            idx = (self.lo_i + np.arange(n)) % self.lo.size
            self.lo_i = (self.lo_i + n) % self.lo.size
            return iq * self.lo[idx]
        ph = self.phi + self.w * np.arange(n, dtype=np.float64)
        self.phi = (self.phi + self.w * n) % (2 * np.pi)
        return iq * np.exp(-1j * ph).astype(np.complex64)

    def process(self, iq: np.ndarray):
        self.tick_frames = []
        if not self.in_span:
            return
        R = self.r
        mix = self._mix(iq)
        if self._rem.size:
            mix = np.concatenate([self._rem, mix])
        usable = (mix.size // R) * R
        if usable < R:
            self._rem = mix
            return
        self._rem = mix[usable:]
        dec = mix[:usable].reshape(-1, R).mean(axis=1)
        # FM discriminate
        z = np.empty_like(dec)
        z[0] = dec[0] * np.conj(self.prev) if self.prev != 0 else dec[0]
        z[1:] = dec[1:] * np.conj(dec[:-1])
        self.prev = dec[-1]
        ang = np.angle(z).astype(np.float64)
        out = discriminator_iir(self, ang)
        smp = np.clip(out * AUDIO_SCALE, -32767, 32767).astype(np.int16)
        mag = float(np.sqrt(np.mean(np.abs(dec) ** 2) + 1e-12))
        self.mag = mag
        if self.mag_floor is None:
            self.mag_floor = mag
        elif not self.open:
            self.mag_floor = 0.98 * self.mag_floor + 0.02 * mag
        # DDC magnitude stay-open: the 2 MHz FFT bin goes cold mid-over
        # (4.42 s clip still had speech after the bin dropped).
        self.mag_hot = mag >= max((self.mag_floor or 0) * 2.2, 40.0)
        self._gate(smp)

    def _gate(self, smp: np.ndarray):  # noqa: C901 (unchanged)
        now = time.time()
        nfr = smp.size // FRAME
        if nfr == 0:
            return
        frames = smp[: nfr * FRAME].reshape(nfr, FRAME)
        for fr in frames:
            self.tick_frames.append(fr)
            raw = fr.tobytes()
            if not self.open:
                self.preroll.extend(raw)
                if len(self.preroll) > self.preroll_bytes:
                    del self.preroll[: len(self.preroll) - self.preroll_bytes]
            # Ground: hardware squelch is the real over length. FFT/mag only
            # assist. Other channels: FFT opens, mag holds.
            if self.spec.get("kind") == "tower":
                # Parked on 455.625 the FFT bin is the DC spike (~-62 idle) and
                # is not a carrier. Hardware squelch/RSSI is the over.
                hot = self.radio_hot
            else:
                hot = self.fft_hot or (self.open and self.mag_hot)
            if hot:
                self.above += 1
                self.last_hot = now
            else:
                self.above = 0
            if not self.open:
                if self.above >= HITS_NEEDED:
                    self.open = True
                    if self._flush_timer:
                        self._flush_timer.cancel()
                        self._flush_timer = None
                    if self._hold_pcm and (now - self._hold_at) <= STITCH_S:
                        self.pcm = bytearray(self._hold_pcm)
                        self.pcm.extend(raw)
                        self._hold_pcm = None
                        if self._hold_pcm24 is not None and getattr(self._hold_pcm24, "size", 0):
                            self.pcm24 = self._hold_pcm24
                        self._hold_pcm24 = None
                        self.last_hot = now
                        print(
                            f"[uhf-iq] RESUME {self.spec['label']} fft={self.fft_db:.1f} dB",
                            flush=True,
                        )
                    else:
                        self._hold_pcm = None
                        self._hold_pcm24 = None
                        self.pcm24 = np.zeros(0, dtype=np.int16)
                        self.opened_at = now
                        self.last_hot = now
                        self.pcm = bytearray(self.preroll) + raw
                        print(
                            f"[uhf-iq] OPEN {self.spec['label']} fft={self.fft_db:.1f} dB",
                            flush=True,
                        )
                        MIX_OVERLAY.queue_tone(self.spec["hz"], MIX_SR)
                        if self.spec.get("kind") != "tower" and self.pcm:
                            MIX_OVERLAY.push_iq(np.frombuffer(bytes(self.pcm), dtype="<i2"))
                continue
            self.pcm.extend(raw)
            if self.spec.get("kind") != "tower":
                MIX_OVERLAY.push_iq(fr)
            if (now - self.opened_at) >= MAX_S or (
                not hot and (now - self.last_hot) >= self.hang_s
            ):
                self._close()

    def _close(self):
        self.open = False
        pcm = bytes(self.pcm)
        self.pcm = bytearray()
        self.above = 0
        self._hold_pcm = pcm
        self._hold_pcm24 = self.pcm24
        self.pcm24 = np.zeros(0, dtype=np.int16)
        self._hold_at = time.time()
        if self._flush_timer:
            self._flush_timer.cancel()
        self._flush_timer = threading.Timer(STITCH_S, self._flush_hold)
        self._flush_timer.daemon = True
        self._flush_timer.start()
        print(
            f"[uhf-iq] HOLD {self.spec['label']} {len(pcm)/2/AUDIO_FS:.2f}s (stitch {STITCH_S:.1f}s)",
            flush=True,
        )

    def _flush_hold(self):
        pcm = self._hold_pcm
        pcm24 = self._hold_pcm24
        self._hold_pcm = None
        self._hold_pcm24 = None
        self._flush_timer = None
        if not pcm or self.open:
            return
        dur = len(pcm) / 2 / AUDIO_FS
        if dur < MIN_S:
            print(f"[uhf-iq] DROP short {self.spec['label']} {dur:.2f}s", flush=True)
            return
        print(f"[uhf-iq] CLOSE {self.spec['label']} {dur:.2f}s — submit", flush=True)
        threading.Thread(target=submit_over, args=(self.spec, pcm, pcm24), daemon=True).start()


SUBMIT_URL = None
MIX_CLIENTS: set = set()
MIX_LOCK = threading.Lock()
MIX_LAST_HZ = None


def mix_broadcast(pcm: bytes, meta: dict | None):
    global MIX_LAST_HZ
    dead = []
    hz = (meta or {}).get("centerHz")
    send_meta = meta is not None and hz != MIX_LAST_HZ
    if send_meta:
        MIX_LAST_HZ = hz
    payload_meta = json.dumps(meta) if send_meta and meta else None
    with MIX_LOCK:
        clients = list(MIX_CLIENTS)
        for c in clients:
            try:
                if payload_meta:
                    c.send(payload_meta)
                c.send(pcm)
            except Exception:
                dead.append(c)
        for c in dead:
            MIX_CLIENTS.discard(c)


def mix_handler(conn):
    try:
        conn.send(json.dumps({"sampleRate": MIX_SR, "format": "s16le"}))
    except Exception:
        return
    with MIX_LOCK:
        MIX_CLIENTS.add(conn)
    print(f"[uhf-iq] mix client +1 n={len(MIX_CLIENTS)}", flush=True)
    try:
        for _ in conn:
            pass
    except Exception:
        pass
    finally:
        with MIX_LOCK:
            MIX_CLIENTS.discard(conn)
        print(f"[uhf-iq] mix client -1 n={len(MIX_CLIENTS)}", flush=True)


def mix_server():
    print(f"[uhf-iq] mix WS on 0.0.0.0:{MIX_PORT}", flush=True)
    with ws_serve(mix_handler, "0.0.0.0", MIX_PORT) as server:
        server.serve_forever()


def mix_from_chans(chans: list[Chan]):
    n = max((len(c.tick_frames) for c in chans), default=0)
    if n == 0:
        return
    for i in range(n):
        acc = np.zeros(FRAME, dtype=np.int32)
        active = []
        for c in chans:
            if not c.open or i >= len(c.tick_frames):
                continue
            acc += c.tick_frames[i].astype(np.int32)
            active.append(c)
        mix = np.clip(acc, -32767, 32767).astype(np.int16)
        if active:
            active.sort(key=lambda c: KIND_PRIO.get(c.spec["kind"], 9))
            top = active[0]
            meta = {
                "sampleRate": AUDIO_FS,
                "centerHz": top.spec["hz"],
                "frequency": top.spec["hz"],
                "channels": [{"hz": c.spec["hz"], "label": c.spec["label"]} for c in active],
            }
        else:
            meta = {"sampleRate": AUDIO_FS, "channels": []}
        mix_broadcast(mix.tobytes(), meta)


def submit_over(spec, pcm, pcm24=None):
    global SUBMIT_URL
    if not SUBMIT_URL:
        SUBMIT_URL = _discover_submit()
    # Whole-over 24 kHz → 8 kHz. Per-chunk decimate joined every ~50 ms and
    # Speex turned those joins into the "sampling" sound on Broadnet.
    if pcm24 is not None and getattr(pcm24, "size", 0) > 48:
        try:
            from scipy.signal import resample_poly
            y = resample_poly(pcm24.astype(np.float64), AUDIO_FS, MIX_SR)
            pcm = np.clip(np.round(y), -32767, 32767).astype(np.int16).tobytes()
        except Exception as e:
            print(f"[uhf-iq] resample24 failed: {e}", flush=True)
    tone = ident_pcm(spec["hz"], AUDIO_FS)
    if tone.size:
        pcm = tone.tobytes() + pcm
    body = {
        "interface": "wispayr-primary",
        "kind": spec["kind"],
        "label": spec["label"],
        "hz": spec["hz"],
        # Queue-arrival, not over-start. Age is measured from captured_at and
        # tower max_age is 25s, so a 24–52s ground over timestamped at PTT is
        # already stale and never airs.
        "captured_at": time.time(),
        "pcm_b64": base64.b64encode(pcm).decode("ascii"),
    }
    try:
        rec = post_json(SUBMIT_URL, body, timeout=15)
        print(f"[uhf-iq] queued {spec['label']} {rec}", flush=True)
    except Exception as e:
        print(f"[uhf-iq] submit FAILED {spec['label']}: {e}", flush=True)


class App:
    def __init__(self):
        self.center = WATCH_HZ
        self.sr = FS
        self.chans = [Chan(s, self.center, FS) for s in CHANNELS]
        self._hello = None
        self._last_park = 0.0
        self._iq_bytes = 0
        self._t0 = time.time()

    def on_open(self, ws):
        print("[uhf-iq] ws open", flush=True)

    def on_message(self, ws, msg):
        if isinstance(msg, str):
            try:
                self._hello = json.loads(msg)
            except Exception:
                return
            sr = int(self._hello.get("sampleRate") or FS)
            ctr = int(self._hello.get("centerHz") or WATCH_HZ)
            print(f"[uhf-iq] hello sr={sr} center={ctr} decim={self._hello.get('decim', 1)}", flush=True)
            if sr % AUDIO_FS:
                print(f"[uhf-iq] sample rate {sr} is not a multiple of {AUDIO_FS} — IQ channels idle until it is", flush=True)
            self.sr = sr
            for c in self.chans:
                c.set_rate(sr)
            if ctr:
                self.set_center(ctr, "hello")
            return
        if not isinstance(msg, (bytes, bytearray)):
            return
        buf = np.frombuffer(msg, dtype="<i2")
        if buf.size < 4 or (buf.size & 1):
            return
        if self.sr % AUDIO_FS:
            return
        cpx = buf.astype(np.float32).view(np.complex64)
        self._iq_bytes += len(msg)
        for c in self.chans:
            if c.spec.get("kind") == "tower":
                continue  # hardware /ws/audio — IQ DDC was 4× too short
            c.process(cpx)
        # Listen mix is hardware-clocked at 24 kHz. Broadcasting IQ frames
        # here interleaved a second 8 kHz clock onto the player socket.
        now = time.time()
        if now - self._t0 >= 10:
            rate = self._iq_bytes / (now - self._t0) / 1e6
            mags = " ".join(f"{c.spec['label'].split()[-1]}={c.mag:.0f}/{c.mag_floor or 0:.0f}" for c in self.chans)
            print(f"[uhf-iq] iq {rate:.2f} MB/s sr={self.sr} center={self.center} mag {mags}", flush=True)
            self._iq_bytes = 0
            self._t0 = now
        if now - self._last_park >= 20:
            self._last_park = now
            threading.Thread(target=self.park_and_refresh, daemon=True).start()

    def set_center(self, ctr: int, why: str):
        ctr = int(ctr)
        if ctr == self.center:
            return
        print(f"[uhf-iq] centre {self.center} -> {ctr} ({why})", flush=True)
        self.center = ctr
        for c in self.chans:
            c.set_center(ctr)

    def park_and_refresh(self):
        """Park on ground, then trust the device config for the centre. The bridge's hello could go
        stale (10 Oct 2026: 30 h DDC-ing fire/PIK OPS at a "100 MHz" centre, overs sent as noise)."""
        park()
        try:
            f = int(get(CONFIG).get("frequency") or 0)
            if f:
                self.set_center(f, "nrsp/config")
        except Exception as e:
            print(f"[uhf-iq] config refresh: {e}", flush=True)

    def on_error(self, ws, err):
        print(f"[uhf-iq] ws error {err}", flush=True)

    def on_close(self, ws, code, reason):
        print(f"[uhf-iq] ws close {code} {reason}", flush=True)


def radio_loop(chans, stop):
    ground = next((c for c in chans if c.spec.get("kind") == "tower"), None)
    while not stop.is_set():
        try:
            d = get(RADIO)
            f = d.get("frequency") or 0
            pwr = d.get("signalPower")
            sq = bool(d.get("squelchOpen"))
            on_gnd = abs(f - 455625000) <= 4000
            if ground is not None:
                # 2026-09-19: dropped `or pwr >= -102`. That clause BYPASSED the
                # hardware squelch and sat only ~4 dB above the noise floor
                # (measured p50 -106.6), so any upward drift of the channel --
                # and this one has moved 19 dB across three measurements --
                # made ground permanently hot and aired 8-18s of hiss as a
                # tower over (STT: "no readable speech (carrier/noise only)").
                # It also contradicted itself: with the squelch CLOSED the audio
                # is muted, yet pwr alone could still call the channel hot.
                # Hardware squelch is the real over length (see HardwareGround).
                # Real speech at -80 clears the -96 squelch with 16 dB to spare.
                ground.radio_hot = on_gnd and sq
        except Exception:
            pass
        stop.wait(0.12)


class HardwareGround:
    """24 kHz hardware NFM (device centre) → 8 kHz frames on the ground Chan."""

    def __init__(self, chan: Chan, all_chans: list[Chan]):
        self.chan = chan
        self.all_chans = all_chans
        self.rate = 24000
        self._aa = BiquadCascade(24000)
        self._aa_rem = np.zeros(0, dtype=np.float64)
        self._pre24 = np.zeros(0, dtype=np.int16)

    def on_open(self, ws):
        print("[uhf-iq] hardware audio open", flush=True)

    def on_message(self, ws, msg):
        if isinstance(msg, str):
            try:
                meta = json.loads(msg)
                if meta.get("sampleRate"):
                    self.rate = int(meta["sampleRate"])
                    self._aa.set_fs(self.rate)
                    print(f"[uhf-iq] hardware audio sr={self.rate} center={meta.get('centerHz')}", flush=True)
            except Exception:
                pass
            return
        if not isinstance(msg, (bytes, bytearray)):
            return
        x = np.frombuffer(msg, dtype="<i2")
        if x.size < 2:
            return
        # Live listen at native hardware rate (24 kHz). Device squelch
        # already zeros idle. Do not mean-decimate this path: 24→8 with a
        # 3-sample average folds hiss into the voice band.
        open_chans = []
        if self.chan.radio_hot or self.chan.open:
            open_chans.append({"hz": 455625000, "label": "EGPK ground"})
        for c in self.all_chans:
            if c.spec.get("kind") != "tower" and c.open:
                open_chans.append({"hz": c.spec["hz"], "label": c.spec["label"]})
        if open_chans:
            top = open_chans[0]
            meta = {
                "sampleRate": self.rate,
                "centerHz": top["hz"],
                "frequency": top["hz"],
                "channels": open_chans,
            }
        else:
            meta = {"sampleRate": self.rate, "channels": []}
        mixed = MIX_OVERLAY.mix_into(x, self.rate)
        mix_broadcast(mixed.tobytes(), meta)
        pre_n = max(1, int(self.rate * float(self.chan.spec.get("preroll_s") or 1.0)))
        self._pre24 = np.concatenate([self._pre24, x])
        if self._pre24.size > pre_n:
            self._pre24 = self._pre24[-pre_n:]
        # Broadnet still wants 8 kHz frames for hang/gate. Low-pass at 24 kHz
        # first, then take every Nth sample.
        dec = max(1, int(round(self.rate / AUDIO_FS)))
        filt = self._aa.run(x)
        if self._aa_rem.size:
            filt = np.concatenate([self._aa_rem, filt])
        n = (filt.size // dec) * dec
        if n < dec:
            self._aa_rem = filt
            return
        self._aa_rem = filt[n:]
        smp = np.clip(filt[:n:dec], -32767, 32767).astype(np.int16)
        self.chan.tick_frames = []
        self.chan._gate(smp)
        # 24 kHz master for the over (resampled as a whole at submit). After
        # _gate so OPEN/CLOSE has already reset pcm24.
        if self.chan.open:
            if self.chan.pcm24.size == 0:
                self.chan.pcm24 = self._pre24.copy()
            else:
                self.chan.pcm24 = np.concatenate([self.chan.pcm24, x])

    def on_error(self, ws, err):
        print(f"[uhf-iq] hardware audio error {err}", flush=True)

    def on_close(self, ws, code, reason):
        print(f"[uhf-iq] hardware audio close {code} {reason}", flush=True)

    def run(self):
        while True:
            ws = WebSocketApp(
                HW_WS,
                on_open=self.on_open,
                on_message=self.on_message,
                on_error=self.on_error,
                on_close=self.on_close,
            )
            ws.run_forever(ping_interval=20, ping_timeout=10)
            print("[uhf-iq] hardware audio reconnect in 2s", flush=True)
            time.sleep(2)


def main():
    global SUBMIT_URL
    park()
    SUBMIT_URL = _discover_submit()
    print(f"[uhf-iq] submit {SUBMIT_URL}", flush=True)
    app = App()
    stop = threading.Event()
    threading.Thread(target=fft_loop, args=(app.chans, stop), daemon=True).start()
    threading.Thread(target=radio_loop, args=(app.chans, stop), daemon=True).start()
    ground = next((c for c in app.chans if c.spec.get("kind") == "tower"), None)
    if ground is not None:
        hw = HardwareGround(ground, app.chans)
        threading.Thread(target=hw.run, daemon=True).start()
    threading.Thread(target=mix_server, daemon=True).start()
    while True:
        ws = WebSocketApp(
            IQ_WS,
            on_open=app.on_open,
            on_message=app.on_message,
            on_error=app.on_error,
            on_close=app.on_close,
        )
        ws.run_forever(ping_interval=20, ping_timeout=10)
        print("[uhf-iq] reconnect in 2s", flush=True)
        time.sleep(2)
        park()


if __name__ == "__main__":
    main()
