/**
 * second-demod.js — in-process NFM demodulator for a SECOND channel.
 *
 * The van's nRSP-ST is a single tuner, so SDRconnect can only demodulate one
 * audio channel over its WebSocket. To hear a second frequency simultaneously
 * we take the raw Full-IQ stream (s16-LE interleaved I/Q @ fsIn, centred at
 * centerHz) that sdr-manager emits on its 'iq' event, digitally down-convert to
 * a target frequency anywhere inside the +-fsIn/2 window, decimate with a
 * 3rd-order CIC, FM-discriminate, and emit mono s16 PCM @ fsAudio (fsIn/R).
 *
 * The primary SDRconnect demod stays on centerHz (its /ws/audio is untouched);
 * this module feeds /ws/audio2. Both target freqs must fall within
 * centerHz +- fsIn/2 (e.g. 455.625 centre, 2 MHz window => 454.625..456.625).
 */
const { EventEmitter } = require('events');

class SecondDemod extends EventEmitter {
  constructor(sdrManager, opts = {}) {
    super();
    this.sdr = sdrManager;
    this.fsIn = opts.fsIn || 2000000;
    this.centerHz = opts.centerHz || 455625000;
    this.targetHz = opts.targetHz || 455700000;
    this.R = opts.decim || 50;                       // CIC decimation factor
    this.fsAudio = Math.round(this.fsIn / this.R);   // audio sample rate (~40k)
    this.enabled = opts.enabled !== false;
    this.active = false;   // client-gated: only process when a /ws/audio2 listener is present
    this.squelchEnabled = !!opts.squelchEnabled;
    // Squelch (12 Oct 2026): measured and threshold are BOTH dB — the 12.5 kHz channel power above a tracked
    // noise floor. squelchLevel = open margin in dB (legacy values < 1, e.g. the old 0.004 linear, mean "default").
    this.squelchLevel = (opts.squelchLevel != null && opts.squelchLevel >= 1) ? opts.squelchLevel : 10;
    this.squelchHangMs = opts.squelchHangMs || 400;
    this.chanDb = -200; this.floorDb = null; this.quiet = 9;
    // quieting threshold: ~10 dB carrier-to-noise in 12.5 kHz. squelchLevel (dB) maps to it: 10 dB -> 0.3 rad^2.
    this.quietOpen = opts.quietOpen || 0.3 * Math.pow(10, (10 - ((opts.squelchLevel >= 1) ? opts.squelchLevel : 10)) / 20); this.sqOpen = false; this._sqUntil = 0;
    // 12.5 kHz channel filter at fsAudio, BEFORE the discriminator (12 Oct 2026). The CIC alone passed +-20 kHz,
    // so the 455.7125 data bursts and the van spur comb reached the discriminator and clicked at ~88 Hz.
    this.chanCutHz = opts.chanCutHz || 6000;
    this._fir = SecondDemod.lowpass(opts.chanTaps || 95, this.chanCutHz / (this.fsIn / (opts.decim || 50)));
    this._hI = new Float64Array(this._fir.length); this._hQ = new Float64Array(this._fir.length); this._hP = 0;
    this.gain = opts.gain != null ? opts.gain : 1.0;
    this.audioScale = opts.audioScale || 11000;      // rad -> int16 amplitude

    // DDC oscillator e^{-j w n}
    this._or = 1; this._oi = 0; this._c = 1; this._s = 0; this._oscN = 0;
    this._setOsc();

    // 3rd-order CIC: integrators (I,Q) + comb history
    this._iI = [0, 0, 0]; this._iQ = [0, 0, 0];
    this._cIp = [0, 0, 0]; this._cQp = [0, 0, 0];
    this._n = 0;
    this._cicGain = Math.pow(this.R, 3);

    // FM discriminator + audio filter state
    this._pre = 0; this._pim = 0;
    this._dc = 0; this._deemph = 0; this._lpf = 0;

    // stats
    this.frames = 0; this.bytes = 0; this.lastAt = 0; this.rms = 0;

    this._onIq = (buf) => { if (this.enabled && this.active) this._process(buf); };
    this.sdr.on('iq', this._onIq);
  }

  /** Blackman-windowed sinc low-pass, unity DC gain. fc = cutoff / fs. */
  static lowpass(n, fc) {
    const h = new Float64Array(n), m = (n - 1) / 2; let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = i - m, sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1));
      h[i] = sinc * w; sum += h[i];
    }
    for (let i = 0; i < n; i++) h[i] /= sum;
    return h;
  }

  _setOsc() {
    const off = this.targetHz - this.centerHz;          // shift +off to DC
    const w = 2 * Math.PI * off / this.fsIn;
    this._c = Math.cos(w); this._s = Math.sin(w);
    this._or = 1; this._oi = 0; this._oscN = 0;
  }

  setTarget(hz) { this.targetHz = Math.round(hz); this._setOsc(); }
  setCenter(hz) { this.centerHz = Math.round(hz); this._setOsc(); }
  setEnabled(on) { this.enabled = !!on; }
  setActive(on) { this.active = !!on; }
  setGain(g) { if (g > 0) this.gain = g; }
  setSquelch(on, level) { this.squelchEnabled = !!on; if (level != null && level >= 1) this.squelchLevel = level; }

  stats() {
    return {
      enabled: this.enabled, active: this.active, targetHz: this.targetHz, centerHz: this.centerHz,
      fsAudio: this.fsAudio, offsetHz: this.targetHz - this.centerHz,
      frames: this.frames, bytes: this.bytes, lastAt: this.lastAt,
      rms: +this.rms.toFixed(5), squelch: this.squelchEnabled, squelchLevel: this.squelchLevel, squelchUnit: "dB C/N (FM quieting on the 12.5 kHz channel)",
      chanDb: +this.chanDb.toFixed(1), quiet: +this.quiet.toFixed(3), quietOpen: this.quietOpen, floorDb: this.floorDb == null ? null : +this.floorDb.toFixed(1), squelchOpen: this.sqOpen,
      chanFilterHz: this.chanCutHz * 2,
      inWindow: Math.abs(this.targetHz - this.centerHz) < this.fsIn / 2,
    };
  }

  _process(buf) {
    // Track the primary device centre so the DDC offset stays correct across
    // any primary retune (config POST, preset, scanner).
    const dc0 = this.sdr && this.sdr.config && this.sdr.config.frequency;
    if (dc0 && dc0 !== this.centerHz) this.setCenter(dc0);

    // s16-LE IQ view (realign if odd byte offset)
    let src = buf;
    if ((src.byteOffset & 1) !== 0) src = Buffer.from(src);
    const iq = new Int16Array(src.buffer, src.byteOffset, src.length >> 1);
    const nSamp = iq.length >> 1;
    if (nSamp === 0) return;

    const R = this.R, c = this._c, sN = this._s, cicGain = this._cicGain;
    const out = new Int16Array(((nSamp / R) | 0) + 2);
    let outN = 0;
    let or = this._or, oi = this._oi;
    let i0 = this._iI[0], i1 = this._iI[1], i2 = this._iI[2];
    let q0 = this._iQ[0], q1 = this._iQ[1], q2 = this._iQ[2];
    const cIp = this._cIp, cQp = this._cQp;
    let n = this._n, pre = this._pre, pim = this._pim;
    let dc = this._dc, deemph = this._deemph, lpf = this._lpf;
    let sumSq = 0, cnt = 0, angSq = 0;

    for (let k = 0; k < nSamp; k++) {
      const I = iq[k * 2], Q = iq[k * 2 + 1];
      // down-convert
      // CIC in 32-bit two's-complement wrap (12 Oct 2026 v2). In float64 the 3rd-order integrators grow without bound
      // and lose precision within minutes: channel noise rose ~60 dB over 15 min and held the squelch open.
      // 14-bit input (>>2) + 3*log2(50)=17 bits of growth fits 31 bits, so the comb output is exact.
      const re = Math.round((I * or - Q * oi) * 0.25) | 0;
      const im = Math.round((I * oi + Q * or) * 0.25) | 0;
      const nor = or * c + oi * sN;      // osc *= e^{-jw}
      oi = oi * c - or * sN; or = nor;
      // CIC integrators
      i0 = (i0 + re) | 0; i1 = (i1 + i0) | 0; i2 = (i2 + i1) | 0;
      q0 = (q0 + im) | 0; q1 = (q1 + q0) | 0; q2 = (q2 + q1) | 0;
      if (++n >= R) {
        n = 0;
        // 3rd-order comb, I
        let x = i2, d0 = (x - cIp[0]) | 0; cIp[0] = x;
        let d1 = (d0 - cIp[1]) | 0; cIp[1] = d0;
        let d2 = (d1 - cIp[2]) | 0; cIp[2] = d1;
        const bi0 = d2 * 4 / cicGain;
        // 3rd-order comb, Q
        x = q2; d0 = (x - cQp[0]) | 0; cQp[0] = x;
        d1 = (d0 - cQp[1]) | 0; cQp[1] = d0;
        d2 = (d1 - cQp[2]) | 0; cQp[2] = d1;
        const bq0 = d2 * 4 / cicGain;

        // 12.5 kHz channel FIR (circular history)
        const hI = this._hI, hQ = this._hQ, fir = this._fir, L = fir.length;
        let hp = this._hP; hI[hp] = bi0; hQ[hp] = bq0;
        let bi = 0, bq = 0;
        for (let t = 0, j = hp; t < L; t++) { bi += fir[t] * hI[j]; bq += fir[t] * hQ[j]; if (--j < 0) j = L - 1; }
        this._hP = (hp + 1) % L;

        sumSq += bi * bi + bq * bq; cnt++;

        // FM discriminate: angle(curr * conj(prev))
        const yr = bi * pre + bq * pim;
        const yi = bq * pre - bi * pim;
        pre = bi; pim = bq;
        const ang = Math.atan2(yi, yr);
        angSq += ang * ang;

        dc = 0.9995 * dc + 0.0005 * ang;         // remove carrier offset
        const a = ang - dc;
        deemph = deemph + 0.45 * (a - deemph);   // de-emphasis
        lpf = lpf + 0.6 * (deemph - lpf);        // gentle audio LPF
        let smp = lpf * this.audioScale * this.gain;
        if (smp > 32767) smp = 32767; else if (smp < -32768) smp = -32768;
        out[outN++] = smp | 0;
      }
      if ((++this._oscN & 1023) === 0) {
        const mag = Math.sqrt(or * or + oi * oi) || 1;
        or /= mag; oi /= mag;
      }
    }

    // persist state
    this._or = or; this._oi = oi;
    this._iI[0] = i0; this._iI[1] = i1; this._iI[2] = i2;
    this._iQ[0] = q0; this._iQ[1] = q1; this._iQ[2] = q2;
    this._n = n; this._pre = pre; this._pim = pim;
    this._dc = dc; this._deemph = deemph; this._lpf = lpf;
    if (cnt > 0) {
      this.rms = Math.sqrt(sumSq / cnt) / 32768;
      // Channel power (filtered) in dB, and a floor that drops fast and rises slowly (~100 s), so a long over
      // does not pull it up but a changed noise environment is learned.
      const db = 10 * Math.log10(sumSq / cnt / (32768 * 32768) + 1e-30);
      this.chanDb = db;
      if (this.floorDb == null || db < this.floorDb) this.floorDb = this.floorDb == null ? db : this.floorDb + 0.3 * (db - this.floorDb);
      else this.floorDb += 0.0005 * (db - this.floorDb);
      // Noise squelch (v2): FM quieting on the filtered channel. Noise gives a discriminator variance of ~1.2 rad^2
      // (through the 12 kHz filter); a carrier ~10 dB over the noise quiets it below ~0.3. Power-over-floor alone was
      // fooled by whole-band level steps (~13 dB) on the van. Both are reported; quieting decides.
      this.quiet = angSq / cnt;
      const now = Date.now(), margin = db - this.floorDb;
      if (this.quiet < this.quietOpen) { this.sqOpen = true; this._sqUntil = now + this.squelchHangMs; }
      else if (this.quiet > this.quietOpen * 1.5 && now > this._sqUntil) this.sqOpen = false;
    }

    if (outN > 0) {
      const payload = Buffer.allocUnsafe(outN * 2);
      if (this.squelchEnabled && !this.sqOpen) {
        payload.fill(0);
      } else {
        for (let i = 0; i < outN; i++) payload.writeInt16LE(out[i], i * 2);
      }
      this.frames++; this.bytes += payload.length; this.lastAt = Date.now();
      this.emit('audio', payload);
    }
  }

  dispose() { try { this.sdr.off('iq', this._onIq); } catch {} }
}

module.exports = SecondDemod;
