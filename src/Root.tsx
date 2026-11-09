import { Suspense, lazy, useEffect, useState } from 'react';
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

const App = lazy(() => import('./App'));

/** Every key urlState.ts writes, plus the one the landing search hands over. */
const APP_KEYS = [
  'lens', 'use', 'year', 'district', 'sector', 'cell', 'village', 'score', 'at', 'sel', 'upi',
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
    <Suspense fallback={<div className="lp-boot">Opening the Atlas</div>}>
      <App />
    </Suspense>
  );
}
