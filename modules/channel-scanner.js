/**
 * channel-scanner.js — multi-channel scanner for the nRSP-ST
 *
 * Design constraints (measured 2026-06-10):
 *  - Rapid device_center_frequency retunes (~1.5s apart) WEDGE the
 *    SDRconnect demod chain (spectrum + signal_power + audio all freeze;
 *    only an sdrconnect-headless restart recovers). Center retunes must be
 *    rare and slow.
 *  - device_vfo_frequency moves are cheap and safe at ≥1 Hz, and
 *    signal_power follows the VFO (it is demod-chain power).
 *
 * So: channels are grouped into spectrum-span windows. The scanner parks the
 * center on one group at a time and watches ALL of that group's channels
 * simultaneously in the FFT bins. When a channel's bin power rises above the
 * noise floor by marginDb (or above absolute threshold if set), the VFO hops
 * there, signal_power confirms, and the scanner LOCKS (audio streams it).
 * After hangMs of silence it resumes. Groups rotate on a slow cadence.
 *
 * Distinct from spectrum-scanner.js (soapy_power band sweeper on a separate
 * RTL dongle). This module drives the PRIMARY nRSP-ST tune: starting a scan
 * takes over the radio; any manual tune stops the scan.
 */

const TICK_MS = 250;

class ChannelScanner {
  constructor(sdrManager) {
    this.sdr = sdrManager;
    this.running = false;
    this.state = 'idle';      // idle | settle | watch | confirm | locked
    this.groups = [];
    this.gIdx = 0;
    this.channels = [];
    this.current = null;      // channel being confirmed / locked
    this.groupDwellMs = 3000;
    this.centerSettleMs = 1500;
    this.confirmMs = 1800;
    this.hangMs = 2500;
    this.marginDb = 10;       // bin power above noise floor → hit
    this.threshold = null;    // absolute dB override (null = use margin)
    this.hits = [];
    this._timer = null;
    this._stateAt = 0;
    this._vfoAt = 0;
    this._lastAbove = 0;
    this._lastLevels = {};    // freq → last bin power (for status/UI)
  }

  start(channels, opts = {}) {
    const chans = (Array.isArray(channels) ? channels : [])
      .map(c => ({
        freq: parseInt(c.freq, 10),
        mode: c.mode || 'NFM',
        bandwidth: parseInt(c.bandwidth, 10) || 12500,
        label: c.label || (c.freq / 1e6).toFixed(4) + ' MHz',
      }))
      .filter(c => c.freq > 0)
      .sort((a, b) => a.freq - b.freq);
    if (chans.length < 1) throw new Error('no valid channels');

    this.stop();
    this.channels = chans;
    if (opts.dwellMs) this.groupDwellMs = Math.max(1500, Math.min(15000, parseInt(opts.dwellMs, 10)));
    if (opts.hangMs) this.hangMs = Math.max(500, Math.min(30000, parseInt(opts.hangMs, 10)));
    if (opts.marginDb !== undefined) this.marginDb = Math.max(3, Math.min(40, parseFloat(opts.marginDb)));
    this.threshold = (opts.threshold !== undefined && opts.threshold !== null && opts.threshold > -120)
      ? parseFloat(opts.threshold) : null;

    // Group channels into windows that fit the usable spectrum span
    const sampleRate = this.sdr.config.sampleRate || 2e6;
    const span = sampleRate * 0.8;
    this.groups = [];
    let g = null;
    for (const c of chans) {
      if (!g || c.freq - g.channels[0].freq > span) {
        g = { channels: [], center: 0 };
        this.groups.push(g);
      }
      g.channels.push(c);
    }
    for (const grp of this.groups) {
      const lo = grp.channels[0].freq, hi = grp.channels[grp.channels.length - 1].freq;
      grp.center = Math.round((lo + hi) / 2);
      // A channel sitting exactly on the center frequency lands on the DC
      // spike — nudge the center off by 100 kHz if that happens.
      if (grp.channels.some(c => Math.abs(c.freq - grp.center) < 20000)) grp.center += 100000;
    }

    this.running = true;
    this.wedged = false;
    this.gIdx = -1;
    this.hits = [];
    this._nextGroup();
    return this.status();
  }

  stop() {
    this.running = false;
    this.state = 'idle';
    this.current = null;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  skip() {
    if (!this.running) return;
    if (this.state === 'locked' || this.state === 'confirm') {
      // Jump straight to the next ALSO-active channel if one exists —
      // returning to watch would just re-lock the same transmission.
      const others = (this._active || []).filter(c => this.current && c.freq !== this.current.freq);
      if (others.length) {
        this.current = others[0];
        this._vfo(others[0]);
        this._setState('confirm');
      } else {
        this.current = null;
        this._setState('watch');
      }
      this._tick();
    } else {
      this._nextGroup();
    }
  }

  status() {
    const grp = this.groups[this.gIdx] || null;
    return {
      running: this.running,
      wedged: this.wedged || false,
      state: this.state,
      locked: this.state === 'locked',
      current: this.current,
      active: (this._active || []).map(c => ({ freq: c.freq, label: c.label })),
      group: grp ? { index: this.gIdx, count: this.groups.length, center: grp.center, size: grp.channels.length } : null,
      channels: this.channels,
      levels: this._lastLevels,
      noiseFloor: this._noiseFloor(),
      marginDb: this.marginDb,
      threshold: this.threshold,
      dwellMs: this.groupDwellMs,
      hangMs: this.hangMs,
      signalPower: this.sdr.signalPower,
      hits: this.hits.slice(-12),
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  _setState(s) { this.state = s; this._stateAt = Date.now(); }

  _nextGroup() {
    if (!this.running) return;
    this.gIdx = (this.gIdx + 1) % this.groups.length;
    const grp = this.groups[this.gIdx];
    // Center retune — the expensive, fragile operation. Happens at most once
    // per groupDwell (≥1.5s settle + ≥1.5s dwell ⇒ ≥3s apart).
    this.sdr.tune(grp.center, this.sdr.config.bandwidth);
    // Park the VFO on the first channel so audio is meaningful while watching
    this._vfo(grp.channels[0]);
    this._setState('settle');
    this._tick();
  }

  _vfo(ch) {
    if (this.sdr.demodMode !== ch.mode) this.sdr.setDemod(ch.mode);
    this.sdr.setVfo(ch.freq);
    this._vfoAt = Date.now();
  }

  _noiseFloor() {
    const bins = this.sdr.bins;
    if (!bins || !bins.length) return null;
    const sorted = [...bins].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  _binPower(freq) {
    const bins = this.sdr.bins;
    const center = this.sdr.config.frequency;
    const span = this.sdr.config.sampleRate || 2e6;
    if (!bins || !bins.length || !center) return null;
    const lo = center - span / 2;
    const frac = (freq - lo) / span;
    if (frac < 0.02 || frac > 0.98) return null;
    const mid = Math.round(frac * (bins.length - 1));
    // peak over ±6.25 kHz worth of bins
    const half = Math.max(1, Math.round((12500 / span) * bins.length / 2));
    let peak = -200;
    for (let i = Math.max(0, mid - half); i <= Math.min(bins.length - 1, mid + half); i++) {
      if (bins[i] > peak) peak = bins[i];
    }
    return peak;
  }

  _hit(ch) {
    const p = this._binPower(ch.freq);
    if (p == null) return false;
    this._lastLevels[ch.freq] = p;
    if (this.threshold != null) return p >= this.threshold;
    const nf = this._noiseFloor();
    return nf != null && p >= nf + this.marginDb;
  }

  _tick() {
    if (!this.running) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      try { this._step(); } catch (e) { console.warn('[ChanScan]', e.message); this._tick(); }
    }, TICK_MS);
  }

  _step() {
    if (!this.running) return;
    const now = Date.now();
    const grp = this.groups[this.gIdx];
    const inState = now - this._stateAt;

    // Wedge guard: if the spectrum stream stalls the demod chain is gone —
    // stop scanning rather than churn a dead radio (recovery = headless
    // restart; see module header).
    if (this.sdr.lastSpectrumAt && now - this.sdr.lastSpectrumAt > 12000) {
      console.warn('[ChanScan] spectrum stalled >12s — stopping scan (radio chain wedged?)');
      this.stop();
      this.wedged = true;
      return;
    }

    if (this.state === 'settle') {
      // Wait for fresh spectrum after the center retune
      if (inState >= this.centerSettleMs && this.sdr.lastSpectrumAt > this._stateAt) {
        this._setState('watch');
      }
      return this._tick();
    }

    if (this.state === 'watch') {
      this._active = grp.channels.filter(ch => this._hit(ch));
      if (this._active.length) {
        this.current = this._active[0];
        this._vfo(this.current);
        this._setState('confirm');
        return this._tick();
      }
      if (inState >= this.groupDwellMs) {
        if (this.groups.length > 1) return this._nextGroup();
        this._setState('watch'); // single group: keep watching forever
      }
      return this._tick();
    }

    if (this.state === 'confirm') {
      // signal_power (demod power at the VFO) confirms the FFT hit
      const fresh = this.sdr.signalPowerAt > this._vfoAt + 400;
      const stillHot = this._hit(this.current);
      if (fresh && stillHot) {
        this._setState('locked');
        this._lastAbove = now;
        this.hits.push({ at: now, freq: this.current.freq, label: this.current.label, power: this.sdr.signalPower });
        if (this.hits.length > 50) this.hits.shift();
      } else if (inState >= this.confirmMs && !stillHot) {
        this.current = null;
        this._setState('watch');
      }
      return this._tick();
    }

    if (this.state === 'locked') {
      // Keep watching the whole window while locked — other channels going
      // active are surfaced in status as `active` (operator can SKIP to them)
      this._active = grp.channels.filter(ch => this._hit(ch));
      if (this._hit(this.current)) this._lastAbove = now;
      if (now - this._lastAbove > this.hangMs) {
        this.current = null;
        this._setState('watch');
      }
      return this._tick();
    }

    this._tick();
  }
}

module.exports = ChannelScanner;
