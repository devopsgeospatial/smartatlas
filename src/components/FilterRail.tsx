import { YEAR_ORDER } from '../constants';
import { toggle } from '../lib/filters';
import type { Selection } from '../services/dataset';
import type { Filters } from '../types';

interface Props {
  filters: Filters;
  selection: Selection | null;
  onChange: (f: Filters) => void;
}

const n = (v: number | null | undefined) => (v == null ? '' : v.toLocaleString());

/**
 * Detection year, and the running count.
 *
 * Everything else moved to the bar across the top, where the area cascade reads
 * left to right the way it is spoken. Year stayed: it is the one filter that is
 * not about narrowing to a place, it has only two options, and it belongs
 * beside the total it changes.
 */
export default function FilterRail({ filters, selection, onChange }: Props) {
  return (
    <aside className="rail" aria-label="Detection year">
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

      <div className="total">
        <div className="big num">{selection ? selection.matches.toLocaleString() : '···'}</div>
        <div className="cap">structures</div>
      </div>
    </aside>
  );
}
