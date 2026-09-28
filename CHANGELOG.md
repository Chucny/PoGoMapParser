# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Water rendering, covering the whole path from tags to filled canvas:
  - `isWater(tags)`, a single predicate shared by `isRenderable` and
    `drawScene` so what is fetched and what is painted cannot drift apart.
    Recognises `waterway=*`, `water=*`,
    `natural=water|coastline|bay|strait|spring|wetland`,
    `landuse=reservoir|basin` and `leisure=swimming_pool`.
  - `isClosed(geometry)` and `signedArea(geometry)` static helpers.
  - `assembleMultipolygons(elements, coords, bbox)`, which stitches relation
    member ways into rings, reversing them as needed and handling ring closure
    when the far side lies outside the bbox. Inner rings are emitted with
    `hole: true` and skipped by the renderer.
  - `coastlineRegions(coastlines, bbox)`, which treats shorelines and the view
    edge as a planar subdivision, cuts it into faces with a half-edge walk, and
    classifies each face topologically rather than by ray cast.
  - `snapToPerimeter`, `edgeHeading`, `perimeterT`, `bboxCorners`,
    `perimeterCornersBetween` and `axisCrossing` supporting the above.
- Liang–Barsky clipping: `clipToBBox`, `clipPolyline`, `clipSegment` and
  `clipPolygon`, applied to every geometry before it reaches the painter.
- `closeAgainstBBox` now prefers the **counter-clockwise** closure. OSM area
  rings run counter-clockwise, so closing counter-clockwise keeps water inside;
  the previous clockwise preference put it outside.
- Guard dropping any water region whose `|signedArea|` exceeds the view area,
  which catches keyhole faces from a shore grazing the view edge.
- Half-edges in the face walk carry an explicit `withWay` flag instead of
  inferring direction from `from === edge.a`, which fails for a shore that
  closes on itself where both ends are the same node.
- A 25-level zoom pyramid (z10–z34) and a single-tile renderer in the demo,
  both sharing the library.
- A static server, `tools/serve.py`, with readiness routes, a root redirect and
  JSON errors that name the real routes.

### Fixed

- Clipping sign error. Liang–Barsky needs `(dx, xmax − x₀)` for upper bounds
  (east and north), not `(−dx, …)` for all four cases. The wrong sign let
  northern and eastern geometry through unclipped while looking correct on the
  other two sides. `outside=0` on every capture after the fix.
- `assembleMultipolygons` now clips to the bbox; it was the source of
  out-of-view geometry.
- `edgeHeading` takes its heading from the first segment with length rather than
  the vector to the far endpoint. On a curved shore the two differ enough to
  collide with an adjacent edge's bearing, which tied the sort and merged three
  faces into one. This was the real cause of a shoreline failing to render.

### Changed

- Migrated from Overpass to the official OpenStreetMap API:
  `https://api.openstreetmap.org/api/0.6/map.json`, GET-only, bbox order
  `west,south,east,north`. That endpoint reflects the request origin in
  `access-control-allow-origin`, so the browser calls it directly and no local
  proxy is involved.
- Ways are stitched from `nodes: [id]` and relations from `members`, since the
  API returns no inline geometry.
- `filterElements` does the tag filtering client-side, because the API has no
  tag filter.
- Error classification split into `retryAfterMs`, `osmHttpError`,
  `networkError` and `errorDetail`, so a 429 with `Retry-After` is honoured
  before anything else is tried.
- Buildings restyled to sit only just darker than the mint ground, so
  footprints read as texture rather than as blocks.
- Road stroke weights doubled from the 2016 reference measurements; building
  edges stay at the reference 0.75.
- Restructured into `src/`, `demo/`, `test/`, `tools/` and `docs/`. The demo
  keeps no feature logic.
- `tools/serve.py` dropped its `/overpass` relay, which had no callers left
  after the migration to the OSM API. It probes the port before binding, because
  Windows sets `SO_REUSEADDR` and a second bind on a live port succeeds while
  stealing connections.

### Known limitations

- A `natural=coastline` ring lying strictly inside the view with water on the
  outside is not rendered. The region is unbounded, merges with the face beyond
  the view, and leaves nothing bounded to fill. Pinned by a test so it cannot
  change by accident.
- Any water region larger than the view area is discarded.

## [1.0.0]

Initial release: canvas renderer, OSM API fetch pipeline, the 2016 palette
sampled from the July 2016 release and the April 2016 beta field test, and the
offline test harness.

[Unreleased]: https://github.com/pogomapparser/pogomapparser/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/pogomapparser/pogomapparser/releases/tag/v1.0.0
