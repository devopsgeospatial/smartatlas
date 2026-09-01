import { useEffect, useState } from 'react';
import { COLORS, LABELS, ORDER, useColor, useLabel } from '../constants';
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
        <div className="dhead-place">{p.sector || 'Sector not recorded'}</div>

        <div className="dfacts">
          <div>
            <span className="k">Floors</span>
            <span className="v num">{nf(p.estimated_floor)}</span>
          </div>
          <div>
            <span className="k">Height</span>
            <span className="v num">{nf(p.Height, 1, ' m')}</span>
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
        {/* ---- the comparison that matters --------------------------------- */}
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
