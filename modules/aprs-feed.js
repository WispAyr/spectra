/**
 * aprs-feed.js — APRS decoder feed via direwolf AGWPE
 * Connects to direwolf's AGWPE TCP interface on port 8000
 * Falls back to demo mode with simulated APRS stations
 */

const net = require('net');

class AprsFeed {
  constructor(config, callbacks) {
    this.config = config;
    this.onStation = callbacks.onStation;
    this.onMessage = callbacks.onMessage;
    this.socket = null;
    this.running = false;
    this.demoMode = false;
    this.demoInterval = null;
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
    if (this.demoInterval) clearInterval(this.demoInterval);
    console.log('[APRS] Feed stopped');
  }

  _connectAgwpe() {
    this.socket = new net.Socket();
    this.socket.setTimeout(6000);

    this.socket.connect(this.config.agwpePort, '127.0.0.1', () => {
      console.log('[APRS] Connected to direwolf AGWPE');
      this.demoMode = false;
      this._sendAgwpeRegistration();
    });

    this.socket.on('data', (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this._parseAgwpe();
    });

    this.socket.on('error', () => {
      if (!this.demoMode) {
        console.log('[APRS] direwolf not available — starting demo mode');
        this._startDemoMode();
      }
      this.socket.destroy();
      if (this.running) setTimeout(() => this._connectAgwpe(), 20000);
    });

    this.socket.on('timeout', () => {
      this.socket.destroy();
      if (!this.demoMode) this._startDemoMode();
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

  _startDemoMode() {
    this.demoMode = true;
    const stations = this._generateDemoStations();
    let tick = 0;

    // Initial burst
    stations.forEach(s => this.onStation(s));

    this.demoInterval = setInterval(() => {
      tick++;
      // Beacon random station
      const s = stations[Math.floor(Math.random() * stations.length)];
      s.lat += (Math.random() - 0.5) * 0.001;
      s.lon += (Math.random() - 0.5) * 0.001;
      s.lastSeen = Date.now();
      this.onStation({ ...s });

      // Occasional message
      if (tick % 8 === 0) {
        const msgs = ['73s de the road!', 'QRV 144.800', 'Hello from van!', 'In transit North'];
        this.onMessage({
          callsign: s.callsign,
          info: msgs[Math.floor(Math.random() * msgs.length)],
          timestamp: Date.now()
        });
      }
    }, 8000);
  }

  _generateDemoStations() {
    const callsigns = ['M0ABC-9', 'G4XYZ-7', 'MW0DEF-1', 'G1HIJ-5', '2E0KLM-9', 'M7NOP-3'];
    return callsigns.map((cs, i) => ({
      callsign: cs,
      lat: 51.5 + (Math.random() - 0.5) * 4,
      lon: -1.5 + (Math.random() - 0.5) * 6,
      comment: ['Mobile', 'Home Station', 'Fill-in Digipeater', 'iGate', 'Mobile', 'Tracker'][i],
      lastSeen: Date.now() - Math.random() * 60000
    }));
  }
}

module.exports = AprsFeed;
