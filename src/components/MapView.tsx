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

/* Villages are fetched a zoom level before they can be seen, so the layer is
 * already populated by the time it fades in rather than appearing a beat late. */
const VILLAGE_LOAD_ZOOM = 12.5;

export interface FlyTarget {
  lat: number;
  lon: number;
  zoom?: number;
  bbox?: BBox;
  nonce: number;
}

interface Props {
  dataset: Dataset | null;
  /** The load threw, so "loading" would be a lie. */
  loadFailed?: boolean;
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
    const colors = colorExpr();
    map.setPaintProperty('structures', 'fill-color', colors);
    map.setPaintProperty('structures-line', 'line-color', colors);
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
      setStatus(propsRef.current.loadFailed ? 'Dataset not loaded' : 'Loading dataset…');
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

  /* Villages are only fetched once the map first reaches the zoom where they
   * would show. Loading 2.3 MB for a city-wide view nobody has zoomed into yet
   * would spend the user's first impression on geometry they cannot see. */
  const villagesRequested = useRef(false);
  const maybeLoadVillages = () => {
    const map = mapRef.current;
    if (!map || villagesRequested.current || map.getZoom() < VILLAGE_LOAD_ZOOM) return;
    villagesRequested.current = true;
    fetch(new URL(`${import.meta.env.BASE_URL}data/villages.geojson`, window.location.href).href)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const src = mapRef.current?.getSource('villages') as GeoJSONSource | undefined;
        if (data && src) src.setData(data);
      })
      .catch(() => {
        // A missing boundary layer is a degraded map, not a broken one.
        villagesRequested.current = false;
      });
  };

  const onZoomChanged = () => maybeLoadVillages();

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
        /* Glyphs are served from this app, not from a public font server.
         * fonts.openmaptiles.org now answers every glyph request with its own
         * landing page — HTML, status 200 — so MapLibre silently rendered no
         * labels at all. Two Latin ranges of two faces is about 350 kB and
         * removes the dependency entirely. */
        glyphs:
          new URL(`${import.meta.env.BASE_URL}fonts/`, window.location.href).href +
          '{fontstack}/{range}.pbf',
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
            tiles: [ESRI + 'World_Street_Map/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
          },
          dark: {
            type: 'raster',
            tiles: [ESRI + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
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
      const base = import.meta.env.BASE_URL;

      /* Every GeoJSON source here is created empty and filled from a fetch on
       * this thread, rather than handed a URL for MapLibre to fetch itself.
       *
       * A url-backed geojson source is loaded inside MapLibre's worker, and in
       * this build that request never completes: the source stays unloaded, no
       * error is raised, and the layer silently renders nothing. Relative and
       * absolute URLs behave identically, so it is not URL resolution. The
       * structures layer has always worked because it is given parsed data, and
       * this simply does the same for the boundaries. */
      const fillSource = (id: string, url: string) =>
        fetch(new URL(url, window.location.href).href)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            const src = mapRef.current?.getSource(id) as GeoJSONSource | undefined;
            if (data && src) src.setData(data);
          })
          .catch(() => {
            /* A boundary that fails to load is a plainer map, not a broken one. */
          });

      /* Administrative boundaries, drawn coarse to fine.
       *
       * The cartography follows one rule: a level appears when it is the finest
       * thing you could still read, and fades once the level below has taken
       * over. Districts carry the whole city; villages only earn their ink once
       * a few of them fill the screen. Weight decreases with level so the
       * hierarchy survives having three of them on screen at once, and every
       * label is haloed because these sit over satellite imagery.
       *
       * Villages are 2.3 MB, so they load only when the map first crosses into
       * the zoom band where they would be visible. */
      map.addSource('bounds', { type: 'geojson', data: EMPTY as any });
      map.addSource('cells', { type: 'geojson', data: EMPTY as any });
      map.addSource('villages', { type: 'geojson', data: EMPTY as any });
      fillSource('bounds', `${base}boundaries.geojson`);
      fillSource('cells', `${base}data/cells.geojson`);

      /* Cells take the heavier face, villages the lighter one: weight carries
       * the hierarchy when both are on screen together. */
      const FONT_CELL = ['Open Sans Semibold'];
      const FONT_VILLAGE = ['Noto Sans Regular'];
      const halo = {
        'text-halo-width': 1.6,
        'text-halo-blur': 0.4,
      };

      // Villages: the finest, thinnest, first to go.
      map.addLayer({
        id: 'village-line',
        type: 'line',
        source: 'villages',
        minzoom: 13.5,
        paint: {
          'line-color': token('--tx-2', '#a5b6b4'),
          'line-width': ['interpolate', ['linear'], ['zoom'], 13.5, 0.6, 17, 1.2],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 0, 15, 0.7],
          'line-dasharray': [2, 2],
        },
      });
      map.addLayer({
        id: 'cell-line',
        type: 'line',
        source: 'cells',
        minzoom: 11,
        paint: {
          'line-color': token('--tx-2', '#a5b6b4'),
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 16, 1.4],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 12.5, 0.55],
        },
      });
      map.addLayer({
        id: 'bounds-line',
        type: 'line',
        source: 'bounds',
        paint: {
          'line-color': token('--tx-2', '#a5b6b4'),
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 14, 2.2],
          'line-opacity': 0.55,
          'line-dasharray': [3, 2],
        },
      });

      /* Labels sit above every boundary line and below nothing else. Ranges
       * overlap by half a zoom level so a name never blinks out before its
       * replacement has appeared. */
      map.addLayer({
        id: 'cell-label',
        type: 'symbol',
        source: 'cells',
        minzoom: 12.5,
        maxzoom: 16,
        layout: {
          'text-field': ['get', 'c'],
          'text-font': FONT_CELL,
          'text-size': ['interpolate', ['linear'], ['zoom'], 12.5, 10, 15.5, 13],
          'text-letter-spacing': 0.06,
          'text-transform': 'uppercase',
          'text-padding': 6,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': token('--tx-1', '#e9f0ef'),
          'text-halo-color': token('--bg-0', '#070c0d'),
          ...halo,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 12.5, 0, 13.2, 1, 15.4, 1, 16, 0],
        },
      });
      maybeLoadVillages();

      map.addLayer({
        id: 'village-label',
        type: 'symbol',
        source: 'villages',
        minzoom: 15,
        layout: {
          'text-field': ['get', 'v'],
          'text-font': FONT_VILLAGE,
          'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10.5, 18, 13],
          'text-padding': 5,
          'symbol-placement': 'point',
        },
        paint: {
          'text-color': token('--tx-2', '#a5b6b4'),
          'text-halo-color': token('--bg-0', '#070c0d'),
          ...halo,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.4, 1],
        },
      });

      map.addSource('structures', { type: 'geojson', data: EMPTY as any });

      /* The class colour is carried by the outline, not the fill, so the roof
       * stays visible underneath and an officer can compare what the model says
       * against what the imagery shows without toggling anything off.
       *
       * The fill does not disappear, it recedes. Two things still need it: at
       * z14 a house is three pixels across, where an outline and a fill are the
       * same picture and the city has to read as mass; and MapLibre hit-tests
       * clicks against the fill, so a hollow polygon would only be selectable
       * on its edge. It therefore drops to a wash that fades as the outline
       * takes over. */
      map.addLayer({
        id: 'structures',
        type: 'fill',
        source: 'structures',
        paint: {
          'fill-color': colorExpr(),
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.55, 16, 0.22, 18, 0.12],
        },
      });

      /* A dark casing under the coloured outline. Without it a mid-tone class
       * on a bright roof loses its edge, and the lighter classes disappear over
       * pale ground entirely. */
      map.addLayer({
        id: 'structures-casing',
        type: 'line',
        source: 'structures',
        paint: {
          'line-color': 'rgba(6,14,13,.55)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.8, 17, 2.2, 19, 3.4],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.5, 1],
        },
      });

      map.addLayer({
        id: 'structures-line',
        type: 'line',
        source: 'structures',
        paint: {
          'line-color': colorExpr(),
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.6, 17, 1.4, 19, 2.2],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 0.6, 15.5, 1],
        },
      });

      map.addLayer({
        id: 'selection',
        type: 'line',
        source: 'structures',
        filter: ['==', ['get', 'OBJECTID'], -1] as any,
        paint: {
          'line-color': token('--select', '#ffffff'),
          // Wider than the class outline it now sits beside, or the selected
          // building would be no louder than its neighbours.
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2, 17, 3, 19, 4],
          'line-opacity': 1,
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

      for (const layer of ['structures']) {
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
        const hits = map.queryRenderedFeatures(e.point, { layers: ['structures'] });
        if (!hits.length) propsRef.current.onSelect(null);
      });

      map.on('moveend', () => {
        const c = map.getCenter();
        propsRef.current.onCamera({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
        schedule();
      });
      map.on('zoomend', onZoomChanged);

      /* Order matters and MapLibre draws in insertion order. Boundary lines
       * belong under the buildings — they are context, not subject — but the
       * names belong above everything, or a dense sector buries them under its
       * own footprints. The layers are created in one block for legibility and
       * the two label layers are lifted here. */
      for (const id of ['cell-label', 'village-label']) {
        if (map.getLayer(id)) map.moveLayer(id);
      }

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
    props.loadFailed,
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
      /* Duration scales with how far the camera actually travels, so stepping
       * from a cell to one of its villages is a short move and jumping across
       * the city is not an abrupt one. easeTo/fitBounds with a fixed duration
       * made the small steps feel sluggish and the large ones feel violent. */
      const c = map.getCenter();
      const midX = (t.bbox[0] + t.bbox[2]) / 2;
      const midY = (t.bbox[1] + t.bbox[3]) / 2;
      const travel = Math.hypot(midX - c.lng, midY - c.lat);
      const duration = Math.round(Math.min(1600, 550 + travel * 9000));
      map.fitBounds(
        [
          [t.bbox[0], t.bbox[1]],
          [t.bbox[2], t.bbox[3]],
        ],
        { padding: 56, duration, essential: true, maxZoom: 17.5 },
      );
    } else {
      map.flyTo({ center: [t.lon, t.lat], zoom: t.zoom ?? 17, duration: 700, essential: true });
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
