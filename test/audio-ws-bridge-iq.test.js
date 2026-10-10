'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const WebSocket = require('ws');
const AudioWsBridge = require('../modules/audio-ws-bridge');

function freePort() {
  return new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function mkBridge(opts = {}) {
  const sdr = new EventEmitter();
  sdr.config = { sampleRate: 2_000_000, frequency: 455_625_000 };
  sdr.getLastFft = () => ({ bins: [] });
  const port = await freePort();
  const bridge = new AudioWsBridge(sdr, { port, ...opts });
  await new Promise((r) => bridge.server.listening ? r() : bridge.server.once('listening', r));
  return { sdr, bridge, port, close: () => { clearInterval(bridge._spectrumTimer); bridge.wssIq.clients.forEach((c) => c.terminate()); return new Promise((r) => bridge.server.close(r)); } };
}

function connect(port, path) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const msgs = [];
    ws.on('message', (d, isBin) => msgs.push(isBin ? d : JSON.parse(d.toString())));
    ws.once('open', () => res({ ws, msgs }));
    ws.once('error', rej);
    ws.once('unexpected-response', (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
  });
}

const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
const iqChunk = (n) => Buffer.alloc(n * 4, 1);

test('?decim=2 reader gets a hello at fs/2 and half the bytes; a full-rate reader is unchanged', async () => {
  const b = await mkBridge();
  try {
    const half = await connect(b.port, '/ws/iq?decim=2');
    const full = await connect(b.port, '/ws/iq?fresh=1');
    await until(() => half.msgs.length && full.msgs.length);
    assert.deepEqual([half.msgs[0].sampleRate, half.msgs[0].decim, half.msgs[0].centerHz], [1_000_000, 2, 455_625_000]);
    assert.deepEqual([full.msgs[0].sampleRate, full.msgs[0].decim], [2_000_000, 1]);
    b.sdr.emit('iq', iqChunk(8192));
    await until(() => half.msgs.length >= 2 && full.msgs.length >= 2);
    assert.equal(full.msgs[1].length, 8192 * 4);
    assert.equal(half.msgs[1].length, 4096 * 4);
    half.ws.close(); full.ws.close();
  } finally { await b.close(); }
});

test('a decimator lives only while it has readers', async () => {
  const b = await mkBridge();
  try {
    const r = await connect(b.port, '/ws/iq?decim=4');
    await until(() => b.bridge._iqDecims.has(4));
    r.ws.close();
    await until(() => !b.bridge._iqDecims.has(4));
  } finally { await b.close(); }
});

test('invalid decim is refused at the upgrade', async () => {
  const b = await mkBridge();
  try {
    await assert.rejects(connect(b.port, '/ws/iq?decim=3'));
    await assert.rejects(connect(b.port, '/ws/iq?decim=abc'));
  } finally { await b.close(); }
});

test('a centre change set without a retune event re-sends the hello before the next IQ frame', async () => {
  const b = await mkBridge();
  try {
    const r = await connect(b.port, '/ws/iq?decim=2');
    await until(() => r.msgs.length === 1);
    b.sdr.emit('iq', iqChunk(64));
    await until(() => r.msgs.length === 2);
    b.sdr.config.frequency = 100_000_000; // what POST /api/nrsp/config does — no 'retune' emitted
    b.sdr.emit('iq', iqChunk(64));
    await until(() => r.msgs.length === 4);
    assert.equal(r.msgs[2].centerHz, 100_000_000);
    assert.ok(Buffer.isBuffer(r.msgs[3]));
    r.ws.close();
  } finally { await b.close(); }
});

test('a reader that stops reading gets frames dropped, then is closed 1013 after the slow-reader window', async () => {
  const b = await mkBridge({ iqSlowReaderMs: 300 });
  try {
    const r = await connect(b.port, '/ws/iq?fresh=1');
    await until(() => r.msgs.length === 1);
    r.ws._socket.pause(); // stop draining: kernel buffers fill, then ws.bufferedAmount climbs
    let code = null; r.ws.on('close', (c) => { code = c; });
    const t0 = Date.now();
    while (b.bridge._iqSlowClosed === 0 && Date.now() - t0 < 8000) {
      b.sdr.emit('iq', iqChunk(65_536)); // 256 KB per frame
      await new Promise((res) => setImmediate(res));
    }
    assert.ok(b.bridge._iqDrops > 0, 'frames were dropped');
    assert.equal(b.bridge._iqSlowClosed, 1, 'the slow reader was closed');
    // the bounded queue never grew past ~the limit + one frame
    r.ws._socket.resume();
    await until(() => code !== null, 5000);
    assert.equal(code, 1013);
  } finally { await b.close(); }
});

test('a plain /ws/iq reader keeps the old rules: no hello on a silent centre change, never evicted', async () => {
  const b = await mkBridge({ iqSlowReaderMs: 200 });
  try {
    const r = await connect(b.port, '/ws/iq');
    await until(() => r.msgs.length === 1);
    assert.equal(r.msgs[0].decim, 1);
    b.sdr.config.frequency = 100_000_000;
    b.sdr.emit('iq', iqChunk(64));
    await until(() => r.msgs.length === 2);
    assert.ok(Buffer.isBuffer(r.msgs[1]), 'no extra hello for a legacy reader');
    r.ws._socket.pause();
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) { b.sdr.emit('iq', iqChunk(65_536)); await new Promise((res) => setImmediate(res)); }
    assert.equal(b.bridge._iqSlowClosed, 0, 'legacy reader never closed');
    assert.ok(b.bridge._iqDrops > 0, 'but frames above 2 MB buffered are dropped, as before');
    r.ws._socket.resume(); r.ws.close();
  } finally { await b.close(); }
});
