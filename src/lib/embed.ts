/**
 * Are we running inside someone else's page?
 *
 * The ArcGIS Experience Builder Embed widget sandboxes its iframe without
 * `allow-downloads`, so a blob download silently does nothing: the anchor click
 * returns normally and no error is raised. A blocked download is therefore
 * undetectable after the fact, and the only honest move is to detect the frame
 * up front and offer a route that does not need the capability at all.
 *
 * Reading window.top across origins throws, which is itself proof of embedding.
 */
export function isEmbedded(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}
