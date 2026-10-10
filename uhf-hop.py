#!/usr/bin/env python3
"""Hop the nRSP-ST centre across the four EGPK UHF ops channels.

The spectra channel-scanner packs them into one 2 MHz FFT group and parks
device_center at 456.1625 MHz. On this Full IQ session NFM audio follows
device_center_frequency, not VFO offset, so that park is deaf. Preset
activate calls sdrManager.tune(channel, 12500) — the path that actually
received (measured 2026-09-02 17:51Z).

Stays on a channel while squelch is open or RSSI is above OPEN_DBM.
Does not start /api/chanscan (that is the deaf packer). Keep relay
scan_mode/scan_keeper false while this is running.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

RADIO = "http://127.0.0.1:3943/api/radio"
PRESETS = "http://127.0.0.1:3943/api/presets"
SCAN = "http://127.0.0.1:3943/api/chanscan"
OPEN_DBM = -105.0
SETTLE_S = 1.6
DWELL_S = 4.0
BUSY_POLL_S = 0.5
HANG_S = 2.0
CYCLE = [
    ("p455625000-227152452", 455625000, "EGPK ground"),
    ("p455700000-1484033606", 455700000, "airport fire"),
    ("p455750000-1239598523", 455750000, "PIK OPS 455.75"),
    ("p456700000-1484032645", 456700000, "PIK OPS 456.7"),
]


def get(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def post(url, timeout=8):
    req = urllib.request.Request(url, data=b"{}", method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def radio():
    return get(RADIO)


def activate(pid):
    return post(f"{PRESETS}/{pid}/activate")


def main():
    i = 0
    print("[uhf-hop] start", flush=True)
    while True:
        try:
            sc = get(SCAN)
            if sc.get("running"):
                print("[uhf-hop] chanscan running — sleeping, will not fight it", flush=True)
                time.sleep(10)
                continue
        except Exception as e:
            print(f"[uhf-hop] chanscan status: {e}", flush=True)

        pid, freq, label = CYCLE[i % len(CYCLE)]
        try:
            st = radio()
        except Exception as e:
            print(f"[uhf-hop] radio: {e}", flush=True)
            time.sleep(2)
            continue

        pwr = st.get("signalPower")
        sq = bool(st.get("squelchOpen"))
        cur = st.get("frequency")
        if sq or (pwr is not None and pwr >= OPEN_DBM):
            time.sleep(BUSY_POLL_S)
            continue

        if cur != freq:
            try:
                activate(pid)
            except Exception as e:
                print(f"[uhf-hop] activate {label} failed: {e}", flush=True)
                time.sleep(2)
                continue
            time.sleep(SETTLE_S)
            try:
                st = radio()
            except Exception:
                st = {}
            print(
                f"[uhf-hop] {label} f={st.get('frequency')} bw={st.get('deviceBandwidth')} "
                f"pwr={st.get('signalPower')} sq={st.get('squelchOpen')} deemph={st.get('nfmDeemphasis')}",
                flush=True,
            )
            pwr = st.get("signalPower")
            sq = bool(st.get("squelchOpen"))
            if sq or (pwr is not None and pwr >= OPEN_DBM):
                hung = time.time()
                while True:
                    time.sleep(BUSY_POLL_S)
                    try:
                        st = radio()
                    except Exception:
                        break
                    pwr = st.get("signalPower")
                    sq = bool(st.get("squelchOpen"))
                    if sq or (pwr is not None and pwr >= OPEN_DBM):
                        hung = time.time()
                    elif time.time() - hung >= HANG_S:
                        break
                i = (i + 1) % len(CYCLE)
                continue

        deadline = time.time() + DWELL_S
        while time.time() < deadline:
            time.sleep(BUSY_POLL_S)
            try:
                st = radio()
            except Exception:
                break
            pwr = st.get("signalPower")
            sq = bool(st.get("squelchOpen"))
            if sq or (pwr is not None and pwr >= OPEN_DBM):
                hung = time.time()
                while True:
                    time.sleep(BUSY_POLL_S)
                    try:
                        st = radio()
                    except Exception:
                        break
                    pwr = st.get("signalPower")
                    sq = bool(st.get("squelchOpen"))
                    if sq or (pwr is not None and pwr >= OPEN_DBM):
                        hung = time.time()
                    elif time.time() - hung >= HANG_S:
                        break
                break
        i = (i + 1) % len(CYCLE)


if __name__ == "__main__":
    main()
