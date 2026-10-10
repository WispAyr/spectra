#!/usr/bin/env python3
"""Watch all four EGPK UHF ops channels at once, then centre-tune for audio.

The nRSP-ST samples 2 MHz IQ. Parking device_center at 456.1625 puts
455.625 / 455.700 / 455.750 / 456.700 inside one FFT. Hardware NFM audio
follows device_center, not VFO, so the midpoint demod is silent — we use
the FFT as the simultaneous detector and only move the centre onto a
channel when its bin is hot (measured 2026-09-02: ground bin -62 while
midpoint signal_power stayed -118).

Does not start /api/chanscan. Keep relay scan_mode/scan_keeper false.
"""
from __future__ import annotations

import json
import time
import urllib.request

RADIO = "http://127.0.0.1:3943/api/radio"
FFT = "http://127.0.0.1:3943/api/spectrum/fft"
PRESETS = "http://127.0.0.1:3943/api/presets"
CONFIG = "http://127.0.0.1:3943/api/nrsp/config"
SCAN = "http://127.0.0.1:3943/api/chanscan"

WATCH_HZ = 456162500
OPEN_DBM = -105.0
MARGIN_DB = 10.0
ABS_DB = -90.0          # idle bins sit -108..-100; live ground was -62
HITS_NEEDED = 2
SETTLE_S = 1.6
HANG_S = 2.0
POLL_S = 0.25
WATCH_POLL_S = 0.2

CYCLE = [
    ("p455625000-227152452", 455625000, "EGPK ground"),
    ("p455700000-1484033606", 455700000, "airport fire"),
    ("p455750000-1239598523", 455750000, "PIK OPS 455.75"),
    ("p456700000-1484032645", 456700000, "PIK OPS 456.7"),
]


def get(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def post(url, body=None, timeout=8):
    data = json.dumps(body if body is not None else {}).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


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


def median(vals):
    s = sorted(vals)
    return s[len(s) // 2]


def park_watch():
    post(CONFIG, {"frequency": WATCH_HZ})
    time.sleep(SETTLE_S)


def activate(pid):
    post(f"{PRESETS}/{pid}/activate")
    time.sleep(SETTLE_S)


def busy(st):
    pwr = st.get("signalPower")
    return bool(st.get("squelchOpen")) or (pwr is not None and pwr >= OPEN_DBM)


def wait_hang():
    hung = time.time()
    while True:
        time.sleep(POLL_S)
        try:
            st = get(RADIO)
        except Exception:
            return
        if busy(st):
            hung = time.time()
        elif time.time() - hung >= HANG_S:
            return


def main():
    print("[uhf-watch] start — FFT watch at 456.1625, centre-tune on hit", flush=True)
    hits = {c[1]: 0 for c in CYCLE}
    parked = False
    while True:
        try:
            if get(SCAN).get("running"):
                print("[uhf-watch] chanscan running — backing off", flush=True)
                time.sleep(10)
                parked = False
                continue
        except Exception as e:
            print(f"[uhf-watch] scan status: {e}", flush=True)

        try:
            radio = get(RADIO)
        except Exception as e:
            print(f"[uhf-watch] radio: {e}", flush=True)
            time.sleep(2)
            continue

        if busy(radio) and radio.get("frequency") != WATCH_HZ:
            wait_hang()
            parked = False
            continue

        if radio.get("frequency") != WATCH_HZ:
            try:
                park_watch()
                parked = True
                st = get(RADIO)
                print(
                    f"[uhf-watch] PARK f={st.get('frequency')} bw={st.get('deviceBandwidth')} "
                    f"pwr={st.get('signalPower')} deemph={st.get('nfmDeemphasis')}",
                    flush=True,
                )
            except Exception as e:
                print(f"[uhf-watch] park failed: {e}", flush=True)
                time.sleep(2)
            continue

        parked = True
        try:
            fft = get(FFT)
        except Exception as e:
            print(f"[uhf-watch] fft: {e}", flush=True)
            time.sleep(1)
            continue

        bins = fft.get("bins") or []
        if not bins:
            time.sleep(WATCH_POLL_S)
            continue
        nf = median(bins)
        thresh = max(nf + MARGIN_DB, ABS_DB)
        winner = None
        best = -999
        for pid, freq, label in CYCLE:
            p = bin_peak(fft, freq)
            if p is None:
                hits[freq] = 0
                continue
            if p >= thresh:
                hits[freq] += 1
                if hits[freq] >= HITS_NEEDED and p > best:
                    winner = (pid, freq, label, p, nf)
                    best = p
            else:
                hits[freq] = 0

        if not winner:
            time.sleep(WATCH_POLL_S)
            continue

        pid, freq, label, p, nf = winner
        print(f"[uhf-watch] HIT {label} bin={p:.1f} floor={nf:.1f} — centre-tune", flush=True)
        try:
            activate(pid)
            st = get(RADIO)
            print(
                f"[uhf-watch] LOCK {label} f={st.get('frequency')} pwr={st.get('signalPower')} "
                f"sq={st.get('squelchOpen')} bw={st.get('deviceBandwidth')}",
                flush=True,
            )
        except Exception as e:
            print(f"[uhf-watch] lock failed: {e}", flush=True)
            parked = False
            continue
        hits = {c[1]: 0 for c in CYCLE}
        if busy(get(RADIO)):
            wait_hang()
        parked = False


if __name__ == "__main__":
    main()
