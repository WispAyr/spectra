/**
 * iq-decimator.js — integer decimation of interleaved s16-LE I/Q (sc16) by 2, 4 or 8.
 *
 * Why (10 Oct 2026): the nRSP Full-IQ tap is 2 Msps sc16 = 64 Mbps over loopback. Its one
 * permanent reader, uhf-iq.py (EGPK ground → Broadnet relay), only needs ±131 kHz around the
 * tower channel (455.625 → 455.75 MHz) and fell 15 MB behind at full rate. Readers can now ask
 * for `/ws/iq?decim=N` and get the same band at fs/N.
 *
 * Each ÷2 stage is a 15-tap halfband (Kaiser β=7, every other tap zero, symmetric), so a stage
 * costs 5 multiplies per output per rail. At ÷2 from 2 Msps the passband ripple is 0.002 dB up
 * to ±131 kHz and anything that would alias onto ±131 kHz is down ≥ 77 dB. Later stages of a ÷4
 * or ÷8 cascade have a narrower transition band (see test/iq-decimator.test.js for the numbers).
 * State is carried across chunks, so chunk boundaries are seamless.
 *
 * Hot path (halio is a loaded Pi 5 with swap full): one interleaved Float32 scratch per stage,
 * grown once and reused — no per-chunk Float32 allocations; only the output Buffer is new.
 */
'use strict';

// Halfband taps h[0..14]; h[7] = 0.5 centre, odd offsets from the centre are 0.
const C1 = 0.297828;   // h[6] = h[8]
const C3 = -0.056935;  // h[4] = h[10]
const C5 = 0.009399;   // h[2] = h[12]
const C7 = -0.000270;  // h[0] = h[14]
const NORM = 1 / (0.5 + 2 * (C1 + C3 + C5 + C7)); // exact unity DC gain
const K0 = 0.5 * NORM, K1 = C1 * NORM, K3 = C3 * NORM, K5 = C5 * NORM, K7 = C7 * NORM;
const TAPS = 15;
const HIST = TAPS - 1;       // complex samples of history
const H2 = HIST * 2;         // … as interleaved floats

class HalfbandStage {
  constructor() {
    this.buf = new Float32Array(H2 + 2 * 8192); // [history | new samples], interleaved I,Q
    this.count = 0; // input samples consumed so far (decides which inputs produce an output)
  }

  /** Make room for n new complex samples after the history; returns the scratch to fill at H2. */
  room(n) {
    if (this.buf.length < H2 + 2 * n) {
      const b = new Float32Array(H2 + 2 * n);
      b.set(this.buf.subarray(0, H2));
      this.buf = b;
    }
    return this.buf;
  }

  /** Filter the n samples already written at buf[H2…]; write n/2-ish outputs into `out` (interleaved,
   *  at outOff). Returns the number of complex outputs. */
  run(n, out, outOff) {
    const b = this.buf;
    const first = (this.count & 1) ? 1 : 0;
    const nOut = n > first ? ((n - first + 1) >> 1) : 0;
    let o = outOff;
    for (let k = 0, m = 2 * (HIST + first); k < nOut; k++, m += 4) {
      // m indexes the newest sample's I; taps reach back 14 complex samples (28 floats).
      out[o++] = K0 * b[m - 14] + K1 * (b[m - 12] + b[m - 16]) + K3 * (b[m - 8] + b[m - 20])
        + K5 * (b[m - 4] + b[m - 24]) + K7 * (b[m] + b[m - 28]);
      out[o++] = K0 * b[m - 13] + K1 * (b[m - 11] + b[m - 15]) + K3 * (b[m - 7] + b[m - 19])
        + K5 * (b[m - 3] + b[m - 23]) + K7 * (b[m + 1] + b[m - 27]);
    }
    b.copyWithin(0, 2 * n, 2 * n + H2); // keep the last HIST samples as history
    this.count += n;
    return nOut;
  }

  /** Convenience for tests: Float32Array i, q in → {i, q} out. */
  process(i, q) {
    const n = i.length;
    const b = this.room(n);
    for (let k = 0; k < n; k++) { b[H2 + 2 * k] = i[k]; b[H2 + 2 * k + 1] = q[k]; }
    const out = new Float32Array(n + 2);
    const m = this.run(n, out, 0);
    const oi = new Float32Array(m), oq = new Float32Array(m);
    for (let k = 0; k < m; k++) { oi[k] = out[2 * k]; oq[k] = out[2 * k + 1]; }
    return { i: oi, q: oq };
  }
}

const FACTORS = [2, 4, 8];

class IqDecimator {
  constructor(factor) {
    if (!FACTORS.includes(factor)) throw new Error(`decim must be one of ${FACTORS.join(', ')}`);
    this.factor = factor;
    this.stages = [];
    for (let f = factor; f > 1; f >>= 1) this.stages.push(new HalfbandStage());
    this._odd = null; // a ws frame can split a 4-byte sample
    this._last = new Float32Array(2 * 4096);
  }

  /** payload: Buffer of interleaved s16-LE I/Q. Returns a Buffer in the same format at fs/factor. */
  process(payload) {
    let buf = payload;
    if (this._odd) { buf = Buffer.concat([this._odd, payload]); this._odd = null; }
    const whole = buf.length - (buf.length % 4);
    if (whole < buf.length) this._odd = Buffer.from(buf.subarray(whole));
    let n = whole >> 2;
    // Int16Array needs 2-byte alignment; ws frames usually are, copy when not. (Host is little-endian:
    // halio aarch64 and every Mac/x86 we run on — sc16 on the wire is LE.)
    const src = (buf.byteOffset & 1) ? Buffer.from(buf.subarray(0, whole)) : buf;
    const s16 = new Int16Array(src.buffer, src.byteOffset, n * 2);

    // Stage 1 reads straight from the s16 samples.
    let st = this.stages[0];
    let b = st.room(n);
    for (let j = 0; j < 2 * n; j++) b[H2 + j] = s16[j];
    for (let s = 0; s < this.stages.length; s++) {
      const next = this.stages[s + 1];
      let out, off;
      if (next) { out = next.room((n >> 1) + 1); off = H2; } else {
        if (this._last.length < n + 2) this._last = new Float32Array(n + 2);
        out = this._last; off = 0;
      }
      n = st.run(n, out, off);
      st = next;
    }
    const o16 = new Int16Array(2 * n);
    const f = this._last;
    for (let j = 0; j < 2 * n; j++) {
      const r = Math.round(f[j]);
      // clamp: Int16Array stores wrap, which would flip a full-scale burst's sign
      o16[j] = r > 32767 ? 32767 : r < -32768 ? -32768 : r;
    }
    return Buffer.from(o16.buffer, 0, o16.byteLength);
  }
}

module.exports = { IqDecimator, HalfbandStage, FACTORS, TAPS };
