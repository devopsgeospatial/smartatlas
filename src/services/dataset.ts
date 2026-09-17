/* ----------------------------------------------------------------------------
 * The dataset, held in memory.
 *
 * Reads the exported tables prepared by tools/prepare_data.py rather than the
 * Feature Service. Everything the interface needs is in typed arrays, so a
 * filter change is a pass over memory instead of a network round trip — counts
 * update as fast as the tick, which is the whole point.
 *
 * Swapping back to the live service later means reimplementing this module's
 * four functions; nothing above it knows where the data came from.
 * -------------------------------------------------------------------------- */

import { ORDER, YEAR_ORDER } from '../constants';
import type { BFeature, Filters } from '../types';

export interface TaxTable {
  /** Parcels designated for construction with no structure on them. */
  parcels: number;
  vacantDesignated: number;
  vacantSqm: number;
  byStatus: Record<string, number>;
  vacantByZone: Record<string, number>;
  vacantByDistrict: Record<string, number>;
  vacantBySector: {
    sector: string;
    district: string;
    vacant: number;
    sqm: number;
    byZone: Record<string, number>;
  }[];
}

/**
 * The vacant-land figures for whatever area is selected.
 *
 * The parcel table is aggregated at build time rather than held row by row, so
 * a sector is narrowed by picking its precomputed row instead of scanning. The
 * fields that only mean something city-wide — the district split, the sector
 * ranking — are null when one sector is in scope, so a caller cannot render a
 * chart that silently still shows the whole city.
 */
export interface TaxView {
  /** The name of the area these figures are for, or 'ALL'. */
  scope: string;
  /** The district containing it. Null city-wide. */
  district: string | null;
  vacant: number;
  sqm: number;
  byZone: Record<string, number>;
  byDistrict: Record<string, number> | null;
  bySector: TaxTable['vacantBySector'] | null;
  /**
   * The finest level the parcel table can actually answer at.
   *
   * The tax extract is aggregated to sector. A cell or village selection
   * therefore cannot narrow it further, and the panel says so rather than
   * showing the sector's figures under a village's name.
   */
  servedAt: 'city' | 'district' | 'sector';
  /** True when the user asked for something finer than servedAt. */
  coarserThanAsked: boolean;
}

/**
 * Narrow the parcel figures as far as the tax extract allows.
 *
 * Buildings are held per village; parcels only per sector. Rather than pretend
 * otherwise, this resolves to the deepest level it can serve and reports both
 * that level and whether the request went deeper.
 */
export function taxFor(tax: TaxTable, f: Filters): TaxView {
  const city = {
    scope: 'ALL',
    district: null,
    vacant: tax.vacantDesignated,
    sqm: tax.vacantSqm,
    byZone: tax.vacantByZone,
    byDistrict: tax.vacantByDistrict,
    bySector: tax.vacantBySector,
    servedAt: 'city' as const,
    coarserThanAsked: false,
  };
  if (f.district === 'ALL') return city;

  const deeperAsked = f.cell !== 'ALL' || f.village !== 'ALL';

  if (f.sector === 'ALL') {
    // Roll the sector rows up to the district; the extract has no district row
    // carrying area, only a count.
    const rows = tax.vacantBySector.filter((r) => r.district === f.district);
    const byZone: Record<string, number> = {};
    let vacant = 0;
    let sqm = 0;
    for (const r of rows) {
      vacant += r.vacant;
      sqm += r.sqm;
      for (const [z, v] of Object.entries(r.byZone || {})) byZone[z] = (byZone[z] || 0) + v;
    }
    return {
      scope: f.district,
      district: f.district,
      vacant,
      sqm,
      byZone,
      byDistrict: null,
      bySector: rows,
      servedAt: 'district',
      coarserThanAsked: false,
    };
  }

  const row = tax.vacantBySector.find((r) => r.sector === f.sector);
  /* A sector with no vacant parcels has no row at all. That is a real answer —
   * zero — not missing data, so it reports zero rather than falling back to the
   * city total, which would read as if the filter had been ignored. */
  return {
    scope: f.sector,
    district: row?.district ?? f.district,
    vacant: row?.vacant ?? 0,
    sqm: row?.sqm ?? 0,
    byZone: row?.byZone ?? {},
    byDistrict: null,
    bySector: null,
    servedAt: 'sector',
    coarserThanAsked: deeperAsked,
  };
}

/** One village, and the path that identifies it. Written by prepare_admin.py. */
export interface AdminUnit {
  d: string;
  s: string;
  c: string;
  v: string;
  /** [w, s, e, n] — enough to fly to the unit before any boundary has loaded. */
  bb: [number, number, number, number];
  /** A point inside the unit, for a label. */
  lp: [number, number] | null;
}

export interface AdminTable {
  units: AdminUnit[];
  districts: { d: string; bb: [number, number, number, number] }[];
  sectors: { d: string; s: string; bb: [number, number, number, number] }[];
  cells: { d: string; s: string; c: string; bb: [number, number, number, number] }[];
}

/**
 * The hierarchy, resolved once into integer lookups.
 *
 * A building carries a single Uint16 pointing at a village row. Filtering by
 * district would otherwise mean a string comparison per structure per frame, so
 * each level gets its own index array over the unit table and every comparison
 * stays integer.
 */
export interface AdminIndex {
  table: AdminTable;
  districtNames: string[];
  /** Sector and cell keys are path-qualified: a name alone is not unique. */
  sectorKeys: string[];
  cellKeys: string[];
  unitDistrict: Uint8Array;
  unitSector: Uint8Array;
  unitCell: Uint16Array;
}

export const SEP = '\u0001';

export function buildAdminIndex(table: AdminTable): AdminIndex {
  const districtNames: string[] = [];
  const sectorKeys: string[] = [];
  const cellKeys: string[] = [];
  const dOf = new Map<string, number>();
  const sOf = new Map<string, number>();
  const cOf = new Map<string, number>();
  const n = table.units.length;
  const unitDistrict = new Uint8Array(n);
  const unitSector = new Uint8Array(n);
  const unitCell = new Uint16Array(n);

  table.units.forEach((u, i) => {
    if (!dOf.has(u.d)) {
      dOf.set(u.d, districtNames.length);
      districtNames.push(u.d);
    }
    const sk = u.d + SEP + u.s;
    if (!sOf.has(sk)) {
      sOf.set(sk, sectorKeys.length);
      sectorKeys.push(sk);
    }
    const ck = sk + SEP + u.c;
    if (!cOf.has(ck)) {
      cOf.set(ck, cellKeys.length);
      cellKeys.push(ck);
    }
    unitDistrict[i] = dOf.get(u.d)!;
    unitSector[i] = sOf.get(sk)!;
    unitCell[i] = cOf.get(ck)!;
  });

  return { table, districtNames, sectorKeys, cellKeys, unitDistrict, unitSector, unitCell };
}

export interface RawStats {
  generatedAt: string;
  buildings: {
    total: number;
    byUse: Record<string, number>;
    byYear: Record<string, number>;
    byZone: Record<string, number>;
    byZoneUse: Record<string, Record<string, number>>;
    byDistrict: Record<string, number>;
    byStatus: Record<string, number>;
    zoneLabels: Record<string, string>;
    sectorNames: string[];
    zoneNames: string[];
    groundConfirmed: number;
  };
  tax: TaxTable;
}

export interface Dataset {
  n: number;
  lon: Float32Array;
  lat: Float32Array;
  use: Uint8Array;
  year: Uint8Array;
  floors: Uint8Array;
  score: Uint8Array;
  area: Uint16Array;
  height: Uint16Array;
  /** Index into admin.units. 65535 when the path matched no village. */
  admin: Uint16Array;
  /** Index into stats.buildings.sectorNames. Present on every structure. */
  sector: Uint8Array;
  zone: Uint8Array;
  /** Footprint outlines: vertex range per structure, deltas from the centroid. */
  ringStart: Uint32Array;
  dx: Int16Array;
  dy: Int16Array;
  upis: string[];
  stats: RawStats;
  adminIndex: AdminIndex;
  sectorNames: string[];
  zoneNames: string[];
}

let cache: Dataset | null = null;

/** Bytes received so far, and the total once every response has declared its size. */
export interface LoadProgress {
  loaded: number;
  total: number | null;
}

/**
 * Fetch a file as bytes, reporting its declared size as soon as the headers
 * land and each chunk as it arrives. Returns null for a missing file so the
 * caller can decide whether that is fatal.
 */
async function fetchBytes(
  url: string,
  onSize: (bytes: number | null) => void,
  onChunk: (bytes: number) => void,
): Promise<ArrayBuffer | null> {
  const res = await fetch(url);
  if (!res.ok) {
    onSize(0);
    return null;
  }
  const declared = Number(res.headers.get('content-length'));
  onSize(Number.isFinite(declared) && declared > 0 ? declared : null);

  if (!res.body) {
    const buf = await res.arrayBuffer();
    onChunk(buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    onChunk(value.byteLength);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out.buffer;
}

/**
 * The first load is the only wait in the product — some 35 MB before anything
 * can be counted — so it reports progress rather than leaving the panels blank.
 * The three data files are streamed concurrently and their sizes summed as each
 * response declares one; until all three have, the total is null.
 */
export async function loadDataset(onProgress?: (p: LoadProgress) => void): Promise<Dataset> {
  if (cache) return cache;
  const base = import.meta.env.BASE_URL;

  const sizes: (number | null | undefined)[] = [undefined, undefined, undefined];
  let loaded = 0;
  const report = () => {
    if (!onProgress) return;
    const known = sizes.every((s) => s !== undefined);
    const total = known && sizes.every((s) => s !== null) ? sizes.reduce((a, s) => a + (s || 0), 0) : null;
    onProgress({ loaded, total });
  };
  const get = (i: number, file: string) =>
    fetchBytes(
      `${base}data/${file}`,
      (s) => {
        sizes[i] = s;
        report();
      },
      (n) => {
        loaded += n;
        report();
      },
    );

  const [statsRes, adminRes, buf, geomBuf, upiBuf] = await Promise.all([
    fetch(`${base}data/stats.json`),
    fetch(`${base}data/admin.json`),
    get(0, 'buildings.bin'),
    get(1, 'geometry.bin'),
    get(2, 'upis.txt'),
  ]);
  if (!statsRes.ok || !buf) {
    throw new Error('Dataset not found. Run: python tools/prepare_data.py');
  }
  if (!adminRes.ok) {
    throw new Error('admin.json not found. Run: python tools/prepare_admin.py');
  }

  const stats: RawStats = await statsRes.json();
  const adminIndex = buildAdminIndex(await adminRes.json());
  const upiText = upiBuf ? new TextDecoder().decode(upiBuf) : '';

  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 5));
  /* SPAB2 added the administrative unit index and dropped the sector byte it
   * replaces. A cached SPAB1 file against this build would decode into
   * nonsense, so the mismatch is fatal rather than best-effort. */
  if (magic !== 'SPAB3') {
    throw new Error(
      `Unexpected dataset format ${magic} — expected SPAB3. Re-run tools/prepare_data.py, ` +
        'or hard-reload if an older dataset is cached.',
    );
  }
  const n = new DataView(buf).getUint32(5, true);

  let o = 9;
  const lon = new Float32Array(buf.slice(o, o + n * 4));
  o += n * 4;
  const lat = new Float32Array(buf.slice(o, o + n * 4));
  o += n * 4;
  const use = new Uint8Array(buf, o, n);
  o += n;
  const year = new Uint8Array(buf, o, n);
  o += n;
  const floors = new Uint8Array(buf, o, n);
  o += n;
  const score = new Uint8Array(buf, o, n);
  o += n;
  const area = new Uint16Array(buf.slice(o, o + n * 2));
  o += n * 2;
  const height = new Uint16Array(buf.slice(o, o + n * 2));
  o += n * 2;
  const admin = new Uint16Array(buf.slice(o, o + n * 2));
  o += n * 2;
  const sector = new Uint8Array(buf, o, n);
  o += n;
  const zone = new Uint8Array(buf, o, n);

  // Footprint outlines.
  let ringStart = new Uint32Array(n + 1);
  let dx = new Int16Array(0);
  let dy = new Int16Array(0);
  if (geomBuf) {
    const gbuf = geomBuf;
    const gmagic = new TextDecoder().decode(new Uint8Array(gbuf, 0, 5));
    if (gmagic === 'SPAG1') {
      const gv = new DataView(gbuf);
      const gn = gv.getUint32(5, true);
      const verts = gv.getUint32(9, true);
      let go = 13;
      ringStart = new Uint32Array(gbuf.slice(go, go + (gn + 1) * 4));
      go += (gn + 1) * 4;
      dx = new Int16Array(gbuf.slice(go, go + verts * 2));
      go += verts * 2;
      dy = new Int16Array(gbuf.slice(go, go + verts * 2));
    }
  }

  cache = {
    n,
    lon,
    lat,
    use,
    year,
    floors,
    score,
    area,
    height,
    admin,
    zone,
    ringStart,
    dx,
    dy,
    /* Split on either ending: a Windows generator, or git normalising the file
     * to LF on the way into the repo, must both yield a bare UPI. A stray \r
     * here is invisible on screen but makes every findByUpi lookup miss. */
    upis: upiText ? upiText.split(/\r?\n/) : [],
    stats,
    adminIndex,
    sector,
    sectorNames: stats.buildings.sectorNames || [],
    zoneNames: stats.buildings.zoneNames || [],
  };
  return cache;
}

/* ---- filtering ----------------------------------------------------------- */

export interface Selection {
  /** Row indices passing the current filters. */
  matches: number;
  byUse: Record<string, number>;
  byYear: Record<string, number>;
  byZone: Record<string, number>;
}

/**
 * Which administrative units the current area selection admits.
 *
 * Returned as a mask over the unit table rather than a level-specific test, so
 * the hot loops stay one array lookup deep whichever level is chosen. Null when
 * no area is selected, which lets the caller skip the check entirely.
 */
/**
 * The area test for the current filters, or null when no area is chosen.
 *
 * District and sector come from the sector index, which every structure
 * carries, so those two levels cover the whole city and agree with the district
 * totals on the panel. Cell and village come from the village index, which some
 * exports leave incomplete — a structure the upi join could not place is
 * excluded once the selection goes below sector.
 */
export function areaTest(d: Dataset, f: Filters): ((i: number) => boolean) | null {
  if (f.cell !== 'ALL' || f.village !== 'ALL') {
    const m = unitMask(d, f)!;
    return (i) => m[d.admin[i]] === 1;
  }
  if (f.sector !== 'ALL') {
    const si = d.sectorNames.indexOf(f.sector);
    return (i) => d.sector[i] === si;
  }
  if (f.district !== 'ALL') {
    const allowed = new Uint8Array(256);
    for (const r of d.adminIndex.table.sectors) {
      if (r.d !== f.district) continue;
      const si = d.sectorNames.indexOf(r.s);
      if (si >= 0) allowed[si] = 1;
    }
    return (i) => allowed[d.sector[i]] === 1;
  }
  return null;
}

export function unitMask(d: Dataset, f: Filters): Uint8Array | null {
  if (f.district === 'ALL' && f.sector === 'ALL' && f.cell === 'ALL' && f.village === 'ALL') {
    return null;
  }
  const units = d.adminIndex.table.units;
  const m = new Uint8Array(units.length);
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (f.district !== 'ALL' && u.d !== f.district) continue;
    if (f.sector !== 'ALL' && u.s !== f.sector) continue;
    if (f.cell !== 'ALL' && u.c !== f.cell) continue;
    if (f.village !== 'ALL' && u.v !== f.village) continue;
    m[i] = 1;
  }
  return m;
}

function useMask(d: Dataset, filters: Filters): Uint8Array {
  const allowed = new Uint8Array(256);
  filters.uses.forEach((c) => {
    const i = ORDER.indexOf(c);
    if (i >= 0) allowed[i] = 1;
  });
  return allowed;
}

function yearMask(d: Dataset, filters: Filters): Uint8Array {
  const allowed = new Uint8Array(256);
  filters.years.forEach((y) => {
    const i = YEAR_ORDER.indexOf(y);
    if (i >= 0) allowed[i] = 1;
  });
  return allowed;
}

/**
 * Counts for the current selection, plus per-facet counts that ignore their own
 * dimension — so a class you just unticked still shows how many ticking it back
 * on would bring.
 */
export function summarise(d: Dataset, filters: Filters): Selection {
  const uAllowed = useMask(d, filters);
  const yAllowed = yearMask(d, filters);
  const inArea = areaTest(d, filters);
  const minScore = Math.round(filters.minScore * 254);

  const byUse: Record<string, number> = {};
  const byYear: Record<string, number> = {};
  const byZone: Record<string, number> = {};
  ORDER.forEach((c) => (byUse[c] = 0));
  YEAR_ORDER.forEach((y) => (byYear[y] = 0));

  let matches = 0;
  for (let i = 0; i < d.n; i++) {
    if (inArea && !inArea(i)) continue;
    if (minScore > 0 && d.score[i] !== 255 && d.score[i] < minScore) continue;

    const u = d.use[i];
    const y = d.year[i];
    const okUse = u < 255 && uAllowed[u] === 1;
    const okYear = y < 255 && yAllowed[y] === 1;

    // Each facet counts itself against everything else selected.
    if (okYear && u < 255) byUse[ORDER[u]]++;
    if (okUse && y < 255) byYear[YEAR_ORDER[y]]++;

    if (okUse && okYear) {
      matches++;
      const z = d.zoneNames[d.zone[i]];
      if (z) byZone[z] = (byZone[z] || 0) + 1;
    }
  }
  return { matches, byUse, byYear, byZone };
}

/* ---- viewport ------------------------------------------------------------ */

export interface Bounds {
  w: number;
  s: number;
  e: number;
  n: number;
}

/** Rebuild the footprint ring from Int16 deltas; falls back to the centroid. */
function ringOf(d: Dataset, i: number): [number, number][] | null {
  if (!d.dx.length) return null;
  const a = d.ringStart[i];
  const b = d.ringStart[i + 1];
  if (b <= a) return null;
  const cx = d.lon[i];
  const cy = d.lat[i];
  const ring: [number, number][] = [];
  for (let k = a; k < b; k++) {
    ring.push([cx + d.dx[k] * 1e-6, cy + d.dy[k] * 1e-6]);
  }
  if (ring.length < 3) return null;
  ring.push(ring[0]); // GeoJSON rings must close
  return ring;
}

/** The administrative path of one structure, down to the village. */
export function adminOf(d: Dataset, i: number) {
  const u = d.adminIndex.table.units[d.admin[i]];
  if (!u) return { district: undefined, sector: undefined, cell: undefined, village: undefined };
  return { district: u.d, sector: u.s, cell: u.c, village: u.v };
}

function toFeature(d: Dataset, i: number): BFeature {
  const ring = ringOf(d, i);
  return {
    type: 'Feature',
    id: i,
    geometry: ring
      ? { type: 'Polygon', coordinates: [ring] }
      : { type: 'Point', coordinates: [d.lon[i], d.lat[i]] },
    properties: {
      OBJECTID: i,
      lon: d.lon[i],
      lat: d.lat[i],
      UPI: d.upis[i] || undefined,
      ...adminOf(d, i),
      lu_cod_pred: d.use[i] < 255 ? ORDER[d.use[i]] : undefined,
      acquisition_date: d.year[i] < 255 ? YEAR_ORDER[d.year[i]] : undefined,
      score: d.score[i] === 255 ? null : d.score[i] / 254,
      Height: d.height[i] ? d.height[i] / 10 : null,
      estimated_floor: d.floors[i] || null,
      area: d.area[i] || null,
      Proposed_Use: d.stats.buildings.zoneLabels[d.zoneNames[d.zone[i]]] || undefined,
      zoneCode: d.zoneNames[d.zone[i]] || undefined,
    },
  };
}

export function queryViewport(
  d: Dataset,
  b: Bounds,
  filters: Filters,
  cap = 20000,
): { features: BFeature[]; capped: boolean } {
  const uAllowed = useMask(d, filters);
  const yAllowed = yearMask(d, filters);
  const inArea = areaTest(d, filters);
  const minScore = Math.round(filters.minScore * 254);

  const out: BFeature[] = [];
  for (let i = 0; i < d.n; i++) {
    const x = d.lon[i];
    if (x < b.w || x > b.e) continue;
    const y = d.lat[i];
    if (y < b.s || y > b.n) continue;
    if (inArea && !inArea(i)) continue;
    if (minScore > 0 && d.score[i] !== 255 && d.score[i] < minScore) continue;
    const u = d.use[i];
    if (u === 255 || uAllowed[u] !== 1) continue;
    const yr = d.year[i];
    if (yr === 255 || yAllowed[yr] !== 1) continue;

    out.push(toFeature(d, i));
    if (out.length >= cap) return { features: out, capped: true };
  }
  return { features: out, capped: false };
}

export function findByUpi(d: Dataset, upi: string): BFeature | null {
  const i = d.upis.indexOf(upi);
  return i >= 0 ? toFeature(d, i) : null;
}
