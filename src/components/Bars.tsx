/* ----------------------------------------------------------------------------
 * Ranked horizontal bars.
 *
 * The panel is 300px wide, so the label and value sit on their own line and the
 * bar runs the full width beneath them. Nothing is truncated, nothing has to be
 * measured against an axis, and the number you actually want is already written
 * out — the bar is there to show the shape, not to be read off.
 *
 * One series, so no legend: the title names it.
 * -------------------------------------------------------------------------- */

export interface BarDatum {
  key: string;
  label: string;
  /** Secondary line under the label — a zone description, a district. */
  note?: string;
  value: number;
  /** Categorical fill. Omit for a single-series magnitude chart. */
  color?: string;
}

interface Props {
  title: string;
  data: BarDatum[];
  /** Cap the rows shown; the rest are summarised on a final line. */
  limit?: number;
  /** Appended to the value, e.g. "ha". */
  unit?: string;
}

const fmt = (v: number) => v.toLocaleString();

export default function Bars({ title, data, limit, unit }: Props) {
  const sorted = [...data].sort((a, b) => b.value - a.value).filter((d) => d.value > 0);
  const shown = limit ? sorted.slice(0, limit) : sorted;
  const rest = sorted.length - shown.length;
  const restTotal = sorted.slice(shown.length).reduce((n, d) => n + d.value, 0);
  const max = shown.length ? shown[0].value : 1;

  if (!shown.length) {
    return (
      <section className="chart">
        <h4 className="micro chart-title">{title}</h4>
        <p className="chart-empty">Nothing in this selection.</p>
      </section>
    );
  }

  return (
    <section className="chart">
      <h4 className="micro chart-title">{title}</h4>
      <ul className="bars">
        {shown.map((d) => (
          <li className="barrow" key={d.key} title={`${d.label}: ${fmt(d.value)}${unit ? ' ' + unit : ''}`}>
            <div className="barhead">
              <span className="barlabel">
                {d.label}
                {d.note && <span className="barnote">{d.note}</span>}
              </span>
              <span className="barvalue num">
                {fmt(d.value)}
                {unit && <span className="barunit">{unit}</span>}
              </span>
            </div>
            <div className="bartrack">
              <i
                style={{
                  width: `${Math.max(1.5, (100 * d.value) / max)}%`,
                  background: d.color || 'var(--data-1)',
                }}
              />
            </div>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <p className="chart-rest">
          {rest} more · {fmt(restTotal)}
          {unit ? ` ${unit}` : ''}
        </p>
      )}
    </section>
  );
}
