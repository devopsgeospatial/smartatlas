/* ----------------------------------------------------------------------------
 * Filters are the product's main control surface, so they run server-side.
 *
 * Filtering only in the browser would be simpler to write and wrong to use: the
 * counts beside each class would describe whatever happened to be downloaded,
 * not the city. Every filter here becomes a WHERE clause, so a count is always
 * a count of the thing it claims to count.
 * -------------------------------------------------------------------------- */

import { ORDER, YEAR_ORDER } from '../constants';
import type { Filters } from '../types';

export const DEFAULT_FILTERS: Filters = {
  uses: [...ORDER],
  years: [...YEAR_ORDER],
  sector: 'ALL',
  minScore: 0,
};

/** Single-quote escaping for SQL string literals. */
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Build the WHERE clause. `omit` leaves one dimension out, which is how each
 * facet counts its own options against everything *else* the user has chosen —
 * otherwise unticking a class would zero its own count and it could never be
 * ticked back on from the number beside it.
 */
export function buildWhere(f: Filters, omit?: 'uses' | 'years'): string {
  const parts: string[] = [];

  if (omit !== 'uses') {
    if (f.uses.length === 0) return '1=0';
    if (f.uses.length < ORDER.length) {
      parts.push(`lu_cod_pred IN (${f.uses.map(q).join(',')})`);
    }
  }
  if (omit !== 'years') {
    if (f.years.length === 0) return '1=0';
    if (f.years.length < YEAR_ORDER.length) {
      parts.push(`acquisition_date IN (${f.years.map(q).join(',')})`);
    }
  }
  if (f.sector !== 'ALL') parts.push(`sector = ${q(f.sector)}`);
  if (f.minScore > 0) parts.push(`score >= ${f.minScore}`);

  return parts.length ? parts.join(' AND ') : '1=1';
}

export function isFiltered(f: Filters): boolean {
  return (
    f.uses.length !== ORDER.length ||
    f.years.length !== YEAR_ORDER.length ||
    f.sector !== 'ALL' ||
    f.minScore > 0
  );
}

/** How many distinct narrowings are active — drives the badge on "Clear". */
export function activeFilterCount(f: Filters): number {
  let n = 0;
  if (f.uses.length !== ORDER.length) n++;
  if (f.years.length !== YEAR_ORDER.length) n++;
  if (f.sector !== 'ALL') n++;
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
