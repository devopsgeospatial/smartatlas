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

/* ----------------------------------------------------------------------------
 * Registry reconciliation (SPAB4, one byte per structure).
 *
 * The codes are written by tools/prepare_data.py and must not be reordered:
 * the packed dataset carries the number, not the name.
 *
 * Colour choice. Green/amber/red would read as good/warning/bad, and that is a
 * judgement this data cannot support — a structure absent from the registry may
 * be exempt, or may predate the extract. So the ramp is one hue by intensity:
 * a quiet grey-green for reconciled, and progressively hotter for the two
 * states that warrant a look. "No UPI" is deliberately the faintest thing on
 * the map, because it is a data-quality gap and not a finding.
 * -------------------------------------------------------------------------- */
export const REV = { NONE: 0, MATCH: 1, MISMATCH: 2, ABSENT: 3 } as const;

export const REV_ORDER = [REV.ABSENT, REV.MISMATCH, REV.MATCH, REV.NONE];

export const REV_LABELS: Record<number, string> = {
  [REV.NONE]: 'No UPI — not checked',
  [REV.MATCH]: 'In tax roll',
  [REV.MISMATCH]: 'In roll, use conflicts',
  [REV.ABSENT]: 'Not in tax roll',
};

export const REV_COLORS: Record<number, string> = {
  [REV.NONE]: '#55645F',
  [REV.MATCH]: '#3E7D6E',
  [REV.MISMATCH]: '#E8913C',
  [REV.ABSENT]: '#D8452F',
};

/** The 2023 stock, drawn as context behind the year the registry can answer for. */
export const BASELINE_COLOR = '#4A5A63';

export const revLabel = (c?: number | null) =>
  (c != null && REV_LABELS[c]) || 'Not checked';
export const revColor = (c?: number | null) =>
  (c != null && REV_COLORS[c]) || REV_COLORS[REV.NONE];
