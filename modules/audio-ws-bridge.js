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
 *                   interleaved:true} on connect / rate-change, then binary
 *                   interleaved s16-LE I/Q (same buffer sdr-manager emits).
 *                   Refcounted: SPECTRA enables iq_stream only while clients
 *                   (or /ws/audio2) are connected.
 *
 * Diagnostics (plain HTTP on the same port):
 *   GET /stats          — relay counters + measured byte rate
 *   GET /dump?ms=3000   — capture raw audio payload for wire-format analysis
 */
const http = require('http');
const WebSocket = require('ws');

const KNOWN_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const SPECTRUM_PUSH_MS = 150;

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
        this.wssIq.handleUpgrade(req, socket, head, ws => {
          try { ws.send(JSON.stringify(this._iqHello())); } catch {}
          this._notifyIqClients();
          ws.on('close', () => this._notifyIqClients());
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
    if (this.wssIq) { const iq = JSON.stringify(this._iqHello()); this.wssIq.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) { try { c.send(iq); } catch {} } }); }
  }

  _iqHello() {
    const cfg = (this.sdr && this.sdr.config) || {};
    return {
      sampleRate: cfg.sampleRate || 2000000,
      centerHz: cfg.frequency || 0,
      format: 'sc16',
      interleaved: true,
      endian: 'le',
    };
  }

  _notifyIqClients() {
    if (this.onIqClients) { try { this.onIqClients(this.wssIq.clients.size); } catch {} }
  }

  _onIq(payload) {
    if (!this.wssIq.clients.size) return;
    this._iqFrames++;
    this._iqBytes += payload.length;
    this._iqLastAt = Date.now();
    // Drop rather than buffer if a slow client falls behind (~2 MB backlog).
    this.wssIq.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 1 << 21) {
        try { c.send(payload); } catch {}
      }
    });
  }

  iqStats() {
    return {
      clients: this.wssIq.clients.size,
      frames: this._iqFrames,
      bytes: this._iqBytes,
      lastAt: this._iqLastAt,
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

module.exports = AudioWsBridge;
