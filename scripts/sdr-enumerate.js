#!/usr/bin/env node
/* sdr-enumerate — GENERATED INVENTORY producer. Do not edit /run/sdr/devices.json by hand.
 * Merges /home/wispayr/spectra/sdr-manifest.json (expected radios) with live probes
 * (lsusb, SoapySDRUtil, SPECTRA /api/health) into /run/sdr/devices.json. Zero deps.
 * NOTE: "IQ File" = SDRconnect virtual fallback; "IQ Lite" = a REAL nRSP stream = healthy. */
const fs = require('fs');
const cp = require('child_process');

const MANIFEST = '/home/wispayr/spectra/sdr-manifest.json';
const OUTDIR = '/run/sdr';
const OUT = OUTDIR + '/devices.json';
const SPECTRA = 'http://127.0.0.1:3333';

function sh(cmd, timeoutMs) {
  try { return cp.execSync(cmd, { timeout: timeoutMs || 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return ((e && e.stdout) || '').toString(); }
}
function curlJson(url, timeoutMs) {
  const secs = Math.ceil((timeoutMs || 4000) / 1000);
  const out = sh('curl -s --max-time ' + secs + ' ' + url, (timeoutMs || 4000) + 1500);
  try { return JSON.parse(out); } catch (e) { return null; }
}
function ping(addr) {
  if (!addr) return false;
  try { cp.execSync('ping -c1 -W2 ' + addr, { timeout: 4000, stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}

let manifest = { radios: [] };
try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) {}

const lsusb = sh('lsusb', 4000);
const soapy = sh('SoapySDRUtil --find 2>/dev/null', 9000);
const status = curlJson(SPECTRA + '/api/status', 4000) || {};
const health = curlJson(SPECTRA + '/api/health', 4000) || {};
const sdr = status.sdr || {};
const activeDevice = sdr.activeDevice || '';

const soapyDrivers = [];
soapy.split('\n').forEach(function (l) {
  const m = l.match(/driver\s*=\s*([^\s,]+)/i);
  if (m) soapyDrivers.push({ driver: m[1], line: l.trim() });
});

function usbPresent(usbId) {
  if (!usbId) return false;
  return new RegExp(usbId.replace(/:/g, '[:]'), 'i').test(lsusb);
}

const radios = (manifest.radios || []).map(function (r) {
  let present = false, hmode = 'absent', detail = '';
  if (r.transport === 'usb') {
    const bySoapy = r.soapyMatch && soapyDrivers.some(function (d) { return d.driver.toLowerCase() === String(r.soapyMatch).toLowerCase(); });
    present = usbPresent(r.usbId) || !!bySoapy;
    hmode = present ? 'present' : 'absent';
    detail = present ? (r.usbId || r.soapyMatch || '') : 'not plugged in';
  } else if (r.transport === 'network') {
    const viaSpectra = r.healthEndpoint && /:3333\//.test(r.healthEndpoint);
    if (viaSpectra) {
      const dev = activeDevice;
      const isVirtual = /IQ File/i.test(dev);
      if (sdr.connected && dev && !isVirtual) { present = true; hmode = health.mode || 'live'; detail = dev; }
      else if (isVirtual) { present = true; hmode = 'iq_fallback'; detail = dev; }
      else { present = false; hmode = 'down'; detail = dev || 'no device bound'; }
    } else {
      present = ping(r.addr); hmode = present ? 'present' : 'down'; detail = r.addr || '';
    }
  }
  return {
    id: r.id, label: r.label, kind: r.kind, transport: r.transport,
    capabilities: r.capabilities || [], expected: r.expected !== false,
    primary: !!r.primary, present: present, health: hmode, detail: detail
  };
});

const knownDrivers = new Set((manifest.radios || []).map(function (r) { return (r.soapyMatch || '').toLowerCase(); }).filter(Boolean));
const unexpected = soapyDrivers
  .filter(function (d) { return !knownDrivers.has(d.driver.toLowerCase()); })
  .map(function (d) { return { driver: d.driver, line: d.line }; });

const out = {
  generatedAt: new Date().toISOString(),
  site: manifest.site || 'van-halio',
  radios: radios,
  unexpected: unexpected,
  primaryHealth: health.mode || null,
  probes: { lsusb: lsusb.trim().split('\n').filter(Boolean), soapy: soapyDrivers.map(function (d) { return d.line; }) }
};

try { fs.mkdirSync(OUTDIR, { recursive: true }); } catch (e) {}
const tmp = OUT + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
fs.renameSync(tmp, OUT);

const anyUsb = radios.some(function (r) { return r.transport === 'usb' && r.present; }) || soapyDrivers.some(function (d) { return /rtl|airspy|hackrf/i.test(d.driver); });
try {
  if (anyUsb) fs.writeFileSync(OUTDIR + '/has-usb-sdr', '');
  else if (fs.existsSync(OUTDIR + '/has-usb-sdr')) fs.unlinkSync(OUTDIR + '/has-usb-sdr');
} catch (e) {}
console.log('sdr-enumerate: wrote ' + OUT + ' — ' + radios.length + ' radios, ' + unexpected.length + ' unexpected, primary=' + (health.mode || '?'));
