"""
Join the RRA registry extract to the SPARC building layer, on UPI.

WHAT THIS PRODUCES
    Two flags, exactly as specified:
        status_in_registry   Yes / No   — is this parcel's UPI in the RRA extract
        status_use           Yes / No   — does the declared use match the observed use
    plus the diagnostic columns that make those two safe to act on, and three
    aggregate tables an assessor can actually work from.

RUNS ANYWHERE
    python tools/rra_join.py --registry rra_extract.csv

    or, in Jupyter / Spyder / VS Code:
        from tools.rra_join import run
        out = run(registry="rra_extract.csv")
        out.buildings.head();  out.parcels.head();  out.by_area

    No RRA file yet? Generate a plausible one from our own UPIs and exercise the
    whole pipeline today:
        python tools/rra_join.py --make-fixture fixture_rra.csv
        python tools/rra_join.py --registry fixture_rra.csv

================================================================================
THREE THINGS IN THE DATA THAT CHANGE THIS DESIGN
================================================================================

1.  A PARCEL IS NOT A BUILDING, AND THE RATIO IS NOT SMALL.
    620,205 structures sit on 262,915 distinct UPIs. 156,150 parcels (59%) carry
    more than one building, and those parcels hold 508,243 buildings — 82% of
    the city. One parcel reaches 493 structures.

    Declared use is an attribute of the PARCEL. Observed use is an attribute of
    the BUILDING. Comparing them building by building therefore asks a question
    the registry cannot answer: a parcel declared residential, carrying a house
    and a shop, is not "wrong" on the house. Scored naively, 82% of the city is
    exposed to a mismatch that is an artefact of the join, not a finding — and
    an assessor who works ten of those and finds nothing stops trusting the
    eleventh, which may be real.

    So the parcel is the unit of analysis. Building-level output is still
    written, because it was asked for and it is useful for inspection, but the
    headline numbers come off parcels_rra_join.csv, and status_use at parcel
    level asks the fair question: does ANY structure on this parcel match what
    was declared? The valuable signal is the companion flag,
    has_undeclared_use_class — a parcel where something is standing that the
    declaration does not account for.

2.  "NO" IS THREE DIFFERENT ANSWERS WEARING ONE LABEL.
    A UPI that does not match can mean the parcel is genuinely unregistered, or
    that our layer has no UPI for it (5,197 structures carry none), or that the
    two sides simply spell the identifier differently. Only the first is a
    revenue lead. The other two are data-quality work, and they are cheap to
    separate — so status_in_registry stays strictly Yes/No as specified, and
    join_quality carries the reason beside it. Filter on join_quality before
    sending anyone into the field.

3.  THE TWO SIDES WILL NOT SPELL THE UPI THE SAME WAY.
    Ours is zero-padded, slash-separated: 1/01/04/01/19. An extract from another
    system may drop the padding, use dashes, carry stray whitespace, or arrive
    from Excel with the whole thing mangled into a date or a float. Both sides
    are normalised to one canonical form before comparison, and the script
    reports how many rows changed under normalisation — if that number is large,
    read it as a warning that the raw join would have failed silently.

A FOURTH THING, ON THE USE COMPARISON
    The RRA extract will not use our seven-code taxonomy. String equality
    between "Residential" and "RI" is False, and a script that reports that as a
    mismatch is generating noise at scale. Declared values are therefore mapped
    through an editable crosswalk (tools/rra_use_crosswalk.csv). Anything not in
    the crosswalk is NOT scored as a mismatch: it is reported as uncomparable
    and listed in unmapped_declared_uses.csv so the crosswalk can be extended.
    Silence is the correct output for a question we could not ask.

    Observed use is a model inference carrying a confidence. Comparing a 0.3
    inference against a declaration and calling the difference a mismatch is
    also noise; --min-confidence (default 0.0, so nothing is hidden by default)
    lets an assessor raise the bar for a worklist.

OUTPUTS (written to --out-dir, default: the working directory)
    buildings_rra_join.csv        one row per structure
    parcels_rra_join.csv          one row per parcel — the unit to work from
    summary_by_area.csv           counts by district and sector
    unmapped_declared_uses.csv    declared values the crosswalk does not cover
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import random
import re
import sys
from dataclasses import dataclass
from typing import Iterator

try:
    import pandas as pd
except ImportError:  # pragma: no cover - environment guard
    sys.exit(
        "pandas is not installed on this machine.\n"
        "  online:   pip install pandas\n"
        "  offline:  bring a wheel and run  pip install --no-index "
        "pandas-*.whl numpy-*.whl\n"
        "  Anaconda / ArcGIS Pro already ship it — run this from that Python "
        "instead.\n"
        "This script needs nothing else: no geopandas, no GDAL, no internet."
    )

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ============================================================================
#  >>>  PUT THE RRA FILE HERE  <<<
#
#  Drop the RRA extract next to this repo and write its path below, then just
#  press Run in Jupyter / Spyder / VS Code — nothing else needs editing.
#
#      RRA_CSV = r"D:\Projects\SPARC\SPARC_Demo\smart-parcel-atlas\rra_extract.csv"
#
#  Leave it as "" to be prompted for the path instead.
# ============================================================================
RRA_CSV = ""

#  Optional. Leave as None and the script finds these columns itself, printing
#  which ones it picked. Fill them in only if it picks wrong.
RRA_UPI_COLUMN = None            # e.g. "UPI"  or  "Upi_Number"
RRA_DECLARED_USE_COLUMN = None   # e.g. "DeclaredUse"  or  "Property Use"

#  Where the four output CSVs land. Default: this repo's folder.
OUTPUT_DIR = ROOT

DEFAULT_BUILDINGS = os.path.join(ROOT, "Kigali_Buildings.geojson")
DEFAULT_CROSSWALK = os.path.join(ROOT, "tools", "rra_use_crosswalk.csv")

# Our taxonomy. Kept here rather than imported so the script stands alone in a
# notebook on someone else's machine.
USE_LABELS = {
    "RI": "Residential - Unplanned",
    "ROR": "Residential - Planned",
    "RAP": "Residential - Apartment",
    "CM": "Commercial",
    "CMI": "Mixed Use",
    "PI": "Public Institution",
    "I": "Industrial",
}

# Column names we will try if the registry's own are not given. Ordered by how
# unambiguous they are, so a file carrying both "upi" and "parcel_id" picks upi.
UPI_CANDIDATES = ["upi", "upi_no", "upinumber", "upi_number", "parcelupi",
                  "parcel_upi", "plot_upi", "parcel_id", "parcelid", "plot_no"]
USE_CANDIDATES = ["declared_use", "declaredus", "use", "land_use", "landuse",
                  "property_use", "propertyuse", "usage", "use_type", "usetype",
                  "activity", "business_type"]


# ============================================================================
# UPI normalisation
# ============================================================================
_SEP = re.compile(r"[\\/\-_.\s]+")


def normalise_upi(value) -> str:
    """
    Reduce a UPI to one canonical form so two systems can be compared.

    Rules, in order: coerce to text, strip, split on any run of separators,
    drop empty segments, strip leading zeros from each segment, rejoin on "/".

        "1/01/04/01/19"  -> "1/1/4/1/19"
        " 1-1-4-1-019 "  -> "1/1/4/1/19"
        "1/01/04/01/19 " -> "1/1/4/1/19"

    Stripping the padding rather than adding it is deliberate: we know our own
    padding convention but not theirs, and padding-to-a-guess would invent
    identifiers that match nothing. Removing it converges both sides on the
    only representation neither system had to choose.

    Returns "" for anything that does not survive — missing, blank, or a value
    Excel has turned into a float or a date. Those become join_quality=NO_UPI,
    never a silent non-match.
    """
    if value is None:
        return ""
    s = str(value).strip()
    if not s or s.lower() in {"nan", "none", "null", "na", "n/a", "-"}:
        return ""
    # Excel loves turning 1/01/04 into a date or a number. Both are unrecoverable
    # here; better to name them than to join on a corrupted key.
    if re.fullmatch(r"-?\d+(\.\d+)?", s) and "/" not in s:
        return ""
    parts = [p for p in _SEP.split(s) if p]
    if not parts:
        return ""
    out = []
    for p in parts:
        p = p.lstrip("0") or "0"
        out.append(p)
    return "/".join(out)


# ============================================================================
# Reading our building layer
# ============================================================================
def iter_features(path: str) -> Iterator[dict]:
    """
    Stream features out of a GeoJSON FeatureCollection without loading it.

    The Kigali export is ~578 MB and is written as one enormous line, so
    json.load would need several gigabytes of RAM and readline would not help.
    JSONDecoder.raw_decode scans and parses one object at a time in C, which is
    the difference between a minute and an afternoon — a hand-written brace
    counter in Python is roughly two orders of magnitude slower over a file this
    size, which is worth knowing before writing one.

    This is the same reader tools/prepare_data.py uses, repeated here rather
    than imported so the script stands alone in a notebook on another machine.
    """
    dec = json.JSONDecoder()
    with io.open(path, "r", encoding="utf-8") as f:
        buf = f.read(1 << 20)
        i = buf.find('"features"')
        if i < 0:
            raise SystemExit(f"no features array found in {path}")
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


def read_buildings(path: str, limit: int | None = None) -> pd.DataFrame:
    """Our side of the join: one row per structure, attributes only."""
    low = path.lower()
    ext = ".csv" if low.endswith((".csv", ".csv.gz")) else os.path.splitext(low)[1]
    if ext == ".csv":
        # pandas reads .gz transparently from the extension.
        df = pd.read_csv(path, dtype=str, nrows=limit)
        df.columns = [c.strip() for c in df.columns]
        missing = [c for c in ("upi_raw", "observed_use_code") if c not in df.columns]
        if missing:
            raise SystemExit(
                f"{os.path.basename(path)} is missing {missing}. A buildings CSV "
                "for this script should be the one written by --export-slim."
            )
    elif ext in (".geojson", ".json"):
        rows = []
        for i, feat in enumerate(iter_features(path)):
            if limit and i >= limit:
                break
            p = feat.get("properties") or {}
            rows.append({
                "objectid": p.get("OBJECTID"),
                "upi_raw": p.get("upi"),
                "observed_use_code": (p.get("Land Use Code") or "").strip(),
                "model_confidence": p.get("Model Confidence"),
                "footprint_sqm": p.get("Footprint Area (sqm)"),
                "floors": p.get("Estimated Floors"),
                "height_m": p.get("Building Height (m)"),
                "detected": p.get("Acquisition Year"),
                "ground_confirmed": p.get("Ground-Confirmed"),
                "zone": p.get("new_zoning"),
                "district": p.get("District"),
                "sector": p.get("Sector"),
                "cell": p.get("Cell"),
                "village": p.get("Village"),
            })
            if (i + 1) % 100000 == 0:
                print(f"  ...{i + 1:,} structures", flush=True)
        df = pd.DataFrame(rows)
    else:
        raise SystemExit(
            f"unsupported buildings file: {ext} (use .geojson, .csv or .csv.gz)")

    for c in ("model_confidence", "footprint_sqm", "height_m"):
        if c in df:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    df["upi_norm"] = df["upi_raw"].map(normalise_upi)
    df["observed_use_label"] = df["observed_use_code"].map(USE_LABELS).fillna(
        df["observed_use_code"])
    return df


# ============================================================================
# Reading the RRA extract
# ============================================================================
def _pick_column(cols, candidates, what, explicit=None):
    if explicit:
        if explicit not in cols:
            raise SystemExit(
                f"--{what}-col '{explicit}' is not in the registry file.\n"
                f"columns present: {', '.join(cols)}"
            )
        return explicit
    norm = {re.sub(r"[^a-z0-9]", "", c.lower()): c for c in cols}
    for cand in candidates:
        key = re.sub(r"[^a-z0-9]", "", cand)
        if key in norm:
            return norm[key]
    return None


def load_registry(path: str, upi_col=None, use_col=None) -> tuple[pd.DataFrame, str, str | None]:
    """
    The RRA side. Schema is unknown until the file arrives, so the columns are
    detected and the choice is printed — never guessed silently.
    """
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xlsm", ".xls"):
        reg = pd.read_excel(path, dtype=str)
    else:
        # sep=None + engine="python" sniffs comma vs semicolon vs tab, which is
        # the difference between a working join and 100% "No".
        reg = pd.read_csv(path, dtype=str, sep=None, engine="python",
                          keep_default_na=False)
    reg.columns = [str(c).strip() for c in reg.columns]

    ucol = _pick_column(list(reg.columns), UPI_CANDIDATES, "upi", upi_col)
    if not ucol:
        raise SystemExit(
            "could not find a UPI column in the registry file.\n"
            f"columns present: {', '.join(reg.columns)}\n"
            "pass it explicitly with --upi-col"
        )
    dcol = _pick_column(list(reg.columns), USE_CANDIDATES, "declared-use", use_col)

    print(f"  registry UPI column:          {ucol!r}")
    print(f"  registry declared-use column: {dcol!r}"
          + ("" if dcol else "   (none found — status_use cannot be scored)"))

    reg["upi_norm"] = reg[ucol].map(normalise_upi)
    reg["declared_use_raw"] = reg[dcol].astype(str).str.strip() if dcol else ""
    return reg, ucol, dcol


# ============================================================================
# The use crosswalk
# ============================================================================
STARTER_CROSSWALK = [
    # declared_value (as it appears in the RRA extract), sparc_use_code
    ("residential", "RI"),
    ("residential - owner occupied", "RI"),
    ("owner occupied", "RI"),
    ("dwelling", "RI"),
    ("house", "RI"),
    ("residential - rented", "RI"),
    ("rental", "RI"),
    ("planned residential", "ROR"),
    ("apartment", "RAP"),
    ("apartments", "RAP"),
    ("flat", "RAP"),
    ("commercial", "CM"),
    ("business", "CM"),
    ("shop", "CM"),
    ("retail", "CM"),
    ("office", "CM"),
    ("hotel", "CM"),
    ("mixed use", "CMI"),
    ("mixed", "CMI"),
    ("commercial and residential", "CMI"),
    ("industrial", "I"),
    ("factory", "I"),
    ("warehouse", "I"),
    ("workshop", "I"),
    ("public institution", "PI"),
    ("institutional", "PI"),
    ("school", "PI"),
    ("church", "PI"),
    ("health facility", "PI"),
    ("government", "PI"),
]


def ensure_crosswalk(path: str) -> None:
    if os.path.exists(path):
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["declared_value", "sparc_use_code"])
        for a, b in STARTER_CROSSWALK:
            w.writerow([a, b])
    print(f"  wrote a starter crosswalk: {path}")
    print("  EXTEND IT once the real declared values are known — see "
          "unmapped_declared_uses.csv after the first run.")


def load_crosswalk(path: str) -> dict:
    """
    Declared value -> our use code. Matched case-insensitively on a squeezed
    string, so "Mixed  Use" and "mixed use" are the same key.
    """
    ensure_crosswalk(path)
    m = {}
    with io.open(path, "r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            k = re.sub(r"\s+", " ", (row.get("declared_value") or "").strip().lower())
            v = (row.get("sparc_use_code") or "").strip().upper()
            if k and v:
                if v not in USE_LABELS:
                    print(f"  WARNING: crosswalk maps {k!r} to {v!r}, which is not "
                          f"one of {', '.join(USE_LABELS)} — the row is ignored")
                    continue
                m[k] = v
    return m


def _cw_key(s) -> str:
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


# ============================================================================
# The join
# ============================================================================
@dataclass
class Result:
    buildings: pd.DataFrame
    parcels: pd.DataFrame
    by_area: pd.DataFrame
    unmapped: pd.DataFrame
    notes: dict


def join(buildings: pd.DataFrame, registry: pd.DataFrame, crosswalk: dict,
         declared_col_present: bool, min_confidence: float = 0.0,
         strict: bool = False) -> Result:
    """
    Left-join our structures onto the registry and score the two flags.

    Left, not inner, on purpose: the rows that do NOT match are the point. An
    inner join would throw away exactly the structures that widen the base.
    """
    # The registry is per-parcel. If it carries several rows for one UPI (a
    # parcel with several taxpayers or several years), collapse to one row so
    # the join cannot multiply our building count — a silent row explosion is
    # the classic way a join like this produces confident nonsense.
    dupes = int(registry["upi_norm"].duplicated().sum())
    reg = registry.drop_duplicates(subset="upi_norm", keep="first")
    reg_slim = reg.loc[reg["upi_norm"] != "", ["upi_norm", "declared_use_raw"]].copy()
    reg_slim["in_registry"] = True

    df = buildings.merge(reg_slim, on="upi_norm", how="left")
    # astype(bool) is not cosmetic: fillna on a merged indicator leaves object
    # dtype, and "~" on an object column is bitwise-not on integers, which
    # silently produces -1/-2 instead of a mask.
    df["in_registry"] = df["in_registry"].fillna(False).astype(bool)

    # ---- flag 1: status_in_registry ---------------------------------------
    df["status_in_registry"] = df["in_registry"].map({True: "Yes", False: "No"})
    df["join_quality"] = "MATCHED"
    df.loc[~df["in_registry"], "join_quality"] = "NOT_IN_REGISTRY"
    df.loc[df["upi_norm"] == "", "join_quality"] = "NO_UPI"
    df.loc[df["upi_norm"] == "", "status_in_registry"] = "No"

    # ---- flag 2: status_use ------------------------------------------------
    df["declared_use_raw"] = df["declared_use_raw"].fillna("")
    df["declared_use_code"] = df["declared_use_raw"].map(
        lambda s: crosswalk.get(_cw_key(s), ""))
    df["declared_use_label"] = df["declared_use_code"].map(USE_LABELS).fillna("")

    conf = df["model_confidence"].fillna(0.0)
    comparable = (
        df["in_registry"]
        & (df["declared_use_code"] != "")
        & (df["observed_use_code"] != "")
        & (conf >= min_confidence)
    )
    df["use_comparable"] = comparable.map({True: "Yes", False: "No"})
    df["use_check"] = "compared"
    df.loc[~df["in_registry"], "use_check"] = "not in registry"
    df.loc[df["in_registry"] & (df["declared_use_raw"] == ""), "use_check"] = "no declared use"
    df.loc[df["in_registry"] & (df["declared_use_raw"] != "") & (df["declared_use_code"] == ""),
           "use_check"] = "declared use not in crosswalk"
    df.loc[comparable & (conf < min_confidence), "use_check"] = "below confidence threshold"
    if not declared_col_present:
        df["use_check"] = "registry carries no declared-use column"

    match = comparable & (df["declared_use_code"] == df["observed_use_code"])
    # Blank, not "No", where the question could not be asked. "No" in this
    # column has to mean "declared and observed disagree" or the count of "No"
    # is worthless to an assessor.
    df["status_use"] = ""
    df.loc[comparable & match, "status_use"] = "Yes"
    df.loc[comparable & ~match, "status_use"] = "No"
    if strict:
        df.loc[df["status_use"] == "", "status_use"] = "No"

    # ---- parcel level ------------------------------------------------------
    parcels = _rollup(df, crosswalk)

    # ---- what the crosswalk missed ----------------------------------------
    miss = df.loc[df["use_check"] == "declared use not in crosswalk", "declared_use_raw"]
    unmapped = (miss.value_counts().rename_axis("declared_value")
                .reset_index(name="structures")
                if len(miss) else
                pd.DataFrame(columns=["declared_value", "structures"]))

    by_area = _by_area(parcels)

    notes = {
        "structures": len(df),
        "parcels": len(parcels),
        "registry_rows": len(registry),
        "registry_duplicate_upis": dupes,
        "structures_no_upi": int((df["join_quality"] == "NO_UPI").sum()),
        "structures_matched": int((df["join_quality"] == "MATCHED").sum()),
        "structures_not_in_registry": int((df["join_quality"] == "NOT_IN_REGISTRY").sum()),
    }
    return Result(df, parcels, by_area, unmapped, notes)


def _rollup(df: pd.DataFrame, crosswalk: dict) -> pd.DataFrame:
    """
    One row per parcel — the unit the registry is actually about.

    observed_use_dominant is weighted by footprint area, not by count: a 200 m2
    shop beside a 12 m2 store is what the parcel is, and counting structures
    would say the opposite.

    Written with plain groupby aggregations rather than groupby().apply().

    Two reasons, and the second is the one that matters when this runs on
    someone else's machine: a Python callable over 262,915 groups takes minutes
    where the vectorised form takes seconds, and apply()'s include_groups
    argument only exists in pandas 2.2 and later. A government workstation may
    be running pandas 1.x, and a TypeError on an unfamiliar keyword is a bad
    thing to be debugging in someone else's office.
    """
    d = df[df["upi_norm"] != ""].copy()
    if d.empty:
        return pd.DataFrame()
    d["footprint_sqm"] = d["footprint_sqm"].fillna(0.0)

    g = d.groupby("upi_norm", sort=False)
    out = g.agg(
        # The UPI exactly as our layer spells it. The index is the NORMALISED
        # form, which is what the join needed; rejoining later in ArcGIS or
        # Excel has to happen on the original string or it matches nothing and
        # says so with a silent zero.
        upi_original=("upi_raw", "first"),
        district=("district", "first"),
        sector=("sector", "first"),
        cell=("cell", "first"),
        village=("village", "first"),
        n_buildings=("upi_norm", "size"),
        total_footprint_sqm=("footprint_sqm", "sum"),
        status_in_registry=("status_in_registry", "first"),
        join_quality=("join_quality", "first"),
        declared_use_raw=("declared_use_raw", "first"),
        declared_use_code=("declared_use_code", "first"),
        max_confidence=("model_confidence", "max"),
    )
    out["total_footprint_sqm"] = out["total_footprint_sqm"].round(1)
    out["max_confidence"] = out["max_confidence"].fillna(0).round(3)

    # Dominant observed use, weighted by footprint area rather than by count:
    # a 200 m2 shop beside a 12 m2 store is what the parcel is, and counting
    # structures would say the opposite.
    area = (d[d["observed_use_code"] != ""]
            .groupby(["upi_norm", "observed_use_code"])["footprint_sqm"].sum()
            .reset_index()
            .sort_values(["upi_norm", "footprint_sqm"], ascending=[True, False])
            .drop_duplicates("upi_norm")
            .set_index("upi_norm")["observed_use_code"])
    out["observed_use_dominant"] = out.index.map(area).fillna("")

    # The full set of classes standing on the parcel, as a sorted pipe list.
    mix = (d.loc[d["observed_use_code"] != "", ["upi_norm", "observed_use_code"]]
           .drop_duplicates()
           .sort_values(["upi_norm", "observed_use_code"])
           .groupby("upi_norm")["observed_use_code"]
           .agg("|".join))
    out["observed_use_mix"] = out.index.map(mix).fillna("")

    new25 = d.assign(_n=(d["detected"].astype(str) == "2025")).groupby("upi_norm")["_n"].any()
    out["new_since_2023"] = out.index.map(new25).fillna(False).map({True: "Yes", False: "No"})

    codes = out["observed_use_mix"].str.split("|")
    declared = out["declared_use_code"]
    comparable = declared.ne("") & out["observed_use_mix"].ne("")
    # The fair test at parcel level: does anything here match what was declared?
    # A house on a parcel declared residential is not a mismatch because there
    # is also a shop behind it.
    matches = pd.Series(
        [bool(c) and (dd in c) for dd, c in zip(declared, codes.fillna("").apply(
            lambda v: v if isinstance(v, list) else []))],
        index=out.index)
    out["status_use"] = ""
    out.loc[comparable & matches, "status_use"] = "Yes"
    out.loc[comparable & ~matches, "status_use"] = "No"

    # The signal worth chasing: something is standing that the declaration does
    # not account for.
    extra = pd.Series(
        [sorted(set(c) - {dd}) if c else [] for dd, c in zip(declared, codes.fillna("").apply(
            lambda v: v if isinstance(v, list) else []))],
        index=out.index)
    has_extra = extra.map(bool)
    out["has_undeclared_use_class"] = ""
    out.loc[comparable & has_extra, "has_undeclared_use_class"] = "Yes"
    out.loc[comparable & ~has_extra, "has_undeclared_use_class"] = "No"
    out["undeclared_classes"] = [
        "|".join(e) if cmp else "" for e, cmp in zip(extra, comparable)]

    cols = ["upi_original", "district", "sector", "cell", "village", "n_buildings",
            "total_footprint_sqm", "status_in_registry", "join_quality",
            "declared_use_raw", "declared_use_code", "observed_use_dominant",
            "observed_use_mix", "status_use", "has_undeclared_use_class",
            "undeclared_classes", "max_confidence", "new_since_2023"]
    return out[cols].reset_index().rename(columns={"upi_norm": "upi"})


def _by_area(parcels: pd.DataFrame) -> pd.DataFrame:
    """The numbers an assessor is handed: per district and sector."""
    if parcels.empty:
        return pd.DataFrame()
    g = parcels.groupby(["district", "sector"], dropna=False)
    out = pd.DataFrame({
        "parcels": g.size(),
        "buildings": g["n_buildings"].sum(),
        "in_registry": g["status_in_registry"].apply(lambda s: (s == "Yes").sum()),
        "not_in_registry": g["status_in_registry"].apply(lambda s: (s == "No").sum()),
        "use_matches": g["status_use"].apply(lambda s: (s == "Yes").sum()),
        "use_mismatches": g["status_use"].apply(lambda s: (s == "No").sum()),
        "use_not_checked": g["status_use"].apply(lambda s: (s == "").sum()),
        "undeclared_use_present": g["has_undeclared_use_class"].apply(
            lambda s: (s == "Yes").sum()),
    }).reset_index()
    out["pct_not_in_registry"] = (
        out["not_in_registry"] / out["parcels"] * 100).round(1)
    return out.sort_values("not_in_registry", ascending=False)


# ============================================================================
# Taking this to their machine — and bringing the answer back
# ============================================================================
#
# Columns that may never leave RRA premises in the carry-back file. The point of
# running on their machine is that their register stays there; a findings file
# that quietly carries declared use, a taxpayer id or a registration date has
# undone that, and nobody will notice until it matters.
FINDINGS_COLUMNS = [
    "upi_original",              # our spelling of the UPI — the rejoin key
    "upi",                       # the normalised form, for reference
    "district", "sector", "cell", "village",
    "n_buildings",
    "status_in_registry",
    "status_use",
    "has_undeclared_use_class",
    "join_quality",
]


def export_findings(parcels: pd.DataFrame, out_path: str) -> pd.DataFrame:
    """
    The minimum that has to travel back: flags, not their data.

    Everything derived FROM the registry that is not a flag — declared_use_raw,
    and anything else their extract carried — is dropped here. What comes out is
    a verdict per parcel, which is ours, keyed on a UPI, which is public. That
    is a file you can defend carrying.

    Rejoin it to the building layer on upi_original.
    """
    have = [c for c in FINDINGS_COLUMNS if c in parcels.columns]
    out = parcels[have].copy()
    out.to_csv(out_path, index=False, encoding="utf-8-sig")
    print(f"  {os.path.basename(out_path)}: {len(out):,} parcels, "
          f"{len(have)} columns — no registry content, safe to carry")
    return out



def export_slim(buildings_path: str, out_path: str) -> None:
    """
    Write the join-relevant building attributes as a compressed CSV.

    Run this HERE, once, before travelling. The GeoJSON is ~578 MB of mostly
    geometry, and this join needs none of it; the slim table is roughly twenty
    times smaller, fits on anything, and loads in seconds instead of a minute.
    Copy the .csv.gz and this script to their machine and point --buildings at
    it. Nothing else changes.
    """
    if not out_path.endswith(".gz"):
        out_path += ".gz"
    print(f"reading {os.path.basename(buildings_path)} ...")
    df = read_buildings(buildings_path)
    keep = ["objectid", "upi_raw", "observed_use_code", "model_confidence",
            "footprint_sqm", "floors", "height_m", "detected", "ground_confirmed",
            "zone", "district", "sector", "cell", "village"]
    df[keep].to_csv(out_path, index=False, compression="gzip", encoding="utf-8")
    mb = os.path.getsize(out_path) / 1e6
    src = os.path.getsize(buildings_path) / 1e6
    print(f"wrote {out_path}: {len(df):,} structures, {mb:.1f} MB "
          f"(from {src:.0f} MB — {src/max(mb,0.1):.0f}x smaller)")
    print("Copy that file and rra_join.py to their machine, then run:")
    print(f"  python rra_join.py --buildings {os.path.basename(out_path)} "
          "--registry <their_extract.csv>")


def preflight(registry: str, buildings: str, crosswalk: str,
              upi_col=None, use_col=None) -> int:
    """
    Check the environment and both inputs in seconds, without reading the
    building layer.

    This exists because the expensive failure is not a wrong answer, it is
    discovering on site that pandas is missing or that their UPI column is
    called something unexpected, after a five-minute read has already run. Do
    this first, every time, on their machine.
    """
    ok = True
    print("=" * 66)
    print("  PREFLIGHT")
    print(f"    python            {sys.version.split()[0]}")
    if sys.version_info < (3, 8):
        print("      ^ too old — this needs 3.8 or later"); ok = False
    print(f"    pandas            {pd.__version__}")

    print(f"    buildings         {buildings}")
    if not os.path.exists(buildings):
        print("      ^ NOT FOUND. Use --export-slim on the source machine and "
              "copy the .csv.gz across."); ok = False
    else:
        print(f"                      {os.path.getsize(buildings)/1e6:,.0f} MB")

    print(f"    registry          {registry}")
    if not os.path.exists(registry):
        print("      ^ NOT FOUND"); ok = False
    else:
        try:
            reg, ucol, dcol = load_registry(registry, upi_col, use_col)
        except SystemExit as e:
            print(f"      ^ {e}"); return 1
        n = len(reg)
        blank = int((reg["upi_norm"] == "").sum())
        dup = int(reg["upi_norm"].duplicated().sum())
        changed = int((reg[ucol].astype(str).str.strip() != reg["upi_norm"]).sum())
        print(f"                      {n:,} rows")
        print(f"    upi unusable      {blank:,}  ({blank/max(1,n):.0%})"
              + ("   <- check the column and the export format" if blank > n * 0.05 else ""))
        print(f"    duplicate upis    {dup:,}"
              + ("   <- one row per parcel is assumed; extras are dropped" if dup else ""))
        print(f"    upis normalised   {changed:,}  ({changed/max(1,n):.0%})")
        if dcol:
            cw = load_crosswalk(crosswalk)
            vals = reg["declared_use_raw"].map(_cw_key)
            unknown = sorted(set(v for v in vals if v and v not in cw))
            known = int(sum(1 for v in vals if v in cw))
            print(f"    declared use      {known:,} of {n:,} values map to a SPARC code")
            if unknown:
                print(f"    NOT in crosswalk  {len(unknown)} distinct value(s):")
                for v in unknown[:10]:
                    print(f"                        {v[:52]}")
                if len(unknown) > 10:
                    print(f"                        ... and {len(unknown)-10} more")
                print("      -> add them to tools/rra_use_crosswalk.csv before the real run,")
                print("         or status_use stays blank for those rows (never a false 'No')")
        else:
            print("    declared use      no column found — status_use cannot be scored")
    print("=" * 66)
    print("  READY" if ok else "  NOT READY — fix the items marked ^ above")
    return 0 if ok else 1


# ============================================================================
# Fixture — so the pipeline can be exercised before RRA delivers
# ============================================================================
def make_fixture(buildings_path: str, out_path: str, seed: int = 7,
                 coverage: float = 0.72, wrong_use: float = 0.18) -> None:
    """
    Build a synthetic registry from our own UPIs.

    It deliberately does three awkward things the real file will also do: it
    covers only part of the city, it spells the UPI without zero padding, and it
    writes declared use as free text rather than our codes. A pipeline that only
    works on a tidy fixture has not been tested.
    """
    rng = random.Random(seed)
    seen: dict[str, str] = {}
    print(f"reading {os.path.basename(buildings_path)} for UPIs ...")
    for i, feat in enumerate(iter_features(buildings_path)):
        p = feat.get("properties") or {}
        u = normalise_upi(p.get("upi"))
        if u and u not in seen:
            seen[u] = (p.get("Land Use Code") or "").strip()
        if (i + 1) % 200000 == 0:
            print(f"  ...{i + 1:,}", flush=True)

    label_for = {
        "RI": ["Residential", "Residential - Owner Occupied", "Dwelling"],
        "ROR": ["Residential", "Planned Residential"],
        "RAP": ["Apartment", "Apartments"],
        "CM": ["Commercial", "Business", "Shop"],
        "CMI": ["Mixed Use", "Commercial and Residential"],
        "PI": ["Public Institution", "School", "Church"],
        "I": ["Industrial", "Warehouse"],
    }
    codes = list(label_for)
    rows = []
    for upi, code in seen.items():
        if rng.random() > coverage:
            continue
        pick = code if code in label_for else rng.choice(codes)
        if rng.random() < wrong_use:
            pick = rng.choice([c for c in codes if c != pick])
        rows.append({
            "UPI": upi,                       # unpadded, unlike ours
            "TaxpayerID": f"TP{rng.randrange(10**6, 10**7)}",
            "DeclaredUse": rng.choice(label_for[pick]),
            "RegisteredOn": f"20{rng.randrange(15, 26):02d}-{rng.randrange(1,13):02d}-01",
        })
    pd.DataFrame(rows).to_csv(out_path, index=False)
    print(f"wrote {out_path}: {len(rows):,} registry rows over "
          f"{len(seen):,} distinct UPIs ({len(rows)/max(1,len(seen)):.0%} coverage)")


# ============================================================================
# Entry points
# ============================================================================
def run(registry: str, buildings: str = DEFAULT_BUILDINGS,
        crosswalk: str = DEFAULT_CROSSWALK, out_dir: str = ROOT,
        upi_col: str | None = None, use_col: str | None = None,
        min_confidence: float = 0.0, strict: bool = False,
        limit: int | None = None, write: bool = True) -> Result:
    """Notebook-friendly entry point. Returns the Result; also writes the CSVs."""
    print(f"reading buildings: {buildings}")
    b = read_buildings(buildings, limit=limit)
    print(f"  {len(b):,} structures, {b['upi_norm'].ne('').sum():,} with a UPI, "
          f"{b.loc[b['upi_norm'].ne(''), 'upi_norm'].nunique():,} distinct parcels")

    print(f"reading registry: {registry}")
    reg, ucol, dcol = load_registry(registry, upi_col, use_col)
    changed = int((reg[ucol].astype(str).str.strip() != reg["upi_norm"]).sum())
    print(f"  {len(reg):,} rows; {changed:,} UPIs changed under normalisation "
          f"({changed/max(1,len(reg)):.0%})")

    cw = load_crosswalk(crosswalk)
    print(f"  crosswalk: {len(cw)} declared values mapped")

    print("joining ...")
    res = join(b, reg, cw, declared_col_present=bool(dcol),
               min_confidence=min_confidence, strict=strict)

    _report(res)

    if write:
        os.makedirs(out_dir, exist_ok=True)
        paths = {
            "buildings_rra_join.csv": res.buildings.drop(columns=["in_registry"]),
            "parcels_rra_join.csv": res.parcels,
            "summary_by_area.csv": res.by_area,
            "unmapped_declared_uses.csv": res.unmapped,
        }
        print("writing ...")
        for name, frame in paths.items():
            fp = os.path.join(out_dir, name)
            frame.to_csv(fp, index=False, encoding="utf-8-sig")
            print(f"  {name}: {len(frame):,} rows")
        if not res.parcels.empty:
            export_findings(res.parcels,
                            os.path.join(out_dir, "findings_to_carry_back.csv"))
            print("")
            print("  Leave the other three files on this machine. Only")
            print("  findings_to_carry_back.csv is meant to travel.")
    return res


def _report(res: Result) -> None:
    n = res.notes
    b, p = res.buildings, res.parcels
    pct = lambda a, t: f"{a/max(1,t)*100:5.1f}%"
    print("")
    print("=" * 66)
    print("  STRUCTURES")
    print(f"    total                      {n['structures']:>9,}")
    print(f"    matched to registry        {n['structures_matched']:>9,}  "
          f"{pct(n['structures_matched'], n['structures'])}")
    print(f"    UPI not in registry        {n['structures_not_in_registry']:>9,}  "
          f"{pct(n['structures_not_in_registry'], n['structures'])}")
    print(f"    no UPI on our side         {n['structures_no_upi']:>9,}  "
          f"{pct(n['structures_no_upi'], n['structures'])}   <- data quality, not a lead")
    if n["registry_duplicate_upis"]:
        print(f"    registry rows dropped as duplicate UPIs  "
              f"{n['registry_duplicate_upis']:,}")
    if not p.empty:
        tot = len(p)
        nin = int((p["status_in_registry"] == "No").sum())
        um = int((p["status_use"] == "No").sum())
        uy = int((p["status_use"] == "Yes").sum())
        un = int((p["status_use"] == "").sum())
        ud = int((p["has_undeclared_use_class"] == "Yes").sum())
        print("  PARCELS  (the unit to work from)")
        print(f"    total                      {tot:>9,}")
        print(f"    not in registry            {nin:>9,}  {pct(nin, tot)}"
              "   <- base-widening candidates")
        print(f"    declared use matches       {uy:>9,}  {pct(uy, tot)}")
        print(f"    declared use differs       {um:>9,}  {pct(um, tot)}")
        print(f"    could not be checked       {un:>9,}  {pct(un, tot)}")
        print(f"    undeclared use class on parcel {ud:>5,}  {pct(ud, tot)}"
              "   <- strongest lead")
    if len(res.unmapped):
        print("  CROSSWALK GAPS  (top declared values not mapped)")
        for _, r in res.unmapped.head(8).iterrows():
            print(f"    {str(r['declared_value'])[:44]:<44} {r['structures']:>8,}")
        print("    -> extend tools/rra_use_crosswalk.csv and re-run")
    print("=" * 66)
    print("")
    print("  Read 'No' in status_in_registry together with join_quality:")
    print("  NOT_IN_REGISTRY is a lead, NO_UPI is a data-quality task.")
    print("")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Join the RRA registry extract to the SPARC building layer on UPI.")
    ap.add_argument("--registry", help="RRA extract (.csv or .xlsx)")
    ap.add_argument("--buildings", default=DEFAULT_BUILDINGS,
                    help="our building layer (.geojson or .csv)")
    ap.add_argument("--crosswalk", default=DEFAULT_CROSSWALK)
    ap.add_argument("--out-dir", default=ROOT)
    ap.add_argument("--upi-col", help="registry column holding the UPI")
    ap.add_argument("--use-col", help="registry column holding the declared use")
    ap.add_argument("--min-confidence", type=float, default=0.0,
                    help="skip the use comparison below this model confidence")
    ap.add_argument("--strict", action="store_true",
                    help='force every non-Yes status_use to "No" (loses the '
                         '"could not check" state — not recommended)')
    ap.add_argument("--limit", type=int, help="read only N structures (a quick test)")
    ap.add_argument("--make-fixture", metavar="OUT.CSV",
                    help="generate a synthetic registry from our own UPIs and exit")
    ap.add_argument("--export-slim", metavar="OUT.CSV.GZ",
                    help="write the portable building table and exit — run this "
                         "before taking the script to another machine")
    ap.add_argument("--check", action="store_true",
                    help="validate the environment and both inputs in seconds, "
                         "without reading the building layer. Run this first.")
    a = ap.parse_args(argv)

    if a.export_slim:
        export_slim(a.buildings, a.export_slim)
        return 0
    if a.make_fixture:
        make_fixture(a.buildings, a.make_fixture)
        return 0
    if a.check:
        return preflight(a.registry or RRA_CSV, a.buildings, a.crosswalk,
                         a.upi_col or RRA_UPI_COLUMN,
                         a.use_col or RRA_DECLARED_USE_COLUMN)

    # The RRA_CSV slot at the top of this file is the notebook path; the
    # --registry flag is the terminal one. Either is fine, and the flag wins.
    registry = a.registry or RRA_CSV
    if not registry:
        registry = input("path to the RRA csv: ").strip().strip('"')
    if not registry:
        ap.error("no RRA file given — set RRA_CSV at the top of this script, "
                 "or pass --registry")
    if not os.path.exists(registry):
        ap.error(f"RRA file not found: {registry}")

    run(registry=registry, buildings=a.buildings, crosswalk=a.crosswalk,
        out_dir=a.out_dir or OUTPUT_DIR,
        upi_col=a.upi_col or RRA_UPI_COLUMN,
        use_col=a.use_col or RRA_DECLARED_USE_COLUMN,
        min_confidence=a.min_confidence, strict=a.strict, limit=a.limit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
