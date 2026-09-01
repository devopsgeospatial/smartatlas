# Smart Parcel Atlas

One building record — footprint, predicted use, height, floor count, parcel UPI,
master-plan zone — read by each institution through its own lens: **Atlas**,
**Revenue**, **Compliance**.

Built on the SPARC enriched building layer. The layer is **not** queried at
runtime: the exports are compacted ahead of time into a few static files the
browser opens in one round trip. The app is therefore a pure static bundle with
no backend and no service dependency beyond basemap tiles.

Separate application from `kigali-building-use`, which is unchanged.

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # typecheck + production bundle into dist/
npm run data         # regenerate public/data from the source exports (Python)
npm run check:data   # verify the prepared data decodes and agrees with itself
npm run check:search # smoke-test the search parser
```

## The data pipeline

`tools/prepare_data.py` turns two large exports into four small files:

| Input (not in the repo — hundreds of MB) | |
| --- | --- |
| `Kigali_Buildings.geojson` | building polygons with predicted use, height, floors, zone |
| `tax.dbf` | parcel tax table: UPI, zone, designated-for-construction, vacancy |

| Output — `public/data/` | | |
| --- | ---: | --- |
| `stats.json` | 9 KB | every aggregate the panels need, in one request |
| `buildings.bin` | 11 MB | one record per structure: centroid + attributes, packed typed arrays |
| `geometry.bin` | 14 MB | footprint outlines, Int16 deltas from each centroid |
| `upis.txt` | 10 MB | parcel identifiers, newline-delimited, index-aligned with `buildings.bin` |

655,012 structures across 36 sectors and 29 master-plan zones. Both binaries
carry a magic header (`SPAB1`, `SPAG1`) and a record count; `npm run check:data`
decodes them exactly the way the browser does and asserts the decoded arrays
agree with `stats.json` — counts per use, per year, per zone, ring integrity,
and that every centroid lands inside Kigali. Run it after every regeneration.

The source exports are gitignored. To rebuild, drop them in the project root and
run `npm run data`.

## Search — one box, no mode selector

Paste whatever you have. The box works out what it is and **says what it
understood before you commit**, so a misread costs a glance rather than a wasted
navigation. Press <kbd>/</kbd> anywhere to focus it.

| Input | Example |
| --- | --- |
| Decimal degrees | `-1.9441, 30.0619` |
| Reversed pair | `30.0619, -1.9441` → order corrected automatically |
| Hemisphere suffixes | `1.9441S, 30.0619E` |
| Degrees / minutes / seconds | `1°56'38.8"S 30°03'42.8"E` |
| Google Maps link | `https://www.google.com/maps/@-1.9441,30.0619,17z` |
| Parcel identifier | `1/03/07/02/1234` |
| Sector name | `reme` → Remera, Gasabo |

Order correction uses Rwanda's own extent — latitude `[-2.95, -1.02]`, longitude
`[28.8, 30.95]` — so a reversed pair is unambiguous and is fixed with the
correction stated in the dropdown.

**Copying coordinates out:** right-click any structure on the map, or use Copy in
the dossier. Both write `lat, lon` — the format this box, Google Maps and ArcGIS
all expect on paste.

## Filters and statistics are the same control

Each row in the left rail is both a filter and a bar chart: the bar is the
statistic, the row is the toggle. Counts are precomputed over the whole city, so
they describe the entire selection rather than whatever happens to be on screen.

Selecting a sector both filters and flies the map to that sector's extent.

Building use labels, order and colours are carried over unchanged from the
original app so the two products read as one family.

## Lens indicators

The right panel shows the selected structure's dossier, or — when nothing is
selected — the indicators for the active lens.

### Atlas

Structure count, count new since 2023, vacant taxable parcels, field-verified
count; composition by use and by district.

### Compliance

Composition against the Kigali master plan: how many structures stand in each of
the 29 zones in use, with the zone's full description under its code, plus the
same structures broken down by use.

Structures whose parcel carried no master-plan zone appear as their own **No
zone** row, so the bars sum to the headline count rather than falling silently
short of it.

### Revenue

**Vacant taxable parcels** — 120,293 parcels, 7,767 ha, broken down by district,
by zone and by sector. This is real arithmetic on `tax.dbf`.

Two tiles read **Pending data** rather than showing a number, and say why:

- **Not declared** — the RRA tax register is not yet joined.
- **Use differs from declared** — declared use is empty on all records.

The product states the gap instead of filling it. Nothing in this build is
simulated; where a join is missing, the surface says so.

## Export and reports

- **Structures — CSV** · rows in view: `upi`, `sector`, `longitude`, `latitude`,
  `use_code`, `use`, `confidence`, `height_m`, `floors`, `footprint_m2`,
  `year_detected`, `zone`.
- **Structures — GeoJSON** · the same, with geometry, for GIS.
- **Lens report** · a printable standalone page carrying its own provenance note
  and a plain statement of what is measured and what is still missing. Opens in
  a new tab with a Print / Save-as-PDF button; falls back to a download if
  popups are blocked.

## The whole view lives in the URL

Lens, every filter, camera position and current selection are written to the URL
hash. A reload keeps your place, the back button undoes a filter, and a demo can
be handed over as a link that opens on exactly the screen you were describing.

```
#lens=compliance&at=-1.95400,30.09300,16.5&use=CM,I&sector=Remera&sel=12345
```

## Design system

Implements **Ubutaka** — `src/design/tokens.css`. Three token tiers, dark-first
because the product's ground is satellite imagery. Left rail and right panel are
deliberately the same width (300px). The map is specified in six visual planes:
imagery desaturated 25% so it recedes, boundaries hairline, structures at 88%
alpha with a dark stroke, change ring, labels always topmost with a halo, and
pure white reserved absolutely for selection.

Below zoom 14 the map shows boundaries and citywide statistics only; individual
structures appear above it, with the count in view stated bottom-left.

The land-use palette is the original brand palette. Note for later: two pairs in
it are hard to separate — the residential greens, and public institution against
industrial under deuteranopia. The dossier and legend always pair colour with a
text label, which is what keeps that safe.

## Layout

```
src/
  design/tokens.css       Every design token, three tiers, both themes
  styles.css              Application styles — token references only
  config.ts               Map tunables
  constants.ts            Use labels, brand colours, display order
  sectors.ts              Sector list, districts, bboxes
  types.ts                Shared types
  lib/
    search.ts             Coordinate / UPI / sector interpretation
    filters.ts            Filter state → predicate over the packed arrays
    exportData.ts         CSV, GeoJSON, printable report
    urlState.ts           View state ⇄ URL hash
    clipboard.ts          Clipboard write that survives an iframe
  services/dataset.ts     Loads and decodes public/data; queries and statistics
  components/
    SearchBox.tsx         One box, interpretation shown before commit
    FilterRail.tsx        Filters and composition statistics in one control
    MapView.tsx           MapLibre, six visual planes, viewport loading
    Dossier.tsx           Selected structure — critical facts first
    LensPanel.tsx         Atlas / Revenue / Compliance indicators
    Bars.tsx              Ranked horizontal bars
    ExportMenu.tsx        CSV, GeoJSON, report
  App.tsx                 State, composition, URL sync
tools/
  prepare_data.py         Source exports → public/data
  check-dataset.mjs       Verifies the prepared data
  check-search.ts         Search parser smoke test
```

## Known gaps

- **No parcel geometry.** `tax.dbf` arrived without its `.shp`/`.shx`, so vacant
  parcels exist only as counts and areas. They cannot be drawn on the map or
  clicked until the polygons are supplied.
- **Tax register not joined** — declared use is empty on all records, so no
  declared-versus-observed comparison is possible yet.
- **Permit register not joined** at all.
- **Case queues and the decision ledger** are not built. The ledger is the only
  part that needs a backend.
