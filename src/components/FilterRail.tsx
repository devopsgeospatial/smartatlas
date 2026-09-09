import { useMemo } from 'react';
import { COLORS, LABELS, ORDER, YEAR_ORDER } from '../constants';
import {
  AREA_LEVELS,
  DEFAULT_FILTERS,
  activeFilterCount,
  setArea,
  toggle,
  type AreaKey,
} from '../lib/filters';
import type { AdminIndex, Selection } from '../services/dataset';
import type { BBox, Filters } from '../types';

interface Props {
  filters: Filters;
  selection: Selection | null;
  admin: AdminIndex | null;
  onChange: (f: Filters) => void;
  /** Fly to the extent of whatever area is now selected; null returns to the city. */
  onZoomToArea: (bb: BBox | null) => void;
}

const n = (v: number | null | undefined) => (v == null ? '' : v.toLocaleString());

/**
 * Filters only. Counts, no percentages and no bars — a number a person can read
 * at a glance beats a bar they have to interpret.
 *
 * Order matters: what is new comes before what it is used for. Building use is
 * essential, but it is not the question anyone opens this product to answer.
 */
/** The label and the placeholder each level shows before its parent is chosen. */
const AREA_UI: Record<AreaKey, { label: string; all: string; waiting: string }> = {
  district: { label: 'District', all: 'All Kigali', waiting: 'All Kigali' },
  sector: { label: 'Sector', all: 'All sectors', waiting: 'Choose a district first' },
  cell: { label: 'Cell', all: 'All cells', waiting: 'Choose a sector first' },
  village: { label: 'Village', all: 'All villages', waiting: 'Choose a cell first' },
};

export default function FilterRail({
  filters,
  selection,
  admin,
  onChange,
  onZoomToArea,
}: Props) {
  const active = activeFilterCount(filters);

  /* Each level lists only what sits inside the level above, which is what makes
   * a name safe to compare on: "Kabeza" is several villages city-wide but one
   * village inside a given cell. */
  const options = useMemo(() => {
    const t = admin?.table;
    if (!t) return { district: [], sector: [], cell: [], village: [] };
    return {
      district: t.districts.map((r) => r.d),
      sector:
        filters.district === 'ALL'
          ? []
          : t.sectors.filter((r) => r.d === filters.district).map((r) => r.s),
      cell:
        filters.sector === 'ALL'
          ? []
          : t.cells
              .filter((r) => r.d === filters.district && r.s === filters.sector)
              .map((r) => r.c),
      village:
        filters.cell === 'ALL'
          ? []
          : t.units
              .filter(
                (u) =>
                  u.d === filters.district && u.s === filters.sector && u.c === filters.cell,
              )
              .map((u) => u.v)
              .sort((x, y) => x.localeCompare(y)),
    } as Record<AreaKey, string[]>;
  }, [admin, filters.district, filters.sector, filters.cell]);

  /** The extent of the deepest level now chosen. */
  function extentFor(f: Filters): BBox | null {
    const t = admin?.table;
    if (!t) return null;
    if (f.village !== 'ALL') {
      return (
        t.units.find(
          (u) => u.d === f.district && u.s === f.sector && u.c === f.cell && u.v === f.village,
        )?.bb ?? null
      );
    }
    if (f.cell !== 'ALL') {
      return (
        t.cells.find((r) => r.d === f.district && r.s === f.sector && r.c === f.cell)?.bb ?? null
      );
    }
    if (f.sector !== 'ALL') {
      return t.sectors.find((r) => r.d === f.district && r.s === f.sector)?.bb ?? null;
    }
    if (f.district !== 'ALL') return t.districts.find((r) => r.d === f.district)?.bb ?? null;
    return null;
  }

  function pickArea(key: AreaKey, value: string) {
    const next = setArea(filters, key, value);
    onChange(next);
    onZoomToArea(extentFor(next));
  }

  return (
    <aside className="rail" aria-label="Filters">
      <div className="rail-block">
        <div className="rail-head">
          <span className="micro">Area</span>
          <button
            className="linkbtn"
            disabled={active === 0}
            onClick={() => {
              onChange({ ...DEFAULT_FILTERS });
              onZoomToArea(null);
            }}
          >
            {active === 0 ? '' : `Clear (${active})`}
          </button>
        </div>
        <div className="arealevels">
          {AREA_LEVELS.map((key, i) => {
            const parentChosen = i === 0 || filters[AREA_LEVELS[i - 1]] !== 'ALL';
            const list = options[key];
            const ui = AREA_UI[key];
            return (
              <label className="arealevel" key={key}>
                <span className="micro arealevel-label">{ui.label}</span>
                <select
                  className="select"
                  value={filters[key]}
                  aria-label={ui.label}
                  disabled={!parentChosen || list.length === 0}
                  onChange={(e) => pickArea(key, e.target.value)}
                >
                  <option value="ALL">{parentChosen ? ui.all : ui.waiting}</option>
                  {list.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </div>

      <div className="rail-block">
        <div className="rail-head">
          <span className="micro">Year of detection</span>
        </div>
        <div className="optlist">
          {YEAR_ORDER.map((y) => {
            const on = filters.years.includes(y);
            return (
              <button
                key={y}
                className="optrow"
                role="checkbox"
                aria-checked={on}
                onClick={() => onChange({ ...filters, years: toggle(filters.years, y) })}
              >
                <span className="box" aria-hidden="true">
                  {on ? '✓' : ''}
                </span>
                <span className="optname">{y}</span>
                <span className="optcount num">{n(selection?.byYear[y])}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rail-block">
        <div className="rail-head">
          <span className="micro">Building use</span>
          <button
            className="linkbtn"
            onClick={() =>
              onChange({ ...filters, uses: filters.uses.length === ORDER.length ? [] : [...ORDER] })
            }
          >
            {filters.uses.length === ORDER.length ? 'None' : 'All'}
          </button>
        </div>
        <div className="optlist">
          {ORDER.map((code) => {
            const on = filters.uses.includes(code);
            return (
              <button
                key={code}
                className="optrow"
                role="checkbox"
                aria-checked={on}
                onClick={() => onChange({ ...filters, uses: toggle(filters.uses, code) })}
              >
                <span className="box" aria-hidden="true">
                  {on ? '✓' : ''}
                </span>
                <span className="swatch" style={{ background: COLORS[code] }} />
                <span className="optname">{LABELS[code]}</span>
                <span className="optcount num">{n(selection?.byUse[code])}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rail-block">
        <div className="rail-head">
          <span className="micro">Minimum confidence</span>
          <span className="micro" style={{ letterSpacing: 0 }}>
            {filters.minScore === 0 ? 'off' : filters.minScore.toFixed(2)}
          </span>
        </div>
        <input
          className="range"
          type="range"
          min={0}
          max={0.95}
          step={0.05}
          value={filters.minScore}
          aria-label="Minimum model confidence"
          onChange={(e) => onChange({ ...filters, minScore: parseFloat(e.target.value) })}
        />
      </div>

      <div className="total">
        <div className="big num">{selection ? selection.matches.toLocaleString() : '···'}</div>
        <div className="cap">structures</div>
      </div>
    </aside>
  );
}
