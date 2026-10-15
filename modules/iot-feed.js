/**
 * iot-feed.js — IoT/ISM signal decoder feed via rtl_433
 * Spawns rtl_433 with SoapySDR pointing at rsp_tcp endpoint.
 * No data is emitted unless rtl_433 actually decodes packets.
 */

const { spawn } = require('child_process');

class IotFeed {
  constructor(config, callbacks) {
    this.config = config;
    this.onDevice = callbacks.onDevice;
    this.proc = null;
    this.running = false;
    this.connected = false;
  }

  start() {
    this.running = true;
    console.log('[IoT] Starting rtl_433 feed...');
    this._spawnRtl433();
  }

  stop() {
    this.running = false;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    console.log('[IoT] Feed stopped');
  }

  _spawnRtl433() {
    // rtl_433 with SoapySDR backend pointed at rsp_tcp
    const args = [
      '-d', 'driver=soapy,driver=rtlsdr', // SoapySDR
      '-f', this.config.frequency.toString(),
      '-F', 'json',                          // JSON output
      '-M', 'utc',
      '-R', '0'                              // Auto-detect all protocols
    ];

    // Add specific protocols if configured
    if (this.config.protocols && this.config.protocols.length > 0) {
      // Protocol IDs would go here for targeted decoding
    }

    try {
      this.proc = spawn('rtl_433', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.connected = true;

      this.proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
          if (line.trim()) this._parseLine(line.trim());
        });
      });

      this.proc.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('Registering')) {
          console.log('[IoT] rtl_433 protocol registered');
        }
      });

      this.proc.on('close', (code) => {
        this.connected = false;
        if (this.running) {
          console.log(`[IoT] rtl_433 exited (${code}) — retrying in 30s`);
          setTimeout(() => this._spawnRtl433(), 30000);
        }
      });

      this.proc.on('error', (err) => {
        this.connected = false;
        console.log(`[IoT] rtl_433 spawn error: ${err.code || err.message}`);
      });

    } catch (e) {
      this.connected = false;
      console.log(`[IoT] rtl_433 unavailable: ${e.message}`);
    }
  }

  _parseLine(line) {
    try {
      const data = JSON.parse(line);
      const device = {
        model: data.model || 'Unknown',
        id: data.id || data.device || 0,
        channel: data.channel,
        battery: data.battery_ok !== undefined ? data.battery_ok : data.battery,
        temperature_C: data.temperature_C || data.temp_C || null,
        humidity: data.humidity || null,
        pressure_hPa: data.pressure_hPa || null,
        wind_speed_km_h: data.wind_speed_km_h || null,
        wind_dir_deg: data.wind_dir_deg || null,
        rain_mm: data.rain_mm || null,
        code: data.code || null,
        type: this._classifyDevice(data),
        rssi: data.rssi || null,
        snr: data.snr || null,
        noise: data.noise || null,
        raw: data,
        timestamp: data.time || new Date().toISOString()
      };
      this.onDevice(device);
    } catch (e) {
      // Not valid JSON — ignore
    }
  }

  _classifyDevice(data) {
    const model = (data.model || '').toLowerCase();
    if (model.includes('tpms') || model.includes('tire') || model.includes('tyre')) return 'tpms';
    if (model.includes('weather') || data.temperature_C !== undefined) return 'weather';
    if (model.includes('door') || model.includes('pir') || model.includes('alarm')) return 'security';
    if (model.includes('power') || model.includes('energy') || model.includes('ct')) return 'energy';
    if (data.code !== undefined) return 'keyfob';
    return 'unknown';
  }

}

module.exports = IotFeed;
