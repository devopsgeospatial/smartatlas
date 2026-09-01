/* ----------------------------------------------------------------------------
 * Runtime configuration.
 *
 * The building layer is not queried at runtime — it is compacted ahead of time
 * into public/data by tools/prepare_data.py and decoded by services/dataset.ts.
 * What remains here is what the map itself needs to be told.
 * -------------------------------------------------------------------------- */
export const CONFIG = {
  /** Below this zoom: boundaries and citywide statistics only, no individual structures. */
  pointZoom: 14,
} as const;
