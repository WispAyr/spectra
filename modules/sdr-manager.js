/**
 * sdr-manager.js — SDRconnect WebSocket client for nRSP-ST
 * Talks to a local SDRconnect_headless process which auto-discovers the nRSP on LAN.
 */

const WebSocket = require("ws");
const { EventEmitter } = require("events");

const DEFAULT_BINS = 1024;
const RECONNECT_MS = 5000;
const KEEPALIVE_MS = 15000;

class SdrManager extends EventEmitter {
  constructor(config, onStatus) {
    super();
    this.config = { wsPort: 9100, ...config };
    if (this.config.host === "10.42.42.42" || !this.config.host) {
      this.config.host = "127.0.0.1";
    }
    this.onStatus = onStatus;
    this.connected = false;
    this.ws = null;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.activeDevice = null;
    this.bins = new Array(DEFAULT_BINS).fill(-100);
    this.signalPower = null;
    this.signalSnr = null;
    this.lastSpectrumAt = 0;
  }

  connect() {
    this._open();
  }

  _open() {
    const url = `ws://${this.config.host}:${this.config.wsPort}/`;
    console.log(`[SDR] Connecting to SDRconnect at ${url}`);
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.warn(`[SDR] WebSocket construct failed: ${e.message}`);
      return this._scheduleReconnect();
    }

    this.ws.on("open", () => {
      console.log("[SDR] SDRconnect WS open — initialising device");
      this.connected = true;
      this.onStatus({ connected: true, host: this.config.host, transport: "sdrconnect-ws" });
      this.emit("connected");
      this._initDevice();
      this._armKeepalive();
    });

    this.ws.on("message", (data, isBinary) => {
      if (isBinary) this._handleBinary(data);
      else this._handleText(data);
    });

    this.ws.on("error", (err) => {
      console.warn(`[SDR] WS error: ${err.message}`);
    });

    this.ws.on("close", (code) => {
      const wasConnected = this.connected;
      this.connected = false;
      if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
      this.onStatus({ connected: false, error: `closed:${code}`, demoMode: !wasConnected });
      this._scheduleReconnect();
    });
  }

  _initDevice() {
    // Make sure primary slot is enabled and streaming, then tune + enable spectrum.
    this._send({ event_type: "get_property", property: "valid_devices", device: "primary" });
    this._send({ event_type: "get_property", property: "active_device", device: "primary" });
    this._send({ event_type: "set_primary_device_enable", value: "true", device: "primary" });
    this._send({ event_type: "device_stream_enable", value: "true", device: "primary" });
    this._sendTune();
    this._send({ event_type: "spectrum_enable", value: "true", device: "primary" });
    if (this.config.iqStream) {
      this._send({ event_type: "iq_stream_enable", value: "true", device: "primary" });
    }
  }

  _armKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      this._send({ event_type: "get_property", property: "active_device", device: "primary" });
    }, KEEPALIVE_MS);
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, RECONNECT_MS);
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }

  _sendTune() {
    if (this.config.frequency) {
      this._send({ event_type: "set_property", property: "device_center_frequency", value: String(this.config.frequency), device: "primary" });
    }
    if (this.config.sampleRate) {
      this._send({ event_type: "set_property", property: "device_sample_rate", value: String(this.config.sampleRate), device: "primary" });
    }
    if (this.config.bandwidth) {
      this._send({ event_type: "set_property", property: "filter_bandwidth", value: String(this.config.bandwidth), device: "primary" });
    }
  }

  _handleText(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const ev = msg.event_type;
    const prop = msg.property;
    const val = msg.value;
    if (ev === "property_changed" || ev === "get_property_response") {
      switch (prop) {
        case "active_device": this.activeDevice = val; break;
        case "signal_power": this.signalPower = parseFloat(val); break;
        case "signal_snr": this.signalSnr = parseFloat(val); break;
        case "device_center_frequency": this.config.frequency = parseInt(val, 10) || this.config.frequency; break;
        case "device_sample_rate": this.config.sampleRate = parseInt(val, 10) || this.config.sampleRate; break;
        default: break;
      }
    }
  }

  _handleBinary(buf) {
    if (buf.length < 2) return;
    const type = buf.readUInt16LE(0);
    if (type === 0x0003) {
      // Spectrum: uint8 bytes after 2-byte header. Map 0..255 -> -120..0 dBm.
      const n = buf.length - 2;
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        out[i] = (buf[i + 2] / 255) * 120 - 120;
      }
      this.bins = out;
      this.lastSpectrumAt = Date.now();
    } else if (type === 0x0002) {
      this.emit("iq_chunk", { bytes: buf.length - 2 });
    }
  }

  // ─── Public API (preserved from old rsp_tcp client) ─────────────────────

  tune(frequency, bandwidth) {
    this.config.frequency = frequency;
    if (bandwidth) this.config.bandwidth = bandwidth;
    console.log(`[SDR] Tuning to ${(frequency / 1e6).toFixed(3)} MHz`);
    this._sendTune();
  }

  setAntenna(port) {
    this.config.antennaPort = port;
    this._send({ event_type: "set_property", property: "active_antenna", value: String(port), device: "primary" });
    console.log(`[SDR] Antenna port: ${port}`);
  }

  setGain(gainReduction) {
    this.config.gainReduction = gainReduction;
    // SDRconnect uses lna_state (0=lowest gain, higher=more attenuation depending on band).
    // Map 0..40 dB reduction roughly to lna_state 0..9. Caller can override via lnaState in config.
    const lna = this.config.lnaState != null
      ? this.config.lnaState
      : Math.max(0, Math.min(9, Math.round(gainReduction / 4)));
    this._send({ event_type: "set_property", property: "lna_state", value: String(lna), device: "primary" });
    console.log(`[SDR] Gain reduction: ${gainReduction} dB -> lna_state=${lna}`);
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendTune();
    }
  }

  getLastFft() {
    return {
      frequency: this.config.frequency,
      bandwidth: this.config.bandwidth,
      bins: this.bins,
      timestamp: this.lastSpectrumAt || Date.now(),
      connected: this.connected,
      activeDevice: this.activeDevice,
      signalPower: this.signalPower,
      signalSnr: this.signalSnr
    };
  }

  disconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.connected = false;
  }
}

module.exports = SdrManager;
