/**
 * PoGoMapParser
 * 2D OpenStreetMap tile renderer matching the 2016 Pokémon GO map aesthetic.
 *
 * Copyright (C) 2026 PoGoMapParser contributors
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version. This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file for details.
 *
 * The only runtime dependency is a DOM: a browser, or a canvas shim under Node.
 * The class is a plain declaration so a <script> tag can use it directly, with a
 * CommonJS export added at the foot of the file for bundlers and Node.
 *
 * Style reference: 15 screenshots from the July 2016 release and the April 2016
 * beta field test. Measured palette anchors (5x5 averaged samples):
 *   land base   #B1FE98 / #CCFEC1 / #C6FEB9  (pale mint green)
 *   park fill   #05B08D / #36BE91           (deep emerald-teal)
 *   water       #31B7E5 / #3DC0E7 / #3299E1 (medium sky blue)
 *   road fill   #5B9880 / #5D9A83           (desaturated teal-green)
 *   road casing #EFFE98 / #FBFE96           (pale yellow-cream)
 *   buildings   #F3FDF0                     (near-white with a green tint)
 *     ...departed from on purpose: buildings are painted only just darker than
 *     the mint ground (#9cde84 fill, #86c96f edge) so footprints read as a
 *     subtle texture on the map. Road stroke weights are doubled from the
 *     reference.
 *
 * Data: the official OpenStreetMap API, https://api.openstreetmap.org.
 *
 * That endpoint answers with `access-control-allow-origin` set to the calling
 * origin, so the page fetches it directly from the browser — no local proxy, no
 * User-Agent games. It is GET-only and reflects the request origin, so no
 * preflight is triggered by this request. The demo therefore needs only a
 * static file server, never an API relay.
 *
 * The OSM API is not a query engine, which shapes the rest of this file:
 *   - There is no tag filter, so a bbox returns every node, way and relation
 *     inside it and the filtering happens here, in `filterElements`.
 *   - Ways carry `nodes: [id]` rather than a geometry array, so
 *     `stitchGeometry` rebuilds each way's coordinates from its member nodes.
 *   - Only GET is allowed, so requests are GET with the bbox in the query
 *     string rather than POSTed Overpass QL.
 *   - A bbox may not exceed 0.25 square degrees, so `splitBBox` keeps every
 *     sub-box well under that.
 *   - It is rate limited and meant for editing, so requests stay strictly
 *     sequential with pauses, honour Retry-After, and back off on 429/400.
 */
class PoGoMapParser {
    /**
     * The API's own hard bbox limit: a request larger than this is refused with
     * HTTP 400, so `splitBBox` guarantees every sub-box stays under it. Measured
     * from the API's own error text, not assumed.
     */
    static apiMaxBBoxAreaDegrees2 = 0.25;

    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) throw new Error(`Canvas element with id "${canvasId}" not found.`);
        this.ctx = this.canvas.getContext('2d');
        if (!this.ctx) throw new Error(`Could not acquire a 2d context for canvas "${canvasId}".`);

        // Caching structures for fast re-renders
        this.terrainTile = null;
        this.mapCache = new Map();
        // In-flight API requests, so repeated clicks reuse a single network call
        this.pendingRequests = new Map();
        // Most recent transport/API failure, surfaced by the UI for diagnostics
        this.lastError = null;

        // The one and only data source: the official OpenStreetMap API. It
        // reflects the request origin in `access-control-allow-origin`, so the
        // page talks to it directly and needs no local proxy.
        this.osmApiEndpoint = 'https://api.openstreetmap.org/api/0.6/map.json';

        // The API caps a bbox at 0.25 square degrees and refuses larger ones
        // with 400 "The maximum bbox size is 0.25 degrees"; that hard number
        // lives in apiMaxBBoxAreaDegrees2 and is never exceeded by a sub-box.
        // This is the far lower target we aim for, so responses stay small.
        this.maxBBoxAreaDegrees2 = 0.0025;
        this.maxQuerySpanMeters = 2000;    // Above this a bbox is split into a sub-grid
        this.maxSubQueries = 64;           // Ceiling on sub-boxes for one area

        // Request tuning. This API is rate limited and intended for editing
        // use, so requests are sequential with pauses, and a 429 is honoured
        // via Retry-After before anything else is tried.
        this.requestTimeoutMs = 60000;     // Client-side abort for a stalled request
        this.subQueryDelayMs = 1200;       // Pause between sub-queries
        this.maxAttemptsPerBBox = 3;       // Attempts for a single sub-query
        this.retryBaseDelayMs = 5000;      // Base for exponential backoff between attempts

        // Optional progress hook: called with a short human-readable string for
        // every sub-query and attempt, so a slow fetch shows visible activity
        // instead of looking hung.
        this.onProgress = null;

        // Terrain tuning
        this.grainTileSize = 128;   // Noise tile period. Larger = less obvious repetition.
        this.grainDensity = 0.05;   // Share of pixels tinted darker. The 2016 fields are
                                    // mostly a soft mottled wash, not visible grain.
        this.grainSeed = 20160706;  // Fixed seed: the field is identical on every load.

        // Stroke weights at the 550px reference resolution. Smaller tiles scale these
        // down (with a floor) so the style stays legible across a zoom pyramid.
        this.referenceWidth = 550;
        // Road weights are deliberately double the 2016 reference measurements,
        // so the two-pass casing/fill construction reads clearly at tile scale
        // rather than dissolving into the ground colour. Building edges stay at
        // the reference weight: a heavy outline would dominate a fill that is
        // only just darker than the ground.
        this.strokes = {
            roadCasingMajor: 14, roadFillMajor: 9,
            roadCasingMid: 10, roadFillMid: 6,
            roadCasingMinor: 6, roadFillMinor: 3.6,
            water: 4, buildingEdge: 0.75, minimum: 0.6
        };

        // 2016 Pokémon GO palette, sampled from release screenshots (see header).
        this.colors = {
            land: '#b2f097',
            grain: '#a2e58f',
            park: '#3abc86',
            water: '#38aee3',
            roadFill: '#5c987f',
            roadCasing: '#f2fd95',
            // Deliberate departure from the 2016 references, which sampled
            // near-white here (#F3FDF0). These sit only just darker than the mint
            // ground, so footprints read as a subtle texture on the map rather
            // than as blocks dropped on top of it.
            building: '#9cde84',
            buildingEdge: '#86c96f'
        };

        // Highway classes by visual weight. Major roads stay visible for kilometres;
        // footways and tracks only matter at street level.
        this.highwayClasses = {
            major: new Set(['motorway', 'trunk', 'primary']),
            mid: new Set(['secondary', 'tertiary', 'unclassified', 'residential',
                'living_street', 'service'])
        };

        this.initTerrainTile();
        this.clear();
    }

    /**
     * Deterministic pseudo-random generator, so the terrain is identical on every
     * load instead of re-rolling each time.
     */
    static mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /** Expands a `#rrggbb` string into an `[r, g, b]` triple. */
    static hexToRgb(hex) {
        const value = parseInt(String(hex).replace('#', ''), 16);
        return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    }

    /**
     * Builds the ground tile: a pale mint wash with large soft tonal blotches
     * (the cloudy mottling visible in every 2016 screenshot) plus a sparse
     * darker grain. A repeating tile is seamless by construction.
     */
    initTerrainTile() {
        const size = this.grainTileSize;
        const tile = document.createElement('canvas');
        tile.width = size;
        tile.height = size;
        const tCtx = tile.getContext('2d');
        if (!tCtx) throw new Error('Could not acquire a 2d context for the terrain tile.');

        // Base mint lawn
        tCtx.fillStyle = this.colors.land;
        tCtx.fillRect(0, 0, size, size);

        const random = PoGoMapParser.mulberry32(this.grainSeed);

        // Soft tonal blotches
        const blobs = Math.floor((size * size) / 900);
        for (let i = 0; i < blobs; i++) {
            const x = random() * size;
            const y = random() * size;
            const r = size * (0.08 + random() * 0.22);
            const g = tCtx.createRadialGradient(x, y, 0, x, y, r);
            if (random() < 0.5) {
                g.addColorStop(0, 'rgba(140,210,130,0.10)');
            } else {
                g.addColorStop(0, 'rgba(230,255,220,0.10)');
            }
            g.addColorStop(1, 'rgba(0,0,0,0)');
            tCtx.fillStyle = g;
            tCtx.beginPath();
            tCtx.arc(x, y, r, 0, 7);
            tCtx.fill();
        }

        // Sparse darker grain pixels
        const [dr, dg, db] = PoGoMapParser.hexToRgb(this.colors.grain);
        const image = tCtx.getImageData(0, 0, size, size);
        const pixels = image.data;
        for (let i = 0; i < pixels.length; i += 4) {
            if (random() >= this.grainDensity) continue;
            pixels[i] = dr;
            pixels[i + 1] = dg;
            pixels[i + 2] = db;
        }
        tCtx.putImageData(image, 0, 0);
        this.terrainTile = tile;
    }

    /**
     * Binds the ground tile to a specific 2d context. A CanvasPattern is created
     * per context, so every tile canvas needs its own pattern instance.
     */
    createTerrainPattern(ctx) {
        if (!this.terrainTile) return this.colors.land;
        const pattern = ctx.createPattern(this.terrainTile, 'repeat');
        // Assigning a null pattern to fillStyle throws, so fall back to flat land
        return pattern || this.colors.land;
    }

    /**
     * Fetches spatial map features inside a Bounding Box.
     * Large boxes are split into a sub-grid fetched strictly one request at a
     * time with pauses in between, so no single response is big enough to time out.
     */
    async fetchMapData(south, west, north, east) {
        const cacheKey = `${south},${west},${north},${east}`;

        if (this.mapCache.has(cacheKey)) return this.mapCache.get(cacheKey);
        if (this.pendingRequests.has(cacheKey)) return this.pendingRequests.get(cacheKey);

        const request = this.fetchArea({ south, west, north, east })
            .then(elements => {
                this.mapCache.set(cacheKey, elements);
                return elements;
            })
            .finally(() => {
                this.pendingRequests.delete(cacheKey);
            });

        this.pendingRequests.set(cacheKey, request);
        return request;
    }

    /**
     * Splits an oversized bbox and fetches the parts sequentially with a pause
     * between each, then stitches the results back together.
     */
    async fetchArea(bbox) {
        // Buildings are sub-pixel across a wide view, so only request them when the
        // whole area is at street-level span. This keeps coarse responses small.
        const includeBuildings = PoGoMapParser.spanMeters(bbox) <= 1500;
        const parts = this.splitBBox(bbox);

        const batches = [];
        for (let i = 0; i < parts.length; i++) {
            this.report(`sub-query ${i + 1}/${parts.length} ...`);
            batches.push(await this.fetchSubBBox(parts[i], includeBuildings));
            if (i < parts.length - 1) await this.delay(this.subQueryDelayMs);
        }

        return this.mergeElements(batches);
    }

    /** Emits a progress string to the optional onProgress hook, never throwing. */
    report(message) {
        if (typeof this.onProgress !== 'function') return;
        try {
            this.onProgress(message);
        } catch (ignore) {
            // A broken UI hook must never break data fetching.
        }
    }

    /**
     * Breaks a bbox into a square grid so that each request covers roughly
     * `maxQuerySpanMeters`. Returns a single-element array when it is already small.
     *
     * Three pressures decide the grid: the per-request span target, the response
     * size target, and the API's own hard bbox limit. The hard limit is treated as
     * a floor rather than a target, because a sub-box over it is rejected with a
     * 400 that no retry can fix, whereas a sub-box over the size target merely
     * answers slowly.
     */
    splitBBox(bbox) {
        const spanMeters = PoGoMapParser.spanMeters(bbox);
        const area = Math.abs((bbox.north - bbox.south) * (bbox.east - bbox.west));

        const byArea = area > this.maxBBoxAreaDegrees2
            ? Math.ceil(Math.sqrt(area / this.maxBBoxAreaDegrees2))
            : 1;
        const bySpan = spanMeters > this.maxQuerySpanMeters
            ? Math.ceil(spanMeters / this.maxQuerySpanMeters)
            : 1;
        const byHardLimit = area > PoGoMapParser.apiMaxBBoxAreaDegrees2
            ? Math.ceil(Math.sqrt(area / PoGoMapParser.apiMaxBBoxAreaDegrees2))
            : 1;

        if (byArea <= 1 && bySpan <= 1 && byHardLimit <= 1) return [bbox];

        const wanted = Math.max(byArea, bySpan, byHardLimit);
        // The request budget is a total, so it caps the grid's side length rather
        // than its area. Below that cap the hard limit always wins, so an
        // ordinary view can never produce a request the API will reject.
        const maxSide = Math.max(1, Math.floor(Math.sqrt(this.maxSubQueries)));
        const divisions = Math.min(maxSide, wanted);
        if (byHardLimit > maxSide) {
            // Far too large to satisfy within the request budget. Say so rather
            // than letting a wall of silent HTTP 400s stand in for the reason.
            this.report(`area is too large to fetch in full: it would need a ` +
                `${byHardLimit}x${byHardLimit} grid, so only ${divisions}x${divisions} ` +
                `sub-boxes are requested and the rest will be rejected`);
        }
        const latStep = (bbox.north - bbox.south) / divisions;
        const lonStep = (bbox.east - bbox.west) / divisions;

        const parts = [];
        for (let row = 0; row < divisions; row++) {
            for (let col = 0; col < divisions; col++) {
                // bboxes are inclusive, so overlap slightly to avoid
                // dropping ways that sit exactly on a shared edge
                const overlap = 1e-9;
                parts.push({
                    south: bbox.south + row * latStep - overlap,
                    west: bbox.west + col * lonStep - overlap,
                    north: bbox.south + (row + 1) * latStep + overlap,
                    east: bbox.west + (col + 1) * lonStep + overlap
                });
            }
        }
        return parts;
    }

    /**
     * Fetches one sub-box from the OSM API, retrying transient failures with
     * exponential backoff. Returns an empty array if every attempt fails, so
     * one bad sub-box never sinks the whole area.
     */
    async fetchSubBBox(bbox, includeBuildings) {
        let lastError = null;

        for (let attempt = 0; attempt < this.maxAttemptsPerBBox; attempt++) {
            try {
                return await this.requestMapBox(bbox, includeBuildings);
            } catch (error) {
                lastError = error;
                // A rejected request (bad bbox, oversized area) fails identically
                // on retry, so stop early instead of adding load.
                if (error.fatal) {
                    this.lastError = error.message;
                    console.error('PoGoMapParser query error:', error);
                    return [];
                }
            }
            if (attempt < this.maxAttemptsPerBBox - 1) {
                // Exponential backoff with jitter, honouring the server's own
                // cool-down when it sends Retry-After. A 429 here is the OSM API
                // asking for slower use, so waiting is the only correct response.
                const wait = Math.max(
                    (lastError && lastError.retryAfterMs) || 0,
                    this.retryBaseDelayMs * Math.pow(2, attempt) + Math.random() * 500
                );
                this.report(`retrying in ${(wait / 1000).toFixed(1)}s ` +
                    `(${lastError ? lastError.message : 'failed'})`);
                await this.delay(wait);
            }
        }

        this.lastError = lastError ? lastError.message : 'OSM API request failed.';
        console.error('PoGoMapParser fetch error:', lastError);
        return [];
    }

    /**
     * Runs one GET against the OSM API with a client-side timeout, so a stalled
     * request is abandoned instead of hanging the sequential queue forever.
     *
     * The bbox goes in the query string because this API is GET-only. No custom
     * headers are set, so the browser sends no preflight: the API allows
     * `GET, HEAD, OPTIONS` and reflects the calling origin, which is what makes
     * this work straight from the page with no local proxy.
     */
    async requestMapBox(bbox, includeBuildings) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        try {
            const response = await fetch(this.buildRequestUrl(bbox), {
                method: 'GET',
                signal: controller.signal
            });

            const raw = await response.text();
            if (!response.ok) throw PoGoMapParser.osmHttpError(response, raw);

            let data;
            try {
                data = JSON.parse(raw);
            } catch (parseError) {
                const error = new Error('OSM API returned an unreadable response (not JSON).');
                error.fatal = false;
                // The response did arrive, so stamp it with its status. Without
                // this the catch below reads it as a transport failure and blames
                // the connection for what is really a bad body.
                error.status = response.status;
                throw error;
            }

            const elements = Array.isArray(data.elements) ? data.elements : [];
            return this.filterElements(elements, includeBuildings, bbox);
        } catch (error) {
            if (error && error.fatal) throw error;
            if (error && error.name === 'AbortError') {
                const timeoutError = new Error(
                    `OSM API timed out after ${this.requestTimeoutMs / 1000}s`
                );
                timeoutError.fatal = false;
                timeoutError.code = 'timeout';
                throw timeoutError;
            }
            // Anything that reached here with an HTTP status came from the server,
            // so its own message is the useful one. A bare TypeError means the
            // request never produced a response at all, which says nothing about
            // the query and everything about the connection.
            if (error && typeof error.status === 'number') throw error;
            throw PoGoMapParser.networkError(error);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Builds the request URL for a bbox. The OSM API takes the bbox as
     * `left,bottom,right,top` — note that is lon,lat,lon,lat, the reverse of
     * Overpass's south,west,north,east.
     */
    buildRequestUrl(bbox) {
        const { south, west, north, east } = bbox;
        const params = new URLSearchParams({ bbox: `${west},${south},${east},${north}` });
        return `${this.osmApiEndpoint}?${params.toString()}`;
    }

    /**
     * The OSM API has no query language, so a bbox returns every element inside
     * it. This keeps only the feature types the 2016 style actually paints, then
     * rebuilds way geometry from their member nodes.
     *
     * The span-driven detail cutoffs that used to live in the Overpass query are
     * applied here instead, because nothing upstream narrows the result set any
     * more: in a dense city minor ways outnumber major roads hundreds to one
     * while rendering sub-pixel, so coarse levels drop them. Water and parks are
     * never dropped — they read at every scale.
     *
     * Returns elements in the same shape the renderer has always taken
     * (`geometry` arrays), so the painter is unchanged.
     */
    filterElements(elements, includeBuildings, bbox) {
        const span = bbox ? PoGoMapParser.spanMeters(bbox) : 0;
        const keepResidential = span <= 1500;
        const keepMinorRoads = span <= 500;

        const coords = new Map();  // node id -> {lat, lon}
        for (const el of elements) {
            if (el && el.type === 'node' && el.id !== undefined &&
                typeof el.lat === 'number' && typeof el.lon === 'number') {
                coords.set(el.id, { lat: el.lat, lon: el.lon });
            }
        }

        const kept = [];
        const coastlines = [];
        for (const el of elements) {
            if (!el || !el.tags) continue;

            // Relations have no `nodes`; their geometry is rebuilt from member
            // ways by `assembleMultipolygons`, which runs below.
            if (el.type !== 'way') continue;
            if (!Array.isArray(el.nodes) || el.nodes.length < 2) continue;

            if (el.tags.highway) {
                const tier = this.roadTier(el.tags);
                if (tier === 'minor' && !keepMinorRoads) continue;
                if (tier === 'mid' && !keepResidential) continue;
            } else if (!this.isRenderable(el.tags)) {
                continue;
            }
            // Buildings are sub-pixel across a wide view, so they are dropped at
            // coarse spans even though they came down in the same response.
            if (el.tags.building && !includeBuildings) continue;

            let geometry = this.stitchGeometry(el.nodes, coords);
            if (geometry.length < 2) continue;  // member nodes missing from the bbox

            // The API returns whole ways, not the part inside the view, so a
            // coastline can arrive lying entirely outside the bbox and a river can
            // carry nodes hundreds of metres past the edge. Painting that as-is
            // smears geometry across the tile and fills the wrong side of the
            // coast, so everything is cut down to the view first.
            if (bbox) geometry = this.clipToBBox(geometry, bbox);
            if (geometry.length < 2) continue;

            // A shoreline bounds water only together with the view edge and the
            // other shorelines, so it is set aside and cut into regions below.
            if (bbox && el.tags.natural === 'coastline') {
                coastlines.push(geometry);
                continue;
            }

            // A water body running past the edge of the view comes back open, so
            // its ring is closed along the edge rather than left as a hairline.
            if (bbox && this.isWater(el.tags) && this.isWaterArea({ tags: el.tags, geometry })) {
                geometry = this.closeAgainstBBox(geometry, bbox);
            }

            kept.push({ type: 'way', id: el.id, tags: el.tags, geometry });
        }

        // Large water is usually mapped as a multipolygon relation rather than a
        // single way, so it only appears once the relations are reassembled.
        kept.push(...this.assembleMultipolygons(elements, coords, bbox));
        kept.push(...this.coastlineRegions(coastlines, bbox));

        return kept;
    }

    /**
     * Rebuilds multipolygon relations from their member ways. OSM does not store
     * a relation's geometry: it is the ordered set of member ways joined at their
     * shared end nodes, so that is what this walks.
     *
     * Only relations this style paints are rebuilt. `inner` rings are emitted
     * flagged as holes and are not filled, so islands read as land rather than
     * as water inside a water body.
     */
    assembleMultipolygons(elements, coords, bbox) {
        const ways = new Map();
        for (const el of elements) {
            if (el && el.type === 'way' && el.id !== undefined) ways.set(el.id, el);
        }
        if (ways.size === 0) return [];

        const out = [];
        for (const rel of elements) {
            if (!rel || rel.type !== 'relation' || !rel.tags || !Array.isArray(rel.members)) continue;
            if (!this.isRenderable(rel.tags)) continue;
            if (rel.tags.type && rel.tags.type !== 'multipolygon') continue;
            if (!rel.members.some(m => m && m.role === 'outer')) continue;

            // Index members by each end node so consecutive ways can be joined.
            const byEnd = new Map();
            for (const m of rel.members) {
                const way = ways.get(m && m.ref);
                if (!way || !Array.isArray(way.nodes) || way.nodes.length < 2) continue;
                for (const end of [way.nodes[0], way.nodes[way.nodes.length - 1]]) {
                    if (!byEnd.has(end)) byEnd.set(end, []);
                    byEnd.get(end).push(way);
                }
            }
            const used = new Set();

            for (const role of ['outer', 'inner']) {
                const members = rel.members.filter(m => m && m.role === role);
                // Start from an unvisited member, then follow the chain of ways
                // that share an endpoint until it loops or runs out. The seed is
                // marked visited up front: a member whose way lies outside the
                // response has nothing to follow, and without that the loop would
                // keep re-picking the same unusable member forever.
                for (;;) {
                    const seed = members.find(m => !used.has(m.ref));
                    if (!seed) break;
                    used.add(seed.ref);

                    const chain = [];
                    let current = ways.get(seed.ref);
                    while (current && !used.has(current.id)) {
                        used.add(current.id);
                        chain.push(current);
                        const tail = current.nodes[current.nodes.length - 1];
                        const next = (byEnd.get(tail) || []).find(w => !used.has(w.id));
                        current = next;
                    }

                    const nodeIds = [];
                    for (const way of chain) {
                        const reversed = nodeIds.length > 0
                            && nodeIds[nodeIds.length - 1] !== way.nodes[0]
                            && way.nodes[way.nodes.length - 1] === nodeIds[nodeIds.length - 1];
                        const ids = reversed ? way.nodes.slice().reverse() : way.nodes;
                        for (const id of ids) {
                            if (nodeIds[nodeIds.length - 1] !== id) nodeIds.push(id);
                        }
                    }
                    let geometry = this.stitchGeometry(nodeIds, coords);
                    if (geometry.length < 3) continue;  // a ring needs three points
                    // Member ways run well past the view, exactly as a single way
                    // does, so they are cut down before anything is painted.
                    if (bbox) geometry = this.clipToBBox(geometry, bbox);
                    if (geometry.length < 3) continue;

                    if (bbox && this.isWater(rel.tags) && !this.isClosed(geometry)) {
                        geometry = this.closeAgainstBBox(geometry, bbox);
                    }

                    out.push({
                        type: 'relation',
                        id: rel.id,
                        tags: rel.tags,
                        geometry,
                        hole: role === 'inner'
                    });
                }
            }
        }
        return out;
    }

    /** True for a tagged element this renderer paints. */
    isRenderable(tags) {
        if (!tags) return false;
        if (tags.highway) return true;
        if (tags.building && tags.building !== 'no') return true;
        if (this.isWater(tags)) return true;
        return this.isPark(tags);
    }

    /**
     * True for anything that paints as water.
     *
     * The vocabulary is deliberately broad. `natural=water` and `waterway=*` alone
     * miss most real water, because a large body is usually mapped as a
     * `natural=coastline` boundary rather than an area, and reservoirs, pools,
     * straits and wetlands all carry their own keys. Missing any of these is why
     * a harbour or a river can be entirely absent from a view that should be
     * mostly blue.
     */
    isWater(tags) {
        if (!tags) return false;
        // Linear and areal watercourses, plus the odd tagged pond.
        if (tags.waterway) return true;
        if (tags.water) return true;
        switch (tags.natural) {
            case 'water':
            case 'coastline':
            case 'bay':
            case 'strait':
            case 'spring':
            case 'wetland':
                return true;
            default:
                break;
        }
        if (tags.landuse === 'reservoir' || tags.landuse === 'basin') return true;
        if (tags.leisure === 'swimming_pool') return true;
        return false;
    }

    /** True when a ring's last point lands back on its first. */
    isClosed(geometry) {
        if (!Array.isArray(geometry) || geometry.length < 3) return false;
        const first = geometry[0];
        const last = geometry[geometry.length - 1];
        return first.lat === last.lat && first.lon === last.lon;
    }

    /** Where a segment meets an axis-aligned boundary, as a point. */
    static axisCrossing(a, b, axis, value) {
        const key = axis === 'lat' ? 'lat' : 'lon';
        const span = b[key] - a[key];
        if (span === 0) return { lat: a.lat, lon: a.lon };
        const t = (value - a[key]) / span;
        return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
    }

    /**
     * The part of a segment inside the view, or null when it lies wholly outside.
     * A plain parametric clip: if the ends straddle a boundary, the crossing
     * point is interpolated.
     */
    static clipSegment(a, b, bbox) {
        const { south, west, north, east } = bbox;
        let t0 = 0;
        let t1 = 1;
        const dx = b.lon - a.lon;
        const dy = b.lat - a.lat;
        // Each bound is rewritten as `t * p <= q`, which makes p positive an
        // upper limit on t and p negative a lower one. The two edges the segment
        // runs towards therefore carry the unscaled delta and the two it runs
        // away from carry its negation.
        const tests = [
            [-dx, a.lon - west],   // west: lon >= west
            [dx, east - a.lon],    // east: lon <= east
            [-dy, a.lat - south],  // south: lat >= south
            [dy, north - a.lat]    // north: lat <= north
        ];
        for (const [p, q] of tests) {
            if (p === 0) {
                if (q < 0) return null;   // parallel to this edge and outside it
                continue;
            }
            const r = q / p;
            if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
            else { if (r < t0) return null; if (r < t1) t1 = r; }
        }
        const at = (t) => ({ lat: a.lat + t * dy, lon: a.lon + t * dx });
        return [at(t0), at(t1)];
    }

    /**
     * Cuts a line down to the view. Segments outside the view are dropped, which
     * can split the line; the longest surviving run is returned, because joining
     * the pieces back together would draw a line straight across the map.
     */
    clipPolyline(geometry, bbox) {
        const runs = [];
        let run = [];
        for (let i = 0; i < geometry.length - 1; i++) {
            const seg = PoGoMapParser.clipSegment(geometry[i], geometry[i + 1], bbox);
            if (!seg) {
                if (run.length > 1) runs.push(run);
                run = [];
                continue;
            }
            if (run.length === 0) run = [seg[0], seg[1]];
            else run.push(seg[1]);
        }
        if (run.length > 1) runs.push(run);
        if (runs.length === 0) return [];
        return runs.reduce((a, b) => (b.length > a.length ? b : a));
    }

    /**
     * Cuts a closed ring down to the view (Sutherland-Hodgman). Correct for the
     * convex and mildly concave rings this style draws; a ring that the view cuts
     * into a shape needing an inward notch can come out with a flat edge, which
     * is a small visual simplification rather than a wrong fill.
     */
    clipPolygon(geometry, bbox) {
        const { south, west, north, east } = bbox;
        const edges = [
            { inside: (p) => p.lat >= south, axis: 'lat', value: south },
            { inside: (p) => p.lat <= north, axis: 'lat', value: north },
            { inside: (p) => p.lon >= west, axis: 'lon', value: west },
            { inside: (p) => p.lon <= east, axis: 'lon', value: east }
        ];

        let output = geometry.slice();
        for (const edge of edges) {
            if (output.length === 0) return [];
            const input = output;
            output = [];
            for (let i = 0; i < input.length; i++) {
                const cur = input[i];
                const prev = input[(i + input.length - 1) % input.length];
                const curIn = edge.inside(cur);
                const prevIn = edge.inside(prev);
                if (curIn) {
                    if (!prevIn) output.push(PoGoMapParser.axisCrossing(prev, cur, edge.axis, edge.value));
                    output.push(cur);
                } else if (prevIn) {
                    output.push(PoGoMapParser.axisCrossing(prev, cur, edge.axis, edge.value));
                }
            }
        }
        return output;
    }

    /**
     * Cuts any geometry down to the view, choosing the closed or open treatment
     * by whether the ring closes on itself. This is the step that makes out-of-view
     * geometry safe to draw, and it has to happen before anything is closed
     * against the view boundary.
     */
    clipToBBox(geometry, bbox) {
        if (!Array.isArray(geometry) || geometry.length < 2) return [];
        if (!bbox || !(bbox.north > bbox.south) || !(bbox.east > bbox.west)) return geometry;
        return this.isClosed(geometry)
            ? this.clipPolygon(geometry, bbox)
            : this.clipPolyline(geometry, bbox);
    }

    /** Signed area in square degrees; negative means clockwise. */
    static signedArea(geometry) {
        let total = 0;
        for (let i = 0; i < geometry.length - 1; i++) {
            total += geometry[i].lon * geometry[i + 1].lat
                - geometry[i + 1].lon * geometry[i].lat;
        }
        return total / 2;
    }

    /**
     * Where a point sits along the view's perimeter, as a value in [0, 4) that
     * counts the four edges clockwise from the top-left corner. Used to walk the
     * boundary when closing an open waterway.
     */
    static perimeterT(point, bbox) {
        const { south, west, north, east } = bbox;
        const lonSpan = east - west;
        const latSpan = north - south;
        if (!(lonSpan > 0) || !(latSpan > 0)) return 0;

        // Distance to each edge, so a point sitting on a corner resolves to the
        // edge it was clipped by rather than to an arbitrary one.
        const toTop = Math.abs(point.lat - north);
        const toBottom = Math.abs(point.lat - south);
        const toLeft = Math.abs(point.lon - west);
        const toRight = Math.abs(point.lon - east);

        const clamp01 = (v) => Math.min(1, Math.max(0, v));
        if (toTop <= toBottom && toTop <= toLeft && toTop <= toRight) {
            return clamp01((point.lon - west) / lonSpan);                       // top
        }
        if (toRight <= toLeft && toRight <= toBottom) {
            return 1 + clamp01((north - point.lat) / latSpan);                  // right
        }
        if (toBottom <= toLeft) {
            return 2 + clamp01((east - point.lon) / lonSpan);                   // bottom
        }
        return 3 + clamp01((point.lat - south) / latSpan);                     // left
    }

    /** The view's corners in the same clockwise order as `perimeterT`. */
    static bboxCorners(bbox) {
        const { south, west, north, east } = bbox;
        return [
            { lat: north, lon: west },
            { lat: north, lon: east },
            { lat: south, lon: east },
            { lat: south, lon: west }
        ];
    }

    /**
     * The corner positions crossed when walking the perimeter from one position
     * to another, excluding both endpoints. `step` is +1 or -1 for direction.
     */
    static perimeterCornersBetween(corners, from, to, step) {
        const arc = [];
        // How far along the loop the head is, in the chosen direction.
        const distance = (((step > 0 ? to - from : from - to) % 4) + 4) % 4;

        let pos = from;
        let remaining = distance;
        for (let guard = 0; guard < 5 && remaining > 1e-9; guard++) {
            // Distance from `pos` forward to the next corner, in the walk's direction.
            const toNext = step > 0 ? Math.ceil(pos + 1e-12) - pos : pos - Math.floor(pos - 1e-12);
            if (toNext <= 1e-12 || toNext > remaining) break;
            pos += step * toNext;
            remaining -= toNext;
            arc.push(corners[((Math.round(pos) % 4) + 4) % 4]);
        }
        return arc;
    }

    /**
     * Closes an open water ring against the edges of the view so it can be filled.
     *
     * A lake or reservoir that runs past the edge of the view comes back as an
     * open line, and filling a line draws a hairline rather than a body of water.
     * The ring is closed along the view boundary instead. There are two ways
     * round, and the one taken is the one that keeps the water on the inside:
     * OSM maps area rings counter-clockwise, so the counter-clockwise result is
     * the correct side. (Shorelines are not closed this way, because no single
     * shoreline bounds anything on its own -- see `coastlineRegions`.)
     */
    closeAgainstBBox(geometry, bbox) {
        if (!Array.isArray(geometry) || geometry.length < 2) return geometry;
        if (this.isClosed(geometry)) return geometry;

        const head = geometry[0];
        const tail = geometry[geometry.length - 1];
        const tHead = PoGoMapParser.perimeterT(head, bbox);
        const tTail = PoGoMapParser.perimeterT(tail, bbox);
        if (!Number.isFinite(tHead) || !Number.isFinite(tTail)) return geometry;

        const corners = PoGoMapParser.bboxCorners(bbox);
        // Both routes from the tail back to the head along the view boundary.
        const routes = [1, -1].map((step) => geometry.concat(
            PoGoMapParser.perimeterCornersBetween(corners, tTail, tHead, step),
            [head]
        ));

        // Prefer the counter-clockwise ring, which keeps the water inside.
        const counterClockwise = routes.find(r => PoGoMapParser.signedArea(r) > 0);
        if (counterClockwise) return counterClockwise;
        // Neither route is counter-clockwise, which happens when the view runs
        // exactly along the ring, so take whichever covers more ground.
        return routes.reduce((best, r) =>
            Math.abs(PoGoMapParser.signedArea(r)) > Math.abs(PoGoMapParser.signedArea(best)) ? r : best);
    }

    /**
     * Pulls a point onto the view edge. Clipping leaves coordinates only a
     * rounding error away from the boundary, and a node has to match the edge
     * exactly to count as sitting on it, so near misses are snapped.
     */
    static snapToPerimeter(point, bbox) {
        const EPS = 1e-9;
        const snap = (v, lo, hi) => {
            if (Math.abs(v - lo) <= EPS) return lo;
            if (Math.abs(v - hi) <= EPS) return hi;
            return v;
        };
        return {
            lat: snap(point.lat, bbox.south, bbox.north),
            lon: snap(point.lon, bbox.west, bbox.east)
        };
    }

    /**
     * The bearing an edge leaves one of its nodes in, measured from north.
     *
     * It has to come from the first segment that actually has length. Taking the
     * vector to the far end instead is wrong for every curved shoreline, which is
     * nearly all of them: a shore that bulges north while running west points
     * nowhere near west, and if it lands on another edge's bearing the two become
     * indistinguishable, which silently corrupts the face walk.
     */
    static edgeHeading(edge, fromStart) {
        const pts = edge.points;
        if (fromStart) {
            for (let i = 1; i < pts.length; i++) {
                const dLat = pts[i].lat - pts[0].lat;
                const dLon = pts[i].lon - pts[0].lon;
                if (dLat !== 0 || dLon !== 0) return Math.atan2(dLon, dLat);
            }
        } else {
            const last = pts[pts.length - 1];
            for (let i = pts.length - 2; i >= 0; i--) {
                const dLat = last.lat - pts[i].lat;
                const dLon = last.lon - pts[i].lon;
                if (dLat !== 0 || dLon !== 0) return Math.atan2(dLon, dLat);
            }
        }
        return 0;  // a single repeated point has no direction to give
    }

    /**
     * Turns shoreline ways into fillable bodies of water.
     *
     * OSM maps a shore as an open `natural=coastline` way with the water on its
     * right, so no single shoreline encloses anything and closing one against the
     * view floods everything on the water side of that one line. A river's two
     * banks show why this cannot be done one shoreline at a time: each bank on
     * its own covers the whole tile between them.
     *
     * What bounds the water is the view edge and the shorelines taken together.
     * As a planar subdivision they cut the tile into faces. Which of those faces
     * are water falls out of the same rule: a face is walked so that its inside
     * stays on the right, so a water face is one whose shoreline is walked the
     * way the way itself runs (water on the right), and a land face is one whose
     * shoreline is walked against it.
     */
    coastlineRegions(coastlines, bbox) {
        if (!bbox || !(bbox.north > bbox.south) || !(bbox.east > bbox.west)) return [];

        const lines = [];
        for (const line of coastlines) {
            if (!Array.isArray(line) || line.length < 2) continue;
            const snapped = line.map(pt => PoGoMapParser.snapToPerimeter(pt, bbox));
            // Repeated points would make a zero-length edge with no bearing.
            const clean = snapped.filter((pt, i) => i === 0 ||
                pt.lat !== snapped[i - 1].lat || pt.lon !== snapped[i - 1].lon);
            if (clean.length >= 2) lines.push(clean);
        }
        if (lines.length === 0) return [];

        const nodes = new Map();
        const node = (point) => {
            const key = `${point.lat.toFixed(9)}|${point.lon.toFixed(9)}`;
            let found = nodes.get(key);
            if (!found) {
                found = { lat: point.lat, lon: point.lon, out: [] };
                nodes.set(key, found);
            }
            return found;
        };

        // The corners come first, so the view edge exists even where no shoreline
        // reaches it.
        for (const corner of PoGoMapParser.bboxCorners(bbox)) node(corner);

        const edges = [];
        for (const line of lines) {
            edges.push({
                a: node(line[0]),
                b: node(line[line.length - 1]),
                points: line,
                shore: true
            });
        }

        // The view edge, split wherever a shoreline meets it. Without these splits
        // the two banks of a river would not close against shared nodes and the
        // tile would come out as one face.
        const sides = [
            { axis: 'lat', value: bbox.north, along: (p, q) => p.lon - q.lon },
            { axis: 'lon', value: bbox.east, along: (p, q) => q.lat - p.lat },
            { axis: 'lat', value: bbox.south, along: (p, q) => q.lon - p.lon },
            { axis: 'lon', value: bbox.west, along: (p, q) => p.lat - q.lat }
        ];
        for (const side of sides) {
            const onSide = [...nodes.values()]
                .filter(n => n[side.axis] === side.value)
                .sort(side.along);
            for (let i = 0; i < onSide.length - 1; i++) {
                edges.push({ a: onSide[i], b: onSide[i + 1], points: [onSide[i], onSide[i + 1]] });
            }
        }
        if (edges.length === 0) return [];

        const viewArea = (bbox.north - bbox.south) * (bbox.east - bbox.west);

        // Two directed half-edges per edge, so a face can be walked in both senses.
        // The sense is recorded rather than inferred from the two end nodes,
        // because a shore that closes on itself leaves them identical.
        const half = [];
        for (const edge of edges) {
            const forward = { edge, from: edge.a, to: edge.b, withWay: true };
            const back = { edge, from: edge.b, to: edge.a, withWay: false };
            forward.rev = back;
            back.rev = forward;
            half.push(forward, back);
            edge.a.out.push(forward);
            edge.b.out.push(back);
        }

        // Order each node's exits by bearing, anticlockwise from north.
        for (const n of nodes.values()) {
            n.out.sort((p, q) =>
                PoGoMapParser.edgeHeading(p.edge, p.withWay) -
                PoGoMapParser.edgeHeading(q.edge, q.withWay));
            n.at = new Map(n.out.map((h, i) => [h, i]));
        }

        const seen = new Set();
        const regions = [];
        for (const start of half) {
            if (seen.has(start)) continue;
            const ring = [];
            let shoreEdges = 0;
            let shoreWithWater = 0;
            let cursor = start;
            do {
                seen.add(cursor);
                const points = cursor.withWay
                    ? cursor.edge.points
                    : cursor.edge.points.slice().reverse();
                // Each edge shares its joint with the previous one, so skip it.
                for (const pt of (ring.length ? points.slice(1) : points)) ring.push(pt);
                if (cursor.edge.shore) {
                    shoreEdges++;
                    // Following the way's own order puts the water on the right,
                    // which is the side this walk keeps as the face's inside.
                    if (cursor.withWay) shoreWithWater++;
                }
                const exits = cursor.to.out;
                cursor = exits[(cursor.to.at.get(cursor.rev) - 1 + exits.length) % exits.length];
            } while (cursor !== start && !seen.has(cursor));

            if (ring.length < 3) continue;
            const area = PoGoMapParser.signedArea(ring);
            // Taking the most clockwise exit at each node traces faces with the
            // inside on the right, so land and water run clockwise and only the
            // face around the whole tile, which runs the other way, is dropped.
            if (area > 0) continue;
            // A shore that grazes the view edge at a single point leaves a face
            // whose ring folds back through itself, and it can measure larger than
            // the view. Water inside the view never can, so that is the giveaway.
            if (Math.abs(area) > viewArea) continue;
            // A face bounded only by the view edge is untouched land.
            if (shoreEdges === 0 || shoreWithWater !== shoreEdges) continue;

            regions.push({
                type: 'region',
                id: null,
                tags: { natural: 'coastline' },
                geometry: ring
            });
        }
        return regions;
    }

    /**
     * Turns a way's list of node ids into a coordinate array, skipping any node
     * that was not included in the bbox response. A way clipped by the bbox edge
     * legitimately has missing endpoints, so this returns a partial line rather
     * than dropping the way entirely.
     */
    stitchGeometry(nodeIds, coords) {
        const geometry = [];
        for (const id of nodeIds) {
            const point = coords.get(id);
            if (point) geometry.push(point);
        }
        return geometry;
    }

    /** Reads a Retry-After header (seconds or HTTP date) into milliseconds. */
    static retryAfterMs(response) {
        try {
            const headers = response && response.headers;
            const value = headers && typeof headers.get === 'function'
                ? headers.get('Retry-After')
                : null;
            if (!value) return 0;
            const seconds = Number(value);
            if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
            const date = Date.parse(value);
            if (Number.isFinite(date)) return Math.max(0, date - Date.now());
        } catch (ignore) {
            // Malformed header — fall through to the default backoff.
        }
        return 0;
    }

    /**
     * Builds an Error for a non-2xx OSM API response.
     *
     * 400 is fatal: this API rejects a malformed or oversized bbox with a
     * message that will not change on a retry. 429 and 5xx are the server asking
     * for slower or less load, so those are retried after a pause.
     */
    static osmHttpError(response, raw) {
        const status = response.status;
        const retryAfterMs = PoGoMapParser.retryAfterMs(response);
        const detail = PoGoMapParser.errorDetail(raw);
        const hint = status === 429
            ? ' (rate limited — the OSM API is asking for slower use; honouring its cooldown)'
            : status === 400
                ? ' (the bbox was rejected; it may exceed the 0.25 square degree limit)'
                : status === 509
                    ? ' (the API is over its bandwidth limit; retrying after a pause)'
                    : status >= 500
                        ? ' (server error; retrying after a pause)'
                        : '';
        const error = new Error(
            `OSM API returned HTTP ${status}${detail ? ` - ${detail}` : ''}${hint}`
        );
        error.fatal = status === 400 || status === 401 || status === 403 || status === 410;
        error.status = status;
        if (retryAfterMs) error.retryAfterMs = retryAfterMs;
        return error;
    }

    /**
     * Builds the error for "the request never produced a usable response". In
     * the browser this arrives as a bare TypeError: fetch rejects identically for
     * offline, VPN/firewall blocks, adblockers, and DNS failures, so the message
     * names that range instead of pretending the query was wrong.
     */
    static networkError(cause) {
        const timedOut = cause && cause.code === 'timeout';
        const detail = timedOut
            ? cause.message
            : 'the browser could not complete the request, so no status was reported ' +
              '(offline, VPN/firewall/adblocker, or the host is unreachable)';
        const error = new Error(`OSM API unreachable — ${detail}.`);
        error.fatal = false;
        if (cause) error.cause = cause;
        return error;
    }

    /**
     * Pulls a human-readable snippet out of an OSM API error body, which is
     * usually plain text (or an XML error document). Never dumps raw markup.
     */
    static errorDetail(raw) {
        const text = String(raw || '').trim();
        if (!text) return '';
        if (text[0] === '{' || text[0] === '[') {
            try {
                const remark = (JSON.parse(text).remark || '').trim();
                if (remark) return remark.slice(0, 180);
            } catch (ignore) {
                // Not JSON after all — fall through to plain-text handling.
            }
        }
        // Strip XML/HTML tags and collapse whitespace so a 504 gateway page
        // becomes one short sentence instead of raw markup.
        return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
    }

    /**
     * Concatenates per-sub-box results, dropping duplicates. Ways on a shared edge
     * come back from both neighbouring sub-queries and would otherwise be drawn twice.
     */
    mergeElements(batches) {
        const seen = new Set();
        const merged = [];

        for (const batch of batches) {
            if (!Array.isArray(batch)) continue;
            for (const el of batch) {
                if (!el) continue;
                const key = el.id === undefined ? null : `${el.type}:${el.id}`;
                if (key !== null) {
                    if (seen.has(key)) continue;
                    seen.add(key);
                }
                merged.push(el);
            }
        }
        return merged;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Builds a slippy-map style bounding box of the given zoom level around a centre.
     * Zoom 0 spans the whole 360 degrees of longitude; every level halves the span.
     * The latitude span is scaled by cos(latitude) so ground pixels stay square.
     */
    static zoomBBox(centerLat, centerLon, zoom) {
        const lonSpan = 360 / Math.pow(2, zoom);
        const latSpan = lonSpan * Math.cos(centerLat * Math.PI / 180);
        return {
            south: centerLat - latSpan / 2,
            west: centerLon - lonSpan / 2,
            north: centerLat + latSpan / 2,
            east: centerLon + lonSpan / 2
        };
    }

    /** Approximate ground width of a bounding box, in metres, for tile captions. */
    static spanMeters(bbox) {
        const midLat = (bbox.north + bbox.south) / 2;
        return (bbox.east - bbox.west) * 111320 * Math.cos(midLat * Math.PI / 180);
    }

    /**
     * Renders elements onto the parser's own canvas
     */
    render(elements, south, west, north, east) {
        this.drawScene(this.ctx, this.canvas.width, this.canvas.height,
            elements, { south, west, north, east });
    }

    /**
     * Renders elements onto any other canvas, used to build the zoom pyramid tiles.
     * The canvas must already have its width/height assigned.
     */
    renderTo(targetCanvas, elements, bbox) {
        if (!targetCanvas || !targetCanvas.getContext) {
            throw new Error('renderTo() requires a canvas element as its first argument.');
        }
        const ctx = targetCanvas.getContext('2d');
        if (!ctx) throw new Error('Could not acquire a 2d context for the target canvas.');
        this.drawScene(ctx, targetCanvas.width, targetCanvas.height, elements, bbox);
    }

    /** Visual weight of a road: major arteries render widest. */
    roadTier(tags) {
        const kind = tags && tags.highway;
        if (this.highwayClasses.major.has(kind)) return 'major';
        if (this.highwayClasses.mid.has(kind)) return 'mid';
        return 'minor';
    }

    /** True for anything that paints as park-green in the 2016 client. */
    isPark(tags) {
        if (!tags) return false;
        if (tags.leisure === 'park' || tags.leisure === 'golf_course' ||
            tags.leisure === 'garden' || tags.leisure === 'pitch' ||
            tags.leisure === 'playground' || tags.leisure === 'recreation_ground' ||
            tags.leisure === 'nature_reserve') return true;
        if (tags.landuse === 'grass' || tags.landuse === 'meadow' ||
            tags.landuse === 'forest' || tags.landuse === 'recreation_ground') return true;
        return tags.natural === 'wood' || tags.natural === 'grassland' ||
            tags.natural === 'scrub';
    }

    /**
     * Core painter: mint ground wash, then park blocks, water, pale building
     * footprints, and finally roads as a pale-yellow casing pass with a dark
     * teal fill pass on top. All drawing happens here so the single canvas and
     * the pyramid tiles share one implementation.
     */
    drawScene(ctx, width, height, elements, bbox) {
        const { south, west, north, east } = bbox;

        // A degenerate bbox divides by zero below and paints NaN coordinates
        if (!(north > south) || !(east > west)) {
            throw new Error('Invalid bounding box: north must exceed south and east must exceed west.');
        }
        if (!Array.isArray(elements)) {
            throw new Error('drawScene() expects an array of Overpass elements.');
        }
        if (!(width > 0) || !(height > 0)) {
            throw new Error('Target canvas must have a positive width and height.');
        }

        // Reset any drawing state left behind by the caller or a previous render
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Scale stroke weights with tile size, with a floor so thin tiles stay legible
        const scale = Math.max(0.4, width / this.referenceWidth);
        const px = (weight) => Math.max(this.strokes.minimum, weight * scale);

        // Helper coordinates projection mapping function
        const latToY = (lat) => height - ((lat - south) / (north - south)) * height;
        const lonToX = (lon) => ((lon - west) / (east - west)) * width;

        // Traces any geometry array into the current path
        const tracePath = (geometry) => {
            ctx.beginPath();
            geometry.forEach((pt, idx) => {
                if (idx === 0) ctx.moveTo(lonToX(pt.lon), latToY(pt.lat));
                else ctx.lineTo(lonToX(pt.lon), latToY(pt.lat));
            });
        };

        // 1. Mint ground wash
        ctx.fillStyle = this.createTerrainPattern(ctx);
        ctx.fillRect(0, 0, width, height);

        // Separate features for clean layered drawing
        const parks = [];
        const waters = [];
        const buildings = [];
        const roadsMajor = [];
        const roadsMid = [];
        const roadsMinor = [];

        elements.forEach(el => {
            // Results can omit tags entirely, so never dereference blindly
            if (!el || !el.geometry || !el.tags || el.geometry.length === 0) return;
            // A hole in a water body is an island: leave it unpainted so the land
            // underneath shows through instead of flooding it.
            if (el.hole) return;
            const tags = el.tags;
            if (this.isWater(tags)) waters.push(el);
            else if (this.isPark(tags)) parks.push(el);
            else if (tags.building && tags.building !== 'no') buildings.push(el);
            else if (tags.highway) {
                const tier = this.roadTier(tags);
                if (tier === 'major') roadsMajor.push(el);
                else if (tier === 'mid') roadsMid.push(el);
                else roadsMinor.push(el);
            }
        });

        // 2. Park blocks (deep emerald-teal)
        ctx.fillStyle = this.colors.park;
        parks.forEach(park => {
            tracePath(park.geometry);
            ctx.closePath();
            ctx.fill();
        });

        // 3. Water (solid sky blue)
        ctx.fillStyle = this.colors.water;
        ctx.strokeStyle = this.colors.water;
        ctx.lineWidth = px(this.strokes.water);
        waters.forEach(water => {
            tracePath(water.geometry);
            // Areas (lakes, pools, riverbanks) get filled, linear waterways get stroked
            if (this.isWaterArea(water)) {
                ctx.closePath();
                ctx.fill();
            } else {
                ctx.stroke();
            }
        });

        // 4. Building footprints (near-white blocks, drawn under the roads)
        ctx.fillStyle = this.colors.building;
        ctx.strokeStyle = this.colors.buildingEdge;
        ctx.lineWidth = px(this.strokes.buildingEdge);
        buildings.forEach(building => {
            tracePath(building.geometry);
            ctx.closePath();
            ctx.globalAlpha = 0.92;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.stroke();
        });

        // 5. Roads, per tier: pale-yellow casing pass, then dark teal fill pass.
        // This two-pass order is the defining 2016 look.
        const tiers = [
            [roadsMajor, this.strokes.roadCasingMajor, this.strokes.roadFillMajor],
            [roadsMid, this.strokes.roadCasingMid, this.strokes.roadFillMid],
            [roadsMinor, this.strokes.roadCasingMinor, this.strokes.roadFillMinor]
        ];
        tiers.forEach(([roads, casing, fill]) => {
            if (roads.length === 0) return;
            ctx.strokeStyle = this.colors.roadCasing;
            ctx.lineWidth = px(casing);
            roads.forEach(road => {
                tracePath(road.geometry);
                ctx.stroke();
            });
            ctx.strokeStyle = this.colors.roadFill;
            ctx.lineWidth = px(fill);
            roads.forEach(road => {
                tracePath(road.geometry);
                ctx.stroke();
            });
        });
    }

    /**
     * Decides whether a waterway element should be filled as an area (lake, pool,
     * riverbank, coastline) or stroked as a linear feature (river, stream, canal).
     */
    isWaterArea(water) {
        const tags = water.tags || {};

        // `area=yes` / `area=no` is the canonical OSM way of disambiguating a waterway
        if (tags.area === 'yes') return true;
        if (tags.area === 'no') return false;

        // These describe a region rather than a line, so they are always filled,
        // even though a coastline arrives as an open way.
        if (this.isWater(tags)) {
            const linear = tags.waterway && tags.waterway !== 'riverbank'
                && tags.waterway !== 'dock' && tags.waterway !== 'canal';
            if (!linear) return true;
            if (tags.natural === 'coastline' || tags.natural === 'bay' ||
                tags.natural === 'strait' || tags.natural === 'water' ||
                tags.landuse === 'reservoir' || tags.landuse === 'basin' ||
                tags.leisure === 'swimming_pool') return true;
        }

        // Geometry fallback: a ring must match in BOTH coordinates. Comparing latitude
        // alone painted every river bend that returns to its starting latitude as a lake.
        return this.isClosed(water.geometry);
    }

    /**
     * Repaints the bare ground, used for the first frame and for clearing.
     * `clearRect` would leave a transparent canvas, which exports to a blank PNG.
     */
    clear() {
        const ctx = this.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = this.createTerrainPattern(ctx);
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    /**
     * Converts current canvas layout directly into a dataURL image tile string
     */
    exportToTileImage() {
        return this.canvas.toDataURL('image/png');
    }
}

// The library is a plain class declaration so a <script> tag can use it directly,
// which is how the demo page and any drop-in embed will load it. A CommonJS
// export is added alongside for bundlers and Node, and guarded by `typeof` so it
// costs nothing in the browser.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PoGoMapParser;
}
