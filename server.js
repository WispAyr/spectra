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

// ─── REST API ─────────────────────────────────────────────────────────────────

// Status
app.get('/api/status', (req, res) => {
  res.json({
    connected: state.connected,
    uptime: Math.floor((Date.now() - state.startTime) / 1000),
    aircraftCount: Object.keys(state.aircraft).length,
    aprsCount: Object.keys(state.aprsStations).length,
    iotDeviceCount: Object.keys(state.iotDevices).length,
    signalCounts: state.signalCounts,
    config: {
      nrsp: { host: config.nrsp.host, webPort: config.nrsp.webPort },
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
  const { host, webPort, antennaPort, gainReduction, frequency, bandwidth } = req.body;
  if (host) config.nrsp.host = host;
  if (webPort) config.nrsp.webPort = webPort;
  if (antennaPort) config.nrsp.antennaPort = antennaPort;
  if (gainReduction !== undefined) config.nrsp.gainReduction = gainReduction;
  if (frequency) config.nrsp.frequency = frequency;
  if (bandwidth) config.nrsp.bandwidth = bandwidth;
  sdrManager.updateConfig(config.nrsp);
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
  res.json({ success: true, config: config.nrsp });
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

// Spectrum sweep data (mock FFT for demo; real data from SoapySDR process)
app.get('/api/spectrum/fft', (req, res) => {
  res.json(sdrManager.getLastFft());
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
  recorder.stopAll();
  process.exit(0);
});
