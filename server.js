/**
 * SPECTRA — SDRplay nRSP-ST Van Intelligence Platform
 * Main server: Express API + WebSocket hub + module orchestration
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// Modules
const SdrManager = require('./modules/sdr-manager');
const AdsbFeed = require('./modules/adsb-feed');
const AprsFeed = require('./modules/aprs-feed');
const IotFeed = require('./modules/iot-feed');
const SpectrumScanner = require('./modules/spectrum-scanner');
const RecordingManager = require('./modules/recording-manager');
const SignalLog = require('./modules/signal-log');
const IqTcpServer = require('./modules/iq-tcp-server');
const SignalDetector = require('./modules/signal-detector');
const AudioWsBridge = require('./modules/audio-ws-bridge');
const SecondDemod = require('./modules/second-demod');
const ChannelScanner = require('./modules/channel-scanner');
const BandSweeper = require('./modules/band-sweeper');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  connected: false,
  startTime: Date.now(),
  aircraft: {},
  aprsStations: {},
  iotDevices: {},
  recordings: [],
  scanResults: [],
  signalCounts: { adsb: 0, aprs: 0, iot: 0, scan: 0 }
};

// ─── WebSocket Broadcast ──────────────────────────────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ─── Module Initialisation ────────────────────────────────────────────────────
const signalLog = new SignalLog(config.database.path);

// Active-frequency detector: peak-detects signals from the live FFT window.
const detector = new SignalDetector(config.detector || {});

const sdrManager = new SdrManager(config.nrsp, (status) => {
  state.connected = status.connected;
  broadcast('sdr_status', status);
});

const adsbFeed = config.decoders.adsb.enabled ? new AdsbFeed(config.decoders.adsb, {
  onAircraft: (aircraft) => {
    state.aircraft[aircraft.hex] = aircraft;
    state.signalCounts.adsb++;
    broadcast('adsb_update', aircraft);
    signalLog.log('adsb', aircraft);
  },
  onTimeout: (hex) => {
    delete state.aircraft[hex];
    broadcast('adsb_remove', { hex });
  }
}) : null;

const aprsFeed = config.decoders.aprs.enabled ? new AprsFeed(config.decoders.aprs, {
  onStation: (station) => {
    state.aprsStations[station.callsign] = station;
    state.signalCounts.aprs++;
    broadcast('aprs_update', station);
    signalLog.log('aprs', station);
  },
  onMessage: (msg) => broadcast('aprs_message', msg)
}) : null;

const iotFeed = config.decoders.iot.enabled ? new IotFeed(config.decoders.iot, {
  onDevice: (device) => {
    const key = `${device.model || 'unknown'}_${device.id || Math.random()}`;
    state.iotDevices[key] = { ...device, lastSeen: Date.now() };
    state.signalCounts.iot++;
    broadcast('iot_update', device);
    signalLog.log('iot', device);
  }
}) : null;

const scanner = config.scanner.enabled ? new SpectrumScanner(config.scanner, sdrManager, {
  onSweep: (result) => {
    state.scanResults.unshift(result);
    if (state.scanResults.length > 500) state.scanResults.pop();
    state.signalCounts.scan++;
    broadcast('scan_result', result);
  },
  onAnomaly: (anomaly) => {
    broadcast('scan_anomaly', anomaly);
    signalLog.log('scan_anomaly', anomaly);
  }
}) : null;

// IQ-as-rtl_tcp bridge: lets readsb / rtl_433 / rtl_ais consume the nRSP-ST
// over the WebSocket SDRconnect feed as if it were a USB RTL-SDR dongle.
const iqBridge = (config.iqBridge && config.iqBridge.enabled !== false)
  ? new IqTcpServer(config.iqBridge || {}, sdrManager)
  : null;

const recorder = new RecordingManager(config.recording, sdrManager, {
  onStart: (rec) => {
    state.recordings.unshift(rec);
    broadcast('recording_start', rec);
  },
  onStop: (rec) => {
    const idx = state.recordings.findIndex(r => r.id === rec.id);
    if (idx !== -1) state.recordings[idx] = rec;
    broadcast('recording_stop', rec);
  }
});

// Audio relay: demodulated nRSP audio (0x0001 frames) → kiosk RF Intel
// "PTT / LISTEN". Serves ws://127.0.0.1:3334/ws/audio for the CSU proxy.
const audioBridge = new AudioWsBridge(sdrManager, config.audioBridge || {});

// Second in-process NFM channel: DDC + demod on the Full-IQ stream, served on
// /ws/audio2, so the van hears a second frequency simultaneously with the
// primary SDRconnect demod (which stays on the tuned centre).
const ch2cfg = config.channel2 || {};
const secondDemod = new SecondDemod(sdrManager, {
  fsIn: config.nrsp.sampleRate || 2000000,
  centerHz: config.nrsp.frequency || 455625000,
  targetHz: ch2cfg.frequency || 455700000,
  enabled: ch2cfg.enabled !== false,
  gain: ch2cfg.gain,
  squelchEnabled: !!ch2cfg.squelchEnabled,
  squelchLevel: ch2cfg.squelchLevel,
});
audioBridge.audio2Rate = secondDemod.fsAudio;
secondDemod.on('audio', (buf) => audioBridge.pushAudio2(buf));

// On-demand gating: stream Full-IQ while /ws/audio2 (2nd NFM) OR /ws/iq
// (raw IQ consumers e.g. DAB) have listeners — reclaims CPU when idle.
function evalIqGate() {
  const a2 = audioBridge.wssAudio2 ? audioBridge.wssAudio2.clients.size : 0;
  const iq = audioBridge.wssIq ? audioBridge.wssIq.clients.size : 0;
  const wantA2 = a2 > 0 && secondDemod.enabled;
  secondDemod.setActive(wantA2);
  sdrManager.setIqStream(wantA2 || iq > 0);
}
audioBridge.onAudio2Clients = () => evalIqGate();
audioBridge.onIqClients = () => evalIqGate();

// ─── REST API ─────────────────────────────────────────────────────────────────

// Status
app.get('/api/status', (req, res) => {
  const fft = sdrManager.getLastFft();
  res.json({
    connected: state.connected,
    uptime: Math.floor((Date.now() - state.startTime) / 1000),
    aircraftCount: Object.keys(state.aircraft).length,
    aprsCount: Object.keys(state.aprsStations).length,
    iotDeviceCount: Object.keys(state.iotDevices).length,
    signalCounts: state.signalCounts,
    sdr: {
      connected: fft.connected,
      activeDevice: fft.activeDevice,
      frequency: fft.frequency,
      bandwidth: fft.bandwidth,
      signalPower: fft.signalPower,
      signalSnr: fft.signalSnr,
      lastSpectrumAt: fft.timestamp
    },
    scanner: scanner ? scanner.status() : { running: false, realDataAvailable: false, backend: null },
    config: {
      nrsp: { host: config.nrsp.host, wsPort: config.nrsp.wsPort },
      decoders: Object.fromEntries(
        Object.entries(config.decoders).map(([k, v]) => [k, { enabled: v.enabled }])
      )
    }
  });
});

// Aircraft
app.get('/api/adsb/aircraft', (req, res) => {
  res.json(Object.values(state.aircraft));
});

// APRS
app.get('/api/aprs/stations', (req, res) => {
  res.json(Object.values(state.aprsStations));
});

// IoT Devices
app.get('/api/iot/devices', (req, res) => {
  res.json(Object.values(state.iotDevices));
});

// Scan Results
app.get('/api/scan/results', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(state.scanResults.slice(0, limit));
});

// Active frequencies detected from the live FFT window
app.get('/api/signals/active', (req, res) => {
  res.json({
    ok: true,
    tunedHz: sdrManager.getLastFft().frequency,
    spanHz: sdrManager.getLastFft().bandwidth,
    signals: detector.list()
  });
});

// Audio frame stats (for characterising the SDRconnect 0x0001 audio wire format)
app.get('/api/audio/stats', (req, res) => {
  const stats = sdrManager.getAudioStats ? sdrManager.getAudioStats() : { unsupported: true };
  stats.secondary = sdrManager.getAudio2Stats ? sdrManager.getAudio2Stats() : null;
  res.json(stats);
});

// Signal Log
app.get('/api/log', (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  const type = req.query.type;
  res.json(signalLog.query(type, limit));
});

// nRSP-ST Config
app.get('/api/nrsp/config', (req, res) => {
  res.json(config.nrsp);
});

app.post('/api/nrsp/config', (req, res) => {
  const { host, webPort, antennaPort, gainReduction, frequency, bandwidth, demodMode, sampleRate, iqStream } = req.body;
  // SCAN-STOP ATTRIBUTION: the channel scan has stopped silently twice with
  // wedged=false, so it is being stopped externally. Record WHO.
  if (chanScanner.running) {
    console.log('[ChanScan] STOPPED BY POST /api/radio (manual tune) ip=' + (req.socket && req.socket.remoteAddress) +
      ' ua=' + JSON.stringify(req.headers['user-agent'] || '') +
      ' ref=' + JSON.stringify(req.headers['referer'] || '') +
      ' body=' + JSON.stringify(req.body || {}).slice(0, 200));
  }
  // A manual tune takes the radio back from the scanner / sweeper
  if (frequency && chanScanner.running) chanScanner.stop();
  if (frequency && bandSweeper.running) bandSweeper.stop();
  if (host) config.nrsp.host = host;
  if (webPort) config.nrsp.webPort = webPort;
  if (antennaPort) config.nrsp.antennaPort = antennaPort;
  if (gainReduction !== undefined) config.nrsp.gainReduction = gainReduction;
  if (frequency) config.nrsp.frequency = frequency;
  if (bandwidth) config.nrsp.bandwidth = bandwidth;
  // DAB needs 2048000; was previously ignored (destructure omitted sampleRate).
  if (sampleRate !== undefined && sampleRate !== null) {
    const sr = parseInt(sampleRate, 10);
    if (!Number.isNaN(sr) && sr > 0) config.nrsp.sampleRate = sr;
  }
  if (iqStream !== undefined) config.nrsp.iqStream = !!iqStream;
  sdrManager.updateConfig(config.nrsp);
  // Keep 2nd-channel demod DDC math aligned with device sample rate.
  if (sampleRate !== undefined && secondDemod && typeof secondDemod.fsIn !== 'undefined') {
    secondDemod.fsIn = config.nrsp.sampleRate || secondDemod.fsIn;
    if (typeof secondDemod._setOsc === 'function') secondDemod._setOsc();
  }
  if (demodMode) {
    config.nrsp.demodMode = demodMode;
    sdrManager.setDemod(demodMode);
  }
  // Re-assert sample rate after demod change (some stacks reset on mode switch).
  if (config.nrsp.sampleRate) {
    sdrManager._send({
      event_type: 'set_property',
      property: 'device_sample_rate',
      value: String(config.nrsp.sampleRate),
      device: 'primary',
    });
    sdrManager._send({ event_type: 'get_property', property: 'device_sample_rate', device: 'primary' });
  }
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
  res.json({ success: true, config: config.nrsp });
});

// Squelch — level <= -120 means OFF. Threshold is in the same dB scale as
// signal_power. Persisted under config.nrsp.squelch.
app.get('/api/squelch', (req, res) => {
  res.json({
    level: sdrManager.squelchEnabled ? sdrManager.squelchThreshold : -120,
    enabled: sdrManager.squelchEnabled,
    open: sdrManager.squelchOpen(),
  });
});

app.post('/api/squelch', (req, res) => {
  const level = parseInt(req.body.level, 10);
  if (Number.isNaN(level)) return res.status(400).json({ error: 'level required' });
  const enabled = level > -120;
  sdrManager.setSquelch(enabled, enabled ? level : -120);
  config.nrsp.squelch = { level: enabled ? level : -120 };
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
  res.json({ level: enabled ? level : -120, enabled, open: sdrManager.squelchOpen() });
});

// Raw SDRconnect protocol access — discovery/debug (loopback consumers only;
// see docs/SDRCONNECT_BRIDGE.md for the property vocabulary)
app.post('/api/nrsp/raw', (req, res) => {
  if (!req.body || !req.body.event_type) return res.status(400).json({ error: 'event_type required' });
  sdrManager.sendRaw({ device: 'primary', ...req.body });
  res.json({ sent: true });
});

app.get('/api/nrsp/responses', (req, res) => {
  res.json(sdrManager.lastMessages.slice(-40));
});

// ─── Antenna ──────────────────────────────────────────────────────────────────
app.get('/api/antenna', (req, res) => {
  res.json({ antenna: sdrManager.activeAntenna, valid: sdrManager.antennas });
});

app.post('/api/antenna', (req, res) => {
  const ant = String(req.body.antenna || '');
  if (!ant) return res.status(400).json({ error: 'antenna required' });
  sdrManager.setAntenna(ant);
  config.nrsp.antennaPort = ant;
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
  res.json({ antenna: ant });
});

// ─── Radio facilities (gain / AGC / audio options / RDS / VFO) ────────────────
// Second channel (in-process demod on the Full-IQ stream)
app.get('/api/nrsp/ch2', (req, res) => {
  const st = secondDemod.stats();
  st.bridge = audioBridge.audio2Stats ? audioBridge.audio2Stats() : null;
  st.presets = config.channel2Presets || [];
  res.json(st);
});
app.post('/api/nrsp/ch2', (req, res) => {
  const b = req.body || {};
  if (b.frequency !== undefined) secondDemod.setTarget(parseInt(b.frequency, 10));
  if (b.enabled !== undefined) secondDemod.setEnabled(!!b.enabled);
  if (b.gain !== undefined) secondDemod.setGain(parseFloat(b.gain));
  if (b.squelch !== undefined || b.squelchLevel !== undefined) {
    secondDemod.setSquelch(b.squelch !== undefined ? !!b.squelch : secondDemod.squelchEnabled,
      b.squelchLevel !== undefined ? parseFloat(b.squelchLevel) : null);
  }
  config.channel2 = {
    frequency: secondDemod.targetHz, enabled: secondDemod.enabled, gain: secondDemod.gain,
    squelchEnabled: secondDemod.squelchEnabled, squelchLevel: secondDemod.squelchLevel,
  };
  try { fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2)); } catch (e) {}
  evalIqGate();
  res.json(secondDemod.stats());
});

app.get('/api/radio', (req, res) => {
  res.json(sdrManager.getRadioState());
});

app.post('/api/radio', (req, res) => {
  const b = req.body || {};
  if (b.lnaState !== undefined) sdrManager.setLna(b.lnaState);
  if (b.agcEnable !== undefined) sdrManager.setAgc(!!b.agcEnable);
  if (b.vfoFrequency) sdrManager.setVfo(parseInt(b.vfoFrequency, 10));
  for (const k of Object.keys(SdrManager.OPTION_PROPS || {})) {
    if (b[k] !== undefined) sdrManager.setOption(k, !!b[k]);
  }
  res.json({ ok: true, state: sdrManager.getRadioState() });
});

// ─── Presets (persisted channel memory) ───────────────────────────────────────
if (!Array.isArray(config.presets)) config.presets = [];

function savePresets() {
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
}

app.get('/api/presets', (req, res) => {
  res.json({ presets: config.presets });
});

app.post('/api/presets', (req, res) => {
  const { name, location, frequency, demodMode, gain, bandwidth } = req.body || {};
  const freq = parseInt(frequency, 10);
  if (!name || !freq) return res.status(400).json({ error: 'name and frequency required' });
  const preset = {
    id: 'p' + freq + '-' + Math.abs([...String(name)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)),
    name: String(name), location: String(location || 'General'),
    frequency: freq, demodMode: demodMode || 'NFM',
    bandwidth: parseInt(bandwidth, 10) || 12500,
    gain: gain !== undefined ? parseInt(gain, 10) : undefined,
  };
  config.presets = config.presets.filter(p => p.id !== preset.id);
  config.presets.push(preset);
  savePresets();
  res.json({ preset });
});

app.post('/api/presets/:id/activate', (req, res) => {
  const preset = config.presets.find(p => p.id === req.params.id);
  if (!preset) return res.status(404).json({ error: 'preset not found' });
  // SCAN-STOP ATTRIBUTION: the channel scan has stopped silently twice with
  // wedged=false, so it is being stopped externally. Record WHO.
  if (chanScanner.running) {
    console.log('[ChanScan] STOPPED BY POST /api/presets/:id/activate ip=' + (req.socket && req.socket.remoteAddress) +
      ' ua=' + JSON.stringify(req.headers['user-agent'] || '') +
      ' ref=' + JSON.stringify(req.headers['referer'] || '') +
      ' body=' + JSON.stringify(req.body || {}).slice(0, 200));
  }
  if (chanScanner.running) chanScanner.stop();
  if (bandSweeper.running) bandSweeper.stop();
  if (preset.demodMode) sdrManager.setDemod(preset.demodMode);
  sdrManager.tune(preset.frequency, preset.bandwidth || 12500);
  config.nrsp.frequency = preset.frequency;
  if (preset.bandwidth) config.nrsp.bandwidth = preset.bandwidth;
  if (preset.demodMode) config.nrsp.demodMode = preset.demodMode;
  savePresets();
  res.json({ preset });
});

app.delete('/api/presets/:id', (req, res) => {
  const before = config.presets.length;
  config.presets = config.presets.filter(p => p.id !== req.params.id);
  savePresets();
  res.json({ deleted: before - config.presets.length });
});

// ─── Channel scanner (multi-frequency watch on the primary nRSP) ──────────────
const chanScanner = new ChannelScanner(sdrManager);

app.get('/api/chanscan', (req, res) => {
  res.json(chanScanner.status());
});

app.post('/api/chanscan/start', (req, res) => {
  const b = req.body || {};
  let channels = Array.isArray(b.channels) && b.channels.length ? b.channels : null;
  if (!channels) {
    // Default: scan the saved presets
    channels = config.presets.map(p => ({
      freq: p.frequency, mode: p.demodMode, bandwidth: p.bandwidth, label: p.name,
    }));
  }
  try {
    if (bandSweeper.running) bandSweeper.stop();
    const st = chanScanner.start(channels, {
      dwellMs: b.dwellMs, hangMs: b.hangMs,
      threshold: b.threshold !== undefined ? b.threshold
        : (sdrManager.squelchEnabled ? sdrManager.squelchThreshold : -95),
    });
    res.json(st);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/chanscan/stop', (req, res) => {
  chanScanner.stop();
  res.json(chanScanner.status());
});

app.post('/api/chanscan/skip', (req, res) => {
  chanScanner.skip();
  res.json(chanScanner.status());
});

// ─── Band sweeper (one-shot band survey on the primary nRSP) ──────────────────
const bandSweeper = new BandSweeper(sdrManager);

app.get('/api/bandsweep', (req, res) => {
  res.json(bandSweeper.status());
});

app.post('/api/bandsweep/start', (req, res) => {
  try {
    if (chanScanner.running) chanScanner.stop();
    const st = bandSweeper.start(req.body || {});
    res.json(st);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/bandsweep/stop', (req, res) => {
  bandSweeper.stop();
  res.json(bandSweeper.status());
});

// nRSP-ST Native Web UI Proxy info
app.get('/api/nrsp/weburl', (req, res) => {
  res.json({ url: `http://${config.nrsp.host}:${config.nrsp.webPort}` });
});

// Recordings
app.get('/api/recordings', (req, res) => {
  res.json(recorder.list());
});

app.post('/api/recordings/start', (req, res) => {
  const { frequency, bandwidth, duration, label } = req.body;
  const rec = recorder.start({ frequency, bandwidth, duration, label });
  res.json(rec);
});

app.post('/api/recordings/stop', (req, res) => {
  const { id } = req.body;
  const rec = recorder.stop(id);
  res.json(rec || { error: 'Recording not found' });
});

app.delete('/api/recordings/:id', (req, res) => {
  const result = recorder.delete(req.params.id);
  res.json(result);
});

// Decoders toggle
app.post('/api/decoders/:name/toggle', (req, res) => {
  const { name } = req.params;
  if (!config.decoders[name]) return res.status(404).json({ error: 'Unknown decoder' });
  config.decoders[name].enabled = !config.decoders[name].enabled;
  res.json({ decoder: name, enabled: config.decoders[name].enabled });
});

// Scanner trigger
app.post('/api/scan/trigger', (req, res) => {
  if (!scanner) return res.status(400).json({ error: 'Scanner not enabled' });
  scanner.triggerImmediate(req.body.band);
  res.json({ triggered: true });
});

// Spectrum sweep data. Bins rounded to integer dB — full-precision floats
// made this a ~10 KB payload, which crushed the kiosk's poll loop over
// Starlink. Live consumers should prefer ws://:3334/ws/spectrum.
app.get('/api/spectrum/fft', (req, res) => {
  const d = sdrManager.getLastFft();
  if (d.bins) d.bins = d.bins.map(b => Math.round(b));
  res.json(d);
});

// ─── WebSocket Handling ───────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  // Send full state on connect
  ws.send(JSON.stringify({ type: 'state_init', data: {
    aircraft: Object.values(state.aircraft),
    aprsStations: Object.values(state.aprsStations),
    iotDevices: Object.values(state.iotDevices),
    connected: state.connected,
    signalCounts: state.signalCounts
  }, ts: Date.now() }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleWsMessage(ws, msg);
    } catch (e) {
      console.error('[WS] Invalid message:', e.message);
    }
  });

  ws.on('close', () => console.log('[WS] Client disconnected'));
});

function handleWsMessage(ws, msg) {
  switch (msg.type) {
    case 'tune':
      sdrManager.tune(msg.frequency, msg.bandwidth);
      break;
    case 'set_antenna':
      sdrManager.setAntenna(msg.port);
      break;
    case 'set_gain':
      sdrManager.setGain(msg.gainReduction);
      break;
    case 'request_fft':
      ws.send(JSON.stringify({ type: 'fft_data', data: sdrManager.getLastFft(), ts: Date.now() }));
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      break;
  }
}

// ─── Active-frequency detection loop ────────────────────────────────────────────
// Sample the latest FFT a few times a second; the detector ignores duplicate
// frames (by timestamp) so this is cheap. Broadcast the active table on change.
let _lastSignalBroadcast = 0;
setInterval(() => {
  detector.update(sdrManager.getLastFft());
  const now = Date.now();
  if (now - _lastSignalBroadcast >= 2000) {
    _lastSignalBroadcast = now;
    broadcast('signals_active', detector.list());
  }
}, 400);

// ─── Periodic heartbeat ────────────────────────────────────────────────────────
setInterval(() => {
  // Clean stale aircraft (>60s without update)
  const now = Date.now();
  for (const [hex, ac] of Object.entries(state.aircraft)) {
    if (now - ac.lastSeen > 60000) {
      delete state.aircraft[hex];
      broadcast('adsb_remove', { hex });
    }
  }
  broadcast('heartbeat', {
    uptime: Math.floor((now - state.startTime) / 1000),
    aircraftCount: Object.keys(state.aircraft).length,
    aprsCount: Object.keys(state.aprsStations).length,
    iotCount: Object.keys(state.iotDevices).length,
    signalCounts: state.signalCounts,
    connected: state.connected
  });
}, 5000);

// ─── Boot ─────────────────────────────────────────────────────────────────────
// ─── SDR health + inventory (added 2026-06-21) ──────────────────────────────
// Derived health verdict. "IQ File" = SDRconnect virtual fallback (degraded);
// "IQ Lite" is a REAL nRSP streaming format = healthy. Do not conflate them.
function computeHealth() {
  const fft = sdrManager.getLastFft() || {};
  const audio = sdrManager.getAudioStats ? sdrManager.getAudioStats() : {};
  const dev = fft.activeDevice || '';
  const now = Date.now();
  const spectrumFresh = !!fft.timestamp && (now - fft.timestamp < 8000);
  const audioFresh = !!audio.lastAt && (now - audio.lastAt < 8000);
  const isVirtual = /IQ File/i.test(dev);
  let mode;
  if (!state.connected || !fft.connected) mode = 'gateway_down';
  else if (!dev) mode = 'no_device';
  else if (isVirtual) mode = 'iq_fallback';
  else if (!spectrumFresh && !audioFresh) mode = 'stale';
  else mode = 'live';
  return {
    ok: mode === 'live', mode: mode, device: dev,
    frequency: fft.frequency, bandwidth: fft.bandwidth,
    signalSnr: fft.signalSnr, signalPower: fft.signalPower,
    spectrumFresh: spectrumFresh, audioFresh: audioFresh,
    audioBytesPerSec: audio.bytesPerSec || 0,
    lastSpectrumAt: fft.timestamp || 0, audioLastAt: audio.lastAt || 0,
    ts: now
  };
}
app.get('/api/health', (req, res) => res.json(computeHealth()));
app.get('/api/sdr/inventory', (req, res) => {
  let inv = { radios: [], unexpected: [], generatedAt: null, error: null };
  try { inv = JSON.parse(fs.readFileSync('/run/sdr/devices.json', 'utf8')); }
  catch (e) { inv.error = 'inventory not yet generated'; }
  inv.health = computeHealth();
  const age = inv.generatedAt ? (Date.now() - Date.parse(inv.generatedAt)) : null;
  inv.fresh = age != null && age < 120000;
  res.json(inv);
});


const PORT = config.server.port;

server.listen(PORT, config.server.host, () => {
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║    SPECTRA — SDR Intelligence Hub     ║`);
  console.log(`╠═══════════════════════════════════════╣`);
  console.log(`║  API  : http://localhost:${PORT}          ║`);
  console.log(`║  nRSP : ${config.nrsp.host}:${config.nrsp.webPort}       ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);

  // Start all feeds
  sdrManager.connect();
  if (iqBridge) iqBridge.start();
  if (adsbFeed) adsbFeed.start();
  if (aprsFeed) aprsFeed.start();
  if (iotFeed) iotFeed.start();
  if (scanner) scanner.start();
});

process.on('SIGINT', () => {
  console.log('\n[SPECTRA] Shutting down...');
  if (adsbFeed) adsbFeed.stop();
  if (aprsFeed) aprsFeed.stop();
  if (iotFeed) iotFeed.stop();
  if (scanner) scanner.stop();
  if (iqBridge) iqBridge.stop();
  recorder.stopAll();
  process.exit(0);
});
