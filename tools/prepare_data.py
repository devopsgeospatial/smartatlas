"""
Turn the exported tables into small, fast files the browser can open instantly.

Inputs (kept out of the repo — they are hundreds of megabytes):
  Kigali_Buildings.geojson   building polygons with predicted use, height, floors, zone
  tax.dbf                    parcel tax table: UPI, zone, designated-for-construction, vacancy

Outputs (public/data/):
  stats.json      every aggregate the panels need — a few kilobytes, loaded in one request
  buildings.bin   one record per structure: centroid + attributes, as packed typed arrays
  geometry.bin    the footprint outlines, as Int16 deltas from each centroid
  upis.txt        parcel identifiers, newline-delimited, index-aligned with buildings.bin

Run:  python tools/prepare_data.py
"""

import array
import io
import json
import os
import struct
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILDINGS = os.path.join(ROOT, "Kigali_Buildings.geojson")
TAX_DBF = os.path.join(ROOT, "tax.dbf")
OUT = os.path.join(ROOT, "public", "data")

USE_ORDER = ["CM", "CMI", "RAP", "ROR", "RI", "PI", "I"]
USE_INDEX = {c: i for i, c in enumerate(USE_ORDER)}
YEAR_ORDER = ["2025", "2023"]
YEAR_INDEX = {y: i for i, y in enumerate(YEAR_ORDER)}


def zone_code(raw):
    """Pull 'R1A' out of 'R1A-Low density residential densification zone'."""
    if not raw:
        return ""
    s = str(raw).strip()
    for i, ch in enumerate(s):
        if ch == "-" or (ch == " " and i > 0 and s[i:i + 2] == " -"):
            return s[:i].strip().upper()
    return s.split()[0].upper() if s else ""


# The tax table spells some sectors in upper case, and one is misspelled. Left
# alone they become extra rows that no sector filter can ever select, so every
# name is folded onto the spelling the buildings layer uses.
SECTOR_ALIASES = {"mageragere": "mageregere"}


def canon_sector(raw, canon):
    """Fold a tax-table sector name onto the buildings layer's spelling."""
    s = (raw or "").strip()
    if not s:
        return ""
    k = SECTOR_ALIASES.get(s.lower(), s.lower())
    return canon.get(k, s.title())


def outer_ring(geom):
    """The outer ring of a Polygon, or of the first part of a MultiPolygon."""
    if not geom:
        return None
    t = geom.get("type")
    if t == "Polygon":
        return geom["coordinates"][0]
    if t == "MultiPolygon":
        return geom["coordinates"][0][0]
    return None


def centroid(geom):
    """Area-weighted centroid of the outer ring; falls back to the mean vertex."""
    if not geom:
        return None
    t = geom.get("type")
    if t == "Polygon":
        ring = geom["coordinates"][0]
    elif t == "MultiPolygon":
        ring = geom["coordinates"][0][0]
    elif t == "Point":
        c = geom["coordinates"]
        return (c[0], c[1])
    else:
        return None
    if len(ring) < 3:
        return None
    a = cx = cy = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i][0], ring[i][1]
        x1, y1 = ring[i + 1][0], ring[i + 1][1]
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(a) < 1e-14:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return (sum(xs) / len(xs), sum(ys) / len(ys))
    a *= 0.5
    return (cx / (6 * a), cy / (6 * a))


def iter_features(path):
    """Stream features out of a GeoJSON file that may be one enormous line."""
    dec = json.JSONDecoder()
    with io.open(path, "r", encoding="utf-8") as f:
        buf = f.read(1 << 20)
        i = buf.find('"features"')
        if i < 0:
            raise SystemExit("no features array found")
        i = buf.index("[", i) + 1
        while True:
            while i < len(buf) and buf[i] in ", \n\r\t":
                i += 1
            if i < len(buf) and buf[i] == "]":
                return
            if i >= len(buf) - 2:
                chunk = f.read(1 << 20)
                if not chunk:
                    return
                buf = buf[i:] + chunk
                i = 0
                continue
            try:
                obj, end = dec.raw_decode(buf, i)
            except ValueError:
                chunk = f.read(1 << 20)
                if not chunk:
                    return
                buf = buf[i:] + chunk
                i = 0
                continue
            yield obj
            i = end


def read_dbf(path):
    """Minimal DBF reader — enough for a flat attribute table."""
    with open(path, "rb") as f:
        hdr = f.read(32)
        n_records = struct.unpack("<I", hdr[4:8])[0]
        hdr_len = struct.unpack("<H", hdr[8:10])[0]
        rec_len = struct.unpack("<H", hdr[10:12])[0]
        fields = []
        while True:
            d = f.read(32)
            if not d or d[0] == 0x0D:
                break
            name = d[0:11].split(b"\x00")[0].decode("latin-1").strip()
            fields.append((name, chr(d[11]), d[16]))
        f.seek(hdr_len)
        for _ in range(n_records):
            raw = f.read(rec_len)
            if not raw or len(raw) < rec_len:
                break
            if raw[0:1] == b"*":  # deleted
                continue
            pos = 1
            row = {}
            for name, _t, ln in fields:
                row[name] = raw[pos:pos + ln].decode("latin-1").strip()
                pos += ln
            yield row


# ---------------------------------------------------------------- buildings
def build_buildings():
    lons, lats = [], []
    uses, years, floors, scores, areas, heights = [], [], [], [], [], []
    sector_idx, zone_idx = [], []
    # Footprint outlines: Int16 deltas from the centroid at 1e-6 degrees
    # (about 0.11 m), which is far finer than the footprints themselves.
    gx = array.array("h")
    gy = array.array("h")
    goff = array.array("I")
    sector_names, zone_names = [], []
    sector_key, zone_key = {}, {}
    upis = []
    by_use = Counter()
    by_year = Counter()
    by_zone = Counter()
    by_zone_use = defaultdict(Counter)
    by_district = Counter()
    by_sector = Counter()
    by_status = Counter()
    zone_labels = {}
    ground = 0
    n = 0

    for feat in iter_features(BUILDINGS):
        p = feat.get("properties") or {}
        c = centroid(feat.get("geometry"))
        if not c:
            continue
        use = (p.get("Land Use Code") or "").strip()
        year = str(p.get("Acquisition Year") or "").strip()
        zone = zone_code(p.get("new_zoning"))

        ring = outer_ring(feat.get("geometry")) or []
        # GeoJSON rings repeat the first vertex last; drop it and re-close on read.
        if len(ring) > 1 and ring[0][0] == ring[-1][0] and ring[0][1] == ring[-1][1]:
            ring = ring[:-1]
        goff.append(len(gx))
        for v in ring:
            dx = int(round((v[0] - c[0]) * 1e6))
            dy = int(round((v[1] - c[1]) * 1e6))
            gx.append(max(-32768, min(32767, dx)))
            gy.append(max(-32768, min(32767, dy)))

        lons.append(c[0])
        lats.append(c[1])
        uses.append(USE_INDEX.get(use, 255))
        years.append(YEAR_INDEX.get(year, 255))

        fl = p.get("Estimated Floors")
        floors.append(max(0, min(255, int(fl))) if isinstance(fl, (int, float)) else 0)
        sc = p.get("Model Confidence")
        scores.append(max(0, min(254, int(round(sc * 254)))) if isinstance(sc, (int, float)) else 255)
        ar = p.get("Footprint Area (sqm)")
        areas.append(max(0, min(65535, int(round(ar)))) if isinstance(ar, (int, float)) else 0)
        ht = p.get("Building Height (m)")
        heights.append(max(0, min(65535, int(round(ht * 10)))) if isinstance(ht, (int, float)) else 0)

        sec = (p.get("Sector") or "").strip()
        if sec not in sector_key:
            sector_key[sec] = len(sector_names)
            sector_names.append(sec)
        sector_idx.append(min(254, sector_key[sec]))
        if zone not in zone_key:
            zone_key[zone] = len(zone_names)
            zone_names.append(zone)
        zone_idx.append(min(254, zone_key[zone]))

        upis.append((p.get("upi") or "").strip())

        by_use[use] += 1
        by_year[year] += 1
        if zone:
            by_zone[zone] += 1
            by_zone_use[zone][use] += 1
            if zone not in zone_labels:
                zone_labels[zone] = str(p.get("new_zoning") or "").strip()
        by_district[(p.get("District") or "").strip()] += 1
        by_sector[(p.get("Sector") or "").strip()] += 1
        by_status[(p.get("status") or "").strip()] += 1
        if p.get("Ground-Confirmed"):
            ground += 1

        n += 1
        if n % 100000 == 0:
            print(f"  ...{n:,} structures", flush=True)

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "buildings.bin"), "wb") as f:
        f.write(b"SPAB1")
        f.write(struct.pack("<I", n))
        f.write(struct.pack(f"<{n}f", *lons))
        f.write(struct.pack(f"<{n}f", *lats))
        f.write(bytes(uses))
        f.write(bytes(years))
        f.write(bytes(floors))
        f.write(bytes(scores))
        f.write(struct.pack(f"<{n}H", *areas))
        f.write(struct.pack(f"<{n}H", *heights))
        f.write(bytes(sector_idx))
        f.write(bytes(zone_idx))

    goff.append(len(gx))  # terminating offset
    with open(os.path.join(OUT, "geometry.bin"), "wb") as f:
        f.write(b"SPAG1")
        f.write(struct.pack("<II", n, len(gx)))
        f.write(goff.tobytes())
        f.write(gx.tobytes())
        f.write(gy.tobytes())

    # newline="" so Windows does not rewrite these \n as \r\n. The browser splits
    # on either, but keeping the file LF means the bytes are the same on every
    # platform and git has nothing to normalise.
    with io.open(os.path.join(OUT, "upis.txt"), "w", encoding="utf-8", newline="") as f:
        f.write("\n".join(upis))

    print(f"  buildings.bin: {n:,} structures, "
          f"{os.path.getsize(os.path.join(OUT, 'buildings.bin')) / 1e6:.1f} MB")
    print(f"  geometry.bin:  {len(gx):,} vertices, "
          f"{os.path.getsize(os.path.join(OUT, 'geometry.bin')) / 1e6:.1f} MB")

    return {
        "total": n,
        "sectorNames": sector_names,
        "zoneNames": zone_names,
        "byUse": dict(by_use),
        "byYear": dict(by_year),
        "byZone": dict(by_zone),
        "byZoneUse": {z: dict(c) for z, c in by_zone_use.items()},
        "zoneLabels": zone_labels,
        "byDistrict": dict(by_district),
        "bySector": dict(by_sector),
        "byStatus": dict(by_status),
        "groundConfirmed": ground,
    }


# ---------------------------------------------------------------------- tax
def build_tax(sector_names):
    canon = {s.lower(): s for s in sector_names if s}
    total = 0
    designated = 0
    vacant = 0
    vacant_designated = 0
    by_status = Counter()
    by_zone = Counter()
    vac_by_zone = Counter()
    vac_by_district = Counter()
    vac_by_sector = defaultdict(
        lambda: {"district": "", "vacant": 0, "designated": 0, "sqm": 0.0, "byZone": Counter()}
    )
    sqm_vacant = 0.0

    for row in read_dbf(TAX_DBF):
        total += 1
        is_constr = row.get("IS_CONSTR_") == "1"
        is_vacant = row.get("IS_VACANT") == "1"
        zone = (row.get("MASTER_ZON") or "").strip().upper()
        district = (row.get("district") or "").strip()
        sector = canon_sector(row.get("sector"), canon)
        status = (row.get("TAX_STATUS") or "").strip()
        try:
            size = float(row.get("size") or 0)
        except ValueError:
            size = 0.0

        by_status[status] += 1
        if zone:
            by_zone[zone] += 1
        if is_constr:
            designated += 1
            vac_by_sector[sector]["designated"] += 1
            vac_by_sector[sector]["district"] = district
        if is_vacant:
            vacant += 1
        if is_constr and is_vacant:
            vacant_designated += 1
            sqm_vacant += size
            if zone:
                vac_by_zone[zone] += 1
            vac_by_district[district] += 1
            vac_by_sector[sector]["vacant"] += 1
            vac_by_sector[sector]["sqm"] += size
            # Per-sector zone mix, so the Revenue lens can narrow to one sector
            # instead of only ever showing the city.
            if zone:
                vac_by_sector[sector]["byZone"][zone] += 1

    sectors = [
        {"sector": s, "district": v["district"], "vacant": v["vacant"],
         "designated": v["designated"], "sqm": round(v["sqm"]),
         "byZone": dict(v["byZone"])}
        for s, v in vac_by_sector.items() if v["vacant"] > 0
    ]
    sectors.sort(key=lambda r: -r["vacant"])

    print(f"  tax.dbf: {total:,} parcels, {vacant_designated:,} designated and vacant")

    return {
        "parcels": total,
        "designated": designated,
        "vacant": vacant,
        "vacantDesignated": vacant_designated,
        "vacantSqm": round(sqm_vacant),
        "byStatus": dict(by_status),
        "byZone": dict(by_zone),
        "vacantByZone": dict(vac_by_zone),
        "vacantByDistrict": dict(vac_by_district),
        "vacantBySector": sectors,
    }


def main():
    missing = [p for p in (BUILDINGS, TAX_DBF) if not os.path.exists(p)]
    if missing:
        raise SystemExit("missing input(s):\n  " + "\n  ".join(missing))

    # Buildings first: its sector names are the canonical spellings, and the tax
    # pass folds its own onto them.
    print("reading Kigali_Buildings.geojson ...")
    buildings = build_buildings()
    print("reading tax.dbf ...")
    tax = build_tax(buildings["sectorNames"])

    stats = {
        "generatedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "buildings": buildings,
        "tax": tax,
    }
    os.makedirs(OUT, exist_ok=True)
    with io.open(os.path.join(OUT, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, separators=(",", ":"))
    print(f"  stats.json: {os.path.getsize(os.path.join(OUT, 'stats.json')) / 1024:.0f} KB")
    print("done")


if __name__ == "__main__":
    main()
