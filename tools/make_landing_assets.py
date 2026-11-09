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

WHAT THE STILL REPRODUCES
    The selection is growthPoints() with default filters: structures whose use
    is in the seven-class taxonomy and whose detection year is 2025. That is
    60,212 points, the same figure the Atlas tile shows.

    The colour ramp, its stop positions and its alphas are copied from the
    density-heat paint in src/components/MapView.tsx. Sector boundaries are
    drawn underneath, because the live map adds the density layer after the
    boundary layer and so paints over it.

    The frame is the city bounding box grown by MARGIN on every side, so no
    part of the Kigali boundary touches the edge of the image.

TWO GROUNDS, MEASURED
    The still is rendered twice: once on the flat page background, and once on
    the dashboard's own Esri imagery basemap at reduced brightness, the way the
    Atlas looks with the imagery base under the surface. Both are scored on the
    contrast between the dense areas and the ground behind them, and the winner
    is written out. The score is a WCAG contrast ratio between the mean colour
    of the brightest decile of the surface and the mean colour of the pixels
    carrying no density at all.

    The still is flattened onto its ground, with no alpha. Keeping the alpha
    channel cost 1.3 MB because the ramp's soft edges compress badly;
    flattened, the same frame is about 46 KB.

Run:  python tools/make_landing_assets.py
Out:  public/growth-still.webp, public/data/coverage.json
      plus both candidates in build/ for the record
"""
import io
import json
import math
import os
import struct
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "public", "data")
OUT = os.path.join(ROOT, "public", "growth-still.webp")
OUT_COVERAGE = os.path.join(DATA, "coverage.json")
BUILD = os.path.join(ROOT, "build")

# src/sectors.ts CITY_BBOX, then grown so the boundary never touches the frame.
CITY_BBOX = (29.97807, -2.07829, 30.27613, -1.78046)
MARGIN = 0.06                # share of the span added on every side

SS = 2                       # supersample factor, downscaled at the end
SIZE = 1024                  # final edge, px
SIGMA = 4.0 * SS
PCTL = 99.7                  # normalisation percentile

# density-heat 'heatmap-color', verbatim from MapView.tsx
RAMP = [
    (0.00, (0, 0, 0), 0.00),
    (0.25, (24, 84, 92), 0.34),
    (0.55, (38, 142, 140), 0.55),
    (0.78, (84, 198, 184), 0.72),
    (0.93, (158, 232, 208), 0.85),
    (1.00, (226, 252, 240), 0.93),
]
DENSE_AT = 0.78              # where the ramp's bright half begins
BOUNDARY = (233, 240, 239)   # --tx-1
PAGE_BG = (13, 21, 23)       # --bg-1 / --core-ink-900 #0d1517
QUALITY = 82

ESRI = ("https://server.arcgisonline.com/ArcGIS/rest/services/"
        "World_Imagery/MapServer/tile/{z}/{y}/{x}")
TILE_Z = 13
IMAGERY_BRIGHTNESS = 0.34    # the basemap, dimmed so the surface reads over it


def frame():
    w, s, e, n = CITY_BBOX
    dx, dy = (e - w) * MARGIN, (n - s) * MARGIN
    return (w - dx, s - dy, e + dx, n + dy)


BBOX = frame()


def mercator_y(lat_deg):
    lat = np.radians(lat_deg)
    return np.log(np.tan(np.pi / 4.0 + lat / 2.0))


# ---- data ------------------------------------------------------------------

def read_packed():
    stats = json.load(io.open(os.path.join(DATA, "stats.json"), encoding="utf-8"))
    raw = io.open(os.path.join(DATA, "buildings.bin"), "rb").read()
    assert raw[:5] == b"SPAB7", raw[:5]
    n = struct.unpack_from("<I", raw, 5)[0]
    return stats, raw, n


def write_coverage(stats, raw, n):
    """How many in-taxonomy structures carry a UPI, and a master-plan zone."""
    zone_names = stats["buildings"]["zoneNames"]
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


def growth_points(stats, raw, n):
    """lon, lat of every structure growthPoints() would emit."""
    lon = np.frombuffer(raw, dtype="<f4", count=n, offset=9)
    lat = np.frombuffer(raw, dtype="<f4", count=n, offset=9 + n * 4)
    o = 9 + n * 8
    use = np.frombuffer(raw, dtype=np.uint8, count=n, offset=o)
    year = np.frombuffer(raw, dtype=np.uint8, count=n, offset=o + n)

    # YEAR_ORDER = ['2025', '2023'], so code 0 is the 2025 cohort.
    keep = (use < 7) & (year == 0)
    assert int(keep.sum()) == stats["buildings"]["byYear"]["2025"] - 1, (
        "growth selection does not match stats.json minus the one "
        "off-taxonomy record"
    )
    print(f"  records {n:,}  growth points {int(keep.sum()):,}")
    return lon[keep], lat[keep]


# ---- layers ----------------------------------------------------------------

def density(lon, lat, w, h):
    """Returns (rgba uint8, t float) where t is the normalised surface."""
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
    return out.astype(np.uint8), t


def boundaries(w, h, alpha):
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
                d.line(project(ring), fill=BOUNDARY + (alpha,), width=SS, joint="curve")
                rings += 1
    print(f"  sector rings drawn {rings}")
    return img


# ---- the Esri imagery ground ----------------------------------------------

def tile_xy(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def fetch_tile(z, x, y):
    url = ESRI.format(z=z, x=x, y=y)
    req = urllib.request.Request(url, headers={"User-Agent": "sparc-kigali-landing-build"})
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return Image.open(io.BytesIO(r.read())).convert("RGB")
        except (urllib.error.URLError, OSError):
            continue
    return None


def imagery_ground(w, h):
    """Esri World Imagery mosaicked over BBOX, dimmed. None if unreachable."""
    west, south, east, north = BBOX
    x0f, y0f = tile_xy(west, north, TILE_Z)
    x1f, y1f = tile_xy(east, south, TILE_Z)
    x0, y0, x1, y1 = int(x0f), int(y0f), int(x1f), int(y1f)

    jobs = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    print(f"  fetching {len(jobs)} Esri tiles at z{TILE_Z}")
    with ThreadPoolExecutor(max_workers=8) as pool:
        tiles = list(pool.map(lambda j: fetch_tile(TILE_Z, j[0], j[1]), jobs))
    if any(t is None for t in tiles):
        print("  imagery unreachable, skipping that candidate")
        return None

    mosaic = Image.new("RGB", ((x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256))
    for (x, y), t in zip(jobs, tiles):
        mosaic.paste(t, ((x - x0) * 256, (y - y0) * 256))

    # Crop the mosaic to the exact bbox, in tile-pixel space.
    left = (x0f - x0) * 256
    top = (y0f - y0) * 256
    right = (x1f - x0) * 256
    bottom = (y1f - y0) * 256
    crop = mosaic.crop((round(left), round(top), round(right), round(bottom)))
    crop = crop.resize((w, h), Image.LANCZOS)

    arr = np.asarray(crop).astype(np.float32) * IMAGERY_BRIGHTNESS
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")


# ---- scoring ---------------------------------------------------------------

def rel_lum(rgb):
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    c = np.where(c <= 0.03928, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def score(flat_rgb, t, label):
    a = np.asarray(flat_rgb).astype(np.float64)
    dense = t >= DENSE_AT
    ground = t <= 0.02
    if dense.sum() == 0 or ground.sum() == 0:
        return 0.0
    md, mg = a[dense].mean(axis=0), a[ground].mean(axis=0)
    ld, lg = rel_lum(md), rel_lum(mg)
    ratio = (max(ld, lg) + 0.05) / (min(ld, lg) + 0.05)
    print(f"  {label:<22} dense rgb {md.round(1)}  ground rgb {mg.round(1)}"
          f"  contrast {ratio:.2f}:1  ({int(dense.sum()):,} dense px)")
    return ratio


# ---- main ------------------------------------------------------------------

def compose(ground_img, dens_rgba, bound_img, w, h):
    base = Image.new("RGBA", (w, h), tuple(PAGE_BG) + (255,))
    if ground_img is not None:
        base.paste(ground_img.convert("RGB"), (0, 0))
    base.alpha_composite(bound_img)
    base.alpha_composite(Image.fromarray(dens_rgba, mode="RGBA"))
    return base.convert("RGB")


def main():
    os.makedirs(BUILD, exist_ok=True)
    w = h = SIZE * SS

    stats, raw, n = read_packed()
    write_coverage(stats, raw, n)
    lon, lat = growth_points(stats, raw, n)

    dens_rgba, t = density(lon, lat, w, h)

    print("\n  candidate A: flat page background")
    a = compose(None, dens_rgba, boundaries(w, h, 56), w, h).resize((SIZE, SIZE), Image.LANCZOS)

    print("\n  candidate B: Esri imagery, dimmed")
    img_ground = imagery_ground(w, h)
    b = None
    if img_ground is not None:
        # A brighter boundary, because imagery is noisier than a flat ground.
        b = compose(img_ground, dens_rgba, boundaries(w, h, 90), w, h).resize(
            (SIZE, SIZE), Image.LANCZOS)

    ts = np.asarray(Image.fromarray((t * 255).astype(np.uint8)).resize(
        (SIZE, SIZE), Image.LANCZOS)).astype(np.float32) / 255.0

    print("\n  scoring, dense decile against empty ground")
    sa = score(a, ts, "A flat background")
    sb = score(b, ts, "B dimmed imagery") if b is not None else 0.0

    a.save(os.path.join(BUILD, "growth-still-flat.webp"), format="WEBP",
           quality=QUALITY, method=4)
    if b is not None:
        b.save(os.path.join(BUILD, "growth-still-imagery.webp"), format="WEBP",
               quality=QUALITY, method=4)

    chosen, name = (a, "A flat background") if sa >= sb else (b, "B dimmed imagery")
    chosen.save(OUT, format="WEBP", quality=QUALITY, method=4)

    kb = os.path.getsize(OUT) / 1024.0
    print(f"\n  chose {name}  ({max(sa, sb):.2f}:1 against {min(sa, sb):.2f}:1)")
    print(f"wrote {OUT}  {SIZE}x{SIZE}  {kb:.1f} KB")


if __name__ == "__main__":
    main()
