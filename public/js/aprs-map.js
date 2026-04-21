/* aprs-map.js — Leaflet APRS station map */

const AprsMap = (() => {
  let map = null;
  let markers = {};
  let initialized = false;

  function init() {
    if (initialized) {
      if (map) setTimeout(() => map.invalidateSize(), 100);
      return;
    }
    initialized = true;

    map = L.map('aprs-map', {
      center: [52.0, -1.5],
      zoom: 7,
      zoomControl: true,
      attributionControl: false
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 19
    }).addTo(map);

    if (window.App && App.state) {
      Object.values(App.state.aprsStations).forEach(update);
    }
  }

  function update(station) {
    if (!map || !station.lat || !station.lon) return;
    const latlng = [station.lat, station.lon];
    const cs = station.callsign;

    const icon = L.divIcon({
      className: '',
      html: `<div style="font-size:14px;filter:drop-shadow(0 0 4px rgba(168,85,247,0.9))">📡</div>
             <div style="font-size:9px;color:#a855f7;font-family:monospace;margin-top:1px;white-space:nowrap">${cs}</div>`,
      iconSize: [40, 28], iconAnchor: [20, 14]
    });

    if (markers[cs]) {
      markers[cs].setLatLng(latlng).setIcon(icon);
    } else {
      markers[cs] = L.marker(latlng, { icon }).addTo(map);
    }

    markers[cs].bindPopup(`<div style="font-family:monospace;font-size:11px;color:#0d1117">
      <b>${cs}</b><br>${station.comment || 'APRS Station'}<br>
      ${station.lat.toFixed(4)}, ${station.lon.toFixed(4)}
    </div>`);

    const cnt = document.getElementById('aprs-count');
    if (cnt && window.App) cnt.textContent = Object.keys(App.state.aprsStations).length;
  }

  return { init, update };
})();

document.addEventListener('DOMContentLoaded', () => setTimeout(() => AprsMap.init(), 400));
