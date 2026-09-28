// Loads index.html's inline script against a DOM stub and exercises
// renderSingleTile(), which is new code with real branching (input clamping,
// fetch failure, render failure, busy guard).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolved from this file, so the suite runs from any working directory.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const parserSrc = readFileSync(join(ROOT, 'src', 'PoGoMapParser.js'), 'utf8');
const html = readFileSync(join(ROOT, 'demo', 'index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

// ---- canvas / DOM stubs -------------------------------------------------
const pattern = {};
const gradient = { addColorStop() {} };
const noop = () => {};
const ctx = {
  createPattern: () => pattern, createRadialGradient: () => gradient,
  getImageData: () => ({ data: new Uint8ClampedArray(128 * 128 * 4) }),
  putImageData: noop, fillRect: noop, beginPath: noop, moveTo: noop,
  lineTo: noop, closePath: noop, fill: noop, stroke: noop,
  setTransform: noop, arc: noop, beginPath: noop,
  fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '', globalAlpha: 1,
};

function makeEl(id = '') {
  return {
    id, width: 0, height: 0, innerText: '', disabled: false,
    style: {}, children: [],
    getContext: () => ctx,
    appendChild(child) { this.children.push(child); return child; },
    addEventListener: noop,
    setAttribute: noop, removeAttribute: noop, classList: { add: noop, remove: noop },
  };
}

const byId = new Map();
for (const id of ['statusLog', 'pyramidLog', 'pyramidGrid', 'pyramidBtn',
                  'singleTileBtn', 'outputTitle', 'outputBlurb',
                  'tileZoom', 'tileSize', 'tileLat', 'tileLon']) {
  byId.set(id, makeEl(id));
}
// The engine canvas the parser binds to.
byId.set('pogoCanvas', Object.assign(makeEl('pogoCanvas'), { width: 550, height: 550 }));

globalThis.document = {
  getElementById: (id) => byId.get(id) || null,
  createElement: () => makeEl(),
};
globalThis.AbortController = globalThis.AbortController || class {
  constructor() { this.signal = {}; }
  abort() { this.aborted = true; }
};
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.window = { open: () => null };

// Track every element the script builds, so we can inspect the rendered tile.
const created = [];
const realCreate = globalThis.document.createElement;
globalThis.document.createElement = (tag) => { const e = makeEl(); e.tag = tag; created.push(e); return e; };

const PoGoMapParser = new Function(`${parserSrc}; return PoGoMapParser;`)();
// `parser` is exported from the page's own closure so the failure tests can
// drive the very instance renderSingleTile() talks to, instead of a decoy.
const api = new Function('PoGoMapParser', 'document', 'window', 'performance', `
  ${script}
  return { parser, renderSingleTile, renderPyramid, claimOutput, releaseOutput,
           readNumber, formatSpan, CENTER, PYRAMID, buildTiers, buildTileSpecs, pickTier };
`)(PoGoMapParser, globalThis.document, globalThis.window, globalThis.performance);

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

console.log('=== 25-level zoom pyramid ===');
const specs = api.buildTileSpecs();
check('pyramid declares 25 levels', api.PYRAMID.levels === 25, `-> ${api.PYRAMID.levels}`);
check('produces exactly 25 tiles', specs.length === 25, `-> ${specs.length}`);
check('coarsest level is z10', specs[0].zoom === 10, `-> z${specs[0].zoom}`);
check('finest level is z34', specs[24].zoom === 34, `-> z${specs[24].zoom}`);
check('every level is a whole number', specs.every(s => Number.isInteger(s.zoom)),
  `-> ${specs.filter(s => !Number.isInteger(s.zoom)).length} fractional`);
check('levels are strictly increasing',
  specs.every((s, i) => i === 0 || s.zoom > specs[i - 1].zoom));
check('levels cover z10 through z34 with no gaps',
  specs.every((s, i) => s.zoom === 10 + i),
  `-> first mismatch at index ${specs.findIndex((s, i) => s.zoom !== 10 + i)}`);
check('coarsest tile is the smallest pixel size', specs[0].size === api.PYRAMID.minTilePx,
  `-> ${specs[0].size}px`);
check('finest tile is the largest pixel size', specs[24].size === api.PYRAMID.maxTilePx,
  `-> ${specs[24].size}px`);
check('tiles grow monotonically in size',
  specs.every((s, i) => i === 0 || s.size >= specs[i - 1].size));
check('every tile has a usable bbox', specs.every(s =>
  s.tileBBox.north > s.tileBBox.south && s.tileBBox.east > s.tileBBox.west));
check('spans shrink as zoom rises',
  specs.every((s, i) => i === 0 ||
    PoGoMapParser.spanMeters(s.tileBBox) < PoGoMapParser.spanMeters(specs[i - 1].tileBBox)));
const tiers = api.buildTiers();
check('data tiers are fetched one zoom at a time',
  tiers.every((z, i) => z === api.PYRAMID.tierMinZoom + i),
  `-> z${tiers[0]}..z${tiers[tiers.length - 1]}`);
check('every tile maps to a fetched tier',
  specs.every(s => tiers.includes(api.pickTier(s.zoom, tiers))));
check('deep zooms reuse the finest fetched tier',
  api.pickTier(34, tiers) === tiers[tiers.length - 1], `-> z${api.pickTier(34, tiers)}`);
check('zooms coarser than every tier fall back to the first',
  api.pickTier(10, tiers) === tiers[0], `-> z${api.pickTier(10, tiers)}`);
check('tile zoom control spans the pyramid range',
  /id="tileZoom"[^>]*min="6"[^>]*max="34"/.test(html));
check('heading advertises 25 levels', /id="outputTitle">25-Level Zoom Pyramid</.test(html));
check('no stale 17-level reference remains', !/17-Level/.test(html));

console.log('\n=== single-tile wiring ===');
check('button exists in the page', !!byId.get('singleTileBtn'));
check('button is wired to renderSingleTile', /onclick="renderSingleTile\(\)"/.test(html));
check('all four tile inputs exist',
  ['tileZoom', 'tileSize', 'tileLat', 'tileLon'].every(id => byId.get(id)));
check('output area has a title to relabel', /id="outputTitle"/.test(html) && /id="outputBlurb"/.test(html));
check('single-tile option is offered instead of the pyramid',
  /instead of the whole pyramid/.test(html));

console.log('\n=== input clamping (garbage / empty / out of range) ===');
const zoomIn = byId.get('tileZoom'), sizeIn = byId.get('tileSize');
const latIn = byId.get('tileLat'), lonIn = byId.get('tileLon');
zoomIn.value = ''; sizeIn.value = ''; latIn.value = ''; lonIn.value = '';
check('empty zoom falls back to 17', api.readNumber(zoomIn, 17, 10, 24) === 17);
check('empty size falls back to 256', api.readNumber(sizeIn, 256, 64, 1024) === 256);
zoomIn.value = 'abc'; sizeIn.value = 'abc';
check('non-numeric falls back', api.readNumber(zoomIn, 17, 10, 24) === 17);
zoomIn.value = '99'; sizeIn.value = '99999'; latIn.value = '95';
check('zoom clamped to max', api.readNumber(zoomIn, 17, 10, 24) === 24);
check('size clamped to max', api.readNumber(sizeIn, 256, 64, 1024) === 1024);
check('lat clamped to valid range', api.readNumber(latIn, 0, -85, 85) === 85);
zoomIn.value = '2'; sizeIn.value = '1'; latIn.value = '-99';
check('zoom clamped to min', api.readNumber(zoomIn, 17, 10, 24) === 10);
check('size clamped to min', api.readNumber(sizeIn, 256, 64, 1024) === 64);
check('fractional zoom kept', (() => { zoomIn.value = '17.5'; return api.readNumber(zoomIn, 17, 10, 24) === 17.5; })());

console.log('\n=== happy path renders one tile ===');
// fetchMapData / renderTo are stubbed on the prototype, so the page's own
// parser instance exercises the real control flow around them.
const originalFetch = PoGoMapParser.prototype.fetchMapData;
const originalRenderTo = PoGoMapParser.prototype.renderTo;
let renderToArgs = null;
PoGoMapParser.prototype.fetchMapData = async () => ([
  { type: 'way', id: 1, tags: { highway: 'primary' }, geometry: [{ lat: 40.75, lon: -73.984 }, { lat: 40.751, lon: -73.983 }] },
]);
PoGoMapParser.prototype.renderTo = function (canvas, data, bbox) { renderToArgs = { canvas, data, bbox }; };

created.length = 0;
zoomIn.value = '17'; sizeIn.value = '256'; latIn.value = '40.75'; lonIn.value = '-73.984';
byId.get('pyramidLog').innerText = '';
await api.renderSingleTile();
const canvasEl = created.find(e => e.tag === 'canvas');
const figEl = created.find(e => e.tag === 'figure');
check('created exactly one canvas', created.filter(e => e.tag === 'canvas').length === 1);
check('created exactly one figure', created.filter(e => e.tag === 'figure').length === 1);
check('canvas sized to the request', canvasEl.width === 256 && canvasEl.height === 256,
  `-> ${canvasEl.width}x${canvasEl.height}`);
check('renderTo was called once', !!renderToArgs);
check('renderTo got the fetched data', renderToArgs && renderToArgs.data.length === 1);
check('renderTo got a matching bbox',
  renderToArgs && Math.abs(renderToArgs.bbox.east - renderToArgs.bbox.west) > 0);
check('log reports success', /rendered 1 vectors/.test(byId.get('pyramidLog').innerText),
  `-> "${byId.get('pyramidLog').innerText}"`);
check('output title switched to single-tile mode', /Single Tile/.test(byId.get('outputTitle').innerText),
  `-> "${byId.get('outputTitle').innerText}"`);
check('caption shows the vector count', /1 vec/.test(figEl.children[1].innerHTML || ''),
  `-> "${figEl.children[1].innerHTML}"`);

console.log('\n=== busy guard: pyramid and single tile cannot overlap ===');
check('output is free again after the run', api.claimOutput() === true);
check('a second claim is refused while busy', api.claimOutput() === false);
api.releaseOutput();
check('released output can be claimed again', api.claimOutput() === true);
api.releaseOutput();

console.log('\n=== fetch failure degrades instead of throwing ===');
// The page detects failure by watching its own parser's lastError, so the stub
// has to set it on that instance for the failure branch to be reachable.
PoGoMapParser.prototype.fetchMapData = async function () {
  this.lastError = 'OSM API returned HTTP 400 - bbox too large';
  return [];
};
created.length = 0;
api.parser.lastError = null;
byId.get('pyramidLog').innerText = '';
await api.renderSingleTile();
const failFig = created.find(e => e.tag === 'figure');
check('still produced a tile, did not throw', !!failFig);
check('failure surfaced in the log', /fetch failed/.test(byId.get('pyramidLog').innerText),
  `-> "${byId.get('pyramidLog').innerText}"`);
check('underlying error quoted', /HTTP 400/.test(byId.get('pyramidLog').innerText));
check('caption marks the tile failed', /fetch failed/.test(failFig.children[1].innerHTML || ''),
  `-> "${failFig.children[1].innerHTML}"`);
check('buttons re-enabled after the run', byId.get('pyramidBtn').disabled === false
  && byId.get('singleTileBtn').disabled === false);

console.log('\n=== a genuinely empty area is not reported as a failure ===');
PoGoMapParser.prototype.fetchMapData = async function () { this.lastError = null; return []; };
created.length = 0;
api.parser.lastError = null;
byId.get('pyramidLog').innerText = '';
await api.renderSingleTile();
check('empty area reads as "no data"', /rendered 0 vectors/.test(byId.get('pyramidLog').innerText),
  `-> "${byId.get('pyramidLog').innerText}"`);

console.log('\n=== a thrown fetch does not kill the page ===');
PoGoMapParser.prototype.fetchMapData = async () => { throw new Error('split exploded'); };
created.length = 0;
api.parser.lastError = null;
byId.get('pyramidLog').innerText = '';
const realError = console.error;
console.error = () => {};                 // the page logs this on purpose
let threw = false;
try { await api.renderSingleTile(); } catch { threw = true; } finally { console.error = realError; }
check('renderSingleTile absorbed the throw', threw === false);
check('reported the failure', /split exploded/.test(byId.get('pyramidLog').innerText),
  `-> "${byId.get('pyramidLog').innerText}"`);
check('buttons re-enabled after the throw',
  byId.get('pyramidBtn').disabled === false && byId.get('singleTileBtn').disabled === false);

PoGoMapParser.prototype.fetchMapData = originalFetch;
PoGoMapParser.prototype.renderTo = originalRenderTo;

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
