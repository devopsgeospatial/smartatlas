import React from 'react';
import { createRoot } from 'react-dom/client';
import Root from './Root';
import { isEmbedded } from './lib/embed';
import './styles.css';
import './landing.css';

/* ----------------------------------------------------------------------------
 * Opened on its own, but meant to be embedded.
 *
 * A browser's "Open frame in new tab" uses the iframe's own address, and no
 * page can change what that menu offers. So the embed URL does arrive in a
 * top-level tab, showing the hosting address rather than the product.
 *
 * `?host=` is only ever put on the URL that goes into an embed, so finding it
 * at the top level means exactly that: this tab should have been the host
 * page. Send the reader there before anything renders.
 *
 * Framed, nothing happens: the parameter is read as a link target instead, in
 * lib/embed. The origin check keeps a mistyped value from bouncing the page
 * off itself.
 * -------------------------------------------------------------------------- */
const declaredHost = new URLSearchParams(window.location.search).get('host');
if (declaredHost && !isEmbedded()) {
  try {
    const u = new URL(declaredHost, window.location.href);
    const web = u.protocol === 'https:' || u.protocol === 'http:';
    if (web && u.origin !== window.location.origin) {
      window.location.replace(u.href);
    }
  } catch {
    /* not a URL; fall through and show the app rather than nothing */
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
