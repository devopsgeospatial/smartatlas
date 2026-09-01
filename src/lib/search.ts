/* ----------------------------------------------------------------------------
 * One search box, no mode selector.
 *
 * The user should never have to tell the product what kind of thing they just
 * pasted. Paste a coordinate pair in any format people actually copy — from
 * Google Maps, from ArcGIS, from a GPS handset, from a WhatsApp message — or a
 * UPI, or a sector name, and the box works it out and says what it understood
 * before you commit to it.
 *
 * That "say what you understood" step is the whole design: the interpretation is
 * visible and correctable, so a wrong guess costs nothing.
 * -------------------------------------------------------------------------- */

import { SECTOR_LIST, SECTOR_BBOX, DISTRICTS } from '../sectors';
import type { BBox } from '../types';

/** Rwanda sits entirely inside these bounds — used to disambiguate lat/lon order. */
const RW_LAT: [number, number] = [-2.95, -1.02];
const RW_LON: [number, number] = [28.8, 30.95];
/** Kigali city extent, for the "outside the city" warning. */
const KGL: BBox = [29.97807, -2.07829, 30.27613, -1.78046];

export type SearchResult =
  | {
      kind: 'coords';
      lat: number;
      lon: number;
      /** What we think you gave us, echoed back for confirmation. */
      label: string;
      detail: string;
      /** True when the point is outside the Kigali extent — still navigable. */
      outside: boolean;
      swapped: boolean;
    }
  | { kind: 'upi'; upi: string; label: string; detail: string }
  | { kind: 'sector'; sector: string; district: string; bbox: BBox; label: string; detail: string }
  | { kind: 'empty' }
  | { kind: 'unknown'; label: string; detail: string };

const inRange = (v: number, r: [number, number]) => v >= r[0] && v <= r[1];

function fmt(n: number) {
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/** Build a coords result, fixing lat/lon order when the pair is unambiguous. */
function coords(a: number, b: number, source: string): SearchResult {
  let lat = a;
  let lon = b;
  let swapped = false;

  const asGiven = inRange(a, RW_LAT) && inRange(b, RW_LON);
  const asFlipped = inRange(b, RW_LAT) && inRange(a, RW_LON);
  if (!asGiven && asFlipped) {
    lat = b;
    lon = a;
    swapped = true;
  }

  const outside = !(lon >= KGL[0] && lon <= KGL[2] && lat >= KGL[1] && lat <= KGL[3]);
  const bits = [source];
  if (swapped) bits.push('order corrected to lat, lon');
  if (outside) bits.push('outside Kigali');

  return {
    kind: 'coords',
    lat,
    lon,
    label: `${fmt(lat)}, ${fmt(lon)}`,
    detail: bits.join(' · '),
    outside,
    swapped,
  };
}

/* ---- degrees / minutes / seconds ---------------------------------------- */
const DMS_TOKEN =
  /(\d{1,3})\s*[°d:\s]\s*(\d{1,2})\s*['’′m:\s]\s*(\d{1,2}(?:\.\d+)?)?\s*["”″s]?\s*([NSEWnsew])?/g;

function parseDms(text: string): SearchResult | null {
  DMS_TOKEN.lastIndex = 0;
  const hits: { value: number; hemi: string | null }[] = [];
  let m: RegExpExecArray | null;
  while ((m = DMS_TOKEN.exec(text)) !== null) {
    const deg = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const sec = m[3] ? parseFloat(m[3]) : 0;
    if (min > 59 || sec >= 60) return null;
    hits.push({ value: deg + min / 60 + sec / 3600, hemi: m[4] ? m[4].toUpperCase() : null });
    if (hits.length === 2) break;
  }
  if (hits.length !== 2) return null;

  let lat: number | null = null;
  let lon: number | null = null;
  for (const h of hits) {
    const signed = h.hemi === 'S' || h.hemi === 'W' ? -h.value : h.value;
    if (h.hemi === 'N' || h.hemi === 'S') lat = signed;
    else if (h.hemi === 'E' || h.hemi === 'W') lon = signed;
  }
  // No hemisphere letters: assume the conventional lat-then-lon order.
  if (lat === null && lon === null) {
    lat = hits[0].value;
    lon = hits[1].value;
  } else if (lat === null || lon === null) {
    return null;
  }
  return coords(lat, lon, 'degrees, minutes, seconds');
}

/* ---- map links ----------------------------------------------------------- */
function parseMapUrl(text: string): SearchResult | null {
  if (!/https?:\/\//i.test(text) && !text.includes('@')) return null;
  // Google Maps: /@lat,lon,17z  ·  ?q=lat,lon  ·  !3dLAT!4dLON
  const at = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) return coords(parseFloat(at[1]), parseFloat(at[2]), 'map link');
  const d34 = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (d34) return coords(parseFloat(d34[1]), parseFloat(d34[2]), 'map link');
  const q = text.match(/[?&](?:q|ll|center|marker)=(-?\d+(?:\.\d+)?)[,%2C]+(-?\d+(?:\.\d+)?)/i);
  if (q) return coords(parseFloat(q[1]), parseFloat(q[2]), 'map link');
  return null;
}

/* ---- signed or hemisphere-suffixed decimal pairs -------------------------- */
const DEC_PAIR =
  /^\s*([+-]?\d{1,3}(?:\.\d+)?)\s*([NSEWnsew])?\s*[,;/\s]\s*([+-]?\d{1,3}(?:\.\d+)?)\s*([NSEWnsew])?\s*$/;

function parseDecimal(text: string): SearchResult | null {
  const m = text.match(DEC_PAIR);
  if (!m) return null;
  let a = parseFloat(m[1]);
  let b = parseFloat(m[3]);
  if (!isFinite(a) || !isFinite(b)) return null;
  const ha = m[2] ? m[2].toUpperCase() : null;
  const hb = m[4] ? m[4].toUpperCase() : null;
  if (ha === 'S' || ha === 'W') a = -Math.abs(a);
  if (hb === 'S' || hb === 'W') b = -Math.abs(b);

  // Explicit hemispheres settle the order regardless of how it was typed.
  if (ha && hb) {
    const aIsLat = ha === 'N' || ha === 'S';
    return aIsLat ? coords(a, b, 'decimal degrees') : coords(b, a, 'decimal degrees');
  }
  if (Math.abs(a) > 90 && Math.abs(b) > 90) return null;
  return coords(a, b, 'decimal degrees');
}

/* ---- UPI ----------------------------------------------------------------- */
const UPI_RE = /^\d{1,2}(?:\s*\/\s*\d{1,4}){2,4}$/;

function parseUpi(text: string): SearchResult | null {
  const cleaned = text.replace(/\s+/g, '');
  if (!UPI_RE.test(cleaned)) return null;
  return {
    kind: 'upi',
    upi: cleaned,
    label: cleaned,
    detail: 'parcel identifier',
  };
}

/* ---- sector -------------------------------------------------------------- */
function parseSector(text: string): SearchResult | null {
  const q = text.trim().toLowerCase();
  if (q.length < 2) return null;
  const exact = SECTOR_LIST.find((s) => s.s.toLowerCase() === q);
  const starts = SECTOR_LIST.find((s) => s.s.toLowerCase().startsWith(q));
  const has = SECTOR_LIST.find((s) => s.s.toLowerCase().includes(q));
  const hit = exact || starts || has;
  if (!hit) return null;
  return {
    kind: 'sector',
    sector: hit.s,
    district: DISTRICTS[hit.s],
    bbox: SECTOR_BBOX[hit.s],
    label: hit.s,
    detail: `sector · ${DISTRICTS[hit.s]} district`,
  };
}

/**
 * Interpret whatever is in the box. Coordinate forms are tried first because
 * they are the only unambiguous input — a bare number is never a sector name.
 */
export function interpret(raw: string): SearchResult {
  const text = raw.trim();
  if (!text) return { kind: 'empty' };

  const url = parseMapUrl(text);
  if (url) return url;

  const dms = parseDms(text);
  if (dms) return dms;

  const dec = parseDecimal(text);
  if (dec) return dec;

  const upi = parseUpi(text);
  if (upi) return upi;

  const sector = parseSector(text);
  if (sector) return sector;

  return {
    kind: 'unknown',
    label: text,
    detail: 'not a coordinate, UPI or sector name',
  };
}

/** Sector suggestions for the dropdown, ranked so a prefix match leads. */
export function suggestSectors(raw: string, limit = 6) {
  const q = raw.trim().toLowerCase();
  if (q.length < 1) return [];
  const scored = SECTOR_LIST.map((s) => {
    const name = s.s.toLowerCase();
    let rank = -1;
    if (name === q) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    else if (name.includes(q)) rank = 2;
    else if (s.d.toLowerCase().startsWith(q)) rank = 3;
    return { s, rank };
  })
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.s.s.localeCompare(b.s.s));
  return scored.slice(0, limit).map((x) => x.s);
}

/** The canonical copy format: lat, lon — what every search box expects on paste. */
export function formatCoords(lat: number, lon: number): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}
