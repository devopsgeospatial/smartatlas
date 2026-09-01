export type LensId = 'atlas' | 'revenue' | 'compliance';
export type Basemap = 'imagery' | 'hybrid' | 'streets' | 'dark';

export interface BuildingProps {
  OBJECTID: number;
  UPI?: string;
  sector?: string;
  district?: string;
  province?: string;
  score?: number | null;
  Height?: number | null;
  estimated_floor?: number | null;
  area?: number | null;
  acquisition_date?: string;
  lu_cod_pred?: string;
  Predicted_Use?: string;
  Proposed_Use?: string;
  /** Master-plan zone code, e.g. R1A. */
  zoneCode?: string;
  /** Footprint centroid, so callers never have to unwrap the geometry. */
  lon?: number;
  lat?: number;
  Registered_Use?: string;
  match_ground?: string | null;
  Parcel_Match?: string;
}

export interface BFeature {
  type: 'Feature';
  id?: number;
  geometry:
    | { type: 'Point'; coordinates: [number, number] }
    | { type: 'Polygon'; coordinates: [number, number][][] };
  properties: BuildingProps;
}

/** Everything the user can narrow by. Serialised into the URL. */
export interface Filters {
  uses: string[];
  years: string[];
  sector: string;
  /** Minimum model confidence, 0 = off. */
  minScore: number;
}

export interface Stats {
  total: number;
  byUse: Record<string, number>;
  byYear: Record<string, number>;
  /** Field-validated against the ground. */
  groundChecked: number;
  /** Structures carrying a height, and therefore a floor estimate. */
  withHeight: number;
  /** Structures joined to a cadastral parcel. */
  parcelMatched: number;
}

/** Server-side compliance counts, all computed from real columns. */
export interface ComplianceStats {
  protectedZone: number;
  steepSlope: number;
  agricultureZone: number;
  housingInIndustry: number;
  industryInHousing: number;
  noParcel: number;
}

export type BBox = [number, number, number, number];

export interface Sector {
  s: string;
  d: string;
  bb: BBox;
}

/** Where the map is looking. Serialised into the URL so a view is shareable. */
export interface CameraState {
  lon: number;
  lat: number;
  zoom: number;
}
