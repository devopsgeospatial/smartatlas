/* ----------------------------------------------------------------------------
 * The whole view lives in the URL.
 *
 * This is the cheapest simplicity win in the product: a reload keeps your place,
 * the back button undoes a filter, and a demo can be handed over as a link that
 * opens on exactly the screen you were describing. No saved views, no share
 * dialog, no state to explain.
 * -------------------------------------------------------------------------- */

import { ORDER, YEAR_ORDER } from '../constants';
import { DEFAULT_FILTERS } from './filters';
import type { CameraState, Filters, LensId } from '../types';

export interface AppUrlState {
  lens: LensId;
  filters: Filters;
  camera: CameraState | null;
  selected: number | null;
}

const LENSES: LensId[] = ['atlas', 'revenue', 'compliance'];

const num = (v: string | null, fallback: number) => {
  const n = v == null ? NaN : parseFloat(v);
  return isFinite(n) ? n : fallback;
};

function readList(raw: string | null, allowed: string[], fallback: string[]): string[] {
  if (raw == null) return fallback;
  if (raw === '') return [];
  const picked = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => allowed.includes(s));
  return picked.length ? picked : [];
}

export function readUrl(): AppUrlState {
  const p = new URLSearchParams(window.location.hash.replace(/^#/, ''));

  const lensRaw = p.get('lens') as LensId | null;
  const lens: LensId = lensRaw && LENSES.includes(lensRaw) ? lensRaw : 'atlas';

  const filters: Filters = {
    uses: readList(p.get('use'), ORDER, DEFAULT_FILTERS.uses),
    years: readList(p.get('year'), YEAR_ORDER, DEFAULT_FILTERS.years),
    sector: p.get('sector') || 'ALL',
    minScore: Math.min(1, Math.max(0, num(p.get('score'), 0))),
  };

  let camera: CameraState | null = null;
  const at = p.get('at');
  if (at) {
    const [lat, lon, z] = at.split(',').map((s) => parseFloat(s));
    if (isFinite(lat) && isFinite(lon)) {
      camera = { lat, lon, zoom: isFinite(z) ? z : 15 };
    }
  }

  const selRaw = p.get('sel');
  const sel = selRaw ? parseInt(selRaw, 10) : NaN;

  return { lens, filters, camera, selected: isFinite(sel) ? sel : null };
}

export function writeUrl(state: AppUrlState) {
  const p = new URLSearchParams();

  if (state.lens !== 'atlas') p.set('lens', state.lens);
  if (state.filters.uses.length !== ORDER.length) p.set('use', state.filters.uses.join(','));
  if (state.filters.years.length !== YEAR_ORDER.length) p.set('year', state.filters.years.join(','));
  if (state.filters.sector !== 'ALL') p.set('sector', state.filters.sector);
  if (state.filters.minScore > 0) p.set('score', String(state.filters.minScore));
  if (state.camera) {
    p.set(
      'at',
      `${state.camera.lat.toFixed(5)},${state.camera.lon.toFixed(5)},${state.camera.zoom.toFixed(1)}`,
    );
  }
  if (state.selected != null) p.set('sel', String(state.selected));

  const hash = p.toString();
  const next = `${window.location.pathname}${window.location.search}${hash ? '#' + hash : ''}`;
  window.history.replaceState(null, '', next);
}
