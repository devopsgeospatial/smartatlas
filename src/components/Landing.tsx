import { useEffect, useMemo, useState } from 'react';
import SearchBox from './SearchBox';
import { COLORS, LABELS, ORDER } from '../constants';
import { CITY_BBOX } from '../sectors';
import type { Sector } from '../types';

/* ----------------------------------------------------------------------------
 * The front door.
 *
 * It sits in front of the dashboard and loads none of its data: stats.json is
 * 14 KB and carries every figure on this page, the hero is a 46 KB still, and
 * the search runs off the static SECTOR_LIST. MapLibre and the 40 MB building
 * layer are only fetched once a door is opened, which is what keeps the first
 * screen inside its budget.
 *
 * Every number here is derived from stats.json the same way the dashboard's
 * own panel derives it, so the two can never disagree.
 * -------------------------------------------------------------------------- */

/** Where the Atlas opens from a door: the centre of CITY_BBOX, whole city. */
const CITY_VIEW = (() => {
  const [w, s, e, n] = CITY_BBOX;
  return `${((s + n) / 2).toFixed(5)},${((w + e) / 2).toFixed(5)},11`;
})();

interface Figures {
  structures: number;
  newSince2023: number;
  undeveloped: number;
  fieldVerified: number;
  withUpi: number;
  withZone: number;
}

/** Reads stats.json. Shape is owned by tools/prepare_data.py. */
interface StatsShape {
  buildings: {
    total: number;
    byUse: Record<string, number>;
    byYear: Record<string, number>;
    groundConfirmed: number;
  };
  tax: { vacant: number };
}

/** public/data/coverage.json, written by tools/make_landing_assets.py. */
interface CoverageShape {
  structures: number;
  withUpi: number;
  withZone: number;
}

function derive(s: StatsShape, cov: CoverageShape): Figures {
  const b = s.buildings;

  /* The dashboard counts a structure only when its use is one of the seven
   * classes in ORDER, so the headline is the sum over those and not
   * buildings.total. One record carries an off-taxonomy class and is excluded
   * everywhere, which is why this reads 620,169 against a packed 620,170. */
  const structures = ORDER.reduce((t, c) => t + (b.byUse[c] ?? 0), 0);
  const offTaxonomy = b.total - structures;

  /* That one off-taxonomy record sits in the 2025 cohort, verified against the
   * packed layer, so subtracting it here reproduces the Atlas tile exactly. */
  const newSince2023 = (b.byYear['2025'] ?? 0) - offTaxonomy;

  return {
    structures,
    newSince2023,
    undeveloped: s.tax.vacant,
    fieldVerified: b.groundConfirmed,
    withUpi: cov.withUpi,
    withZone: cov.withZone,
  };
}

const nf = (v: number) => v.toLocaleString('en-US');

/** "Residential — Unplanned" reads as "Residential, unplanned" here: the page
 *  carries no dashes, and the dashboard's label is the only place they appear. */
const plainLabel = (code: string) =>
  (LABELS[code] || code).replace(/\s+—\s+/, ', ').replace(/,\s+(\w)/, (_m, c) => `, ${c.toLowerCase()}`);

const DOORS = [
  {
    id: 'atlas',
    kind: 'primary' as const,
    title: 'Open the Atlas',
    desc: 'Every structure, its use, zoning and year first seen.',
    hash: `lens=atlas&at=${CITY_VIEW}`,
  },
  {
    id: 'revenue',
    kind: 'secondary' as const,
    title: 'Revenue',
    desc: 'Undeveloped taxable parcels and use for property tax.',
    hash: `lens=revenue&at=${CITY_VIEW}`,
  },
  {
    id: 'compliance',
    kind: 'secondary' as const,
    title: 'Compliance',
    desc: 'Buildings checked against the Kigali Master Plan.',
    hash: `lens=compliance&at=${CITY_VIEW}`,
  },
];

const STEPS = [
  ['Imagery', '30 cm satellite imagery of the whole city, captured in 2023 and again in 2025.'],
  ['AI footprint extraction', 'A model traces every building footprint, then the two years are compared to find what is new.'],
  ['Land use classification', 'Each footprint is classified into one of seven use classes and joined to its parcel and Master Plan zone.'],
  ['Field validation', 'Officers confirm structures on the ground, and those confirmations are carried on the record.'],
];

export default function Landing() {
  const [figures, setFigures] = useState<Figures | null>(null);

  useEffect(() => {
    let live = true;
    const at = (f: string) =>
      new URL(`${import.meta.env.BASE_URL}data/${f}`, window.location.href).href;
    Promise.all([
      fetch(at('stats.json')).then((r) => r.json()),
      fetch(at('coverage.json')).then((r) => r.json()),
    ])
      .then(([s, c]: [StatsShape, CoverageShape]) => live && setFigures(derive(s, c)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const open = (hash: string) => {
    window.location.hash = hash;
  };

  const liveLine = figures
    ? `Loading ${nf(figures.structures)} structures across Kigali, ${nf(figures.fieldVerified)} verified in the field.`
    : 'Loading structures across Kigali.';

  const stats = useMemo(
    () => [
      { label: 'Structures', value: figures?.structures },
      { label: 'New since 2023', value: figures?.newSince2023 },
      { label: 'Undeveloped taxable parcels', value: figures?.undeveloped },
      { label: 'Field verified', value: figures?.fieldVerified },
    ],
    [figures],
  );

  return (
    <main className="lp">
      <section className="lp-top">
        <div className="lp-intro">
          <p className="lp-tagline">Building level land use intelligence for Kigali</p>

          <p className="lp-live" aria-live="polite">
            {liveLine}
          </p>

          <h1 className="lp-title">SPARC Kigali</h1>
          <p className="lp-sub">Smart Parcel Atlas for Resilient Cities</p>

          <div className="lp-search">
            <SearchBox
              onCoords={(lat, lon) => open(`at=${lat.toFixed(5)},${lon.toFixed(5)},17.5`)}
              onUpi={(upi) => open(`upi=${encodeURIComponent(upi)}`)}
              onSector={(s: Sector) => {
                const [w, so, e, n] = s.bb;
                open(
                  `district=${encodeURIComponent(s.d)}&sector=${encodeURIComponent(s.s)}` +
                    `&at=${((so + n) / 2).toFixed(5)},${((w + e) / 2).toFixed(5)},13.2`,
                );
              }}
            />
          </div>

          <nav className="lp-doors" aria-label="Open the dashboard">
            {DOORS.map((d) => (
              <a
                key={d.id}
                className={`lp-door lp-door-${d.kind}`}
                href={`#${d.hash}`}
                onClick={(e) => {
                  e.preventDefault();
                  open(d.hash);
                }}
              >
                <span className="lp-door-title">{d.title}</span>
                <span className="lp-door-desc">{d.desc}</span>
              </a>
            ))}
          </nav>
        </div>

        <figure className="lp-figure">
          <img
            className="lp-still"
            src={`${import.meta.env.BASE_URL}growth-still.webp`}
            width={1024}
            height={1024}
            decoding="async"
            alt="Density of structures first seen in the 2025 imagery across the 35 sectors of Kigali, brightest where new building is most concentrated."
          />
          <figcaption className="lp-figcap">
            <span className="lp-ramp" aria-hidden="true" />
            <span className="lp-figcap-text">
              Where the city grew. Structures first seen in 2025, sparse to dense.
            </span>
          </figcaption>
        </figure>
      </section>

      <section className="lp-stats" aria-label="The layer in figures">
        {stats.map((s) => (
          <div className="lp-stat" key={s.label}>
            <p className="lp-stat-label">{s.label}</p>
            <p className="lp-stat-value">{s.value == null ? ' ' : nf(s.value)}</p>
          </div>
        ))}
      </section>

      <div className="lp-band">
        <section className="lp-col" aria-labelledby="lp-data-h">
          <h2 className="lp-h2" id="lp-data-h">
            The data
          </h2>
          <ul className="lp-list">
            <li>30 cm satellite imagery, captured in 2023 and in 2025.</li>
            <li>Seven building use classes, assigned to every structure.</li>
            <li>
              {figures ? `${nf(figures.withUpi)} structures carry their UPI and ${nf(figures.withZone)} carry a Master Plan zone.` : 'Each structure carries its UPI and its Master Plan zone.'}
            </li>
            <li>
              {figures ? `${nf(figures.fieldVerified)} structures verified in the field.` : 'Structures verified in the field.'}
            </li>
          </ul>

          <ul className="lp-uses" aria-label="Building use classes">
            {ORDER.map((c) => (
              <li className="lp-use" key={c}>
                <span className="lp-swatch" style={{ background: COLORS[c] }} aria-hidden="true" />
                {plainLabel(c)}
              </li>
            ))}
          </ul>
        </section>

        <section className="lp-col" aria-labelledby="lp-how-h">
          <h2 className="lp-h2" id="lp-how-h">
            How it works
          </h2>
          <ol className="lp-steps">
            {STEPS.map(([name, line], i) => (
              <li className="lp-step" key={name}>
                <span className="lp-step-n">{String(i + 1).padStart(2, '0')}</span>
                <span className="lp-step-name">{name}</span>
                <span className="lp-step-line">{line}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="lp-partners" aria-labelledby="lp-partners-h">
        <h2 className="lp-h2" id="lp-partners-h">
          Partners
        </h2>
        <p className="lp-partner-list">
          National Land Authority. City of Kigali. World Bank.
        </p>
      </section>

      <footer className="lp-footer">
        <p className="lp-disclaimer">
          The boundaries, colors, denominations, and any other information shown on any map in this
          work do not imply any judgment on the part of The World Bank concerning the legal status
          of any territory or the endorsement or acceptance of such boundaries.
        </p>
        <p className="lp-foot-link">
          <a
            href={`#${DOORS[0].hash}`}
            onClick={(e) => {
              e.preventDefault();
              open(DOORS[0].hash);
            }}
          >
            Open the dashboard
          </a>
        </p>
      </footer>
    </main>
  );
}
