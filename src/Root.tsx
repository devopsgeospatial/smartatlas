import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import Landing from './components/Landing';

/* ----------------------------------------------------------------------------
 * Which of the two screens the URL is asking for.
 *
 * The dashboard already keeps its whole view in the hash, so the hash is the
 * router: any hash carrying dashboard state opens the dashboard, and a bare
 * URL opens the landing page. Nothing in the dashboard changes, and every link
 * handed out before this page existed still opens exactly the screen it did.
 *
 * App is imported lazily so MapLibre and the dataset decoder stay out of the
 * landing bundle: 236 KB gzipped against 53 KB, and the landing page needs
 * none of it. App takes its own snapshot of the hash per mount, so a door can
 * be opened, backed out of and opened again without carrying stale state.
 * -------------------------------------------------------------------------- */

const RELOAD_KEY = 'sparc:chunk-reload';

const flag = {
  get(): boolean {
    try {
      return sessionStorage.getItem(RELOAD_KEY) === '1';
    } catch {
      return false;
    }
  },
  set(v: boolean) {
    try {
      if (v) sessionStorage.setItem(RELOAD_KEY, '1');
      else sessionStorage.removeItem(RELOAD_KEY);
    } catch {
      /* storage can be refused in a sandboxed frame; the reload still works,
         it just loses the guard against doing it twice */
    }
  },
};

/**
 * Import the dashboard, surviving a deploy that happened while this page was
 * open.
 *
 * Vite names the chunk by content hash and the deploy removes the previous
 * file, so a tab loaded before a release asks for a module that is no longer
 * there and the import rejects. Without this the door does nothing at all:
 * React.lazy has no state for a failed import, so the Suspense fallback simply
 * stays up. Reloading pulls the new index and its new chunk name.
 *
 * The reload happens once. If the page comes back and still cannot load the
 * module, the fault is not staleness and looping would only hide it, so the
 * error is allowed through to the boundary below.
 */
function loadApp() {
  return import('./App').then(
    (m) => {
      flag.set(false);
      return m;
    },
    (err) => {
      if (!flag.get()) {
        flag.set(true);
        window.location.reload();
        // The page is going away; never settle, so nothing renders meanwhile.
        return new Promise<never>(() => {});
      }
      throw err;
    },
  );
}

const App = lazy(loadApp);

/** A failed chunk is the one error here that reaches the user as a dead click. */
class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="lp-boot">
        <p>The Atlas could not be loaded.</p>
        <button
          className="themebtn"
          onClick={() => {
            flag.set(false);
            window.location.reload();
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}

/** Every key urlState.ts writes, plus the one the landing search hands over. */
const APP_KEYS = [
  'lens', 'use', 'year', 'district', 'sector', 'cell', 'village', 'score', 'at', 'sel',
  'upi', 'export',
];

function wantsApp(): boolean {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return false;
  const p = new URLSearchParams(raw);
  return APP_KEYS.some((k) => p.has(k));
}

export default function Root() {
  const [app, setApp] = useState(wantsApp);

  useEffect(() => {
    const onHash = () => setApp(wantsApp());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /* styles.css locks the page to the viewport and hides overflow, which is
   * right for a full-screen map and wrong for a page that scrolls. The
   * landing stylesheet releases that, keyed off this attribute, so the
   * dashboard is never served a relaxed shell. */
  useEffect(() => {
    if (app) document.body.removeAttribute('data-screen');
    else document.body.setAttribute('data-screen', 'landing');
    return () => document.body.removeAttribute('data-screen');
  }, [app]);

  if (!app) return <Landing />;

  return (
    <AppBoundary>
      <Suspense fallback={<div className="lp-boot">Opening the Atlas</div>}>
        <App />
      </Suspense>
    </AppBoundary>
  );
}
