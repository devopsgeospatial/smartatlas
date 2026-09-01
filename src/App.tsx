import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Dossier from './components/Dossier';
import ExportMenu from './components/ExportMenu';
import FilterRail from './components/FilterRail';
import LensPanel from './components/LensPanel';
import MapView, { type FlyTarget } from './components/MapView';
import SearchBox from './components/SearchBox';
import { readUrl, writeUrl } from './lib/urlState';
import {
  findByUpi,
  loadDataset,
  summarise,
  type Dataset,
  type Selection,
} from './services/dataset';
import type { BFeature, CameraState, Filters, LensId, Sector } from './types';

const LENSES: { id: LensId; label: string }[] = [
  { id: 'atlas', label: 'Atlas' },
  { id: 'revenue', label: 'Revenue' },
  { id: 'compliance', label: 'Compliance' },
];

const initial = readUrl();

export default function App() {
  const [lens, setLens] = useState<LensId>(initial.lens);
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [selected, setSelected] = useState<BFeature | null>(null);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewFeatures, setViewFeatures] = useState<BFeature[]>([]);
  const [flyTo, setFlyTo] = useState<FlyTarget | null>(
    initial.camera
      ? { lat: initial.camera.lat, lon: initial.camera.lon, zoom: initial.camera.zoom, nonce: 0 }
      : null,
  );
  const [toast, setToast] = useState<{ text: string; mono?: string } | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  const cameraRef = useRef<CameraState | null>(initial.camera);
  const flyNonce = useRef(1);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    loadDataset()
      .then(setDataset)
      .catch((e) => setError(e?.message || 'Could not load the dataset.'));
  }, []);

  /** Counts come straight off the typed arrays, so a tick updates instantly. */
  const selection: Selection | null = useMemo(
    () => (dataset ? summarise(dataset, filters) : null),
    [dataset, filters],
  );

  useEffect(() => {
    writeUrl({
      lens,
      filters,
      camera: cameraRef.current,
      selected: selected ? selected.properties.OBJECTID : null,
    });
  }, [lens, filters, selected]);

  const showToast = useCallback((text: string, mono?: string) => {
    window.clearTimeout(toastTimer.current);
    setToast({ text, mono });
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const goToCoords = useCallback(
    (lat: number, lon: number, label: string) => {
      setFlyTo({ lat, lon, zoom: 17.5, nonce: flyNonce.current++ });
      showToast('Moved to', label);
    },
    [showToast],
  );

  const zoomToSector = useCallback((s: Sector | null) => {
    if (!s) return;
    setFlyTo({ lat: 0, lon: 0, bbox: s.bb, nonce: flyNonce.current++ });
  }, []);

  const goToSector = useCallback(
    (s: Sector) => {
      setFilters((f) => ({ ...f, sector: s.s }));
      zoomToSector(s);
    },
    [zoomToSector],
  );

  const goToUpi = useCallback(
    (upi: string) => {
      if (!dataset) return;
      const f = findByUpi(dataset, upi);
      if (!f) {
        showToast('No structure with that UPI', upi);
        return;
      }
      setSelected(f);
      setFlyTo({
        lat: f.properties.lat ?? 0,
        lon: f.properties.lon ?? 0,
        zoom: 18,
        nonce: flyNonce.current++,
      });
    },
    [dataset, showToast],
  );

  const onCamera = useCallback((c: CameraState) => {
    cameraRef.current = c;
  }, []);

  const onCopied = useCallback(
    (text: string, ok: boolean) => {
      showToast(ok ? 'Copied' : 'Clipboard blocked — copy manually', text);
    },
    [showToast],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" aria-hidden="true" />
          <b>Smart Parcel Atlas</b>
        </div>

        <SearchBox onCoords={goToCoords} onUpi={goToUpi} onSector={goToSector} />

        <nav className="lensbar" aria-label="Lens">
          {LENSES.map((l) => (
            <button key={l.id} aria-pressed={lens === l.id} onClick={() => setLens(l.id)}>
              {l.label}
            </button>
          ))}
        </nav>

        <ExportMenu
          lens={lens}
          filters={filters}
          stats={dataset ? dataset.stats : null}
          selection={selection}
          features={viewFeatures}
          onDone={showToast}
        />

        <button
          className="themebtn"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>

      <div className="workspace">
        <FilterRail
          filters={filters}
          selection={selection}
          onChange={setFilters}
          onZoomToSector={zoomToSector}
        />

        <MapView
          dataset={dataset}
          filters={filters}
          selectedId={selected ? selected.properties.OBJECTID : null}
          flyTo={flyTo}
          initialCamera={initial.camera}
          onSelect={setSelected}
          onCamera={onCamera}
          onCopied={onCopied}
          onFeatures={setViewFeatures}
        />

        <aside className="sidepanel" aria-label="Information">
          {error ? (
            <div className="empty">
              <div className="t">Dataset not loaded</div>
              <div className="d">{error}</div>
            </div>
          ) : selected ? (
            <Dossier
              feature={selected}
              stats={dataset ? dataset.stats : null}
              onClose={() => setSelected(null)}
              onCopied={onCopied}
            />
          ) : (
            <LensPanel lens={lens} stats={dataset ? dataset.stats : null} selection={selection} />
          )}
        </aside>
      </div>

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.mono && <span className="mono num">{toast.mono}</span>}
        </div>
      )}
    </div>
  );
}
