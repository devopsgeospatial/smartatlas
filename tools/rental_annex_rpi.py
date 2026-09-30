"""
Rental Probability Index (RPI) — detecting undeclared secondary dwelling units.

The question this answers: on a parcel declared "Residential — Owner Occupied",
is there physical evidence of a separate let unit? Three independent signals are
combined, none of which is proof on its own:

  1. A detached secondary structure in the size band of a dwelling, not a shed.
  2. More utility meters than a single household needs.
  3. Built-up area materially above what the tax roll records.

WHAT THIS PRODUCES
    A ranked candidate list for inspection. It is not a finding, and it is not
    evidence. Every flag is an inference from a footprint, a meter count and a
    roll entry; an officer confirms or clears it on site. The output carries the
    per-component reasons so an assessor can see why a parcel scored, and argue
    with it.

COORDINATE REFERENCE SYSTEM
    Working CRS is EPSG:32736 — WGS 84 / UTM zone 36S. Note this differs from
    the 32636 named in the brief: 32636 is zone 36*N*. Kigali is at ~1.94 deg
    SOUTH, so 36N would place it at a negative northing. Zone 36 is correct for
    30 deg E; the hemisphere is not. Areas are computed in the projected CRS and
    the GeoJSON is emitted in EPSG:4326, which the GeoJSON spec requires.

Run:  python tools/rental_annex_rpi.py [--geojson-only] [--out FILE]
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point, Polygon

# ---------------------------------------------------------------- parameters

WORKING_CRS = "EPSG:32736"  # WGS 84 / UTM zone 36S — metres, correct hemisphere
OUTPUT_CRS = "EPSG:4326"  # GeoJSON is WGS 84 lon/lat by specification

# Kigali city centre, used only to anchor the synthetic grid somewhere real.
KIGALI_LON, KIGALI_LAT = 30.0619, -1.9441

# Size bands, in square metres.
SHED_MAX_M2 = 20.0  # at or below this, a domestic store — exempt
ANNEX_MIN_M2 = 25.0  # at or above this, large enough to let
ANNEX_MAX_M2 = 120.0  # above this it is a second house, not an annex

# RPI component weights. These sum to 100.
W_ANNEX = 40
W_METERS = 35
W_EXPANSION = 25

FLAG_THRESHOLD = 60  # at or above this, worth an inspection visit

# ---------------------------------------------------------------------------
# ILLUSTRATIVE tax assumptions. These are placeholders for a worked example and
# are NOT the Rwanda Revenue Authority's schedule. Replace both with the current
# statutory figures before any of this reaches an assessment. The estimate is
# deliberately a single, legible multiplication so a reviewer can check it.
# ---------------------------------------------------------------------------
ASSUMED_RENT_RWF_PER_M2_MONTH = 3_500
ASSUMED_EFFECTIVE_TAX_RATE = 0.20

RNG = np.random.default_rng(42)  # fixed, so the same run gives the same parcels


# ------------------------------------------------------------------ synthesis


def _origin() -> tuple[float, float]:
    """Kigali centre projected into the working CRS."""
    pt = gpd.GeoSeries([Point(KIGALI_LON, KIGALI_LAT)], crs=OUTPUT_CRS).to_crs(WORKING_CRS)
    return float(pt.x.iloc[0]), float(pt.y.iloc[0])


def _rect(cx: float, cy: float, w: float, h: float, jitter: float = 0.0) -> Polygon:
    """Axis-aligned rectangle centred on (cx, cy), optionally roughened."""
    dx, dy = w / 2.0, h / 2.0
    pts = [(cx - dx, cy - dy), (cx + dx, cy - dy), (cx + dx, cy + dy), (cx - dx, cy + dy)]
    if jitter:
        pts = [(x + RNG.uniform(-jitter, jitter), y + RNG.uniform(-jitter, jitter)) for x, y in pts]
    return Polygon(pts)


# Twenty parcels, by archetype. `annex` is the secondary structure area in m²
# (0 = none). `meters` is how many utility meters stand on the parcel.
# `declared_built_m2` is what the tax roll records as built — the baseline the
# expansion signal measures against.
ARCHETYPES = [
    # -- compliant: one house, one meter, roll matches the ground (7) ---------
    *[
        dict(kind="single_home", primary=140.0, annex=0.0, meters=1, declared=140.0)
        for _ in range(4)
    ],
    dict(kind="single_home", primary=95.0, annex=0.0, meters=1, declared=95.0),
    dict(kind="single_home", primary=180.0, annex=0.0, meters=1, declared=180.0),
    dict(kind="single_home", primary=120.0, annex=0.0, meters=1, declared=120.0),
    # -- exempt: house plus a domestic store under 20 m² (4) ------------------
    dict(kind="home_with_shed", primary=130.0, annex=12.0, meters=1, declared=130.0),
    dict(kind="home_with_shed", primary=145.0, annex=16.5, meters=1, declared=145.0),
    dict(kind="home_with_shed", primary=110.0, annex=9.0, meters=1, declared=110.0),
    dict(kind="home_with_shed", primary=160.0, annex=18.0, meters=2, declared=160.0),
    # -- high risk: independent annex, extra meters, roll understates (5) -----
    dict(kind="likely_rental", primary=150.0, annex=48.0, meters=2, declared=150.0),
    dict(kind="likely_rental", primary=155.0, annex=62.0, meters=3, declared=155.0),
    dict(kind="likely_rental", primary=145.0, annex=75.0, meters=3, declared=145.0),
    dict(kind="likely_rental", primary=165.0, annex=55.0, meters=2, declared=165.0),
    dict(kind="likely_rental", primary=138.0, annex=45.0, meters=3, declared=138.0),
    # -- edge cases that keep the scoring honest (4) --------------------------
    # Annex in band, but a single meter and the roll already knows about it.
    dict(kind="edge_declared_footprint", primary=150.0, annex=52.0, meters=1, declared=202.0),
    # Two meters, no secondary structure at all — a workshop in the main house.
    dict(kind="edge_meters_only", primary=175.0, annex=0.0, meters=3, declared=175.0),
    # Second structure too large to be an annex — reads as a second dwelling.
    dict(kind="edge_oversize", primary=160.0, annex=185.0, meters=3, declared=160.0),
    # Already declared as a rental. Physically identical to the high-risk set,
    # and must NOT be flagged as evasion — it is compliant.
    dict(kind="declared_rental", primary=150.0, annex=60.0, meters=3, declared=150.0),
]

# Beyond the curated 20, parcels are drawn from this mix. The weights are a
# PLANNING ASSUMPTION, not a measurement: nobody has surveyed Kigali for annex
# prevalence, and that is precisely the number this tool exists to establish.
# They are set so roughly 6 in 100 parcels carry an undeclared let unit, which
# is a conservative reading of what similar cities find. Change them and the
# revenue projection changes proportionally — so quote the flag rate, never the
# rate implied by the 20-parcel fixture, which is 25% by construction.
PREVALENCE = {
    "single_home": 0.55,
    "home_with_shed": 0.28,
    "likely_rental": 0.06,
    "edge_declared_footprint": 0.03,
    "edge_meters_only": 0.03,
    "edge_oversize": 0.01,
    "declared_rental": 0.04,
}

# Per-archetype ranges the sampler draws from: primary m2, annex m2, meters.
DRAW = {
    "single_home": ((85, 200), (0, 0), (1, 1)),
    "home_with_shed": ((100, 175), (6, 19), (1, 2)),
    "likely_rental": ((130, 175), (30, 95), (2, 3)),
    "edge_declared_footprint": ((140, 170), (35, 70), (1, 1)),
    "edge_meters_only": ((150, 195), (0, 0), (2, 3)),
    "edge_oversize": ((150, 190), (130, 210), (2, 3)),
    "declared_rental": ((130, 175), (30, 90), (2, 3)),
}


def _sample_spec(rng: np.random.Generator) -> dict:
    """One randomised parcel drawn from the prevalence mix."""
    kinds = list(PREVALENCE)
    kind = str(rng.choice(kinds, p=[PREVALENCE[k] for k in kinds]))
    (plo, phi), (alo, ahi), (mlo, mhi) = DRAW[kind]
    primary = round(float(rng.uniform(plo, phi)), 1)
    annex = round(float(rng.uniform(alo, ahi)), 1) if ahi > 0 else 0.0
    meters = int(rng.integers(mlo, mhi + 1))
    # The roll usually records the primary only; sometimes it is already correct.
    declared = primary
    if kind == "edge_declared_footprint":
        declared = round(primary + annex, 1)
    elif kind in ("single_home", "home_with_shed") and rng.random() < 0.85:
        declared = primary
    return dict(kind=kind, primary=primary, annex=annex, meters=meters, declared=declared)


def build_specs(n: int, rng: np.random.Generator) -> list[dict]:
    """
    The curated 20 first, then randomised parcels to reach n.

    The fixture stays at the front so the self-check keeps testing the same
    known archetypes however large the run is.
    """
    if n <= len(ARCHETYPES):
        return ARCHETYPES[:n]
    return ARCHETYPES + [_sample_spec(rng) for _ in range(n - len(ARCHETYPES))]


DECLARED_USE = {
    "declared_rental": "Residential - Rental Declared",
}
OWNERS = [
    "UWASE Marie", "HABIMANA Jean", "MUKAMANA Alice", "NSENGIYUMVA Eric",
    "KAYITESI Diane", "BIZIMANA Paul", "INGABIRE Grace", "RWEMA Olivier",
    "MUTESI Sandrine", "GATERA Emmanuel", "UWIMANA Claudine", "NKURUNZIZA Felix",
    "IRADUKUNDA Ange", "MUGISHA David", "KWIZERA Sylvie", "NDAYISABA Thierry",
    "UMUTONI Peace", "SEBAGABO Aimable", "MUKARUGWIZA Josee", "TWAGIRAYEZU Alex",
]


def synthesize(n: int = 20) -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame, gpd.GeoDataFrame]:
    """Build the three input layers: parcels, building footprints, utility meters."""
    ox, oy = _origin()

    parcel_w, parcel_h = 30.0, 26.0
    gap_x, gap_y = 6.0, 8.0  # road reserve between parcels
    specs = build_specs(n, RNG)
    cols = 5 if n <= 20 else int(np.ceil(np.sqrt(n)))

    parcels, buildings, meters = [], [], []

    for i, spec in enumerate(specs):
        col, row = i % cols, i // cols
        cx = ox + col * (parcel_w + gap_x)
        cy = oy - row * (parcel_h + gap_y)

        upi = f"1/03/07/{row + 1:02d}/{col + 1:04d}"
        parcels.append(
            {
                "upi": upi,
                "owner_name": OWNERS[i] if i < len(OWNERS) else f"Parcel holder {i:05d}",
                "declared_use": DECLARED_USE.get(spec["kind"], "Residential - Owner Occupied"),
                "declared_built_m2": spec["declared"],
                "_truth": spec["kind"],  # withheld from scoring; used to sanity-check
                "geometry": _rect(cx, cy, parcel_w, parcel_h),
            }
        )

        # Primary residence, toward the street edge of the plot.
        side = float(np.sqrt(spec["primary"]))
        py = cy + parcel_h / 2 - side / 2 - 3.0
        buildings.append(
            {
                "building_id": f"B{i:03d}A",
                "geometry": _rect(cx, py, side, side, jitter=0.15),
            }
        )

        # Secondary structure, set back toward the rear boundary.
        if spec["annex"] > 0:
            aside = float(np.sqrt(spec["annex"]))
            ay = cy - parcel_h / 2 + aside / 2 + 2.5
            buildings.append(
                {
                    "building_id": f"B{i:03d}B",
                    "geometry": _rect(cx + 4.0, ay, aside, aside, jitter=0.12),
                }
            )

        # Meters clustered near the street frontage, as they are in practice.
        for m in range(spec["meters"]):
            meters.append(
                {
                    "meter_id": f"M{i:03d}{chr(65 + m)}",
                    "meter_type": "ELECTRICITY" if m % 2 == 0 else "WATER",
                    "geometry": Point(
                        cx - parcel_w / 2 + 2.0 + m * 1.8 + RNG.uniform(-0.3, 0.3),
                        cy + parcel_h / 2 - 1.6 + RNG.uniform(-0.3, 0.3),
                    ),
                }
            )

    parcels_gdf = gpd.GeoDataFrame(parcels, geometry="geometry", crs=WORKING_CRS)
    buildings_gdf = gpd.GeoDataFrame(buildings, geometry="geometry", crs=WORKING_CRS)
    meters_gdf = gpd.GeoDataFrame(meters, geometry="geometry", crs=WORKING_CRS)
    return parcels_gdf, buildings_gdf, meters_gdf


# ------------------------------------------------------------- spatial joins


def assign_buildings(
    parcels: gpd.GeoDataFrame, buildings: gpd.GeoDataFrame
) -> gpd.GeoDataFrame:
    """
    Attach each footprint to exactly one parcel.

    A footprint that crosses a boundary would be dropped by a `within` join and
    double-counted by an `intersects` one. Neither is acceptable when the count
    of buildings on a parcel is itself a scoring signal, so this intersects the
    two layers, measures the shared area, and gives the building to whichever
    parcel holds most of it.
    """
    b = buildings.copy()
    b["_full_area_m2"] = b.geometry.area

    pieces = gpd.overlay(
        b[["building_id", "_full_area_m2", "geometry"]],
        parcels[["upi", "geometry"]],
        how="intersection",
        keep_geom_type=True,
    )
    if pieces.empty:
        return gpd.GeoDataFrame(
            columns=["building_id", "upi", "area_m2", "_full_area_m2", "share_in_parcel"]
        )

    pieces["_overlap_m2"] = pieces.geometry.area
    pieces = pieces.sort_values("_overlap_m2", ascending=False)
    best = pieces.drop_duplicates(subset="building_id", keep="first").copy()

    # Score on the whole footprint, not the clipped sliver: a 60 m² annex that
    # laps 0.4 m over the boundary is still a 60 m² annex.
    best["area_m2"] = best["_full_area_m2"]
    best["share_in_parcel"] = best["_overlap_m2"] / best["_full_area_m2"]
    return best[["building_id", "upi", "area_m2", "share_in_parcel"]].reset_index(drop=True)


def assign_meters(parcels: gpd.GeoDataFrame, meters: gpd.GeoDataFrame) -> pd.DataFrame:
    """Count meters per parcel. A point is unambiguous, so a plain join is fine."""
    joined = gpd.sjoin(
        meters[["meter_id", "meter_type", "geometry"]],
        parcels[["upi", "geometry"]],
        how="inner",
        predicate="within",
    )
    return (
        joined.groupby("upi")
        .agg(meter_count=("meter_id", "count"), meter_types=("meter_type", "nunique"))
        .reset_index()
    )


# ----------------------------------------------------------------- features


def parcel_features(
    parcels: gpd.GeoDataFrame, b_assigned: gpd.GeoDataFrame, m_counts: pd.DataFrame
) -> gpd.GeoDataFrame:
    """Roll the assigned buildings and meters up to one row per parcel."""
    if b_assigned.empty:
        agg = pd.DataFrame(columns=["upi", "building_count", "max_building_area_m2",
                                    "annex_area_m2", "total_built_m2"])
    else:
        rows = []
        for upi, grp in b_assigned.groupby("upi"):
            areas = np.sort(grp["area_m2"].to_numpy())[::-1]
            rows.append(
                {
                    "upi": upi,
                    "building_count": int(len(areas)),
                    "max_building_area_m2": float(areas[0]),
                    # The largest structure that is not the primary residence.
                    "annex_area_m2": float(areas[1]) if len(areas) > 1 else 0.0,
                    "total_built_m2": float(areas.sum()),
                }
            )
        agg = pd.DataFrame(rows)

    out = parcels.merge(agg, on="upi", how="left").merge(m_counts, on="upi", how="left")
    out["building_count"] = out["building_count"].fillna(0).astype(int)
    out["meter_count"] = out["meter_count"].fillna(0).astype(int)
    out["meter_types"] = out["meter_types"].fillna(0).astype(int)
    for c in ("max_building_area_m2", "annex_area_m2", "total_built_m2"):
        out[c] = out[c].fillna(0.0)

    out["parcel_area_m2"] = out.geometry.area
    out["coverage_ratio"] = out["total_built_m2"] / out["parcel_area_m2"]
    # How far the ground exceeds the roll, as a fraction of the roll.
    out["expansion_ratio"] = np.where(
        out["declared_built_m2"] > 0,
        (out["total_built_m2"] - out["declared_built_m2"]) / out["declared_built_m2"],
        0.0,
    )
    return out


# --------------------------------------------------------------------- score


def _ramp(x: float, lo: float, hi: float) -> float:
    """0 below lo, 1 above hi, linear between. Keeps a score from being a cliff."""
    if hi <= lo:
        return 1.0 if x >= hi else 0.0
    return float(np.clip((x - lo) / (hi - lo), 0.0, 1.0))


def score_row(r: pd.Series) -> dict:
    """
    Three weighted components, each with a stated reason.

    Every factor is in [0, 1] and multiplies its documented weight, so the
    weights in the header are the real maxima and the total cannot exceed 100.
    """
    reasons: list[str] = []

    # 1. A secondary structure in the size band of a dwelling ---------------
    a = r["annex_area_m2"]
    if ANNEX_MIN_M2 <= a <= ANNEX_MAX_M2:
        f_annex = 1.0
        reasons.append(f"secondary structure {a:.0f} m2, within the {ANNEX_MIN_M2:.0f}-{ANNEX_MAX_M2:.0f} m2 dwelling band")
    elif a > ANNEX_MAX_M2:
        # Too big to be an annex. Still irregular, but it is a different case:
        # a second full dwelling, which is assessed on another basis.
        f_annex = 0.6
        reasons.append(f"secondary structure {a:.0f} m2 exceeds the annex band — assess as a second dwelling")
    elif a > SHED_MAX_M2:
        f_annex = 0.4  # 20-25 m²: borderline, could be a large store
        reasons.append(f"secondary structure {a:.0f} m2 is borderline between store and dwelling")
    else:
        f_annex = 0.0
        if a > 0:
            reasons.append(f"secondary structure {a:.0f} m2 is within the domestic store exemption")

    # 2. More meters than one household needs -------------------------------
    m = int(r["meter_count"])
    if m >= 3:
        f_meter = 1.0
        reasons.append(f"{m} utility meters on one residential parcel")
    elif m == 2:
        f_meter = 0.7
        reasons.append("2 utility meters on one residential parcel")
    else:
        f_meter = 0.0

    # 3. Built-up area above what the roll records ---------------------------
    e = float(r["expansion_ratio"])
    f_exp = _ramp(e, 0.10, 0.60)
    if f_exp > 0:
        reasons.append(
            f"built area {r['total_built_m2']:.0f} m2 against {r['declared_built_m2']:.0f} m2 on the roll (+{e * 100:.0f}%)"
        )

    rpi = W_ANNEX * f_annex + W_METERS * f_meter + W_EXPANSION * f_exp
    return {
        "rpi_score": round(float(rpi), 1),
        "c_annex": round(W_ANNEX * f_annex, 1),
        "c_meters": round(W_METERS * f_meter, 1),
        "c_expansion": round(W_EXPANSION * f_exp, 1),
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


def estimated_tax_rwf(annex_m2: float) -> int:
    """
    Illustrative only — see the assumptions block at the top of this file.

    Annual rent on the annex, times an assumed effective rate. One
    multiplication, so a reviewer can check it without reading code.
    """
    if annex_m2 < ANNEX_MIN_M2:
        return 0
    annual_rent = annex_m2 * ASSUMED_RENT_RWF_PER_M2_MONTH * 12
    return int(round(annual_rent * ASSUMED_EFFECTIVE_TAX_RATE, -3))


def score(parcels: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    out = parcels.copy()
    comp = out.apply(score_row, axis=1, result_type="expand")
    out = pd.concat([out, comp], axis=1)

    # A parcel already declared as a rental is compliant, whatever it looks
    # like from the air. Scoring it as evasion would send an officer to a
    # taxpayer who has already done the right thing.
    already = out["declared_use"].str.contains("Rental", case=False, na=False)
    out.loc[already, "rpi_score"] = 0.0
    out.loc[already, "reasons"] = out.loc[already, "reasons"].apply(
        lambda _: ["already declared as a rental — compliant, not a candidate"]
    )

    out["risk_tier"] = out["rpi_score"].apply(risk_tier)
    out["estimated_annual_tax_evaded_rwf"] = np.where(
        out["rpi_score"] >= FLAG_THRESHOLD,
        out["annex_area_m2"].apply(estimated_tax_rwf),
        0,
    )
    return gpd.GeoDataFrame(out, geometry="geometry", crs=parcels.crs)


# -------------------------------------------------------------------- output

PROPS = [
    "upi",
    "rpi_score",
    "risk_tier",
    "building_count",
    "annex_area_m2",
    "meter_count",
    "estimated_annual_tax_evaded_rwf",
]


def to_geojson(flagged: gpd.GeoDataFrame) -> str:
    """Flagged parcels as a WGS 84 FeatureCollection, ordered by score."""
    g = flagged.sort_values("rpi_score", ascending=False).to_crs(OUTPUT_CRS).copy()
    g["annex_area_m2"] = g["annex_area_m2"].round(1)
    keep = PROPS + ["owner_name", "declared_use", "max_building_area_m2", "reasons"]
    g["max_building_area_m2"] = g["max_building_area_m2"].round(1)
    fc = json.loads(g[keep + ["geometry"]].to_json(drop_id=True))

    # 7 decimal places is about a centimetre at this latitude. The 14 that come
    # out of the reprojection are noise, and they triple the file.
    def _round(node):
        if isinstance(node, list):
            return [_round(v) for v in node]
        return round(node, 7) if isinstance(node, float) else node

    for feat in fc["features"]:
        feat["geometry"]["coordinates"] = _round(feat["geometry"]["coordinates"])

    fc["name"] = "rental_evasion_candidates"
    fc["crs"] = {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}}
    return json.dumps(fc, indent=2, ensure_ascii=False)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-n", "--parcels", type=int, default=20, metavar="N",
                    help="parcels to synthesize (default 20: the curated fixture)")
    ap.add_argument("--seed", type=int, default=42, help="RNG seed (default 42)")
    ap.add_argument("--geojson-only", action="store_true", help="print only the FeatureCollection")
    ap.add_argument("--summary-only", action="store_true",
                    help="print the summary and suppress the FeatureCollection")
    ap.add_argument("--out", metavar="FILE", help="also write the GeoJSON to a file")
    args = ap.parse_args()

    global RNG
    RNG = np.random.default_rng(args.seed)

    t0 = time.perf_counter()
    parcels_gdf, buildings_gdf, meters_gdf = synthesize(args.parcels)
    b_assigned = assign_buildings(parcels_gdf, buildings_gdf)
    m_counts = assign_meters(parcels_gdf, meters_gdf)
    feats = parcel_features(parcels_gdf, b_assigned, m_counts)
    scored = score(feats)
    flagged = scored[scored["rpi_score"] >= FLAG_THRESHOLD].copy()
    elapsed = time.perf_counter() - t0

    if not args.geojson_only:
        w = sys.stderr
        print(f"CRS            {WORKING_CRS} for measurement, {OUTPUT_CRS} for output", file=w)
        print(f"Inputs         {len(parcels_gdf)} parcels, {len(buildings_gdf)} footprints, "
              f"{len(meters_gdf)} meters", file=w)
        print(f"Assigned       {len(b_assigned)} footprints to parcels, "
              f"{int(m_counts['meter_count'].sum())} meters", file=w)

        cols = ["upi", "_truth", "building_count", "max_building_area_m2", "annex_area_m2",
                "meter_count", "c_annex", "c_meters", "c_expansion", "rpi_score", "risk_tier"]
        ranked = scored.sort_values("rpi_score", ascending=False)
        if len(scored) <= 40:
            print(f"\nAll {len(scored)} parcels, scored:\n", file=w)
            print(ranked[cols].to_string(index=False, float_format=lambda v: f"{v:.1f}"), file=w)
        else:
            print("\nTop 15 by score:\n", file=w)
            print(ranked[cols].head(15).to_string(index=False,
                  float_format=lambda v: f"{v:.1f}"), file=w)
            print("\nRisk tiers:", file=w)
            for tier in ("Critical", "High", "Medium", "Low"):
                k = int((scored["risk_tier"] == tier).sum())
                print(f"  {tier:9} {k:>8,}  {k / len(scored) * 100:5.1f}%", file=w)

        rate = len(flagged) / len(scored) * 100
        print(f"\nFlagged at RPI >= {FLAG_THRESHOLD}: {len(flagged):,} of "
              f"{len(scored):,} parcels ({rate:.1f}%)", file=w)
        total = int(flagged["estimated_annual_tax_evaded_rwf"].sum())
        print(f"Illustrative annual tax at stake: {total:,} RWF "
              f"(assumptions at the top of this file — not RRA's schedule)", file=w)
        if len(scored) <= len(ARCHETYPES):
            print("NOTE: the curated fixture is 25% evasion by construction. Do not read a "
                  "city-wide rate off it — run with -n for a prevalence-weighted sample.",
                  file=w)
        print(f"Elapsed: {elapsed:.2f}s for {len(parcels_gdf):,} parcels, "
              f"{len(buildings_gdf):,} footprints, {len(meters_gdf):,} meters\n", file=w)

        # Did the score recover the archetypes it was built to catch?
        truth = scored.set_index("upi")["_truth"]
        got = set(flagged["upi"])
        should = set(scored.loc[scored["_truth"] == "likely_rental", "upi"])
        must_not = set(scored.loc[scored["_truth"].isin(
            ["single_home", "home_with_shed", "declared_rental"]), "upi"])
        print(f"Recall on planted evasion parcels : {len(should & got)}/{len(should)}", file=w)
        print(f"False flags on compliant parcels  : {len(must_not & got)}", file=w)
        extra = sorted(got - should)
        for u in extra[:5]:
            print(f"  also flagged {u} ({truth[u]})", file=w)
        if len(extra) > 5:
            print(f"  ... and {len(extra) - 5:,} more", file=w)
        print("\n" + "-" * 72 + "\n", file=w)

    if args.summary_only:
        return 0

    gj = to_geojson(flagged)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(gj)
        print(f"wrote {args.out}", file=sys.stderr)
    print(gj)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
