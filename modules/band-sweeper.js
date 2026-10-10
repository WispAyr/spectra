/**
 * band-sweeper.js — guided band survey for the nRSP-ST
 *
 * Steps the device center across [startHz, stopHz] in 0.8×sampleRate windows
 * at a wedge-safe cadence (≥3s per step — rapid center retunes freeze the
 * SDRconnect chain, see channel-scanner.js header), peak-holds the FFT bins
 * during each dwell, and assembles:
 *   - a composite spectrum across the whole band (downsampled)
 *   - a peak list: distinct signals above noiseFloor + marginDb
 *
 * One-shot: runs the step list once, then stops and leaves the results in
 * status() until the next sweep. Mutually exclusive with the channel scanner.
 */

const TICK_MS = 250;
const COMPOSITE_POINTS = 2048;

class BandSweeper {
  constructor(sdrManager) {
    this.sdr = sdrManager;
    this.running = false;
    this.startHz = 0;
    this.stopHz = 0;
    this.steps = [];
    this.idx = -1;
    this.settleMs = 1600;
    this.dwellMs = 2200;
    this.marginDb = 8;
    this.peaks = [];
    this.composite = null;
    this.completedAt = 0;
    this.wedged = false;
    this._timer = null;
    this._stateAt = 0;
    this._hold = null;      // peak-held bins for current step
    this._state = 'idle';   // idle | settle | dwell
  }

  start({ startHz, stopHz, marginDb } = {}) {
    startHz = parseInt(startHz, 10); stopHz = parseInt(stopHz, 10);
    if (!startHz || !stopHz || stopHz <= startHz) throw new Error('bad band');
    if (stopHz - startHz > 60e6) throw new Error('band too wide (max 60 MHz)');
    this.stop();
    const sampleRate = this.sdr.config.sampleRate || 2e6;
    const span = sampleRate * 0.8;
    this.startHz = startHz; this.stopHz = stopHz;
    if (marginDb !== undefined) this.marginDb = Math.max(3, Math.min(40, parseFloat(marginDb)));
    this.steps = [];
    for (let c = startHz + span / 2; c - span / 2 < stopHz; c += span) {
      this.steps.push(Math.round(c));
    }
    this.running = true;
    this.wedged = false;
    this.peaks = [];
    this.composite = { startHz, stopHz, points: new Array(COMPOSITE_POINTS).fill(-130) };
    this.completedAt = 0;
    this.idx = -1;
    this._next();
    return this.status();
  }

  stop() {
    this.running = false;
    this._state = 'idle';
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  status() {
    return {
      running: this.running,
      wedged: this.wedged,
      band: this.startHz ? { startHz: this.startHz, stopHz: this.stopHz } : null,
      progress: this.steps.length ? Math.min(1, (this.idx + (this._state === 'idle' ? 0 : 0.5)) / this.steps.length) : 0,
      step: this.idx + 1,
      stepCount: this.steps.length,
      etaSec: this.running ? Math.round((this.steps.length - this.idx) * (this.settleMs + this.dwellMs) / 1000) : 0,
      peaks: this.peaks,
      composite: this.composite,
      completedAt: this.completedAt,
    };
  }

  _next() {
    if (!this.running) return;
    this.idx++;
    if (this.idx >= this.steps.length) {
      this.running = false;
      this._state = 'idle';
      this.completedAt = Date.now();
      // Sort strongest first, cap list
      this.peaks.sort((a, b) => b.db - a.db);
      this.peaks = this.peaks.slice(0, 60);
      return;
    }
    this.sdr.tune(this.steps[this.idx], this.sdr.config.bandwidth);
    this._hold = null;
    this._state = 'settle';
    this._stateAt = Date.now();
    this._tick();
  }

  _tick() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      try { this._step(); } catch (e) { console.warn('[BandSweep]', e.message); this._tick(); }
    }, TICK_MS);
  }

  _step() {
    if (!this.running) return;
    const now = Date.now();
    // Wedge guard — same failure mode as the channel scanner
    if (this.sdr.lastSpectrumAt && now - this.sdr.lastSpectrumAt > 12000) {
      console.warn('[BandSweep] spectrum stalled >12s — aborting sweep');
      this.stop();
      this.wedged = true;
      return;
    }
    const inState = now - this._stateAt;

    if (this._state === 'settle') {
      if (inState >= this.settleMs && this.sdr.lastSpectrumAt > this._stateAt) {
        this._state = 'dwell';
        this._stateAt = now;
      }
      return this._tick();
    }

    if (this._state === 'dwell') {
      const bins = this.sdr.bins;
      if (bins && bins.length) {
        if (!this._hold || this._hold.length !== bins.length) this._hold = Float64Array.from(bins);
        else for (let i = 0; i < bins.length; i++) if (bins[i] > this._hold[i]) this._hold[i] = bins[i];
      }
      if (inState >= this.dwellMs) {
        this._harvest();
        return this._next();
      }
      return this._tick();
    }
  }

  _harvest() {
    const hold = this._hold;
    if (!hold || !hold.length) return;
    const sampleRate = this.sdr.config.sampleRate || 2e6;
    const center = this.steps[this.idx];
    const lo = center - sampleRate / 2;
    const n = hold.length;
    const usableLo = 0.1, usableHi = 0.9; // trim window edges / DC skirt

    // Composite: project this step's bins onto the band-wide array (max-merge)
    const band = this.stopHz - this.startHz;
    for (let i = 0; i < n; i++) {
      const frac = i / (n - 1);
      if (frac < usableLo || frac > usableHi) continue;
      const f = lo + frac * sampleRate;
      if (f < this.startHz || f > this.stopHz) continue;
      const ci = Math.min(COMPOSITE_POINTS - 1, Math.max(0, Math.round((f - this.startHz) / band * (COMPOSITE_POINTS - 1))));
      if (hold[i] > this.composite.points[ci]) this.composite.points[ci] = +hold[i].toFixed(1);
    }

    // Peak detection: contiguous runs above noiseFloor + margin
    const sorted = [...hold].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length / 2)];
    const thr = floor + this.marginDb;
    let run = null;
    for (let i = 0; i < n; i++) {
      const frac = i / (n - 1);
      const inWin = frac >= usableLo && frac <= usableHi;
      if (inWin && hold[i] >= thr) {
        if (!run) run = { startI: i, maxI: i, maxV: hold[i] };
        else if (hold[i] > run.maxV) { run.maxV = hold[i]; run.maxI = i; }
      } else if (run) {
        const f = Math.round(lo + (run.maxI / (n - 1)) * sampleRate);
        if (f >= this.startHz && f <= this.stopHz) {
          this.peaks.push({ freq: f, db: +run.maxV.toFixed(1), snr: +(run.maxV - floor).toFixed(1) });
        }
        run = null;
      }
    }
    if (run) {
      const f = Math.round(lo + (run.maxI / (n - 1)) * sampleRate);
      if (f >= this.startHz && f <= this.stopHz) {
        this.peaks.push({ freq: f, db: +run.maxV.toFixed(1), snr: +(run.maxV - floor).toFixed(1) });
      }
    }
  }
}

module.exports = BandSweeper;
