import { useEffect, useRef, useState } from 'react';
import SearchBox from './SearchBox';
import { COLORS, LABELS, ORDER } from '../constants';
import { CITY_BBOX } from '../sectors';
import type { Sector } from '../types';

/* ----------------------------------------------------------------------------
 * The front door.
 *
 * It loads none of the dashboard's data: stats.json and landing.json are 14 KB
 * between them, the imagery is rendered ahead of time by
 * tools/make_landing_assets.py, and the search runs off the static
 * SECTOR_LIST. MapLibre and the 40 MB building layer are fetched only once a
 * door is opened.
 *
 * Every figure here is read at runtime from those two files, and each one
 * appears exactly once on the page.
 * -------------------------------------------------------------------------- */

const CITY_VIEW = (() => {
  const [w, s, e, n] = CITY_BBOX;
  return `${((s + n) / 2).toFixed(5)},${((w + e) / 2).toFixed(5)},11`;
})();

interface StatsShape {
  buildings: {
    total: number;
    byUse: Record<string, number>;
    byYear: Record<string, number>;
    groundConfirmed: number;
  };
  tax: { vacant: number };
}

/** public/data/landing.json, written by tools/make_landing_assets.py. */
interface LandingShape {
  structures: number;
  exampleUpi: string;
  proof: {
    place: string;
    newInFrame: number;
    totalInFrame: number;
    before: string;
    after: string;
  };
}

interface Figures {
  structures: number;
  newSince2023: number;
  undeveloped: number;
  fieldVerified: number;
}

function derive(s: StatsShape): Figures {
  const b = s.buildings;
  /* The dashboard counts a structure only when its use is one of the seven
   * classes in ORDER, so the headline is the sum over those and not
   * buildings.total. One record carries an off-taxonomy class and is excluded
   * everywhere, which is why this reads 620,169 against a packed 620,170. That
   * record sits in the 2025 cohort, verified against the packed layer, so
   * taking it off the new-build count reproduces the Atlas tile exactly. */
  const structures = ORDER.reduce((t, c) => t + (b.byUse[c] ?? 0), 0);
  const offTaxonomy = b.total - structures;
  return {
    structures,
    newSince2023: (b.byYear['2025'] ?? 0) - offTaxonomy,
    undeveloped: s.tax.vacant,
    fieldVerified: b.groundConfirmed,
  };
}

const nf = (v: number) => v.toLocaleString('en-US');

/** "Residential — Unplanned" reads as "Residential, unplanned" here: the page
 *  carries no dashes, and the dashboard's label is the only place they appear. */
const plainLabel = (code: string) =>
  (LABELS[code] || code)
    .replace(/\s+—\s+/, ', ')
    .replace(/,\s+(\w)/, (_m, c) => `, ${c.toLowerCase()}`);

/**
 * Counts one figure up from zero, once, when it first arrives. Ease-out cubic
 * over 1.2s, and prefers-reduced-motion jumps straight to the value.
 */
function useCountUp(target: number | undefined, ms = 1200) {
  const [shown, setShown] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (target == null || started.current) return;
    started.current = true;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      setShown(Math.round(target * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);

  return target == null ? null : shown;
}

const STEPS: [string, string][] = [
  ['Imagery', 'Very high resolution satellite imagery of the whole city, flown twice.'],
  ['AI footprint extraction', 'A model traces every building, then the two years are compared to find what is new.'],
  ['Land use classification', 'Each footprint is given a use class and joined to its parcel and Master Plan zone.'],
  ['Field validation', 'Officers confirm structures on the ground, and the confirmation is carried on the record.'],
];

const asset = (f: string) => `${import.meta.env.BASE_URL}${f}`;

export default function Landing() {
  const [figures, setFigures] = useState<Figures | null>(null);
  const [extra, setExtra] = useState<LandingShape | null>(null);
  const [split, setSplit] = useState(50);

  useEffect(() => {
    let live = true;
    const at = (f: string) =>
      new URL(`${import.meta.env.BASE_URL}data/${f}`, window.location.href).href;
    Promise.all([
      fetch(at('stats.json')).then((r) => r.json()),
      fetch(at('landing.json')).then((r) => r.json()),
    ])
      .then(([s, l]: [StatsShape, LandingShape]) => {
        if (!live) return;
        setFigures(derive(s));
        setExtra(l);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const open = (hash: string) => {
    window.location.hash = hash;
  };

  const stats: [string, number | undefined][] = [
    ['Structures', figures?.structures],
    ['New since 2023', figures?.newSince2023],
    ['Undeveloped taxable parcels', figures?.undeveloped],
    ['Field verified', figures?.fieldVerified],
  ];
  const counted = [
    useCountUp(figures?.structures),
    useCountUp(figures?.newSince2023),
    useCountUp(figures?.undeveloped),
    useCountUp(figures?.fieldVerified),
  ];

  return (
    <main className="lp">
      <section className="lp-hero">
        <img
          className="lp-hero-img"
          src={asset('hero-1280.webp')}
          srcSet={`${asset('hero-960.webp')} 960w, ${asset('hero-1280.webp')} 1280w, ${asset('hero-1920.webp')} 1920w`}
          sizes="100vw"
          width={1920}
          height={1080}
          fetchPriority="high"
          decoding="async"
          alt="Satellite view of Kacyiru, Kigali, with every building footprint filled in the colour of its land use class."
        />
        <div className="lp-scrim" aria-hidden="true" />

        <div className="lp-hero-inner">
          <p className="lp-tagline">Building level land use intelligence for Kigali</p>
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

          {extra && (
            <p className="lp-try">
              <span className="lp-try-label">Try a UPI</span>
              <button
                type="button"
                className="lp-try-upi"
                onClick={() => open(`upi=${encodeURIComponent(extra.exampleUpi)}`)}
              >
                {extra.exampleUpi}
              </button>
            </p>
          )}

          <div className="lp-actions">
            <a
              className="lp-cta"
              href={`#lens=atlas&at=${CITY_VIEW}`}
              onClick={(e) => {
                e.preventDefault();
                open(`lens=atlas&at=${CITY_VIEW}`);
              }}
            >
              Open the Atlas
            </a>
            {([['Revenue', 'revenue'], ['Compliance', 'compliance']] as const).map(([label, lens]) => (
              <a
                key={lens}
                className="lp-link"
                href={`#lens=${lens}&at=${CITY_VIEW}`}
                onClick={(e) => {
                  e.preventDefault();
                  open(`lens=${lens}&at=${CITY_VIEW}`);
                }}
              >
                {label}
                <span className="lp-arrow" aria-hidden="true">
                  →
                </span>
              </a>
            ))}
          </div>
        </div>

        <div className="lp-legend">
          <p className="lp-legend-title">Land use</p>
          <ul className="lp-legend-list">
            {ORDER.map((c) => (
              <li key={c}>
                <span className="lp-swatch" style={{ background: COLORS[c] }} aria-hidden="true" />
                {plainLabel(c)}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="lp-figures" aria-label="The layer in figures">
        {stats.map(([label, value], i) => (
          <div className="lp-fig" key={label}>
            <p className="lp-fig-label">{label}</p>
            <p className="lp-fig-value">
              {value == null ? ' ' : nf(counted[i] ?? value)}
            </p>
          </div>
        ))}
      </section>

      <section className="lp-proof" aria-labelledby="lp-proof-h">
        <h2 className="lp-h2" id="lp-proof-h">
          What changed
        </h2>

        <div className="lp-slider">
          <img
            className="lp-slide"
            src={asset('proof-2023.webp')}
            width={1400}
            height={875}
            loading="lazy"
            decoding="async"
            alt="The same neighbourhood in the earlier imagery, with open ground where buildings later appear."
          />
          <div className="lp-slide-after" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
            <img
              className="lp-slide"
              src={asset('proof-2025.webp')}
              width={1400}
              height={875}
              loading="lazy"
              decoding="async"
              alt="The same neighbourhood in the later imagery, with the structures SPARC first saw in 2025 outlined."
            />
          </div>

          <div className="lp-handle" style={{ left: `${split}%` }} aria-hidden="true">
            <span className="lp-handle-grip" />
          </div>

          <input
            className="lp-range"
            type="range"
            min={0}
            max={100}
            step={1}
            value={split}
            onChange={(e) => setSplit(Number(e.target.value))}
            aria-label="Reveal the later imagery"
          />

          <span className="lp-stamp lp-stamp-l" aria-hidden="true">
            {extra ? extra.proof.before : 'earlier'}
          </span>
          <span className="lp-stamp lp-stamp-r" aria-hidden="true">
            {extra ? extra.proof.after : 'later'}
          </span>
        </div>

        <p className="lp-caption">
          {extra
            ? `In this one frame of ${extra.proof.place}, ${nf(extra.proof.newInFrame)} structures stand in the later imagery that were not there in the earlier, each one outlined as you drag.`
            : 'Drag to compare the same frame across two imagery dates.'}
        </p>
        {extra && (
          <p className="lp-credit">
            Esri World Imagery, Wayback releases {extra.proof.before} and {extra.proof.after}. A
            release is when the mosaic was published, not when the picture was taken.
          </p>
        )}
      </section>

      <section className="lp-how" aria-labelledby="lp-how-h">
        <h2 className="lp-h2" id="lp-how-h">
          How it works
        </h2>
        <ol className="lp-steps">
          {STEPS.map(([name, line]) => (
            <li className="lp-step" key={name}>
              <span className="lp-step-name">{name}</span>
              <span className="lp-step-line">{line}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* Partners. No official logo files exist in this repo. A redrawn or
          approximated institutional mark is not acceptable, so the names stand
          as text until the real assets are supplied. */}
      <section className="lp-partners" aria-labelledby="lp-partners-h">
        <h2 className="lp-h2" id="lp-partners-h">
          Partners
        </h2>
        <ul className="lp-partner-list">
          <li>National Land Authority</li>
          <li>City of Kigali</li>
          <li>World Bank</li>
        </ul>
      </section>

      <footer className="lp-footer">
        <p className="lp-disclaimer">
          The boundaries, colors, denominations, and any other information shown on any map in this
          work do not imply any judgment on the part of The World Bank concerning the legal status
          of any territory or the endorsement or acceptance of such boundaries.
        </p>
      </footer>
    </main>
  );
}
