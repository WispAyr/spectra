/* SPECTRA — app.js: router, WS client, state, tenant/site model */

const App = (() => {
  // ── Tenant / Site State ──────────────────────────────────────
  const state = {
    tenant: { id: 'default', name: 'Default Tenant' },
    sites: [
      { id: 'van-1', name: 'Van Unit 1', nrspHost: '192.168.1.100', active: true },
    ],
    activeSiteId: 'van-1',
    aircraft: {},
    aprsStations: {},
    iotDevices: {},
    signalCounts: { adsb: 0, aprs: 0, iot: 0, scan: 0 },
    logEntries: [],
    ws: null,
    connected: false,
    uptime: 0,
    frequency: 100e6,
  };

  // ── WebSocket ────────────────────────────────────────────────
  function connectWs() {
    const ws = new WebSocket(`ws://${location.host}`);
    state.ws = ws;

    ws.onopen = () => console.log('[WS] connected');

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    };

    ws.onclose = () => {
      state.connected = false;
      updateStatus(false);
      setTimeout(connectWs, 3000);
    };

    ws.onerror = () => ws.close();
  }

  function send(type, data) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type, ...data }));
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'state_init':
        msg.data.aircraft.forEach(a => { state.aircraft[a.hex] = a; });
        msg.data.aprsStations.forEach(s => { state.aprsStations[s.callsign] = s; });
        msg.data.iotDevices.forEach(d => { state.iotDevices[`${d.model}_${d.id}`] = d; });
        state.signalCounts = msg.data.signalCounts;
        state.connected = !!msg.data.connected;
        updateStatus(state.connected, !state.connected);
        refreshAll();
        break;
      case 'adsb_update':
        state.aircraft[msg.data.hex] = msg.data;
        state.signalCounts.adsb++;
        onAdsb(msg.data);
        addLog('adsb', `${msg.data.callsign || msg.data.hex} ${msg.data.altitude}ft ${msg.data.speed}kt`);
        break;
      case 'adsb_remove':
        delete state.aircraft[msg.data.hex];
        if (window.AdsbMap) AdsbMap.removeAircraft(msg.data.hex);
        break;
      case 'aprs_update':
        state.aprsStations[msg.data.callsign] = msg.data;
        state.signalCounts.aprs++;
        if (window.AprsMap) AprsMap.update(msg.data);
        addLog('aprs', `${msg.data.callsign}: ${msg.data.comment || ''}`);
        break;
      case 'aprs_message':
        addLog('aprs', `MSG ${msg.data.callsign}: ${msg.data.info}`);
        Widgets.addAprsMessage(msg.data);
        break;
      case 'iot_update':
        state.signalCounts.iot++;
        Widgets.updateIotCard(msg.data);
        addLog('iot', `${msg.data.model} id:${msg.data.id} ${formatIotReading(msg.data)}`);
        break;
      case 'scan_result':
        if (window.Scanner) Scanner.onResult(msg.data);
        state.signalCounts.scan++;
        break;
      case 'scan_anomaly':
        if (window.Scanner) Scanner.onAnomaly(msg.data);
        addLog('scan_anomaly', `${msg.data.frequencyMHz} MHz +${msg.data.delta.toFixed(0)}dB`);
        break;
      case 'sdr_status':
        state.connected = msg.data.connected;
        updateStatus(msg.data.connected);
        break;
      case 'heartbeat':
        state.uptime = msg.data.uptime;
        state.signalCounts = msg.data.signalCounts;
        updateHeartbeat(msg.data);
        break;
      case 'fft_data':
        if (window.Waterfall) Waterfall.pushFft(msg.data);
        break;
    }
  }

  // ── Routing ──────────────────────────────────────────────────
  let currentPage = 'dashboard';

  function goTo(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const pg = document.getElementById(`page-${page}`);
    const nav = document.getElementById(`nav-${page}`);
    if (pg) pg.classList.add('active');
    if (nav) nav.classList.add('active');
    currentPage = page;
    onPageActivated(page);
  }

  window.goTo = goTo;

  function onPageActivated(page) {
    if (page === 'adsb' && window.AdsbMap) AdsbMap.init();
    if (page === 'aprs' && window.AprsMap) AprsMap.init();
    if (page === 'waterfall' && window.Waterfall) Waterfall.init();
    if (page === 'scanner' && window.Scanner) Scanner.init();
    if (page === 'settings') renderSettings();
    if (page === 'nrsp') loadNrspIframe();
  }

  // ── UI Updates ───────────────────────────────────────────────
  function refreshAll() {
    updateStatCards();
    Object.values(state.aircraft).forEach(onAdsb);
    if (window.AprsMap) Object.values(state.aprsStations).forEach(s => AprsMap.update(s));
    if (window.Waterfall) Waterfall.startPolling();
  }

  function onAdsb(ac) {
    updateStatCards();
    if (window.AdsbMap) AdsbMap.update(ac);
    Widgets.updateAircraftList();
  }

  function updateStatCards() {
    const ac = Object.keys(state.aircraft).length;
    const ap = Object.keys(state.aprsStations).length;
    const io = Object.keys(state.iotDevices).length;
    setText('stat-aircraft-val', ac);
    setText('stat-aprs-val', ap);
    setText('stat-iot-val', io);
    setText('stat-scan-val', state.signalCounts.scan);
    setText('badge-adsb', ac);
    setText('badge-aprs', ap);
    setText('badge-iot', io);
  }

  function updateStatus(connected) {
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    if (!dot || !txt) return;
    dot.className = `status-dot status-dot--${connected ? 'connected' : 'offline'}`;
    txt.textContent = connected ? 'Connected' : 'Offline';
  }

  function updateHeartbeat(data) {
    updateStatCards();
    const up = data.uptime;
    const h = String(Math.floor(up / 3600)).padStart(2, '0');
    const m = String(Math.floor((up % 3600) / 60)).padStart(2, '0');
    const s = String(up % 60).padStart(2, '0');
    setText('uptime-display', `UP ${h}:${m}:${s}`);
  }

  function addLog(type, msg) {
    const el = document.getElementById('signal-log-feed');
    if (!el) return;
    const now = new Date().toTimeString().slice(0, 8);
    const row = document.createElement('div');
    row.className = 'log-entry';
    row.innerHTML = `<span class="log-entry__time">${now}</span>
      <span class="log-entry__type log-entry__type--${type}">${type}</span>
      <span class="log-entry__msg">${escHtml(msg)}</span>`;
    el.insertBefore(row, el.firstChild);
    if (el.children.length > 200) el.removeChild(el.lastChild);
  }

  // ── Tenant / Site UI ─────────────────────────────────────────
  function renderSiteSwitcher() {
    const existing = document.getElementById('site-switcher');
    if (existing) return;

    const sw = document.createElement('div');
    sw.id = 'site-switcher';
    sw.style.cssText = 'padding:8px 16px;border-bottom:1px solid var(--glass-border)';
    sw.innerHTML = `<select id="site-select" class="wf-select" style="width:100%;font-size:11px;">
      ${state.sites.map(s => `<option value="${s.id}" ${s.id===state.activeSiteId?'selected':''}>${s.name}</option>`).join('')}
      <option value="__add">+ Add site…</option>
    </select>`;
    document.querySelector('.sidebar__status').after(sw);

    document.getElementById('site-select').addEventListener('change', (e) => {
      if (e.target.value === '__add') { showAddSiteModal(); return; }
      switchSite(e.target.value);
    });
  }

  function switchSite(siteId) {
    const site = state.sites.find(s => s.id === siteId);
    if (!site) return;
    state.activeSiteId = siteId;
    fetch('/api/nrsp/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: site.nrspHost })
    });
    state.aircraft = {};
    state.aprsStations = {};
    state.iotDevices = {};
    updateStatCards();
    console.log('[Sites] Switched to', site.name);
  }

  function showAddSiteModal() {
    const name = prompt('Site name (e.g. "Van Unit 2"):');
    if (!name) return;
    const host = prompt('nRSP-ST IP address:', '192.168.1.100');
    if (!host) return;
    const id = name.toLowerCase().replace(/\s+/g, '-');
    state.sites.push({ id, name, nrspHost: host, active: false });
    renderSiteSwitcher();
    document.getElementById('site-select').value = id;
    switchSite(id);
  }

  // ── Settings render ───────────────────────────────────────────
  function renderSettings() {
    fetch('/api/status').then(r => r.json()).then(data => {
      const si = document.getElementById('sys-info');
      if (si) si.innerHTML = `
        <div class="sys-row"><span>Backend</span><span>Node.js running</span></div>
        <div class="sys-row"><span>nRSP Host</span><span>${data.config.nrsp.host}</span></div>
        <div class="sys-row"><span>Uptime</span><span>${data.uptime}s</span></div>
        <div class="sys-row"><span>Tenant</span><span>${state.tenant.name}</span></div>
        <div class="sys-row"><span>Sites</span><span>${state.sites.length}</span></div>`;

      const dt = document.getElementById('decoder-toggles');
      if (dt && data.config.decoders) {
        dt.innerHTML = Object.entries(data.config.decoders).map(([k, v]) => `
          <div class="decoder-row">
            <span>${k.toUpperCase()}</span>
            <label class="toggle-switch">
              <input type="checkbox" ${v.enabled ? 'checked' : ''} onchange="toggleDecoder('${k}', this.checked)">
              <div class="toggle-track"></div>
            </label>
          </div>`).join('');
      }
    }).catch(() => {});
  }

  window.toggleDecoder = (name, enabled) => {
    fetch(`/api/decoders/${name}/toggle`, { method: 'POST' });
  };

  // ── nRSP iframe ───────────────────────────────────────────────
  function loadNrspIframe() {
    fetch('/api/nrsp/weburl').then(r => r.json()).then(({ url }) => {
      const frame = document.getElementById('nrsp-iframe');
      const urlEl = document.getElementById('nrsp-url-display');
      const link = document.getElementById('nrsp-open-link');
      if (frame && frame.src === 'about:blank') frame.src = url;
      if (urlEl) urlEl.textContent = url;
      if (link) link.href = url;
    }).catch(() => {});
  }

  // ── Waterfall controls ────────────────────────────────────────
  function initWaterfallControls() {
    document.getElementById('wf-tune-btn')?.addEventListener('click', () => {
      const freq = parseFloat(document.getElementById('wf-freq-input').value) * 1e6;
      const bw = parseInt(document.getElementById('wf-bw-select').value);
      const ant = document.getElementById('wf-ant-select').value;
      state.frequency = freq;
      send('tune', { frequency: freq, bandwidth: bw });
      send('set_antenna', { port: ant });
      setText('freq-display', `${(freq / 1e6).toFixed(3)} MHz`);
      if (window.Waterfall) Waterfall.setFrequency(freq, bw);
    });

    document.getElementById('wf-gain')?.addEventListener('input', (e) => {
      const val = e.target.value;
      setText('wf-gain-val', `${val} dB`);
      send('set_gain', { gainReduction: parseInt(val) });
    });

    document.querySelectorAll('.band-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const freq = parseFloat(btn.dataset.freq) * 1e6;
        const bw = parseInt(btn.dataset.bw);
        document.getElementById('wf-freq-input').value = btn.dataset.freq;
        document.getElementById('wf-bw-select').value = bw;
        send('tune', { frequency: freq, bandwidth: bw });
        state.frequency = freq;
        if (window.Waterfall) Waterfall.setFrequency(freq, bw);
      });
    });
  }

  // ── Nav listeners ─────────────────────────────────────────────
  function initNav() {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        goTo(item.dataset.page);
      });
    });
  }

  // ── Filter buttons ────────────────────────────────────────────
  function initFilters() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  // ── Save settings ─────────────────────────────────────────────
  function initSettings() {
    document.getElementById('save-nrsp-btn')?.addEventListener('click', () => {
      const host = document.getElementById('set-nrsp-host').value;
      const webPort = parseInt(document.getElementById('set-nrsp-webport').value);
      const antennaPort = document.getElementById('set-antenna').value;
      fetch('/api/nrsp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, webPort, antennaPort })
      }).then(() => alert('Saved — reconnecting…'));
    });
  }

  // ── Helpers ───────────────────────────────────────────────────
  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatIotReading(d) {
    if (d.temperature_C !== null && d.temperature_C !== undefined)
      return `${d.temperature_C.toFixed(1)}°C ${d.humidity ? d.humidity.toFixed(0)+'%' : ''}`;
    if (d.pressure_kPa) return `${d.pressure_kPa.toFixed(0)} kPa`;
    if (d.code) return `code:${d.code}`;
    return '';
  }

  // ── Boot ─────────────────────────────────────────────────────
  function init() {
    initNav();
    initFilters();
    initWaterfallControls();
    initSettings();
    renderSiteSwitcher();
    connectWs();
    // Start FFT polling
    setInterval(() => {
      if (currentPage === 'waterfall') send('request_fft', {});
    }, 300);
  }

  document.addEventListener('DOMContentLoaded', init);
  return { state, send, goTo, addLog };
})();
