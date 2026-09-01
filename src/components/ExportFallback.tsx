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

export type FallbackKind = 'csv' | 'geojson' | 'report';

interface Props {
  kind: FallbackKind;
  payload: string;
  /** Rows for the data exports; omitted for the report. */
  rows?: number;
  onClose: () => void;
}

const TITLES: Record<FallbackKind, string> = {
  csv: 'Structures — CSV',
  geojson: 'Structures — GeoJSON',
  report: 'Lens report',
};

/** Enough to confirm it is the right data without pasting megabytes into a textarea. */
const PREVIEW_LIMIT = 20000;

export default function ExportFallback({ kind, payload, rows, onClose }: Props) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [linkCopied, setLinkCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  /* The current view, hash and all, so pasting it opens on this exact screen. */
  const appUrl = window.location.href;

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

        <p className="fallback-why">
          {kind === 'report'
            ? 'Saving and printing are blocked inside this embed. The report is shown below. To print or keep it, copy the link and open the app in a new tab.'
            : 'File downloads are blocked inside this embed. Copy the rows below and paste them into a spreadsheet — or copy the link, open the app in a new tab, and Export saves a file as normal.'}
        </p>

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
