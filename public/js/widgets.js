/* widgets.js — Dashboard widgets: aircraft list, IoT cards, scanner, recorder */

const Widgets = (() => {

  // ── Aircraft list (dashboard) ─────────────────────────────────
  function updateAircraftList() {
    const el = document.getElementById('dash-aircraft-list');
    if (!el || !window.App) return;
    const aircraft = Object.values(App.state.aircraft);
    if (!aircraft.length) {
      el.innerHTML = '<div class="live-list__empty">Acquiring signals…</div>';
      return;
    }
    aircraft.sort((a, b) => (b.altitude || 0) - (a.altitude || 0));
    el.innerHTML = aircraft.slice(0, 8).map(ac => `
      <div class="live-list__item" onclick="goTo('adsb')">
        <span class="callsign">${ac.callsign || ac.hex}</span>
        <span class="detail">${ac.type || '—'}</span>
        <span class="alt">${ac.altitude ? ac.altitude.toFixed(0) + 'ft' : '—'}</span>
      </div>`).join('');
  }

  // ── IoT device cards ──────────────────────────────────────────
  function updateIotCard(device) {
    if (!window.App) return;
    const key = `${device.model}_${device.id}`;
    App.state.iotDevices[key] = device;

    updateDashIotList();
    updateIotGrid();
    document.getElementById('stat-iot-val').textContent = Object.keys(App.state.iotDevices).length;
    document.getElementById('badge-iot').textContent = Object.keys(App.state.iotDevices).length;
  }

  function updateDashIotList() {
    const el = document.getElementById('dash-iot-list');
    if (!el || !window.App) return;
    const devices = Object.values(App.state.iotDevices);
    if (!devices.length) {
      el.innerHTML = '<div class="live-list__empty">Scanning ISM bands…</div>';
      return;
    }
    el.innerHTML = devices.slice(0, 6).map(d => {
      const reading = formatReading(d);
      return `<div class="live-list__item">
        <span class="callsign" style="color:var(--accent-green)">${d.model.split('-')[0]}</span>
        <span class="detail">${d.type || 'sensor'}</span>
        <span class="alt" style="color:var(--accent-green)">${reading}</span>
      </div>`;
    }).join('');
  }

  function updateIotGrid() {
    const el = document.getElementById('iot-device-grid');
    if (!el || !window.App) return;
    const devices = Object.values(App.state.iotDevices);
    el.innerHTML = devices.map(d => buildIotCard(d)).join('');
    initRssiMeters();
  }

  function buildIotCard(d) {
    const typeClass = d.type || 'unknown';
    const readings = buildReadings(d);
    const rssiBar = d.rssi ? `<div class="rssi-bar-wrap"><div class="rssi-bar" style="width:${rssiToPercent(d.rssi)}%" data-rssi="${d.rssi}"></div></div>` : '';
    const ts = d.timestamp ? new Date(d.timestamp).toLocaleTimeString() : '—';

    return `<div class="iot-card iot-card--${typeClass}">
      <div class="iot-card__header">
        <div class="iot-card__model">${d.model || 'Unknown'} · id:${d.id || '?'}</div>
        <div class="iot-card__type iot-card__type--${typeClass}">${typeClass}</div>
      </div>
      <div class="iot-card__readings">${readings}</div>
      ${rssiBar}
      <div class="iot-card__footer">
        <span>${ts}</span>
        <span>${d.rssi ? d.rssi.toFixed(0) + ' dBm' : ''}</span>
      </div>
    </div>`;
  }

  function buildReadings(d) {
    const readings = [];
    if (d.temperature_C !== null && d.temperature_C !== undefined)
      readings.push(`<div class="iot-reading"><span class="iot-reading__val">${d.temperature_C.toFixed(1)}°C</span><span class="iot-reading__lbl">Temp</span></div>`);
    if (d.humidity !== null && d.humidity !== undefined)
      readings.push(`<div class="iot-reading"><span class="iot-reading__val">${Number(d.humidity).toFixed(0)}%</span><span class="iot-reading__lbl">Humidity</span></div>`);
    if (d.pressure_kPa)
      readings.push(`<div class="iot-reading"><span class="iot-reading__val">${d.pressure_kPa.toFixed(0)}</span><span class="iot-reading__lbl">kPa</span></div>`);
    if (d.wind_speed_km_h !== null && d.wind_speed_km_h !== undefined)
      readings.push(`<div class="iot-reading"><span class="iot-reading__val">${d.wind_speed_km_h.toFixed(1)}</span><span class="iot-reading__lbl">km/h wind</span></div>`);
    if (d.code)
      readings.push(`<div class="iot-reading"><span class="iot-reading__val" style="font-size:12px">${d.code}</span><span class="iot-reading__lbl">Code</span></div>`);
    if (!readings.length)
      readings.push(`<div class="iot-reading"><span class="iot-reading__val">—</span><span class="iot-reading__lbl">No data</span></div>`);
    return readings.join('');
  }

  function formatReading(d) {
    if (d.temperature_C !== null && d.temperature_C !== undefined) return `${Number(d.temperature_C).toFixed(1)}°C`;
    if (d.pressure_kPa) return `${Number(d.pressure_kPa).toFixed(0)} kPa`;
    if (d.code) return d.code.slice(0, 8);
    return '—';
  }

  function rssiToPercent(rssi) {
    return Math.max(5, Math.min(100, ((rssi + 100) / 50) * 100));
  }

  function initRssiMeters() {
    // Add CSS for RSSI bars if not present
    if (!document.getElementById('rssi-style')) {
      const s = document.createElement('style');
      s.id = 'rssi-style';
      s.textContent = `.rssi-bar-wrap{height:3px;background:var(--bg-3);border-radius:2px;margin:8px 0 4px}.rssi-bar{height:100%;background:linear-gradient(90deg,var(--accent-green),var(--accent-cyan));border-radius:2px;transition:width 0.5s}`;
      document.head.appendChild(s);
    }
  }

  // ── APRS messages ─────────────────────────────────────────────
  function addAprsMessage(msg) {
    const el = document.getElementById('aprs-message-list');
    if (!el) return;
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px;border-bottom:1px solid var(--glass-border);font-size:12px';
    row.innerHTML = `<b style="color:var(--accent-purple)">${msg.callsign}</b>
      <span style="color:var(--text-2);font-size:10px;float:right">${new Date().toLocaleTimeString()}</span>
      <div style="color:var(--text-1);margin-top:4px">${msg.info || ''}</div>`;
    el.insertBefore(row, el.firstChild);
    if (el.children.length > 50) el.removeChild(el.lastChild);
  }

  // ── Scanner ───────────────────────────────────────────────────
  const Scanner = (() => {
    let scanChart = null;
    let scanCtx = null;
    let lastResult = null;

    function init() {
      const canvas = document.getElementById('scan-chart');
      if (!canvas) return;
      scanChart = canvas;
      scanCtx = canvas.getContext('2d');
      canvas.width = canvas.offsetWidth || 800;
      canvas.height = 240;

      // Populate band select
      const sel = document.getElementById('scan-band-select');
      if (sel && window.App) {
        fetch('/api/status').then(r => r.json()).then(s => {
          // Would populate from config in a real scenario
        });
      }

      const bands = ['Airband AM','Marine VHF','PMR446','ISM 433','LTE/4G 800'];
      const sel2 = document.getElementById('scan-band-select');
      if (sel2 && !sel2.options.length) {
        bands.forEach(b => {
          const opt = document.createElement('option');
          opt.value = b; opt.textContent = b;
          sel2.appendChild(opt);
        });
      }

      document.getElementById('scan-trigger-btn')?.addEventListener('click', () => {
        const band = document.getElementById('scan-band-select')?.value;
        fetch('/api/scan/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ band })
        });
      });

      fetch('/api/scan/results').then(r => r.json()).then(results => {
        if (results.length) onResult(results[0]);
      }).catch(() => {});
    }

    function onResult(result) {
      lastResult = result;
      drawScanChart(result);
      addSweepRow(result);
    }

    function onAnomaly(anomaly) {
      const el = document.getElementById('anomaly-list');
      if (!el) return;
      const row = document.createElement('div');
      row.className = 'anomaly-row';
      row.innerHTML = `<span class="freq">${anomaly.frequencyMHz} MHz</span>
        <span class="band">${anomaly.band}</span>
        <span class="delta">+${Number(anomaly.delta).toFixed(0)} dB</span>
        <span class="time">${new Date(anomaly.timestamp).toLocaleTimeString()}</span>`;
      el.insertBefore(row, el.firstChild);
      if (el.children.length > 20) el.removeChild(el.lastChild);
    }

    function drawScanChart(result) {
      if (!scanCtx || !result) return;
      const W = scanChart.width, H = scanChart.height;
      scanCtx.clearRect(0, 0, W, H);

      // Background
      scanCtx.fillStyle = 'rgba(0,0,0,0.3)';
      scanCtx.fillRect(0, 0, W, H);

      // Grid lines
      scanCtx.strokeStyle = 'rgba(255,255,255,0.05)';
      scanCtx.lineWidth = 1;
      [-60,-70,-80,-90].forEach(db => {
        const y = ((db + 100) / 60) * H;
        scanCtx.beginPath();
        scanCtx.moveTo(0, y);
        scanCtx.lineTo(W, y);
        scanCtx.stroke();
        scanCtx.fillStyle = 'rgba(255,255,255,0.3)';
        scanCtx.fillText(`${db}dBm`, 4, y - 2);
      });

      if (!result.powers || !result.powers.length) return;

      // Gradient fill
      const grad = scanCtx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, 'rgba(245,158,11,0.5)');
      grad.addColorStop(1, 'rgba(245,158,11,0.02)');

      scanCtx.beginPath();
      result.powers.forEach((p, i) => {
        const x = (i / result.powers.length) * W;
        const y = Math.max(0, Math.min(H, H - ((p + 100) / 60) * H));
        if (i === 0) scanCtx.moveTo(x, y); else scanCtx.lineTo(x, y);
      });
      scanCtx.lineTo(W, H); scanCtx.lineTo(0, H); scanCtx.closePath();
      scanCtx.fillStyle = grad;
      scanCtx.fill();

      // Line
      scanCtx.beginPath();
      scanCtx.strokeStyle = '#f59e0b';
      scanCtx.lineWidth = 1.5;
      result.powers.forEach((p, i) => {
        const x = (i / result.powers.length) * W;
        const y = Math.max(0, Math.min(H, H - ((p + 100) / 60) * H));
        if (i === 0) scanCtx.moveTo(x, y); else scanCtx.lineTo(x, y);
      });
      scanCtx.stroke();

      // Freq labels
      scanCtx.fillStyle = 'rgba(255,255,255,0.4)';
      scanCtx.font = '10px monospace';
      [0, 0.25, 0.5, 0.75, 1].forEach(frac => {
        const freq = result.start + frac * (result.end - result.start);
        const x = frac * W;
        scanCtx.fillText(`${(freq / 1e6).toFixed(1)}`, x + 2, H - 4);
      });
    }

    function addSweepRow(result) {
      const el = document.getElementById('sweep-list');
      if (!el) return;
      const maxP = result.powers ? Math.max(...result.powers).toFixed(0) : '—';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:12px;padding:6px 8px;border-radius:4px;font-family:monospace;font-size:11px;color:var(--text-1);border-bottom:1px solid var(--glass-border)';
      row.innerHTML = `<span style="color:var(--accent-yellow)">${result.band}</span>
        <span>${(result.start/1e6).toFixed(1)}–${(result.end/1e6).toFixed(1)} MHz</span>
        <span>peak: ${maxP} dBm</span>
        <span style="margin-left:auto;color:var(--text-2)">${new Date(result.timestamp).toLocaleTimeString()}</span>`;
      el.insertBefore(row, el.firstChild);
      if (el.children.length > 20) el.removeChild(el.lastChild);
    }

    return { init, onResult, onAnomaly };
  })();

  // ── Recorder UI ───────────────────────────────────────────────
  function initRecorder() {
    document.getElementById('rec-start-btn')?.addEventListener('click', () => {
      const freq = parseFloat(document.getElementById('rec-freq').value) * 1e6;
      const bandwidth = parseInt(document.getElementById('rec-bw').value);
      const duration = parseInt(document.getElementById('rec-duration').value) || 0;
      const label = document.getElementById('rec-label').value;

      fetch('/api/recordings/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frequency: freq, bandwidth, duration: duration || undefined, label })
      }).then(r => r.json()).then(rec => {
        loadRecordings();
      });
    });

    loadRecordings();
  }

  function loadRecordings() {
    fetch('/api/recordings').then(r => r.json()).then(recs => {
      const el = document.getElementById('recordings-grid');
      if (!el) return;
      if (!recs.length) {
        el.innerHTML = '<div style="color:var(--text-2);font-size:12px;padding:16px">No recordings yet</div>';
        return;
      }
      el.innerHTML = recs.map(rec => `
        <div class="rec-card ${rec.active ? 'active' : ''}">
          <div class="rec-card__name">${rec.label || rec.filename}</div>
          <div class="rec-card__meta">${rec.filename}</div>
          <div class="rec-card__meta">${rec.sizeMb || '0'} MB · ${rec.duration ? rec.duration + 's' : 'ongoing'}</div>
          <div class="rec-card__actions">
            ${rec.active
              ? `<button class="btn btn--danger btn--sm" onclick="stopRecording('${rec.id}')">⏹ Stop</button>`
              : `<button class="btn btn--danger btn--sm" onclick="deleteRecording('${rec.id}')">🗑 Delete</button>`
            }
          </div>
        </div>`).join('');
    }).catch(() => {});
  }

  window.stopRecording = (id) => {
    fetch('/api/recordings/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    }).then(() => loadRecordings());
  };

  window.deleteRecording = (id) => {
    fetch(`/api/recordings/${id}`, { method: 'DELETE' }).then(() => loadRecordings());
  };

  document.addEventListener('DOMContentLoaded', () => {
    initRecorder();
    setTimeout(updateAircraftList, 2000);
    setInterval(updateAircraftList, 5000);
    setInterval(updateDashIotList, 3000);
  });

  // Expose Scanner to window for app.js
  window.Scanner = Scanner;

  return { updateAircraftList, updateIotCard, addAprsMessage };
})();
