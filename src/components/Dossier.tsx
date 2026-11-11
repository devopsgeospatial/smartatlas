import { useEffect, useState } from 'react';
import { COLORS, LABELS, ORDER, REV, useColor, useLabel } from '../constants';
import { copyText } from '../lib/clipboard';
import { formatCoords } from '../lib/search';
import Bars, { type BarDatum } from './Bars';
import type { RawStats } from '../services/dataset';
import type { BFeature } from '../types';

interface Props {
  feature: BFeature | null;
  stats: RawStats | null;
  onClose: () => void;
  onCopied: (text: string, ok: boolean) => void;
}

const nf = (v: number | null | undefined, digits = 0, suffix = '') =>
  v == null ? '—' : `${v.toLocaleString(undefined, { maximumFractionDigits: digits })}${suffix}`;

/**
 * Floors and height are modelled, not measured, so a gap is a gap in the
 * estimate rather than a missing fact about the building. Saying so beats a
 * dash the reader has to interpret.
 */
const est = (v: number | null | undefined, digits = 0, suffix = '') =>
  v == null ? 'Not estimated' : `${v.toLocaleString(undefined, { maximumFractionDigits: digits })}${suffix}`;

const zoneDesc = (label: string) => (label || '').replace(/^[A-Z0-9]+\s*-\s*/, '');

/**
 * Building Information.
 *
 * Facts first, then the one comparison that carries meaning: what the model
 * observed against what the master plan proposes for that parcel. Both are
 * shown plainly, side by side — the reader draws the conclusion, the product
 * does not draw it for them.
 */
export default function Dossier({ feature, stats, onClose, onCopied }: Props) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [feature]);

  if (!feature) return null;

  const p = feature.properties;
  const coords = formatCoords(p.lat ?? 0, p.lon ?? 0);
  const score = typeof p.score === 'number' ? p.score : null;
  const zoneCode = p.zoneCode || '';
  const zoneLabel = (p.Proposed_Use || '').trim();

  /* The 2023 rule bites on absence only, not on the whole cohort.
   *
   * Absence is the one verdict the extract cannot support for stock that was
   * already standing: it starts in 2019, so a 2023 structure missing from it
   * may simply predate it. That case gets no verdict.
   *
   * A declared use is the opposite. It is a fact the registry holds, and the
   * parcel being in the extract is what makes it readable, not when the
   * structure appeared. Suppressing it for the 2023 cohort hid the declared
   * use on 343,163 structures that have one, 81,368 of them the very use
   * differences this view exists to show. The comparison is valid wherever
   * there is a record to compare against. */
  const absentPre2023 = p.rev === REV.ABSENT && p.acquisition_date === '2023';
  const registryValue = absentPre2023
    ? 'Not assessed (pre 2023 stock)'
    : p.declared_use || 'No registry record';
  /* A difference carries no note. The two values sit side by side, so the
   * reader makes the comparison rather than being handed a verdict on it. */
  const registryNote = absentPre2023
    ? ''
    : p.rev === REV.MATCH
      ? 'agrees with observed'
      : p.rev === REV.MISMATCH || p.rev === REV.ABSENT
        ? ''
        : 'no parcel identifier';

  /* What else stands in this zone — context for whether this building is typical. */
  const zoneMix = stats?.buildings.byZoneUse?.[zoneCode];
  const mixBars: BarDatum[] = zoneMix
    ? ORDER.filter((c) => (zoneMix[c] ?? 0) > 0).map((c) => ({
        key: c,
        label: LABELS[c],
        value: zoneMix[c],
        color: COLORS[c],
      }))
    : [];

  async function copyCoords() {
    const ok = await copyText(coords);
    setCopied(ok);
    onCopied(coords, ok);
    if (ok) window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="dossier-card">
      <header className="dhead">
        <div className="dhead-top">
          <span className="micro">Building Information</span>
          <button className="linkbtn" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="dhead-upi mono">{p.UPI || `#${p.OBJECTID}`}</div>
        {/* Read outward, the way an address is spoken: the village first, then
            what contains it. An officer navigating to this building needs the
            village; a manager reading over their shoulder needs the district. */}
        <div className="dhead-place">
          {p.village ? (
            <>
              <b>{p.village}</b>
              <span className="dhead-path">
                {[p.cell, p.sector, p.district].filter(Boolean).join(' · ')}
              </span>
            </>
          ) : (
            p.sector || 'Location not recorded'
          )}
        </div>

        <div className="dfacts">
          <div>
            <span className="k">Floors</span>
            <span className="v num">{est(p.estimated_floor)}</span>
          </div>
          <div>
            <span className="k">Height</span>
            <span className="v num">{est(p.Height, 1, ' m')}</span>
          </div>
          <div>
            <span className="k">Footprint</span>
            <span className="v num">{nf(p.area, 0, ' m²')}</span>
          </div>
          <div>
            <span className="k">Detected</span>
            <span className="v num">{p.acquisition_date || '—'}</span>
          </div>
        </div>
      </header>

      <div className="dbody">
        {/* ---- the comparison the revenue case rests on --------------------
          * What the imagery shows, beside what the parcel is registered as.
          *
          * These two used to sit in separate blocks, with the observed use
          * repeated in each, so the one comparison a revenue officer is
          * actually making had to be done in the reader's head. Observed
          * appears once now, and the thing it is being compared against sits
          * next to it.
          *
          * An empty declared use is not "no declaration" — it means the
          * parcel is absent from the extract entirely, which the value says
          * in words rather than leaving a blank to interpret. */}
        <section className="compare">
          <div className="compare-side">
            <div className="compare-label">Observed use</div>
            <div className="compare-value">
              <span
                className="usechip"
                style={{ background: useColor(p.lu_cod_pred) }}
                aria-hidden="true"
              />
              <span>{useLabel(p.lu_cod_pred)}</span>
            </div>
            {score != null && <div className="compare-note num">confidence {score.toFixed(2)}</div>}
          </div>

          <div className="compare-vs" aria-hidden="true">
            vs
          </div>

          <div className="compare-side">
            <div className="compare-label">Declared use</div>
            <div className="compare-value">
              <span>{registryValue}</span>
            </div>
            {/* No caption where there is no record to characterise: the value
              * already names the registry, and a note under it would be
              * restating the same absence twice. */}
            {registryNote && <div className="compare-note">{registryNote}</div>}
          </div>
        </section>

        {/* ---- and what the master plan asks of the parcel ------------------
          * The compliance question, which shares "observed" with the block
          * above and so is not repeated as a second side-by-side. */}
        <section className="compare compare-one">
          <div className="compare-side">
            <div className="compare-label">Proposed use</div>
            <div className="compare-value">
              <span className="zonecode mono">{zoneCode || '—'}</span>
              <span>{zoneDesc(zoneLabel) || 'No zone recorded'}</span>
            </div>
            <div className="compare-note">master plan</div>
          </div>
        </section>

        {/* ---- context: what else stands in this zone ---------------------- */}
        {mixBars.length > 0 && (
          <Bars title={`What stands in ${zoneCode || 'this zone'}`} data={mixBars} limit={5} />
        )}

        <div className="coordrow">
          <span className="val">{coords}</span>
          <button className={'copybtn' + (copied ? ' done' : '')} onClick={copyCoords}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
