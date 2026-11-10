import { useEffect, useRef, useState } from 'react';
import {
  buildReport,
  exportCsv,
  exportGeoJson,
  openReport,
  toCsv,
  toGeoJson,
} from '../lib/exportData';
import { canDownload, canOpenTab, type Capability } from '../lib/embed';
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
  /** Open on arrival, for a link that exists to hand over the worklist. */
  openOnMount?: boolean;
}

export default function ExportMenu({
  lens, filters, stats, selection, features, onDone, openOnMount = false,
}: Props) {
  const [open, setOpen] = useState(openOnMount);
  const [fallback, setFallback] = useState<{
    kind: FallbackKind;
    payload: string;
    rows?: number;
    /** True only when the sandbox has actually refused the capability. */
    certain: boolean;
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  /* Read once: the frame's sandbox cannot change for the life of the page.
   * 'yes' means just do it, 'no' means the sandbox has refused the capability
   * and the manual route is the only one, 'unknown' means a cross-origin
   * parent we cannot interrogate, so try the real thing and offer the manual
   * route beside it without claiming anything was blocked. */
  const dl = useRef(canDownload()).current;
  const tab = useRef(canOpenTab()).current;

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
              /* 'no' is the only state we are entitled to call blocked, and
                 it only occurs for a same-origin sandbox. Anything else gets
                 the real download; the manual routes stay in the menu. */
              if (dl === 'no') {
                setFallback({
                  kind: 'csv', certain: true,
                  payload: toCsv(features), rows: features.length,
                });
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
              if (dl === 'no') {
                setFallback({
                  kind: 'geojson', certain: true,
                  payload: toGeoJson(features), rows: features.length,
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
              /* The report needs a tab, or failing that a saved file. Only
                 when both are refused does it fall back to the panel. */
              if (tab !== 'no') {
                const opened = openReport({ lens, filters, stats, selection, features });
                if (opened) {
                  onDone('Report opened in a new tab');
                  return;
                }
                if (dl === 'yes') {
                  onDone('Popup blocked, report saved as a file');
                  return;
                }
              }
              setFallback({
                kind: 'report',
                certain: tab === 'no' && dl === 'no',
                payload: buildReport({
                  lens, filters, stats, selection, features, noPrint: true,
                }),
              });
            }}
          >
            <b>Report</b>
            <span>Printable summary</span>
          </button>

          {/* Only when framed. A frame may or may not permit a download and we
              cannot tell from inside, so these sit here as routes the reader
              can take if nothing arrived, instead of a panel that interrupts
              an export which very likely worked. */}
          {dl !== 'yes' && (
            <>
              <hr className="exportrule" />
              <a
                className="exportalt"
                role="menuitem"
                href={window.location.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
              >
                <b>Open in a new tab</b>
                <span>If the download did not arrive</span>
              </a>
              <button
                role="menuitem"
                disabled={empty}
                onClick={() => {
                  setOpen(false);
                  setFallback({
                    kind: 'csv', certain: false,
                    payload: toCsv(features), rows: features.length,
                  });
                }}
              >
                <b>Copy rows instead</b>
                <span>Paste into a spreadsheet</span>
              </button>
            </>
          )}
        </div>
      )}
      {fallback && (
        <ExportFallback
          kind={fallback.kind}
          payload={fallback.payload}
          rows={fallback.rows}
          certain={fallback.certain}
          onClose={() => setFallback(null)}
        />
      )}
    </div>
  );
}
