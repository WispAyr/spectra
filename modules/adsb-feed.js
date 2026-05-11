/**
 * adsb-feed.js — ADS-B decoder feed
 * Connects to dump1090-fa Beast TCP socket on port 30005.
 * No data is emitted unless the decoder is reachable.
 */

const net = require('net');

class AdsbFeed {
  constructor(config, callbacks) {
    this.config = config;
    this.onAircraft = callbacks.onAircraft;
    this.onTimeout = callbacks.onTimeout;
    this.socket = null;
    this.running = false;
    this.connected = false;
  }

  start() {
    this.running = true;
    console.log('[ADS-B] Starting feed...');
    this._connectBeast();
  }

  stop() {
    this.running = false;
    if (this.socket) this.socket.destroy();
    console.log('[ADS-B] Feed stopped');
  }

  _connectBeast() {
    this.socket = new net.Socket();
    this.socket.setTimeout(8000);

    this.socket.connect(this.config.port, this.config.host, () => {
      console.log('[ADS-B] Connected to dump1090 Beast socket');
      this.connected = true;
    });

    this.socket.on('data', (data) => {
      this._parseBeast(data);
    });

    this.socket.on('error', (err) => {
      if (this.connected) {
        console.log(`[ADS-B] socket error: ${err.code || err.message}`);
      }
      this.connected = false;
      this.socket.destroy();
      if (this.running) setTimeout(() => this._connectBeast(), 15000);
    });

    this.socket.on('timeout', () => {
      this.connected = false;
      this.socket.destroy();
    });
  }

  _parseBeast(data) {
    // Beast binary format parser (simplified)
    // Real implementation: parse 0x1A framing, extract MLAT, Mode-S, etc.
    // For now, emit raw event that backend accumulates
  }
}

module.exports = AdsbFeed;
