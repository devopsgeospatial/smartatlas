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
