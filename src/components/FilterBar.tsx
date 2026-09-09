import { useMemo } from 'react';
import { COLORS, LABELS, ORDER } from '../constants';
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

/** The label and the placeholder each level shows before its parent is chosen. */
const AREA_UI: Record<AreaKey, { label: string; all: string; waiting: string }> = {
  district: { label: 'District', all: 'All Kigali', waiting: 'All Kigali' },
  sector: { label: 'Sector', all: 'All sectors', waiting: 'Pick a district' },
  cell: { label: 'Cell', all: 'All cells', waiting: 'Pick a sector' },
  village: { label: 'Village', all: 'All villages', waiting: 'Pick a cell' },
};

/**
 * The filters that read as a row: where you are, what you are looking at, and
 * how sure the model has to be.
 *
 * These sit across the top rather than down the side because the area cascade
 * is read left to right — district, then sector, then cell, then village — and
 * a column made that sequence look like four unrelated controls. Detection year
 * stays in the rail: it is two options that rarely change, and it would be the
 * only thing here that is not part of narrowing down a place.
 */
export default function FilterBar({ filters, selection, admin, onChange, onZoomToArea }: Props) {
  const active = activeFilterCount(filters);
  const allUses = filters.uses.length === ORDER.length;

  /* Each level lists only what sits inside the level above, which is what makes
   * a name safe to compare on: "Kabeza" is several villages city-wide but one
   * village inside a given cell. */
  const options = useMemo(() => {
    const t = admin?.table;
    if (!t) return { district: [], sector: [], cell: [], village: [] } as Record<AreaKey, string[]>;
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
                (u) => u.d === filters.district && u.s === filters.sector && u.c === filters.cell,
              )
              .map((u) => u.v)
              .sort((x, y) => x.localeCompare(y)),
    } as Record<AreaKey, string[]>;
  }, [admin, filters.district, filters.sector, filters.cell]);

  /** The extent of the deepest level chosen. */
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
    <div className="filterbar" role="group" aria-label="Filters">
      <div className="fgroup fgroup-area">
        {AREA_LEVELS.map((key, i) => {
          const parentChosen = i === 0 || filters[AREA_LEVELS[i - 1]] !== 'ALL';
          const list = options[key];
          const ui = AREA_UI[key];
          return (
            <label className="fbfield" key={key}>
              <span className="micro fbfield-label">{ui.label}</span>
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

      <div className="fgroup fgroup-use">
        <div className="fbfield">
          <span className="micro fbfield-label">
            Building use
            <button
              className="linkbtn"
              onClick={() => onChange({ ...filters, uses: allUses ? [] : [...ORDER] })}
            >
              {allUses ? 'None' : 'All'}
            </button>
          </span>
          <div className="usepills">
            {ORDER.map((code) => {
              const on = filters.uses.includes(code);
              return (
                <button
                  key={code}
                  className="usepill"
                  role="checkbox"
                  aria-checked={on}
                  title={LABELS[code]}
                  onClick={() => onChange({ ...filters, uses: toggle(filters.uses, code) })}
                >
                  <span className="swatch" style={{ background: COLORS[code] }} />
                  <span className="usepill-name">{LABELS[code]}</span>
                  <span className="usepill-count num">{n(selection?.byUse[code])}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="fgroup fgroup-score">
        <label className="fbfield">
          <span className="micro fbfield-label">
            Min confidence
            <span className="fbfield-value">
              {filters.minScore === 0 ? 'off' : filters.minScore.toFixed(2)}
            </span>
          </span>
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
        </label>
      </div>

      <button
        className="linkbtn filterbar-clear"
        disabled={active === 0}
        onClick={() => {
          onChange({ ...DEFAULT_FILTERS });
          onZoomToArea(null);
        }}
      >
        {active === 0 ? 'No filters' : `Clear (${active})`}
      </button>
    </div>
  );
}
