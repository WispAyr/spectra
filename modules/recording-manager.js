/**
 * recording-manager.js — IQ and audio recording management
 * Controls start/stop of IQ recordings via rsp_tcp or sox
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

class RecordingManager {
  constructor(config, sdrManager, callbacks) {
    this.config = config;
    this.sdrManager = sdrManager;
    this.onStart = callbacks.onStart;
    this.onStop = callbacks.onStop;
    this.activeRecordings = new Map();
    this.recordings = [];

    // Ensure output dir exists
    if (!fs.existsSync(config.outputDir)) {
      fs.mkdirSync(config.outputDir, { recursive: true });
    }

    this._loadExistingRecordings();
  }

  _loadExistingRecordings() {
    try {
      const files = fs.readdirSync(this.config.outputDir);
      files.forEach(f => {
        const fullPath = path.join(this.config.outputDir, f);
        const stat = fs.statSync(fullPath);
        const ext = path.extname(f);
        if (['.iq', '.wav', '.raw'].includes(ext)) {
          this.recordings.push({
            id: path.basename(f, ext),
            filename: f,
            path: fullPath,
            size: stat.size,
            created: stat.mtime.getTime(),
            active: false,
            label: path.basename(f, ext)
          });
        }
      });
    } catch (e) {
      // Directory may be empty or inaccessible
    }
  }

  list() {
    const diskRecordings = this.recordings.map(r => ({
      ...r,
      active: this.activeRecordings.has(r.id),
      sizeMb: (r.size / 1024 / 1024).toFixed(2)
    }));
    return diskRecordings.sort((a, b) => b.created - a.created);
  }

  start({ frequency, bandwidth, duration, label }) {
    const id = uuidv4().slice(0, 8);
    const freq = frequency || this.sdrManager.config.frequency;
    const bw = bandwidth || this.sdrManager.config.bandwidth;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${ts}_${(freq / 1e6).toFixed(3)}MHz_${id}.iq`;
    const outputPath = path.join(this.config.outputDir, filename);

    console.log(`[Recorder] Starting recording: ${filename}`);

    const rec = {
      id,
      filename,
      path: outputPath,
      frequency: freq,
      bandwidth: bw,
      label: label || `${(freq / 1e6).toFixed(3)} MHz`,
      started: Date.now(),
      duration: duration || null,
      active: true,
      size: 0
    };

    // In real implementation: pipe rsp_tcp IQ stream to file
    // Here we simulate with a timer that tracks elapsed time
    const sizeTimer = setInterval(() => {
      if (!this.activeRecordings.has(id)) {
        clearInterval(sizeTimer);
        return;
      }
      rec.size += bw * 2 * 2; // 2 bytes per I/Q sample
      rec.elapsed = Math.floor((Date.now() - rec.started) / 1000);

      // Auto-stop if duration exceeded
      if (duration && rec.elapsed >= duration) {
        this.stop(id);
      }
    }, 1000);

    this.activeRecordings.set(id, { rec, proc: null, sizeTimer });
    this.recordings.unshift(rec);
    this.onStart(rec);
    return rec;
  }

  stop(id) {
    const entry = this.activeRecordings.get(id);
    if (!entry) return null;

    const { rec, proc, sizeTimer } = entry;
    if (proc) proc.kill();
    if (sizeTimer) clearInterval(sizeTimer);

    rec.active = false;
    rec.stopped = Date.now();
    rec.duration = Math.floor((rec.stopped - rec.started) / 1000);

    this.activeRecordings.delete(id);
    this.onStop(rec);
    console.log(`[Recorder] Stopped recording: ${rec.filename} (${rec.duration}s)`);
    return rec;
  }

  stopAll() {
    for (const id of this.activeRecordings.keys()) {
      this.stop(id);
    }
  }

  delete(id) {
    // Stop if active
    if (this.activeRecordings.has(id)) this.stop(id);

    const idx = this.recordings.findIndex(r => r.id === id);
    if (idx === -1) return { success: false, error: 'Not found' };

    const rec = this.recordings[idx];
    try {
      if (fs.existsSync(rec.path)) fs.unlinkSync(rec.path);
    } catch (e) {
      // File may not exist (demo mode)
    }

    this.recordings.splice(idx, 1);
    return { success: true };
  }

  getStats() {
    const totalSize = this.recordings.reduce((acc, r) => acc + (r.size || 0), 0);
    return {
      count: this.recordings.length,
      activeCount: this.activeRecordings.size,
      totalSizeMb: (totalSize / 1024 / 1024).toFixed(2),
      maxSizeMb: this.config.maxSizeMb
    };
  }
}

module.exports = RecordingManager;
