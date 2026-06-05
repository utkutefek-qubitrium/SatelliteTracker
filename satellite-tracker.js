/*
 * <satellite-tracker> — a self-contained Web Component that shows the live
 * location of an Earth-orbiting satellite on a 2D world map or a 3D globe,
 * and predicts the next passes over the visitor's location.
 *
 * Defaults to tracking D-Orbit's "ION SCV Astounding Alexandra", the carrier
 * hosting the payload, but it can track any object in the public catalog.
 *
 * Orbital data (TLE) is fetched at runtime from CelesTrak in the visitor's
 * browser and propagated client-side with satellite.js (SGP4). No build step
 * and no server are required — drop the script on a page and add the tag:
 *
 *   <script type="module" src="satellite-tracker.js"></script>
 *   <satellite-tracker satellite-name="Astounding Alexandra"></satellite-tracker>
 *
 * Attributes (all optional):
 *   satellite-name   Name (substring) to look up on CelesTrak. Default: "Astounding Alexandra".
 *   norad-id         NORAD catalog number. Takes precedence over satellite-name when set.
 *   tle-line1        Manual TLE line 1. Use with tle-line2 to skip the network entirely.
 *   tle-line2        Manual TLE line 2.
 *   label            Display name shown in the UI. Defaults to the name from the TLE.
 *   view             Initial view: "map" or "globe". Default: "map".
 *   update-interval  Position refresh in ms. Default: 1000.
 *   show-footprint   "true"/"false". Coverage circle. Default: true.
 *   show-track       "true"/"false". Ground track for one orbit. Default: true.
 *   show-terminator  "true"/"false". Day/night shading. Default: true.
 *   show-passes      "true"/"false". Next-pass predictor panel. Default: true.
 *   observer-lat     Preset observer latitude (deg) for pass prediction.
 *   observer-lon     Preset observer longitude (deg) for pass prediction.
 *   min-elevation    Minimum elevation (deg) counted as a visible pass. Default: 10.
 *   pass-count       Number of upcoming passes to list. Default: 3.
 *   units            "metric" or "imperial". Default: metric.
 *   proxy            Optional URL prefix prepended to the CelesTrak request (CORS fallback).
 */

const SATELLITE_JS = 'https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js';
const TOPOJSON_JS = 'https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js';
const LAND_TOPOJSON = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json';

const EARTH_RADIUS_KM = 6371;
const TLE_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // re-fetch elements at most every 2h
const DEG = Math.PI / 180;

// Shared viewBox for both projections (a 2:1 frame; the globe sits centred in it).
const VB_W = 1000;
const VB_H = 500;
const GLOBE_CX = VB_W / 2;
const GLOBE_CY = VB_H / 2;
const GLOBE_R = 225;

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// Shared promise caches so multiple widgets on a page load each dependency once.
const scriptPromises = new Map();
let landPromise = null;

function loadScript(url) {
  if (scriptPromises.has(url)) return scriptPromises.get(url);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + url));
    document.head.appendChild(s);
  });
  scriptPromises.set(url, p);
  return p;
}

// Fetch + decode the world land outline once, shared across instances.
async function loadLand() {
  if (landPromise) return landPromise;
  landPromise = (async () => {
    await loadScript(TOPOJSON_JS);
    const res = await fetch(LAND_TOPOJSON);
    if (!res.ok) throw new Error('land topology HTTP ' + res.status);
    const topo = await res.json();
    // eslint-disable-next-line no-undef
    return topojson.feature(topo, topo.objects.land);
  })().catch((err) => {
    console.warn('[satellite-tracker] basemap unavailable:', err.message);
    return null;
  });
  return landPromise;
}

// Great-circle destination point given start, bearing and angular distance (all radians).
function destination(latRad, lonRad, bearingRad, angDistRad) {
  const lat2 = Math.asin(
    Math.sin(latRad) * Math.cos(angDistRad) +
      Math.cos(latRad) * Math.sin(angDistRad) * Math.cos(bearingRad)
  );
  const lon2 =
    lonRad +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(angDistRad) * Math.cos(latRad),
      Math.cos(angDistRad) - Math.sin(latRad) * Math.sin(lat2)
    );
  return [lat2, lon2];
}

// Approximate geographic position of the Sun (subsolar point) for terminator shading.
function subsolarPoint(date) {
  const jd = date.valueOf() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = 23.439 * DEG;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra / DEG - gmst;
  lon = (((lon + 180) % 360) + 360) % 360 - 180;
  return { lat: decl / DEG, lon, decl };
}

function compass(azDeg) {
  return COMPASS[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];
}

class SatelliteTracker extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._timer = null;
    this._satrec = null;
    this._tleName = '';
    this._noradId = '';
    this._view = 'map';
    this._landRings = [];
    // globe orientation + interaction state
    this._globeLon = 0;
    this._globeLat = 20;
    this._follow = true;
    this._dragging = false;
    this._rafPending = false;
    // cached geometry (geographic), re-projected on demand
    this._satLL = null;
    this._trackLL = [];
    this._footLL = [];
    this._termLL = null;
    this._observer = null;
    this._passes = [];
    this._lastTrackAt = 0;
    this._lastTermAt = 0;
    this._lastPassAt = 0;
  }

  connectedCallback() {
    this._view = (this.getAttribute('view') || 'map').toLowerCase() === 'globe' ? 'globe' : 'map';
    this._renderShell();
    this._restoreObserver();
    this._start();
  }

  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ---- configuration ---------------------------------------------------------
  _boolAttr(name, def) {
    const v = this.getAttribute(name);
    if (v === null) return def;
    return v !== 'false' && v !== '0' && v !== 'no';
  }

  get config() {
    const bool = (name, def) => this._boolAttr(name, def);
    return {
      name: this.getAttribute('satellite-name') || 'Astounding Alexandra',
      noradId: this.getAttribute('norad-id') || '',
      tle1: this.getAttribute('tle-line1') || '',
      tle2: this.getAttribute('tle-line2') || '',
      label: this.getAttribute('label') || '',
      interval: Math.max(250, parseInt(this.getAttribute('update-interval'), 10) || 1000),
      footprint: bool('show-footprint', true),
      track: bool('show-track', true),
      terminator: bool('show-terminator', true),
      passes: bool('show-passes', true),
      minElevation: parseFloat(this.getAttribute('min-elevation')) || 10,
      passCount: Math.max(1, parseInt(this.getAttribute('pass-count'), 10) || 3),
      imperial: (this.getAttribute('units') || 'metric').toLowerCase() === 'imperial',
      proxy: this.getAttribute('proxy') || '',
    };
  }

  // ---- lifecycle -------------------------------------------------------------
  async _start() {
    const cfg = this.config;
    try {
      this._setStatus('loading', 'Loading orbital data…');
      const [land] = await Promise.all([loadLand(), loadScript(SATELLITE_JS)]);
      this._buildLandRings(land);
      this._drawBasemap();

      const { name, l1, l2, noradId } = await this._resolveTle(cfg);
      // eslint-disable-next-line no-undef
      this._satrec = satellite.twoline2satrec(l1, l2);
      this._tleName = name;
      this._noradId = noradId;
      this._epoch = this._epochDate(this._satrec);

      // preset observer from attributes
      const oLat = parseFloat(this.getAttribute('observer-lat'));
      const oLon = parseFloat(this.getAttribute('observer-lon'));
      if (!this._observer && Number.isFinite(oLat) && Number.isFinite(oLon)) {
        this._observer = { lat: oLat, lon: oLon, alt: 0, label: 'Preset location' };
      }
      this._refreshObserverUI();

      this._tick();
      this._timer = setInterval(() => this._tick(), cfg.interval);
      this._setStatus('live', 'Live');
    } catch (err) {
      console.error('[satellite-tracker]', err);
      this._setStatus('error', err.message || 'Failed to load tracker');
    }
  }

  async _resolveTle(cfg) {
    if (cfg.tle1 && cfg.tle2) {
      return { name: cfg.label || cfg.name, l1: cfg.tle1.trim(), l2: cfg.tle2.trim(), noradId: cfg.noradId };
    }
    const query = cfg.noradId
      ? `CATNR=${encodeURIComponent(cfg.noradId)}`
      : `NAME=${encodeURIComponent(cfg.name)}`;
    const url = `${cfg.proxy}https://celestrak.org/NORAD/elements/gp.php?${query}&FORMAT=TLE`;
    const cacheKey = 'sat-tracker:' + query;

    const cached = this._readCache(cacheKey);
    if (cached) {
      const picked = this._pickEntry(cached.entries, cfg.name);
      if (picked) return cfg.label ? { ...picked, name: cfg.label } : picked;
    }
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('CelesTrak request failed (HTTP ' + res.status + ')');
    const text = (await res.text()).trim();
    if (!text || /no gp data/i.test(text)) {
      throw new Error(`No catalog match for "${cfg.noradId || cfg.name}". Check the name or NORAD id.`);
    }
    const entries = this._parseTle(text);
    if (!entries.length) throw new Error('Could not parse orbital data from CelesTrak.');
    this._writeCache(cacheKey, { entries });
    const picked = this._pickEntry(entries, cfg.name);
    if (!picked) throw new Error('No matching satellite found in the response.');
    return cfg.label ? { ...picked, name: cfg.label } : picked;
  }

  _parseTle(text) {
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
    const out = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].startsWith('1 ') && lines[i + 1].startsWith('2 ')) {
        const name = i > 0 && !lines[i - 1].startsWith('1 ') ? lines[i - 1].trim() : 'Unknown';
        const noradId = lines[i].slice(2, 7).trim();
        out.push({ name, l1: lines[i], l2: lines[i + 1], noradId });
      }
    }
    return out;
  }

  _pickEntry(entries, name) {
    if (!entries || !entries.length) return null;
    const wanted = name.toLowerCase();
    return entries.find((e) => e.name.toLowerCase().includes(wanted)) || entries[0];
  }

  _readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (Date.now() - obj.t > TLE_CACHE_TTL_MS) return null;
      return obj.v;
    } catch { return null; }
  }

  _writeCache(key, value) {
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value })); } catch { /* ignore */ }
  }

  _epochDate(satrec) {
    const jd = satrec.jdsatepoch + (satrec.jdsatepochF || 0);
    return new Date((jd - 2440587.5) * 86400000);
  }

  // ---- projection ------------------------------------------------------------
  // Returns { x, y, v } where v is visibility (always true for the map).
  _project(lat, lon) {
    if (this._view === 'globe') {
      const phi = lat * DEG, lam = lon * DEG;
      const phi0 = this._globeLat * DEG, lam0 = this._globeLon * DEG;
      const cosc =
        Math.sin(phi0) * Math.sin(phi) +
        Math.cos(phi0) * Math.cos(phi) * Math.cos(lam - lam0);
      const x = GLOBE_R * Math.cos(phi) * Math.sin(lam - lam0);
      const y = GLOBE_R * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(lam - lam0));
      return { x: GLOBE_CX + x, y: GLOBE_CY - y, v: cosc >= 0 };
    }
    return { x: ((lon + 180) / 360) * VB_W, y: ((90 - lat) / 180) * VB_H, v: true };
  }

  // Build an SVG path from [lat,lon] points, breaking at hidden points (globe)
  // or antimeridian crossings (map).
  _pathFrom(points, close = false) {
    let d = '', prev = null;
    const maxJump = this._view === 'map' ? VB_W / 2 : Infinity;
    for (const [la, lo] of points) {
      const p = this._project(la, lo);
      if (!p.v) { prev = null; continue; }
      if (prev === null || Math.abs(p.x - prev.x) > maxJump) {
        d += `M${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      } else {
        d += `L${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      }
      prev = p;
    }
    return close ? d + 'Z' : d;
  }

  // ---- per-frame update ------------------------------------------------------
  _tick() {
    const now = new Date();
    // eslint-disable-next-line no-undef
    const pv = satellite.propagate(this._satrec, now);
    if (!pv || !pv.position) { this._setStatus('error', 'Propagation error (decayed orbit?)'); return; }
    // eslint-disable-next-line no-undef
    const gmst = satellite.gstime(now);
    // eslint-disable-next-line no-undef
    const geo = satellite.eciToGeodetic(pv.position, gmst);
    // eslint-disable-next-line no-undef
    const lat = satellite.degreesLat(geo.latitude);
    // eslint-disable-next-line no-undef
    const lon = satellite.degreesLong(geo.longitude);
    const alt = geo.height;
    const v = pv.velocity;
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

    const cfg = this.config;
    this._satLL = [lat, lon];
    this._satAlt = alt;
    if (cfg.footprint) this._footLL = this._computeFootprint(lat, lon, alt);
    if (cfg.track && now - this._lastTrackAt > 30000) { this._trackLL = this._computeTrack(now); this._lastTrackAt = +now; }
    if (cfg.terminator && now - this._lastTermAt > 20000) { this._termLL = this._computeTerminator(now); this._lastTermAt = +now; }
    if (cfg.passes && this._observer && now - this._lastPassAt > 60000) {
      this._passes = this._predictPasses(now); this._lastPassAt = +now; this._renderPasses();
    }

    if (this._view === 'globe' && this._follow) {
      this._globeLon = lon;
      this._globeLat = Math.max(-60, Math.min(60, lat));
      this._drawBasemap();
    }
    this._redrawGeo();
    this._updateReadout({ lat, lon, alt, speed, now });
  }

  _computeTrack(now) {
    const periodMin = (2 * Math.PI) / this._satrec.no;
    const halfMs = (periodMin / 2) * 60000;
    const stepMs = (periodMin * 60000) / 180;
    const pts = [];
    for (let t = -halfMs; t <= halfMs; t += stepMs) {
      const d = new Date(+now + t);
      // eslint-disable-next-line no-undef
      const pv = satellite.propagate(this._satrec, d);
      if (!pv || !pv.position) continue;
      // eslint-disable-next-line no-undef
      const g = satellite.eciToGeodetic(pv.position, satellite.gstime(d));
      // eslint-disable-next-line no-undef
      pts.push([satellite.degreesLat(g.latitude), satellite.degreesLong(g.longitude)]);
    }
    return pts;
  }

  _computeFootprint(lat, lon, alt) {
    const ang = Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + alt));
    const latR = lat * DEG, lonR = lon * DEG;
    const pts = [];
    for (let b = 0; b <= 360; b += 5) {
      const [la, lo] = destination(latR, lonR, b * DEG, ang);
      let lonDeg = (lo / DEG);
      lonDeg = (((lonDeg + 180) % 360) + 360) % 360 - 180;
      pts.push([la / DEG, lonDeg]);
    }
    return pts;
  }

  _computeTerminator(now) {
    const sun = subsolarPoint(now);
    const tanDecl = Math.tan(sun.decl);
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 2) {
      const h = (lon - sun.lon) * DEG;
      const latRad = Math.atan(-Math.cos(h) / tanDecl);
      pts.push([latRad / DEG, lon]);
    }
    return { pts, decl: sun.decl };
  }

  // Re-project all cached geometry into the current view.
  _redrawGeo() {
    const e = this._els;
    e.track.setAttribute('d', this._trackLL.length ? this._pathFrom(this._trackLL) : '');
    e.footprint.setAttribute('d', this._footLL.length ? this._pathFrom(this._footLL, true) : '');

    // terminator
    if (this._termLL) {
      if (this._view === 'map') {
        const nightPoleY = this._termLL.decl >= 0 ? VB_H : 0;
        let d = this._pathFrom(this._termLL.pts);
        d += `L${VB_W},${nightPoleY}L0,${nightPoleY}Z`;
        e.night.setAttribute('d', d);
        e.night.setAttribute('class', 'night fill');
      } else {
        e.night.setAttribute('d', this._pathFrom(this._termLL.pts));
        e.night.setAttribute('class', 'night line');
      }
    }

    // satellite marker
    if (this._satLL) {
      const p = this._project(this._satLL[0], this._satLL[1]);
      e.sat.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      e.sat.style.visibility = p.v ? 'visible' : 'hidden';
    }
    // observer marker
    if (this._observer) {
      const p = this._project(this._observer.lat, this._observer.lon);
      e.observer.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      e.observer.style.visibility = p.v ? 'visible' : 'hidden';
    } else {
      e.observer.style.visibility = 'hidden';
    }
  }

  // ---- next-pass prediction --------------------------------------------------
  _predictPasses(start) {
    const cfg = this.config;
    const obs = this._observer;
    const obsGd = { longitude: obs.lon * DEG, latitude: obs.lat * DEG, height: (obs.alt || 0) / 1000 };
    const minEl = cfg.minElevation;
    const stepS = 30;
    const horizonS = 48 * 3600;
    const out = [];
    let inPass = false, cur = null, prev = null;

    for (let s = 0; s <= horizonS; s += stepS) {
      const date = new Date(+start + s * 1000);
      // eslint-disable-next-line no-undef
      const pv = satellite.propagate(this._satrec, date);
      if (!pv || !pv.position) { prev = null; continue; }
      // eslint-disable-next-line no-undef
      const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
      // eslint-disable-next-line no-undef
      const look = satellite.ecfToLookAngles(obsGd, ecf);
      const el = look.elevation / DEG;
      const az = ((look.azimuth / DEG) % 360 + 360) % 360;
      const sample = { date, el, az };

      if (el >= minEl) {
        if (!inPass) {
          inPass = true;
          cur = { aos: this._crossTime(prev, sample, minEl) || date, aosAz: az, maxEl: el, maxAz: az, maxTime: date };
        }
        if (el > cur.maxEl) { cur.maxEl = el; cur.maxAz = az; cur.maxTime = date; }
        cur.last = sample;
      } else if (inPass) {
        cur.los = this._crossTime(cur.last, sample, minEl) || cur.last.date;
        cur.losAz = cur.last.az;
        out.push(cur);
        inPass = false; cur = null;
        if (out.length >= cfg.passCount) break;
      }
      prev = sample;
    }
    return out;
  }

  // Linear interpolation of the time when elevation crosses `target`.
  _crossTime(a, b, target) {
    if (!a || !b || a.el === b.el) return null;
    const frac = (target - a.el) / (b.el - a.el);
    if (frac < 0 || frac > 1) return null;
    return new Date(+a.date + frac * (+b.date - +a.date));
  }

  // ---- readout ---------------------------------------------------------------
  _updateReadout({ lat, lon, alt, speed, now }) {
    const cfg = this.config;
    const f = (n, d = 2) => n.toFixed(d);
    const altDisp = cfg.imperial ? `${f(alt * 0.621371, 1)} mi` : `${f(alt, 1)} km`;
    const spdDisp = cfg.imperial ? `${f(speed * 0.621371, 2)} mi/s` : `${f(speed, 2)} km/s`;
    const periodMin = (2 * Math.PI) / this._satrec.no;
    const incl = this._satrec.inclo / DEG;

    this._els.name.textContent = this._label();
    this._els.norad.textContent = this._noradId ? `NORAD ${this._noradId}` : '';
    this._set('lat', `${f(Math.abs(lat), 3)}° ${lat >= 0 ? 'N' : 'S'}`);
    this._set('lon', `${f(Math.abs(lon), 3)}° ${lon >= 0 ? 'E' : 'W'}`);
    this._set('alt', altDisp);
    this._set('spd', spdDisp);
    this._set('period', `${f(periodMin, 1)} min`);
    this._set('incl', `${f(incl, 2)}°`);
    this._els.epoch.textContent = this._epoch ? `Elements: ${this._ago(this._epoch)} old` : '';
    this._els.updated.textContent = `Updated ${now.toUTCString().replace('GMT', 'UTC')}`;
  }

  _label() { return this.getAttribute('label') || this._tleName || this.config.name; }

  _ago(date) {
    const s = Math.max(0, (Date.now() - date.getTime()) / 1000);
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
    return `${(s / 86400).toFixed(1)} d`;
  }

  _set(key, value) { if (this._els[key]) this._els[key].textContent = value; }

  _setStatus(state, text) {
    if (!this._els) return;
    this._els.status.dataset.state = state;
    this._els.statusText.textContent = text;
    this._els.overlay.hidden = state === 'live';
    this._els.overlay.dataset.state = state;
    this._els.overlayMsg.textContent = text;
  }

  // ---- passes UI -------------------------------------------------------------
  _restoreObserver() {
    try {
      const raw = localStorage.getItem('sat-tracker:observer');
      if (raw) this._observer = JSON.parse(raw);
    } catch { /* ignore */ }
  }

  _saveObserver() {
    try { localStorage.setItem('sat-tracker:observer', JSON.stringify(this._observer)); } catch { /* ignore */ }
  }

  _setObserver(lat, lon, label) {
    this._observer = { lat, lon, alt: 0, label: label || `${lat.toFixed(2)}, ${lon.toFixed(2)}` };
    this._saveObserver();
    this._refreshObserverUI();
    this._lastPassAt = 0; // force recompute next tick
    if (this._satrec) { this._passes = this._predictPasses(new Date()); this._lastPassAt = Date.now(); this._renderPasses(); }
    this._redrawGeo();
  }

  _refreshObserverUI() {
    if (!this._els) return;
    if (this._observer) {
      this._els.latIn.value = this._observer.lat.toFixed(4);
      this._els.lonIn.value = this._observer.lon.toFixed(4);
      this._els.locLabel.textContent = this._observer.label || '';
    }
  }

  _renderPasses() {
    const list = this._els.passList;
    if (!this._observer) { list.innerHTML = '<div class="hint">Set your location to see upcoming passes.</div>'; return; }
    if (!this._passes.length) { list.innerHTML = '<div class="hint">No passes above the horizon in the next 48 h.</div>'; return; }
    const now = Date.now();
    list.innerHTML = this._passes.map((p) => {
      const ongoing = +p.aos <= now && +p.los >= now;
      const durS = Math.round((+p.los - +p.aos) / 1000);
      const dur = `${Math.floor(durS / 60)}m ${String(durS % 60).padStart(2, '0')}s`;
      const when = ongoing ? 'Now' : this._fmtTime(p.aos);
      return `<div class="pass${ongoing ? ' now' : ''}">
        <span class="el">▲ ${Math.round(p.maxEl)}°</span>
        <span class="when">${when}</span>
        <span class="meta">${dur} · ${compass(p.aosAz)}→${compass(p.losAz)}</span>
      </div>`;
    }).join('');
  }

  _fmtTime(date) {
    const opts = { weekday: 'short', hour: '2-digit', minute: '2-digit' };
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleString([], opts);
  }

  _requestGeolocation() {
    if (!navigator.geolocation) { this._els.locLabel.textContent = 'Geolocation unavailable'; return; }
    this._els.locLabel.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => this._setObserver(pos.coords.latitude, pos.coords.longitude, 'Your location'),
      (err) => { this._els.locLabel.textContent = 'Location denied — enter manually'; console.warn(err); },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
    );
  }

  // ---- view switching + globe interaction ------------------------------------
  _setView(view) {
    if (view === this._view) return;
    this._view = view;
    this._els.toggle.querySelectorAll('button[data-view]').forEach((b) =>
      b.classList.toggle('active', b.dataset.view === view));
    this._els.followBtn.hidden = view !== 'globe';
    this._els.oceanRect.style.display = view === 'map' ? '' : 'none';
    this._els.oceanDisc.style.display = view === 'globe' ? '' : 'none';
    this._els.scene.setAttribute('clip-path', view === 'globe' ? 'url(#discClip)' : 'none');
    this._els.svg.style.cursor = view === 'globe' ? 'grab' : 'default';
    this._drawBasemap();
    this._redrawGeo();
  }

  _setFollow(on) {
    this._follow = on;
    this._els.followBtn.classList.toggle('active', on);
    if (on && this._satLL) {
      this._globeLon = this._satLL[1];
      this._globeLat = Math.max(-60, Math.min(60, this._satLL[0]));
      this._scheduleRedraw();
    }
  }

  _onPointerDown(ev) {
    if (this._view !== 'globe') return;
    this._dragging = true;
    this._follow = false;
    this._els.followBtn.classList.remove('active');
    this._dragX = ev.clientX; this._dragY = ev.clientY;
    this._els.svg.setPointerCapture(ev.pointerId);
    this._els.svg.style.cursor = 'grabbing';
  }

  _onPointerMove(ev) {
    if (!this._dragging) return;
    const dx = ev.clientX - this._dragX;
    const dy = ev.clientY - this._dragY;
    this._dragX = ev.clientX; this._dragY = ev.clientY;
    this._globeLon = (((this._globeLon - dx * 0.4) + 180) % 360 + 360) % 360 - 180;
    this._globeLat = Math.max(-89, Math.min(89, this._globeLat + dy * 0.4));
    this._scheduleRedraw();
  }

  _onPointerUp(ev) {
    this._dragging = false;
    this._els.svg.style.cursor = this._view === 'globe' ? 'grab' : 'default';
    if (ev && ev.pointerId != null) { try { this._els.svg.releasePointerCapture(ev.pointerId); } catch { /* ignore */ } }
  }

  _scheduleRedraw() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this._drawBasemap();
      this._redrawGeo();
    });
  }

  // ---- basemap ---------------------------------------------------------------
  _buildLandRings(land) {
    this._landRings = [];
    if (!land || !land.features) return;
    for (const feat of land.features) {
      const geom = feat.geometry;
      const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
      for (const poly of polys) {
        for (const ring of poly) {
          this._landRings.push(ring.map(([lo, la]) => [la, lo]));
        }
      }
    }
  }

  _drawBasemap() {
    const g = this._els.map;
    // graticule (sampled so it curves on the globe)
    const grat = [];
    for (let lon = -180; lon <= 180; lon += 30) {
      const line = [];
      for (let lat = -90; lat <= 90; lat += 4) line.push([lat, lon]);
      grat.push(this._pathFrom(line));
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const line = [];
      for (let lon = -180; lon <= 180; lon += 4) line.push([lat, lon]);
      grat.push(this._pathFrom(line));
    }
    const land = this._landRings.map((r) => this._pathFrom(r, true)).join('');
    g.innerHTML =
      `<path class="graticule" d="${grat.join('')}"></path>` +
      (land ? `<path class="land" d="${land}"></path>` : '');
  }

  // ---- DOM scaffolding -------------------------------------------------------
  _renderShell() {
    const root = this.shadowRoot;
    const cfg = this.config;
    root.innerHTML = `
      <style>
        :host {
          display:block;
          --bg:#070c18; --space:#05080f; --ocean:#0d1b2e; --land:#1f3a5f;
          --grid:rgba(120,160,210,.14); --accent:#38bdf8; --track:#f59e0b;
          --foot:rgba(56,189,248,.9); --obs:#22c55e; --text:#e2e8f0; --muted:#94a3b8;
          --panel:rgba(8,14,28,.72);
          font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--text);
        }
        .card { position:relative; background:var(--bg); border:1px solid rgba(148,163,184,.18);
                border-radius:14px; overflow:hidden; box-shadow:0 10px 40px rgba(0,0,0,.35); }
        .mapwrap { position:relative; width:100%; aspect-ratio:2/1; touch-action:none; }
        svg { display:block; width:100%; height:100%;
              background:radial-gradient(120% 120% at 50% 30%, #0a1322 0%, var(--space) 80%); }
        .ocean-rect { fill:url(#oceanGrad); }
        .ocean-disc { filter:drop-shadow(0 0 26px rgba(56,189,248,.25)); }
        .graticule { fill:none; stroke:var(--grid); stroke-width:1; }
        .land { fill:var(--land); stroke:rgba(120,170,230,.35); stroke-width:.6; }
        .night.fill { fill:rgba(2,6,18,.5); stroke:none; }
        .night.line { fill:none; stroke:rgba(255,210,120,.55); stroke-width:1.5; stroke-dasharray:2 4; }
        .track { fill:none; stroke:var(--track); stroke-width:2; stroke-dasharray:5 5; opacity:.85; }
        .footprint { fill:rgba(56,189,248,.10); stroke:var(--foot); stroke-width:1.5; }
        .sat .glow { fill:var(--accent); opacity:.25; }
        .sat .core { fill:#fff; stroke:var(--accent); stroke-width:2.5; }
        .sat .ping { fill:none; stroke:var(--accent); stroke-width:2; animation:ping 2.2s ease-out infinite; }
        @keyframes ping { 0%{r:6;opacity:.9} 100%{r:26;opacity:0} }
        .obs .pin { fill:var(--obs); stroke:#06210f; stroke-width:1.5; }
        .obs .ring { fill:none; stroke:var(--obs); stroke-width:1.5; opacity:.6; }

        .panel { position:absolute; top:12px; left:12px; background:var(--panel);
                 backdrop-filter:blur(6px); border:1px solid rgba(148,163,184,.2);
                 border-radius:10px; padding:10px 12px; min-width:178px; font-size:13px; line-height:1.35; }
        .panel h3 { margin:0 0 2px; font-size:14px; font-weight:650; }
        .norad { color:var(--muted); font-size:11px; margin-bottom:8px; }
        .grid { display:grid; grid-template-columns:auto auto; gap:2px 14px; }
        .grid .k { color:var(--muted); }
        .grid .v { text-align:right; font-variant-numeric:tabular-nums; font-weight:600; }
        .status { display:flex; align-items:center; gap:6px; margin-top:8px; font-size:11px; color:var(--muted); }
        .dot { width:8px; height:8px; border-radius:50%; background:#64748b; }
        .status[data-state="live"] .dot { background:#22c55e; box-shadow:0 0 8px #22c55e; }
        .status[data-state="error"] .dot { background:#ef4444; }
        .status[data-state="loading"] .dot { background:#f59e0b; }

        .viewtoggle { position:absolute; top:12px; right:12px; display:flex; gap:6px; }
        .viewtoggle .group { display:flex; background:var(--panel); border:1px solid rgba(148,163,184,.2);
                             border-radius:8px; overflow:hidden; backdrop-filter:blur(6px); }
        .viewtoggle button { background:none; border:0; color:var(--muted); padding:6px 12px;
                             font-size:12px; cursor:pointer; font-weight:600; }
        .viewtoggle button.active { background:var(--accent); color:#04223a; }
        .followBtn { background:var(--panel); border:1px solid rgba(148,163,184,.2); border-radius:8px;
                     color:var(--muted); padding:6px 10px; font-size:12px; cursor:pointer; backdrop-filter:blur(6px); }
        .followBtn.active { color:var(--obs); border-color:rgba(34,197,94,.5); }

        .passes { padding:10px 12px; border-top:1px solid rgba(148,163,184,.14); }
        .passhead { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
        .passhead .title { font-weight:650; font-size:13px; }
        .passhead .spacer { flex:1; }
        .locBtn { background:var(--accent); color:#04223a; border:0; border-radius:7px; padding:5px 10px;
                  font-size:12px; font-weight:650; cursor:pointer; }
        .loc-inputs { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); flex-wrap:wrap; margin-bottom:8px; }
        .loc-inputs input { width:84px; background:#0b1424; border:1px solid rgba(148,163,184,.25);
                            color:var(--text); border-radius:6px; padding:4px 6px; font-size:12px; }
        .loc-inputs .setBtn { background:none; border:1px solid rgba(148,163,184,.3); color:var(--text);
                              border-radius:6px; padding:4px 9px; font-size:12px; cursor:pointer; }
        .locLabel { color:var(--obs); font-size:11px; }
        .passlist { display:flex; flex-direction:column; gap:5px; }
        .pass { display:flex; align-items:center; gap:10px; font-size:13px; padding:6px 9px;
                background:rgba(148,163,184,.07); border-radius:7px; }
        .pass.now { background:rgba(34,197,94,.14); border:1px solid rgba(34,197,94,.4); }
        .pass .el { font-weight:700; color:var(--accent); min-width:46px; }
        .pass .when { font-weight:600; min-width:88px; }
        .pass .meta { color:var(--muted); font-size:12px; }
        .hint { color:var(--muted); font-size:12px; }

        .footer { display:flex; justify-content:space-between; gap:8px; padding:7px 12px;
                  font-size:11px; color:var(--muted); border-top:1px solid rgba(148,163,184,.14); }
        .overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
                   background:rgba(8,12,24,.7); font-size:14px; text-align:center; padding:20px; }
        .overlay[data-state="error"] { color:#fca5a5; }
        @media (max-width:560px){
          .panel { min-width:0; left:8px; top:8px; padding:8px 10px; font-size:12px; }
          .pass .meta { display:none; }
        }
      </style>
      <div class="card">
        <div class="mapwrap" id="mapwrap">
          <svg id="svg" viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid slice"
               role="img" aria-label="Live satellite position">
            <defs>
              <radialGradient id="oceanGrad" cx="50%" cy="30%" r="90%">
                <stop offset="0%" stop-color="#13263f"/><stop offset="100%" stop-color="${'#0d1b2e'}"/>
              </radialGradient>
              <radialGradient id="discGrad" cx="38%" cy="32%" r="75%">
                <stop offset="0%" stop-color="#1b3457"/><stop offset="70%" stop-color="#0d1b2e"/>
                <stop offset="100%" stop-color="#081320"/>
              </radialGradient>
              <clipPath id="discClip"><circle cx="${GLOBE_CX}" cy="${GLOBE_CY}" r="${GLOBE_R}"/></clipPath>
            </defs>
            <rect class="ocean-rect" id="oceanRect" x="0" y="0" width="${VB_W}" height="${VB_H}"></rect>
            <circle class="ocean-disc" id="oceanDisc" cx="${GLOBE_CX}" cy="${GLOBE_CY}" r="${GLOBE_R}"
                    fill="url(#discGrad)" style="display:none"></circle>
            <g id="scene" clip-path="none">
              <g id="map"></g>
              <path id="night" class="night fill"></path>
              <path id="track" class="track"></path>
              <path id="footprint" class="footprint"></path>
              <g id="observer" class="obs" style="visibility:hidden">
                <circle class="ring" r="9"></circle>
                <circle class="pin" r="4"></circle>
              </g>
              <g id="sat" class="sat">
                <circle class="ping" r="6"></circle>
                <circle class="glow" r="10"></circle>
                <circle class="core" r="4"></circle>
              </g>
            </g>
          </svg>

          <div class="panel">
            <h3 id="name">Satellite</h3>
            <div class="norad" id="norad"></div>
            <div class="grid">
              <span class="k">Latitude</span><span class="v" id="lat">–</span>
              <span class="k">Longitude</span><span class="v" id="lon">–</span>
              <span class="k">Altitude</span><span class="v" id="alt">–</span>
              <span class="k">Speed</span><span class="v" id="spd">–</span>
              <span class="k">Period</span><span class="v" id="period">–</span>
              <span class="k">Inclination</span><span class="v" id="incl">–</span>
            </div>
            <div class="status" id="status" data-state="loading">
              <span class="dot"></span><span id="statusText">Starting…</span>
            </div>
          </div>

          <div class="viewtoggle" id="toggle">
            <button class="followBtn active" id="followBtn" hidden>⊙ Follow</button>
            <div class="group">
              <button data-view="map" class="active">Map</button>
              <button data-view="globe">Globe</button>
            </div>
          </div>

          <div class="overlay" id="overlay" data-state="loading"><span id="overlayMsg">Loading…</span></div>
        </div>

        <div class="passes" id="passes" ${cfg.passes ? '' : 'style="display:none"'}>
          <div class="passhead">
            <span class="title">Next passes over your location</span>
            <span class="spacer"></span>
            <button class="locBtn" id="locBtn">📍 Use my location</button>
          </div>
          <div class="loc-inputs">
            <label>Lat <input id="latIn" type="number" step="0.0001" placeholder="0.0"></label>
            <label>Lon <input id="lonIn" type="number" step="0.0001" placeholder="0.0"></label>
            <button class="setBtn" id="setLoc">Set</button>
            <span class="locLabel" id="locLabel"></span>
          </div>
          <div class="passlist" id="passList">
            <div class="hint">Set your location to see upcoming passes.</div>
          </div>
        </div>

        <div class="footer">
          <span id="epoch"></span><span id="updated"></span>
        </div>
      </div>
    `;

    const $ = (id) => root.getElementById(id);
    this._els = {
      svg: $('svg'), scene: $('scene'), map: $('map'), night: $('night'), track: $('track'),
      footprint: $('footprint'), sat: $('sat'), observer: $('observer'),
      oceanRect: $('oceanRect'), oceanDisc: $('oceanDisc'),
      name: $('name'), norad: $('norad'), lat: $('lat'), lon: $('lon'), alt: $('alt'),
      spd: $('spd'), period: $('period'), incl: $('incl'),
      status: $('status'), statusText: $('statusText'), epoch: $('epoch'), updated: $('updated'),
      overlay: $('overlay'), overlayMsg: $('overlayMsg'),
      toggle: $('toggle'), followBtn: $('followBtn'),
      latIn: $('latIn'), lonIn: $('lonIn'), locLabel: $('locLabel'), passList: $('passList'),
    };

    // wire events
    this._els.toggle.querySelectorAll('button[data-view]').forEach((b) =>
      b.addEventListener('click', () => this._setView(b.dataset.view)));
    this._els.followBtn.addEventListener('click', () => this._setFollow(!this._follow));
    $('locBtn').addEventListener('click', () => this._requestGeolocation());
    $('setLoc').addEventListener('click', () => {
      const la = parseFloat(this._els.latIn.value), lo = parseFloat(this._els.lonIn.value);
      if (Number.isFinite(la) && Number.isFinite(lo)) this._setObserver(la, lo, 'Manual location');
      else this._els.locLabel.textContent = 'Enter valid lat/lon';
    });
    const svg = this._els.svg;
    svg.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    svg.addEventListener('pointermove', (e) => this._onPointerMove(e));
    svg.addEventListener('pointerup', (e) => this._onPointerUp(e));
    svg.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    svg.addEventListener('dblclick', () => { if (this._view === 'globe') this._setFollow(true); });

    // apply initial view
    if (this._view === 'globe') {
      this._els.toggle.querySelector('[data-view="globe"]').classList.add('active');
      this._els.toggle.querySelector('[data-view="map"]').classList.remove('active');
      this._els.followBtn.hidden = false;
      this._els.oceanRect.style.display = 'none';
      this._els.oceanDisc.style.display = '';
      this._els.scene.setAttribute('clip-path', 'url(#discClip)');
      svg.style.cursor = 'grab';
    }
  }
}

customElements.define('satellite-tracker', SatelliteTracker);
export { SatelliteTracker };
