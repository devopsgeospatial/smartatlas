/* Verify the prepared data decodes the way the app decodes it, and that the
 * decoded arrays agree with the aggregates in stats.json.
 * Run: npm run check:data
 */
import { readFileSync } from 'node:fs';

const ORDER = ['CM', 'CMI', 'RAP', 'ROR', 'RI', 'PI', 'I'];
const YEARS = ['2025', '2023'];

let fail = 0;
const check = (name, ok, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const asBuffer = (p) => {
  const r = readFileSync(p);
  return r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength);
};

/* ---- attributes ---------------------------------------------------------- */
const stats = JSON.parse(readFileSync('public/data/stats.json', 'utf8'));
const buf = asBuffer('public/data/buildings.bin');

const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 5));
const n = new DataView(buf).getUint32(5, true);

let o = 9;
const lon = new Float32Array(buf.slice(o, o + n * 4)); o += n * 4;
const lat = new Float32Array(buf.slice(o, o + n * 4)); o += n * 4;
const use = new Uint8Array(buf, o, n); o += n;
const year = new Uint8Array(buf, o, n); o += n;
const floors = new Uint8Array(buf, o, n); o += n;
const score = new Uint8Array(buf, o, n); o += n;
const area = new Uint16Array(buf.slice(o, o + n * 2)); o += n * 2;
const height = new Uint16Array(buf.slice(o, o + n * 2)); o += n * 2;
const admin = new Uint16Array(buf.slice(o, o + n * 2)); o += n * 2;
const sector = new Uint8Array(buf, o, n); o += n;
const zone = new Uint8Array(buf, o, n); o += n;

check('magic is SPAB3', magic === 'SPAB3', magic);
check('record count matches stats.json', n === stats.buildings.total, n.toLocaleString());
check('all attribute bytes consumed', o === buf.byteLength, `${o} of ${buf.byteLength}`);

let inBox = 0;
for (let i = 0; i < n; i++) {
  if (lon[i] > 29.9 && lon[i] < 30.4 && lat[i] > -2.2 && lat[i] < -1.7) inBox++;
}
check('coordinates inside Kigali', inBox / n > 0.999, `${((100 * inBox) / n).toFixed(2)}%`);

const byUse = {}, byYear = {};
for (let i = 0; i < n; i++) {
  if (use[i] < 255) byUse[ORDER[use[i]]] = (byUse[ORDER[use[i]]] || 0) + 1;
  if (year[i] < 255) byYear[YEARS[year[i]]] = (byYear[YEARS[year[i]]] || 0) + 1;
}
for (const c of ORDER) {
  check(`use ${c}`, byUse[c] === stats.buildings.byUse[c],
    `${(byUse[c] || 0).toLocaleString()} vs ${(stats.buildings.byUse[c] || 0).toLocaleString()}`);
}
for (const y of YEARS) {
  check(`year ${y}`, byYear[y] === stats.buildings.byYear[y],
    `${(byYear[y] || 0).toLocaleString()} vs ${(stats.buildings.byYear[y] || 0).toLocaleString()}`);
}

const zn = stats.buildings.zoneNames;
let badZone = 0;
for (let i = 0; i < n; i++) if (zone[i] >= zn.length) badZone++;

const adminTable = JSON.parse(readFileSync('public/data/admin.json', 'utf8'));
let badAdmin = 0;
const unitSeen = new Set();
for (let i = 0; i < n; i++) {
  const a = admin[i];
  if (a === 65535) continue;
  if (a >= adminTable.units.length) badAdmin++;
  else unitSeen.add(a);
}
const sn = stats.buildings.sectorNames;
let badSector = 0;
for (let i = 0; i < n; i++) if (sector[i] >= sn.length) badSector++;
check('sector indices resolve', badSector === 0, `${sn.length} sectors`);

check('admin indices resolve', badAdmin === 0, `${unitSeen.size} villages carry structures`);
const unmatchedAdmin = (() => { let k = 0; for (let i = 0; i < n; i++) if (admin[i] === 65535) k++; return k; })();
/* An admin path that matches no village silently drops the structure from every
 * area filter, so it is worth a line even when it is zero. */
/* Cell and Village are absent from some exports and recovered by upi, so a
 * residue is expected. District and sector filters do not depend on it; cell
 * and village do, and that is what this number measures. */
check(
  'village coverage above 90%',
  (n - unmatchedAdmin) / n > 0.9,
  `${(((n - unmatchedAdmin) / n) * 100).toFixed(1)}% placed, ${unmatchedAdmin.toLocaleString()} not`,
);
check('zone indices resolve', badZone === 0, `${zn.length} zones`);

let badFloors = 0;
for (let i = 0; i < n; i++) if (floors[i] > 60) badFloors++;
check('floor counts plausible', badFloors === 0);

/* Ground confirmation is a headline tile, and it is the one aggregate with no
 * array to cross-check it against — stats.json is the only copy. A source
 * revision once shipped this field as the string "No" instead of null, which
 * plain truthiness in the pipeline read as confirmed and turned 2.2% into 100%.
 * A survey covering every structure in the city is not a plausible figure, so
 * anything at or near total is treated as that bug rather than as good news. */
const gc = stats.buildings.groundConfirmed;
const gcPct = (gc / stats.buildings.total) * 100;
check(
  'ground-confirmed count is plausible',
  gc > 0 && gcPct < 50,
  `${gc.toLocaleString()} of ${stats.buildings.total.toLocaleString()} (${gcPct.toFixed(2)}%)`,
);

/* ---- footprint geometry -------------------------------------------------- */
const g = asBuffer('public/data/geometry.bin');
const gmagic = new TextDecoder().decode(new Uint8Array(g, 0, 5));
const gdv = new DataView(g);
const gn = gdv.getUint32(5, true);
const verts = gdv.getUint32(9, true);

let go = 13;
const off = new Uint32Array(g.slice(go, go + (gn + 1) * 4)); go += (gn + 1) * 4;
const gdx = new Int16Array(g.slice(go, go + verts * 2)); go += verts * 2;
const gdy = new Int16Array(g.slice(go, go + verts * 2)); go += verts * 2;

check('geometry magic is SPAG1', gmagic === 'SPAG1', gmagic);
check('geometry count matches attributes', gn === n, gn.toLocaleString());
check('all geometry bytes consumed', go === g.byteLength, `${go} of ${g.byteLength}`);
check('offsets monotonic', (() => {
  for (let i = 0; i < gn; i++) if (off[i + 1] < off[i]) return false;
  return true;
})());
check('final offset equals vertex count', off[gn] === verts, verts.toLocaleString());

let degenerate = 0, oversize = 0;
for (let i = 0; i < gn; i++) {
  const c = off[i + 1] - off[i];
  if (c < 3) degenerate++;
  if (c > 500) oversize++;
}
check('every ring has 3+ vertices', degenerate === 0, `${degenerate} degenerate`);
check('no runaway rings', oversize === 0);

// A rebuilt footprint must sit on top of the centroid it was encoded against.
let offCentre = 0;
for (let i = 0; i < gn; i += 997) {
  const a = off[i], b = off[i + 1];
  let sx = 0, sy = 0;
  for (let k = a; k < b; k++) { sx += gdx[k]; sy += gdy[k]; }
  if (Math.abs(sx / (b - a)) * 1e-6 > 5e-4 || Math.abs(sy / (b - a)) * 1e-6 > 5e-4) offCentre++;
}
check('rings centred on their centroid', offCentre === 0, `${offCentre} outliers`);

console.log(
  `\nrow 0: ${lat[0].toFixed(6)}, ${lon[0].toFixed(6)}  ` +
  `use=${ORDER[use[0]]} year=${YEARS[year[0]]} floors=${floors[0]} ` +
  `area=${area[0]}m² height=${(height[0] / 10).toFixed(1)}m ` +
  `zone=${zn[zone[0]]}`,
);
const u0 = adminTable.units[admin[0]];
console.log(
  `admin 0: ${u0 ? [u0.d, u0.s, u0.c, u0.v].join(' / ') : 'unmatched'}`,
);
console.log(
  `ring 0: ${off[1] - off[0]} vertices, first at ` +
  `${(lat[0] + gdy[0] * 1e-6).toFixed(7)}, ${(lon[0] + gdx[0] * 1e-6).toFixed(7)}`,
);

console.log(fail === 0 ? '\nAll checks passed.' : `\n${fail} check(s) failed.`);
process.exit(fail === 0 ? 0 : 1);
