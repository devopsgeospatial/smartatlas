import { COLORS, LABELS, ORDER, YEAR_ORDER } from '../constants';
import { DEFAULT_FILTERS, activeFilterCount, toggle } from '../lib/filters';
import { SECTOR_LIST } from '../sectors';
import type { Selection } from '../services/dataset';
import type { Filters, Sector } from '../types';

interface Props {
  filters: Filters;
  selection: Selection | null;
  onChange: (f: Filters) => void;
  onZoomToSector: (s: Sector | null) => void;
}

const n = (v: number | null | undefined) => (v == null ? '' : v.toLocaleString());

/**
 * Filters only. Counts, no percentages and no bars — a number a person can read
 * at a glance beats a bar they have to interpret.
 *
 * Order matters: what is new comes before what it is used for. Building use is
 * essential, but it is not the question anyone opens this product to answer.
 */
export default function FilterRail({ filters, selection, onChange, onZoomToSector }: Props) {
  const active = activeFilterCount(filters);

  function pickSector(value: string) {
    onChange({ ...filters, sector: value });
    onZoomToSector(value === 'ALL' ? null : SECTOR_LIST.find((s) => s.s === value) ?? null);
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
              onZoomToSector(null);
            }}
          >
            {active === 0 ? '' : `Clear (${active})`}
          </button>
        </div>
        <select
          className="select"
          value={filters.sector}
          aria-label="Sector"
          onChange={(e) => pickSector(e.target.value)}
        >
          <option value="ALL">All Kigali</option>
          {SECTOR_LIST.map((s) => (
            <option key={s.s} value={s.s}>
              {s.s} · {s.d}
            </option>
          ))}
        </select>
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
