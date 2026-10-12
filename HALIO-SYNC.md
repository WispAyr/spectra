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
