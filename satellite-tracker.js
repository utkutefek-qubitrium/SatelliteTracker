/*
 * <satellite-tracker> — a self-contained Web Component that shows the live
 * location of an Earth-orbiting satellite on a 2D world map.
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
 *   update-interval  Position refresh in ms. Default: 1000.
 *   show-footprint   "true"/"false". Coverage circle. Default: true.
 *   show-track       "true"/"false". Ground track for one orbit. Default: true.
 *   show-terminator  "true"/"false". Day/night shading. Default: true.
 *   units            "metric" or "imperial". Default: metric.
 *   proxy            Optional URL prefix prepended to the CelesTrak request,
 *                    e.g. a CORS proxy. Usually unnecessary — CelesTrak sends CORS headers.
 */

const SATELLITE_JS = 'https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js';
const TOPOJSON_JS = 'https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js';
const LAND_TOPOJSON = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json';

const EARTH_RADIUS_KM = 6371;
const TLE_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // re-fetch elements at most every 2h
const MAP_W = 1000;
const MAP_H = 500;

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
    // Non-fatal: the tracker still works without the basemap.
    console.warn('[satellite-tracker] basemap unavailable:', err.message);
    return null;
  });
  return landPromise;
}

// Equirectangular projection into the MAP_W x MAP_H viewBox.
function project(lat, lon) {
  return [((lon + 180) / 360) * MAP_W, ((90 - lat) / 180) * MAP_H];
}

// Great-circle destination point given a start, bearing and angular distance (all radians).
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
  const rad = Math.PI / 180;
  const jd = date.valueOf() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = 23.439 * rad;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra / rad - gmst;
  lon = (((lon + 180) % 360) + 360) % 360 - 180;
  return { lat: decl / rad, lon, decl };
}

// Split a [x,y] polyline wherever it crosses the antimeridian (big x jump),
// returning one SVG path "d" string with separate sub-paths.
function polylineToPath(points) {
  let d = '';
  let prevX = null;
  for (const [x, y] of points) {
    if (prevX === null || Math.abs(x - prevX) > MAP_W / 2) {
      d += `M${x.toFixed(1)},${y.toFixed(1)}`;
    } else {
      d += `L${x.toFixed(1)},${y.toFixed(1)}`;
    }
    prevX = x;
  }
  return d;
}

class SatelliteTracker extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._timer = null;
    this._satrec = null;
    this._tleName = '';
    this._noradId = '';
    this._lastTrackAt = 0;
    this._lastTermAt = 0;
  }

  connectedCallback() {
    this._renderShell();
    this._start();
  }

  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ---- configuration helpers -------------------------------------------------
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
      this._drawBasemap(land);

      const { name, l1, l2, noradId } = await this._resolveTle(cfg);
      // eslint-disable-next-line no-undef
      this._satrec = satellite.twoline2satrec(l1, l2);
      this._tleName = name;
      this._noradId = noradId;
      this._epoch = this._epochDate(this._satrec);

      this._tick();
      this._timer = setInterval(() => this._tick(), cfg.interval);
      this._setStatus('live', 'Live');
    } catch (err) {
      console.error('[satellite-tracker]', err);
      this._setStatus('error', err.message || 'Failed to load tracker');
    }
  }

  // Resolve a TLE from manual attributes, cache, or CelesTrak.
  async _resolveTle(cfg) {
    if (cfg.tle1 && cfg.tle2) {
      return { name: cfg.label || cfg.name, l1: cfg.tle1.trim(), l2: cfg.tle2.trim(), noradId: cfg.noradId };
    }

    const query = cfg.noradId
      ? `CATNR=${encodeURIComponent(cfg.noradId)}`
      : `NAME=${encodeURIComponent(cfg.name)}`;
    const url = `${cfg.proxy}https://celestrak.org/NORAD/elements/gp.php?${query}&FORMAT=TLE`;
    const cacheKey = 'sat-tracker:' + query;

    // Serve a fresh-enough cached copy if present.
    const cached = this._readCache(cacheKey);
    if (cached) {
      const picked = this._pickEntry(cached.entries, cfg.name);
      if (picked) return picked;
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
    } catch {
      return null;
    }
  }

  _writeCache(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value }));
    } catch {
      /* storage may be unavailable (private mode); ignore */
    }
  }

  _epochDate(satrec) {
    // satellite.js exposes the epoch as a Julian date (integer + fractional parts).
    const jd = satrec.jdsatepoch + (satrec.jdsatepochF || 0);
    return new Date((jd - 2440587.5) * 86400000);
  }

  // ---- per-frame update ------------------------------------------------------
  _tick() {
    const now = new Date();
    // eslint-disable-next-line no-undef
    const pv = satellite.propagate(this._satrec, now);
    if (!pv || !pv.position) {
      this._setStatus('error', 'Propagation error (decayed orbit?)');
      return;
    }
    // eslint-disable-next-line no-undef
    const gmst = satellite.gstime(now);
    // eslint-disable-next-line no-undef
    const geo = satellite.eciToGeodetic(pv.position, gmst);
    // eslint-disable-next-line no-undef
    const lat = satellite.degreesLat(geo.latitude);
    // eslint-disable-next-line no-undef
    const lon = satellite.degreesLong(geo.longitude);
    const alt = geo.height; // km
    const v = pv.velocity;
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); // km/s

    const cfg = this.config;
    this._updateSat(lat, lon);
    if (cfg.footprint) this._updateFootprint(lat, lon, alt);
    if (cfg.track && now - this._lastTrackAt > 30000) {
      this._updateTrack(now);
      this._lastTrackAt = +now;
    }
    if (cfg.terminator && now - this._lastTermAt > 20000) {
      this._updateTerminator(now);
      this._lastTermAt = +now;
    }
    this._updateReadout({ lat, lon, alt, speed, now });
  }

  // Ground track for roughly one orbital period centred on now.
  _updateTrack(now) {
    const periodMin = (2 * Math.PI) / this._satrec.no; // no = mean motion (rad/min)
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
      pts.push(project(satellite.degreesLat(g.latitude), satellite.degreesLong(g.longitude)));
    }
    this._els.track.setAttribute('d', polylineToPath(pts));
  }

  _updateFootprint(lat, lon, alt) {
    const ang = Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + alt)); // central angle (rad)
    const latR = (lat * Math.PI) / 180;
    const lonR = (lon * Math.PI) / 180;
    const pts = [];
    for (let b = 0; b <= 360; b += 6) {
      const [la, lo] = destination(latR, lonR, (b * Math.PI) / 180, ang);
      let lonDeg = (lo * 180) / Math.PI;
      lonDeg = (((lonDeg + 180) % 360) + 360) % 360 - 180;
      pts.push(project((la * 180) / Math.PI, lonDeg));
    }
    this._els.footprint.setAttribute('d', polylineToPath(pts));
  }

  _updateSat(lat, lon) {
    const [x, y] = project(lat, lon);
    this._els.sat.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
  }

  // Shade the night hemisphere using the subsolar point.
  _updateTerminator(now) {
    const sun = subsolarPoint(now);
    const tanDecl = Math.tan(sun.decl);
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 2) {
      const h = ((lon - sun.lon) * Math.PI) / 180;
      const latRad = Math.atan(-Math.cos(h) / tanDecl);
      pts.push(project((latRad * 180) / Math.PI, lon));
    }
    // Close the polygon along whichever pole is in darkness.
    const nightPoleY = sun.decl >= 0 ? MAP_H : 0; // sun north -> south pole dark
    let d = polylineToPath(pts);
    d += `L${MAP_W},${nightPoleY}L0,${nightPoleY}Z`;
    this._els.night.setAttribute('d', d);
  }

  // ---- readout ---------------------------------------------------------------
  _updateReadout({ lat, lon, alt, speed, now }) {
    const cfg = this.config;
    const f = (n, d = 2) => n.toFixed(d);
    const altDisp = cfg.imperial ? `${f(alt * 0.621371, 1)} mi` : `${f(alt, 1)} km`;
    const spdDisp = cfg.imperial
      ? `${f(speed * 0.621371, 2)} mi/s`
      : `${f(speed, 2)} km/s`;
    const periodMin = (2 * Math.PI) / this._satrec.no;
    const incl = (this._satrec.inclo * 180) / Math.PI;

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

  _label() {
    return this.getAttribute('label') || this._tleName || this.config.name;
  }

  _ago(date) {
    const s = Math.max(0, (Date.now() - date.getTime()) / 1000);
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
    return `${(s / 86400).toFixed(1)} d`;
  }

  _set(key, value) {
    if (this._els[key]) this._els[key].textContent = value;
  }

  _setStatus(state, text) {
    if (!this._els) return;
    this._els.status.dataset.state = state;
    this._els.statusText.textContent = text;
    this._els.overlay.hidden = state === 'live';
    this._els.overlayMsg.textContent = text;
    this._els.overlay.dataset.state = state;
  }

  // ---- DOM scaffolding -------------------------------------------------------
  _drawBasemap(land) {
    const mapG = this._els.map;
    mapG.innerHTML = '';
    // graticule
    const grat = [];
    for (let lon = -150; lon <= 150; lon += 30) {
      const [x] = project(0, lon);
      grat.push(`M${x},0V${MAP_H}`);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const [, y] = project(lat, 0);
      grat.push(`M0,${y}H${MAP_W}`);
    }
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    g.setAttribute('d', grat.join(''));
    g.setAttribute('class', 'graticule');
    mapG.appendChild(g);

    if (land && land.features) {
      const paths = [];
      for (const feat of land.features) {
        const geom = feat.geometry;
        const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
        for (const poly of polys) {
          for (const ring of poly) {
            paths.push(polylineToPath(ring.map(([lo, la]) => project(la, lo))) + 'Z');
          }
        }
      }
      const landPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      landPath.setAttribute('d', paths.join(''));
      landPath.setAttribute('class', 'land');
      mapG.appendChild(landPath);
    }
  }

  _renderShell() {
    const root = this.shadowRoot;
    root.innerHTML = `
      <style>
        :host {
          display: block;
          --bg: #0b1120;
          --ocean: #0d1b2e;
          --land: #1f3a5f;
          --grid: rgba(120,160,210,.12);
          --accent: #38bdf8;
          --track: #f59e0b;
          --foot: rgba(56,189,248,.9);
          --text: #e2e8f0;
          --muted: #94a3b8;
          font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
          color: var(--text);
        }
        .card {
          position: relative;
          background: var(--bg);
          border: 1px solid rgba(148,163,184,.18);
          border-radius: 14px;
          overflow: hidden;
          box-shadow: 0 10px 40px rgba(0,0,0,.35);
        }
        .mapwrap { position: relative; width: 100%; aspect-ratio: 2 / 1; }
        svg { display:block; width:100%; height:100%; background:
              radial-gradient(120% 90% at 50% 0%, #122139 0%, var(--ocean) 70%); }
        .graticule { fill:none; stroke:var(--grid); stroke-width:1; }
        .land { fill:var(--land); stroke:rgba(120,170,230,.35); stroke-width:.6; }
        .night { fill: rgba(2,6,18,.45); stroke:none; pointer-events:none; }
        .track { fill:none; stroke:var(--track); stroke-width:2; stroke-dasharray:5 5;
                 opacity:.85; }
        .footprint { fill:rgba(56,189,248,.10); stroke:var(--foot); stroke-width:1.5; }
        .sat .glow { fill:var(--accent); opacity:.25; }
        .sat .core { fill:#fff; stroke:var(--accent); stroke-width:2.5; }
        .sat .ping { fill:none; stroke:var(--accent); stroke-width:2;
                     transform-origin:center; animation:ping 2.2s ease-out infinite; }
        @keyframes ping { 0%{r:6; opacity:.9} 100%{r:26; opacity:0} }

        .panel {
          position:absolute; top:12px; left:12px;
          background:rgba(8,14,28,.72); backdrop-filter:blur(6px);
          border:1px solid rgba(148,163,184,.2); border-radius:10px;
          padding:10px 12px; min-width:180px; font-size:13px; line-height:1.35;
        }
        .panel h3 { margin:0 0 2px; font-size:14px; font-weight:650; letter-spacing:.2px; }
        .norad { color:var(--muted); font-size:11px; margin-bottom:8px; }
        .grid { display:grid; grid-template-columns:auto auto; gap:2px 14px; }
        .grid .k { color:var(--muted); }
        .grid .v { text-align:right; font-variant-numeric:tabular-nums; font-weight:600; }
        .status { display:flex; align-items:center; gap:6px; margin-top:8px;
                  font-size:11px; color:var(--muted); }
        .dot { width:8px; height:8px; border-radius:50%; background:#64748b; }
        .status[data-state="live"] .dot { background:#22c55e; box-shadow:0 0 8px #22c55e; }
        .status[data-state="error"] .dot { background:#ef4444; }
        .status[data-state="loading"] .dot { background:#f59e0b; }

        .footer { display:flex; justify-content:space-between; gap:8px;
                  padding:7px 12px; font-size:11px; color:var(--muted);
                  border-top:1px solid rgba(148,163,184,.14); }
        .footer a { color:var(--muted); }

        .overlay { position:absolute; inset:0; display:flex; align-items:center;
                   justify-content:center; background:rgba(8,12,24,.7);
                   font-size:14px; text-align:center; padding:20px; }
        .overlay[data-state="error"] { color:#fca5a5; }
        @media (max-width:520px){
          .panel{ min-width:0; left:8px; top:8px; padding:8px 10px; font-size:12px; }
          .grid{ gap:1px 10px; }
        }
      </style>
      <div class="card">
        <div class="mapwrap">
          <svg viewBox="0 0 ${MAP_W} ${MAP_H}" preserveAspectRatio="xMidYMid slice"
               role="img" aria-label="World map showing live satellite position">
            <g id="map"></g>
            <path id="night" class="night"></path>
            <path id="track" class="track"></path>
            <path id="footprint" class="footprint"></path>
            <g id="sat" class="sat">
              <circle class="ping" r="6"></circle>
              <circle class="glow" r="10"></circle>
              <circle class="core" r="4"></circle>
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

          <div class="overlay" id="overlay" data-state="loading">
            <span id="overlayMsg">Loading…</span>
          </div>
        </div>
        <div class="footer">
          <span id="epoch"></span>
          <span id="updated"></span>
        </div>
      </div>
    `;

    const $ = (id) => root.getElementById(id);
    this._els = {
      map: $('map'),
      night: $('night'),
      track: $('track'),
      footprint: $('footprint'),
      sat: $('sat'),
      name: $('name'),
      norad: $('norad'),
      lat: $('lat'),
      lon: $('lon'),
      alt: $('alt'),
      spd: $('spd'),
      period: $('period'),
      incl: $('incl'),
      status: $('status'),
      statusText: $('statusText'),
      epoch: $('epoch'),
      updated: $('updated'),
      overlay: $('overlay'),
      overlayMsg: $('overlayMsg'),
    };
  }
}

customElements.define('satellite-tracker', SatelliteTracker);
export { SatelliteTracker };
