/**
 * sdr-manager.js — SDRconnect WebSocket client for nRSP-ST
 * Talks to a local SDRconnect_headless process which auto-discovers the nRSP on LAN.
 */

const WebSocket = require("ws");
const { EventEmitter } = require("events");
const { execFile } = require("child_process");

const DEFAULT_BINS = 1024;
const RECONNECT_MS = 5000;
const KEEPALIVE_MS = 15000;
// Half-open detector: if a device is bound and spectrum was flowing but has
// gone silent this long, the WS is presumed wedged (headless never emits
// 'close') -> force a reconnect. Spectrum (0x0003) is continuous and
// signal-independent, so a quiet/squelched channel never trips this.
const CANARY_STALE_MS = 45000;
const CANARY_COOLDOWN_MS = 60000;
// Escalation: spectrum dead this long ACROSS reconnects means headless itself is
// wedged (SIGSTOP class) — a client reconnect can't fix it, so restart headless
// in-app rather than wait ~2-4min for the systemd nrsp-watchdog.
const ESCALATE_STALE_MS = 90000;
const ESCALATE_COOLDOWN_MS = 180000;

class SdrManager extends EventEmitter {
  constructor(config, onStatus) {
    super();
    this.config = { wsPort: 9100, ...config };
    // SDRconnect_headless always runs locally on this host and re-serves the
    // networked nRSP-ST on :wsPort. config.nrsp.host (settable from the nRSP
    // settings page) refers to the *device admin* only — the WS gateway is
    // local. Pin the WS host to loopback so a stray value from the UI can't
    // break the SDR feed. Env override for the rare remote-headless case.
    this.config.host = process.env.NRSP_WS_HOST || "127.0.0.1";
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
    // Per-connection liveness canary (see CANARY_* consts)
    this._spectrumSeenThisConn = false;
    this._lastCanaryTerminate = 0;
    // Escalation state — independent of WS lifecycle so it still fires when the
    // WS can't even re-open (headless frozen).
    this._everSawSpectrum = false;
    this._lastEscalate = 0;
    this._escalating = false;
    this._escalateTimer = setInterval(() => this._escalateCheck(), 5000);
    // Demod + squelch state (mirrors SDRconnect properties; see
    // docs/SDRCONNECT_BRIDGE.md for the property vocabulary)
    this.demodMode = this.config.demodMode || null;
    this.squelchEnabled = false;
    this.squelchThreshold = -120;
    this.signalPowerAt = 0;
    // Radio facilities (probed 2026-06-10): lna_state 0 = MAX gain (SDRplay
    // convention), range lna_state_min..max (0..26 on the nRSP-ST)
    this.lnaState = null;
    this.lnaMin = 0;
    this.lnaMax = 26;
    this.agcEnabled = null;
    this.antennas = [];
    this.activeAntenna = null;
    this.wfmStereo = null;
    this.nfmDeemphasis = null;
    this.audioMuted = null;
    this.audioFilter = null;
    this.rdsEnabled = null;
    this.rds = { pi: null, pty: null, radiotext: null };
    this.vfoFrequency = null;
    // Ring buffer of recent text messages from SDRconnect — protocol
    // discovery/debug surface, exposed via /api/nrsp/responses
    this.lastMessages = [];
    this.deviceVariant = this.config.deviceVariant || null;
    this.validDevices = [];
    this.iqWanted = false;
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
      // Tower-audio bandwidth gate (15 Oct 2026): after every (re)connect the device sits on its 192 kHz default until
      // our filter_bandwidth is confirmed. Hold demodulated audio until the device REPORTS the configured width, so the
      // wide window (adjacent fire channel etc.) never reaches listeners. Fails open after 20 s so audio is never lost.
      this._bwConfirmed = false; this._bwGateSince = Date.now(); this._bwGateDropped = 0;
      console.log("[SDR] SDRconnect WS open — initialising device");
      this.connected = true;
      this._spectrumSeenThisConn = false;
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

    this.ws.on("close", (code, reason) => {
      const reasonStr = reason ? reason.toString() : '';
      console.log(`[SDR] WS closed: code=${code} reason=${JSON.stringify(reasonStr)}`);
      const wasConnected = this.connected;
      this.connected = false;
      this._serialSelected = false;
      this._appliedDemod = false;
      this._appliedSquelch = false;
      this._appliedVolume = false;
      this._appliedAntenna = false;
      if (this._discoveryTimer) { clearInterval(this._discoveryTimer); this._discoveryTimer = null; }
      if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
      this.onStatus({ connected: false, error: `closed:${code}`, demoMode: !wasConnected });
      this._scheduleReconnect();
    });
  }

  _initDevice() {
    // ⚠ Send ONLY discovery queries here. SDRconnect_headless SEGVs (~5s
    // after start, systemd crash loop) if it receives stream-enables or
    // set_property while the device is still being discovered
    // ("Refreshing..." state) — verified 2026-06-10. Stream enables + tune
    // wait for a real serial in active_device → _onDeviceReady().
    this._send({ event_type: "get_property", property: "valid_devices", device: "primary" });
    this._send({ event_type: "get_property", property: "active_device", device: "primary" });
    // Poll discovery faster than the 15s keepalive until the device appears.
    if (this._discoveryTimer) clearInterval(this._discoveryTimer);
    this._discoveryTimer = setInterval(() => {
      if (this._serialSelected) { clearInterval(this._discoveryTimer); this._discoveryTimer = null; return; }
      this._send({ event_type: "get_property", property: "active_device", device: "primary" });
    }, 4000);
  }

  // Device discovered (active_device reported a serial): enable the primary
  // slot + streams, tune, then reconcile demod/squelch/volume state.
  _onDeviceReady() {
    this._send({ event_type: "set_primary_device_enable", value: "true", device: "primary" });
    this._send({ event_type: "device_stream_enable", value: "true", device: "primary" });
    this._sendTune();
    this._send({ event_type: "spectrum_enable", value: "true", device: "primary" });
    // Audio stream gates the demodulator chain which produces signal_power /
    // signal_snr property events. Audio binary frames (0x0001) feed the
    // audio-ws-bridge.
    this._send({ event_type: "audio_stream_enable", value: "true", device: "primary" });
    if (this.config.iqStream || this.iqWanted) {
      this._send({ event_type: "iq_stream_enable", value: "true", device: "primary" });
    }
    setTimeout(() => this._syncDemodState(), 2000);
  }

  // Called ~2s after the device serial is selected: query demod/squelch/
  // volume, then (via the responses in _handleText) apply persisted config
  // at most once per connection.
  _syncDemodState() {
    for (const p of [
      "demodulator", "squelch_enable", "squelch_threshold", "audio_volume_percent",
      "lna_state", "lna_state_min", "lna_state_max", "agc_enable",
      "valid_antennas", "active_antenna",
      "wfm_stereo_enable", "nfm_deemphasis_enable", "audio_mute", "audio_filter",
      "rds_enable", "device_vfo_frequency",
    ]) {
      this._send({ event_type: "get_property", property: p, device: "primary" });
    }
    // RE-ASSERT the filter bandwidth on every reconnect.
    //
    // SDRconnect comes back from a reconnect on its DEVICE DEFAULTS, which for
    // this radio is a wide filter. filter_bandwidth was never in the query list
    // above and there is no incoming case for it either, so the mirror could
    // not even notice the divergence: /api/status kept reporting the configured
    // 12500 while the device was actually demodulating wide. The audible result
    // is a tower feed that "sounds like wide/narrow is set wrong" while every
    // status surface says it is fine.
    //
    // Sent unconditionally rather than compared, because we have no readback to
    // compare against — the device never reports this property.
    // ORDER MATTERS: demodulator FIRST, filter second.
    //
    // Selecting a demodulator resets the filter to that mode's default width,
    // so sending the filter first (as this did originally) gets it clobbered a
    // line later. Measured evidence: with the wrong order the recorded audio
    // carried as much energy above 4 kHz as in the 300-3400 Hz voice band
    // (0.7 dB apart), against ~14 dB apart when the demod is genuinely narrow.
    // That is what "sounds like wide/narrow is set wrong" is.
    //
    // The filter is sent on a short delay so the mode change has landed.
    if (this.config.demodMode) {
      this._send({
        event_type: "set_property", property: "demodulator",
        value: String(this.config.demodMode), device: "primary",
      });
    }
    // Re-assert the SQUELCH unconditionally too, and AFTER the demodulator —
    // selecting a demod resets mode-scoped defaults. Previously squelch was
    // only QUERIED here and only corrected if the device happened to report a
    // different value, which left the receiver ungated for the whole window
    // between audio_stream_enable and the readback arriving. Measured effect:
    // bursts of full-scale flat noise ~23 dB LOUDER than speech, clipping the
    // rail and burying the voice. That is the real "sounds wide" fault.
    // AGC winds gain up on a dead channel until the amplified NOISE crosses
    // the device's own squelch threshold, so the gate opens on hiss and the
    // feed streams full-scale noise while signal_power still reads -119 dBm.
    // Measured 2026-09-02: AGC on = 18% non-silent at -7.4 dBFS pinned to the
    // rail; AGC off = 0% non-silent, properly gated. This is what made the
    // Broadnet relay unreadable — it faithfully relayed the noise.
    // The tower relay is a strong local signal (-82 dBm against a -119 floor,
    // 37 dB), so fixed max gain has ample margin without AGC.
    if (this.config.agcEnable === false) {
      this._send({ event_type: "set_property", property: "agc_enable", value: "false", device: "primary" });
    }
    if (this.config.audioLimiters === false) {
      this._send({ event_type: "set_property", property: "audio_limiters", value: "false", device: "primary" });
    }
    if (this.config.squelch && this.config.squelch.level > -120) {
      this._send({ event_type: "set_property", property: "squelch_enable", value: "true", device: "primary" });
      this._send({ event_type: "set_property", property: "squelch_threshold", value: String(this.config.squelch.level), device: "primary" });
    }
    if (this.config.bandwidth) {
      setTimeout(() => {
        this._send({
          event_type: "set_property", property: "filter_bandwidth",
          value: String(this.config.bandwidth), device: "primary",
        });
      }, 600);
      setTimeout(() => this._send({ event_type: "get_property", property: "filter_bandwidth", device: "primary" }), 1200);
      setTimeout(() => this._send({ event_type: "get_property", property: "filter_bandwidth", device: "primary" }), 3000);
    }
  }

  _armKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      this._send({ event_type: "get_property", property: "active_device", device: "primary" });
      // Ask the DEVICE what width it is on, every 15 s. Asserting once after a
      // reconnect is not enough: it sits on its 192 kHz default until corrected,
      // and /api/status only ever echoed our intended value, so drift was invisible.
      this._send({ event_type: "get_property", property: "filter_bandwidth", device: "primary" });
      this._send({ event_type: "get_property", property: "squelch_enable", device: "primary" });
      this._canaryCheck();
    }, KEEPALIVE_MS);
  }

  // Half-open watchdog. Only acts once a real device is bound (_serialSelected
  // — never true on the IQ-File fallback) and spectrum has actually flowed on
  // THIS connection. If spectrum then stalls past CANARY_STALE_MS the socket to
  // headless is wedged without emitting 'close', so force it: ws.terminate() ->
  // 'close' -> _scheduleReconnect(). Cooldown-guarded so it can't thrash the
  // SEGV-prone device re-lock; the systemd nrsp-watchdog stays the backstop for
  // a headless-wedged SDR (which a client reconnect can't fix).
  _canaryCheck() {
    if (!this._serialSelected) return;
    if (!this._spectrumSeenThisConn) return;
    const now = Date.now();
    if (now - this.lastSpectrumAt < CANARY_STALE_MS) return;
    if (now - (this._lastCanaryTerminate || 0) < CANARY_COOLDOWN_MS) return;
    this._lastCanaryTerminate = now;
    const stale = Math.round((now - this.lastSpectrumAt) / 1000);
    console.warn(`[SDR] Canary: spectrum stale ${stale}s while device bound — forcing WS reconnect`);
    try { this.ws.terminate(); } catch (e) { /* close handler will reconnect */ }
  }

  // Headless-wedge escalation. Independent of the keepalive (which needs an
  // open WS): fires even when the WS can't re-open. If spectrum has been dead
  // > ESCALATE_STALE_MS across reconnects (and a real device existed), restart
  // sdrconnect-headless once (cooldown-guarded). nrsp-watchdog stays the slow
  // backstop (IQ-file cold-boot + audio-only wedge the spectrum canary can't see).
  _escalateCheck() {
    if (!this._everSawSpectrum || this._escalating) return;
    // 2026-10-17 (Ewan OK): nrsp-watchdog.timer is the single sdrconnect restarter. Remove this flag file to re-enable.
    try { if (require("fs").existsSync("/etc/spectra/no-headless-escalation")) return; } catch (_) {}
    const now = Date.now();
    if (now - this.lastSpectrumAt < ESCALATE_STALE_MS) return;
    if (now - (this._lastEscalate || 0) < ESCALATE_COOLDOWN_MS) return;
    this._lastEscalate = now;
    this._escalating = true;
    const stale = Math.round((now - this.lastSpectrumAt) / 1000);
    console.warn(`[SDR] Escalation: spectrum dead ${stale}s across reconnects — restarting sdrconnect-headless`);
    execFile("sudo", ["-n", "systemctl", "restart", "sdrconnect-headless"], { timeout: 30000 }, (err) => {
      this._escalating = false;
      if (err) console.warn(`[SDR] headless restart failed: ${err.message}`);
      else console.log("[SDR] sdrconnect-headless restarted by escalation");
    });
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

  _ppm() { const v = Number(this.config.ppmCorrection); return Number.isFinite(v) ? v : 0; }
  _hwFreq(nominal) { return Math.round(nominal * (1 - this._ppm() * 1e-6)); }
  _nominalFreq(hw) { return Math.round(hw * (1 + this._ppm() * 1e-6)); }

  _sendTune() {
    if (this.config.frequency) {
      // Receiver PPM correction (2026-10-12): SDRconnect headless exposes no
      // ppm property over the websocket, so we pre-compensate the commanded
      // centre. config.nrsp.ppmCorrection > 0 means the nRSP TCXO runs fast
      // (signals read LOW). +1.40 ppm measured from the 455.625 tower carrier
      // (-637 Hz). Everything downstream keeps using the NOMINAL frequency.
      const _hw = this._hwFreq(this.config.frequency);
      this._send({ event_type: "set_property", property: "device_center_frequency", value: String(_hw), device: "primary" });
      this._send({ event_type: "set_property", property: "device_vfo_frequency", value: String(_hw), device: "primary" });
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
    this.lastMessages.push({ at: Date.now(), ...msg });
    if (this.lastMessages.length > 120) this.lastMessages.shift();
    if (ev === "property_changed" || ev === "get_property_response") {
      switch (prop) {
        case "active_device":
          this.activeDevice = val;
          if (val && !this._serialSelected) {
            const m = val.match(/\((\d+)\)/);
            if (m) {
              this._serialSelected = true;
              let _selName = null;
              if (this.deviceVariant) {
                _selName = (this.validDevices || []).find(d => d.includes("(" + m[1] + ")") && d.includes("(" + this.deviceVariant + ")"))
                  || val.replace(/\s*\([^()]*\)\s*$/, " (" + this.deviceVariant + ")");
              }
              if (_selName) {
                console.log("[SDR] Selecting device variant -> " + _selName);
                this._send({ event_type: "selected_device_name", value: _selName, device: "primary" });
              } else {
                this._send({ event_type: "selected_device_serial", value: m[1], device: "primary" });
              }
              setTimeout(() => this._onDeviceReady(), 1000);
            }
          }
          break;
        case "squelch_enable": {
          // SELF-HEAL squelch gate. An ungated receiver passes full-scale noise.
          this.squelchEnabled = String(val) === "true";
          const _wantOn = !!(this.config.squelch && this.config.squelch.level > -120);
          if (_wantOn && !this.squelchEnabled) {
            console.log("[SDR] squelch_enable drifted false -> re-asserting true");
            this._send({ event_type: "set_property", property: "squelch_enable", value: "true", device: "primary" });
            this._send({ event_type: "set_property", property: "squelch_threshold", value: String(this.config.squelch.level), device: "primary" });
          }
          break;
        }
        case "filter_bandwidth": {
          // SELF-HEAL filter_bandwidth. The device reports 192000 after any
          // SDRconnect restart - 192 kHz on a 12.5 kHz channel - which is the
          // "sounds wide" fault. There is no high-cut property on this build, so
          // this is the only width lever.
          const _bw = parseFloat(val);
          this.filterBandwidth = Number.isFinite(_bw) ? _bw : null;
          const _want = this.config.bandwidth;
          if (_want && Number.isFinite(_bw)) {
            const _ok = Math.abs(_bw - _want) <= 1;
            if (_ok && this._bwConfirmed === false) console.log("[SDR] filter_bandwidth confirmed " + _bw + " - audio released (held " + (Date.now() - this._bwGateSince) + " ms, dropped " + (this._bwGateDropped || 0) + " frames)");
            this._bwConfirmed = _ok;
          }
          if (_want && Number.isFinite(_bw) && Math.abs(_bw - _want) > 1) {
            console.log("[SDR] filter_bandwidth drifted " + _bw + " -> re-asserting " + _want);
            this._send({ event_type: "set_property", property: "filter_bandwidth", value: String(_want), device: "primary" });
          }
          break;
        }
        case "demodulator":
          this.demodMode = String(val);
          if (this.config.demodMode && !this._appliedDemod && this.config.demodMode !== this.demodMode) {
            this._appliedDemod = true;
            this.setDemod(this.config.demodMode);
          }
          break;
        case "squelch_enable":
          this.squelchEnabled = String(val) === "true";
          break;
        case "squelch_threshold":
          this.squelchThreshold = parseFloat(val);
          if (this.config.squelch && this.config.squelch.level > -120 && !this._appliedSquelch
              && (this.config.squelch.level !== this.squelchThreshold || !this.squelchEnabled)) {
            this._appliedSquelch = true;
            this.setSquelch(true, this.config.squelch.level);
          }
          break;
        case "audio_volume_percent":
          // Full-scale demod PCM for the audio bridge (browser slider
          // attenuates); the device default of 25% is far too quiet.
          // AUDIO VOLUME — do not slam to 100.
            // This used to force 100% on every reconnect, which drove the demodulated
            // audio into the digital rail: measured non-silent RMS -7.5 dBFS with
            // p99.9 at -0.2 dB and up to 1.5% hard clipping, on a signal with 40 dB of
            // SNR. Clipped speech reads as flat broadband noise and sounds like
            // unreadable static once relayed. At 20% the same traffic measures
            // -27.9 dBFS with 0.000% clipping.
            // _appliedVolume resets on socket close, so the old code re-clipped the
            // audio every reconnect (~11 min) - which is why this kept "reverting".
            const _wantVol = Number.isFinite(this.config.audioVolumePercent)
              ? this.config.audioVolumePercent : 20;
            if (parseInt(val, 10) !== _wantVol) {
              this._appliedVolume = true;
              console.log("[SDR] audio_volume_percent " + val + " -> re-asserting " + _wantVol);
              this._send({ event_type: "set_property", property: "audio_volume_percent", value: String(_wantVol), device: "primary" });
            }
          break;
        case "signal_power": this.signalPower = parseFloat(val); this.signalPowerAt = Date.now(); break;
        case "lna_state": this.lnaState = parseInt(val, 10); break;
        case "lna_state_min": this.lnaMin = parseInt(val, 10); break;
        case "lna_state_max": this.lnaMax = parseInt(val, 10); break;
        case "agc_enable": this.agcEnabled = String(val) === "true"; break;
        case "valid_antennas": this.antennas = String(val).split(",").map(s => s.trim()).filter(Boolean); break;
        case "active_antenna":
          this.activeAntenna = String(val);
          // Headless restarts silently revert to "Antenna A" — re-apply the
          // configured port once per connection (verified 2026-06-10: the van
          // antenna lives on Antenna B; A is unterminated → flat spectrum).
          if (this.config.antennaPort && !this._appliedAntenna
              && this.config.antennaPort.startsWith("Antenna")
              && this.activeAntenna !== this.config.antennaPort) {
            this._appliedAntenna = true;
            this.setAntenna(this.config.antennaPort);
          }
          break;
        case "wfm_stereo_enable": this.wfmStereo = String(val) === "true"; break;
        case "nfm_deemphasis_enable": this.nfmDeemphasis = String(val) === "true"; break;
        case "audio_mute": this.audioMuted = String(val) === "true"; break;
        case "audio_filter": this.audioFilter = String(val) === "true"; break;
        case "rds_enable": this.rdsEnabled = String(val) === "true"; break;
        case "rds_pi": this.rds.pi = String(val); break;
        case "rds_pty": this.rds.pty = String(val); break;
        case "rds_radiotext": this.rds.radiotext = String(val); break;
        case "device_vfo_frequency": this.vfoFrequency = parseInt(val, 10); break;
        case "signal_snr": this.signalSnr = parseFloat(val); break;
        case "device_center_frequency": {
          const _raw = parseInt(val, 10);
          let _nf = _raw ? this._nominalFreq(_raw) : this.config.frequency;
          if (Math.abs(_nf - this.config.frequency) <= 2) _nf = this.config.frequency;
          this.hwCenterFrequency = _raw || null;
          if (_nf !== this.config.frequency) { this.config.frequency = _nf; this.emit("retune", _nf); }
          break;
        }
        case "device_sample_rate": this.config.sampleRate = parseInt(val, 10) || this.config.sampleRate; break;
        case "valid_devices":
          this.validDevices = String(val).split(",").map(x => x.trim()).filter(Boolean);
          break;
        default:
          // PROPLOG (temporary): learn the real SDRconnect property vocabulary.
          // Unknown properties were being discarded silently, which is why the
          // demod width could not be diagnosed from any status surface.
          if (!this._propSeen) this._propSeen = new Set();
          if (!this._propSeen.has(prop)) {
            this._propSeen.add(prop);
            console.log("[SDR][PROPLOG] " + prop + " = " + String(val).slice(0, 120));
          }
          break;
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
      this._spectrumSeenThisConn = true;
      this._everSawSpectrum = true;
    } else if (type === 0x0002) {
      // IQ chunk: 2-byte type header followed by interleaved s16-LE I/Q samples.
      // Emit the raw payload buffer so downstream bridges (iq-tcp-server)
      // can repackage as rtl_tcp or feed an in-process decoder.
      const payload = buf.subarray(2);
      this.emit("iq", payload);
      this.emit("iq_chunk", { bytes: payload.length });
    } else if (type === 0x0001) {
      // Demodulated audio frame. Emit the raw payload so a WS bridge can relay
      // it to the browser for "click to listen". Keep rolling byte stats so the
      // wire format (rate / sample size) can be characterised.
      if (this.config.bandwidth && this._bwConfirmed === false) {
        if (Date.now() - (this._bwGateSince || 0) < 20000) { this._bwGateDropped = (this._bwGateDropped || 0) + 1; return; }
        console.log("[SDR] filter_bandwidth not confirmed after 20 s - releasing audio anyway (fail open)");
        this._bwConfirmed = null;
      }
      const payload = buf.subarray(2);
      this._audioBytes = (this._audioBytes || 0) + payload.length;
      this._audioFrames = (this._audioFrames || 0) + 1;
      this._audioLastAt = Date.now();
      if (!this._audioFirstAt) this._audioFirstAt = this._audioLastAt;
      this.emit("audio", payload);
    } else if (type === 0x0004) {
      // Secondary-VRX demodulated audio (second simultaneous channel)
      const payload = buf.subarray(2);
      this._audio2Bytes = (this._audio2Bytes || 0) + payload.length;
      this._audio2Frames = (this._audio2Frames || 0) + 1;
      this._audio2LastAt = Date.now();
      this.emit("audio2", payload);
    }
  }

  getAudio2Stats() {
    return {
      frames: this._audio2Frames || 0,
      bytes: this._audio2Bytes || 0,
      lastAt: this._audio2LastAt || 0,
    };
  }

  getAudioStats() {
    const dt = (this._audioLastAt && this._audioFirstAt)
      ? (this._audioLastAt - this._audioFirstAt) / 1000 : 0;
    return {
      frames: this._audioFrames || 0,
      bytes: this._audioBytes || 0,
      seconds: +dt.toFixed(2),
      bytesPerSec: dt > 0 ? Math.round((this._audioBytes || 0) / dt) : 0,
      lastAt: this._audioLastAt || 0
    };
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
    // Re-pin the WS gateway to loopback — the nRSP settings page may push a
    // device IP here, but the headless gateway is always local.
    this.config.host = process.env.NRSP_WS_HOST || "127.0.0.1";
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendTune();
    }
  }

  // Squelch gate state, computed locally from the 1 Hz signal_power feed so
  // the UI tracks it even if SDRconnect never reports a gate property.
  squelchOpen() {
    if (!this.squelchEnabled || this.squelchThreshold <= -120) return true;
    if (this.signalPower == null) return true;
    return this.signalPower >= this.squelchThreshold;
  }

  setDemod(mode) {
    this.config.demodMode = mode;
    this.demodMode = mode;
    this._send({ event_type: "set_property", property: "demodulator", value: String(mode), device: "primary" });
    this._send({ event_type: "get_property", property: "demodulator", device: "primary" });
  }

  setSquelch(enabled, threshold) {
    this.squelchEnabled = !!enabled;
    if (threshold !== undefined && threshold !== null) this.squelchThreshold = threshold;
    this._send({ event_type: "set_property", property: "squelch_enable", value: this.squelchEnabled ? "true" : "false", device: "primary" });
    if (this.squelchEnabled) {
      this._send({ event_type: "set_property", property: "squelch_threshold", value: String(this.squelchThreshold), device: "primary" });
    }
  }

  sendRaw(obj) {
    this._send(obj);
  }

  // Toggle the Full-IQ stream on demand (used to gate the 2nd-channel demod).
  setIqStream(on) {
    this.iqWanted = !!on;
    this._send({ event_type: "iq_stream_enable", value: on ? "true" : "false", device: "primary" });
  }

  setLna(state) {
    const s = Math.max(this.lnaMin, Math.min(this.lnaMax, parseInt(state, 10) || 0));
    this.lnaState = s;
    this._send({ event_type: "set_property", property: "lna_state", value: String(s), device: "primary" });
  }

  setAgc(enabled) {
    this.agcEnabled = !!enabled;
    this._send({ event_type: "set_property", property: "agc_enable", value: enabled ? "true" : "false", device: "primary" });
  }

  setVfo(freqHz) {
    this.vfoFrequency = freqHz;
    this._send({ event_type: "set_property", property: "device_vfo_frequency", value: String(freqHz), device: "primary" });
  }

  // Whitelisted boolean/number audio + RDS options
  static OPTION_PROPS = {
    wfmStereo: "wfm_stereo_enable",
    nfmDeemphasis: "nfm_deemphasis_enable",
    audioMute: "audio_mute",
    audioFilter: "audio_filter",
    rdsEnable: "rds_enable",
  };

  setOption(key, value) {
    const prop = SdrManager.OPTION_PROPS[key];
    if (!prop) return false;
    this._send({ event_type: "set_property", property: prop, value: value ? "true" : "false", device: "primary" });
    this._send({ event_type: "get_property", property: prop, device: "primary" });
    return true;
  }

  getRadioState() {
    return {
      connected: this.connected,
      activeDevice: this.activeDevice,
      frequency: this.config.frequency,
      vfoFrequency: this.vfoFrequency,
      bandwidth: this.config.bandwidth,
      // What the DEVICE says, not what we asked for. These disagreeing is
      // exactly the fault that hid for hours behind /api/status.
      deviceBandwidth: this.filterBandwidth ?? null,
      deviceSquelchEnabled: this.squelchEnabled ?? null,
      demodMode: this.demodMode,
      signalPower: this.signalPower,
      signalSnr: this.signalSnr,
      squelchLevel: this.squelchEnabled ? this.squelchThreshold : -120,
      squelchOpen: this.squelchOpen(),
      lnaState: this.lnaState,
      lnaMin: this.lnaMin,
      lnaMax: this.lnaMax,
      agcEnabled: this.agcEnabled,
      antennas: this.antennas,
      antenna: this.activeAntenna,
      wfmStereo: this.wfmStereo,
      nfmDeemphasis: this.nfmDeemphasis,
      audioMute: this.audioMuted,
      audioFilter: this.audioFilter,
      rdsEnable: this.rdsEnabled,
      rds: this.rds,
    };
  }

  getLastFft() {
    const ts = this.lastSpectrumAt || Date.now();
    return {
      frequency: this.config.frequency,
      bandwidth: this.config.bandwidth,
      // The spectrum bins cover the full device sample rate, NOT the demod
      // filter bandwidth (verified 2026-06-10 by tracking FM stations across
      // two different centre tunes).
      spanHz: this.config.sampleRate || 2e6,
      bins: this.bins,
      timestamp: ts,
      ts,
      connected: this.connected,
      activeDevice: this.activeDevice,
      signalPower: this.signalPower,
      signalSnr: this.signalSnr,
      demodMode: this.demodMode,
      antenna: this.activeAntenna || this.config.antennaPort,
      squelchLevel: this.squelchEnabled ? this.squelchThreshold : -120,
      squelchOpen: this.squelchOpen(),
      lnaState: this.lnaState,
      lnaMin: this.lnaMin,
      lnaMax: this.lnaMax,
      agcEnabled: this.agcEnabled,
      wfmStereo: this.wfmStereo,
      nfmDeemphasis: this.nfmDeemphasis,
      audioMute: this.audioMuted,
      rds: (this.rds.pty || this.rds.radiotext) ? this.rds : null
    };
  }

  disconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this._escalateTimer) { clearInterval(this._escalateTimer); this._escalateTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.connected = false;
  }
}

module.exports = SdrManager;
