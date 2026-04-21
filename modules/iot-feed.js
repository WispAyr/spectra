/**
 * iot-feed.js — IoT/ISM signal decoder feed via rtl_433
 * Spawns rtl_433 with SoapySDR pointing at rsp_tcp endpoint
 * Falls back to demo mode simulating ISM devices
 */

const { spawn } = require('child_process');

class IotFeed {
  constructor(config, callbacks) {
    this.config = config;
    this.onDevice = callbacks.onDevice;
    this.proc = null;
    this.running = false;
    this.demoMode = false;
    this.demoInterval = null;
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
    if (this.demoInterval) clearInterval(this.demoInterval);
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
        if (this.running) {
          console.log(`[IoT] rtl_433 exited (${code}) — retrying...`);
          setTimeout(() => this._spawnRtl433(), 10000);
        }
      });

      this.proc.on('error', () => {
        if (!this.demoMode) {
          console.log('[IoT] rtl_433 not found — starting demo mode');
          this._startDemoMode();
        }
      });

    } catch (e) {
      console.log('[IoT] rtl_433 unavailable — demo mode');
      this._startDemoMode();
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

  _startDemoMode() {
    this.demoMode = true;

    const demoDevices = [
      { model: 'Schrader-SMD3MA2-TPMS', id: 0xDE1A, type: 'tpms', pressure_kPa: 240, temperature_C: 22 },
      { model: 'Schrader-SMD3MA2-TPMS', id: 0xDE1B, type: 'tpms', pressure_kPa: 238, temperature_C: 23 },
      { model: 'Schrader-SMD3MA2-TPMS', id: 0xDE1C, type: 'tpms', pressure_kPa: 241, temperature_C: 21 },
      { model: 'Schrader-SMD3MA2-TPMS', id: 0xDE1D, type: 'tpms', pressure_kPa: 239, temperature_C: 22 },
      { model: 'Oregon-THGR122N', id: 1, channel: 1, type: 'weather', temperature_C: 18.5, humidity: 62, battery_ok: 1 },
      { model: 'LaCrosse-TX141W', id: 2, channel: 0, type: 'weather', temperature_C: 12.1, humidity: 75, battery_ok: 1 },
      { model: 'Generic-Security', id: 0xAB12, type: 'security', code: '101010110100' }
    ];

    let tick = 0;
    demoDevices.forEach(d => {
      const dev = {
        ...d,
        rssi: -70 + Math.random() * 20,
        snr: 10 + Math.random() * 15,
        timestamp: new Date().toISOString()
      };
      this.onDevice(dev);
    });

    this.demoInterval = setInterval(() => {
      tick++;
      const dev = demoDevices[tick % demoDevices.length];

      // Vary sensor readings
      if (dev.type === 'tpms') {
        dev.pressure_kPa += (Math.random() - 0.5) * 2;
        dev.temperature_C += (Math.random() - 0.5) * 0.5;
      }
      if (dev.type === 'weather') {
        dev.temperature_C += (Math.random() - 0.5) * 0.3;
        dev.humidity = Math.max(20, Math.min(100, dev.humidity + (Math.random() - 0.5) * 2));
      }

      this.onDevice({
        ...dev,
        rssi: -70 + Math.random() * 20,
        snr: 10 + Math.random() * 15,
        timestamp: new Date().toISOString()
      });
    }, 5000);
  }
}

module.exports = IotFeed;
