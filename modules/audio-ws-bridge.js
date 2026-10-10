/**
 * audio-ws-bridge.js — radio WS bridge for the CSU kiosk
 *
 * WebSocket paths on 127.0.0.1:<port> (kiosk proxies these):
 *
 *   /ws/audio     — demodulated audio as mono s16-LE PCM.
 *                   SDRconnect wire format (measured 2026-06-10): s16-LE
 *                   STEREO with identical L/R at 48 kHz, 50 ms frames, no
 *                   header. We downmix to mono and decimate 2:1 with a 2-tap
 *                   average → 24 kHz (~48 KB/s; was 96 — kinder to Starlink,
 *                   still 12 kHz audio bandwidth). Protocol: JSON
 *                   { sampleRate } on connect / rate change, then binary PCM.
 *
 *   /ws/audio48   — same framing as /ws/audio but NO 2:1 decimation: stereo
 *                   downmix only → mono s16 @ 48 kHz. For DMR/dsd-fme which
 *                   needs full-rate 4FSK. Kiosk/tower must keep /ws/audio.
 *
 *   /ws/spectrum  — live radio state pushed ~6.5 fps (replaces the kiosk's
 *                   150 ms HTTP polling of /api/spectrum/fft, which shipped
 *                   ~10 KB full-precision JSON per request). Frames are the
 *                   sdr-manager getLastFft() object with bins rounded to
 *                   integer dB (~2.5 KB). Sent only when fresh spectrum
 *                   arrived since the last push.
 *
 *   /ws/iq        — raw Full-IQ tap for nRSP-session modes (e.g. DAB).
 *                   Protocol: JSON hello {sampleRate,centerHz,format:"sc16",
 *                   interleaved:true,decim} on connect, retune or rate change,
 *                   then binary interleaved s16-LE I/Q.
 *                   `/ws/iq?decim=2|4|8` = the same tap decimated in-process
 *                   (halfband cascade, modules/iq-decimator.js), sampleRate in
 *                   the hello is already divided. One decimator per factor is
 *                   shared by every reader of that factor. (10 Oct 2026)
 *                   Refcounted: SPECTRA enables iq_stream only while clients
 *                   (or /ws/audio2) are connected.
 *                   Opt-in readers (decim>1 or ?fresh=1): bounded to ~0.25 s
 *                   of their stream (min 256 KB) — frames dropped beyond that,
 *                   and a reader behind for IQ_SLOW_READER_MS (15 s) is closed
 *                   with 1013 to reconnect fresh; hello re-sent whenever the
 *                   centre/rate changed. A plain /ws/iq reader (uhf-iq.py, the
 *                   tower relay — review-only per Ewan 10 Oct 2026) keeps the
 *                   exact old semantics: drop above 2 MB buffered, never
 *                   closed, hellos only on 'retune'.
 *
 * Diagnostics (plain HTTP on the same port):
 *   GET /stats          — relay counters + measured byte rate
 *   GET /dump?ms=3000   — capture raw audio payload for wire-format analysis
 */
const http = require('http');
const WebSocket = require('ws');
const { IqDecimator, FACTORS } = require('./iq-decimator');

const KNOWN_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const SPECTRUM_PUSH_MS = 150;
const IQ_MIN_BUFFER = 256 * 1024;       // never drop below this much queued
const IQ_BUFFER_SECONDS = 0.25;         // else allow ~0.25 s of the reader's own stream
const IQ_SLOW_READER_MS = 15000;        // continuously behind this long → close 1013

class AudioWsBridge {
  constructor(sdrManager, opts = {}) {
    this.sdr = sdrManager;
    if (this.sdr && this.sdr.on) this.sdr.on('retune', () => this._reemitHellos());
    this.port = opts.port || 3334;
    this.host = opts.host || '127.0.0.1';
    this.fixedRate = opts.sampleRate || 0;
    this.measuredRate = 0;
    this._win = { bytes: 0, start: Date.now() };
    this._frames = 0;
    this._bytes = 0;
    this._lastAt = 0;
    this._dump = null;
    this._lastSpectrumPush = 0;
    this.audio2Rate = opts.audio2Rate || 40000;
    this.onAudio2Clients = null;
    this._a2frames = 0; this._a2bytes = 0; this._a2lastAt = 0;

    this.server = http.createServer((req, res) => this._onHttp(req, res));
    this.wssAudio = new WebSocket.Server({ noServer: true });
    this.wssAudio48 = new WebSocket.Server({ noServer: true });
    this.wssSpectrum = new WebSocket.Server({ noServer: true });
    this.wssAudio2 = new WebSocket.Server({ noServer: true });
    this.wssIq = new WebSocket.Server({ noServer: true });
    this._a48frames = 0; this._a48bytes = 0; this._a48lastAt = 0;
    this._iqFrames = 0; this._iqBytes = 0; this._iqLastAt = 0;
    this._iqDecims = new Map();           // factor → IqDecimator, while it has readers
    this._iqDrops = 0; this._iqSlowClosed = 0;
    this.iqSlowReaderMs = opts.iqSlowReaderMs || IQ_SLOW_READER_MS;
    this.onIqClients = null;   // SPECTRA re-eval iq_stream_enable

    this.server.on('upgrade', (req, socket, head) => {
      const path = (req.url || '').split('?')[0];
      if (path === '/ws/audio') {
        this.wssAudio.handleUpgrade(req, socket, head, ws => {
          try { ws.send(JSON.stringify(this._audioHello(this.currentRate()))); } catch {}
        });
      } else if (path === '/ws/audio48') {
        // Native 48 kHz mono for DMR/dsd — never change /ws/audio default.
        this.wssAudio48.handleUpgrade(req, socket, head, ws => {
          try { ws.send(JSON.stringify(this._audioHello(48000))); } catch {}
        });
      } else if (path === '/ws/spectrum') {
        this.wssSpectrum.handleUpgrade(req, socket, head, ws => {
          const f = this._spectrumFrame();
          if (f) { try { ws.send(f); } catch {} }
        });
      } else if (path === '/ws/audio2') {
        this.wssAudio2.handleUpgrade(req, socket, head, ws => {
          try { ws.send(JSON.stringify(this._audioHello(this.audio2Rate))); } catch {}
          this._notifyA2Clients();
          ws.on('close', () => this._notifyA2Clients());
        });
      } else if (path === '/ws/iq') {
        const decim = parseDecim(req.url);
        const fresh = decim > 1 || /[?&]fresh=1(&|$)/.test(req.url || '');
        if (decim === null) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
        this.wssIq.handleUpgrade(req, socket, head, ws => {
          ws.iqDecim = decim; ws.iqFresh = fresh; ws.iqDrops = 0; ws.iqBehindSince = 0; ws.iqSent = 0;
          if (decim > 1 && !this._iqDecims.has(decim)) this._iqDecims.set(decim, new IqDecimator(decim));
          ws.iqHelloKey = this._iqKey();
          try { ws.send(JSON.stringify(this._iqHello(decim))); } catch {}
          this._notifyIqClients();
          ws.on('close', () => { this._pruneDecims(); this._notifyIqClients(); });
        });
      } else {
        socket.destroy();
      }
    });

    this.sdr.on('audio', (payload) => this._onAudio(payload));
    this.sdr.on('iq', (payload) => this._onIq(payload));

    this._spectrumTimer = setInterval(() => this._pushSpectrum(), SPECTRUM_PUSH_MS);

    this.server.listen(this.port, this.host, () => {
      console.log(`[AudioWS] PCM + spectrum relay listening ${this.host}:${this.port}`);
    });
    this.server.on('error', (e) => console.warn(`[AudioWS] ${e.message}`));
  }

  currentRate() {
    return this.fixedRate || this.measuredRate || 24000;
  }

  // ── spectrum push ─────────────────────────────────────────────────────────

  _spectrumFrame() {
    if (!this.sdr.getLastFft) return null;
    const d = this.sdr.getLastFft();
    if (!d.bins || !d.bins.length) return null;
    d.bins = d.bins.map(b => Math.round(b));
    d.ok = true;
    return JSON.stringify(d);
  }

  _pushSpectrum() {
    if (!this.wssSpectrum.clients.size) return;
    const at = this.sdr.lastSpectrumAt || 0;
    if (at <= this._lastSpectrumPush) return;
    this._lastSpectrumPush = at;
    const frame = this._spectrumFrame();
    if (!frame) return;
    this.wssSpectrum.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 1 << 18) {
        try { c.send(frame); } catch {}
      }
    });
  }

  // ── audio ─────────────────────────────────────────────────────────────────

  _onAudio(payload) {
    this._frames++;
    this._bytes += payload.length;
    this._lastAt = Date.now();

    if (this._dump) {
      this._dump.chunks.push(Buffer.from(payload));
      this._dump.frames.push(payload.length);
    }

    // SDRconnect: s16-LE stereo identical L/R @ 48 kHz, no header.
    // pairs = stereo frames in this payload.
    const pairs = payload.length >> 2;
    if (pairs < 2) return;

    // /ws/audio48: stereo → mono, NO decimation (native 48 kHz for dsd-fme).
    if (this.wssAudio48.clients.size) {
      const mono48 = Buffer.allocUnsafe(pairs * 2);
      for (let i = 0; i < pairs; i++) {
        const a = payload.readInt16LE(i * 4);
        const b = payload.readInt16LE(i * 4 + 2);
        mono48.writeInt16LE((a + b) >> 1, i * 2);
      }
      this._a48frames++;
      this._a48bytes += mono48.length;
      this._a48lastAt = Date.now();
      this.wssAudio48.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 1 << 20) {
          try { c.send(mono48); } catch {}
        }
      });
    }

    // /ws/audio: stereo → mono, then 2:1 decimate with a 2-tap average (48→24 kHz).
    const outN = pairs >> 1;
    const mono = Buffer.allocUnsafe(outN * 2);
    for (let i = 0; i < outN; i++) {
      const a = payload.readInt16LE(i * 8);
      const b = payload.readInt16LE(i * 8 + 4);
      mono.writeInt16LE((a + b) >> 1, i * 2);
    }

    // Rolling rate measurement over ~5s windows (s16 mono assumed) — 24k path only
    this._win.bytes += mono.length;
    const dt = Date.now() - this._win.start;
    if (dt >= 5000) {
      const raw = this._win.bytes / (dt / 1000) / 2;
      let best = KNOWN_RATES[0];
      for (const r of KNOWN_RATES) if (Math.abs(r - raw) < Math.abs(best - raw)) best = r;
      const snapped = Math.abs(best - raw) / best <= 0.10 ? best : Math.round(raw);
      if (!this.fixedRate && snapped !== this.measuredRate) {
        this.measuredRate = snapped;
        const meta = JSON.stringify(this._audioHello(snapped));
        this.wssAudio.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) { try { c.send(meta); } catch {} } });
      }
      this._win = { bytes: 0, start: Date.now() };
    }

    this.wssAudio.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 1 << 20) {
        try { c.send(mono); } catch {}
      }
    });
  }

  _audioHello(rate) {
    const cfg = (this.sdr && this.sdr.config) || {};
    return { sampleRate: rate, centerHz: cfg.frequency || 0 };
  }

  // Re-emit hellos to already-connected clients on retune so a mid-stream
  // consumer never holds a stale sampleRate/centerHz. (2026-08-05)
  _reemitHellos() {
    const sendA = (wss, rate) => { if (!wss) return; const m = JSON.stringify(this._audioHello(rate)); wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) { try { c.send(m); } catch {} } }); };
    sendA(this.wssAudio, this.currentRate());
    sendA(this.wssAudio48, 48000);
    sendA(this.wssAudio2, this.audio2Rate);
    this._sendIqHellos();
  }

  /** Re-announce centre/rate to IQ readers. stale=true: only those whose last hello no longer matches. */
  _sendIqHellos(stale = false) {
    if (!this.wssIq) return;
    const key = this._iqKey();
    this.wssIq.clients.forEach(c => {
      if (stale && (!c.iqFresh || c.iqHelloKey === key)) return;
      c.iqHelloKey = key;
      if (c.readyState === WebSocket.OPEN) { try { c.send(JSON.stringify(this._iqHello(c.iqDecim || 1))); } catch {} }
    });
  }

  _iqKey() {
    const cfg = (this.sdr && this.sdr.config) || {};
    return `${cfg.frequency || 0}/${cfg.sampleRate || 2000000}`;
  }

  _iqHello(decim = 1) {
    const cfg = (this.sdr && this.sdr.config) || {};
    const fs = cfg.sampleRate || 2000000;
    return {
      sampleRate: Math.round(fs / decim),
      centerHz: cfg.frequency || 0,
      format: 'sc16',
      interleaved: true,
      endian: 'le',
      decim,
    };
  }

  _pruneDecims() {
    const live = new Set();
    this.wssIq.clients.forEach(c => live.add(c.iqDecim || 1));
    for (const f of [...this._iqDecims.keys()]) if (!live.has(f)) this._iqDecims.delete(f);
  }

  /** Send one IQ frame to one reader, bounded. Returns false if dropped. */
  _sendIqBounded(c, buf, now) {
    if (c.readyState !== WebSocket.OPEN) return false;
    if (!c.iqFresh) { // legacy reader: exactly the pre-10-Oct rule
      if (c.bufferedAmount >= 1 << 21) { c.iqDrops++; this._iqDrops++; return false; }
      c.iqSent += buf.length; try { c.send(buf); } catch {} return true;
    }
    const fs = ((this.sdr && this.sdr.config && this.sdr.config.sampleRate) || 2000000) / (c.iqDecim || 1);
    const limit = Math.max(IQ_MIN_BUFFER, fs * 4 * IQ_BUFFER_SECONDS);
    if (c.bufferedAmount > limit) {
      c.iqDrops++; this._iqDrops++;
      if (!c.iqBehindSince) c.iqBehindSince = now;
      else if (now - c.iqBehindSince > this.iqSlowReaderMs) {
        this._iqSlowClosed++;
        console.warn(`[AudioWS] /ws/iq reader (decim ${c.iqDecim || 1}) behind for ${now - c.iqBehindSince} ms — closing 1013`);
        try { c.close(1013, 'slow reader'); } catch {}
        setTimeout(() => { try { c.terminate(); } catch {} }, 2000).unref?.();
      }
      return false;
    }
    c.iqBehindSince = 0;
    c.iqSent += buf.length;
    try { c.send(buf); } catch {}
    return true;
  }

  _notifyIqClients() {
    if (this.onIqClients) { try { this.onIqClients(this.wssIq.clients.size); } catch {} }
  }

  _onIq(payload) {
    if (!this.wssIq.clients.size) return;
    const now = Date.now();
    this._iqFrames++;
    this._iqBytes += payload.length;
    this._iqLastAt = now;
    // POST /api/nrsp/config sets config.frequency before SDRconnect echoes it, so no 'retune'
    // fires and readers kept a stale centre (uhf-iq ran 30 h DDC-ing at "100 MHz", 10 Oct 2026).
    this._sendIqHellos(true);
    const out = new Map([[1, payload]]);
    for (const [f, d] of this._iqDecims) out.set(f, d.process(payload));
    this.wssIq.clients.forEach(c => {
      const buf = out.get(c.iqDecim || 1);
      if (buf && buf.length) this._sendIqBounded(c, buf, now);
    });
  }

  iqStats() {
    const readers = [];
    this.wssIq.clients.forEach(c => readers.push({ decim: c.iqDecim || 1, bufferedAmount: c.bufferedAmount, drops: c.iqDrops || 0, sentBytes: c.iqSent || 0, behindMs: c.iqBehindSince ? Date.now() - c.iqBehindSince : 0 }));
    return {
      clients: this.wssIq.clients.size,
      frames: this._iqFrames,
      bytes: this._iqBytes,
      lastAt: this._iqLastAt,
      drops: this._iqDrops,
      slowClosed: this._iqSlowClosed,
      readers,
      hello: this._iqHello(),
    };
  }

  _notifyA2Clients() {
    if (this.onAudio2Clients) { try { this.onAudio2Clients(this.wssAudio2.clients.size); } catch {} }
    // audio2 also needs IQ — re-eval combined gate via iq callback if wired
    if (this.onIqClients) { try { this.onIqClients(this.wssIq.clients.size); } catch {} }
  }

  // Second in-process demod channel (e.g. 455.7) relayed on /ws/audio2.
  pushAudio2(payload) {
    this._a2frames++; this._a2bytes += payload.length; this._a2lastAt = Date.now();
    this.wssAudio2.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 1 << 20) {
        try { c.send(payload); } catch {}
      }
    });
  }

  audio2Stats() {
    return { clients: this.wssAudio2.clients.size, frames: this._a2frames, bytes: this._a2bytes, lastAt: this._a2lastAt, rate: this.audio2Rate };
  }

  _onHttp(req, res) {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        audioClients: this.wssAudio.clients.size,
        audio48Clients: this.wssAudio48.clients.size,
        audio48Frames: this._a48frames,
        audio48Bytes: this._a48bytes,
        audio48LastAt: this._a48lastAt,
        audio48Rate: 48000,
        iqClients: this.wssIq.clients.size,
        iqFrames: this._iqFrames,
        iqBytes: this._iqBytes,
        iqLastAt: this._iqLastAt,
        iqDrops: this._iqDrops,
        iqSlowClosed: this._iqSlowClosed,
        iqReaders: this.iqStats().readers,
        iq: this._iqHello(),
        spectrumClients: this.wssSpectrum.clients.size,
        audio2Clients: this.wssAudio2.clients.size,
        audio2Frames: this._a2frames,
        audio2Bytes: this._a2bytes,
        audio2LastAt: this._a2lastAt,
        clients: this.wssAudio.clients.size,
        frames: this._frames,
        bytes: this._bytes,
        lastAt: this._lastAt,
        fixedRate: this.fixedRate,
        measuredRate: this.measuredRate,
        rate: this.currentRate(),
      }));
      return;
    }
    if (u.pathname === '/dump') {
      const ms = Math.min(parseInt(u.searchParams.get('ms') || '3000', 10), 15000);
      if (this._dump) { res.writeHead(409); res.end('dump in progress'); return; }
      this._dump = { chunks: [], frames: [] };
      setTimeout(() => {
        const d = this._dump; this._dump = null;
        const body = Buffer.concat(d.chunks);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-frames': String(d.frames.length),
          'x-frame-sizes': d.frames.slice(0, 12).join(','),
          'x-ms': String(ms),
        });
        res.end(body);
      }, ms);
      return;
    }
    res.writeHead(404); res.end();
  }
}

/** `?decim=N` → N (1 when absent). null = invalid (the upgrade is refused with 400). */
function parseDecim(url) {
  const q = (url || '').split('?')[1];
  if (!q) return 1;
  const v = new URLSearchParams(q).get('decim');
  if (v === null || v === '' || v === '1') return 1;
  const n = Number(v);
  return FACTORS.includes(n) ? n : null;
}

module.exports = AudioWsBridge;
module.exports.parseDecim = parseDecim;
