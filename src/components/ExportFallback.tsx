/* ----------------------------------------------------------------------------
 * Export, for when the page cannot hand the browser a file.
 *
 * Embedded in Experience Builder the iframe is sandboxed without
 * `allow-downloads` or `allow-popups`, so both the blob download and the report
 * tab are refused. Everything here works within that sandbox: the text is on
 * screen and selectable, Copy goes through the execCommand path in
 * lib/clipboard, and the report renders in a srcdoc frame that inherits the
 * sandbox rather than trying to escape it.
 * -------------------------------------------------------------------------- */

import { useEffect, useRef, useState } from 'react';
import { copyText } from '../lib/clipboard';
import { hostPageUrl } from '../lib/embed';

export type FallbackKind = 'csv' | 'geojson' | 'report';

interface Props {
  kind: FallbackKind;
  payload: string;
  /** Rows for the data exports; omitted for the report. */
  rows?: number;
  /**
   * True only when the frame's sandbox has actually refused the capability.
   * False means the parent is cross-origin and could not be read, so the panel
   * offers itself as a second route without claiming the first one failed.
   */
  certain: boolean;
  onClose: () => void;
}

const TITLES: Record<FallbackKind, string> = {
  csv: 'Structures, CSV',
  geojson: 'Structures, GeoJSON',
  report: 'Lens report',
};

function why(kind: FallbackKind, certain: boolean): string {
  if (kind === 'report') {
    return certain
      ? 'This embed does not allow a new tab or a saved file, so the report is shown here. Copy the HTML to keep it.'
      : 'The report is shown here in case the new tab did not open. Copy the HTML to keep it.';
  }
  return certain
    ? 'This embed does not allow file downloads, so the rows are here instead. Copy them and paste them into a spreadsheet.'
    : 'If the file did not arrive, this page is framed by a site that blocks downloads. Copy the rows below and paste them into a spreadsheet.';
}

/** Enough to confirm it is the right data without pasting megabytes into a textarea. */
const PREVIEW_LIMIT = 20000;

export default function ExportFallback({ kind, payload, rows, certain, onClose }: Props) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [linkCopied, setLinkCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  /* The page the reader was given, not this app's hosting address. Framed,
   * that is the embedding page; standalone it is the current view, hash and
   * all, so pasting it opens on this exact screen. */
  const appUrl = hostPageUrl();

  useEffect(() => {
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const copy = async () => {
    const ok = await copyText(payload);
    setCopied(ok ? 'ok' : 'fail');
    window.setTimeout(() => setCopied('idle'), 2600);
  };

  const copyLink = async () => {
    const ok = await copyText(appUrl);
    setLinkCopied(ok);
    window.setTimeout(() => setLinkCopied(false), 2600);
  };

  const truncated = payload.length > PREVIEW_LIMIT;
  const bytes = new Blob([payload]).size;
  const size = bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

  return (
    <div className="fallback-scrim" role="dialog" aria-modal="true" aria-label={TITLES[kind]}>
      <div className="fallback">
        <header className="fallback-head">
          <div>
            <b>{TITLES[kind]}</b>
            <span className="fallback-meta">
              {rows != null ? `${rows.toLocaleString()} rows · ` : ''}
              {size}
            </span>
          </div>
          <button ref={closeRef} className="linkbtn" onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>

        <p className="fallback-why">{why(kind, certain)}</p>

        {kind === 'report' ? (
          <iframe className="fallback-report" srcDoc={payload} title="Lens report" />
        ) : (
          <textarea
            className="fallback-text mono"
            readOnly
            spellCheck={false}
            value={truncated ? payload.slice(0, PREVIEW_LIMIT) : payload}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}

        <footer className="fallback-foot">
          {truncated && kind !== 'report' && (
            <span className="fallback-note">
              Showing the first {PREVIEW_LIMIT.toLocaleString()} characters. Copy takes all of it.
            </span>
          )}
          <a
            className="linkbtn"
            href={appUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={appUrl}
          >
            Open in a new tab
          </a>
          <button className="linkbtn" onClick={copyLink} title={appUrl}>
            {linkCopied ? 'Link copied' : 'Copy link'}
          </button>
          <button className="themebtn" onClick={copy}>
            {copied === 'ok'
              ? 'Copied'
              : copied === 'fail'
                ? 'Copy failed'
                : kind === 'report'
                  ? 'Copy HTML'
                  : 'Copy all'}
          </button>
        </footer>
      </div>
    </div>
  );
}
