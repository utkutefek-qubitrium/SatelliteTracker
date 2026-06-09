# 🛰️ `<satellite-tracker>`

A self-contained **Web Component** that shows the live location of a satellite on
a 2D world map. Built for tracking the payload aboard **D-Orbit's ION SCV
"Astounding Alexandra"**, but it works for any object in the public catalog.

- **Drop-in** — one `<script>` and one custom element. No build step, no backend.
- **Live** — fetches Two-Line Element (TLE) data from
  [CelesTrak](https://celestrak.org/) and propagates the orbit in the browser
  with [satellite.js](https://github.com/shashwatak/satellite-js) (SGP4).
- **Framework-agnostic** — a real custom element, so it works in plain HTML,
  React, Vue, Svelte, Angular, etc.
- **Two views** — a flat **2D world map** and an interactive **3D globe**
  (drag to rotate, double-click to re-follow the satellite), with a toggle.
- **Pass predictor** — enter a latitude/longitude to get the next passes
  overhead: max elevation, local time, duration, and direction.
- **Shows nicely** — subsatellite point, one-orbit ground track, coverage
  footprint, a day/night terminator, and a live telemetry readout.

## Quick start

```html
<script type="module" src="satellite-tracker.js"></script>

<satellite-tracker
  satellite-name="Astounding Alexandra"
  label="QUBITCORE"
  operator="Qubitrium">
</satellite-tracker>
```

`QUBITCORE` is a hosted payload, so it shares the orbit of its carrier,
D-Orbit's **ION SCV Astounding Alexandra**. The widget therefore tracks the
carrier (`satellite-name`) but displays your payload's name (`label`) and
operator. The view defaults to the interactive **globe**; add `view="map"`
for the flat map.

Open `index.html` for a full demo page.

## Run it locally on a Mac

Browsers block `fetch()` on `file://` pages, so don't just double-click
`index.html` — serve the folder over HTTP. From this directory:

```bash
# Option A — Python (preinstalled on macOS)
python3 -m http.server 8000
# then open http://localhost:8000

# Option B — Node (if you have it)
npx serve .

# Option C — VS Code: right-click index.html → "Open with Live Server"
```

Notes for the demo:
- **Internet is required** — it fetches live orbital data and the basemap from CDNs.
- **Passes:** type a latitude/longitude and hit **Set** to see upcoming passes.
- The **Globe**: drag to rotate, double-click to re-center on the satellite.

## Using it in a React app

```jsx
import 'satellite-tracker.js'; // registers the custom element once

export function PayloadMap() {
  return (
    <satellite-tracker
      satellite-name="Astounding Alexandra"
      label="QUBITCORE"
      operator="Qubitrium"
    />
  );
}
```

## Attributes

| Attribute         | Default                | Description                                                                 |
| ----------------- | ---------------------- | --------------------------------------------------------------------------- |
| `satellite-name`  | `Astounding Alexandra` | Name (substring) to look up on CelesTrak.                                    |
| `norad-id`        | —                      | NORAD catalog number. Takes precedence over `satellite-name` when set.      |
| `tle-line1`       | —                      | Manual TLE line 1. With `tle-line2`, skips the network entirely.            |
| `tle-line2`       | —                      | Manual TLE line 2.                                                          |
| `label`           | name from TLE          | Display name shown in the UI (e.g. your payload `QUBITCORE`).               |
| `operator`        | —                      | Operator name shown as a chip above the label (e.g. `Qubitrium`).          |
| `logo`            | —                      | URL of an operator logo shown in the panel (hidden automatically if it fails to load). |
| `view`            | `globe`                | Initial view: `globe` or `map`.                                           |
| `update-interval` | `1000`                 | Position refresh in milliseconds.                                           |
| `show-footprint`  | `true`                 | Draw the ground coverage circle.                                            |
| `show-track`      | `true`                 | Draw the ground track for one orbit.                                        |
| `show-terminator` | `true`                 | Shade the night side of Earth.                                              |
| `show-passes`     | `true`                 | Show the next-pass predictor panel.                                        |
| `observer-lat`    | —                      | Preset observer latitude (deg) for pass prediction.                        |
| `observer-lon`    | —                      | Preset observer longitude (deg) for pass prediction.                       |
| `min-elevation`   | `10`                   | Minimum elevation (deg) counted as a visible pass.                         |
| `pass-count`      | `3`                    | Number of upcoming passes to list.                                         |
| `units`           | `metric`               | `metric` or `imperial`.                                                     |
| `proxy`           | —                      | URL prefix prepended to the CelesTrak request (only if you hit CORS).       |

### Pinning to an exact object

Looking up by name is convenient and survives catalog updates. If you'd rather
pin to a specific object, set the NORAD id:

```html
<satellite-tracker norad-id="00000" label="ION SCV Astounding Alexandra"></satellite-tracker>
```

You can confirm the current NORAD id for the carrier on
[CelesTrak's catalog search](https://celestrak.org/satcat/search.php) or
[N2YO](https://www.n2yo.com/) — search for "Astounding Alexandra".

### Fully offline (manual TLE)

If you want zero external requests, paste a TLE directly (refresh it periodically
to stay accurate):

```html
<satellite-tracker
  label="ION SCV Astounding Alexandra"
  tle-line1="1 NNNNNU YYNNNA   ..."
  tle-line2="2 NNNNN  ...">
</satellite-tracker>
```

## How it works

1. On connect, it loads `satellite.js` and a low-res world basemap from a CDN.
2. It fetches the TLE from CelesTrak (cached in `localStorage` for 2 hours) — or
   uses your manual `tle-line1/2`.
3. Every `update-interval`, it runs SGP4 to get the ECI position, converts to
   geodetic lat/lon/altitude, and updates the map and readout.
4. The ground track, footprint, and terminator are recomputed on a slower cadence.

## Runtime dependencies (loaded from CDN)

- `satellite.js` — SGP4 orbit propagation
- `topojson-client` + `world-atlas` — the world basemap (optional; the tracker
  still runs if the basemap fails to load)

## Running it on a production site (data & CORS)

CelesTrak does not send CORS headers, so a browser request straight from your
domain to `celestrak.org` is usually blocked once deployed (it often still works
from `localhost`). The widget handles this automatically with **no backend on
your side**, trying in order:

1. a custom `proxy` you provide (if set),
2. CelesTrak directly (works if/when CORS is allowed),
3. public CORS proxies (`corsproxy.io`, then `allorigins.win`),
4. the last successfully cached elements (a TLE stays usable for days).

That makes it "just work" on most sites. The public proxies are third-party and
can rate-limit, so for a **bulletproof** setup serve the data from your own
domain — any of these removes the dependency entirely:

- **Serverless function / Worker** (Vercel, Netlify, Cloudflare): fetch CelesTrak
  server-side and return it, then set `proxy="https://yourapp/api/tle?u="`.
- **Scheduled cache:** a cron/GitHub Action saves the TLE to a static file on
  your domain, and you pass it via `tle-line1` / `tle-line2`.

> Tell me your host and I'll wire the exact version for you.

## A note on the coverage footprint

On the **globe**, the footprint is the true geodesic coverage circle. On the
**flat map**, a real footprint projects to a distorted oval (a circle on a
sphere can't stay a circle on an equirectangular map), so the widget instead
draws a clean circular "range ring" sized to the coverage radius — it reads as
an intentional ring rather than a warped blob. Switch to the globe for the
geometrically exact footprint.

## Notes & limitations

- TLE accuracy degrades over days; the readout shows the element-set age.
- D-Orbit's ION carriers manoeuvre, so elements can change after burns — name
  lookup picks up fresh elements automatically on the next 2-hour refresh.
- Requires an internet connection at runtime unless you supply a manual TLE.
