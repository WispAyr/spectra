/* waterfall.js — Canvas FFT waterfall + spectrum line renderer */

const Waterfall = (() => {
  let wfCanvas, wfCtx, spCanvas, spCtx;
  let frequency = 100e6;
  let bandwidth = 1536000;
  let speed = 250;
  let pollTimer = null;
  let initialized = false;
  const HISTORY_ROWS = 200;
  const wfHistory = [];

  // Color map: noise(blue) → signal(green) → peak(red)
  function dbToColor(db) {
    const norm = Math.max(0, Math.min(1, (db + 100) / 50));
    if (norm < 0.33) {
      const t = norm / 0.33;
      return `rgb(${Math.round(10+t*20)},${Math.round(20+t*60)},${Math.round(80+t*120)})`;
    } else if (norm < 0.66) {
      const t = (norm - 0.33) / 0.33;
      return `rgb(${Math.round(30+t*200)},${Math.round(80+t*160)},${Math.round(200-t*150)})`;
    } else {
      const t = (norm - 0.66) / 0.34;
      return `rgb(${Math.round(230+t*25)},${Math.round(240-t*200)},${Math.round(50-t*40)})`;
    }
  }

  function init() {
    wfCanvas = document.getElementById('wf-canvas');
    spCanvas = document.getElementById('spectrum-canvas');
    if (!wfCanvas || !spCanvas) return;
    wfCtx = wfCanvas.getContext('2d');
    spCtx = spCanvas.getContext('2d');
    // Defer sizing so the page is visible and has layout
    setTimeout(() => {
      resizeCanvases();
      if (!initialized) {
        window.addEventListener('resize', resizeCanvases);
        attachCursorTracking();
        startPolling();
        initialized = true;
      }
      updateFreqAxis();
    }, 50);
  }

  function resizeCanvases() {
    if (!wfCanvas) return;
    const sidebarW = 220;
    const W = Math.max(400, window.innerWidth - sidebarW - 120);
    wfCanvas.width = W;
    wfCanvas.height = 280;
    if (spCanvas) {
      spCanvas.width = W;
      spCanvas.height = 120;
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      fetch('/api/spectrum/fft')
        .then(r => r.json())
        .then(data => pushFft(data))
        .catch(() => {
          // Generate local demo FFT
          pushFft({
            frequency: frequency,
            bandwidth: bandwidth,
            bins: generateDemoFft(frequency, 1024),
            timestamp: Date.now(),
            connected: false
          });
        });
    }, speed);
  }

  function pushFft(data) {
    if (!wfCtx || !data.bins) return;
    const bins = data.bins;
    frequency = data.frequency || frequency;
    bandwidth = data.bandwidth || bandwidth;

    wfHistory.unshift(bins);
    if (wfHistory.length > HISTORY_ROWS) wfHistory.pop();

    drawWaterfall();
    drawSpectrum(bins);
  }

  function drawWaterfall() {
    if (!wfCtx || wfHistory.length === 0) return;
    const W = wfCanvas.width, H = wfCanvas.height;
    const rowH = H / HISTORY_ROWS;

    wfHistory.forEach((row, ri) => {
      const y = ri * rowH;
      const binW = W / row.length;
      row.forEach((db, bi) => {
        wfCtx.fillStyle = dbToColor(db);
        wfCtx.fillRect(bi * binW, y, binW + 0.5, rowH + 0.5);
      });
    });
  }

  function drawSpectrum(bins) {
    if (!spCtx) return;
    const W = spCanvas.width, H = spCanvas.height;
    spCtx.clearRect(0, 0, W, H);

    // Grid
    spCtx.strokeStyle = 'rgba(255,255,255,0.05)';
    spCtx.lineWidth = 1;
    [-60, -70, -80, -90].forEach(db => {
      const y = dbToY(db, H);
      spCtx.beginPath();
      spCtx.moveTo(0, y);
      spCtx.lineTo(W, y);
      spCtx.stroke();
    });

    // Gradient fill
    const grad = spCtx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(0,212,255,0.4)');
    grad.addColorStop(1, 'rgba(0,212,255,0.02)');

    spCtx.beginPath();
    bins.forEach((db, i) => {
      const x = (i / bins.length) * W;
      const y = dbToY(db, H);
      if (i === 0) spCtx.moveTo(x, y);
      else spCtx.lineTo(x, y);
    });
    spCtx.lineTo(W, H);
    spCtx.lineTo(0, H);
    spCtx.closePath();
    spCtx.fillStyle = grad;
    spCtx.fill();

    // Line
    spCtx.beginPath();
    spCtx.strokeStyle = '#00d4ff';
    spCtx.lineWidth = 1.5;
    bins.forEach((db, i) => {
      const x = (i / bins.length) * W;
      const y = dbToY(db, H);
      if (i === 0) spCtx.moveTo(x, y);
      else spCtx.lineTo(x, y);
    });
    spCtx.stroke();
  }

  function dbToY(db, H) {
    return Math.max(0, Math.min(H, ((db + 100) / -60) * H + H));
  }

  function attachCursorTracking() {
    wfCanvas.addEventListener('mousemove', (e) => {
      const rect = wfCanvas.getBoundingClientRect();
      const xFrac = (e.clientX - rect.left) / rect.width;
      const freqOffset = (xFrac - 0.5) * bandwidth;
      const freq = (frequency + freqOffset) / 1e6;
      const fEl = document.getElementById('wf-cursor-freq');
      if (fEl) fEl.textContent = `${freq.toFixed(4)} MHz`;
    });
  }

  function setFrequency(f, bw) {
    frequency = f;
    if (bw) bandwidth = bw;
    const el = document.getElementById('wf-center-val');
    if (el) el.textContent = `${(f / 1e6).toFixed(3)} MHz`;
    const inp = document.getElementById('wf-freq-input');
    if (inp) inp.value = (f / 1e6).toFixed(3);
    updateFreqAxis();
    wfHistory.length = 0;
  }

  function updateFreqAxis() {
    const axis = document.getElementById('wf-freq-axis');
    if (!axis) return;
    const labels = [];
    for (let i = 0; i <= 4; i++) {
      const f = (frequency - bandwidth / 2 + (bandwidth / 4) * i) / 1e6;
      labels.push(`<span>${f.toFixed(2)}</span>`);
    }
    axis.innerHTML = labels.join('');
    const centerEl = document.getElementById('dash-freq-label');
    if (centerEl) centerEl.textContent = `${(frequency / 1e6).toFixed(3)} MHz`;
    const fdEl = document.getElementById('freq-display');
    if (fdEl) fdEl.textContent = `${(frequency / 1e6).toFixed(3)} MHz`;
  }

  function generateDemoFft(centerFreq, bins) {
    const data = [];
    const freqMHz = centerFreq / 1e6;
    for (let i = 0; i < bins; i++) {
      const offset = (i / bins) - 0.5;
      let p = -88 + (Math.random() * 4 - 2);
      // FM band signals
      if (Math.abs(freqMHz - 100) < 5) {
        [-0.3, 0.1, 0.35, -0.15].forEach(peak => {
          const d = Math.abs(offset - peak);
          if (d < 0.02) p = Math.max(p, -55 + Math.random() * 8);
        });
      }
      // ADS-B spike
      if (Math.abs(freqMHz - 1090) < 3 && Math.abs(offset) < 0.01) {
        p = Math.max(p, -45 + Math.random() * 10);
      }
      // APRS spike
      if (Math.abs(freqMHz - 144.8) < 2 && Math.abs(offset) < 0.005) {
        if (Math.random() < 0.1) p = Math.max(p, -50 + Math.random() * 15);
      }
      // ISM 433
      if (Math.abs(freqMHz - 433.92) < 5 && Math.abs(offset) < 0.015) {
        if (Math.random() < 0.05) p = Math.max(p, -55 + Math.random() * 20);
      }
      data.push(Math.round(p * 10) / 10);
    }
    return data;
  }

  // Mini waterfall on dashboard
  function initDash() {
    const canvas = document.getElementById('dash-waterfall');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth || 600;
    canvas.height = 120;
    const hist = [];

    setInterval(() => {
      const bins = generateDemoFft(frequency, 256);
      hist.unshift(bins);
      if (hist.length > 60) hist.pop();
      const W = canvas.width, rowH = canvas.height / 60;
      hist.forEach((row, ri) => {
        const bw = W / row.length;
        row.forEach((db, bi) => {
          ctx.fillStyle = dbToColor(db);
          ctx.fillRect(bi * bw, ri * rowH, bw + 0.5, rowH + 0.5);
        });
      });
    }, 300);
  }

  document.addEventListener('DOMContentLoaded', initDash);
  document.addEventListener('DOMContentLoaded', () => setTimeout(() => Waterfall.init(), 500));

  return { init, pushFft, setFrequency, startPolling };
})();
