"""
Turn the NISR cell and village boundaries into what the map and the filters need.

WHY A UNIT TABLE RATHER THAN NAMES
    Village names are not unique in Kigali: 1,163 villages share 746 names, and
    165 of those names are used more than once. "Kabeza" alone is several
    different places. Nothing may therefore key on a name. The full path
    (district, sector, cell, village) IS unique — verified, 1,163 paths, none
    ambiguous — so every village becomes one row in a table and everything else
    refers to it by index.

    prepare_data.py packs that index against each building, one Uint16, which is
    enough for the whole hierarchy: a building's district, sector and cell all
    follow from its village row.

OUTPUTS (public/data/)
    admin.json       the unit table, plus the bounding box of every district,
                     sector, cell and village, so the filter rail can populate
                     itself and zoom to a selection before any boundary geometry
                     has loaded.
    cells.geojson    161 cell boundaries, slimmed and rounded.
    villages.geojson 1,163 village boundaries, slimmed and rounded.

admin.json carries a label point per village. MapLibre places polygon labels
itself and does it well, so the boundary layers do not repeat it — the point is
there for anything that needs to put a marker on a unit without loading the
geometry.

Run:  python tools/prepare_admin.py
"""

from __future__ import annotations

import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prepare_data import iter_features  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CELLS_IN = os.path.join(ROOT, "Kigali_cells.geojson")
VILLAGES_IN = os.path.join(ROOT, "Kigali_village.geojson")
OUT = os.path.join(ROOT, "public", "data")

# 5 decimal places is about 1.1 m at this latitude, finer than any administrative
# boundary is actually surveyed to, and it roughly halves the file.
PRECISION = 5


def rings(geom):
    """Every ring in a Polygon or MultiPolygon, outer rings first."""
    t, c = geom.get("type"), geom.get("coordinates")
    if t == "Polygon":
        return [c[0]]
    if t == "MultiPolygon":
        return [poly[0] for poly in c]
    return []


def ring_area(ring):
    """Twice the signed area — only its magnitude and sign are used."""
    a = 0.0
    for i in range(len(ring) - 1):
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return a


def label_point(geom):
    """
    A point inside the unit to hang its name on.

    The area-weighted centroid of the largest ring. For the handful of
    multi-part units this picks the biggest part, which is where a reader
    expects the name.
    """
    best, best_a = None, -1.0
    for r in rings(geom):
        a = abs(ring_area(r))
        if a > best_a:
            best, best_a = r, a
    if not best or len(best) < 3:
        return None
    a = cx = cy = 0.0
    for i in range(len(best) - 1):
        x0, y0 = best[i][0], best[i][1]
        x1, y1 = best[i + 1][0], best[i + 1][1]
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(a) < 1e-14:
        xs = [p[0] for p in best]
        ys = [p[1] for p in best]
        return [round(sum(xs) / len(xs), PRECISION), round(sum(ys) / len(ys), PRECISION)]
    a *= 0.5
    return [round(cx / (6 * a), PRECISION), round(cy / (6 * a), PRECISION)]


def bbox_of(geom, into=None):
    """[w, s, e, n], optionally extending an existing box."""
    b = into or [180.0, 90.0, -180.0, -90.0]
    for r in rings(geom):
        for x, y in ((p[0], p[1]) for p in r):
            if x < b[0]:
                b[0] = x
            if y < b[1]:
                b[1] = y
            if x > b[2]:
                b[2] = x
            if y > b[3]:
                b[3] = y
    return b


def round_coords(node):
    if isinstance(node, list):
        return [round_coords(v) for v in node]
    return round(node, PRECISION) if isinstance(node, float) else node


def clean(s):
    return (s or "").strip()


def write_json(name, obj, compact=True):
    path = os.path.join(OUT, name)
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":") if compact else None)
    print(f"  {name}: {os.path.getsize(path) / 1e6:.2f} MB")


def main() -> int:
    os.makedirs(OUT, exist_ok=True)

    # ---- villages: the unit table, and the finest boundary layer ------------
    print("reading villages ...")
    units = []          # one row per village, the index everything else uses
    village_feats = []
    for feat in iter_features(VILLAGES_IN):
        p = feat["properties"]
        g = feat["geometry"]
        d, s, c, v = clean(p["District"]), clean(p["Sector"]), clean(p["Cell"]), clean(p["Village"])
        bb = [round(x, PRECISION) for x in bbox_of(g)]
        lp = label_point(g)
        units.append({"d": d, "s": s, "c": c, "v": v, "id": p.get("Village ID"), "bb": bb, "lp": lp})
        village_feats.append({
            "type": "Feature",
            "properties": {"d": d, "s": s, "c": c, "v": v},
            "geometry": {"type": g["type"], "coordinates": round_coords(g["coordinates"])},
        })

    # The path must be unique or the whole scheme collapses; check, do not assume.
    paths = {(u["d"], u["s"], u["c"], u["v"]) for u in units}
    if len(paths) != len(units):
        raise SystemExit(f"village paths are not unique: {len(units)} units, {len(paths)} paths")
    print(f"  {len(units):,} villages, all paths unique")

    # ---- cells: their own boundary layer, drawn above villages -------------
    print("reading cells ...")
    cell_feats = []
    for feat in iter_features(CELLS_IN):
        p = feat["properties"]
        g = feat["geometry"]
        d, s, c = clean(p["District"]), clean(p["Sector"]), clean(p["Cell"])
        cell_feats.append({
            "type": "Feature",
            "properties": {"d": d, "s": s, "c": c},
            "geometry": {"type": g["type"], "coordinates": round_coords(g["coordinates"])},
        })
    print(f"  {len(cell_feats):,} cells")

    # ---- roll the village boxes up the hierarchy ---------------------------
    # A sector's extent is the union of its villages', which is what a zoom-to
    # needs. Deriving it here means the rail can fly to any level with nothing
    # loaded but this one small file.
    def grow(store, key, bb):
        cur = store.get(key)
        if cur is None:
            store[key] = list(bb)
        else:
            cur[0] = min(cur[0], bb[0]); cur[1] = min(cur[1], bb[1])
            cur[2] = max(cur[2], bb[2]); cur[3] = max(cur[3], bb[3])

    districts, sectors, cells = {}, {}, {}
    for u in units:
        grow(districts, u["d"], u["bb"])
        grow(sectors, (u["d"], u["s"]), u["bb"])
        grow(cells, (u["d"], u["s"], u["c"]), u["bb"])

    admin = {
        "units": units,
        "districts": [{"d": d, "bb": bb} for d, bb in sorted(districts.items())],
        "sectors": [{"d": d, "s": s, "bb": bb} for (d, s), bb in sorted(sectors.items())],
        "cells": [{"d": d, "s": s, "c": c, "bb": bb} for (d, s, c), bb in sorted(cells.items())],
    }
    print(f"  {len(admin['districts'])} districts, {len(admin['sectors'])} sectors, "
          f"{len(admin['cells'])} cells, {len(units):,} villages")

    print("writing ...")
    write_json("admin.json", admin)
    write_json("cells.geojson", {"type": "FeatureCollection", "features": cell_feats})
    write_json("villages.geojson", {"type": "FeatureCollection", "features": village_feats})
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
