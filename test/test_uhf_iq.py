"""uhf-iq.py DSP checks (10 Oct 2026). Run: python3 -m unittest discover -s test -p 'test_*.py'"""
import importlib.util
import pathlib
import sys
import types
import unittest

import numpy as np
from scipy.signal import resample_poly

# uhf-iq imports websocket-client / websockets at module level; the DSP doesn't need them.
for name in ("websocket", "websockets", "websockets.sync", "websockets.sync.server"):
    mod = types.ModuleType(name)
    mod.WebSocketApp = object
    mod.serve = lambda *a, **k: None
    sys.modules.setdefault(name, mod)

spec = importlib.util.spec_from_file_location("uhf_iq", pathlib.Path(__file__).resolve().parents[1] / "uhf-iq.py")
uhf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uhf)


def ref_biquad(sections, z, xs):
    """The per-sample loop BiquadCascade.run used before 10 Oct 2026."""
    out = np.asarray(xs, dtype=np.float64)
    for i, (b0, b1, b2, a1, a2) in enumerate(sections):
        z1, z2 = z[i]
        y = np.empty_like(out)
        for n, x in enumerate(out):
            yn = b0 * x + z1
            z1 = b1 * x - a1 * yn + z2
            z2 = b2 * x - a2 * yn
            y[n] = yn
        z[i] = [z1, z2]
        out = y
    return out


def ref_iir(state, ang):
    dc, de, lp = state
    out = np.empty(ang.size)
    for i, a in enumerate(ang):
        dc = 0.9995 * dc + 0.0005 * a
        x = a - dc
        de = de + 0.45 * (x - de)
        lp = lp + 0.6 * (de - lp)
        out[i] = lp
    state[:] = [dc, de, lp]
    return out


def nfm(offset_hz, fs, seconds=0.5, tone=1000.0, dev=2500.0, amp=6000.0, noise=200.0, seed=1):
    rng = np.random.default_rng(seed)
    n = int(fs * seconds)
    t = np.arange(n) / fs
    phase = 2 * np.pi * offset_hz * t + (dev / tone) * np.sin(2 * np.pi * tone * t)
    x = amp * np.exp(1j * phase) + noise * (rng.standard_normal(n) + 1j * rng.standard_normal(n))
    return x.astype(np.complex64)


def run_chan(chan, iq, chunk=8192):
    got = []
    chan._gate = lambda smp: got.append(smp.copy())
    for k in range(0, iq.size, chunk):
        chan.process(iq[k:k + chunk])
    return np.concatenate(got).astype(np.float64)


class Filters(unittest.TestCase):
    def test_biquad_matches_the_per_sample_loop_across_chunks(self):
        rng = np.random.default_rng(0)
        x = rng.standard_normal(6000) * 3000
        bc = uhf.BiquadCascade(24000)
        z = [[0.0, 0.0], [0.0, 0.0]]
        for a, b in ((0, 1), (1, 777), (777, 2500), (2500, 6000)):
            np.testing.assert_allclose(bc.run(x[a:b]), ref_biquad(bc.s, z, x[a:b]), rtol=1e-9, atol=1e-6)

    def test_discriminator_iir_matches_the_per_sample_loop(self):
        rng = np.random.default_rng(2)
        ang = rng.uniform(-np.pi, np.pi, 5000)
        st = types.SimpleNamespace(dc=0.0, deemph=0.0, lpf=0.0)
        ref = [0.0, 0.0, 0.0]
        for a, b in ((0, 1), (1, 1600), (1600, 5000)):
            np.testing.assert_allclose(uhf.discriminator_iir(st, ang[a:b]), ref_iir(ref, ang[a:b]), rtol=1e-9, atol=1e-9)


class Mixer(unittest.TestCase):
    def test_lo_table_equals_exp_mixing_across_chunks(self):
        fs = 1_000_000
        for off in (75_000, 125_000, -75_000, 0, 12_500):
            lo = uhf.lo_table(off, fs)
            self.assertIsNotNone(lo)
            n = 50_003
            want = np.exp(-2j * np.pi * off * np.arange(n) / fs)
            got, i = [], 0
            for size in (1, 39, 8192, 41_771):
                idx = (i + np.arange(size)) % lo.size
                got.append(lo[idx]); i = (i + size) % lo.size
            np.testing.assert_allclose(np.concatenate(got), want, atol=2e-5)

    def test_lo_table_refuses_awkward_ratios(self):
        self.assertIsNone(uhf.lo_table(1, 999_983))


class Channels(unittest.TestCase):
    def test_decimated_tap_gives_the_same_audio_as_full_rate(self):
        """455.7 (fire, +75 kHz): Chan at 2 Msps vs the ÷2 tap at 1 Msps (scipy stand-in for the halfband)."""
        spec_fire = next(c for c in uhf.CHANNELS if c["kind"] == "fire")
        iq2 = nfm(spec_fire["hz"] - uhf.WATCH_HZ, 2_000_000)
        iq1 = resample_poly(iq2, 1, 2).astype(np.complex64)
        a = run_chan(uhf.Chan(spec_fire, uhf.WATCH_HZ, 2_000_000), iq2)
        b = run_chan(uhf.Chan(spec_fire, uhf.WATCH_HZ, 1_000_000), iq1)
        n = min(a.size, b.size) - 400
        a, b = a[400:n], b[400:n]
        corr = np.corrcoef(a, b)[0, 1]
        self.assertGreater(corr, 0.98, corr)
        self.assertLess(abs(20 * np.log10(np.std(b) / np.std(a))), 0.5)

    def test_fire_audio_is_a_1khz_tone(self):
        spec_fire = next(c for c in uhf.CHANNELS if c["kind"] == "fire")
        iq = nfm(spec_fire["hz"] - uhf.WATCH_HZ, 1_000_000)
        out = run_chan(uhf.Chan(spec_fire, uhf.WATCH_HZ, 1_000_000), iq)[800:]
        f = np.fft.rfftfreq(out.size, 1 / uhf.AUDIO_FS)
        peak = f[np.argmax(np.abs(np.fft.rfft(out * np.hanning(out.size))))]
        self.assertAlmostEqual(peak, 1000.0, delta=20)

    def test_wrong_centre_hears_nothing_right_centre_hears_the_over(self):
        spec_fire = next(c for c in uhf.CHANNELS if c["kind"] == "fire")
        iq = nfm(spec_fire["hz"] - uhf.WATCH_HZ, 1_000_000)
        ch = uhf.Chan(spec_fire, 100_000_000, 1_000_000)  # the stale hello of 9–10 Oct
        self.assertFalse(ch.in_span)
        ch.set_center(uhf.WATCH_HZ)
        self.assertTrue(ch.in_span)
        self.assertGreater(np.std(run_chan(ch, iq)), 100)

    def test_456_7_is_out_of_span_and_skipped(self):
        spec_far = next(c for c in uhf.CHANNELS if c["hz"] == 456700000)
        for fs in (1_000_000, 2_000_000):
            ch = uhf.Chan(spec_far, uhf.WATCH_HZ, fs)
            self.assertFalse(ch.in_span, fs)
            got = []
            ch._gate = lambda smp: got.append(smp)
            ch.process(nfm(0, fs, 0.05))
            self.assertEqual(got, [])

    def test_hello_sets_rate_and_centre(self):
        app = uhf.App()
        app.on_message(None, '{"sampleRate":1000000,"centerHz":455625000,"decim":2}')
        self.assertEqual(app.sr, 1_000_000)
        self.assertTrue(all(c.fs == 1_000_000 and c.r == 125 for c in app.chans))
        app.on_message(None, '{"sampleRate":2000000,"centerHz":100000000}')
        self.assertEqual(app.center, 100_000_000)
        self.assertTrue(all(not c.in_span for c in app.chans))
        app.set_center(455_625_000, "nrsp/config")
        self.assertTrue(sum(c.in_span for c in app.chans) == 3)  # ground (hw path), fire, 455.75 — not 456.7


if __name__ == "__main__":
    unittest.main()


# ── RF-TX lockout (Ewan, 10 Oct 2026: fix allowed "as long as this is locked out from tx'ing") ─────────────────────
import re as _re
import pathlib as _pl

_SRC = (_pl.Path(__file__).resolve().parent.parent / "uhf-iq.py").read_text()


class RfTxLockout(unittest.TestCase):
    def test_static_no_rf_control_code(self):
        # no GPIO, serial/CAT, hamlib/rigctl, subprocess or os.system anywhere in uhf-iq.py
        for pat in (r"\bimport\s+(RPi|gpiod|gpiozero|serial|Hamlib|subprocess)\b", r"\bfrom\s+(RPi|gpiod|gpiozero|serial|Hamlib|subprocess)\b",
                    r"rigctl", r"os\.system\(", r"/dev/tty", r"set_ptt", r"/api/(relay|ptt|arm)\b"):
            assert not _re.search(pat, _SRC), pat


    def test_runtime_allowlist(self):
        m = uhf
        m._check_post(m.CONFIG, {"frequency": 455625000})
        m._check_post("http://10.200.0.29:4979/api/tx/submit",
                      {"interface": "wispayr-primary", "kind": "tower", "label": "x", "hz": 1, "captured_at": 0, "pcm_b64": ""})
        for url, body in [
            (m.CONFIG, {"frequency": 1, "ptt": True}),                       # extra field on the retune
            (m.RADIO, {"tx": True}),                                          # any other local API
            ("http://127.0.0.1:3943/api/relay", {"arm": True}),
            ("http://10.200.0.29:4979/api/tx/submit", {"interface": "wispayr-primary", "keyup": 1}),
            ("http://10.200.0.29:4979/api/tx/submit", {"interface": "other", "pcm_b64": ""}),
            ("http://10.200.0.29:4979/api/tx/mode", {"interface": "wispayr-primary"}),
        ]:
            try:
                m._check_post(url, body)
            except m.RfTxLockout:
                continue
            raise AssertionError(f"not refused: {url} {body}")
        # post_json itself enforces it before opening a socket
        try:
            m.post_json("http://127.0.0.1:3943/api/relay", {"arm": True}, timeout=0.01)
        except m.RfTxLockout:
            pass
        else:
            raise AssertionError("post_json did not refuse")
