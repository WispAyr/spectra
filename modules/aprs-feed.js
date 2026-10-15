/**
 * aprs-feed.js — APRS decoder feed via direwolf AGWPE
 * Connects to direwolf's AGWPE TCP interface on port 8000.
 * No data is emitted unless the decoder is reachable.
 */

const net = require('net');

class AprsFeed {
  constructor(config, callbacks) {
    this.config = config;
    this.onStation = callbacks.onStation;
    this.onMessage = callbacks.onMessage;
    this.socket = null;
    this.running = false;
    this.connected = false;
    this.buffer = Buffer.alloc(0);
  }

  start() {
    this.running = true;
    console.log('[APRS] Starting feed...');
    this._connectAgwpe();
  }

  stop() {
    this.running = false;
    if (this.socket) this.socket.destroy();
    console.log('[APRS] Feed stopped');
  }

  _connectAgwpe() {
    this.socket = new net.Socket();
    this.socket.setTimeout(6000);

    this.socket.connect(this.config.agwpePort, '127.0.0.1', () => {
      console.log('[APRS] Connected to direwolf AGWPE');
      this.connected = true;
      this._sendAgwpeRegistration();
    });

    this.socket.on('data', (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this._parseAgwpe();
    });

    this.socket.on('error', (err) => {
      if (this.connected) {
        console.log(`[APRS] socket error: ${err.code || err.message}`);
      }
      this.connected = false;
      this.socket.destroy();
      if (this.running) setTimeout(() => this._connectAgwpe(), 20000);
    });

    this.socket.on('timeout', () => {
      this.connected = false;
      this.socket.destroy();
    });
  }

  _sendAgwpeRegistration() {
    // AGWPE registration packet
    const buf = Buffer.alloc(36);
    buf.writeInt32LE(0, 0);  // port
    buf[4] = 0x52; // 'R' - register
    buf.write('SPECTRA', 8, 'ascii');
    if (this.socket) this.socket.write(buf);
  }

  _parseAgwpe() {
    // AGWPE frame: 36-byte header + data
    while (this.buffer.length >= 36) {
      const dataLen = this.buffer.readInt32LE(28);
      if (this.buffer.length < 36 + dataLen) break;

      const kind = String.fromCharCode(this.buffer[4]);
      const data = this.buffer.slice(36, 36 + dataLen);

      if (kind === 'U' || kind === 'S') {
        // Unproto (UI) frame - APRS packet
        this._parseAprsPacket(data.toString('ascii'));
      }

      this.buffer = this.buffer.slice(36 + dataLen);
    }
  }

  _parseAprsPacket(raw) {
    try {
      // Simple APRS position parser
      const colonIdx = raw.indexOf(':');
      if (colonIdx === -1) return;

      const header = raw.substring(0, colonIdx);
      const info = raw.substring(colonIdx + 1);
      const callsign = header.split('>')[0];

      let lat = null, lon = null, comment = '';

      // Standard compressed position: !DDMM.hhN/DDDMM.hhW
      const posMatch = info.match(/[!\/=@](\d{2})(\d{2}\.\d{2})([NS]).(.{0,1})(\d{3})(\d{2}\.\d{2})([EW])([\s\S]*)/);
      if (posMatch) {
        lat = parseInt(posMatch[1]) + parseFloat(posMatch[2]) / 60;
        if (posMatch[3] === 'S') lat = -lat;
        lon = parseInt(posMatch[5]) + parseFloat(posMatch[6]) / 60;
        if (posMatch[7] === 'W') lon = -lon;
        comment = posMatch[8] ? posMatch[8].trim() : '';
      }

      if (lat && lon) {
        this.onStation({
          callsign,
          lat,
          lon,
          comment,
          raw: info,
          lastSeen: Date.now()
        });
      } else {
        // Message or status packet
        this.onMessage({ callsign, info, raw, timestamp: Date.now() });
      }
    } catch (e) {
      // Malformed packet — ignore
    }
  }

}

module.exports = AprsFeed;
