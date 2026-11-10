/* ----------------------------------------------------------------------------
 * Export and report generation.
 *
 * Rows for a data team, a printable page for an officer. Nothing invented: every
 * column and every figure comes from the exported tables. Where a field has no
 * source yet, the report says so rather than filling the gap.
 * -------------------------------------------------------------------------- */

import { LABELS, ORDER, useLabel } from '../constants';
import { areaLevel } from './filters';
import { taxFor, type RawStats, type Selection } from '../services/dataset';
import type { BFeature, Filters, LensId } from '../types';

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

export function download(filename: string, data: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 60000);
}

const CSV_COLUMNS = [
  'upi',
  'sector',
  'longitude',
  'latitude',
  'use_code',
  'use',
  'confidence',
  'height_m',
  'floors',
  'footprint_m2',
  'year_detected',
  'zone',
];

const esc = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(features: BFeature[]): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const f of features) {
    const p = f.properties;
    const lon = p.lon ?? 0;
    const lat = p.lat ?? 0;
    rows.push(
      [
        p.UPI ?? '',
        p.sector ?? '',
        lon.toFixed(6),
        lat.toFixed(6),
        p.lu_cod_pred ?? '',
        useLabel(p.lu_cod_pred),
        typeof p.score === 'number' ? p.score.toFixed(3) : '',
        p.Height ?? '',
        p.estimated_floor ?? '',
        p.area ?? '',
        p.acquisition_date ?? '',
        p.Proposed_Use ?? '',
      ]
        .map(esc)
        .join(','),
    );
  }
  return rows.join('\n');
}

export function toGeoJson(features: BFeature[]): string {
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      features: features.map((f) => ({
        type: 'Feature',
        geometry: f.geometry,
        properties: { ...f.properties, use: useLabel(f.properties.lu_cod_pred) },
      })),
    },
    null,
    2,
  );
}

export function exportCsv(features: BFeature[]) {
  download(`structures-${stamp()}.csv`, toCsv(features), 'text/csv;charset=utf-8');
}

export function exportGeoJson(features: BFeature[]) {
  download(`structures-${stamp()}.geojson`, toGeoJson(features), 'application/geo+json');
}

/* ---- report -------------------------------------------------------------- */

export interface ReportInput {
  lens: LensId;
  filters: Filters;
  stats: RawStats | null;
  selection: Selection | null;
  features: BFeature[];
  /**
   * Drop the Print button. Set when the report is shown inside the embedded
   * fallback, where the host sandbox blocks printing too — a button that cannot
   * work is worse than no button.
   */
  noPrint?: boolean;
}

const n = (v: number | null | undefined) => (v == null ? 'n/a' : v.toLocaleString());

/* The shared labels carry an em dash ("Residential — Planned"). The report is a
 * printed document and sets them as prose, so it reads them without one. The
 * CSV keeps the dashboard's own wording, because that column is data other
 * people may already be joining on. */
const plainUse = (code: string) =>
  (LABELS[code] || code)
    .replace(/\s+—\s+/, ', ')
    .replace(/,\s+(\w)/, (_m, c) => `, ${c.toLowerCase()}`);
const ha = (sqm: number) => Math.round(sqm / 10000).toLocaleString();

function scope(f: Filters): string {
  const level = areaLevel(f);
  const bits: string[] = [
    level === 'city'
      ? 'all of Kigali'
      : [f.village, f.cell, f.sector, f.district]
          .filter((x) => x && x !== 'ALL')
          .reverse()
          .join(' · '),
  ];
  if (f.uses.length < ORDER.length) {
    bits.push(f.uses.map((u) => plainUse(u)).join(', '));
  }
  if (f.years.length === 1) bits.push(`detected ${f.years[0]}`);
  if (f.minScore > 0) bits.push(`confidence at least ${f.minScore.toFixed(2)}`);
  return bits.join(' · ');
}

export function buildReport(input: ReportInput): string {
  const { lens, filters, stats, selection } = input;
  if (!stats) return '<!DOCTYPE html><title>No data</title><p>Dataset not loaded.</p>';

  const b = stats.buildings;
  const tax = stats.tax;
  const generated = new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' });

  const useRows = ORDER.map(
    (c) => `<tr><td>${plainUse(c)}</td><td class="n">${n(selection?.byUse[c] ?? b.byUse[c])}</td></tr>`,
  ).join('');

  const zoneSource = selection && Object.keys(selection.byZone).length ? selection.byZone : b.byZone;
  const zoneRows = Object.entries(zoneSource)
    .sort((x, y) => y[1] - x[1])
    .map(
      ([z, v]) =>
        `<tr><td>${z}</td><td>${(b.zoneLabels[z] || '').replace(/^[A-Z0-9]+\s*-\s*/, '')}</td><td class="n">${n(v)}</td></tr>`,
    )
    .join('');

  /* The parcel tables follow the same area as the rest of the report. Narrowed
   * to one sector, a district split and a sector ranking would both be a single
   * row, so that section becomes the zone mix inside the sector instead. */
  const t = taxFor(tax, filters);

  const vacantSection =
    t.byDistrict && t.bySector
      ? `<h3>Undeveloped taxable parcels by district</h3>
<table><thead><tr><th>District</th><th class="n">Parcels</th></tr></thead><tbody>${Object.entries(
          t.byDistrict,
        )
          .sort((x, y) => y[1] - x[1])
          .map(([d, v]) => `<tr><td>${d}</td><td class="n">${n(v)}</td></tr>`)
          .join('')}</tbody></table>

<h3>Undeveloped taxable parcels by sector</h3>
<table><thead><tr><th>Sector</th><th>District</th><th class="n">Parcels</th><th class="n">Hectares</th></tr></thead>
<tbody>${t.bySector
          .slice(0, 15)
          .map(
            (r) =>
              `<tr><td>${r.sector}</td><td>${r.district}</td><td class="n">${n(r.vacant)}</td><td class="n">${ha(r.sqm)}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : `<h3>Undeveloped taxable parcels by zone, ${t.scope}</h3>
<table><thead><tr><th>Zone</th><th>Description</th><th class="n">Parcels</th></tr></thead>
<tbody>${Object.entries(t.byZone)
          .sort((x, y) => y[1] - x[1])
          .map(
            ([z, v]) =>
              `<tr><td>${z}</td><td>${(b.zoneLabels[z] || '').replace(/^[A-Z0-9]+\s*-\s*/, '')}</td><td class="n">${n(v)}</td></tr>`,
          )
          .join('')}</tbody></table>`;

  /* The registry reconciliation. Every figure below is a count held in the
   * dataset, not an estimate: where the join produced nothing, the row says so
   * rather than carrying a guess. The absent count is reported over structures
   * first seen in 2025 only, because the RRA extract starts in 2019 and absence
   * says nothing about stock that was already standing. */
  const rev = b.revenue;
  const r2025 = selection?.byRev2025;
  const absentNew = selection?.newUnregistered ?? rev?.newUnregistered ?? null;
  const conflictsVer = selection?.mismatchVerified ?? rev?.useMismatchVerified ?? null;
  const conflictsAll = selection?.byRev?.[2] ?? rev?.useMismatch ?? null;
  const exempt = selection?.exemptCount ?? rev?.exempted ?? null;
  const onRoll2025 = r2025 ? (r2025[1] || 0) + (r2025[2] || 0) : null;
  const noUpi2025 = r2025 ? r2025[0] || 0 : null;
  const joined = absentNew != null || conflictsAll != null;

  const topRows = (src: Record<string, number> | undefined, label: string) => {
    const rows = Object.entries(src || {})
      .filter(([, v]) => v > 0)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 10);
    if (!rows.length) return '';
    return `<h3>${label}</h3>
<table><thead><tr><th>Sector</th><th class="n">Structures</th></tr></thead><tbody>${rows
      .map(([k, v]) => `<tr><td>${k}</td><td class="n">${n(v)}</td></tr>`)
      .join('')}</tbody></table>`;
  };

  const registrySection = joined
    ? `<div class="kpis">
  <div class="kpi"><div class="l">Built since 2023, not on the roll</div><div class="v">${n(absentNew)}</div>
    <div class="note">upper bound</div></div>
  <div class="kpi"><div class="l">Use conflicts, confirmed on the ground</div><div class="v">${n(conflictsVer)}</div>
    <div class="note">evidence</div></div>
  <div class="kpi"><div class="l">Use conflicts, all structures</div><div class="v">${n(conflictsAll)}</div>
    <div class="note">leads</div></div>
  <div class="kpi"><div class="l">Excluded as exempt</div><div class="v">${n(exempt)}</div>
    <div class="note">register pending</div></div>
</div>

${
  r2025
    ? `<h3>Registry status of structures built since 2023</h3>
<table><thead><tr><th>Status</th><th class="n">Structures</th><th>What it means</th></tr></thead><tbody>
<tr><td>Not in the tax roll</td><td class="n">${n(absentNew)}</td><td>No parcel record in the extract. Verify before any assessment.</td></tr>
<tr><td>In the tax roll</td><td class="n">${n(onRoll2025)}</td><td>Matched to a parcel on the roll.</td></tr>
<tr><td>No parcel identifier</td><td class="n">${n(noUpi2025)}</td><td>Cannot be checked either way. A data gap, not a finding.</td></tr>
</tbody></table>`
    : ''
}

${topRows(selection?.sectorAbsent, 'Not on the roll since 2023, leading sectors')}
${topRows(selection?.sectorMismatchVerified, 'Use conflicts confirmed on the ground, leading sectors')}`
    : `<p class="pending">The tax register is not joined to this extract.</p>
<p class="sub">Structures that are undeclared, or whose observed use differs from the declared use,
cannot be counted here. No figure is estimated in their place.</p>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>SPARC Kigali ${lens} report</title>
<style>
  @page { margin: 18mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.5 "IBM Plex Sans", Arial, sans-serif; color: #111a1b; background: #fff;
         max-width: 190mm; margin: 0 auto; padding: 24px; }
  h1 { font-size: 21pt; margin: 0; letter-spacing: -.02em; }
  .sub { color: #4a5c5a; font-size: 10pt; margin: 4px 0 0; }
  h2 { font-size: 12pt; margin: 26px 0 6px; padding-bottom: 5px; border-bottom: 1px solid #c9d4d1; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt; margin-top: 6px; }
  th { text-align: left; font-size: 8pt; letter-spacing: .08em; text-transform: uppercase;
       color: #5b6d6b; border-bottom: 1px solid #9fb0ad; padding: 6px 8px; }
  td { padding: 6px 8px; border-bottom: 1px solid #e2e9e7; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 12px; }
  .kpi { border: 1px solid #d5dedb; border-radius: 3px; padding: 10px 12px; }
  .kpi .l { font-size: 7.5pt; letter-spacing: .1em; text-transform: uppercase; color: #5b6d6b; }
  .kpi .v { font-size: 17pt; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 3px; }
  h3 { font-size: 10pt; margin: 18px 0 4px; color: #273836; }
  .lead { font-size: 10pt; color: #3d4f4d; margin: 6px 0 12px; max-width: 150mm; }
  .kpi .note { font-size: 7.5pt; color: #8a6d1f; margin-top: 2px; }
  ul.read { font-size: 9.5pt; margin: 8px 0 0; padding-left: 18px; }
  ul.read li { margin-bottom: 6px; }
  .pending { color: #8f6206; font-size: 11pt; font-weight: 600; }
  .prov { font-size: 8.5pt; color: #5b6d6b; margin-top: 28px; border-top: 1px solid #c9d4d1;
          padding-top: 10px; }
  @media print { .noprint { display: none; } body { padding: 0; } }
</style></head><body>

${
  input.noPrint
    ? ''
    : `<p class="noprint" style="text-align:right;margin:0 0 10px">
  <button onclick="window.print()" style="font:600 10pt 'IBM Plex Sans',Arial;padding:7px 14px;
    border:1px solid #0a7c7a;background:#0a7c7a;color:#fff;border-radius:3px;cursor:pointer">
    Print or save as PDF</button></p>`
}

<h1>SPARC Kigali</h1>
<p class="sub">${lens.charAt(0).toUpperCase() + lens.slice(1)} report, ${generated}</p>
<p class="sub">Scope: ${scope(filters)}</p>

<h2>Headline</h2>
<div class="kpis">
  <div class="kpi"><div class="l">Structures</div><div class="v">${n(selection?.matches ?? b.total)}</div></div>
  <div class="kpi"><div class="l">New since 2023</div><div class="v">${n(
    selection?.byYear['2025'] ?? b.byYear['2025'],
  )}</div></div>
  <div class="kpi"><div class="l">Undeveloped taxable parcels</div><div class="v">${n(t.vacant)}</div></div>
  <div class="kpi"><div class="l">Undeveloped land (ha)</div><div class="v">${ha(t.sqm)}</div></div>
</div>

<h2>1. Property taxation</h2>
<p class="lead">Where the building record and the tax roll disagree. Each figure is a list of
properties to look at, not an assessment. What a property is worth stays with the authority.</p>

${registrySection}

${vacantSection}

<h2>2. Compliance monitoring</h2>
<p class="lead">What was actually built, against the zone of the parcel beneath it. Structures are
counted by the zone they stand in, so a zone that should carry no buildings and does is visible
in the first table.</p>

<h3>Structures by Master Plan zone</h3>
<table><thead><tr><th>Zone</th><th>Description</th><th class="n">Structures</th></tr></thead>
<tbody>${zoneRows}</tbody></table>

<h3>Structures by observed use</h3>
<table><thead><tr><th>Use</th><th class="n">Structures</th></tr></thead><tbody>${useRows}</tbody></table>

<h2>How to read this</h2>
<ul class="read">
  <li><b>Not on the roll is an upper bound.</b> Statutorily exempt property has to be removed
      first, and the exemption flag reaches ${n(exempt)} structures in this scope so far. The
      figure can only fall.</li>
  <li><b>Confirmed conflicts are evidence, the rest are leads.</b> A conflict on a structure an
      officer has stood in front of is an observation. One the classifier inferred is a reason
      to send someone.</li>
  <li><b>Absence is only read over new build.</b> The register extract starts in 2019, so absence
      says nothing about a structure that was already standing in 2023.</li>
  <li><b>Undeveloped land needs no model.</b> It rests on parcel records rather than on a use
      prediction, which makes it the cleanest base in this report.</li>
</ul>

<p class="prov">Source: exported Kigali buildings table (${n(b.total)} structures) and parcel tax
table (${n(tax.parcels)} parcels), prepared ${stats.generatedAt.slice(0, 10)}. Building use is a model
prediction and its precision is not measured. Height comes from a built-up height product and
carries metre-scale uncertainty, so a floor count near a storey boundary can be out by one. This
report supports assessment and inspection decisions; it does not assess, fine, or issue notices.</p>

</body></html>`;
}

export function openReport(input: ReportInput): boolean {
  const html = buildReport(input);
  /* A blob URL rather than document.write into a blank window. Writing into an
   * opened window leaves the tab on about:blank, which some browsers treat as
   * the opener's document and others refuse to print; a blob is a real
   * document with its own URL. If the popup is blocked the file is saved
   * instead, so the action always produces something. */
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const w = window.open(url, '_blank', 'noopener');
  if (w) {
    window.setTimeout(() => URL.revokeObjectURL(url), 120000);
    return true;
  }
  URL.revokeObjectURL(url);
  download(`${input.lens}-report-${stamp()}.html`, html, 'text/html;charset=utf-8');
  return false;
}
