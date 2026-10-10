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
 */
'use strict';

// Halfband taps h[0..14]; h[7] = 0.5 centre, odd offsets from the centre are 0.
const C1 = 0.297828;   // h[6] = h[8]
const C3 = -0.056935;  // h[4] = h[10]
const C5 = 0.009399;   // h[2] = h[12]
const C7 = -0.000270;  // h[0] = h[14]
const NORM = 1 / (0.5 + 2 * (C1 + C3 + C5 + C7)); // exact unity DC gain
const TAPS = 15;
const HIST = TAPS - 1;

class HalfbandStage {
  constructor() {
    this.hi = new Float32Array(HIST);
    this.hq = new Float32Array(HIST);
    this.count = 0; // input samples consumed so far (decides which inputs produce an output)
    this._cap = 0; this._bi = null; this._bq = null; // scratch, grown to the largest chunk seen
  }

  /** i, q: Float32Array of equal length. Returns {i, q} at half the rate. */
  process(i, q) {
    const n = i.length;
    if (this._cap < HIST + n) { this._cap = HIST + n; this._bi = new Float32Array(this._cap); this._bq = new Float32Array(this._cap); }
    const bi = this._bi, bq = this._bq;
    bi.set(this.hi); bi.set(i, HIST);
    bq.set(this.hq); bq.set(q, HIST);
    // An output is produced for every input whose absolute index is even.
    const first = (this.count & 1) ? 1 : 0;
    const nOut = n > first ? ((n - first + 1) >> 1) : 0;
    const oi = new Float32Array(nOut);
    const oq = new Float32Array(nOut);
    for (let k = 0, m = HIST + first; k < nOut; k++, m += 2) {
      oi[k] = NORM * (0.5 * bi[m - 7] + C1 * (bi[m - 6] + bi[m - 8]) + C3 * (bi[m - 4] + bi[m - 10])
        + C5 * (bi[m - 2] + bi[m - 12]) + C7 * (bi[m] + bi[m - 14]));
      oq[k] = NORM * (0.5 * bq[m - 7] + C1 * (bq[m - 6] + bq[m - 8]) + C3 * (bq[m - 4] + bq[m - 10])
        + C5 * (bq[m - 2] + bq[m - 12]) + C7 * (bq[m] + bq[m - 14]));
    }
    this.hi.set(bi.subarray(n, n + HIST));
    this.hq.set(bq.subarray(n, n + HIST));
    this.count += n;
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
    this._odd = null; // a trailing odd byte pair is impossible for sc16, but a split sample is not
  }

  /** payload: Buffer of interleaved s16-LE I/Q. Returns a Buffer in the same format at fs/factor. */
  process(payload) {
    let buf = payload;
    if (this._odd) { buf = Buffer.concat([this._odd, payload]); this._odd = null; }
    const whole = buf.length - (buf.length % 4);
    if (whole < buf.length) this._odd = Buffer.from(buf.subarray(whole));
    const n = whole >> 2;
    // Int16Array needs 2-byte alignment; ws frames usually are, copy when not. (Host is little-endian:
    // halio aarch64 and every Mac/x86 we run on — sc16 on the wire is LE.)
    const src = (buf.byteOffset & 1) ? Buffer.from(buf.subarray(0, whole)) : buf;
    const s16 = new Int16Array(src.buffer, src.byteOffset, n * 2);
    let i = new Float32Array(n);
    let q = new Float32Array(n);
    for (let k = 0, j = 0; k < n; k++, j += 2) { i[k] = s16[j]; q[k] = s16[j + 1]; }
    for (const s of this.stages) ({ i, q } = s.process(i, q));
    const o16 = new Int16Array(i.length * 2);
    for (let k = 0, j = 0; k < i.length; k++, j += 2) { o16[j] = clamp16(i[k]); o16[j + 1] = clamp16(q[k]); }
    return Buffer.from(o16.buffer, 0, o16.byteLength);
  }
}

function clamp16(v) {
  const r = Math.round(v);
  return r > 32767 ? 32767 : r < -32768 ? -32768 : r;
}
// Int16Array stores already wrap, so the clamp above is what keeps a full-scale burst from flipping sign.

module.exports = { IqDecimator, HalfbandStage, FACTORS, TAPS };
