import { useEffect, useRef, useState } from 'react';
import {
  buildReport,
  exportCsv,
  exportGeoJson,
  openReport,
  toCsv,
  toGeoJson,
} from '../lib/exportData';
import { isEmbedded } from '../lib/embed';
import ExportFallback, { type FallbackKind } from './ExportFallback';
import type { RawStats, Selection } from '../services/dataset';
import type { BFeature, Filters, LensId } from '../types';

interface Props {
  lens: LensId;
  filters: Filters;
  stats: RawStats | null;
  selection: Selection | null;
  features: BFeature[];
  onDone: (message: string, mono?: string) => void;
}

export default function ExportMenu({ lens, filters, stats, selection, features, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [fallback, setFallback] = useState<{
    kind: FallbackKind;
    payload: string;
    rows?: number;
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  /* Read once: whether we are framed cannot change for the life of the page. */
  const embedded = useRef(isEmbedded()).current;

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  const empty = features.length === 0;

  return (
    <div className="exportmenu" ref={ref}>
      <button
        className="themebtn"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      >
        Export
      </button>
      {open && (
        <div className="exportdrop" role="menu">
          <button
            role="menuitem"
            disabled={empty}
            onClick={() => {
              setOpen(false);
              if (embedded) {
                setFallback({ kind: 'csv', payload: toCsv(features), rows: features.length });
                return;
              }
              exportCsv(features);
              onDone('Exported CSV', `${features.length.toLocaleString()} rows`);
            }}
          >
            <b>CSV</b>
            <span>{empty ? 'Zoom in to load structures' : `${features.length.toLocaleString()} in view`}</span>
          </button>
          <button
            role="menuitem"
            disabled={empty}
            onClick={() => {
              setOpen(false);
              if (embedded) {
                setFallback({
                  kind: 'geojson',
                  payload: toGeoJson(features),
                  rows: features.length,
                });
                return;
              }
              exportGeoJson(features);
              onDone('Exported GeoJSON', `${features.length.toLocaleString()} rows`);
            }}
          >
            <b>GeoJSON</b>
            <span>With geometry, for GIS</span>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              if (embedded) {
                setFallback({
                  kind: 'report',
                  payload: buildReport({ lens, filters, stats, selection, features }),
                });
                return;
              }
              const opened = openReport({ lens, filters, stats, selection, features });
              onDone(opened ? 'Report opened in a new tab' : 'Popup blocked — report downloaded');
            }}
          >
            <b>Report</b>
            <span>Printable summary</span>
          </button>
        </div>
      )}
      {fallback && (
        <ExportFallback
          kind={fallback.kind}
          payload={fallback.payload}
          rows={fallback.rows}
          onClose={() => setFallback(null)}
        />
      )}
    </div>
  );
}
