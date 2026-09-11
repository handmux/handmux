// Web Locks serializes cookie-changing auth requests across tabs when the browser supports it.
// HTTP still works: serialize this tab only, then let the server's primary-cookie-wins invariant
// and subsequent status polling reconcile other tabs. No storage permission is required.
let queue: Promise<unknown> = Promise.resolve();
export function withAuthLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(() => navigator.locks?.request
    ? navigator.locks.request('handmux-auth-cookie', operation) : operation());
  queue = next.catch(() => {});
  return next;
}
