/**
 * spectrum-scanner.js — Scheduled frequency band sweeper
 *
 * Drives soapy_power against a SoapySDR-attached USB SDR (typically a
 * spare RTL-SDR dongle, distinct from the primary nRSP-ST so band sweeps
 * do not yank the primary tune). If soapy_power is not installed, the
 * scanner stays disabled rather than fabricating data.
 */

const { spawn, execFileSync } = require("child_process");

class SpectrumScanner {
  constructor(config, sdrManager, callbacks) {
    this.config = config;
    this.sdrManager = sdrManager;
    this.onSweep = callbacks.onSweep;
    this.onAnomaly = callbacks.onAnomaly;
    this.running = false;
    this.timer = null;
    this.currentBandIdx = 0;
    this.baseline = {};
    this.realDataAvailable = this._probeSoapyPower();
  }

  _probeSoapyPower() {
    try {
      execFileSync("which", ["soapy_power"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  start() {
    if (!this.realDataAvailable) {
      console.warn("[Scanner] soapy_power not found — scanner disabled (no fabricated data)");
      return;
    }
    this.running = true;
    console.log("[Scanner] Starting spectrum scanner");
    this._scheduleSweep();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    console.log("[Scanner] Scanner stopped");
  }

  triggerImmediate(bandName) {
    if (!this.realDataAvailable) return null;
    const band = bandName
      ? this.config.sweepBands.find(b => b.name === bandName)
      : this.config.sweepBands[this.currentBandIdx];
    if (band) this._sweep(band);
    return band || null;
  }

  status() {
    return {
      running: this.running,
      realDataAvailable: this.realDataAvailable,
      backend: this.realDataAvailable ? "soapy_power" : null,
      currentBandIdx: this.currentBandIdx
    };
  }

  _scheduleSweep() {
    if (!this.running) return;
    const band = this.config.sweepBands[this.currentBandIdx];
    this.currentBandIdx = (this.currentBandIdx + 1) % this.config.sweepBands.length;

    this._sweep(band);

    const delay = (this.config.intervalMinutes * 60 * 1000) / this.config.sweepBands.length;
    this.timer = setTimeout(() => this._scheduleSweep(), delay);
  }

  _sweep(band) {
    if (!band) return;
    console.log(`[Scanner] Sweeping ${band.name} (${(band.start / 1e6).toFixed(1)}-${(band.end / 1e6).toFixed(1)} MHz)`);

    const args = [
      "-f", `${band.start}:${band.end}:${band.step}`,
      "-g", "40",
      "-d", "driver=soapy,driver=rtlsdr",
      "-1"
    ];

    let proc;
    try {
      proc = spawn("soapy_power", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      console.warn(`[Scanner] soapy_power spawn failed: ${e.message}`);
      return;
    }

    const lines = [];

    proc.stdout.on("data", data => {
      data.toString().split("\n").forEach(l => {
        if (l.trim()) lines.push(l.trim());
      });
    });

    proc.on("close", () => {
      if (lines.length === 0) {
        console.warn(`[Scanner] ${band.name}: no soapy_power output — skipping (no mock fallback)`);
        return;
      }
      const result = this._parseSoapyPowerOutput(lines, band);
      if (result) {
        this.onSweep(result);
        this._detectAnomalies(result, band);
      }
    });

    proc.on("error", (err) => {
      console.warn(`[Scanner] soapy_power error for ${band.name}: ${err.message}`);
    });
  }

  _parseSoapyPowerOutput(lines, band) {
    const freqs = [];
    const powers = [];

    lines.forEach(line => {
      const parts = line.split(",");
      if (parts.length < 7) return;
      const low = parseFloat(parts[2]);
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
      source: "soapy_power"
    };
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

    this.baseline[band.name] = result.powers.map((p, i) =>
      ((bl[i] || -90) * 0.9 + p * 0.1)
    );
  }
}

module.exports = SpectrumScanner;
