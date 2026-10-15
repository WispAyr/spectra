/**
 * iq-tcp-server.js — expose nRSP-ST IQ stream to local decoders.
 *
 * SPECTRA's SdrManager pulls interleaved s16-LE I/Q samples from the
 * SDRconnect_headless WebSocket. This module fans those samples out two ways:
 *
 *   1. As raw s16-LE bytes written to a FIFO at config.fifoPath. readsb
 *      consumes this directly with `--device-type ifile --ifile <path>
 *      --iformat SC16`, with no format conversion needed (SDRconnect's
 *      native sample width matches SC16). The FIFO is recreated on start
 *      and stale data is discarded if no reader is attached.
 *
 *   2. As an rtl_tcp-compatible TCP server on config.port. Tools like
 *      rtl_433 and rtl_ais speak rtl_tcp and expect u8 samples, so this
 *      side does the s16->u8 conversion ((s16 >> 8) + 128) per sample.
 *      Single-client; the protocol handshake mirrors librtlsdr's
 *      `RTL0`+tuner+gain-count header.
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RTL_CMDS = {
  0x01: 'set_freq', 0x02: 'set_samp', 0x03: 'set_gain_mode',
  0x04: 'set_gain', 0x05: 'set_ppm', 0x06: 'set_if_gain',
  0x07: 'set_test_mode', 0x08: 'set_agc_mode', 0x09: 'set_direct_samp',
  0x0a: 'set_offset_tuning', 0x0b: 'set_rtl_xtal', 0x0c: 'set_tuner_xtal',
  0x0d: 'set_gain_by_idx', 0x0e: 'set_bias_tee'
};

class IqTcpServer {
  constructor(config, sdrManager) {
    this.port = (config && config.port) || 1234;
    this.host = (config && config.host) || '127.0.0.1';
    this.fifoPath = (config && config.fifoPath) || '/run/spectra/iq.s16le';
    this.tunerType = (config && config.tunerType) || 5; // claim R820T
    this.gainCount = (config && config.gainCount) || 29;
    this.sdrManager = sdrManager;
    this.server = null;
    this.client = null;
    this.clientAddr = null;
    this.bytesSent = 0;
    this.connectedAt = 0;
    this.fifoFd = null;
    this.fifoBytesWritten = 0;
    this._onIq = (payload) => this._handleIq(payload);
    this._fifoBacklog = 0;
  }

  start() {
    this._setupFifo();
    this.server = net.createServer((sock) => this._handleTcpClient(sock));
    this.server.listen(this.port, this.host, () => {
      console.log(`[IQ-bridge] rtl_tcp listening on ${this.host}:${this.port}`);
      console.log(`[IQ-bridge] FIFO: ${this.fifoPath} (SC16 raw, readsb ifile)`);
    });
    this.server.on('error', (err) => {
      console.error(`[IQ-bridge] server error: ${err.code || err.message}`);
    });
    this.sdrManager.on('iq', this._onIq);
    this._iqEventCount = 0;
    this._iqBytesIn = 0;
    // Periodic stat line so it's obvious from logs whether IQ is flowing.
    this._statsTimer = setInterval(() => {
      const evts = this._iqEventCount; this._iqEventCount = 0;
      const bytes = this._iqBytesIn; this._iqBytesIn = 0;
      if (evts > 0 || this.client) {
        console.log(`[IQ-bridge] 30s window: ${evts} iq events, ${(bytes/1024).toFixed(1)} KiB in, fifo-fd=${this.fifoFd != null ? 'open' : 'closed'}, fifo-total=${(this.fifoBytesWritten/1048576).toFixed(2)} MiB, tcp-client=${this.client ? 'attached' : 'none'}`);
      }
    }, 30000);
  }

  stop() {
    this.sdrManager.off('iq', this._onIq);
    if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
    if (this.client) { try { this.client.destroy(); } catch {} this.client = null; }
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
    this._closeFifo();
  }

  stats() {
    return {
      port: this.port,
      fifoPath: this.fifoPath,
      hasClient: !!this.client,
      clientAddr: this.clientAddr,
      tcpBytesSent: this.bytesSent,
      fifoBytesWritten: this.fifoBytesWritten,
      tcpUptimeSec: this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0
    };
  }

  _setupFifo() {
    const dir = path.dirname(this.fifoPath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* exists */ }
    let needsCreate = false;
    try {
      const stat = fs.statSync(this.fifoPath);
      if (!stat.isFIFO()) {
        fs.unlinkSync(this.fifoPath);
        needsCreate = true;
      }
    } catch (e) {
      needsCreate = true;
    }
    if (needsCreate) {
      try {
        execFileSync('mkfifo', ['-m', '0666', this.fifoPath]);
        console.log(`[IQ-bridge] created FIFO ${this.fifoPath}`);
      } catch (e) {
        console.error(`[IQ-bridge] mkfifo failed for ${this.fifoPath}: ${e.message}`);
        return;
      }
    }
    this._openFifoIfReader();
  }

  _openFifoIfReader() {
    if (this.fifoFd != null) return;
    // Open non-blocking write-only. Will fail with ENXIO if no reader yet —
    // that's fine; we'll retry on the next IQ chunk.
    try {
      const fd = fs.openSync(this.fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      this.fifoFd = fd;
      console.log(`[IQ-bridge] FIFO reader attached, streaming SC16`);
    } catch (e) {
      // ENXIO = no reader; quietly skip until one appears.
      if (e.code !== 'ENXIO' && e.code !== 'EACCES') {
        console.error(`[IQ-bridge] FIFO open failed: ${e.code || e.message}`);
      }
    }
  }

  _closeFifo() {
    if (this.fifoFd != null) {
      try { fs.closeSync(this.fifoFd); } catch {}
      this.fifoFd = null;
    }
  }

  _writeFifo(payload) {
    if (this.fifoFd == null) {
      this._openFifoIfReader();
      if (this.fifoFd == null) return;
    }
    try {
      const written = fs.writeSync(this.fifoFd, payload, 0, payload.length);
      this.fifoBytesWritten += written;
    } catch (e) {
      if (e.code === 'EPIPE' || e.code === 'EBADF') {
        // Reader went away.
        console.log(`[IQ-bridge] FIFO reader disconnected (${e.code})`);
        this._closeFifo();
      } else if (e.code === 'EAGAIN') {
        // Reader can't keep up; drop and move on.
        this._fifoBacklog++;
        if (this._fifoBacklog % 100 === 1) {
          console.log(`[IQ-bridge] FIFO reader slow, dropped ${this._fifoBacklog} chunks`);
        }
      } else {
        console.error(`[IQ-bridge] FIFO write error: ${e.code || e.message}`);
      }
    }
  }

  _handleTcpClient(sock) {
    if (this.client) {
      console.log(`[IQ-bridge] refusing second TCP client ${sock.remoteAddress}:${sock.remotePort}`);
      try { sock.destroy(); } catch {}
      return;
    }
    this.client = sock;
    this.clientAddr = `${sock.remoteAddress}:${sock.remotePort}`;
    this.bytesSent = 0;
    this.connectedAt = Date.now();
    console.log(`[IQ-bridge] TCP client connected: ${this.clientAddr}`);

    const hdr = Buffer.alloc(12);
    hdr.write('RTL0', 0, 'ascii');
    hdr.writeUInt32BE(this.tunerType, 4);
    hdr.writeUInt32BE(this.gainCount, 8);
    sock.write(hdr);

    sock.setNoDelay(true);
    sock.on('data', (buf) => this._handleTcpCmd(buf));
    sock.on('close', () => {
      const sent = (this.bytesSent / 1048576).toFixed(1);
      console.log(`[IQ-bridge] TCP client disconnected: ${this.clientAddr} (sent ${sent} MiB)`);
      this.client = null;
      this.clientAddr = null;
      this.connectedAt = 0;
    });
    sock.on('error', () => { /* close fires next */ });
  }

  _handleTcpCmd(buf) {
    for (let i = 0; i + 5 <= buf.length; i += 5) {
      const cmd = buf[i];
      const val = buf.readUInt32BE(i + 1);
      const name = RTL_CMDS[cmd] || `cmd_0x${cmd.toString(16)}`;
      console.log(`[IQ-bridge] TCP client ${name}=${val} (logged, not forwarded)`);
    }
  }

  _handleIq(payload) {
    this._iqEventCount++;
    this._iqBytesIn += payload.length;
    // Fan out to both consumers. FIFO gets the raw s16-LE bytes verbatim.
    this._writeFifo(payload);

    // TCP path needs s16 -> u8 conversion (rtl_tcp wire format).
    if (this.client && !this.client.destroyed) {
      const n = payload.length >> 1;
      const out = Buffer.allocUnsafe(n);
      for (let i = 0; i < n; i++) {
        const s = payload.readInt16LE(i << 1);
        out[i] = ((s >> 8) + 128) & 0xff;
      }
      this.bytesSent += out.length;
      try { this.client.write(out); } catch (e) { /* close fires next */ }
    }
  }
}

module.exports = IqTcpServer;
