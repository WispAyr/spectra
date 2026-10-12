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
    this.squelchLevel = opts.squelchLevel != null ? opts.squelchLevel : 0.004;
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
  setSquelch(on, level) { this.squelchEnabled = !!on; if (level != null) this.squelchLevel = level; }

  stats() {
    return {
      enabled: this.enabled, active: this.active, targetHz: this.targetHz, centerHz: this.centerHz,
      fsAudio: this.fsAudio, offsetHz: this.targetHz - this.centerHz,
      frames: this.frames, bytes: this.bytes, lastAt: this.lastAt,
      rms: +this.rms.toFixed(5), squelch: this.squelchEnabled, squelchLevel: this.squelchLevel,
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
    let sumSq = 0, cnt = 0;

    for (let k = 0; k < nSamp; k++) {
      const I = iq[k * 2], Q = iq[k * 2 + 1];
      // down-convert
      const re = I * or - Q * oi;
      const im = I * oi + Q * or;
      const nor = or * c + oi * sN;      // osc *= e^{-jw}
      oi = oi * c - or * sN; or = nor;
      // CIC integrators
      i0 += re; i1 += i0; i2 += i1;
      q0 += im; q1 += q0; q2 += q1;
      if (++n >= R) {
        n = 0;
        // 3rd-order comb, I
        let x = i2, d0 = x - cIp[0]; cIp[0] = x;
        let d1 = d0 - cIp[1]; cIp[1] = d0;
        let d2 = d1 - cIp[2]; cIp[2] = d1;
        const bi = d2 / cicGain;
        // 3rd-order comb, Q
        x = q2; d0 = x - cQp[0]; cQp[0] = x;
        d1 = d0 - cQp[1]; cQp[1] = d0;
        d2 = d1 - cQp[2]; cQp[2] = d1;
        const bq = d2 / cicGain;

        sumSq += bi * bi + bq * bq; cnt++;

        // FM discriminate: angle(curr * conj(prev))
        const yr = bi * pre + bq * pim;
        const yi = bq * pre - bi * pim;
        pre = bi; pim = bq;
        const ang = Math.atan2(yi, yr);

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
    if (cnt > 0) this.rms = Math.sqrt(sumSq / cnt) / 32768;

    if (outN > 0) {
      const payload = Buffer.allocUnsafe(outN * 2);
      if (this.squelchEnabled && this.rms < this.squelchLevel) {
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
