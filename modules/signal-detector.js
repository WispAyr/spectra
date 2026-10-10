/**
 * signal-detector.js — Active-frequency detector from the live nRSP-ST FFT
 *
 * Peak-detects signals standing above the noise floor in the spectrum the
 * primary nRSP-ST is currently tuned to (~one filter_bandwidth window), and
 * maintains a rolling table of "active frequencies" with first/last-seen,
 * hit count, peak power and SNR. No extra hardware — works off the FFT frames
 * SPECTRA already receives over the SDRconnect WebSocket.
 *
 * Note: only sees signals within the currently-tuned window. To survey wider,
 * hop the primary tune across bands (caller's choice) or attach a 2nd SDR.
 */

// Minimal UK band-plan labels for quick identification (Hz ranges).
const BANDS = [
  [108e6, 137e6, 'Aviation VHF', 'AM'],
  [144e6, 146e6, '2m Amateur', 'NFM'],
  [144.79e6, 144.81e6, 'APRS', 'NFM'],
  [153.0e6, 153.5e6, 'POCSAG pager', 'NFM'],
  [156e6, 162.05e6, 'Marine VHF', 'NFM'],
  [380e6, 400e6, 'Airwave/TETRA', 'TETRA'],
  [433.05e6, 434.79e6, 'ISM 433', 'NFM'],
  [446.0e6, 446.2e6, 'PMR446', 'NFM'],
  [451e6, 470e6, 'UHF business', 'NFM'],
  [1090e6, 1090.1e6, 'ADS-B', 'AM'],
];

function labelFor(freqHz) {
  for (const [lo, hi, name, mod] of BANDS) {
    if (freqHz >= lo && freqHz <= hi) return { name, mod };
  }
  return null;
}

class SignalDetector {
  constructor(opts = {}) {
    this.snrThresholdDb = opts.snrThresholdDb ?? 10; // dB above noise floor to count as active
    this.minWidthBins   = opts.minWidthBins ?? 1;
    this.quantHz        = opts.quantHz ?? 6250;      // grouping resolution (key)
    this.expireMs       = opts.expireMs ?? 45000;    // drop entries unseen this long
    this.maxActive      = opts.maxActive ?? 250;
    this.active = new Map(); // quantised-freq -> signal record
    this.lastTs = 0;
  }

  /** Feed one FFT frame from sdrManager.getLastFft(). Returns # detections this frame. */
  update(fft, snrOverride) {
    if (!fft || !fft.connected) return 0;
    const bins = fft.bins;
    if (!Array.isArray(bins) || bins.length < 8) return 0;
    if (fft.timestamp && fft.timestamp === this.lastTs) return 0; // no new frame
    this.lastTs = fft.timestamp || Date.now();

    const n = bins.length;
    const center = fft.frequency;
    if (!center) return 0;
    const span = fft.spanHz || fft.bandwidth || 2048000;
    const binHz = span / n;
    const f0 = center - span / 2;
    const centerBin = n / 2;

    // Robust noise floor: low percentile (biased toward noise, resists wide signals)
    const sorted = bins.slice().sort((a, b) => a - b);
    const floor = sorted[Math.floor(n * 0.4)];
    const thresh = floor + (snrOverride ?? this.snrThresholdDb);

    const now = Date.now();
    let count = 0;
    let i = 0;
    while (i < n) {
      if (bins[i] > thresh) {
        let j = i, peakIdx = i, peakVal = bins[i];
        while (j < n && bins[j] > thresh) {
          if (bins[j] > peakVal) { peakVal = bins[j]; peakIdx = j; }
          j++;
        }
        const widthBins = j - i;
        // Skip the DC/LO spike at the very centre unless it's a genuinely wide hump
        const isDcSpike = Math.abs(peakIdx - centerBin) <= 1 && widthBins <= 2;
        // Lone-bin birdie/noise guard: a 1-bin peak only counts if it's strong
        // (>= threshold + 8 dB). Wider peaks use the normal threshold.
        const isSpur = widthBins <= 1 && (peakVal - floor) < (snrOverride ?? this.snrThresholdDb) + 8;
        if (widthBins >= this.minWidthBins && !isDcSpike && !isSpur) {
          const freq = Math.round(f0 + peakIdx * binHz);
          this._record(freq, peakVal, peakVal - floor, Math.round(widthBins * binHz), now);
          count++;
        }
        i = j;
      } else i++;
    }
    this._expire(now);
    return count;
  }

  _record(freq, power, snr, widthHz, now) {
    const key = Math.round(freq / this.quantHz) * this.quantHz;
    const ex = this.active.get(key);
    if (ex) {
      ex.lastSeen = now;
      ex.hits++;
      ex.power = power;
      ex.snr = snr;
      ex.widthHz = widthHz;
      ex.freq = freq;
      ex.freqMHz = +(freq / 1e6).toFixed(4);
      if (power > ex.peakPower) ex.peakPower = power;
    } else {
      const band = labelFor(freq);
      this.active.set(key, {
        key,
        freq,
        freqMHz: +(freq / 1e6).toFixed(4),
        power,
        peakPower: power,
        snr,
        widthHz,
        band: band ? band.name : null,
        mode: band ? band.mod : null,
        firstSeen: now,
        lastSeen: now,
        hits: 1,
      });
    }
  }

  _expire(now) {
    for (const [k, s] of this.active) {
      if (now - s.lastSeen > this.expireMs) this.active.delete(k);
    }
    if (this.active.size > this.maxActive) {
      const arr = [...this.active.values()].sort((a, b) => a.lastSeen - b.lastSeen);
      const drop = arr.length - this.maxActive;
      for (let k = 0; k < drop; k++) this.active.delete(arr[k].key);
    }
  }

  /** Active signals, most-recently-seen first. */
  list() {
    return [...this.active.values()].sort(
      (a, b) => b.lastSeen - a.lastSeen || b.power - a.power
    );
  }

  clear() { this.active.clear(); }
}

module.exports = SignalDetector;
