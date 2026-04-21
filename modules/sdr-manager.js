/**
 * sdr-manager.js — nRSP-ST connection manager
 * Manages rsp_tcp connection, health checking, tuning, and mock FFT generation
 */

const net = require('net');
const { EventEmitter } = require('events');

class SdrManager extends EventEmitter {
  constructor(config, onStatus) {
    super();
    this.config = { ...config };
    this.onStatus = onStatus;
    this.connected = false;
    this.socket = null;
    this.reconnectTimer = null;
    this.fftBuffer = this._generateMockFft(config.frequency, 1024);
    this.lastFftTime = 0;
    this.fftUpdateInterval = null;
  }

  connect() {
    this._tryConnect();
    // Simulate FFT updates even if not connected (demo mode)
    this.fftUpdateInterval = setInterval(() => {
      this.fftBuffer = this._generateMockFft(this.config.frequency, 1024);
    }, 200);
  }

  _tryConnect() {
    console.log(`[SDR] Connecting to nRSP-ST at ${this.config.host}:${this.config.rspTcpPort}`);
    this.socket = new net.Socket();

    this.socket.setTimeout(5000);

    this.socket.connect(this.config.rspTcpPort, this.config.host, () => {
      console.log('[SDR] Connected to nRSP-ST rsp_tcp server');
      this.connected = true;
      this.onStatus({ connected: true, host: this.config.host });
      this.emit('connected');
      this._sendTuneCommand();
    });

    this.socket.on('data', (data) => {
      this._parseIqData(data);
    });

    this.socket.on('error', (err) => {
      console.warn(`[SDR] Connection error: ${err.message} — running in demo mode`);
      this.connected = false;
      this.onStatus({ connected: false, error: err.message, demoMode: true });
      this.socket.destroy();
      this._scheduleReconnect();
    });

    this.socket.on('timeout', () => {
      console.warn('[SDR] Connection timed out');
      this.connected = false;
      this.onStatus({ connected: false, error: 'timeout', demoMode: true });
      this.socket.destroy();
      this._scheduleReconnect();
    });

    this.socket.on('close', () => {
      if (this.connected) {
        this.connected = false;
        this.onStatus({ connected: false, error: 'closed', demoMode: true });
        this._scheduleReconnect();
      }
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._tryConnect();
    }, 10000);
  }

  _sendTuneCommand() {
    if (!this.socket || !this.connected) return;
    // RTL-TCP protocol: set frequency (cmd 0x01), sample rate (cmd 0x02), gain mode (cmd 0x03)
    const freq = this.config.frequency;
    const buf = Buffer.alloc(5);
    buf[0] = 0x01;
    buf.writeUInt32BE(freq, 1);
    this.socket.write(buf);
  }

  _parseIqData(data) {
    // Real implementation would demodulate IQ samples
    // For now, keep mock FFT and emit raw length
    this.emit('iq_chunk', { bytes: data.length });
  }

  tune(frequency, bandwidth) {
    this.config.frequency = frequency;
    if (bandwidth) this.config.bandwidth = bandwidth;
    console.log(`[SDR] Tuning to ${(frequency / 1e6).toFixed(3)} MHz`);
    if (this.connected && this.socket) {
      this._sendTuneCommand();
    }
    this.fftBuffer = this._generateMockFft(frequency, 1024);
  }

  setAntenna(port) {
    this.config.antennaPort = port;
    console.log(`[SDR] Antenna port: ${port}`);
    // Would send SDRplay API command in real implementation
  }

  setGain(gainReduction) {
    this.config.gainReduction = gainReduction;
    console.log(`[SDR] Gain reduction: ${gainReduction} dB`);
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    if (this.socket) {
      this.socket.destroy();
    }
    setTimeout(() => this._tryConnect(), 500);
  }

  getLastFft() {
    return {
      frequency: this.config.frequency,
      bandwidth: this.config.bandwidth,
      bins: this.fftBuffer,
      timestamp: Date.now(),
      connected: this.connected
    };
  }

  disconnect() {
    if (this.fftUpdateInterval) clearInterval(this.fftUpdateInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) this.socket.destroy();
    this.connected = false;
  }

  // ─── Mock FFT Generator (demo mode / no live signal) ─────────────────────
  _generateMockFft(centerFreq, bins) {
    const data = [];
    const freqMHz = centerFreq / 1e6;

    // Known signal peaks for realistic simulation
    const knownSignals = this._getKnownSignals(freqMHz);

    for (let i = 0; i < bins; i++) {
      const freqOffset = (i / bins - 0.5); // -0.5 to +0.5
      let power = -85 + (Math.random() * 4 - 2); // Noise floor ~-85 dBm

      // Add known signal peaks
      for (const sig of knownSignals) {
        const dist = Math.abs(freqOffset - sig.offset);
        if (dist < sig.width) {
          const peak = sig.power * Math.exp(-(dist * dist) / (0.0002));
          power = Math.max(power, -85 + peak);
        }
      }

      // Occasional random burst
      if (Math.random() < 0.003) {
        power = -60 + Math.random() * 20;
      }

      data.push(Math.round(power * 10) / 10);
    }
    return data;
  }

  _getKnownSignals(freqMHz) {
    // Simulate real-world signals near common frequencies
    const signals = [];

    if (freqMHz >= 87 && freqMHz <= 108) {
      // FM broadcast band
      signals.push({ offset: -0.3, power: 40, width: 0.015 });
      signals.push({ offset: 0.1, power: 35, width: 0.015 });
      signals.push({ offset: 0.35, power: 42, width: 0.015 });
    }
    if (Math.abs(freqMHz - 118) < 20) {
      // Airband AM
      signals.push({ offset: -0.1, power: 30, width: 0.005 });
      signals.push({ offset: 0.2, power: 25, width: 0.005 });
    }
    if (Math.abs(freqMHz - 144.8) < 2) {
      // APRS 144.800
      signals.push({ offset: 0.0, power: 45, width: 0.002 });
    }
    if (Math.abs(freqMHz - 433.92) < 5) {
      // ISM 433
      signals.push({ offset: 0.0, power: 38, width: 0.01 });
      signals.push({ offset: -0.2, power: 28, width: 0.008 });
    }
    if (Math.abs(freqMHz - 1090) < 5) {
      // ADS-B 1090
      signals.push({ offset: 0.0, power: 50, width: 0.003 });
    }

    return signals;
  }
}

module.exports = SdrManager;
