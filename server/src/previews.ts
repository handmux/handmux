// server/src/previews.js
// Preview registry. Maps a safe single-segment name to an on-disk directory under $HOME with a lease.
// in-memory registry (loaded once at construction, flushed atomically on each mutation) — the previous
// reload-and-write-back on every op was an unguarded read-modify-write that could lose an entry when a
// GET's lease update raced a concurrent register(). Pure-ish: home/now/store/ttl are injected for tests.
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isUnder } from './docPath.js';
import { readJsonArray, writeJsonAtomic } from './jsonStore.js';

export function safePreviewName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!/^[A-Za-z0-9._-]+$/.test(raw)) return null;
  if (raw === '.' || raw === '..' || raw[0] === '.') return null;
  // Keep lookups stable across clients that may normalize user-provided names differently.
  return raw.toLowerCase();
}

export interface PreviewRegistrationInput {
  name?: unknown;
  dir?: unknown;
  port?: unknown;
}

export interface PreviewRegistration {
  name: string;
  kind: 'static';
  accessToken: string;
  expiresAt: number;
}

export interface PreviewError {
  error: string;
  status: number;
}

export interface ActivePreviewEntry {
  name: string;
  kind: 'static';
  dir: string;
  accessToken?: string;
  createdAt?: number;
  expiresAt: number;
}

export interface PreviewListEntry {
  name: string;
  kind: 'static';
  dir: string;
  expiresAt: number;
}

export type PreviewLookup =
  | { state: 'missing' }
  | { state: 'expired' }
  | { state: 'active'; entry: ActivePreviewEntry };

export interface PreviewRegistry {
  register(input: PreviewRegistrationInput): Promise<PreviewRegistration | PreviewError>;
  get(name: string): PreviewLookup;
  list(): PreviewListEntry[];
  remove(name: string): void;
}

interface StaticPreviewEntry {
  name: string;
  kind?: 'static';
  dir: string;
  accessToken?: string;
  createdAt?: number;
  expiresAt: number;
}

interface DynamicPreviewEntry {
  name: string;
  kind: 'dynamic';
  expiresAt: number;
}

type PreviewEntry = StaticPreviewEntry | DynamicPreviewEntry;

interface CreatePreviewsOptions {
  home?: string;
  store?: string;
  now?: () => number;
  ttlMs?: number;
  randomToken?: () => string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parsePreviewEntry(value: unknown, realHome: string): PreviewEntry | null {
  if (!isRecord(value)) return null;
  const name = safePreviewName(value.name);
  if (!name || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return null;
  if (value.kind === 'dynamic') return { name, kind: 'dynamic', expiresAt: value.expiresAt };
  if (value.kind !== undefined && value.kind !== 'static') return null;
  if (typeof value.dir !== 'string' || !path.isAbsolute(value.dir)) return null;
  let realDir: string;
  try {
    realDir = fs.realpathSync(value.dir);
    if (!fs.statSync(realDir).isDirectory()) return null;
  } catch { return null; }
  if (!isUnder(realDir, realHome)) return null;
  const entry: StaticPreviewEntry = { name, dir: value.dir, expiresAt: value.expiresAt };
  if (value.kind === 'static') entry.kind = 'static';
  if (typeof value.accessToken === 'string' && value.accessToken) entry.accessToken = value.accessToken;
  if (typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)) entry.createdAt = value.createdAt;
  return entry;
}

export function createPreviews({
  home = homedir(),
  store = process.env.PREVIEW_STORE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/previews.json'),
  now = () => Date.now(),
  ttlMs = 2 * 60 * 60_000,
  randomToken = () => randomBytes(24).toString('base64url'),
}: CreatePreviewsOptions = {}): PreviewRegistry {
  let realHome: string;
  try { realHome = fs.realpathSync(home); } catch { realHome = home; }

  // Loaded ONCE — this in-memory array is the source of truth; every op mutates it and flushes atomically.
  let entries: PreviewEntry[] = readJsonArray(store)
    .map((value) => parsePreviewEntry(value, realHome))
    .filter((entry): entry is PreviewEntry => entry !== null);
  let flushedExpiries = new Map(entries.map((entry) => [entry.name, entry.expiresAt]));
  const flush = () => {
    // Access tokens are runtime capabilities. Open device tabs re-register after a restart and receive
    // a fresh token, so a stale registry file can never resurrect an old preview URL.
    writeJsonAtomic(store, entries.map((entry) => {
      if (entry.kind === 'dynamic') return entry;
      const { accessToken: _accessToken, ...persisted } = entry;
      return persisted;
    }));
    flushedExpiries = new Map(entries.map((entry) => [entry.name, entry.expiresAt]));
  };

  const resultFor = (entry: StaticPreviewEntry & { accessToken: string }): PreviewRegistration => ({
    name: entry.name,
    kind: 'static',
    accessToken: entry.accessToken,
    expiresAt: entry.expiresAt,
  });

  // Re-registering the same active directory is a lease renewal. Preserve its capability so a
  // foreground check does not change the iframe URL and reload an already-mounted page. A changed
  // directory, expired row, or process-restored row without a runtime token receives a fresh one.
  const upsert = (fields: { name: string; kind: 'static'; dir: string }): PreviewRegistration => {
    const ts = now();
    const current = entries.find((entry) => entry.name === fields.name);
    if (current?.kind === fields.kind
      && current.dir === fields.dir
      && current.expiresAt > ts
      && typeof current.accessToken === 'string'
      && current.accessToken) {
      current.expiresAt = ts + ttlMs;
      flush();
      return resultFor(current as StaticPreviewEntry & { accessToken: string });
    }
    entries = entries.filter((entry) => entry.name !== fields.name);
    const entry: StaticPreviewEntry & { accessToken: string } = {
      ...fields,
      accessToken: randomToken(),
      createdAt: ts,
      expiresAt: ts + ttlMs,
    };
    entries.push(entry);
    flush();
    return resultFor(entry);
  };

  async function register({ name, dir, port }: PreviewRegistrationInput): Promise<PreviewRegistration | PreviewError> {
    const nm = safePreviewName(name);
    if (!nm) return { error: 'bad name', status: 400 };
    if (port !== undefined && port !== null && port !== '') return { error: 'bad request', status: 400 };
    if (typeof dir !== 'string' || dir[0] !== '/') return { error: 'not absolute', status: 400 };
    let real: string;
    try { real = fs.realpathSync(dir); } catch { return { error: 'not found', status: 404 }; }
    if (!isUnder(real, realHome)) return { error: 'outside home', status: 400 };
    let st: fs.Stats;
    try { st = fs.statSync(real); } catch { return { error: 'not accessible', status: 404 }; }
    if (!st.isDirectory()) return { error: 'not a directory', status: 400 };
    return upsert({ name: nm, kind: 'static', dir: real });
  }

  function get(name: string): PreviewLookup {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) return { state: 'missing' };
    const ts = now();
    if (entry.expiresAt <= ts) { entries = entries.filter((candidate) => candidate.name !== name); flush(); return { state: 'expired' }; }
    if (entry.kind === 'dynamic') { entries = entries.filter((candidate) => candidate.name !== name); flush(); return { state: 'missing' }; }
    // Match proxy leases: actual page/resource traffic renews the lease. Throttle persistence so a page
    // with many assets does not rewrite the registry once per request.
    const nextExpiry = ts + ttlMs;
    entry.expiresAt = nextExpiry;
    if (nextExpiry - (flushedExpiries.get(entry.name) || 0) >= 60_000) flush();
    return { state: 'active', entry: { ...entry, kind: 'static' } }; // legacy rows (no kind) → static
  }

  function list(): PreviewListEntry[] {
    const active = entries.filter((entry): entry is StaticPreviewEntry => entry.kind !== 'dynamic' && entry.expiresAt > now());
    if (active.length !== entries.length) { entries = active; flush(); }
    return active.map((entry) => ({ name: entry.name, kind: 'static', dir: entry.dir, expiresAt: entry.expiresAt }));
  }

  function remove(name: string): void {
    const next = entries.filter((entry) => entry.name !== name);
    if (next.length !== entries.length) { entries = next; flush(); }
  }

  return { register, get, list, remove };
}
