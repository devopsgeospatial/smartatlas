"""
Flag parcels carrying a likely undeclared rental unit, from footprints + parcels.

This is the real-data counterpart to tools/rental_annex_rpi.py, which scored a
synthetic fixture. The signals differ because the data differs, and the honest
version of this tool is the one that scores only what is actually present.

WHAT THE SYNTHETIC MODEL USED THAT THIS ONE CANNOT
    Utility meter counts   no meter layer has been supplied
    Declared use           Parcels.geojson carries no declared_use
    Tax-roll built area    no baseline, so "undeclared expansion" is unmeasurable
    Permit status          no permit register
    Those four are the strongest corroborating signals in the design, and their
    absence is why nothing here should be read as a finding. What remains is a
    morphological argument: a second, separately-roofed, habitable-sized
    structure on a residential parcel is how a let annex looks from above.

WHAT IT USES INSTEAD
    1. A secondary structure in the size band of a dwelling, not a store.
    2. That structure being tall enough to live in, not a single-course shelter.
    3. More than one such structure on the parcel.
    4. Built intensity on the plot, which is what densification-for-rent produces.

THE JOIN
    Buildings already carry `upi`, so parcels and footprints are joined on the
    attribute rather than spatially. That is both far cheaper over ~1 GB of
    GeoJSON and more faithful: the cadastral assignment in the buildings layer
    is authoritative, and re-deriving it from geometry would silently disagree
    with it at every boundary.

TAX
    The rate schedule is the statutory one — Law No. 048/2023, via RRA: a flat
    50% deduction for upkeep, then 0% to 180,000 FRW, 20% to 1,000,000 FRW, 30%
    above. The one input that is NOT statutory is the assumed market rent per
    square metre, which is a parameter. Run --rent to test its sensitivity.

Run:
    python tools/rental_flags.py                     # score and summarise
    python tools/rental_flags.py --out-dir out/      # write the GeoJSON layers
    python tools/rental_flags.py --rent 2500         # sensitivity on rent
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prepare_data import iter_features  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILDINGS = os.path.join(ROOT, "Kigali_Buildings.geojson")
PARCELS = os.path.join(ROOT, "Parcels.geojson")

# ---------------------------------------------------------------- parameters

SHED_MAX_M2 = 20.0  # at or below, a domestic store — exempt
# Calibrated, not assumed. The median second structure on a Kigali residential
# parcel is 38.2 m2 — that is the ordinary detached kitchen, and a floor below it
# flags most compounds in the city. 40 m2 sits just above that median, so the
# common case is excluded by construction rather than by scoring. See
# tools/rental_calibrate.py for the distribution; override with --annex-min.
ANNEX_MIN_M2 = 40.0
ANNEX_MAX_M2 = 120.0  # above, a second full dwelling rather than an annex

# A let unit has to be habitable. A 2.2 m single-course store is not, however
# large its footprint; these are the floors/height a dwelling clears.
HABITABLE_MIN_H_M = 2.4
MIN_ANNEX_CONFIDENCE = 0.50  # below this the footprint itself is in doubt

RESIDENTIAL_USES = {"RI", "ROR", "RAP"}

# Component weights, summing to 100.
#
# Deliberately set so that the two commonest signals — a second structure of
# habitable size, and it being more than one storey — come to 55 and cannot
# reach the threshold between them. A compound in Kigali routinely carries a
# detached kitchen or store that satisfies both. Flagging therefore requires a
# third, harder signal: the annex being substantial relative to the main house,
# a second qualifying annex, or a plot built over far beyond the residential
# norm. That is what "corroboration" means when there is no meter registry and
# no tax roll to corroborate against.
W_SIZE = 30  # secondary structure in the dwelling band
W_STOREYS = 25  # two storeys or more — an outbuilding rarely is
W_RATIO = 20  # substantial next to the main house, not an appendage
W_MULTIPLE = 15  # more than one qualifying annex
W_INTENSITY = 10  # plot built over beyond the residential norm

FLAG_THRESHOLD = 60

# An annex worth this share of the primary footprint reads as a dwelling rather
# than an outbuilding. Below it, the structure is ancillary whatever its size.
RATIO_LO, RATIO_HI = 0.35, 0.70

# --- Statutory. Law No. 048/2023, rental income tax. ------------------------
UPKEEP_DEDUCTION = 0.50  # flat allowance for maintenance and upkeep
BANDS = ((180_000, 0.00), (1_000_000, 0.20), (float("inf"), 0.30))

# --- NOT statutory: a market input. Change it and re-run. -------------------
DEFAULT_RENT_RWF_PER_M2_MONTH = 3_500


def rental_tax_rwf(gross_annual_rent: float) -> int:
    """
    Annual rental income tax under the RRA schedule.

    Flat 50% deduction first, then the progressive bands applied to the
    remainder. Written as an explicit walk over the bands so it can be checked
    against the published table line by line.
    """
    taxable = gross_annual_rent * (1.0 - UPKEEP_DEDUCTION)
    tax = 0.0
    lower = 0.0
    for upper, rate in BANDS:
        if taxable <= lower:
            break
        tax += (min(taxable, upper) - lower) * rate
        lower = upper
    return int(round(tax, -2))


# ------------------------------------------------------------------ pass one


def aggregate_buildings(path: str, verbose: bool = True) -> dict:
    """
    One streaming pass: everything the score needs, per UPI, without geometry.

    Returns {upi: {...}}. Only attributes are kept, so ~630k footprints cost
    tens of megabytes rather than the gigabytes the polygons would.
    """
    agg: dict[str, dict] = {}
    n = skipped = 0
    for feat in iter_features(path):
        p = feat.get("properties") or {}
        upi = (p.get("upi") or "").strip()
        n += 1
        if not upi:
            skipped += 1
            continue
        area = p.get("Footprint Area (sqm)")
        if not isinstance(area, (int, float)):
            skipped += 1
            continue
        h = p.get("Building Height (m)")
        rec = agg.get(upi)
        if rec is None:
            rec = agg[upi] = {
                "structures": [],
                "sector": (p.get("Sector") or "").strip(),
                "district": (p.get("District") or "").strip(),
                "zone": (p.get("new_zoning") or "").strip(),
            }
        rec["structures"].append(
            (
                float(area),
                float(h) if isinstance(h, (int, float)) else 0.0,
                int(p.get("Estimated Floors") or 0),
                (p.get("Land Use Code") or "").strip(),
                float(p.get("Model Confidence") or 0.0),
                p.get("OBJECTID"),
            )
        )
        if verbose and n % 200_000 == 0:
            print(f"  ...{n:,} footprints", file=sys.stderr, flush=True)
    if verbose:
        print(f"  {n:,} footprints over {len(agg):,} parcels "
              f"({skipped:,} without a usable upi or area)", file=sys.stderr)
    return agg


# -------------------------------------------------------------------- score


def _ramp(x: float, lo: float, hi: float) -> float:
    if hi <= lo:
        return 1.0 if x >= hi else 0.0
    return max(0.0, min(1.0, (x - lo) / (hi - lo)))


def score_parcel(rec: dict, parcel_size_m2: float | None) -> dict | None:
    """
    Score one parcel. Returns None when it cannot be a rental-annex case.

    The largest structure is taken as the primary residence and the next largest
    as the candidate annex, which is the same convention the synthetic model
    used and the one an assessor would apply by eye.
    """
    st = sorted(rec["structures"], key=lambda s: -s[0])
    if len(st) < 2:
        return None  # one structure cannot be a secondary dwelling

    primary, annex = st[0], st[1]
    p_area, p_use = primary[0], primary[3]
    a_area, a_h, a_floors, a_use, a_conf, a_oid = annex

    # The exemption is for owner-occupied residential. A parcel whose main
    # structure is commercial or industrial is a different assessment entirely.
    if p_use not in RESIDENTIAL_USES:
        return None
    if a_area <= SHED_MAX_M2:
        return None  # domestic store, exempt
    if a_conf < MIN_ANNEX_CONFIDENCE:
        return None  # the footprint itself is not trustworthy enough to act on

    reasons: list[str] = []
    height_known = True

    # 1. size band ---------------------------------------------------------
    if ANNEX_MIN_M2 <= a_area <= ANNEX_MAX_M2:
        f_size = 1.0
        reasons.append(f"secondary structure {a_area:.0f} m2, within the "
                       f"{ANNEX_MIN_M2:.0f}-{ANNEX_MAX_M2:.0f} m2 dwelling band")
    elif a_area > ANNEX_MAX_M2:
        f_size = 0.6
        reasons.append(f"secondary structure {a_area:.0f} m2 exceeds the annex band — "
                       "assess as a second dwelling")
    else:
        f_size = 0.4
        reasons.append(f"secondary structure {a_area:.0f} m2 is borderline between "
                       "store and dwelling")

    # 2. storeys -----------------------------------------------------------
    # A detached kitchen or store is almost always single-storey. Two storeys
    # is the single most discriminating thing visible from above.
    if a_floors >= 2:
        f_storeys = 1.0
        reasons.append(f"annex is {a_floors} storeys, {a_h:.1f} m")
    elif a_h >= HABITABLE_MIN_H_M:
        f_storeys = 0.35 * _ramp(a_h, HABITABLE_MIN_H_M, 3.5)
        reasons.append(f"annex is single-storey at {a_h:.1f} m")
    elif a_h <= 0.0 and a_floors <= 0:
        # Unknown, not short. The height product misses a quarter of these, and
        # scoring a gap as evidence of anything would be a fabrication.
        f_storeys = 0.0
        height_known = False
        reasons.append("annex height not measured — habitability could not be screened")
    else:
        f_storeys = 0.0
        reasons.append(f"annex only {a_h:.1f} m tall — likely a shelter, not a dwelling")

    # 3. substantial next to the main house ---------------------------------
    ratio = a_area / p_area if p_area > 0 else 0.0
    f_ratio = _ramp(ratio, RATIO_LO, RATIO_HI)
    if f_ratio > 0:
        reasons.append(f"annex is {ratio * 100:.0f}% of the main house "
                       f"({a_area:.0f} m2 against {p_area:.0f} m2)")

    # 4. more than one qualifying annex ------------------------------------
    qualifying = sum(
        1 for s in st[1:]
        if ANNEX_MIN_M2 <= s[0] <= ANNEX_MAX_M2 and s[4] >= MIN_ANNEX_CONFIDENCE
    )
    f_mult = _ramp(qualifying, 1, 3)
    if qualifying >= 2:
        reasons.append(f"{qualifying} separate structures in the dwelling band")

    # 5. built intensity ---------------------------------------------------
    total_built = sum(s[0] for s in st)
    if parcel_size_m2 and parcel_size_m2 > 0:
        cover = total_built / parcel_size_m2
        f_int = _ramp(cover, 0.40, 0.80)
        if f_int > 0:
            reasons.append(f"{cover * 100:.0f}% of the plot is built over "
                           f"({total_built:.0f} m2 on {parcel_size_m2:.0f} m2)")
    else:
        cover = None
        f_int = 0.0

    rpi = (W_SIZE * f_size + W_STOREYS * f_storeys + W_RATIO * f_ratio
           + W_MULTIPLE * f_mult + W_INTENSITY * f_int)
    return {
        "rpi_score": round(rpi, 1),
        "c_size": round(W_SIZE * f_size, 1),
        "c_storeys": round(W_STOREYS * f_storeys, 1),
        "c_ratio": round(W_RATIO * f_ratio, 1),
        "c_multiple": round(W_MULTIPLE * f_mult, 1),
        "c_intensity": round(W_INTENSITY * f_int, 1),
        "building_count": len(st),
        "primary_area_m2": round(p_area, 1),
        "primary_use": p_use,
        "annex_area_m2": round(a_area, 1),
        "annex_height_m": round(a_h, 1),
        "annex_floors": a_floors,
        "annex_use": a_use,
        "annex_confidence": round(a_conf, 2),
        "height_known": height_known,
        "annex_objectid": a_oid,
        "annex_share_of_primary": round(ratio, 2),
        "qualifying_annexes": qualifying,
        "total_built_m2": round(total_built, 1),
        "plot_coverage": round(cover, 3) if cover is not None else None,
        "reasons": reasons,
    }


def risk_tier(rpi: float) -> str:
    if rpi >= 85:
        return "Critical"
    if rpi >= 75:
        return "High"
    if rpi >= FLAG_THRESHOLD:
        return "Medium"
    return "Low"


# ------------------------------------------------------------------- output


def write_geojson(path: str, features: list[dict], name: str) -> None:
    fc = {
        "type": "FeatureCollection",
        "name": name,
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": features,
    }
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(fc, f, ensure_ascii=False)
    print(f"  wrote {path}  ({len(features):,} features, "
          f"{os.path.getsize(path) / 1e6:.1f} MB)", file=sys.stderr)


def round_coords(node):
    if isinstance(node, list):
        return [round_coords(v) for v in node]
    return round(node, 7) if isinstance(node, float) else node


def main() -> int:
    global ANNEX_MIN_M2
    ap = argparse.ArgumentParser(description="Flag parcels with a likely undeclared rental unit")
    ap.add_argument("--rent", type=float, default=DEFAULT_RENT_RWF_PER_M2_MONTH,
                    metavar="RWF", help="assumed market rent per m2 per month")
    ap.add_argument("--threshold", type=float, default=FLAG_THRESHOLD,
                    help=f"flag at or above this score (default {FLAG_THRESHOLD})")
    ap.add_argument("--annex-min", type=float, default=ANNEX_MIN_M2, metavar="M2",
                    help=f"smallest secondary structure treated as lettable "
                         f"(default {ANNEX_MIN_M2:.0f}; see tools/rental_calibrate.py)")
    ap.add_argument("--out-dir", metavar="DIR", help="write the GeoJSON layers here")
    ap.add_argument("--limit", type=int, metavar="N",
                    help="cap features written per layer, highest score first")
    args = ap.parse_args()
    ANNEX_MIN_M2 = args.annex_min

    w = sys.stderr
    t0 = time.perf_counter()

    print("pass 1/3 — aggregating footprints by parcel ...", file=w)
    agg = aggregate_buildings(BUILDINGS)

    print("pass 2/3 — reading parcels ...", file=w)
    parcel_size: dict[str, float] = {}
    parcel_admin: dict[str, tuple] = {}
    np_ = 0
    for feat in iter_features(PARCELS):
        p = feat.get("properties") or {}
        upi = (p.get("upi") or "").strip()
        np_ += 1
        if not upi:
            continue
        s = p.get("size")
        parcel_size[upi] = float(s) if isinstance(s, (int, float)) else 0.0
        parcel_admin[upi] = (
            (p.get("district") or "").strip(),
            (p.get("sector") or "").strip(),
            (p.get("cell") or "").strip(),
            (p.get("village") or "").strip(),
        )
        if np_ % 200_000 == 0:
            print(f"  ...{np_:,} parcels", file=w, flush=True)
    print(f"  {np_:,} parcels, {len(parcel_size):,} with a upi", file=w)

    matched = sum(1 for u in agg if u in parcel_size)
    print(f"  upi join: {matched:,} of {len(agg):,} built parcels matched a cadastral parcel "
          f"({matched / max(1, len(agg)) * 100:.1f}%)", file=w)

    # ---- score -----------------------------------------------------------
    print("scoring ...", file=w)
    scored: dict[str, dict] = {}
    for upi, rec in agg.items():
        r = score_parcel(rec, parcel_size.get(upi))
        if r is None:
            continue
        if r["rpi_score"] < args.threshold:
            continue
        gross = r["annex_area_m2"] * args.rent * 12
        r["gross_annual_rent_rwf"] = int(round(gross, -2))
        r["estimated_annual_tax_rwf"] = rental_tax_rwf(gross)
        r["risk_tier"] = risk_tier(r["rpi_score"])
        d, s, c, v = parcel_admin.get(upi, ("", "", "", ""))
        r.update(upi=upi, district=d or rec["district"], sector=s or rec["sector"],
                 cell=c, village=v, zone=rec["zone"],
                 parcel_size_m2=round(parcel_size.get(upi, 0.0), 1))
        scored[upi] = r

    order = sorted(scored.values(), key=lambda r: -r["rpi_score"])
    if args.limit:
        order = order[: args.limit]
    keep = {r["upi"] for r in order}

    # ---- summary ---------------------------------------------------------
    tiers = Counter(r["risk_tier"] for r in scored.values())
    tax_total = sum(r["estimated_annual_tax_rwf"] for r in scored.values())
    multi = sum(1 for rec in agg.values() if len(rec["structures"]) >= 2)

    print(f"\nParcels with any structure           {len(agg):>10,}", file=w)
    print(f"Parcels with 2+ structures           {multi:>10,}", file=w)
    print(f"Flagged at RPI >= {args.threshold:<5g}              {len(scored):>10,}"
          f"   ({len(scored) / max(1, len(agg)) * 100:.1f}% of built parcels)", file=w)
    for t in ("Critical", "High", "Medium"):
        print(f"  {t:9}                          {tiers[t]:>10,}", file=w)
    print(f"\nAnnex floor                          {ANNEX_MIN_M2:>10,.0f} m2", file=w)
    print(f"Assumed rent                         {args.rent:>10,.0f} RWF/m2/month", file=w)
    print(f"Estimated annual tax at stake        {tax_total:>10,} RWF", file=w)
    print("  statutory schedule applied; the rent is the only assumption", file=w)

    by_d = Counter(r["district"] for r in scored.values())
    print("\nBy district:", file=w)
    for d, k in by_d.most_common():
        print(f"  {d or '(blank)':14} {k:>8,}", file=w)
    top_s = Counter(r["sector"] for r in scored.values())
    print("\nTop sectors:", file=w)
    for s, k in top_s.most_common(10):
        print(f"  {s or '(blank)':14} {k:>8,}", file=w)

    print("\nHighest-scoring parcels:", file=w)
    for r in order[:10]:
        print(f"  {r['upi']:<20} {r['rpi_score']:>5.1f} {r['risk_tier']:<9} "
              f"annex {r['annex_area_m2']:>6.1f} m2  {r['annex_floors']}fl "
              f"{r['annex_height_m']:>4.1f}m  {r['sector']}", file=w)

    if not args.out_dir:
        print(f"\nElapsed {time.perf_counter() - t0:.0f}s. "
              "Pass --out-dir to write the GeoJSON layers.", file=w)
        return 0

    # ---- pass 3: geometry for the flagged parcels and their annexes -------
    os.makedirs(args.out_dir, exist_ok=True)
    print("\npass 3/3 — collecting geometry for flagged parcels ...", file=w)

    PROPS = ["upi", "rpi_score", "risk_tier", "building_count", "annex_area_m2",
             "annex_floors", "annex_height_m", "annex_confidence", "height_known",
             "qualifying_annexes",
             "primary_area_m2", "annex_share_of_primary", "total_built_m2",
             "plot_coverage", "parcel_size_m2",
             "gross_annual_rent_rwf", "estimated_annual_tax_rwf",
             "district", "sector", "cell", "village", "zone", "reasons"]

    parcel_feats: list[dict] = []
    for feat in iter_features(PARCELS):
        p = feat.get("properties") or {}
        upi = (p.get("upi") or "").strip()
        if upi not in keep:
            continue
        r = scored[upi]
        parcel_feats.append({
            "type": "Feature",
            "properties": {k: r.get(k) for k in PROPS},
            "geometry": {"type": feat["geometry"]["type"],
                         "coordinates": round_coords(feat["geometry"]["coordinates"])},
        })
    write_geojson(os.path.join(args.out_dir, "flagged_parcels.geojson"),
                  parcel_feats, "flagged_parcels")

    want_oid = {scored[u]["annex_objectid"] for u in keep}
    annex_feats: list[dict] = []
    for feat in iter_features(BUILDINGS):
        p = feat.get("properties") or {}
        if p.get("OBJECTID") not in want_oid:
            continue
        upi = (p.get("upi") or "").strip()
        r = scored.get(upi)
        if r is None or r["annex_objectid"] != p.get("OBJECTID"):
            continue
        annex_feats.append({
            "type": "Feature",
            "properties": {
                "upi": upi,
                "rpi_score": r["rpi_score"],
                "risk_tier": r["risk_tier"],
                "annex_area_m2": r["annex_area_m2"],
                "annex_floors": r["annex_floors"],
                "annex_height_m": r["annex_height_m"],
                "annex_confidence": r["annex_confidence"],
                "estimated_annual_tax_rwf": r["estimated_annual_tax_rwf"],
                "sector": r["sector"],
                "cell": r["cell"],
            },
            "geometry": {"type": feat["geometry"]["type"],
                         "coordinates": round_coords(feat["geometry"]["coordinates"])},
        })
    write_geojson(os.path.join(args.out_dir, "flagged_annexes.geojson"),
                  annex_feats, "flagged_annexes")

    print(f"\nElapsed {time.perf_counter() - t0:.0f}s", file=w)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
