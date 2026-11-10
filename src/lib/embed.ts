/**
 * What this page is actually allowed to do, rather than whether it is framed.
 *
 * Being inside an iframe does not stop a download. A sandbox missing
 * `allow-downloads` does, and a sandbox missing `allow-popups` stops the
 * report tab. Those are different questions, and answering them with "are we
 * framed" told people their download had been blocked when it had not.
 *
 * How far this can be answered: window.frameElement is only readable when the
 * parent shares our origin, and an embed on someone else's site never does.
 * `allow-same-origin` keeps the frame's OWN origin; it does not join it to the
 * parent's. So in the field this returns 'unknown' for a real embed, and the
 * caller must not turn 'unknown' into a claim that anything was blocked: it
 * tries the real thing and leaves the manual route within reach.
 */

export type Capability = 'yes' | 'no' | 'unknown';

export function isEmbedded(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function sandboxAllows(token: string): Capability {
  if (!isEmbedded()) return 'yes';

  let el: Element | null = null;
  try {
    el = window.frameElement;
  } catch {
    return 'unknown'; // cross-origin parent: the element is not ours to read
  }
  if (!el) return 'unknown';
  // An iframe with no sandbox attribute is not restricted at all.
  if (!el.hasAttribute('sandbox')) return 'yes';

  const list = (el as HTMLIFrameElement).sandbox;
  if (!list || typeof list.contains !== 'function') return 'unknown';
  return list.contains(token) ? 'yes' : 'no';
}

/** Can the browser be handed a file? */
export const canDownload = (): Capability => sandboxAllows('allow-downloads');

/** Can a new tab be opened, for the printable report? */
export const canOpenTab = (): Capability => sandboxAllows('allow-popups');

/**
 * The page the reader is actually looking at.
 *
 * Framed, window.location.href is this app's own address, which is the raw
 * hosting URL and not the product anyone was given. A link or a right click
 * should offer the page doing the embedding instead.
 *
 * In order of how exact the answer is:
 *
 *   1. `?host=` on the embed URL. The only source that yields the exact page,
 *      because a cross-origin referrer is trimmed to its origin by the default
 *      Referrer-Policy. urlState preserves the query string, so it survives
 *      every navigation inside the app.
 *   2. The parent's own location, readable only when it shares our origin.
 *   3. document.referrer, which for an iframe is the page that loaded it. Under
 *      strict-origin-when-cross-origin this is the host's origin and no path,
 *      which still beats sending someone to the hosting URL.
 *   4. Our own address, which is correct when nothing is embedding us.
 */
export function hostPageUrl(): string {
  const own = window.location.href;

  const declared = new URLSearchParams(window.location.search).get('host');
  if (declared) {
    try {
      const u = new URL(declared, own);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
    } catch {
      /* not a URL: fall through rather than hand out something broken */
    }
  }

  if (!isEmbedded()) return own;

  try {
    const top = window.top?.location.href;
    if (top) return top;
  } catch {
    /* cross-origin parent */
  }

  const ref = document.referrer;
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.origin !== window.location.origin) return u.href;
    } catch {
      /* ignore */
    }
  }

  return own;
}
