"""
Calibration for tools/rental_flags.py: how many parcels does each threshold flag?

The 25 m2 floor came from a generic specification, not from Rwandan housing.
A Kigali compound commonly carries a detached kitchen, a store and a latrine,
and those are exempt domestic structures however habitable-looking they are from
above. Where the annex floor sits therefore decides almost everything about the
size of the caseload, and it is a decision for RRA rather than for this script.

This prints the distribution so the threshold can be argued from evidence.

Run:  python tools/rental_calibrate.py
"""

from __future__ import annotations

import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rental_flags import (  # noqa: E402
    BUILDINGS, MIN_ANNEX_CONFIDENCE, RESIDENTIAL_USES, aggregate_buildings,
)


def main() -> int:
    w = sys.stderr
    agg = aggregate_buildings(BUILDINGS)

    per_parcel = Counter()
    annex_sizes: list[float] = []
    annex_heights: list[float] = []
    for rec in agg.values():
        st = sorted(rec["structures"], key=lambda s: -s[0])
        per_parcel[min(len(st), 10)] += 1
        if len(st) < 2 or st[0][3] not in RESIDENTIAL_USES:
            continue
        a = st[1]
        if a[4] < MIN_ANNEX_CONFIDENCE:
            continue
        annex_sizes.append(a[0])
        annex_heights.append(a[1])

    print("\nStructures per built parcel:", file=w)
    tot = sum(per_parcel.values())
    for k in sorted(per_parcel):
        lbl = f"{k}" if k < 10 else "10+"
        print(f"  {lbl:>3}  {per_parcel[k]:>9,}  {per_parcel[k] / tot * 100:5.1f}%", file=w)

    annex_sizes.sort()
    n = len(annex_sizes)
    print(f"\nSecond-largest structure on a residential parcel: {n:,} parcels", file=w)
    for q in (10, 25, 50, 75, 90, 95, 99):
        print(f"  p{q:<3} {annex_sizes[int(n * q / 100)]:>8.1f} m2", file=w)

    print("\nParcels remaining as the annex floor moves:", file=w)
    print(f"  {'floor':>6}  {'annex >= floor':>15}  {'share of built':>15}", file=w)
    built = len(agg)
    for floor in (20, 25, 30, 35, 40, 50, 60, 75):
        k = sum(1 for a in annex_sizes if a >= floor)
        print(f"  {floor:>4} m2  {k:>15,}  {k / built * 100:>14.1f}%", file=w)

    annex_heights.sort()
    m = len(annex_heights)
    print("\nHeight of that structure:", file=w)
    for q in (10, 25, 50, 75, 90):
        print(f"  p{q:<3} {annex_heights[int(m * q / 100)]:>6.1f} m", file=w)
    low = sum(1 for h in annex_heights if h < 2.4)
    print(f"  under 2.4 m: {low:,} ({low / m * 100:.1f}%) — screened out as non-habitable", file=w)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
