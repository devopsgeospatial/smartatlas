/* ----------------------------------------------------------------------------
 * The filter model, and the small helpers the rail uses to edit it.
 *
 * Filtering happens in memory: services/dataset.ts walks the packed arrays, so a
 * count beside a class is always a count over the whole city, never over what
 * happened to be on screen. Nothing here builds a query.
 * -------------------------------------------------------------------------- */

import { ORDER, YEAR_ORDER } from '../constants';
import type { Filters } from '../types';

export const DEFAULT_FILTERS: Filters = {
  uses: [...ORDER],
  years: [...YEAR_ORDER],
  district: 'ALL',
  sector: 'ALL',
  cell: 'ALL',
  village: 'ALL',
  minScore: 0,
};

/** The four area levels, outermost first. */
export const AREA_LEVELS = ['district', 'sector', 'cell', 'village'] as const;
export type AreaKey = (typeof AREA_LEVELS)[number];

/** The deepest level actually chosen. */
export function areaLevel(f: Filters): 'city' | AreaKey {
  let out: 'city' | AreaKey = 'city';
  for (const k of AREA_LEVELS) if (f[k] !== 'ALL') out = k;
  return out;
}

/** Setting a level clears everything below it — a cell outlives no sector. */
export function setArea(f: Filters, key: AreaKey, value: string): Filters {
  const next: Filters = { ...f, [key]: value };
  let clearing = false;
  for (const k of AREA_LEVELS) {
    if (clearing) next[k] = 'ALL';
    if (k === key) clearing = true;
  }
  return next;
}

export function areaIsFiltered(f: Filters): boolean {
  return AREA_LEVELS.some((k) => f[k] !== 'ALL');
}

export function isFiltered(f: Filters): boolean {
  return (
    f.uses.length !== ORDER.length ||
    f.years.length !== YEAR_ORDER.length ||
    areaIsFiltered(f) ||
    f.minScore > 0
  );
}

/** How many distinct narrowings are active — drives the badge on "Clear". */
export function activeFilterCount(f: Filters): number {
  let n = 0;
  if (f.uses.length !== ORDER.length) n++;
  if (f.years.length !== YEAR_ORDER.length) n++;
  if (areaIsFiltered(f)) n++;
  if (f.minScore > 0) n++;
  return n;
}

export function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Ticking a family sets all of its children; unticking clears all of them. */
export function setFamily(current: string[], members: string[], on: boolean): string[] {
  const without = current.filter((c) => !members.includes(c));
  return on ? [...without, ...members] : without;
}
