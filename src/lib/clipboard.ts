/**
 * Clipboard write that survives being embedded.
 *
 * navigator.clipboard is gated behind the `clipboard-write` permission policy,
 * which embedders (e.g. the ArcGIS Experience Builder Embed widget) rarely
 * grant. The legacy execCommand path still works inside a sandboxed iframe, so
 * fall back to a throwaway textarea when the modern API is unavailable.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the execCommand path */
  }

  const ta = document.createElement('textarea');
  ta.value = text;
  // Keep it off-screen but still focusable — display:none cannot be selected.
  ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
  ta.setAttribute('readonly', '');
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}
