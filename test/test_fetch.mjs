// Offline harness: stubs fetch + canvas, then exercises the real fetch pipeline
// (request shape, node stitching, span cutoffs, splitting, retry, dedupe) and the
// 2016 styling, without any network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolved from this file, so the suite runs from any working directory.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'src', 'PoGoMapParser.js'), 'utf8');

// Stub the browser bits the class touches at construction/render time.
const pattern = {};
const gradient = { addColorStop() {} };
const ctx = {
  createPattern: () => pattern,
  createRadialGradient: () => gradient,
  getImageData: () => ({ data: new Uint8ClampedArray(128 * 128 * 4) }),
  putImageData() {}, fillRect() {}, beginPath() {}, moveTo() {},
  lineTo() {}, closePath() {}, fill() {}, stroke() {}, setTransform() {}, arc() {},
  fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '', globalAlpha: 1,
};
const ctx2d = () => ctx;
globalThis.document = {
  getElementById: () => ({ getContext: ctx2d, width: 550, height: 550, toDataURL: () => '' }),
  createElement: () => ({ getContext: ctx2d, width: 0, height: 0 }),
};
globalThis.AbortController = globalThis.AbortController || class {
  constructor() { this.signal = {}; }
  abort() { this.aborted = true; }
};

const mod = new Function(`${src}; return PoGoMapParser;`)();
const parser = new mod('c');
parser.subQueryDelayMs = 1;   // keep the suite fast; production default stays slow
parser.retryBaseDelayMs = 1;

// ---------------------------------------------------------------- call recorder
let calls = [];
let scenario = () => ({ status: 200, body: null });

globalThis.fetch = async (url, opts) => {
  calls.push({ url, method: opts && opts.method, headers: opts && opts.headers, at: Date.now() });
  const s = scenario(url, calls.length);
  if (s.typeError) throw new TypeError(s.typeError);
  if (s.throw) throw new Error(s.throw);
  if (s.abort) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  return {
    ok: s.status >= 200 && s.status < 300,
    status: s.status,
    headers: s.headers || { get: () => null },
    text: async () => s.body ?? '',
  };
};

// The API returns ways as `nodes: [id]` plus a flat list of coordinate nodes,
// so fixtures are built the same way the parser has to consume them.
//
// Fixtures are laid out around a point inside the view being requested. That
// matters now the parser clips: the API hands back whole ways that run well past
// the bbox, so a fixture parked outside the view is correctly thrown away and the
// test would measure nothing.
const TEST_CENTRE = { lat: 40.7, lon: -73.9 };
const STEP = 0.001;   // ~110 m, so a 4-point way spans ~330 m

/** The middle of the bbox a recorded request asked for. */
const insideUrl = (url) => {
  const raw = decodeURIComponent(new URL(url).searchParams.get('bbox') || '');
  const [west, south, east, north] = raw.split(',').map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return TEST_CENTRE;
  return { lat: (south + north) / 2, lon: (west + east) / 2 };
};

let nextNodeId = 1;
const osmWay = (id, tags, n = 4, centre = TEST_CENTRE) => {
  const nodeIds = [];
  for (let i = 0; i < n; i++) nodeIds.push(nextNodeId++);
  return {
    way: { type: 'way', id, tags, nodes: nodeIds },
    nodes: nodeIds.map((nid, i) => ({
      type: 'node', id: nid,
      lat: centre.lat + (i - (n - 1) / 2) * STEP,
      lon: centre.lon + (i - (n - 1) / 2) * STEP,
    })),
  };
};

/** Wraps fixtures into a full API response body. */
const OSM = (...fixtures) => JSON.stringify({
  version: 0.6,
  elements: fixtures.flatMap(f => [f.way, ...f.nodes]),
});

/** A ready-made element already in the renderer's shape, for render tests. */
const el = (id, tags, n = 4, centre = TEST_CENTRE) => ({
  type: 'way', id,
  tags,
  geometry: Array.from({ length: n }, (_, i) => ({
    lat: centre.lat + (i - (n - 1) / 2) * STEP,
    lon: centre.lon + (i - (n - 1) / 2) * STEP,
  })),
});

/** A bbox of the given ground width in metres, centred on the test point. */
const boxOfMeters = (meters) => {
  const latSpan = meters / 110574;
  const lonSpan = latSpan / Math.cos(TEST_CENTRE.lat * Math.PI / 180);
  return {
    south: TEST_CENTRE.lat - latSpan / 2,
    west: TEST_CENTRE.lon - lonSpan / 2,
    north: TEST_CENTRE.lat + latSpan / 2,
    east: TEST_CENTRE.lon + lonSpan / 2,
  };
};

/** A bbox just large enough to hold the default fixtures. */
const nearBox = () => boxOfMeters(800);

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const fresh = () => { parser.mapCache.clear(); parser.pendingRequests.clear(); calls = []; };

console.log('=== one single main API, no mirrors, no proxy ===');
check('exactly one endpoint configured',
  parser.osmApiEndpoint === 'https://api.openstreetmap.org/api/0.6/map.json',
  `-> "${parser.osmApiEndpoint}"`);
check('endpoint is the JSON variant of the map call', /\/api\/0\.6\/map\.json$/.test(parser.osmApiEndpoint));
check('no Overpass endpoint remains', parser.overpassEndpoint === undefined);
check('no mirror list remains', parser.overpassEndpoints === undefined);
check('no fallback mirror list remains', parser.overpassFallbackEndpoints === undefined);
check('no same-origin proxy path remains', parser.proxyPath === undefined);
check('no proxy probe paths remain', parser.proxyProbePaths === undefined);
check('no proxy state remains', parser.proxyState === undefined);
check('no dead Overpass query builder remains', parser.buildQuery === undefined);
check('dead networkError helper is actually wired in', parser.requestMapBox !== undefined);
check('retries more than once', parser.maxAttemptsPerBBox >= 3, `-> ${parser.maxAttemptsPerBBox}`);
check('API hard bbox limit is recorded as 0.25 deg2',
  mod.apiMaxBBoxAreaDegrees2 === 0.25, `-> ${mod.apiMaxBBoxAreaDegrees2}`);
check('response-size target is well under the API hard limit',
  parser.maxBBoxAreaDegrees2 < mod.apiMaxBBoxAreaDegrees2, `-> ${parser.maxBBoxAreaDegrees2} deg2`);
check('sub-query budget is bounded', parser.maxSubQueries > 1 && parser.maxSubQueries <= 256,
  `-> ${parser.maxSubQueries}`);

console.log('\n=== request shape (GET, no preflight, lon-lat order) ===');
const urlOf = (bbox) => parser.buildRequestUrl(bbox);
const manhattan = { south: 40.75, west: -73.984, north: 40.751, east: -73.983 };
const testUrl = urlOf(manhattan);
const bboxParam = decodeURIComponent(new URL(testUrl).searchParams.get('bbox'));
check('bbox is west,south,east,north', bboxParam === '-73.984,40.75,-73.983,40.751',
  `-> "${bboxParam}"`);
check('lat and lon are not transposed', !bboxParam.startsWith('40.75,-73.984'));

fresh();
scenario = (url) => ({ status: 200, body: OSM(osmWay(1, { highway: 'primary' }, 4, insideUrl(url))) });
await parser.fetchMapData(manhattan.south, manhattan.west, manhattan.north, manhattan.east);
check('uses GET', calls[0].method === 'GET', `-> ${calls[0].method}`);
check('sends no body', calls[0].body === undefined);
const sentHeaders = calls[0].headers || {};
check('sends no custom headers at all', Object.keys(sentHeaders).length === 0,
  `-> ${JSON.stringify(Object.keys(sentHeaders))}`);
check('no User-Agent (browsers forbid setting it)', !('User-Agent' in sentHeaders));
check('no Content-Type (would force a preflight)', !('Content-Type' in sentHeaders));
check('all calls went to the one API',
  calls.every(c => c.url.startsWith('https://api.openstreetmap.org/api/0.6/map.json')));

console.log('\n=== node-id stitching into geometry ===');
{
  const a = osmWay(10, { highway: 'residential' }, 4);
  const raw = JSON.parse(OSM(a)).elements;
  const out = parser.filterElements(raw, true, boxOfMeters(800));
  check('one way survives the filter', out.length === 1, `-> ${out.length}`);
  check('geometry rebuilt from member nodes', out[0].geometry.length === 4,
    `-> ${out[0] && out[0].geometry.length} points`);
  check('coordinates come from the node list',
    out[0].geometry[0].lat === TEST_CENTRE.lat - 1.5 * STEP &&
    out[0].geometry[0].lon === TEST_CENTRE.lon - 1.5 * STEP,
    `-> ${JSON.stringify(out[0].geometry[0])}`);
  check('renderer shape preserved (type/id/tags/geometry)',
    out[0].type === 'way' && out[0].id === 10 && !!out[0].tags && !!out[0].geometry);
}
{
  // A way clipped by the bbox edge is missing some of its nodes upstream.
  const a = osmWay(11, { highway: 'primary' }, 4);
  const raw = JSON.parse(OSM(a)).elements;
  raw.find(e => e.type === 'way').nodes = raw.find(e => e.type === 'way').nodes.slice(1, 3);
  const out = parser.filterElements(raw, true, boxOfMeters(800));
  check('partially clipped way survives as a partial line',
    out.length === 1 && out[0].geometry.length === 2, `-> ${out[0] && out[0].geometry.length} points`);
}
{
  const a = osmWay(12, { highway: 'primary' }, 4);
  const raw = JSON.parse(OSM(a)).elements;
  raw.find(e => e.type === 'way').nodes = [];   // no resolvable members at all
  check('way with no resolvable nodes is dropped',
    parser.filterElements(raw, true, boxOfMeters(800)).length === 0);
}
{
  const rel = { type: 'relation', id: 20, members: [], tags: { leisure: 'park' } };
  check('relations are skipped (geometry lives in members)',
    parser.filterElements([rel], true, boxOfMeters(800)).length === 0);
}

console.log('\n=== tag filtering ===');
const keptTags = (tags, span = 800) => {
  const raw = JSON.parse(OSM(osmWay(99, tags))).elements;
  return parser.filterElements(raw, true, boxOfMeters(span)).length;
};
check('highway kept', keptTags({ highway: 'primary' }) === 1);
check('park kept', keptTags({ leisure: 'park' }) === 1);
check('golf course kept as park', keptTags({ leisure: 'golf_course' }) === 1);
check('grass landuse kept as park', keptTags({ landuse: 'grass' }) === 1);
check('wood kept as park', keptTags({ natural: 'wood' }) === 1);
check('natural water kept', keptTags({ natural: 'water' }) === 1);
check('waterway kept', keptTags({ waterway: 'river' }) === 1);
check('building kept when requested', keptTags({ building: 'yes' }) === 1);
check('building=no dropped', keptTags({ building: 'no' }) === 0);
check('unrelated tag dropped', keptTags({ shop: 'bakery' }) === 0);
check('barrier dropped', keptTags({ barrier: 'fence' }) === 0);
{
  const raw = JSON.parse(OSM(osmWay(98, { highway: 'primary' }))).elements;
  raw[0].tags = undefined;
  check('tagless way dropped', parser.filterElements(raw, true, boxOfMeters(800)).length === 0);
}

console.log('\n=== span-driven detail cutoffs ===');
check('footway kept at street level', keptTags({ highway: 'footway' }, 300) === 1);
check('footway dropped at a wide span', keptTags({ highway: 'footway' }, 6000) === 0);
check('residential kept at mid span', keptTags({ highway: 'residential' }, 800) === 1);
check('residential dropped at a wide span', keptTags({ highway: 'residential' }, 6000) === 0);
check('primary kept at every span',
  keptTags({ highway: 'primary' }, 300) === 1 && keptTags({ highway: 'primary' }, 6000) === 1);
check('water survives every span',
  keptTags({ natural: 'water' }, 300) === 1 && keptTags({ natural: 'water' }, 6000) === 1);
check('park survives every span',
  keptTags({ leisure: 'park' }, 300) === 1 && keptTags({ leisure: 'park' }, 6000) === 1);
{
  const raw = JSON.parse(OSM(osmWay(97, { building: 'yes' }))).elements;
  check('building dropped when includeBuildings is false',
    parser.filterElements(raw, false, boxOfMeters(6000)).length === 0);
  check('building kept when includeBuildings is true',
    parser.filterElements(raw, true, boxOfMeters(800)).length === 1);
}

console.log('\n=== bbox splitting ===');
const wide = mod.zoomBBox(40.75, -73.984, 12);
const small = mod.zoomBBox(40.75, -73.984, 18);
const parts = parser.splitBBox(wide);
check('wide box splits', parts.length > 1, `-> ${parts.length} sub-boxes`);
check('small box not split', parser.splitBBox(small).length === 1);
check('split count <= 64', parts.length <= 64, `-> ${parts.length}`);
check('sub-boxes stay inside parent', parts.every(p =>
  p.south >= wide.south - 1e-7 && p.north <= wide.north + 1e-7 &&
  p.west >= wide.west - 1e-7 && p.east <= wide.east + 1e-7));
const areaOf = (p) => Math.abs((p.north - p.south) * (p.east - p.west));
check('every sub-box is under the API hard limit', parts.every(p =>
  areaOf(p) <= mod.apiMaxBBoxAreaDegrees2 * 1.001),
  `-> worst ${Math.max(...parts.map(areaOf)).toExponential(2)} deg2`);
check('ordinary views also meet the size target', parts.every(p =>
  areaOf(p) <= parser.maxBBoxAreaDegrees2 * 1.001),
  `-> worst ${Math.max(...parts.map(areaOf)).toExponential(2)} deg2`);
{
  // A deliberately enormous bbox: only the hard limit can save this one.
  const huge = { south: 40.0, west: -74.5, north: 41.0, east: -73.0 };
  const hugeParts = parser.splitBBox(huge);
  check('enormous box respects the API hard limit', hugeParts.every(p =>
    areaOf(p) <= mod.apiMaxBBoxAreaDegrees2 * 1.001),
    `-> worst ${Math.max(...hugeParts.map(areaOf)).toExponential(2)} deg2 in ${hugeParts.length} sub-boxes`);
  check('enormous box stays within the request budget',
    hugeParts.length <= parser.maxSubQueries, `-> ${hugeParts.length}`);
}
{
  // Beyond what the request budget can cover, the code must say so out loud
  // rather than emitting a wall of unexplained HTTP 400s.
  const planet = { south: -85, west: -180, north: 85, east: 180 };
  const warnings = [];
  parser.onProgress = (m) => warnings.push(m);
  const planetParts = parser.splitBBox(planet);
  parser.onProgress = null;
  check('impossible area is capped, not attempted', planetParts.length <= parser.maxSubQueries,
    `-> ${planetParts.length}`);
  check('impossible area warns the user', warnings.some(w => /too large/.test(w)),
    `-> ${JSON.stringify(warnings)}`);
}
check('west edge is not greater than east edge', parts.every(p => p.east > p.west));
check('south edge is not greater than north edge', parts.every(p => p.north > p.south));

console.log('\n=== merge dedupes boundary ways ===');
const shared = el(1, { highway: 'primary' });
const onlyA = el(2, { highway: 'primary' });
const onlyB = el(3, { highway: 'primary' });
const merged = parser.mergeElements([[shared, onlyA], [shared, onlyB]]);
check('duplicates removed', merged.length === 3, `-> ${merged.length} elements from 4`);
check('each id appears once', new Set(merged.map(e => e.id)).size === merged.length);
check('non-array batch tolerated', parser.mergeElements([null, [onlyA]]).length === 1);
check('empty input tolerated', parser.mergeElements([]).length === 0);

console.log('\n=== sequential sub-queries on the one API ===');
fresh();
scenario = (url, n) => ({ status: 200, body: OSM(osmWay(100 + n, { highway: 'primary' }, 4, insideUrl(url))) });
let out = await parser.fetchMapData(wide.south, wide.west, wide.north, wide.east);
check('all calls hit the single API',
  calls.every(c => c.url.startsWith('https://api.openstreetmap.org/api/0.6/map.json')));
check('wide area fans out to sub-queries', calls.length === parts.length,
  `-> ${calls.length} calls`);
check('sub-box results merged', out.length === calls.length, `-> ${out.length} elements`);
check('sub-queries were issued sequentially, not at once', (() => {
  for (let i = 1; i < calls.length; i++) {
    if (calls[i].at - calls[i - 1].at < 0) return false;
  }
  return true;
})(), `-> gaps ${calls.slice(1).map((c, i) => c.at - calls[i].at).join(',')}`);

console.log('\n=== 429 is retried after the server cooldown ===');
fresh();
parser.lastError = null;
scenario = (url, n) => n === 1
  ? { status: 429, body: 'Rate limit exceeded', headers: { get: (h) => h === 'Retry-After' ? '1' : null } }
  : { status: 200, body: OSM(osmWay(50, { highway: 'primary' }, 4, insideUrl(url))) };
out = await parser.fetchMapData(40.76, -73.978, 40.761, -73.977);
check('recovered on retry', out.length === 1, `-> ${out.length}`);
check('exactly two attempts', calls.length === 2, `-> ${calls.length} calls`);
check('honoured Retry-After (waited ~1s)',
  calls[1].at - calls[0].at >= 950, `-> ${calls[1].at - calls[0].at}ms`);
check('no error left behind after recovery', !parser.lastError, `-> "${parser.lastError}"`);

console.log('\n=== 5xx is retried, not fatal ===');
fresh();
parser.lastError = null;
scenario = (url, n) => n === 1
  ? { status: 503, body: 'Service Unavailable' }
  : { status: 200, body: OSM(osmWay(51, { highway: 'primary' }, 4, insideUrl(url))) };
out = await parser.fetchMapData(40.762, -73.976, 40.763, -73.975);
check('recovered on retry', out.length === 1, `-> ${out.length}`);
check('exactly two attempts', calls.length === 2, `-> ${calls.length} calls`);

console.log('\n=== all retries exhausted degrades to empty ===');
fresh();
parser.lastError = null;
scenario = () => ({ status: 503, body: 'Service Unavailable' });
out = await parser.fetchMapData(40.764, -73.974, 40.765, -73.973);
check('degrades to empty array', Array.isArray(out) && out.length === 0);
check('error recorded and names the status', /503/.test(parser.lastError || ''),
  `-> "${parser.lastError}"`);
check('no raw markup in the error', !/[<>]/.test(parser.lastError || ''));
check('attempts capped', calls.length === parser.maxAttemptsPerBBox, `-> ${calls.length} calls`);

console.log('\n=== 400 is fatal and never retried ===');
fresh();
parser.lastError = null;
scenario = () => ({ status: 400, body: 'The maximum bbox size is 0.25 degrees' });
out = await parser.fetchMapData(40.766, -73.972, 40.767, -73.971);
check('returns empty on a rejected bbox', out.length === 0);
check('single attempt only', calls.length === 1, `-> ${calls.length} calls`);
check('server message surfaced', /0\.25 degrees/.test(parser.lastError || ''),
  `-> "${parser.lastError}"`);
check('mentions the area limit', /0\.25 square degree/.test(parser.lastError || ''));

console.log('\n=== network failure explains itself instead of saying "Failed to fetch" ===');
fresh();
parser.lastError = null;
scenario = () => ({ typeError: 'Failed to fetch' });
out = await parser.fetchMapData(40.768, -73.970, 40.769, -73.969);
check('degrades to empty array', Array.isArray(out) && out.length === 0);
check('names the unreachable API', /OSM API unreachable/.test(parser.lastError || ''),
  `-> "${parser.lastError}"`);
check('does not leak the bare browser message', !/^Failed to fetch/.test(parser.lastError || ''));
check('names the likely causes', /offline|firewall|adblocker/.test(parser.lastError || ''));
check('attempts capped', calls.length === parser.maxAttemptsPerBBox, `-> ${calls.length} calls`);

console.log('\n=== a stalled request becomes a timeout, not a hang ===');
fresh();
parser.lastError = null;
scenario = () => ({ abort: true });
out = await parser.fetchMapData(40.770, -73.968, 40.771, -73.967);
check('degrades to empty array', Array.isArray(out) && out.length === 0);
check('reports a timeout with the limit', /timed out after 60s/.test(parser.lastError || ''),
  `-> "${parser.lastError}"`);

console.log('\n=== a non-JSON body is reported cleanly ===');
fresh();
parser.lastError = null;
scenario = () => ({ status: 200, body: '<html>not json</html>' });
out = await parser.fetchMapData(40.772, -73.966, 40.773, -73.965);
check('degrades to empty array', out.length === 0);
check('says the response was unreadable', /not JSON/.test(parser.lastError || ''),
  `-> "${parser.lastError}"`);
check('no raw markup in the error', !/[<>]/.test(parser.lastError || ''));

console.log('\n=== progress reporting ===');
fresh();
scenario = (url) => ({ status: 200, body: OSM(osmWay(52, { highway: 'primary' }, 4, insideUrl(url))) });
const seen = [];
parser.onProgress = (m) => seen.push(m);
out = await parser.fetchMapData(40.768, -73.970, 40.769, -73.969);
check('emits progress for sub-queries', seen.length > 0, `-> ${seen.length} updates`);
parser.onProgress = () => { throw new Error('hook blew up'); };
fresh();
let survived = false;
try {
  out = await parser.fetchMapData(40.770, -73.968, 40.771, -73.967);
  survived = out.length === 1;
} catch { survived = false; }
check('a broken progress hook never breaks fetching', survived);
parser.onProgress = null;

console.log('\n=== cache + in-flight dedupe ===');
fresh();
scenario = (url) => ({ status: 200, body: OSM(osmWay(30, { highway: 'primary' }, 4, insideUrl(url))) });
const [r1, r2] = await Promise.all([
  parser.fetchMapData(40.756, -73.979, 40.757, -73.978),
  parser.fetchMapData(40.756, -73.979, 40.757, -73.978),
]);
check('concurrent calls share one request', calls.length === 1, `-> ${calls.length}`);
check('both get data', r1.length === 1 && r2.length === 1);
await parser.fetchMapData(40.756, -73.979, 40.757, -73.978);
check('repeat call served from cache', calls.length === 1, `-> ${calls.length}`);

console.log('\n=== 2016 feature classification ===');
check('golf course is park', parser.isPark({ leisure: 'golf_course' }) === true);
check('grass landuse is park', parser.isPark({ landuse: 'grass' }) === true);
check('wood is park', parser.isPark({ natural: 'wood' }) === true);
check('primary is not park', parser.isPark({ highway: 'primary' }) === false);
check('null tags are not park', parser.isPark(null) === false);
check('motorway tier', parser.roadTier({ highway: 'motorway' }) === 'major');
check('residential tier', parser.roadTier({ highway: 'residential' }) === 'mid');
check('footway tier', parser.roadTier({ highway: 'footway' }) === 'minor');

console.log('\n=== 2016 palette ===');
const c = parser.colors;
check('land is pale mint', c.land === '#b2f097', `-> ${c.land}`);
check('park is emerald', c.park === '#3abc86', `-> ${c.park}`);
check('water is sky blue', c.water === '#38aee3', `-> ${c.water}`);
check('road fill is teal', c.roadFill === '#5c987f', `-> ${c.roadFill}`);
check('road casing is pale yellow', c.roadCasing === '#f2fd95', `-> ${c.roadCasing}`);

console.log('\n=== buildings sit only just darker than the ground ===');
check('building fill is a muted green', /^#[0-9a-f]{6}$/.test(c.building), `-> ${c.building}`);
check('building edge is set', /^#[0-9a-f]{6}$/.test(c.buildingEdge), `-> ${c.buildingEdge}`);
const lum = (hex) => {
  const [r, g, b] = mod.hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const landLum = lum(c.land), buildLum = lum(c.building), edgeLum = lum(c.buildingEdge);
check('buildings are darker than the land', buildLum < landLum,
  `-> land ${landLum.toFixed(0)} vs building ${buildLum.toFixed(0)}`);
check('but only slightly darker (within 25% of land luminance)',
  buildLum > landLum * 0.75,
  `-> ${((buildLum / landLum) * 100).toFixed(0)}% of land`);
check('building edge is darker than the fill', edgeLum < buildLum);
check('buildings are clearly distinct from the 2016 near-white reference',
  c.building !== '#f1faee' && c.building !== '#f3fdf0');

console.log('\n=== road stroke weights (2x the reference) ===');
const s = parser.strokes;
check('major casing doubled to 14', s.roadCasingMajor === 14, `-> ${s.roadCasingMajor}`);
check('major fill doubled to 9', s.roadFillMajor === 9, `-> ${s.roadFillMajor}`);
check('mid casing doubled to 10', s.roadCasingMid === 10, `-> ${s.roadCasingMid}`);
check('mid fill doubled to 6', s.roadFillMid === 6, `-> ${s.roadFillMid}`);
check('minor casing doubled to 6', s.roadCasingMinor === 6, `-> ${s.roadCasingMinor}`);
check('minor fill doubled to 3.6', s.roadFillMinor === 3.6, `-> ${s.roadFillMinor}`);
check('casing stays wider than fill on every tier',
  s.roadCasingMajor > s.roadFillMajor && s.roadCasingMid > s.roadFillMid &&
  s.roadCasingMinor > s.roadFillMinor);
check('tiers still step down in weight',
  s.roadCasingMajor > s.roadCasingMid && s.roadCasingMid > s.roadCasingMinor &&
  s.roadFillMajor > s.roadFillMid && s.roadFillMid > s.roadFillMinor);
check('building edge left at the reference weight', s.buildingEdge === 0.75, `-> ${s.buildingEdge}`);
check('water width untouched at 4', s.water === 4, `-> ${s.water}`);
check('stroke floor still below the thinnest weight', s.minimum < s.roadFillMinor);

console.log('\n=== drawScene smoke test (2016 layers) ===');
const scene = [
  el(1, { leisure: 'park' }),
  el(2, { natural: 'water' }),
  el(3, { building: 'yes' }),
  el(4, { highway: 'primary' }),
  el(5, { highway: 'residential' }),
  el(6, { highway: 'footway' }),
  el(7, { waterway: 'river' }),
  { type: 'way', id: 8, geometry: [] },           // empty geometry skipped
  { type: 'way', id: 9 },                          // tagless skipped
];
let threw = false;
try {
  parser.drawScene(ctx, 200, 200, scene, mod.zoomBBox(40.75, -73.984, 16));
} catch (e) { threw = e; }
check('mixed scene renders', threw === false, threw ? `-> ${threw.message}` : '');

console.log('\n=== isWaterArea ===');
const ring = { tags: {}, geometry: [{lat:1,lon:1},{lat:2,lon:2},{lat:3,lon:3},{lat:1,lon:1}] };
const bendy = { tags: { waterway: 'stream' }, geometry: [{lat:1,lon:1},{lat:2,lon:2},{lat:1,lon:9},{lat:4,lon:4}] };
check('closed ring is area', parser.isWaterArea(ring) === true);
check('river bending back to start lat is not area', parser.isWaterArea(bendy) === false);
check('area=no wins', parser.isWaterArea({ tags:{natural:'water',area:'no'}, geometry:[] }) === false);

console.log('\n=== water vocabulary (OSM tags that actually mean water) ===');
for (const [label, tags] of [
  ['natural=water', { natural: 'water' }],
  ['waterway=river', { waterway: 'river' }],
  ['natural=coastline', { natural: 'coastline' }],
  ['natural=bay', { natural: 'bay' }],
  ['natural=strait', { natural: 'strait' }],
  ['landuse=reservoir', { landuse: 'reservoir' }],
  ['landuse=basin', { landuse: 'basin' }],
  ['leisure=swimming_pool', { leisure: 'swimming_pool' }],
  ['water=pond', { water: 'pond' }],
]) {
  check(`${label} is water`, parser.isWater(tags) === true);
  check(`${label} is renderable`, parser.isRenderable(tags) === true);
}
check('natural=wood is not water', parser.isWater({ natural: 'wood' }) === false);
check('leisure=park is not water', parser.isWater({ leisure: 'park' }) === false);
check('null tags are not water', parser.isWater(null) === false);
check('coastline fills as an area', parser.isWaterArea({ tags: { natural: 'coastline' }, geometry: [{lat:0,lon:0},{lat:0,lon:1}] }) === true);
check('a stream is stroked, not filled',
  parser.isWaterArea({ tags: { waterway: 'stream' }, geometry: [{lat:0,lon:0},{lat:0,lon:1}] }) === false);

console.log('\n=== geometry is clipped to the view ===');
{
  // A way running well past the view on every side, as the API really returns.
  const outside = { south: 0, west: 0, north: 1, east: 1 };
  const raw = JSON.parse(OSM(osmWay(500, { highway: 'primary' }, 4,
    { lat: 0.5, lon: 0.5 }))).elements;
  // Push the fixture's nodes far outside on purpose.
  const far = { lat: -5, lon: -5 };
  raw.filter(e => e.type === 'node').forEach(e => { e.lat = far.lat + e.id * 0.01; e.lon = far.lon + e.id * 0.01; });
  check('a way entirely outside the view is dropped',
    parser.filterElements(raw, true, outside).length === 0);
}
{
  const view = { south: 0, west: 0, north: 0.01, east: 0.01 };
  const cross = [
    { type: 'node', id: 1, lat: -0.005, lon: 0.005 },
    { type: 'node', id: 2, lat: 0.015, lon: 0.005 },
    { type: 'way', id: 600, tags: { highway: 'primary' }, nodes: [1, 2] },
  ];
  const kept = parser.filterElements(cross, true, view);
  check('a way crossing the view is kept', kept.length === 1);
  check('and cut down to the view',
    kept.length === 1 && kept[0].geometry.every(pt =>
      pt.lat >= view.south - 1e-9 && pt.lat <= view.north + 1e-9 &&
      pt.lon >= view.west - 1e-9 && pt.lon <= view.east + 1e-9),
    kept.length ? `-> ${JSON.stringify(kept[0].geometry)}` : '');
}
{
  // Every side at once, which is where a sign error in the clipper shows up.
  const view = { south: 0, west: 0, north: 0.01, east: 0.01 };
  const corners = [
    [-0.005, 0.005], [0.015, 0.005], [0.015, -0.005], [-0.005, -0.005],
  ];
  const nodes = corners.map(([lat, lon], i) => ({ type: 'node', id: 700 + i, lat, lon }));
  const line = { type: 'way', id: 700, tags: { highway: 'primary' }, nodes: nodes.map(n => n.id) };
  const kept = parser.filterElements([...nodes, line], true, view);
  check('a line looping outside on all four sides is clipped in',
    kept.length === 1 && kept[0].geometry.length > 0,
    kept.length ? `-> ${kept[0].geometry.length} points` : '-> dropped');
  check('nothing survives outside the view',
    kept.length === 1 && kept[0].geometry.every(pt =>
      pt.lat >= view.south - 1e-9 && pt.lat <= view.north + 1e-9 &&
      pt.lon >= view.west - 1e-9 && pt.lon <= view.east + 1e-9));
}
check('clipping a segment on all four edges at once keeps the middle',
  mod.clipSegment({ lat: -1, lon: 0.5 }, { lat: 1, lon: 0.5 },
    { south: 0, west: 0, north: 1, east: 1 })
    .every(pt => pt.lat >= 0 && pt.lat <= 1));
check('a segment wholly outside is rejected',
  mod.clipSegment({ lat: 2, lon: 2 }, { lat: 3, lon: 3 },
    { south: 0, west: 0, north: 1, east: 1 }) === null);
{
  // Each upper edge needs the unscaled delta, which is exactly where a sign
  // error slipped through before: the east edge has to bound longitude from above.
  const box = { south: 0, west: 0, north: 1, east: 1 };
  const seg = mod.clipSegment({ lat: 0.5, lon: 0 }, { lat: 0.5, lon: 1 }, box);
  check('a segment along the full view survives whole',
    seg[0].lon === 0 && seg[1].lon === 1, `-> ${JSON.stringify(seg)}`);
  const cut = mod.clipSegment({ lat: 0.5, lon: -1 }, { lat: 0.5, lon: 2 }, box);
  check('a segment overrunning east and west is cut to the view',
    cut[0].lon === 0 && cut[1].lon === 1, `-> ${JSON.stringify(cut)}`);
  const cut2 = mod.clipSegment({ lat: -1, lon: 0.5 }, { lat: 2, lon: 0.5 }, box);
  check('a segment overrunning north and south is cut to the view',
    cut2[0].lat === 0 && cut2[1].lat === 1, `-> ${JSON.stringify(cut2)}`);
}

console.log('\n=== shorelines become fillable water ===');
{
  // OSM puts water on the RIGHT of a coastline way's direction.
  const view = { south: 0, west: 0, north: 1, east: 1 };
  const waterIn = (shores) => {
    const regions = parser.coastlineRegions(shores, view);
    return regions.reduce((a, r) => a + Math.abs(mod.signedArea(r.geometry)), 0);
  };
  const inside = (ring, pt) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.lat > pt.lat) === (b.lat > pt.lat)) continue;
      const t = (pt.lat - a.lat) / (b.lat - a.lat);
      if (pt.lon < a.lon + t * (b.lon - a.lon)) hit = !hit;
    }
    return hit;
  };

  const northSouth = [{ lat: 0, lon: 0.5 }, { lat: 1, lon: 0.5 }];
  check('a shore running north puts water to the east',
    Math.abs(waterIn([northSouth]) - 0.5) < 1e-9, `-> ${waterIn([northSouth])}`);
  check('reversing the shore moves the water to the west',
    Math.abs(waterIn([northSouth.slice().reverse()]) - 0.5) < 1e-9);
  const regions = parser.coastlineRegions([northSouth], view);
  check('water lands east of a north-running shore',
    regions.length === 1 && inside(regions[0].geometry, { lat: 0.5, lon: 0.75 }));
  check('and not west of it',
    regions.length === 1 && !inside(regions[0].geometry, { lat: 0.5, lon: 0.25 }));

  // A river: two banks, water only in the band between them. Closing either bank
  // on its own floods the whole view, which is what this guards against.
  const band = [
    [{ lat: 0, lon: 0.2 }, { lat: 1, lon: 0.2 }],
    [{ lat: 1, lon: 0.8 }, { lat: 0, lon: 0.8 }],
  ];
  check('a river fills only between its banks',
    Math.abs(waterIn(band) - 0.6) < 1e-9, `-> ${waterIn(band)}`);
  const bandRegions = parser.coastlineRegions(band, view);
  check('the band is one region, not two floods',
    bandRegions.length === 1 && Math.abs(Math.abs(mod.signedArea(bandRegions[0].geometry)) - 0.6) < 1e-9,
    `-> ${bandRegions.length} regions`);
  check('the middle of the band is water',
    bandRegions.length === 1 && inside(bandRegions[0].geometry, { lat: 0.5, lon: 0.5 }));
  check('the land beyond the banks is not',
    bandRegions.length === 1 && !inside(bandRegions[0].geometry, { lat: 0.5, lon: 0.1 }) &&
    !inside(bandRegions[0].geometry, { lat: 0.5, lon: 0.9 }));

  // Banks running the other way describe the complement, not the same river.
  check('reversed banks describe the complement',
    Math.abs(waterIn(band.map(b => b.slice().reverse())) - 0.4) < 1e-9,
    `-> ${waterIn(band.map(b => b.slice().reverse()))}`);

  check('no shorelines means no water', waterIn([]) === 0);
  check('a shoreline with no bbox yields nothing', parser.coastlineRegions([northSouth], null).length === 0);

  // A shore that closes on itself, like an islet: the water is the ring it
  // encloses, and the rest of the view is land. Its heading at a node has to come
  // from the first segment, not from the vector to the far end, or the sort ties
  // and faces merge.
  const islet = [
    { lat: 0.5, lon: 0.1 }, { lat: 0.9, lon: 0.4 }, { lat: 0.5, lon: 0.7 },
    { lat: 0.1, lon: 0.4 }, { lat: 0.5, lon: 0.1 },
  ];
  const closed = parser.coastlineRegions([islet], view);
  check('a closed shore bounds exactly one region', closed.length === 1,
    `-> ${closed.length} regions`);
  check('and its water follows the curve, not the chord',
    closed.length === 1 &&
    Math.abs(Math.abs(mod.signedArea(closed[0].geometry)) - 0.24) < 1e-9,
    closed.length ? `-> ${Math.abs(mod.signedArea(closed[0].geometry)).toFixed(3)} of 1.0` : '');
  check('the ring itself is water',
    closed.length === 1 && inside(closed[0].geometry, { lat: 0.5, lon: 0.4 }));
  check('and the open view around it is not',
    closed.length === 1 && !inside(closed[0].geometry, { lat: 0.5, lon: 0.9 }));
  // Known limitation, pinned so it cannot change by accident. A ring whose water
  // is on the *outside* is unbounded, so it merges with the face beyond the view
  // and there is no bounded region left to fill. It needs the ring attached to the
  // view edge to be resolvable, which real shores get by crossing the view.
  check('a ring enclosing land draws nothing (known limitation)',
    waterIn([islet.slice().reverse()]) === 0,
    `-> ${waterIn([islet.slice().reverse()])}`);

  // A shore that just grazes the view edge leaves a face whose ring folds back
  // through itself. It must not be mistaken for water bigger than the view.
  const grazing = [
    { lat: 0.5, lon: 0 }, { lat: 0.9, lon: 0.3 }, { lat: 0.5, lon: 0.6 },
    { lat: 0.1, lon: 0.3 }, { lat: 0.5, lon: 0 },
  ];
  const grazed = parser.coastlineRegions([grazing], view);
  check('a shore grazing the view edge yields only the ring',
    grazed.length === 1 && Math.abs(Math.abs(mod.signedArea(grazed[0].geometry)) - 0.24) < 1e-9,
    `-> ${grazed.length} regions` +
    (grazed.length ? `, areas ${grazed.map(r => Math.abs(mod.signedArea(r.geometry)).toFixed(3)).join(',')}` : ''));
  check('no water region is ever larger than the view',
    grazed.every(r => Math.abs(mod.signedArea(r.geometry)) <= 1 + 1e-9));
}
{
  // A shoreline is never stroked on its own; it only ever arrives as a region.
  const box = boxOfMeters(800);
  const raw = JSON.parse(OSM(osmWay(800, { natural: 'coastline' }, 4, TEST_CENTRE))).elements;
  const kept = parser.filterElements(raw, true, box);
  check('a bare shoreline way does not survive as a line', kept.length === 0,
    `-> ${kept.length} elements`);
}

console.log('\n=== water regions survive to the painter ===');
{
  const view = { south: 0, west: 0, north: 1, east: 1 };
  const regions = parser.coastlineRegions([[{ lat: 0, lon: 0.5 }, { lat: 1, lon: 0.5 }]], view);
  const scene = [...regions, el(1, { highway: 'primary' }), el(2, { building: 'yes' })];
  threw = false;
  try { parser.drawScene(ctx, 200, 200, scene, view); } catch (e) { threw = e; }
  check('a filled water region renders', threw === false, threw ? `-> ${threw.message}` : '');
  const holes = parser.coastlineRegions([[{ lat: 0, lon: 0.5 }, { lat: 1, lon: 0.5 }]], view)
    .map(r => ({ ...r, hole: true }));
  threw = false;
  try { parser.drawScene(ctx, 200, 200, holes, view); } catch (e) { threw = e; }
  check('a region marked as a hole is skipped, not painted', threw === false,
    threw ? `-> ${threw.message}` : '');
}

console.log('\n=== degenerate inputs rejected ===');
threw = false;
try { parser.drawScene(ctx, 100, 100, [], { south: 5, west: 0, north: 5, east: 1 }); } catch { threw = true; }
check('zero-height bbox throws', threw);
threw = false;
try { parser.drawScene(ctx, 100, 100, [], { south: 5, west: 1, north: 6, east: 0 }); } catch { threw = true; }
check('inverted bbox throws', threw);
threw = false;
try { parser.drawScene(ctx, 0, 100, [], { south: 5, west: 0, north: 6, east: 1 }); } catch { threw = true; }
check('zero-width canvas throws', threw);
threw = false;
try { parser.drawScene(ctx, 100, 100, null, { south: 5, west: 0, north: 6, east: 1 }); } catch { threw = true; }
check('null element list throws', threw);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
