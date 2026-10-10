'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IqDecimator } = require('../modules/iq-decimator');

const FS = 2_000_000;

function tone(hz, n, amp = 8000, fs = FS, phase0 = 0) {
  const b = Buffer.alloc(n * 4);
  for (let k = 0; k < n; k++) {
    const ph = phase0 + 2 * Math.PI * hz * k / fs;
    b.writeInt16LE(Math.round(amp * Math.cos(ph)), k * 4);
    b.writeInt16LE(Math.round(amp * Math.sin(ph)), k * 4 + 2);
  }
  return b;
}

function rms(buf, skip = 64) {
  let s = 0, n = 0;
  for (let k = skip; k < buf.length / 4; k++) {
    const i = buf.readInt16LE(k * 4), q = buf.readInt16LE(k * 4 + 2);
    s += i * i + q * q; n++;
  }
  return Math.sqrt(s / n);
}

const db = (a, b) => 20 * Math.log10(a / b);

test('÷2 passes the tower channels (0, +75, +125 kHz) at unity gain', () => {
  for (const hz of [0, 75_000, -75_000, 125_000]) {
    const out = new IqDecimator(2).process(tone(hz, 40_000));
    assert.ok(Math.abs(db(rms(out), 8000)) < 0.1, `${hz} Hz: ${db(rms(out), 8000).toFixed(3)} dB`);
  }
});

test('÷2 rejects what would alias onto ±131 kHz by ≥ 70 dB', () => {
  // At fs/2 = 1 MHz, an input at ±(1 MHz − f) folds onto ∓f. Check the folding band 869 k…1 MHz.
  for (const hz of [869_000, 900_000, 925_000, 1_000_000 - 75_000, -925_000, -880_000]) {
    const out = new IqDecimator(2).process(tone(hz, 40_000));
    const rej = -db(rms(out) || 0.5, 8000);
    assert.ok(rej >= 70, `${hz} Hz rejected only ${rej.toFixed(1)} dB`);
  }
});

test('÷4 keeps ±131 kHz flat and rejects its folding band by ≥ 40 dB', () => {
  for (const hz of [0, 75_000, 125_000]) {
    const out = new IqDecimator(4).process(tone(hz, 80_000));
    assert.ok(Math.abs(db(rms(out), 8000)) < 0.5, `${hz}: ${db(rms(out), 8000).toFixed(3)} dB`);
  }
  for (const hz of [380_000, 425_000, -440_000, 900_000]) {
    const out = new IqDecimator(4).process(tone(hz, 80_000));
    const rej = -db(rms(out) || 0.5, 8000);
    assert.ok(rej >= 40, `${hz} Hz rejected only ${rej.toFixed(1)} dB`);
  }
});

test('output length is input/factor and chunking does not change a single sample', () => {
  const input = Buffer.concat([tone(75_000, 30_001), tone(-200_000, 9_999, 3000)]);
  for (const f of [2, 4, 8]) {
    const whole = new IqDecimator(f).process(input);
    assert.equal(whole.length / 4, Math.ceil((input.length / 4) / f));
    const d = new IqDecimator(f);
    const parts = [];
    // odd byte splits too: a frame boundary can cut a sample in half
    let off = 0;
    for (const len of [4, 6, 1, 4093, 65_536, 3, 77_777]) { parts.push(d.process(input.subarray(off, off + len))); off += len; }
    parts.push(d.process(input.subarray(off)));
    assert.deepEqual(Buffer.concat(parts), whole, `factor ${f}`);
  }
});

test('clips to s16 instead of wrapping', () => {
  const out = new IqDecimator(2).process(tone(0, 2000, 32767));
  for (let k = 0; k < out.length / 2; k++) assert.ok(Math.abs(out.readInt16LE(k * 2)) <= 32767);
});

test('refuses factors other than 2, 4, 8', () => {
  for (const f of [0, 1, 3, 5, 16]) assert.throws(() => new IqDecimator(f));
});
