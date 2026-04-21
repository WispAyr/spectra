/**
 * spectrum-scanner.js — Scheduled frequency band sweeper
 * Uses soapy_power via subprocess for wideband FFT sweeps
 * Falls back to mock FFT from sdr-manager in demo mode
 */

const { spawn } = require('child_process');

class SpectrumScanner {
  constructor(config, sdrManager, callbacks) {
    this.config = config;
    this.sdrManager = sdrManager;
    this.onSweep = callbacks.onSweep;
    this.onAnomaly = callbacks.onAnomaly;
    this.running = false;
    this.timer = null;
    this.currentBandIdx = 0;
    this.baseline = {}; // band name -> baseline power levels
  }

  start() {
    this.running = true;
    console.log('[Scanner] Starting spectrum scanner');
    this._scheduleSweep();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    console.log('[Scanner] Scanner stopped');
  }

  triggerImmediate(bandName) {
    const band = bandName
      ? this.config.sweepBands.find(b => b.name === bandName)
      : this.config.sweepBands[this.currentBandIdx];
    if (band) this._sweep(band);
  }

  _scheduleSweep() {
    if (!this.running) return;
    const band = this.config.sweepBands[this.currentBandIdx];
    this.currentBandIdx = (this.currentBandIdx + 1) % this.config.sweepBands.length;

    this._sweep(band);

    // Stagger sweeps so they don't all hit at once
    const delay = (this.config.intervalMinutes * 60 * 1000) / this.config.sweepBands.length;
    this.timer = setTimeout(() => this._scheduleSweep(), delay);
  }

  _sweep(band) {
    if (!band) return;
    console.log(`[Scanner] Sweeping ${band.name} (${(band.start / 1e6).toFixed(1)}-${(band.end / 1e6).toFixed(1)} MHz)`);

    // Try soapy_power first; fallback to mock
    const args = [
      '-f', `${band.start}:${band.end}:${band.step}`,
      '-g', '40',
      '-d', 'driver=soapy,driver=rtlsdr',
      '-1'  // Single sweep
    ];

    let proc;
    try {
      proc = spawn('soapy_power', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // soapy_power not available — use mock
      this._mockSweep(band);
      return;
    }

    const lines = [];

    proc.stdout.on('data', data => {
      data.toString().split('\n').forEach(l => {
        if (l.trim()) lines.push(l.trim());
      });
    });

    proc.on('close', (code) => {
      if (lines.length === 0) {
        this._mockSweep(band);
        return;
      }
      const result = this._parseSoapyPowerOutput(lines, band);
      if (result) {
        this.onSweep(result);
        this._detectAnomalies(result, band);
      }
    });

    proc.on('error', () => {
      this._mockSweep(band);
    });
  }

  _parseSoapyPowerOutput(lines, band) {
    // soapy_power CSV: date, time, Hz low, Hz high, Hz step, samples, dB...
    const freqs = [];
    const powers = [];

    lines.forEach(line => {
      const parts = line.split(',');
      if (parts.length < 7) return;
      const low = parseFloat(parts[2]);
      const high = parseFloat(parts[3]);
      const step = parseFloat(parts[4]);
      const dbValues = parts.slice(6).map(Number);
      let f = low;
      dbValues.forEach(db => {
        freqs.push(f);
        powers.push(db);
        f += step;
      });
    });

    if (freqs.length === 0) return null;

    return {
      band: band.name,
      start: band.start,
      end: band.end,
      step: band.step,
      freqs,
      powers,
      timestamp: Date.now(),
      source: 'soapy_power'
    };
  }

  _mockSweep(band) {
    const freqs = [];
    const powers = [];
    const steps = Math.floor((band.end - band.start) / band.step);

    for (let i = 0; i <= steps; i++) {
      const f = band.start + i * band.step;
      freqs.push(f);

      // Realistic noise floor with occasional signals
      let power = -90 + Math.random() * 5;
      if (Math.random() < 0.05) power += 15 + Math.random() * 25;

      // Known signals in each band
      power = this._addKnownBandSignals(power, f, band.name);
      powers.push(Math.round(power * 10) / 10);
    }

    const result = {
      band: band.name,
      start: band.start,
      end: band.end,
      step: band.step,
      freqs,
      powers,
      timestamp: Date.now(),
      source: 'demo'
    };

    this.onSweep(result);
    this._detectAnomalies(result, band);
  }

  _addKnownBandSignals(basePower, freq, bandName) {
    switch (bandName) {
      case 'Airband AM':
        // Airport control channels
        if ([118.1e6, 119.0e6, 121.5e6, 131.3e6].some(f => Math.abs(freq - f) < 12500)) {
          return basePower + 30 + Math.random() * 10;
        }
        break;
      case 'Marine VHF':
        if ([156.8e6, 162.025e6, 156.0e6].some(f => Math.abs(freq - f) < 12500)) {
          return basePower + 20 + Math.random() * 15;
        }
        break;
      case 'ISM 433':
        if (Math.abs(freq - 433.92e6) < 50000) {
          return basePower + 25 + Math.random() * 15;
        }
        break;
    }
    return basePower;
  }

  _detectAnomalies(result, band) {
    if (!this.baseline[band.name]) {
      this.baseline[band.name] = result.powers.map(p => p);
      return;
    }

    const threshold = this.config.anomalyThresholdDb;
    const bl = this.baseline[band.name];

    result.powers.forEach((power, i) => {
      const diff = power - (bl[i] || -90);
      if (diff > threshold) {
        const freq = result.freqs[i];
        this.onAnomaly({
          band: band.name,
          frequency: freq,
          frequencyMHz: (freq / 1e6).toFixed(3),
          power,
          baseline: bl[i],
          delta: diff,
          timestamp: Date.now()
        });
      }
    });

    // Update baseline with slow decay
    this.baseline[band.name] = result.powers.map((p, i) =>
      ((bl[i] || -90) * 0.9 + p * 0.1)
    );
  }
}

module.exports = SpectrumScanner;
