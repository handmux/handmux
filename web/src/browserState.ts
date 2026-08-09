export const BROWSER_CLOSE_AFTER_OPTIONS = [10, 30, 60, 120] as const;
export const BROWSER_PROFILE_RETENTION_OPTIONS = [1, 7, 30, null] as const;

export type BrowserCloseAfter = (typeof BROWSER_CLOSE_AFTER_OPTIONS)[number];
export type BrowserProfileRetention = (typeof BROWSER_PROFILE_RETENTION_OPTIONS)[number];
export type BrowserMode = 'direct' | 'proxy';
export type BrowserEntryKind = BrowserMode | 'static';

export interface BrowserPrefs {
  closeAfter: BrowserCloseAfter;
  persistProxyLogin: boolean;
  proxyLoginRetentionDays: BrowserProfileRetention;
}

export interface BrowserWebHistoryEntry {
  kind?: undefined;
  url: string;
  title: string;
  visitedAt: number;
  lastMode?: BrowserMode;
  sessionId?: string;
}

export interface BrowserStaticHistoryEntry {
  kind: 'static';
  dir: string;
  title: string;
  visitedAt: number;
}

export type BrowserHistoryEntry = BrowserWebHistoryEntry | BrowserStaticHistoryEntry;

export interface PersistedBrowserTab {
  id: string;
  mode: BrowserMode;
  originalUrl: string;
  title: string;
  deadline: number | null;
  siteVersion?: 'mobile' | 'desktop';
  createdAt?: number;
}

export interface BrowserTabsState {
  tabs: PersistedBrowserTab[];
  activeId: string | null;
  open: boolean;
  historyActive: boolean;
}

export interface BrowserTabsWriteState {
  tabs?: readonly unknown[];
  activeId?: string | null;
  open?: boolean;
  historyActive?: boolean;
}

const PREF_KEY = 'hm_browser_close_after1';
const PROFILE_PERSIST_KEY = 'hm_browser_profile_persist1';
const PROFILE_RETENTION_KEY = 'hm_browser_profile_retention1';
const HISTORY_KEY = 'hm_browser_history1';
const TABS_KEY = 'hm_browser_tabs1';
const HISTORY_LIMIT = 200;
const SENSITIVE_URL_FIELD = /^(?:access_token|id_token|refresh_token|token|code|authorization|api_?key)$/i;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isCloseAfter(value: unknown): value is BrowserCloseAfter {
  return BROWSER_CLOSE_AFTER_OPTIONS.some((option) => option === value);
}

function isProfileRetention(value: unknown): value is BrowserProfileRetention {
  return BROWSER_PROFILE_RETENTION_OPTIONS.some((option) => option === value);
}

function timeOrNow(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function normalizeBrowserInput(value: unknown): string | null {
  const input = String(value ?? '').trim();
  if (!input) return null;

  let candidate = input;
  if (/^\d+$/.test(input)) {
    const port = Number(input);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    candidate = `http://127.0.0.1:${port}/`;
  } else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
    candidate = `https://${input}`;
  }

  try {
    const url = new URL(candidate);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function readBrowserPrefs(): BrowserPrefs {
  const raw = localStorage.getItem(PREF_KEY);
  const persistProxyLogin = localStorage.getItem(PROFILE_PERSIST_KEY) === '1';
  const retentionRaw = localStorage.getItem(PROFILE_RETENTION_KEY);
  const parsedRetention = retentionRaw === 'never' ? null : Number(retentionRaw);
  const proxyLoginRetentionDays = isProfileRetention(parsedRetention) ? parsedRetention : 30;
  const value = Number(raw);
  return {
    closeAfter: isCloseAfter(value) ? value : 10,
    persistProxyLogin,
    proxyLoginRetentionDays,
  };
}

export function setBrowserCloseAfter(value: unknown): void {
  if (!isCloseAfter(value)) {
    localStorage.removeItem(PREF_KEY);
    return;
  }
  localStorage.setItem(PREF_KEY, String(value));
}

export function setPersistProxyLogin(value: unknown): void {
  if (value === true) localStorage.setItem(PROFILE_PERSIST_KEY, '1');
  else localStorage.removeItem(PROFILE_PERSIST_KEY);
}

export function setProxyLoginRetentionDays(value: unknown): void {
  if (!isProfileRetention(value)) {
    localStorage.removeItem(PROFILE_RETENTION_KEY);
    return;
  }
  localStorage.setItem(PROFILE_RETENTION_KEY, value === null ? 'never' : String(value));
}

function sanitizedHistoryEntry(value: unknown): BrowserHistoryEntry | null {
  const entry = recordOf(value);
  if (entry?.kind === 'static') {
    const dir = String(entry.dir || '');
    if (!dir.startsWith('/') || dir.includes('\0') || dir.length > 4_096) return null;
    return {
      kind: 'static',
      dir,
      title: String(entry.title || ''),
      visitedAt: timeOrNow(entry.visitedAt),
    };
  }
  try {
    const url = new URL(String(entry?.url || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_FIELD.test(key)) url.searchParams.delete(key);
    }
    if (/(?:^|[&#])(?:access_token|id_token|refresh_token|token|code|authorization|api_?key)=/i
      .test(url.hash)) {
      url.hash = '';
    }
    const lastMode = entry?.lastMode === 'proxy'
      ? 'proxy'
      : entry?.lastMode === 'direct' ? 'direct' : null;
    const sessionId = /^[A-Za-z0-9_-]{1,128}$/.test(String(entry?.sessionId || ''))
      ? String(entry?.sessionId)
      : null;
    return {
      url: url.toString(),
      title: String(entry?.title || ''),
      visitedAt: timeOrNow(entry?.visitedAt),
      ...(lastMode ? { lastMode } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  } catch {
    return null;
  }
}

export function readBrowserHistory(): BrowserHistoryEntry[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value
      .map(sanitizedHistoryEntry)
      .filter((entry): entry is BrowserHistoryEntry => entry !== null)
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function addBrowserHistory(entry: unknown): void {
  const clean = sanitizedHistoryEntry(entry);
  if (!clean) return;
  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify([clean, ...readBrowserHistory()].slice(0, HISTORY_LIMIT)),
  );
}

export function upsertBrowserHistory(entry: unknown): void {
  const clean = sanitizedHistoryEntry(entry);
  if (!clean) return;
  const remaining = readBrowserHistory().filter((item) => (
    clean.kind === 'static'
      ? item.kind !== 'static' || item.dir !== clean.dir
      : item.kind === 'static'
        || (item.url !== clean.url && (!clean.sessionId || item.sessionId !== clean.sessionId))
  ));
  localStorage.setItem(HISTORY_KEY, JSON.stringify([clean, ...remaining].slice(0, HISTORY_LIMIT)));
}

export function deleteBrowserHistoryEntry(entry: unknown): void {
  const target = sanitizedHistoryEntry(entry);
  if (!target) return;
  const remaining = readBrowserHistory().filter((item) => (
    target.kind === 'static'
      ? item.kind !== 'static' || item.dir !== target.dir || item.visitedAt !== target.visitedAt
      : item.kind === 'static' || item.url !== target.url || item.visitedAt !== target.visitedAt
  ));
  localStorage.setItem(HISTORY_KEY, JSON.stringify(remaining));
}

export function clearBrowserHistory(): void {
  localStorage.removeItem(HISTORY_KEY);
}

function persistedTab(value: unknown): PersistedBrowserTab | null {
  const tab = recordOf(value);
  const originalUrl = normalizeBrowserInput(tab?.originalUrl);
  if (!tab || !/^[A-Za-z0-9_-]{1,128}$/.test(String(tab.id || '')) || !originalUrl) return null;
  const createdAt = Number(tab.createdAt);
  const mode: BrowserMode = tab.mode === 'proxy' ? 'proxy' : 'direct';
  return {
    id: String(tab.id),
    mode,
    originalUrl,
    title: String(tab.title || '').slice(0, 1_024),
    deadline: typeof tab.deadline === 'number' && Number.isFinite(tab.deadline)
      ? tab.deadline
      : null,
    ...(mode === 'proxy' ? { siteVersion: tab.siteVersion === 'desktop' ? 'desktop' : 'mobile' } : {}),
    ...(Number.isFinite(createdAt) && createdAt > 0 ? { createdAt } : {}),
  };
}

export function readBrowserTabs(): BrowserTabsState {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TABS_KEY) || '{}');
    const raw = recordOf(parsed);
    if (!raw) throw new Error('invalid browser tabs');
    const tabs = (Array.isArray(raw.tabs) ? raw.tabs : [])
      .map(persistedTab)
      .filter((tab): tab is PersistedBrowserTab => tab !== null);
    const candidateId = typeof raw.activeId === 'string' ? raw.activeId : null;
    const activeId = tabs.some((tab) => tab.id === candidateId) ? candidateId : null;
    const historyActive = activeId ? raw.historyActive === true : true;
    return {
      tabs,
      activeId,
      open: raw.open === true && (activeId !== null || raw.historyActive === true),
      historyActive,
    };
  } catch {
    return { tabs: [], activeId: null, open: false, historyActive: true };
  }
}

export function writeBrowserTabs({
  tabs = [], activeId = null, open = false, historyActive = false,
}: BrowserTabsWriteState): void {
  const persisted = tabs
    .map(persistedTab)
    .filter((tab): tab is PersistedBrowserTab => tab !== null);
  const selected = persisted.some((tab) => tab.id === activeId) ? activeId : null;
  localStorage.setItem(TABS_KEY, JSON.stringify({
    tabs: persisted,
    activeId: selected,
    open: !!open,
    historyActive: selected ? !!historyActive : true,
  }));
}

export function clearBrowserTabs(): void {
  localStorage.removeItem(TABS_KEY);
}

export function browserEntryStatus(tabs: unknown): BrowserEntryKind | null {
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  if (tabs.some((value) => recordOf(value)?.mode === 'proxy')) return 'proxy';
  if (tabs.some((value) => {
    const tab = recordOf(value);
    return tab?.mode === 'static' || tab?.kind === 'static';
  })) return 'static';
  return 'direct';
}
