/**
 * adsb-feed.js — ADS-B decoder feed
 * Polls readsb's aircraft.json (standard FA/readsb format) from disk.
 * readsb is fed by SPECTRA's iq-tcp-server, which wraps the SDRconnect
 * WebSocket as an rtl_tcp source.
 * No data is emitted unless readsb is producing fresh output.
 */

const fs = require('fs');

const SEEN_GRACE_SEC = 60;       // emit timeout if not seen for this long
const STALE_FILE_SEC = 30;       // ignore file if mtime older than this

class AdsbFeed {
  constructor(config, callbacks) {
    this.config = config;
    this.onAircraft = callbacks.onAircraft;
    this.onTimeout = callbacks.onTimeout;
    this.jsonPath = config.jsonPath || '/run/readsb/aircraft.json';
    this.pollMs = config.pollMs || 2000;
    this.running = false;
    this.connected = false;
    this.timer = null;
    this.tracked = new Map(); // hex -> { lastSeen: ms, lat, lon, ... }
  }

  start() {
    this.running = true;
    console.log(`[ADS-B] starting feed, polling ${this.jsonPath} every ${this.pollMs}ms`);
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    console.log('[ADS-B] feed stopped');
  }

  _loop() {
    this._poll();
    if (this.running) {
      this.timer = setTimeout(() => this._loop(), this.pollMs);
    }
  }

  _poll() {
    let stat;
    try {
      stat = fs.statSync(this.jsonPath);
    } catch (e) {
      if (this.connected) console.log(`[ADS-B] ${this.jsonPath} not present — decoder offline`);
      this.connected = false;
      return;
    }

    const ageSec = (Date.now() - stat.mtimeMs) / 1000;
    if (ageSec > STALE_FILE_SEC) {
      if (this.connected) console.log(`[ADS-B] ${this.jsonPath} stale (${ageSec.toFixed(1)}s old) — treating as offline`);
      this.connected = false;
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.jsonPath, 'utf8'));
    } catch (e) {
      // partial write — try next tick
      return;
    }

    if (!this.connected) {
      console.log('[ADS-B] connected — readsb output is live');
      this.connected = true;
    }

    const list = Array.isArray(parsed.aircraft) ? parsed.aircraft : [];
    const nowMs = Date.now();
    const seenHexes = new Set();

    for (const ac of list) {
      const hex = (ac.hex || '').toUpperCase();
      if (!hex) continue;
      seenHexes.add(hex);

      // readsb's "seen" is seconds since last message; skip very stale entries.
      if (typeof ac.seen === 'number' && ac.seen > 30) continue;

      const lat = typeof ac.lat === 'number' ? ac.lat : null;
      const lon = typeof ac.lon === 'number' ? ac.lon : null;
      const alt = typeof ac.alt_baro === 'number' ? ac.alt_baro
                : typeof ac.alt_geom === 'number' ? ac.alt_geom
                : null;

      const aircraft = {
        hex,
        callsign: (ac.flight || '').trim() || null,
        type: ac.t || ac.category || null,
        altitude: alt,
        speed: typeof ac.gs === 'number' ? ac.gs : null,
        track: typeof ac.track === 'number' ? ac.track : null,
        lat,
        lon,
        vertRate: typeof ac.baro_rate === 'number' ? ac.baro_rate
                : typeof ac.geom_rate === 'number' ? ac.geom_rate
                : null,
        squawk: ac.squawk || null,
        rssi: typeof ac.rssi === 'number' ? ac.rssi : null,
        messages: typeof ac.messages === 'number' ? ac.messages : 0,
        lastSeen: nowMs - Math.floor((ac.seen || 0) * 1000)
      };

      this.tracked.set(hex, { lastSeen: nowMs });
      this.onAircraft(aircraft);
    }

    // Emit timeouts for tracked aircraft that haven't been seen in a while.
    for (const [hex, info] of this.tracked.entries()) {
      if (seenHexes.has(hex)) continue;
      if (nowMs - info.lastSeen > SEEN_GRACE_SEC * 1000) {
        this.tracked.delete(hex);
        try { this.onTimeout(hex); } catch (e) { /* ignore */ }
      }
    }
  }
}

module.exports = AdsbFeed;
