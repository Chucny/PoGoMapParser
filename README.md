# PoGoMapParser

A 2D OpenStreetMap tile renderer that reproduces the map style of the original
2016 Pokémon GO client, in a single dependency-free file.

Point it at a canvas, give it a bounding box, and it draws mint-green land,
emerald parks, sky-blue water, cream-cased roads and faint building footprints
onto a 2D canvas — straight from the official OpenStreetMap API, with no build
step, no bundler and no map tile server.

<!-- A reference screenshot from the July 2016 Pokemon GO client, not output of
     this renderer. It documents the style being targeted. -->
![Reference screenshot of the 2016 Pokemon GO client, the style this renderer targets](docs/ref2016/ref01.png)

---

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [API](#api)
- [The 2016 style](#the-2016-style)
- [Water rendering](#water-rendering)
- [Project layout](#project-layout)
- [Development](#development)
- [Data source and rate limits](#data-source-and-rate-limits)
- [Known limitations](#known-limitations)
- [Licence](#licence)

---

## Quick start

Open `demo/index.html` through a local server and press a button. The library
itself needs no server, no key and no configuration:

```html
<canvas id="map" width="550" height="550"></canvas>
<script src="src/PoGoMapParser.js"></script>
<script>
    const parser = new PoGoMapParser('map');

    const bbox = PoGoMapParser.zoomBBox(40.7500, -73.9840, 17);
    const data = await parser.fetchArea(bbox);
    parser.renderTo(parser.canvas, data, bbox);
</script>
```

`fetchMapData(south, west, north, east)` is the other entry point: same fetch,
and cached, but it takes the bbox as four loose arguments to match `render()`.

To try it locally:

```sh
git clone <this repository>
cd pogomapparser
python tools/serve.py          # http://localhost:8000
```

`tools/serve.py` exists only because a browser refuses to load a page over
`file://`. The library calls `api.openstreetmap.org` directly from the page, so
there is no API to proxy and nothing for the server to relay.

If `python` is not on your PATH, any static server will do — the demo only needs
the repository root as its document root, so that `../src/PoGoMapParser.js`
resolves:

```sh
python -m http.server 8000     # then open http://localhost:8000/demo/
```

---

## How it works

The pipeline is five stages. Each one exists because the OpenStreetMap API is
not the kind of service this job wants — it is a map-editing API, not a query
engine, and the renderer is shaped around that.

```text
   bbox  ──▶  1. splitBBox        ──▶  2. buildRequestUrl   ──▶  GET map.json
                                                                        │
                            6. drawScene  ◀── 5. renderable  ◀──  4. filter ◀──┘
                                    │            │                ▲
                                    │            ▼                │
                                    │      3. stitchGeometry ─────┘
                                    ▼
                                 canvas
```

### 1. Bounding-box splitting

The API rejects any bbox larger than 0.25 square degrees with a 400, and
returns whole ways rather than clipped ones. `splitBBox` therefore subdivides
the requested area into sub-boxes that respect both the hard API limit and a
much tighter `maxBBoxAreaDegrees2` of 0.0025, so responses stay small. Areas
wider than `maxQuerySpanMeters` are split into a sub-grid.

### 2. Request shape

```text
https://api.openstreetmap.org/api/0.6/map.json?bbox=west,south,east,north
```

Note the reversed axis order — the OSM API takes `west,south,east,north`, the
opposite of the Overpass convention this renderer grew out of. It is GET-only,
and it reflects the request origin in `access-control-allow-origin`, so the
browser can call it with no proxy and no preflight.

### 3. Node stitching

The API does not inline geometry. Ways arrive as `nodes: [id]` and relations
carry `members`. `stitchGeometry` rebuilds each way's coordinate list from the
node table, which is why a response can contain a way that lies entirely outside
the requested bbox — it was pulled in as a member of something that intersects.

### 4. Filtering

There is no server-side tag filter, so a bbox returns every node, way and
relation in it. `filterElements` decides what is actually drawable and drops
the rest.

### 5. Rendering

`drawScene` paints in back-to-front order: terrain wash, water, parks, building
fills, building edges, road casings, road fills. Road casing is drawn as a
wider pass beneath a narrower fill, which is what gives the 2016 roads their
cream halo.

---

## API

### Constructor

```js
new PoGoMapParser(canvasId)
```

Takes the `id` of a `<canvas>` element. Throws if the canvas or its 2D context
cannot be found. The only runtime requirement is a DOM: a browser, or a canvas
shim under Node.

### Rendering

| Method | Purpose |
| --- | --- |
| `render(elements, south, west, north, east)` | Draw onto the parser's own canvas, bbox as four loose arguments. |
| `renderTo(targetCanvas, elements, bbox)` | Draw onto any other canvas. Used to build pyramid tiles. The canvas must already have its `width`/`height` set. |
| `exportToTileImage()` | Return the current canvas as a PNG data URL. |
| `clear()` | Reset the canvas to an empty transparent state. |

### Data

| Method | Purpose |
| --- | --- |
| `fetchArea(bbox)` | Fetch a bbox and return drawable elements. Oversized areas are split into a sub-grid and fetched strictly one request at a time with pauses, then stitched back together. |
| `fetchMapData(south, west, north, east)` | As `fetchArea`, but bbox as four loose arguments. Caches by bbox and de-duplicates concurrent calls, so repeated clicks reuse one network request. |
| `mergeElements(batches)` | Combine element batches from several sub-queries. |

`lastError` holds the most recent transport or API failure as a human-readable
string, or `null` when the last request succeeded.

### Static helpers

| Method | Purpose |
| --- | --- |
| `PoGoMapParser.zoomBBox(centerLat, centerLon, zoom)` | Slippy-map bounding box; zoom 0 spans 360° of longitude, each level halves it, latitude is scaled by cos(latitude) so pixels stay square. |
| `PoGoMapParser.spanMeters(bbox)` | Approximate ground width of a bbox, for tile captions. |

### Tunables

Set these on the instance after construction:

| Property | Default | Meaning |
| --- | --- | --- |
| `onProgress` | `null` | Called with a short human-readable string per sub-query and attempt, so a slow fetch shows activity instead of looking hung. |
| `colors` | 2016 palette | See [the 2016 style](#the-2016-style). |
| `strokes` | reference weights | Road casing/fill widths, water and building edge weights, and the `minimum` floor applied when scaling down. |
| `highwayClasses` | major/mid sets | Which `highway=*` values render widest. |
| `maxBBoxAreaDegrees2` | `0.0025` | Sub-box area target. Always below the API's hard 0.25 limit. |
| `maxQuerySpanMeters` | `2000` | Above this a bbox is split into a sub-grid. |
| `maxSubQueries` | `64` | Ceiling on sub-boxes for one area. |
| `requestTimeoutMs` | `60000` | Client-side abort for a stalled request. |
| `subQueryDelayMs` | `1200` | Pause between sub-queries. |
| `maxAttemptsPerBBox` | `3` | Attempts for a single sub-query. |
| `retryBaseDelayMs` | `5000` | Base for exponential backoff. |
| `grainSeed` | `20160706` | Fixed, so the terrain grain is identical on every load. |

### Loading

The class is a plain declaration, so a `<script>` tag uses it directly. A
CommonJS export is added at the foot of the file, guarded by `typeof`, so
bundlers and Node can `require()` it at no cost to the browser:

```js
const PoGoMapParser = require('pogomapparser');
```

---

## The 2016 style

The palette was sampled from the July 2016 release and the April 2016 beta
field test. The 15 reference screenshots are in
[`docs/ref2016/`](docs/ref2016) — those are captures of the original client,
included to document the target style, not output of this renderer. The values
below are 5×5 averaged samples from them.

| Element | Colour | Notes |
| --- | --- | --- |
| Land base | `#b2f097` | Pale mint green |
| Land grain | `#a2e58f` | Soft mottled wash, not visible grain |
| Park | `#3abc86` | Deep emerald-teal |
| Water | `#38aee3` | Medium sky blue |
| Road fill | `#5c987f` | Desaturated teal-green |
| Road casing | `#f2fd95` | Pale yellow-cream |
| Building | `#9cde84` | |
| Building edge | `#86c96f` | |

Two deliberate departures from the references, both noted in the source:

- **Buildings are darker than the client showed.** The 2016 references sample
  near-white here (`#F3FDF0`), which reads as blocks dropped on top of the map.
  These sit only just darker than the mint ground, so footprints read as a
  subtle texture instead.
- **Road strokes are doubled.** At the reference weight the two-pass
  casing/fill construction dissolves into the ground colour at tile scale.
  Building edges stay at the reference `0.75`, because a heavy outline would
  dominate a fill that is barely darker than the ground.

Stroke weights are authored at the 550 px reference resolution and scale down
for smaller tiles, with a floor, so the style stays legible across a zoom
pyramid. The terrain grain uses a seeded PRNG, so the field is identical on
every load rather than re-rolling.

---

## Water rendering

Water is the part of this renderer that took the most work, because
`natural=coastline` is not an area and cannot simply be filled. Three separate
problems had to be solved:

**Recognising water.** A narrow tag vocabulary matches almost nothing. One
predicate, `isWater(tags)`, covers `waterway=*`, `water=*`,
`natural=water|coastline|bay|strait|spring|wetland`,
`landuse=reservoir|basin` and `leisure=swimming_pool`. The same predicate
drives both `isRenderable` and `drawScene`, so what is fetched and what is
painted cannot drift apart.

**Multipolygons.** Water relations arrive with `members`, not geometry, and were
being dropped entirely. `assembleMultipolygons` stitches the member ways
together, reversing them as needed to form each ring, and handling ring closure
when the far side lies outside the bbox. Inner rings are emitted with
`hole: true` and skipped by the renderer.

**Shorelines.** A coastline is an open way: there is no ring to fill. Closing it
naively against the bbox floods the whole tile, because both river banks
independently claim the entire view. Instead, shorelines and the view edge are
treated as a planar subdivision and cut into faces by a half-edge walk.

Face classification is topological rather than a ray cast. With the walk
keeping the face interior on its right, a water face walks its shoreline *with*
the way's order and a land face walks it *against* — OSM area rings are
counter-clockwise with water on the right. A face with no shoreline edges is
land. Two details that each cost a debugging session:

- `edgeHeading` takes the heading from the first segment with length, not the
  vector to the far endpoint. On a curved shore those differ enough to collide
  with an adjacent edge's bearing, which ties the sort and merges three faces
  into one.
- Half-edges carry an explicit `withWay` flag. Inferring direction from
  `from === edge.a` fails for a shore that closes on itself, where both ends are
  the same node.

Clipping is Liang–Barsky, and the sign convention matters: upper bounds need
`(dx, xmax − x₀)` for east and north, not `(−dx, …)`. Getting that wrong lets
northern and eastern geometry through unclipped while looking correct on the
other two sides.

Verified against live captures: the Harlem River fills at 8.2% of the view with
zero out-of-bounds geometry, and Central Park's "The Pool" at 2.1%.

---

## Project layout

```text
pogomapparser/
├── LICENSE              GPL-3.0, verbatim
├── README.md
├── CHANGELOG.md
├── package.json         metadata and npm scripts; no dependencies
├── .editorconfig
├── .gitignore
├── src/
│   └── PoGoMapParser.js the library. All feature logic lives here.
├── demo/
│   └── index.html       demo dashboard only; no feature logic
├── test/
│   ├── test_fetch.mjs   offline fetch, translation, clipping, water
│   └── test_single_tile.mjs  demo script against a DOM stub
├── tools/
│   └── serve.py         static file server
└── docs/
    └── ref2016/         15 style reference screenshots
```

The split is deliberate: **the demo contains no feature logic.** Every feature
added to this project belongs in `src/PoGoMapParser.js`, with the demo page
reduced to buttons that call it. The tests enforce that by executing the demo
page's inline script against a stubbed DOM.

---

## Development

```sh
npm test          # both suites, offline, no network
python tools/serve.py --port 8080
```

### Tests

| Suite | Covers |
| --- | --- |
| `test/test_fetch.mjs` | Request shape, node stitching, span cutoffs and splitting, retry and `Retry-After`, dedupe, clipping on all four bbox edges, the water tag vocabulary, multipolygon assembly, shoreline regions, and the region-to-painter path. |
| `test/test_single_tile.mjs` | The demo page's inline script — pyramid specs and single-tile rendering — against a stubbed DOM. |

Both suites are fully offline. They stub `globalThis.document` with a canvas
context stub and load the library through `new Function(...)`, so no network
access and no browser is required. Paths resolve relative to the test file, so
the suites run from any working directory.

```sh
node test/test_fetch.mjs        # 191 assertions
node test/test_single_tile.mjs
```

### Static server

`tools/serve.py` serves the repository root, answers `/health` for readiness
probes, redirects `/` to the demo, and returns JSON errors naming the real
routes instead of the stdlib's HTML 404.

```sh
python tools/serve.py --port 8080
python tools/serve.py --help
```

It probes the port before binding rather than relying on `bind()` to fail:
Windows sets `SO_REUSEADDR` by default, so a second server binds a port that is
already in use and quietly steals connections, which is far more confusing than
a clean failure.

---

## Data source and rate limits

Data comes from the [OpenStreetMap API](https://wiki.openstreetmap.org/wiki/API),
which is © OpenStreetMap contributors, available under
[ODbL](https://opendatacommons.org/licenses/odbl/). Any map you render with
this library must carry the attribution *"© OpenStreetMap contributors"*.

That API is rate limited and intended for editing use, which shapes the
defaults: requests are sequential with pauses, `Retry-After` is honoured before
anything else is tried, and timeouts are treated as retryable. If you build
something with sustained traffic, use a dedicated instance —
[OSMVectorTiles](https://github.com/eb-dev/OSMVectorTiles) or a commercial
provider — rather than the public API.

This project is not affiliated with, endorsed by, or connected to Niantic or
The Pokémon Company. It renders map data; it reproduces a visual style.

---

## Known limitations

Stated plainly, because each one is a real behaviour rather than a bug waiting
to be filed:

- **A shoreline that never touches the view edge is dropped.** A closed
  coastline ring lying strictly inside the view, with water on the *outside*, is
  unbounded: it merges with the face beyond the view and leaves no bounded
  region to fill. This is pinned as an explicit test so it cannot change by
  accident. Real shores get resolved by crossing the view.
- **A region larger than the view is discarded.** A keyhole face from a shore
  grazing the view edge can measure larger than the view itself; such a region
  is dropped rather than painted over everything.
- **Geometry is fetched whole and clipped client-side.** The API returns whole
  ways, so a response is larger than the visible area. This is a bandwidth cost,
  not a correctness problem — `outside=0` on every capture.
- **No tile cache to disk.** Re-renders reuse in-flight and in-memory data for
  the page's lifetime only.
- **The style is not a general-purpose OSM style.** It renders a fixed 2016
  palette with a fixed tag subset. Extending it means editing `colors`,
  `highwayClasses` and the predicates.

---

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE) for the full text.

This is free software: you can redistribute it and/or modify it under the terms
of the GNU General Public License as published by the Free Software Foundation,
either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.

Map data © OpenStreetMap contributors, licensed under the ODbL.
