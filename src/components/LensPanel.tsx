import { COLORS, LABELS, ORDER, YEAR_ORDER } from '../constants';
import Bars, { type BarDatum } from './Bars';
import { SECTOR_LIST } from '../sectors';
import { taxFor, type LoadProgress, type RawStats, type Selection } from '../services/dataset';
import type { Filters, LensId } from '../types';

interface Props {
  lens: LensId;
  stats: RawStats | null;
  selection: Selection | null;
  filters: Filters;
  /** Download progress while stats is still null. */
  progress?: LoadProgress | null;
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
function Scope({ sector }: { sector: string }) {
  if (sector === 'ALL') return <p className="lens-scope">All Kigali</p>;
  const district = SECTOR_LIST.find((s) => s.s === sector)?.d;
  return (
    <p className="lens-scope">
      {sector} sector{district && <span className="lens-scope-d"> · {district}</span>}
    </p>
  );
}

/** Strip the leading code from "R1A-Low density residential densification zone". */
const zoneDesc = (label: string) => (label || '').replace(/^[A-Z0-9]+\s*-\s*/, '');

export default function LensPanel({ lens, stats, selection, filters, progress }: Props) {
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
    const t = taxFor(tax, filters.sector);
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

        <Scope sector={t.scope} />

        <div className="stat2grid">
          <Stat label="Vacant taxable parcels" value={n(t.vacant)} />
          <Stat label="Vacant land" value={n(ha(t.sqm))} unit="ha" />
        </div>

        <div className="stat2grid">
          <Pending label="Not declared" why="RRA tax register not yet joined" />
          <Pending label="Use differs from declared" why="Declared use empty on all records" />
        </div>

        {buildingFiltersOn && (
          <p className="lens-note">
            Use, year and confidence narrow the structures only. A parcel has none of them, so
            these figures follow the area.
          </p>
        )}

        {t.byDistrict && (
          <Bars
            title="Vacant parcels by district"
            data={Object.entries(t.byDistrict).map(([d, v]) => ({
              key: d,
              label: d,
              value: v,
            }))}
          />
        )}

        <Bars
          title="Vacant parcels by zone"
          data={Object.entries(t.byZone).map(([z, v]) => ({
            key: z,
            label: z,
            note: zoneDesc(b.zoneLabels[z]),
            value: v,
          }))}
          limit={8}
        />

        {t.bySector && (
          <Bars
            title="Top sectors"
            data={t.bySector.map((r) => ({
              key: r.sector,
              label: r.sector,
              note: r.district,
              value: r.vacant,
            }))}
            limit={8}
          />
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
        <Scope sector={filters.sector} />

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
      <Scope sector={filters.sector} />

      <div className="stat2grid">
        <Stat label="Structures" value={n(selection?.matches ?? b.total)} />
        <Stat label="New since 2023" value={n(newCount)} />
        <Stat label="Vacant taxable parcels" value={n(taxFor(tax, filters.sector).vacant)} />
        <Stat
          label="Field verified"
          value={n(b.groundConfirmed)}
          note={filters.sector === 'ALL' ? undefined : 'citywide — not held per sector'}
        />
      </div>

      <Bars title="Structures by use" data={useBars} />
      {/* A district chart under a sector filter would be one bar, and the other
          two would still be showing the whole city. */}
      {filters.sector === 'ALL' && districtBars.length > 0 && (
        <Bars title="Structures by district" data={districtBars} />
      )}
    </div>
  );
}
