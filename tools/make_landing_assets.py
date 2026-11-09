"""
Build the two assets the landing page needs that stats.json does not carry:
the "where the city grew" still, and the UPI and zone coverage counts.

WHY COVERAGE IS A FILE AND NOT A CONSTANT
    The landing page states how many structures carry a UPI and a Master Plan
    zone. Neither count is in stats.json, and reading them live would mean
    pulling upis.txt and buildings.bin, 25 MB, onto the first screen. They are
    counted here once and written to public/data/coverage.json, 60 bytes, so
    the page still reads every figure it prints from a generated source rather
    than from a number typed into the markup.

Static export of the Atlas "where the city grew" density layer.

WHY A STILL
    The landing page has a two second budget for the first screen. Drawing the
    real surface needs buildings.bin and geometry.bin, about 28 MB, so the live
    map cannot be the hero. This renders the same layer ahead of time into one
    small PNG.

WHAT IT REPRODUCES
    The selection is growthPoints() with default filters: structures whose use
    is in the seven-class taxonomy and whose detection year is 2025. That is
    60,212 points, the same figure the Atlas tile shows.

    The colour ramp, its stop positions and its alphas are copied from the
    density-heat paint in src/components/MapView.tsx. Sector boundaries are
    drawn underneath, in the --tx-1 token, because the live map adds the
    density layer after the boundary layer and so paints over it.

    Two deliberate departures from the live layer, both because this is a
    non-interactive still rather than a map someone navigates:
      - boundaries are drawn at lower opacity, as context rather than
        navigation, so the surface stays dominant;
      - intensity is normalised to a high percentile of this one frame
        instead of MapLibre's zoom-driven ramp, which has no meaning off-map.

    The still is flattened onto --bg-1, the page background it sits on. Keeping
    the alpha channel cost 1.3 MB because the ramp's soft edges compress badly;
    flattened, the same frame is 46 KB. It is therefore tied to that one
    background, which is the trade the two second budget is worth.

Run:  python tools/make_landing_assets.py
Out:  public/growth-still.webp, public/data/coverage.json
"""
import array
import io
import json
import os
import struct

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "public", "data")
OUT = os.path.join(ROOT, "public", "growth-still.webp")
OUT_COVERAGE = os.path.join(DATA, "coverage.json")
PAGE_BG = (13, 21, 23)      # --bg-1 / --core-ink-900 #0d1517
QUALITY = 82

# src/sectors.ts CITY_BBOX
BBOX = (29.97807, -2.07829, 30.27613, -1.78046)

SS = 2                      # supersample factor, downscaled at the end
SIZE = 1024                 # final edge, px
SIGMA = 4.0 * SS            # kernel, chosen to read like the city-scale map
PCTL = 99.7                 # normalisation percentile

# density-heat 'heatmap-color', verbatim from MapView.tsx
RAMP = [
    (0.00, (0, 0, 0), 0.00),
    (0.25, (24, 84, 92), 0.34),
    (0.55, (38, 142, 140), 0.55),
    (0.78, (84, 198, 184), 0.72),
    (0.93, (158, 232, 208), 0.85),
    (1.00, (226, 252, 240), 0.93),
]
BOUNDARY = (233, 240, 239)  # --tx-1
BOUNDARY_ALPHA = 56         # of 255


def mercator_y(lat_deg):
    lat = np.radians(lat_deg)
    return np.log(np.tan(np.pi / 4.0 + lat / 2.0))


def load_growth_points():
    """lon, lat of every structure growthPoints() would emit."""
    stats = json.load(io.open(os.path.join(DATA, "stats.json"), encoding="utf-8"))
    n_use = 7                       # ORDER length; anything else is off-taxonomy
    raw = io.open(os.path.join(DATA, "buildings.bin"), "rb").read()
    assert raw[:5] == b"SPAB7", raw[:5]
    n = struct.unpack_from("<I", raw, 5)[0]

    lon = np.frombuffer(raw, dtype="<f4", count=n, offset=9)
    lat = np.frombuffer(raw, dtype="<f4", count=n, offset=9 + n * 4)
    o = 9 + n * 8
    use = np.frombuffer(raw, dtype=np.uint8, count=n, offset=o)
    year = np.frombuffer(raw, dtype=np.uint8, count=n, offset=o + n)

    # YEAR_ORDER = ['2025', '2023'], so code 0 is the 2025 cohort.
    keep = (use < n_use) & (year == 0)
    print(f"  records {n:,}  growth points {int(keep.sum()):,}")
    assert int(keep.sum()) == stats["buildings"]["byYear"]["2025"] - 1, (
        "growth selection does not match stats.json minus the one "
        "off-taxonomy record"
    )
    return lon[keep], lat[keep]


def density_rgba(lon, lat, w, h):
    west, south, east, north = BBOX
    ys, yn = mercator_y(south), mercator_y(north)

    gx = ((lon - west) / (east - west) * (w - 1)).astype(np.int32)
    gy = ((yn - mercator_y(lat)) / (yn - ys) * (h - 1)).astype(np.int32)
    ok = (gx >= 0) & (gx < w) & (gy >= 0) & (gy < h)
    gx, gy = gx[ok], gy[ok]

    grid = np.zeros((h, w), dtype=np.float32)
    np.add.at(grid, (gy, gx), 1.0)
    grid = gaussian_filter(grid, sigma=SIGMA, mode="constant")

    top = np.percentile(grid[grid > 0], PCTL)
    t = np.clip(grid / top, 0.0, 1.0)

    stops = np.array([s[0] for s in RAMP])
    cols = np.array([s[1] for s in RAMP], dtype=np.float32)
    alphas = np.array([s[2] for s in RAMP], dtype=np.float32)

    out = np.zeros((h, w, 4), dtype=np.float32)
    for c in range(3):
        out[..., c] = np.interp(t, stops, cols[:, c])
    out[..., 3] = np.interp(t, stops, alphas) * 255.0
    return out.astype(np.uint8)


def boundary_rgba(w, h):
    west, south, east, north = BBOX
    ys, yn = mercator_y(south), mercator_y(north)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def project(ring):
        pts = []
        for x, y in ring:
            px = (x - west) / (east - west) * (w - 1)
            py = (yn - mercator_y(np.array(y))) / (yn - ys) * (h - 1)
            pts.append((px, float(py)))
        return pts

    gj = json.load(io.open(os.path.join(ROOT, "public", "boundaries.geojson"),
                           encoding="utf-8"))
    rings = 0
    for feat in gj["features"]:
        g = feat["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for poly in polys:
            for ring in poly:
                d.line(project(ring), fill=BOUNDARY + (BOUNDARY_ALPHA,),
                       width=SS, joint="curve")
                rings += 1
    print(f"  sector rings drawn {rings}")
    return img


def write_coverage():
    """How many in-taxonomy structures carry a UPI, and a master-plan zone."""
    stats = json.load(io.open(os.path.join(DATA, "stats.json"), encoding="utf-8"))
    zone_names = stats["buildings"]["zoneNames"]
    raw = io.open(os.path.join(DATA, "buildings.bin"), "rb").read()
    n = struct.unpack_from("<I", raw, 5)[0]

    o = 9 + n * 8
    use = np.frombuffer(raw, dtype=np.uint8, count=n, offset=o)
    # after use, year, floors, score (u8 x4) come area, height, admin (u16 x3),
    # then sector, zone (u8).
    zone = np.frombuffer(raw, dtype=np.uint8, count=n, offset=o + n * 4 + n * 6 + n)

    in_tax = use < 7
    upis = io.open(os.path.join(DATA, "upis.txt"), encoding="utf-8").read().split("\n")
    has_upi = np.fromiter(
        (bool(upis[i].strip()) if i < len(upis) else False for i in range(n)),
        dtype=bool, count=n,
    )
    named = np.fromiter(
        (z < len(zone_names) and bool(zone_names[z]) for z in zone), dtype=bool, count=n
    )

    out = {
        "structures": int(in_tax.sum()),
        "withUpi": int((in_tax & has_upi).sum()),
        "withZone": int((in_tax & named).sum()),
    }
    io.open(OUT_COVERAGE, "w", encoding="utf-8", newline="\n").write(
        json.dumps(out, indent=2) + "\n"
    )
    print(f"  coverage {out}")
    return out


def main():
    w = h = SIZE * SS
    write_coverage()
    lon, lat = load_growth_points()

    base = boundary_rgba(w, h)
    dens = Image.fromarray(density_rgba(lon, lat, w, h), mode="RGBA")
    base.alpha_composite(dens)

    out = base.resize((SIZE, SIZE), Image.LANCZOS)

    flat = Image.new("RGBA", (SIZE, SIZE), PAGE_BG + (255,))
    flat.alpha_composite(out)
    flat.convert("RGB").save(OUT, format="WEBP", quality=QUALITY, method=4)

    kb = os.path.getsize(OUT) / 1024.0
    print(f"\nwrote {OUT}  {SIZE}x{SIZE}  {kb:.1f} KB")


if __name__ == "__main__":
    main()
