import { useEffect, useMemo, useRef, useState } from 'react';
import { interpret, suggestSectors, type SearchResult } from '../lib/search';
import type { Sector } from '../types';

interface Props {
  onCoords: (lat: number, lon: number, label: string) => void;
  onUpi: (upi: string) => void;
  onSector: (sector: Sector) => void;
}

/**
 * One box, no mode selector.
 *
 * The dropdown always shows what the input was understood to be *before* the
 * user commits, so a misread costs a glance rather than a wasted navigation.
 */
export default function SearchBox({ onCoords, onUpi, onSector }: Props) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const parsed: SearchResult = useMemo(() => interpret(value), [value]);
  const sectors = useMemo(
    () => (parsed.kind === 'coords' || parsed.kind === 'upi' ? [] : suggestSectors(value)),
    [value, parsed.kind],
  );

  /* "/" focuses search from anywhere — the only shortcut worth teaching. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => setCursor(0), [value]);

  function commit(index = cursor) {
    if (parsed.kind === 'coords') {
      onCoords(parsed.lat, parsed.lon, parsed.label);
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (parsed.kind === 'upi') {
      onUpi(parsed.upi);
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    const pick = sectors[index];
    if (pick) {
      onSector(pick);
      setValue(pick.s);
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      return;
    }
    if (!sectors.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, sectors.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    }
  }

  const showDrop = open && value.trim().length > 0;

  return (
    <div className="search" ref={wrapRef}>
      <div className="search-input-wrap">
        <span className="glyph" aria-hidden="true">
          ⌕
        </span>
        <input
          ref={inputRef}
          type="search"
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder="Paste coordinates, a UPI, or type a sector"
          aria-label="Search by coordinates, parcel identifier, or sector name"
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {!value && (
          <kbd aria-hidden="true">/</kbd>
        )}
      </div>

      {showDrop && (
        <div className="search-drop" role="listbox" aria-label="Search interpretation">
          {parsed.kind === 'coords' && (
            <button
              type="button"
              className={'search-read' + (parsed.outside ? ' warn' : '')}
              onClick={() => commit()}
              style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
            >
              <span className="tag">Coordinates</span>
              <span className="val">{parsed.label}</span>
              <span className="why">{parsed.detail}</span>
            </button>
          )}

          {parsed.kind === 'upi' && (
            <button
              type="button"
              className="search-read"
              onClick={() => commit()}
              style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
            >
              <span className="tag">Parcel</span>
              <span className="val">{parsed.label}</span>
              <span className="why">{parsed.detail}</span>
            </button>
          )}

          {sectors.map((s, i) => (
            <button
              key={s.s}
              type="button"
              className={'search-opt' + (i === cursor ? ' active' : '')}
              onMouseEnter={() => setCursor(i)}
              onClick={() => commit(i)}
              role="option"
              aria-selected={i === cursor}
            >
              <span>{s.s}</span>
              <span className="sub">{s.d} district</span>
            </button>
          ))}

          {parsed.kind === 'unknown' && sectors.length === 0 && (
            <div className="search-hint">
              Not recognised. Try a coordinate pair — <code>-1.9441, 30.0619</code> — a parcel UPI, a
              pasted map link, or the start of a sector name.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
