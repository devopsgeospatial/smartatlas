import {
  COLORS, LABELS, ORDER, REV, REV_COLORS, REV_LABELS, REV_ORDER, YEAR_ORDER,
} from '../constants';
import Bars, { type BarDatum } from './Bars';
import { areaLevel } from '../lib/filters';
import { taxFor, type LoadProgress, type RawStats, type Selection } from '../services/dataset';
import type { Filters, LensId } from '../types';

interface Props {
  lens: LensId;
  stats: RawStats | null;
  selection: Selection | null;
  filters: Filters;
  /** Download progress while stats is still null. */
  progress?: LoadProgress | null;
  /** Revenue view: count use conflicts only where ground-confirmed. */
  verifiedOnly: boolean;
  onVerifiedOnly: (v: boolean) => void;
}

const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());
const ha = (sqm: number) => Math.round(sqm / 10000);

function Stat({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: string;
  unit?: string;
  /** Say so when the figure cannot follow the current filter. */
  note?: string;
}) {
  return (
    <div className="stat2">
      <div className="stat2-label">{label}</div>
      <div className="stat2-value num">
        {value}
        {unit && <span className="stat2-unit">{unit}</span>}
      </div>
      {note && <div className="stat2-why">{note}</div>}
    </div>
  );
}

function Pending({ label, why }: { label: string; why: string }) {
  return (
    <div className="stat2 pending">
      <div className="stat2-label">{label}</div>
      <div className="stat2-value">Pending data</div>
      <div className="stat2-why">{why}</div>
    </div>
  );
}

/**
 * Names the area every figure below belongs to. All three lenses carry it, so a
 * narrowed panel can never be mistaken for a city-wide one.
 */
function Scope({ filters }: { filters: Filters }) {
  const level = areaLevel(filters);
  if (level === 'city') return <p className="lens-scope">All Kigali</p>;
  const name = filters[level];
  const above = (['cell', 'sector', 'district'] as const)
    .filter((k) => k !== level && filters[k] !== 'ALL')
    .map((k) => filters[k]);
  return (
    <p className="lens-scope">
      {name} {level}
      {above.length > 0 && <span className="lens-scope-d"> · {above.join(' · ')}</span>}
    </p>
  );
}

/** Strip the leading code from "R1A-Low density residential densification zone". */
const zoneDesc = (label: string) => (label || '').replace(/^[A-Z0-9]+\s*-\s*/, '');

export default function LensPanel({
  lens,
  stats,
  selection,
  filters,
  progress,
  verifiedOnly,
  onVerifiedOnly,
}: Props) {
  if (!stats) {
    const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
    return (
      <div className="lens">
        <div className="empty">
          <div className="t">Loading the city</div>
          <div className="d num">
            {progress?.total
              ? `${mb(progress.loaded)} of ${mb(progress.total)} MB`
              : progress
                ? `${mb(progress.loaded)} MB`
                : 'Connecting…'}
          </div>
          <div className="d">
            Every structure is held in the browser, so the first load is the only wait.
          </div>
        </div>
      </div>
    );
  }

  const b = stats.buildings;
  const tax = stats.tax;

  const useBars: BarDatum[] = ORDER.map((c) => ({
    key: c,
    label: LABELS[c],
    value: selection?.byUse[c] ?? b.byUse[c] ?? 0,
    color: COLORS[c],
  }));

  if (lens === 'revenue') {
    const t = taxFor(tax, filters);

    /* Registry status is reported over structures new since 2023 only.
     *
     * The extract runs 2019-2026, so absence from it says nothing about a
     * building that was already standing in 2023 — it may have been registered
     * in 2013. Handing an assessor 200,000 "unregistered" parcels that turn out
     * to be on the roll would cost more credibility than the larger number
     * could ever buy, so the panel never offers it. */
    const revSrc: Record<number, number> =
      selection?.byRev2025 ??
      Object.fromEntries(
        Object.entries(b.revenue?.byYear?.['2025'] || {}).map(([k, v]) => [
          Number(k),
          v as number,
        ]),
      );
    const revBars: BarDatum[] = REV_ORDER.filter((c) => (revSrc[c] || 0) > 0).map((c) => ({
      key: String(c),
      label: REV_LABELS[c],
      value: revSrc[c] || 0,
      color: REV_COLORS[c],
    }));

    /* A conflict an officer has stood in front of is an observation; one the
     * classifier inferred is a lead. Both counts are already computed, so the
     * toggle only chooses between them. */
    const conflicts = verifiedOnly
      ? (selection?.mismatchVerified ?? b.revenue?.useMismatchVerified)
      : (selection?.byRev?.[REV.MISMATCH] ?? b.revenue?.useMismatch);
    const conflictBySector = verifiedOnly
      ? selection?.sectorMismatchVerified
      : selection?.sectorMismatch;

    const sectorBars = (src: Record<string, number> | undefined, color: string): BarDatum[] =>
      Object.entries(src || {})
        .filter(([, v]) => v > 0)
        .sort((a, c) => c[1] - a[1])
        .map(([s, v]) => ({ key: s, label: s, value: v, color }));

    /* A parcel carries no predicted use, no detection year and no model score,
     * so only the area filter can narrow this lens. Saying so is better than
     * letting the figures sit unchanged and look broken. */
    const buildingFiltersOn =
      filters.uses.length < ORDER.length ||
      filters.years.length < YEAR_ORDER.length ||
      filters.minScore > 0;

    return (
      <div className="lens">
        <h3 className="lens-title">Revenue</h3>

        <Scope filters={filters} />

        {/* Indicators first, both groups together, so the four numbers can be
          * read in one glance. The charts that explain them follow. */}
        <h4 className="lens-sub">Potential revenue leakage</h4>

        <div className="stat2grid">
          <Stat
            label="New since 2023, not in tax roll"
            value={n(selection?.newUnregistered ?? b.revenue?.newUnregistered)}
          />
          <Stat
            label={verifiedOnly ? 'Use conflicts, ground-verified' : 'Use conflicts'}
            value={n(conflicts)}
          />
        </div>

        <button
          className="toggle"
          role="switch"
          aria-checked={verifiedOnly}
          onClick={() => onVerifiedOnly(!verifiedOnly)}
        >
          <span className="box" aria-hidden="true">
            {verifiedOnly ? '✓' : ''}
          </span>
          <span className="optname">Ground-verified conflicts only</span>
        </button>

        <h4 className="lens-sub">Undeveloped land</h4>

        <div className="stat2grid">
          <Stat label="Undeveloped taxable parcels" value={n(t.vacant)} />
          <Stat label="Undeveloped land" value={n(ha(t.sqm))} unit="ha" />
        </div>

        <Bars title="Registry status — built since 2023" data={revBars} />

        <Bars
          title="Not in tax roll — top sectors"
          data={sectorBars(selection?.sectorAbsent, REV_COLORS[REV.ABSENT])}
          limit={8}
        />

        <Bars
          title={
            verifiedOnly
              ? 'Verified use conflicts — top sectors'
              : 'Use conflicts — top sectors'
          }
          data={sectorBars(conflictBySector, REV_COLORS[REV.MISMATCH])}
          limit={8}
        />

        {t.coarserThanAsked && (
          <p className="lens-note">
            Parcel data is held to sector level. These figures are for{' '}
            <b>{t.scope} sector</b>, not the {filters.village !== 'ALL' ? 'village' : 'cell'} you
            selected — the structures above it are.
          </p>
        )}

        {buildingFiltersOn && (
          <p className="lens-note">
            Use, year and confidence narrow the structures only. A parcel has none of them, so
            these figures follow the area.
          </p>
        )}
      </div>
    );
  }

  if (lens === 'compliance') {
    const source =
      selection && Object.keys(selection.byZone).length ? selection.byZone : b.byZone;
    const zoneBars: BarDatum[] = Object.entries(source).map(([z, v]) => ({
      key: z,
      label: z,
      note: zoneDesc(b.zoneLabels[z]),
      value: v,
    }));
    const zonesWithBuildings = zoneBars.filter((d) => d.value > 0).length;

    /* Count structures the same way the Atlas lens does, so the headline reads
     * the same in both. Structures whose parcel carried no master-plan zone are
     * named as their own row rather than left as a silent gap between that
     * headline and the sum of the bars. */
    const total = selection?.matches ?? b.total;
    const unzoned = total - zoneBars.reduce((s, d) => s + d.value, 0);
    if (unzoned > 0) {
      zoneBars.push({
        key: '__unzoned',
        label: 'No zone',
        note: 'no master-plan zone on the parcel',
        value: unzoned,
      });
    }

    return (
      <div className="lens">
        <h3 className="lens-title">Zones</h3>
        <Scope filters={filters} />

        <div className="stat2grid">
          <Stat label="Structures" value={n(total)} />
          <Stat label="Zones in use" value={n(zonesWithBuildings)} />
        </div>

        <Bars title="Structures by zone" data={zoneBars} limit={12} />
        <Bars title="Structures by use" data={useBars} />
      </div>
    );
  }

  /* ---- atlas ------------------------------------------------------------- */
  const newCount = selection?.byYear['2025'] ?? b.byYear['2025'] ?? 0;
  const districtBars: BarDatum[] = Object.entries(b.byDistrict || {})
    .filter(([d]) => d)
    .map(([d, v]) => ({
      key: d,
      label: d,
      value: v,
    }));

  return (
    <div className="lens">
      <h3 className="lens-title">Kigali</h3>
      <Scope filters={filters} />

      <div className="stat2grid">
        <Stat label="Structures" value={n(selection?.matches ?? b.total)} />
        <Stat label="New since 2023" value={n(newCount)} />
        <Stat label="Undeveloped taxable parcels" value={n(taxFor(tax, filters).vacant)} />
        <Stat
          label="Field verified"
          value={n(b.groundConfirmed)}
          note={areaLevel(filters) === 'city' ? undefined : 'citywide — not held by area'}
        />
      </div>

      <Bars title="Structures by use" data={useBars} />
      {/* A district chart under a sector filter would be one bar, and the other
          two would still be showing the whole city. */}
      {areaLevel(filters) === 'city' && districtBars.length > 0 && (
        <Bars title="Structures by district" data={districtBars} />
      )}
    </div>
  );
}
