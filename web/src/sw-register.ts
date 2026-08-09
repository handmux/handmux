// Register the service worker — production builds only (in dev it would fight Vite's HMR). The SW's
// only job is to swap the browser's cold-launch network-error page for our offline fallback; see
// web/public/sw.js. Best-effort: if registration fails or isn't supported, the app just runs
// straight off the network as before.
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* best effort */ });
  });
}
