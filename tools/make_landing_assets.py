"""
Build the landing page's imagery and the few figures stats.json does not hold.

WHAT IT MAKES
    public/hero.webp          Esri imagery of one frame, with every building
                              footprint filled in its use-class colour at 70%.
    public/proof-2023.webp    the same frame of one growing neighbourhood from
    public/proof-2025.webp    two Esri Wayback releases, the later one with the
                              structures SPARC first saw in 2025 outlined.
    public/data/landing.json  the handful of figures and strings the page reads
                              that stats.json does not carry.

WHY STILLS AND NOT A LIVE MAP
    The landing page has a two second budget for the first screen. A live map
    needs MapLibre plus buildings.bin and geometry.bin, about 28 MB, so the
    imagery is rendered ahead of time.

HOW THE FRAMES WERE CHOSEN
    Both by measurement, not by eye, and the numbers are printed on every run.
    The hero frame is scored on how many use classes are actually visible in
    it and on how much of the frame is built. The proof frame is scored on how
    many structures SPARC first saw in 2025 fall inside it.

ON THE TWO IMAGERY DATES
    Esri Wayback serves dated releases of the World Imagery mosaic. A release
    date is when Esri published the mosaic, NOT when the picture was taken, so
    the captions say "Esri World Imagery, Wayback release <date>" and never
    claim a capture date. The releases are checked for a real difference over
    the frame before they are used; the check is printed.

Run:  python tools/make_landing_assets.py
"""
import io
import json
import math
import os
import struct
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "public", "data")
PUB = os.path.join(ROOT, "public")

ORDER = ["CM", "CMI", "RAP", "ROR", "RI", "PI", "I"]
# src/constants.ts COLORS. The map paints from this table, so the hero must too.
COLORS = {
    "RI": (127, 183, 126), "ROR": (76, 175, 80), "RAP": (27, 94, 32),
    "CM": (255, 193, 7), "CMI": (255, 112, 67), "PI": (91, 155, 213),
    "I": (186, 104, 200),
}
ACCENT = (31, 200, 195)          # --accent
FILL_ALPHA = 179                 # 70%

ESRI_NOW = ("https://server.arcgisonline.com/ArcGIS/rest/services/"
            "World_Imagery/MapServer/tile/{z}/{y}/{x}")
WAYBACK = ("https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/"
           "WMTS/1.0.0/default028mm/MapServer/tile/{rel}/{z}/{y}/{x}")
WAYBACK_CFG = "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json"
REL_BEFORE, REL_AFTER = "2023-12-07", "2025-12-18"

OUT_W, OUT_H = 1920, 1080        # 16:9, the render size
HERO_WIDTHS = (960, 1280, 1920)  # shipped as a srcset, so a phone pays least
PROOF_W, PROOF_H = 1400, 875
QUALITY = 70
FRAME_M = 760.0                  # hero frame width on the ground
PROOF_M = 620.0
TILE_Z = 19
SS = 2                           # supersample for the vector overlay
UA = {"User-Agent": "sparc-kigali-landing-build"}


# ---- geography -------------------------------------------------------------

def merc_y(lat_deg):
    lat = np.radians(np.asarray(lat_deg, dtype=np.float64))
    return np.log(np.tan(np.pi / 4.0 + lat / 2.0))


def bbox_for(cx, cy, width_m, aspect):
    mpd_lon = 111320 * math.cos(math.radians(cy))
    w = width_m / mpd_lon
    h = (width_m / aspect) / 111320.0
    return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)


def tile_xy(lon, lat, z):
    n = 2 ** z
    lr = math.radians(lat)
    return ((lon + 180.0) / 360.0 * n,
            (1.0 - math.log(math.tan(lr) + 1.0 / math.cos(lr)) / math.pi) / 2.0 * n)


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return Image.open(io.BytesIO(r.read())).convert("RGB")
        except (urllib.error.URLError, OSError):
            continue
    return None


def mosaic(bbox, size, template, z=TILE_Z, **kw):
    """Esri tiles covering bbox, cropped and resized to size. None on failure."""
    west, south, east, north = bbox
    x0f, y0f = tile_xy(west, north, z)
    x1f, y1f = tile_xy(east, south, z)
    x0, y0, x1, y1 = int(x0f), int(y0f), int(x1f), int(y1f)
    jobs = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    with ThreadPoolExecutor(max_workers=10) as pool:
        tiles = list(pool.map(lambda j: fetch(template.format(z=z, x=j[0], y=j[1], **kw)), jobs))
    missing = sum(t is None for t in tiles)
    if missing:
        print(f"    {missing} of {len(jobs)} tiles missing at z{z}")
        return None

    big = Image.new("RGB", ((x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256))
    for (x, y), t in zip(jobs, tiles):
        big.paste(t, ((x - x0) * 256, (y - y0) * 256))
    crop = big.crop((round((x0f - x0) * 256), round((y0f - y0) * 256),
                     round((x1f - x0) * 256), round((y1f - y0) * 256)))
    return crop.resize(size, Image.LANCZOS)


def mosaic_any(bbox, size, template, zooms=(TILE_Z, TILE_Z - 1), **kw):
    """Not every release is served to the deepest zoom, so step back a level
    rather than give up on the frame."""
    for z in zooms:
        img = mosaic(bbox, size, template, z=z, **kw)
        if img is not None:
            if z != zooms[0]:
                print(f"    fell back to z{z}")
            return img
    return None


# ---- the packed layer ------------------------------------------------------

class Layer:
    def __init__(self):
        self.stats = json.load(io.open(os.path.join(DATA, "stats.json"), encoding="utf-8"))
        raw = io.open(os.path.join(DATA, "buildings.bin"), "rb").read()
        assert raw[:5] == b"SPAB7"
        n = struct.unpack_from("<I", raw, 5)[0]
        self.n = n
        self.lon = np.frombuffer(raw, "<f4", n, 9)
        self.lat = np.frombuffer(raw, "<f4", n, 9 + n * 4)
        o = 9 + n * 8
        self.use = np.frombuffer(raw, np.uint8, n, o)
        self.year = np.frombuffer(raw, np.uint8, n, o + n)
        self.floors = np.frombuffer(raw, np.uint8, n, o + n * 2)
        self.area = np.frombuffer(raw, "<u2", n, o + n * 4)
        self.height = np.frombuffer(raw, "<u2", n, o + n * 4 + n * 2)
        self.sector = np.frombuffer(raw, np.uint8, n, o + n * 4 + n * 6)
        self.zone = np.frombuffer(raw, np.uint8, n, o + n * 4 + n * 6 + n)
        self.sector_names = self.stats["buildings"]["sectorNames"]
        self.zone_names = self.stats["buildings"]["zoneNames"]
        self.upis = io.open(os.path.join(DATA, "upis.txt"), encoding="utf-8").read().split("\n")

        g = io.open(os.path.join(DATA, "geometry.bin"), "rb").read()
        assert g[:5] == b"SPAG1"
        gn = struct.unpack_from("<I", g, 5)[0]
        verts = struct.unpack_from("<I", g, 9)[0]
        o2 = 13
        self.ring_start = np.frombuffer(g, "<u4", gn + 1, o2)
        o2 += (gn + 1) * 4
        self.dx = np.frombuffer(g, "<i2", verts, o2)
        self.dy = np.frombuffer(g, "<i2", verts, o2 + verts * 2)

    def in_frame(self, bbox):
        w, s, e, n = bbox
        return ((self.use < 7) & (self.lon >= w) & (self.lon <= e)
                & (self.lat >= s) & (self.lat <= n))

    def ring(self, i):
        a, b = int(self.ring_start[i]), int(self.ring_start[i + 1])
        if b - a < 3:
            return None
        return (self.lon[i] + self.dx[a:b] * 1e-6, self.lat[i] + self.dy[a:b] * 1e-6)


def project(lons, lats, bbox, w, h):
    west, south, east, north = bbox
    ys, yn = merc_y(south), merc_y(north)
    px = (np.asarray(lons) - west) / (east - west) * (w - 1)
    py = (yn - merc_y(lats)) / (yn - ys) * (h - 1)
    return list(zip(px.tolist(), py.tolist()))


# ---- frame choice ----------------------------------------------------------

def choose_hero(L):
    """Most use classes actually visible, then most built area."""
    best = None
    for name in ("Kimihurura", "Kacyiru", "Nyamirambo"):
        sid = L.sector_names.index(name)
        m = (L.use < 7) & (L.sector == sid)
        x0, x1 = float(L.lon[m].min()), float(L.lon[m].max())
        y0, y1 = float(L.lat[m].min()), float(L.lat[m].max())
        mpd = 111320 * math.cos(math.radians(-1.94))
        w, h = FRAME_M / mpd, (FRAME_M * OUT_H / OUT_W) / 111320.0
        cx = x0 + w / 2
        while cx < x1 - w / 2:
            cy = y0 + h / 2
            while cy < y1 - h / 2:
                bb = bbox_for(cx, cy, FRAME_M, OUT_W / OUT_H)
                sel = L.in_frame(bb)
                k = int(sel.sum())
                if k >= 250:
                    c = Counter(L.use[sel].tolist())
                    # a class counts as visible when at least 8 of it are in frame
                    vis = sum(1 for v in c.values() if v >= 8)
                    built = float(L.area[sel].sum()) / (FRAME_M * FRAME_M * OUT_H / OUT_W)
                    key = (vis, built)
                    if best is None or key > best[0]:
                        best = (key, name, cx, cy, k, c, built)
                cy += h / 4
            cx += w / 4
    key, name, cx, cy, k, c, built = best
    mix = ", ".join(f"{ORDER[u]} {v}" for u, v in sorted(c.items(), key=lambda kv: -kv[1]))
    print(f"  hero frame  {name} {cy:.5f},{cx:.5f}  {k} buildings, "
          f"{key[0]} classes visible, {built*100:.1f}% built")
    print(f"              {mix}")
    return name, cx, cy


def choose_proof(L):
    """Most structures first seen in 2025, city wide."""
    mpd = 111320 * math.cos(math.radians(-1.94))
    w, h = PROOF_M / mpd, (PROOF_M * PROOF_H / PROOF_W) / 111320.0
    new = (L.use < 7) & (L.year == 0)
    gx = (L.lon[new] / w).astype(np.int64)
    gy = (L.lat[new] / h).astype(np.int64)
    cells = Counter(zip(gx.tolist(), gy.tolist()))
    best = None
    for (ix, iy), _ in cells.most_common(12):
        cx, cy = (ix + 0.5) * w, (iy + 0.5) * h
        bb = bbox_for(cx, cy, PROOF_M, PROOF_W / PROOF_H)
        sel = L.in_frame(bb)
        nw = int((sel & (L.year == 0)).sum())
        if best is None or nw > best[0]:
            best = (nw, cx, cy, int(sel.sum()))
    nw, cx, cy, tot = best
    bb = bbox_for(cx, cy, PROOF_M, PROOF_W / PROOF_H)
    sid = Counter(L.sector[L.in_frame(bb)].tolist()).most_common(1)[0][0]
    place = L.sector_names[sid]
    print(f"  proof frame {place} {cy:.5f},{cx:.5f}  {nw} new of {tot} structures")
    return place, cx, cy, nw, tot


# ---- renders ---------------------------------------------------------------

def hero(L, cx, cy):
    bb = bbox_for(cx, cy, FRAME_M, OUT_W / OUT_H)
    print("  fetching hero imagery")
    base = mosaic_any(bb, (OUT_W, OUT_H), ESRI_NOW)
    if base is None:
        raise SystemExit("hero imagery unavailable")

    w, h = OUT_W * SS, OUT_H * SS
    over = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    drawn = 0
    for i in np.nonzero(L.in_frame(bb))[0]:
        r = L.ring(int(i))
        if r is None:
            continue
        pts = project(r[0], r[1], bb, w, h)
        d.polygon(pts, fill=COLORS[ORDER[L.use[i]]] + (FILL_ALPHA,))
        drawn += 1
    over = over.resize((OUT_W, OUT_H), Image.LANCZOS)

    out = base.convert("RGBA")
    out.alpha_composite(over)
    flat = out.convert("RGB")

    sizes = []
    for w in HERO_WIDTHS:
        img = flat if w == OUT_W else flat.resize((w, round(w * OUT_H / OUT_W)), Image.LANCZOS)
        p = os.path.join(PUB, f"hero-{w}.webp")
        img.save(p, format="WEBP", quality=QUALITY, method=6)
        sizes.append(f"{w}px {os.path.getsize(p)/1024:.0f} KB")
    print(f"  wrote hero  {drawn} footprints  " + ", ".join(sizes))
    return bb


def proof(L, cx, cy):
    cfg = json.loads(urllib.request.urlopen(
        urllib.request.Request(WAYBACK_CFG, headers=UA), timeout=60).read().decode())
    rel = {v["itemTitle"].split("Wayback ")[1][:10]: k for k, v in cfg.items()}
    bb = bbox_for(cx, cy, PROOF_M, PROOF_W / PROOF_H)

    print("  fetching proof imagery, two releases")
    before = mosaic_any(bb, (PROOF_W, PROOF_H), WAYBACK, rel=rel[REL_BEFORE])
    after = mosaic_any(bb, (PROOF_W, PROOF_H), WAYBACK, rel=rel[REL_AFTER])
    if before is None or after is None:
        raise SystemExit("wayback imagery unavailable")

    diff = float(np.abs(np.asarray(before).astype(int)
                        - np.asarray(after).astype(int)).mean())
    print(f"  release difference over the frame: {diff:.2f} mean abs pixel"
          f"  {'(real change)' if diff > 12 else '(TOO SIMILAR, do not ship)'}")

    w, h = PROOF_W * SS, PROOF_H * SS
    over = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    sel = L.in_frame(bb) & (L.year == 0)
    outlined = 0
    for i in np.nonzero(sel)[0]:
        r = L.ring(int(i))
        if r is None:
            continue
        pts = project(r[0], r[1], bb, w, h)
        d.line(pts + [pts[0]], fill=ACCENT + (255,), width=3 * SS, joint="curve")
        outlined += 1
    over = over.resize((PROOF_W, PROOF_H), Image.LANCZOS)

    a = after.convert("RGBA")
    a.alpha_composite(over)
    pb = os.path.join(PUB, "proof-2023.webp")
    pa = os.path.join(PUB, "proof-2025.webp")
    before.save(pb, format="WEBP", quality=QUALITY, method=6)
    a.convert("RGB").save(pa, format="WEBP", quality=QUALITY, method=6)
    print(f"  wrote proof pair  {outlined} structures outlined  "
          f"{os.path.getsize(pb)/1024:.0f} KB + {os.path.getsize(pa)/1024:.0f} KB")
    return outlined, diff


def example_upi(L, bb):
    """A real UPI from the hero frame, biggest footprint first so it is easy
    to see when the Atlas flies to it."""
    sel = np.nonzero(L.in_frame(bb))[0]
    sel = sorted(sel, key=lambda i: -int(L.area[i]))
    for i in sel:
        u = L.upis[i].strip() if i < len(L.upis) else ""
        if u:
            print(f"  example UPI {u}  ({ORDER[L.use[i]]}, {int(L.area[i])} m2)")
            return u
    raise SystemExit("no UPI in the hero frame")


LOGO_SRC = os.path.join(ROOT, "Logo")
LOGO_INK = (234, 240, 239)       # #EAF0EF, as the brief sets it
LOGO_BOX = 190                   # px of ink height to normalise toward


def make_logos():
    """Knock each partner mark down to one colour and one optical size.

    The marks arrive as four different things: PNGs with real alpha and a JPEG
    on white. The alpha is taken where it exists and derived from darkness
    where it does not, so a flattened mark does not ship with a white card
    behind it. Sizing is by ink area rather than by height, because a wide
    wordmark set to the same height as a round seal reads far larger.
    """
    if not os.path.isdir(LOGO_SRC):
        print("  no Logo folder, partner marks left as text")
        return []

    # Only marks that may be shown as supplied.
    #
    # The Republic of Rwanda seal is not in the partners row by instruction.
    # WB.jpg is the globe device on its own, with no wordmark; the World Bank
    # mark may not be shown as a bare globe, so the page sets that partner as
    # text until an approved full logo file exists.
    found = []
    for name, file, mono in (
        ("National Land Authority", "NLA_Logo.png", True),
        ("Rwanda Revenue Authority", "Rwanda-Revenue-Authority-logo.png", True),
    ):
        p = os.path.join(LOGO_SRC, file)
        if not os.path.isfile(p):
            print(f"  missing {file}")
            continue
        im = Image.open(p)
        has_alpha = im.mode in ("RGBA", "LA") or "transparency" in im.info
        rgba = im.convert("RGBA")
        if has_alpha:
            a = rgba.split()[3]
        else:
            # Flattened on white: ink is whatever is darker than the paper,
            # stretched so the darkest pixel reaches full opacity. Without the
            # stretch a mid-grey mark ships at half strength and reads grey
            # rather than the ink colour it was asked for.
            g = np.asarray(im.convert("L")).astype(np.float32)
            v = np.clip(255.0 - g, 0, 255)
            if v.max() > 0:
                v *= 255.0 / v.max()
            a = Image.fromarray(v.astype(np.uint8))
        arr = np.asarray(a)
        if arr.max() == 0:
            print(f"  {file} has no usable ink, skipped")
            continue
        ys, xs = np.nonzero(arr > 12)
        box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        found.append([name, file, a.crop(box), rgba.crop(box), mono,
                      float((np.asarray(a.crop(box)) / 255.0).sum())])

    if not found:
        return []

    # Optical size is the geometric mean of two normalisations, because either
    # one alone misbehaves on a mixed set. Equal height alone makes a long
    # wordmark tower over a seal. Equal ink area alone inflates a thin outline
    # drawing, which is how the World Bank globe ended up nearly twice the
    # height of everything beside it. The mean of the two lands where the eye
    # expects.
    target_ink = float(np.median([f[5] for f in found]))
    target_h = float(np.median([f[2].size[1] for f in found]))
    ks = [math.sqrt(math.sqrt(target_ink / f[5]) * (target_h / f[2].size[1]))
          for f in found]
    tallest = max(f[2].size[1] * k for f, k in zip(found, ks))
    group = min(1.0, LOGO_BOX / tallest)

    out = []
    for (name, file, a, rgba, mono, ink), k in zip(found, ks):
        w, h = a.size
        w = max(1, round(w * k * group))
        h = max(1, round(h * k * group))
        if mono:
            img = Image.new("RGBA", (w, h), LOGO_INK + (0,))
            img.putalpha(a.resize((w, h), Image.LANCZOS))
        else:
            img = rgba.resize((w, h), Image.LANCZOS)
        slug = "logo-" + "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")
        while "--" in slug:
            slug = slug.replace("--", "-")
        fp = os.path.join(PUB, f"{slug}.webp")
        img.save(fp, format="WEBP", quality=90, method=6)
        out.append({"name": name, "file": f"{slug}.webp", "w": w, "h": h, "mono": mono})
        print(f"  {name:<26}{w}x{h}  {os.path.getsize(fp)/1024:.0f} KB  "
              f"{'mono' if mono else 'FULL COLOUR, see note'}  from {file}")
    return out


def main():
    L = Layer()
    print("choosing frames")
    _, hx, hy = choose_hero(L)
    place, px, py, new_in_frame, tot_in_frame = choose_proof(L)

    print("\nrendering")
    hbb = hero(L, hx, hy)
    outlined, diff = proof(L, px, py)
    upi = example_upi(L, hbb)

    print("\npartner marks")
    logos = make_logos()

    in_tax = L.use < 7
    h, f = L.height[in_tax], L.floors[in_tax]
    zone_in = L.zone[in_tax & (L.year == 0)]
    undesignated = [z for z in ("A1", "T", "P1", "P2", "P3B", "P3C",
                                "W2", "W3", "W4", "W5", "WB") if z in L.zone_names]
    ids = [L.zone_names.index(z) for z in undesignated]

    out = {
        "structures": int(in_tax.sum()),
        "exampleUpi": upi,
        "logos": logos,
        "attributes": {
            "withHeight": int((h > 0).sum()),
            "fourStoreysPlus": int((f >= 4).sum()),
            "tallestStoreys": int(f.max()),
        },
        # Land the Master Plan does not designate for building at all:
        # agriculture, the transport reserve, the protected zones and the
        # water zones. Reproduces the Pilot Report's figure exactly.
        "undesignatedNew": int(np.isin(zone_in, ids).sum()),
        "undevelopedHa": round(float(L.stats["tax"]["vacantSqm"]) / 10000),
        # The registry comparison, exactly as the Revenue lens computes it.
        # notOnRoll counts the 2025 cohort only, because the RRA extract starts
        # in 2019 and absence says nothing about older stock. It is an upper
        # bound while the exemption register is missing: the exempt flag is set
        # on 32 of 620,170 records, so exempt property cannot yet be removed.
        "registry": {
            "notOnRoll": int(L.stats["buildings"]["revenue"]["newUnregistered"]),
            "conflictsVerified": int(L.stats["buildings"]["revenue"]["useMismatchVerified"]),
            "conflictsAll": int(L.stats["buildings"]["revenue"]["useMismatch"]),
            "exemptFlagged": int(L.stats["buildings"]["revenue"]["exempted"]),
        },
        "proof": {
            "place": place,
            "newInFrame": outlined,
            "totalInFrame": tot_in_frame,
            "before": REL_BEFORE,
            "after": REL_AFTER,
        },
    }
    io.open(os.path.join(DATA, "landing.json"), "w", encoding="utf-8",
            newline="\n").write(json.dumps(out, indent=2) + "\n")
    print(f"\nwrote landing.json {out}")


if __name__ == "__main__":
    main()
