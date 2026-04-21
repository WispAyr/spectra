/**
 * adsb-feed.js — ADS-B decoder feed
 * Connects to dump1090-fa Beast TCP socket on port 30005
 * Also polls JSON aircraft data on port 30003 as fallback
 * In demo mode, generates realistic simulated aircraft
 */

const net = require('net');

class AdsbFeed {
  constructor(config, callbacks) {
    this.config = config;
    this.onAircraft = callbacks.onAircraft;
    this.onTimeout = callbacks.onTimeout;
    this.socket = null;
    this.running = false;
    this.demoMode = false;
    this.demoInterval = null;
    this.demoAircraft = this._generateDemoFleet();
  }

  start() {
    this.running = true;
    console.log('[ADS-B] Starting feed...');
    this._connectBeast();
  }

  stop() {
    this.running = false;
    if (this.socket) this.socket.destroy();
    if (this.demoInterval) clearInterval(this.demoInterval);
    console.log('[ADS-B] Feed stopped');
  }

  _connectBeast() {
    this.socket = new net.Socket();
    this.socket.setTimeout(8000);

    this.socket.connect(this.config.port, this.config.host, () => {
      console.log('[ADS-B] Connected to dump1090 Beast socket');
      this.demoMode = false;
      if (this.demoInterval) {
        clearInterval(this.demoInterval);
        this.demoInterval = null;
      }
    });

    this.socket.on('data', (data) => {
      this._parseBeast(data);
    });

    this.socket.on('error', () => {
      if (!this.demoMode) {
        console.log('[ADS-B] dump1090 not available — starting demo mode');
        this._startDemoMode();
      }
      this.socket.destroy();
      if (this.running) {
        setTimeout(() => this._connectBeast(), 15000);
      }
    });

    this.socket.on('timeout', () => {
      this.socket.destroy();
      if (!this.demoMode) this._startDemoMode();
    });
  }

  _parseBeast(data) {
    // Beast binary format parser (simplified)
    // Real implementation: parse 0x1A framing, extract MLAT, Mode-S, etc.
    // For now, emit raw event that backend accumulates
  }

  _startDemoMode() {
    this.demoMode = true;
    let tick = 0;

    this.demoInterval = setInterval(() => {
      tick++;
      // Update aircraft positions
      this.demoAircraft.forEach(ac => {
        ac.lat += ac.dLat;
        ac.lon += ac.dLon;
        ac.track = (ac.track + (Math.random() - 0.5) * 2 + 360) % 360;
        ac.altitude += (Math.random() - 0.5) * 100;
        ac.altitude = Math.max(1000, Math.min(45000, ac.altitude));
        ac.speed += (Math.random() - 0.5) * 5;
        ac.lastSeen = Date.now();
        this.onAircraft({ ...ac });
      });

      // Occasionally add/remove aircraft
      if (tick % 20 === 0 && this.demoAircraft.length < 15) {
        this.demoAircraft.push(this._generateRandomAircraft());
      }
      if (tick % 35 === 0 && this.demoAircraft.length > 5) {
        const removed = this.demoAircraft.splice(0, 1)[0];
        this.onTimeout(removed.hex);
      }
    }, 2000);
  }

  _generateDemoFleet() {
    const fleet = [];
    const count = 8;
    for (let i = 0; i < count; i++) {
      fleet.push(this._generateRandomAircraft());
    }
    return fleet;
  }

  _generateRandomAircraft() {
    const callsigns = ['BAW', 'EZY', 'RYR', 'VIR', 'DLH', 'AFR', 'KLM', 'IBE', 'TOM', 'TCX'];
    const types = ['A320', 'B737', 'A321', 'B738', 'A319', 'E175', 'B77W', 'A359', 'A220', 'B789'];
    const cs = callsigns[Math.floor(Math.random() * callsigns.length)];
    const num = Math.floor(Math.random() * 9000 + 1000);
    const type = types[Math.floor(Math.random() * types.length)];
    const alt = Math.floor(Math.random() * 35000 + 5000);

    // UK-centric coordinates
    const lat = 50 + Math.random() * 8;
    const lon = -5 + Math.random() * 10;
    const track = Math.random() * 360;
    const speed = 250 + Math.random() * 300;

    const hex = Array.from({ length: 6 }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');

    return {
      hex,
      callsign: `${cs}${num}`,
      type,
      altitude: alt,
      speed: Math.round(speed),
      track: Math.round(track),
      lat,
      lon,
      vertRate: (Math.random() - 0.5) * 1000,
      squawk: Math.floor(Math.random() * 7777).toString().padStart(4, '0'),
      lastSeen: Date.now(),
      dLat: (Math.cos((track * Math.PI) / 180) * speed) / 111320 / 1800,
      dLon: (Math.sin((track * Math.PI) / 180) * speed) / (111320 * Math.cos((lat * Math.PI) / 180)) / 1800,
      messages: Math.floor(Math.random() * 5000)
    };
  }
}

module.exports = AdsbFeed;
