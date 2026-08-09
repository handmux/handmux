// Cache-Control policy for the static web bundle.
//   • index.html + the service worker must NEVER be HTTP-cached — an installed PWA would otherwise
//     keep loading a stale shell (pointing at missing hashed assets) or a stale service worker.
//   • Vite build output under /assets/ carries a content hash in its filename, so the URL itself
//     changes whenever the bytes change → safe to pin forever (immutable).
//   • Everything else is a hand-authored public/ file served at a STABLE url whose bytes change in
//     place across releases (icons, manifest.webmanifest, favicon, og cards, offline assets). Those
//     must NOT be immutable — pinning them would freeze an old copy in every returning browser for a
//     year (a changed app icon / manifest would never reach anyone who had visited before). They get
//     `no-cache` = store but always revalidate; the ETag/Last-Modified express.static already sends
//     make the recheck a cheap 304 when nothing changed, and an actual change is picked up at once.
// Pure so it unit-tests on its own.
export function cacheControlFor(filePath: string): string {
  if (filePath.endsWith('.html') || filePath.endsWith('/sw.js')) return 'no-store';
  if (/[\\/]assets[\\/]/.test(filePath)) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}
