/* ----------------------------------------------------------------------------
 * Land-use taxonomy and brand palette.
 *
 * Labels, order and colours are carried over unchanged from the original Kigali
 * Building Use app so the two products read as one family. "Residential —
 * Unplanned / Planned" intentionally softens the raw model labels for a
 * government audience; the raw code stays available in the data.
 * -------------------------------------------------------------------------- */

export const LABELS: Record<string, string> = {
  RI: 'Residential — Unplanned',
  ROR: 'Residential — Planned',
  RAP: 'Residential — Apartment',
  CM: 'Commercial',
  CMI: 'Mixed Use',
  PI: 'Public Institution',
  I: 'Industrial',
};

export const COLORS: Record<string, string> = {
  RI: '#7FB77E',
  ROR: '#4CAF50',
  RAP: '#1B5E20',
  CM: '#FFC107',
  CMI: '#FF7043',
  PI: '#5B9BD5',
  I: '#BA68C8',
};

/** Display order: commercial first, because that is where the revenue cases are. */
export const ORDER = ['CM', 'CMI', 'RAP', 'ROR', 'RI', 'PI', 'I'];

/** Detection years present in the layer. */
export const YEAR_ORDER = ['2025', '2023'];
export const YEAR_COLORS: Record<string, string> = { '2023': '#4F8FBF', '2025': '#F5A623' };
export const YEAR_LABEL: Record<string, string> = {
  '2025': 'Detected 2025',
  '2023': 'Detected 2023',
};

export const useLabel = (code?: string | null) => (code && LABELS[code]) || code || '—';
export const useColor = (code?: string | null) => (code && COLORS[code]) || '#8a9a98';

/**
 * Resolve a design token to a literal colour. MapLibre paint properties cannot
 * read CSS custom properties, so chrome colours used on the map are read back
 * off the document rather than duplicated.
 */
export function token(varName: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}
