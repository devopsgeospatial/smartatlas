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
  undesignatedNew: number;
  undevelopedHa: number;
  registry: {
    notOnRoll: number;
    conflictsVerified: number;
    conflictsAll: number;
    exemptFlagged: number;
  };
  attributes: { withHeight: number; fourStoreysPlus: number; tallestStoreys: number };
  panels: string[];
  crops: Record<'taxation' | 'compliance', { file: string; highlighted: number }>;
  record: {
    upi: string; use: string; zone: string; zoneLabel: string;
    areaM2: number; floors: number; heightM: number; year: string;
    verified: boolean; place: (string | null)[]; crop: string;
  };
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

const reduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Fires once, the first time the element is on screen. Everything that
 * animates on this page waits for it, so nothing moves above the fold that
 * the reader never sees, and nothing has already finished by the time they
 * scroll to it.
 */
function useInView<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  return [ref, seen] as const;
}

/**
 * Counts one figure up from zero, once, when the band is first on screen.
 * Ease-out cubic over 1.2s, and prefers-reduced-motion jumps to the value.
 */
function useCountUp(target: number | undefined, start: boolean, ms = 1200) {
  const [shown, setShown] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (target == null || !start || started.current) return;
    started.current = true;
    if (reduced()) {
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
  }, [target, start, ms]);

  return target == null ? null : shown;
}

const PANELS = ['panel-1-imagery', 'panel-2-footprints', 'panel-3-use', 'panel-4-verified'];
const PANEL_ALT = [
  'A tile of Kigali in raw satellite imagery.',
  'The same tile with every building footprint traced in outline.',
  'The same tile with each footprint filled in the colour of its land use class.',
  'The same tile again, with a marker on each building an officer has confirmed.',
];

/** Strip the leading code from "C1-Mixed use zone". */
const zoneDesc = (label: string) => (label || '').replace(/^[A-Z0-9]+\s*-\s*/, '');

const STEPS: [string, string][] = [
  ['Imagery', '30 cm satellite imagery of the whole city, captured twice so the two years can be compared.'],
  ['Footprint extraction', 'A model traces every building, then matches the two captures to find what is new.'],
  ['Use classification', 'A second model reads each footprint and gives it a use class.'],
  ['Field validation', 'Officers confirm structures on the ground, and the confirmation is carried on the record.'],
];

/* Field assessment opens the Atlas over a dense frame with the export menu
 * already down. It cannot open on the whole city: Export reads the structures
 * in the viewport, and the button is disabled until they are loaded, so a
 * citywide link would hand someone a dead control. */
const FIELD_VIEW = '-1.93951,30.07688,16';

const SIDE_DOORS: [string, string][] = [
  ['Revenue', `lens=revenue&at=${CITY_VIEW}`],
  ['Compliance', `lens=compliance&at=${CITY_VIEW}`],
  ['Field assessment', `lens=atlas&at=${FIELD_VIEW}&export=1`],
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

  const [bandRef, bandSeen] = useInView<HTMLElement>();
  const [stripRef, stripSeen] = useInView<HTMLOListElement>();

  /* Each figure opens the view it was counted from. Field verified is the one
   * that cannot be filtered in a link: the dashboard has no verified filter in
   * its URL, so it opens the Revenue lens, where ground confirmation is what
   * the panel is built around. */
  const stats: [string, number | undefined, string][] = [
    ['Structures', figures?.structures, `lens=atlas&at=${CITY_VIEW}`],
    ['New since 2023', figures?.newSince2023, `year=2025&at=${CITY_VIEW}`],
    ['Undeveloped parcels', figures?.undeveloped, `lens=revenue&at=${CITY_VIEW}`],
    ['Field verified', figures?.fieldVerified, `lens=revenue&at=${CITY_VIEW}`],
  ];
  const counted = [
    useCountUp(figures?.structures, bandSeen),
    useCountUp(figures?.newSince2023, bandSeen),
    useCountUp(figures?.undeveloped, bandSeen),
    useCountUp(figures?.fieldVerified, bandSeen),
  ];

  return (
    <main className="lp">
      <section className="lp-hero">
        <img
          className="lp-hero-img"
          src={asset('hero-1280.webp')}
          srcSet={`${asset('hero-960.webp')} 960w, ${asset('hero-1280.webp')} 1280w, ${asset('hero-1920.webp')} 1920w`}
          /* Not plain 100vw: at 1366, the commonest projector and laptop width,
             that picks the 1920 file and spends 168 KB to upscale by 7 percent
             less. Below 1440 the 1280 file is served instead, which is the
             difference between clearing the two second budget and missing it. */
          sizes="(max-width: 1439px) 1280px, 1920px"
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
            <span className="lp-links">
            {SIDE_DOORS.map(([label, hash]) => (
              <a
                key={label}
                className="lp-link"
                href={`#${hash}`}
                onClick={(e) => {
                  e.preventDefault();
                  open(hash);
                }}
              >
                {label}
                <span className="lp-arrow" aria-hidden="true">
                  →
                </span>
              </a>
            ))}
            </span>
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

      <section className="lp-figures" aria-label="The layer in figures" ref={bandRef}>
        {stats.map(([label, value, hash], i) => (
          <a
            className="lp-fig"
            key={label}
            href={`#${hash}`}
            onClick={(e) => {
              e.preventDefault();
              open(hash);
            }}
          >
            <span className="lp-fig-label">{label}</span>
            <span className="lp-fig-value">
              {value == null ? ' ' : nf(counted[i] ?? value)}
            </span>
          </a>
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

          {/* Orientation only. Release dates are not named on the page. */}
          <span className="lp-stamp lp-stamp-l" aria-hidden="true">
            Earlier
          </span>
          <span className="lp-stamp lp-stamp-r" aria-hidden="true">
            Later
          </span>
        </div>

        <p className="lp-caption">
          {extra
            ? `In this one frame of ${extra.proof.place}, ${nf(extra.proof.newInFrame)} structures stand in the later imagery that were not there in the earlier, each one outlined as you drag.`
            : 'Drag to compare the same frame across two imagery dates.'}
        </p>
        <p className="lp-credit">Imagery shown for illustration.</p>
      </section>

      <section className="lp-cases" aria-labelledby="lp-cases-h">
        <h2 className="lp-h2" id="lp-cases-h">
          What it answers
        </h2>
        <div className="lp-case-grid">
          <article className="lp-case">
            {extra && (
              <img
                className="lp-case-crop"
                src={asset(extra.crops.taxation.file)}
                width={960}
                height={540}
                loading="lazy"
                decoding="async"
                alt="Imagery of a Jabana street, with the structures that appeared since the last imagery and are not in the property tax registry picked out."
              />
            )}
            <h3 className="lp-case-h">Property taxation</h3>
            <p className="lp-case-p">
              Every extracted structure carries its parcel identifier, so the record can be set
              beside the property tax registry:{' '}
              {extra ? nf(extra.registry.notOnRoll) : 'some'} structures that appeared since the
              last imagery sit on parcels the registry does not hold, and{' '}
              {extra ? nf(extra.registry.conflictsAll) : 'others'} show a declared use that
              disagrees with the imagery.
            </p>
            <p className="lp-case-p">
              That is a worklist, not an assessment, and the first figure is an upper bound until
              exempt property is taken out.
            </p>
          </article>

          <article className="lp-case">
            {extra && (
              <img
                className="lp-case-crop"
                src={asset(extra.crops.compliance.file)}
                width={960}
                height={540}
                loading="lazy"
                decoding="async"
                alt="Imagery of Kigarama, with the structures that appeared on land the Master Plan does not designate for building picked out."
              />
            )}
            <h3 className="lp-case-h">Compliance monitoring</h3>
            <p className="lp-case-p">
              Every structure carries the Master Plan zone of the parcel beneath it, so the plan
              can be read against what was actually built rather than against what was approved.
            </p>
            <p className="lp-case-p">
              Structures that appeared on land the plan does not designate for building are
              flagged by sector, so the plan can be followed up area by area.
            </p>
          </article>
        </div>
      </section>

      <section className="lp-how" aria-labelledby="lp-how-h">
        <h2 className="lp-h2" id="lp-how-h">
          How the layer is made
        </h2>
        {/* One tile of Kigali, four passes over it. The panels reveal left to
            right the first time the strip is on screen, and not at all under
            prefers-reduced-motion. */}
        <ol
          className={'lp-steps' + (stripSeen || reduced() ? ' is-in' : '')}
          ref={stripRef}
        >
          {STEPS.map(([name, line], i) => (
            <li className="lp-step" key={name} style={{ transitionDelay: `${i * 110}ms` }}>
              <img
                className="lp-panel"
                src={asset(`${PANELS[i]}.webp`)}
                width={600}
                height={600}
                loading="lazy"
                decoding="async"
                alt={PANEL_ALT[i]}
              />
              <span className="lp-step-name">{name}</span>
              <span className="lp-step-line">{line}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="lp-carry" aria-labelledby="lp-carry-h">
        <h2 className="lp-h2" id="lp-carry-h">
          What each building carries
        </h2>
        {extra && (
          <div className="lp-record">
            <img
              className="lp-record-crop"
              src={asset(extra.record.crop)}
              width={560}
              height={560}
              loading="lazy"
              decoding="async"
              alt={`Imagery of the building at ${extra.record.upi}, picked out in its land use colour.`}
            />
            <div className="lp-card">
              <p className="lp-card-kicker">Building Information</p>
              <p className="lp-card-upi">{extra.record.upi}</p>
              <p className="lp-card-place">
                <b>{extra.record.place[0]}</b>
                <span>{extra.record.place.slice(1).filter(Boolean).join(' · ')}</span>
              </p>
              <dl className="lp-card-facts">
                {([
                  ['Observed use', plainLabel(extra.record.use), COLORS[extra.record.use]],
                  ['Master Plan zone', `${extra.record.zone} ${zoneDesc(extra.record.zoneLabel)}`, null],
                  ['Footprint', `${nf(extra.record.areaM2)} m²`, null],
                  ['Height', `${extra.record.heightM} m`, null],
                  ['Storeys', String(extra.record.floors), null],
                  ['First seen', extra.record.year, null],
                  ['Field check', extra.record.verified ? 'Confirmed on the ground' : 'Not confirmed', null],
                ] as [string, string, string | null][]).map(([k, v, swatch]) => (
                  <div className="lp-card-row" key={k}>
                    <dt>{k}</dt>
                    <dd>
                      {swatch && (
                        <span className="lp-swatch" style={{ background: swatch }} aria-hidden="true" />
                      )}
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        )}
        <p className="lp-carry-note">
          {extra ? `${nf(extra.attributes.withHeight)} structures carry` : 'Structures carry'} an
          estimated height. Where the imagery does not support a height, the record is left blank
          rather than filled with a guess.
        </p>
      </section>

    </main>
  );
}
