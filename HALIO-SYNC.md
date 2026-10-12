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
