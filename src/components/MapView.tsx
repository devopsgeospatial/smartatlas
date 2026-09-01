import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { CONFIG } from '../config';
import { ORDER, token, useColor } from '../constants';
import { copyText } from '../lib/clipboard';
import { formatCoords } from '../lib/search';
import { queryViewport, type Dataset } from '../services/dataset';
import { CITY_BBOX } from '../sectors';
import type { BBox, BFeature, Basemap, CameraState, Filters } from '../types';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const EMPTY = { type: 'FeatureCollection', features: [] } as const;

const BASE_VISIBILITY: Record<Basemap, string[]> = {
  imagery: ['sat'],
  hybrid: ['sat', 'ref'],
  streets: ['streets'],
  dark: ['dark'],
};

const BASEMAPS: [Basemap, string][] = [
  ['imagery', 'Imagery'],
  ['hybrid', 'Hybrid'],
  ['streets', 'Streets'],
  ['dark', 'Dark'],
];

export interface FlyTarget {
  lat: number;
  lon: number;
  zoom?: number;
  bbox?: BBox;
  nonce: number;
}

interface Props {
  dataset: Dataset | null;
  filters: Filters;
  selectedId: number | null;
  flyTo: FlyTarget | null;
  initialCamera: CameraState | null;
  onSelect: (f: BFeature | null) => void;
  onCamera: (c: CameraState) => void;
  onCopied: (text: string, ok: boolean) => void;
  onFeatures: (features: BFeature[]) => void;
}

export default function MapView(props: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const readyRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  const propsRef = useRef(props);
  propsRef.current = props;

  const [basemap, setBasemap] = useState<Basemap>('imagery');
  const [status, setStatus] = useState<string>('Zoom in to see structures');

  const colorExpr = (): any => {
    const m: any[] = ['match', ['get', 'lu_cod_pred']];
    ORDER.forEach((c) => m.push(c, useColor(c)));
    m.push(token('--tx-3', '#7e918f'));
    return m;
  };

  const repaint = () => {
    const map = mapRef.current;
    if (!map || !map.getLayer('structures')) return;
    map.setPaintProperty('structures', 'fill-color', colorExpr());
    map.setPaintProperty('structures-dot', 'circle-color', colorExpr());
    const sel = propsRef.current.selectedId;
    const f = ['==', ['get', 'OBJECTID'], sel ?? -1] as any;
    map.setFilter('selection', f);
    map.setFilter('selection-dot', f);
  };

  /** Everything is in memory, so this is a synchronous pass — no spinner needed. */
  const refresh = () => {
    const map = mapRef.current;
    const d = propsRef.current.dataset;
    if (!map || !readyRef.current) return;
    if (!d) {
      setStatus('Loading dataset…');
      return;
    }
    if (map.getZoom() < CONFIG.pointZoom) {
      (map.getSource('structures') as GeoJSONSource | undefined)?.setData(EMPTY as any);
      setStatus('Zoom in to see structures');
      propsRef.current.onFeatures([]);
      return;
    }
    const b = map.getBounds();
    const res = queryViewport(
      d,
      { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() },
      propsRef.current.filters,
    );
    (map.getSource('structures') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: res.features,
    } as any);
    repaint();
    setStatus(
      `${res.features.length.toLocaleString()} in view${res.capped ? ' · zoom in for the rest' : ''}`,
    );
    propsRef.current.onFeatures(res.features);
  };

  const schedule = () => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(refresh, 80);
  };

  useEffect(() => {
    const start = props.initialCamera;
    const map = new maplibregl.Map({
      container: holder.current!,
      attributionControl: false,
      center: start
        ? [start.lon, start.lat]
        : [(CITY_BBOX[0] + CITY_BBOX[2]) / 2, (CITY_BBOX[1] + CITY_BBOX[3]) / 2],
      zoom: start ? start.zoom : 11.2,
      maxZoom: 19,
      style: {
        version: 8,
        glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
        sources: {
          sat: {
            type: 'raster',
            tiles: [ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            maxzoom: 19,
            attribution: 'Esri World Imagery',
          },
          ref: {
            type: 'raster',
            tiles: [ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            maxzoom: 19,
          },
          streets: {
            type: 'raster',
            tiles: ['https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'],
            tileSize: 256,
          },
          dark: {
            type: 'raster',
            tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
            tileSize: 256,
          },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#070c0d' } },
          {
            id: 'sat',
            type: 'raster',
            source: 'sat',
            // The reference layer recedes so the thematic layer can lead.
            paint: { 'raster-saturation': -0.25, 'raster-brightness-max': 0.86 },
          },
          { id: 'ref', type: 'raster', source: 'ref', layout: { visibility: 'none' } },
          { id: 'streets', type: 'raster', source: 'streets', layout: { visibility: 'none' } },
          { id: 'dark', type: 'raster', source: 'dark', layout: { visibility: 'none' } },
        ],
      },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: 'SPARC · Esri World Imagery',
      }),
      /* Bottom-left belongs to the in-view count chip, which would sit on top of
       * the credit and hide it. The imagery licence requires the credit stay
       * legible, so it stacks under the zoom control instead. */
      'bottom-right',
    );

    map.on('load', () => {
      map.addSource('bounds', {
        type: 'geojson',
        data: `${import.meta.env.BASE_URL}boundaries.geojson`,
      });
      map.addLayer({
        id: 'bounds-line',
        type: 'line',
        source: 'bounds',
        paint: {
          'line-color': token('--tx-2', '#a5b6b4'),
          'line-width': 1,
          'line-opacity': 0.4,
          'line-dasharray': [3, 2],
        },
      });

      map.addSource('structures', { type: 'geojson', data: EMPTY as any });

      // Below z16 a footprint is smaller than a pixel, so a dot is the honest
      // mark; above it, the real outline is.
      map.addLayer({
        id: 'structures-dot',
        type: 'circle',
        source: 'structures',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2, 15, 3.4, 16.5, 5],
          'circle-color': colorExpr(),
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 15.5, 0.9, 16.5, 0],
          'circle-stroke-width': 0.5,
          'circle-stroke-color': 'rgba(6,14,13,.7)',
        },
      });
      map.addLayer({
        id: 'structures',
        type: 'fill',
        source: 'structures',
        paint: {
          'fill-color': colorExpr(),
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 15.5, 0, 16.5, 0.85],
        },
      });
      map.addLayer({
        id: 'structures-line',
        type: 'line',
        source: 'structures',
        paint: {
          'line-color': 'rgba(6,14,13,.8)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 16, 0.4, 19, 1.1],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 15.5, 0, 16.5, 1],
        },
      });

      map.addLayer({
        id: 'selection',
        type: 'line',
        source: 'structures',
        filter: ['==', ['get', 'OBJECTID'], -1] as any,
        paint: {
          'line-color': token('--select', '#ffffff'),
          'line-width': 2,
          'line-opacity': 0.95,
        },
      });
      map.addLayer({
        id: 'selection-dot',
        type: 'circle',
        source: 'structures',
        filter: ['==', ['get', 'OBJECTID'], -1] as any,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 6, 15, 9, 16.5, 12],
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-width': 1.8,
          'circle-stroke-color': token('--select', '#ffffff'),
          'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 15.5, 1, 16.5, 0],
        },
      });

      map.addLayer({
        id: 'bounds-label',
        type: 'symbol',
        source: 'bounds',
        layout: {
          'symbol-placement': 'point',
          'text-field': ['get', 's'],
          'text-font': ['Open Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 13, 13, 16, 17],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.08,
          'text-padding': 6,
        },
        paint: {
          'text-color': token('--tx-1', '#e9f0ef'),
          'text-halo-color': 'rgba(4,10,10,.92)',
          'text-halo-width': 1.8,
          'text-opacity': 0.9,
        },
      });

      for (const layer of ['structures', 'structures-dot']) {
        map.on('click', layer, (e) => {
          const f = e.features && (e.features[0] as unknown as BFeature);
          if (f) propsRef.current.onSelect(f);
        });
        map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
        map.on('contextmenu', layer, (e) => {
          const f = e.features && (e.features[0] as unknown as BFeature);
          if (!f) return;
          (e.originalEvent as MouseEvent).preventDefault();
          const pr = f.properties as any;
          const text = formatCoords(Number(pr.lat), Number(pr.lon));
          copyText(text).then((ok) => propsRef.current.onCopied(text, ok));
        });
      }
      map.on('click', (e) => {
        const hits = map.queryRenderedFeatures(e.point, {
          layers: ['structures', 'structures-dot'],
        });
        if (!hits.length) propsRef.current.onSelect(null);
      });

      map.on('moveend', () => {
        const c = map.getCenter();
        propsRef.current.onCamera({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
        schedule();
      });

      readyRef.current = true;
      repaint();
      schedule();
    });

    return () => {
      window.clearTimeout(timerRef.current);
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.dataset,
    props.filters.uses.join(','),
    props.filters.years.join(','),
    props.filters.sector,
    props.filters.minScore,
  ]);

  useEffect(() => {
    repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const on = BASE_VISIBILITY[basemap];
    (['sat', 'ref', 'streets', 'dark'] as const).forEach((id) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', on.includes(id) ? 'visible' : 'none');
      }
    });
  }, [basemap]);

  useEffect(() => {
    const map = mapRef.current;
    const t = props.flyTo;
    if (!map || !t) return;
    if (t.bbox) {
      map.fitBounds(
        [
          [t.bbox[0], t.bbox[1]],
          [t.bbox[2], t.bbox[3]],
        ],
        { padding: 48, duration: 600 },
      );
    } else {
      map.flyTo({ center: [t.lon, t.lat], zoom: t.zoom ?? 17, duration: 700 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.flyTo?.nonce]);

  return (
    <div className="mapwrap">
      <div className="map" ref={holder} />
      <div className="basemapbar" role="group" aria-label="Basemap">
        {BASEMAPS.map(([id, label]) => (
          <button key={id} aria-pressed={basemap === id} onClick={() => setBasemap(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="mapchip bl" aria-live="polite">
        {status}
      </div>
    </div>
  );
}
