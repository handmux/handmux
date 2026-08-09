// Shared JSON-store persistence for small single-writer runtime registries (push subscriptions, previews,
// and notification inboxes). The PrivateStateStore boundary supplies 0700/0600 permission migration,
// unique sibling temporaries, fsync, and atomic rename. Callers intentionally keep best-effort semantics:
// a failed flush is recoverable through device re-registration or lease renewal.
import { PrivateStateStore } from './privateStateStore.js';

export function readJsonArray(file: string): unknown[] {
  const value = new PrivateStateStore<unknown>(file).read();
  return Array.isArray(value) ? value : [];
}

export function writeJsonAtomic(file: string, value: unknown): void {
  try {
    new PrivateStateStore<unknown>(file).write(value);
  } catch { /* best effort — a lost flush is recoverable by the caller */ }
}
