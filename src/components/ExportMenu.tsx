import { useEffect, useRef, useState } from 'react';
import { exportCsv, exportGeoJson, openReport } from '../lib/exportData';
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
  const ref = useRef<HTMLDivElement>(null);

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
              exportCsv(features);
              setOpen(false);
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
              exportGeoJson(features);
              setOpen(false);
              onDone('Exported GeoJSON', `${features.length.toLocaleString()} rows`);
            }}
          >
            <b>GeoJSON</b>
            <span>With geometry, for GIS</span>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const opened = openReport({ lens, filters, stats, selection, features });
              setOpen(false);
              onDone(opened ? 'Report opened in a new tab' : 'Popup blocked — report downloaded');
            }}
          >
            <b>Report</b>
            <span>Printable summary</span>
          </button>
        </div>
      )}
    </div>
  );
}
