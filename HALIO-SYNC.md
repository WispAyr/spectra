# HALIO-SYNC — van-halio ~/spectra vs this repo

van-halio runs `~/spectra` on branch `feat/sdrconnect-bridge` with **large uncommitted drift** (config.json, sdr-manager.js,
server.js, several untracked modules incl. `modules/second-demod.js`). This file records changes made on the box so the repo
can catch up. Do not `git pull`/`reset` on halio without reconciling first.

## 2026-10-12 19:23 BST — ch2 (fire 455.700) channel filter + dB squelch  (Ewan approved 19:21)
File: `modules/second-demod.js` (only this file changed on halio). Restarted: `pm2 restart spectra` at 19:23:50 BST.

- **Channel filter:** 95-tap Blackman low-pass (±6 kHz, 12 kHz) on the 40 kHz CIC output, *before* the FM discriminator.
  Before, the CIC passed ±20 kHz, so the 455.7125 data bursts and the van's 15.74 kHz spur comb reached the
  discriminator → an 88 Hz click comb ("buzz"). Comb prominence 30–38 dB before → ~6 dB after.
- **Squelch:** measured and threshold are both dB — filtered-channel power above a tracked noise floor (fast down,
  ~100 s up). `squelchLevel` = open margin dB, default **5** (legacy values < 1, e.g. the old 0.004, mean default);
  400 ms hang, 3 dB hysteresis. Before: linear rms ~1243 vs threshold 0.004 → never closed.
- `/api/nrsp/ch2` now also reports `chanDb`, `floorDb`, `squelchOpen`, `squelchUnit`, `chanFilterHz`.
- Main receiver untouched (still 455.625 NFM, Antenna B); no TX; UHF not armed; crosspoint-hub not restarted.
- **Tower blip:** spectra hosts the tower `/ws/audio` too, so the restart dropped tower audio for a few seconds;
  tower-whisper reconnected (health ok, last_audio_age 0.2 s).

### Rollback
```
ssh van-halio
cp ~/backups/spectra-ch2-20261012-1922/second-demod.js ~/spectra/modules/second-demod.js
pm2 restart spectra
```
(Backup dir also holds server.js, config.json, HEAD and ch2-before.json.)

## 2026-10-12 19:47 BST — ch2 v2: exact integer CIC + FM-quieting squelch
Restarted `pm2 restart spectra` at 19:42:28 and 19:47:02 (tower audio blipped a few seconds each time; tower-whisper stayed connected).

- **Root cause of "still not working":** the CIC integrators ran in float64 and grew without bound, losing precision within
  minutes. Channel noise rose ~60 dB in 15 min (chanDb −71 → −13), the floor tracker followed, and the squelch sat open 95 %
  of the time on loud hiss (−13 dBFS) that buried the real fire calls. Now 32-bit two's-complement wrap (14-bit input), exact.
- **Squelch now FM quieting** on the 12.5 kHz-filtered channel: discriminator variance per 50 ms block; noise ≈ 0.55 here,
  real fire carriers 0.01–0.06. Opens < 0.3 (≈10 dB C/N; `squelchLevel` dB maps to it), closes > 0.45 after 400 ms hang.
  Power-over-floor alone was fooled by whole-band level steps (~10–13 dB) when the tower carrier keys.
- Verified live: 0 of 60 samples open over 2 min of no fire traffic (was 95 % open). `/api/nrsp/ch2` adds `quiet`, `quietOpen`.

Rollback to the 19:23 version: `cp ~/backups/spectra-ch2-20261012-1941-v2/second-demod.js ~/spectra/modules/ && pm2 restart spectra`
(original pre-12-Oct file: `~/backups/spectra-ch2-20261012-1922/second-demod.js`).

## pu2 fire-whisper prompt (19:51 BST)
`com.wispayr.fire-whisper` INITIAL_PROMPT shortened and given radio-check phraseology ("radio check, how do you read, loud and
clear, reading you fives…"). Same model (medium.en-atc, shared whisper-server :4092). A/B on the 19:43 radio-check clip: with
the new prompt the ATC model gives "roger five five eight radio check how do you read five five"; it was logged as
"departure five five eight into checker…". Backup: `~/operations/fire-whisper/backup-20261012-1951/`.

## 2026-10-12 20:17 BST — nRSP receiver PPM correction (+1.40 ppm)
Ewan approved (20:09). RX only; no TX, UHF not armed, crosspoint-hub not touched. One `pm2 restart spectra` at 20:17:15;
`/ws/audio` (tower) was flowing again 3.4 s later.

- **Measured before:** the 455.625 tower carrier read **−637 Hz** live (discriminator mean, 20:15; −641 Hz from the 19:38 FFT
  capture). The nRSP TCXO runs ~1.40 ppm fast, so every signal read low (fire 455.700 read ~−1.2 kHz; ~−0.57 kHz is the handsets).
- **How:** SDRconnect headless exposes no ppm property on its websocket (`ppm_correction` etc. return nothing), so
  `modules/sdr-manager.js` now pre-compensates the commanded centre: `config.nrsp.ppmCorrection = 1.40` →
  `device_center_frequency` / `device_vfo_frequency` = round(f × (1 − ppm·1e-6)) = **455 624 362** for 455.625. The echoed centre
  is mapped back to nominal, so `config.frequency`, `/api/nrsp/config`, IQ hellos, uhf-iq and ch2 all still say 455 625 000.
  Positive ppm = receiver fast / signals read low. Re-applied automatically on every SDRconnect reconnect.
- **Measured after:** tower carrier median **+11 Hz** and **−5 Hz** on two live tower overs (20:44, 20:48; spectral centroid, 0.13 s
  blocks, DC excluded). ch2 still targets 455.700 (offset 75 kHz); fire squelch shut with no traffic (quiet 0.53 vs open < 0.3).
- **Note:** SDRconnect segfaulted 4× (20:15–20:27, first one *before* this change) while ad-hoc 250 kS/s `/ws/iq?decim=8` captures
  ran and the Pi was at load ~20–28; none since 20:27 with no extra decim=8 reader. Avoid new decim=8 IQ readers on halio.

Rollback: `cp ~/backups/spectra-ppm-20261012-201222/{config.json,sdr-manager.js} …` (config.json → ~/spectra/,
sdr-manager.js → ~/spectra/modules/) then `pm2 restart spectra`; or set `nrsp.ppmCorrection` to 0.

Patch as applied on van-halio (van tree has other uncommitted sdr-manager.js changes, so this is recorded here, not committed):

```diff
--- /home/wispayr/backups/spectra-ppm-20261012-201222/sdr-manager.js	2026-10-12 20:12:22.784205615 +0100
+++ /home/wispayr/spectra/modules/sdr-manager.js	2026-10-12 20:17:04.391832960 +0100
@@ -305,9 +305,20 @@
     try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
   }
 
+  _ppm() { const v = Number(this.config.ppmCorrection); return Number.isFinite(v) ? v : 0; }
+  _hwFreq(nominal) { return Math.round(nominal * (1 - this._ppm() * 1e-6)); }
+  _nominalFreq(hw) { return Math.round(hw * (1 + this._ppm() * 1e-6)); }
+
   _sendTune() {
     if (this.config.frequency) {
-      this._send({ event_type: "set_property", property: "device_center_frequency", value: String(this.config.frequency), device: "primary" });
+      // Receiver PPM correction (2026-10-12): SDRconnect headless exposes no
+      // ppm property over the websocket, so we pre-compensate the commanded
+      // centre. config.nrsp.ppmCorrection > 0 means the nRSP TCXO runs fast
+      // (signals read LOW). +1.40 ppm measured from the 455.625 tower carrier
+      // (-637 Hz). Everything downstream keeps using the NOMINAL frequency.
+      const _hw = this._hwFreq(this.config.frequency);
+      this._send({ event_type: "set_property", property: "device_center_frequency", value: String(_hw), device: "primary" });
+      this._send({ event_type: "set_property", property: "device_vfo_frequency", value: String(_hw), device: "primary" });
     }
     if (this.config.sampleRate) {
       this._send({ event_type: "set_property", property: "device_sample_rate", value: String(this.config.sampleRate), device: "primary" });
@@ -440,7 +451,10 @@
         case "device_vfo_frequency": this.vfoFrequency = parseInt(val, 10); break;
         case "signal_snr": this.signalSnr = parseFloat(val); break;
         case "device_center_frequency": {
-          const _nf = parseInt(val, 10) || this.config.frequency;
+          const _raw = parseInt(val, 10);
+          let _nf = _raw ? this._nominalFreq(_raw) : this.config.frequency;
+          if (Math.abs(_nf - this.config.frequency) <= 2) _nf = this.config.frequency;
+          this.hwCenterFrequency = _raw || null;
           if (_nf !== this.config.frequency) { this.config.frequency = _nf; this.emit("retune", _nf); }
           break;
         }
```
