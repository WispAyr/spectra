/* adsb-map.js — Leaflet ADS-B aircraft map */

const AdsbMap = (() => {
  let map = null;
  let markers = {};
  let trails = {};
  let initialized = false;
  let showTrails = true;
  let showLabels = true;

  function init() {
    if (initialized) {
      if (map) setTimeout(() => map.invalidateSize(), 100);
      return;
    }
    initialized = true;

    map = L.map('adsb-map', {
      center: [51.5, -1.5],
      zoom: 7,
      zoomControl: true,
      attributionControl: false
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 19
    }).addTo(map);

    // Controls
    document.getElementById('adsb-trails')?.addEventListener('change', e => {
      showTrails = e.target.checked;
      if (!showTrails) Object.values(trails).forEach(t => t && map.removeLayer(t));
    });
    document.getElementById('adsb-labels')?.addEventListener('change', e => {
      showLabels = e.target.checked;
    });

    // Load existing aircraft
    if (window.App && App.state) {
      Object.values(App.state.aircraft).forEach(update);
    }
  }

  function update(ac) {
    if (!map || !ac.lat || !ac.lon) return;

    const hex = ac.hex;
    const latlng = [ac.lat, ac.lon];
    const angle = ac.track || 0;

    // Trail
    if (!trails[hex]) trails[hex] = [];
    trails[hex].push(latlng);
    if (trails[hex].length > 40) trails[hex].shift();

    if (showTrails && trails[hex].length > 1) {
      if (markers[hex + '_trail']) map.removeLayer(markers[hex + '_trail']);
      markers[hex + '_trail'] = L.polyline(trails[hex], {
        color: altitudeColor(ac.altitude),
        weight: 1.5, opacity: 0.5
      }).addTo(map);
    }

    // Aircraft icon
    const icon = L.divIcon({
      className: '',
      html: `<div style="transform:rotate(${angle}deg);font-size:16px;filter:drop-shadow(0 0 3px rgba(0,212,255,0.8))">✈</div>
             ${showLabels ? `<div style="font-size:9px;color:#00d4ff;font-family:monospace;margin-top:2px;white-space:nowrap">${ac.callsign || hex}</div>` : ''}`,
      iconSize: [24, 24], iconAnchor: [12, 12]
    });

    if (markers[hex]) {
      markers[hex].setLatLng(latlng).setIcon(icon);
    } else {
      markers[hex] = L.marker(latlng, { icon }).addTo(map);
      markers[hex].bindPopup('');
    }

    markers[hex].on('click', () => {
      markers[hex].setPopupContent(buildPopup(ac)).openPopup();
    });

    updateAircraftTable();
  }

  function removeAircraft(hex) {
    if (markers[hex]) { map.removeLayer(markers[hex]); delete markers[hex]; }
    if (markers[hex + '_trail']) { map.removeLayer(markers[hex + '_trail']); delete markers[hex + '_trail']; }
    delete trails[hex];
    updateAircraftTable();
  }

  function altitudeColor(alt) {
    if (!alt) return '#94a3b8';
    if (alt < 5000) return '#22c55e';
    if (alt < 15000) return '#00d4ff';
    if (alt < 30000) return '#3b82f6';
    return '#a855f7';
  }

  function buildPopup(ac) {
    return `<div style="font-family:monospace;font-size:11px;color:#0d1117;min-width:160px">
      <b style="font-size:13px">${ac.callsign || ac.hex}</b><br>
      Type: ${ac.type || '—'}<br>
      Alt: ${ac.altitude ? ac.altitude.toFixed(0) + ' ft' : '—'}<br>
      Speed: ${ac.speed || '—'} kt<br>
      Track: ${ac.track ? ac.track.toFixed(0) + '°' : '—'}<br>
      Squawk: ${ac.squawk || '—'}<br>
      ${ac.lat ? `Pos: ${ac.lat.toFixed(3)}, ${ac.lon.toFixed(3)}` : ''}
    </div>`;
  }

  function updateAircraftTable() {
    const el = document.getElementById('aircraft-table');
    if (!el || !window.App) return;
    const aircraft = Object.values(App.state.aircraft);
    aircraft.sort((a, b) => (b.altitude || 0) - (a.altitude || 0));
    el.innerHTML = aircraft.slice(0, 30).map(ac => `
      <div class="aircraft-row" onclick="AdsbMap.centerOn('${ac.hex}')">
        <div>
          <div class="cs">${ac.callsign || ac.hex}</div>
          <div class="tp">${ac.type || '—'}</div>
        </div>
        <div>
          <div class="alt">${ac.altitude ? ac.altitude.toFixed(0) : '—'} ft</div>
          <div class="spd">${ac.speed || '—'} kt</div>
        </div>
      </div>`).join('') || '<div style="padding:12px;color:var(--text-2);font-size:12px">No aircraft</div>';
  }

  function centerOn(hex) {
    const m = markers[hex];
    if (m && map) map.setView(m.getLatLng(), 10);
  }

  return { init, update, removeAircraft, centerOn };
})();

// Auto-init so Leaflet loads tiles immediately (page uses opacity, not display:none)
document.addEventListener('DOMContentLoaded', () => setTimeout(() => AdsbMap.init(), 300));
