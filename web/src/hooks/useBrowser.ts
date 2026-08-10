import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import {
  acquireBrowserProxyLease,
  clearBrowserProxyProfile,
  deleteBrowserProxyLease,
  getBrowserProxyStatus,
  navigateBrowserProxyLease,
  setBrowserProxyProfilePrefs,
} from '../api.js';
import {
  clearBrowserHistory,
  clearBrowserTabs,
  deleteBrowserHistoryEntry,
  normalizeBrowserInput,
  readBrowserHistory,
  readBrowserPrefs,
  readBrowserTabs,
  setBrowserCloseAfter,
  setPersistProxyLogin as persistProxyLoginLocally,
  setProxyLoginRetentionDays as persistProxyLoginRetentionLocally,
  upsertBrowserHistory,
  writeBrowserTabs,
} from '../browserState.js';
import { isBrowserAccessEnabled, setBrowserAccessEnabled } from '../storage.js';
import { t } from '../i18n';
import type {
  BrowserCloseAfter,
  BrowserHistoryEntry,
  BrowserMode,
  BrowserProfileRetention,
  BrowserTabsState,
  PersistedBrowserTab,
} from '../browserState.js';

type BrowserSiteVersion = 'mobile' | 'desktop';
type ProxyGeneration = number | string;

export interface RuntimeBrowserTab extends PersistedBrowserTab {
  url?: string;
  channel?: string;
  generation?: ProxyGeneration;
}

function withoutBinding(tab: RuntimeBrowserTab): RuntimeBrowserTab {
  const { url: _url, channel: _channel, generation: _generation, ...rest } = tab;
  return rest;
}

function withoutProxyState(tab: RuntimeBrowserTab): RuntimeBrowserTab {
  const { siteVersion: _siteVersion, ...rest } = withoutBinding(tab);
  return rest;
}

interface BrowserBinding {
  url: string;
  channel?: string;
  generation?: ProxyGeneration;
}

interface BrowserProxyStatus {
  ready: boolean;
  generation: ProxyGeneration | null;
}

interface ProxyProfilePrefs {
  persist: boolean;
  retentionDays: BrowserProfileRetention;
}

interface ProxyProfileResponse extends ProxyProfilePrefs {
  warning?: string;
}

interface PendingBrowserUrl {
  url: string;
  mode: BrowserMode;
}

interface PendingOpenResult {
  pending: true;
}

interface PreviousBrowserView {
  activeId: string | null;
  historyActive: boolean;
  open: boolean;
}

interface BrowserBindingRequest {
  url: string;
  siteVersion: BrowserSiteVersion;
  promise: Promise<RuntimeBrowserTab | null>;
}

interface OpenBrowserOptions {
  mode?: BrowserMode;
  force?: boolean;
  signal?: AbortSignal;
}

interface UseBrowserOptions {
  enabled?: boolean;
  browserProxy?: boolean;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function errorRecord(value: unknown): { status?: number; message?: string; name?: string } {
  const error = recordOf(value);
  return {
    ...(typeof error?.status === 'number' ? { status: error.status } : {}),
    ...(typeof error?.message === 'string' ? { message: error.message } : {}),
    ...(typeof error?.name === 'string' ? { name: error.name } : {}),
  };
}

function parseProxyStatus(value: unknown): BrowserProxyStatus {
  const status = recordOf(value);
  const generation = typeof status?.generation === 'number' || typeof status?.generation === 'string'
    ? status.generation
    : null;
  return { ready: status?.ready === true, generation };
}

function parseBinding(value: unknown): BrowserBinding {
  const binding = recordOf(value);
  if (!binding || typeof binding.url !== 'string' || !binding.url) {
    throw new Error(t('browser.loadFailed'));
  }
  return {
    url: binding.url,
    ...(typeof binding.channel === 'string' ? { channel: binding.channel } : {}),
    ...(typeof binding.generation === 'number' || typeof binding.generation === 'string'
      ? { generation: binding.generation }
      : {}),
  };
}

function parseProfileResponse(value: unknown): ProxyProfileResponse {
  const profile = recordOf(value);
  const retentionDays = profile?.retentionDays;
  if (!profile || typeof profile.persist !== 'boolean'
    || (retentionDays !== null && retentionDays !== 1
      && retentionDays !== 7 && retentionDays !== 30)) {
    throw new Error('Browser proxy returned invalid profile preferences');
  }
  return {
    persist: profile.persist,
    retentionDays,
    ...(typeof profile.warning === 'string' ? { warning: profile.warning } : {}),
  };
}

const runtimeTab = (tab: PersistedBrowserTab): RuntimeBrowserTab => ({
  ...tab,
  ...(tab.mode === 'direct' ? { url: tab.originalUrl } : {}),
  ...(tab.mode === 'proxy' ? { siteVersion: tab.siteVersion === 'desktop' ? 'desktop' : 'mobile' } : {}),
});
const PROXY_RETRY_DELAYS = [250, 500, 1000, 2000, 4000, 5000];

function transientProxyError(error: unknown): boolean {
  const candidate = errorRecord(error);
  return [502, 503, 504].includes(candidate.status ?? 0)
    || /(?:timeout|browser unavailable|failed to fetch|networkerror|load failed)/i
      .test(candidate.message || '');
}

const wait = (duration: number): Promise<void> => (
  new Promise((resolve) => setTimeout(resolve, duration))
);

function abortError(): Error {
  const error = new Error('browser open aborted');
  error.name = 'AbortError';
  return error;
}

function abortable<T>(operation: PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function localId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function useBrowser({ enabled = true, browserProxy = false }: UseBrowserOptions = {}) {
  const accessAtMount = useRef(isBrowserAccessEnabled()).current;
  const initial = useRef<BrowserTabsState | null>(null);
  if (!initial.current) {
    initial.current = accessAtMount
      ? readBrowserTabs()
      : { tabs: [], activeId: null, open: false, historyActive: true };
  }
  const [accessEnabled, setAccessEnabled] = useState(accessAtMount);
  const initialState = initial.current;
  const [tabs, setTabs] = useState<RuntimeBrowserTab[]>(() => initialState.tabs.map(runtimeTab));
  const [activeId, setActiveId] = useState<string | null>(initialState.activeId);
  const [open, setOpenState] = useState(initialState.open && accessAtMount);
  const [historyActive, setHistoryActive] = useState(initialState.historyActive);
  const [consentOpen, setConsentOpen] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<PendingBrowserUrl | null>(null);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>(readBrowserHistory);
  const [error, setError] = useState<Error | null>(null);
  const prefs = readBrowserPrefs();
  const [closeAfter, setCloseAfterState] = useState(prefs.closeAfter);
  const [persistProxyLogin, setPersistProxyLoginState] = useState(prefs.persistProxyLogin);
  const [proxyLoginRetentionDays, setProxyLoginRetentionDaysState] = useState(prefs.proxyLoginRetentionDays);
  const tabsRef = useRef(tabs);
  const activeRef = useRef(activeId);
  const openRef = useRef(open);
  const historyRef = useRef(historyActive);
  const bindingPromises = useRef(new Map<string, BrowserBindingRequest>());
  const proxyGeneration = useRef<ProxyGeneration | null>(null);
  const openSequence = useRef(0);
  const navigateSequence = useRef(new Map<string, number>());
  const navigateQueues = useRef(new Map<string, Promise<unknown>>());
  const pendingUrlRef = useRef<PendingBrowserUrl | null>(pendingUrl);
  const enablePromise = useRef<Promise<RuntimeBrowserTab | PendingOpenResult | true | null> | null>(null);
  const profileQueue = useRef<Promise<void>>(Promise.resolve());
  const recoveryWarningShown = useRef(false);
  const pendingProfilePrefs = useRef({
    persist: prefs.persistProxyLogin,
    retentionDays: prefs.proxyLoginRetentionDays,
  });
  const navigatingTabs = useRef(new Map<string, number>());
  tabsRef.current = tabs;
  activeRef.current = activeId;
  openRef.current = open;
  historyRef.current = historyActive;

  const commitTabs = useCallback((update: SetStateAction<RuntimeBrowserTab[]>): RuntimeBrowserTab[] => {
    const next = typeof update === 'function' ? update(tabsRef.current) : update;
    tabsRef.current = next;
    setTabs(next);
    return next;
  }, []);
  const commitActive = useCallback((value: string | null): void => {
    activeRef.current = value;
    setActiveId(value);
  }, []);
  const commitOpen = useCallback((value: boolean): void => {
    openRef.current = value;
    setOpenState(value);
  }, []);
  const commitHistory = useCallback((value: boolean): void => {
    historyRef.current = value;
    setHistoryActive(value);
  }, []);

  useEffect(() => {
    writeBrowserTabs({ tabs, activeId, open, historyActive });
  }, [activeId, historyActive, open, tabs]);

  const recordHistory = useCallback((tab: RuntimeBrowserTab | null | undefined): void => {
    if (!tab?.originalUrl) return;
    upsertBrowserHistory({
      url: tab.originalUrl, title: tab.title, lastMode: tab.mode,
      visitedAt: Date.now(), sessionId: tab.id,
    });
    setHistory(readBrowserHistory());
  }, []);

  const release = useCallback((tab: RuntimeBrowserTab | null | undefined): void => {
    if (tab?.mode === 'proxy') deleteBrowserProxyLease(tab.id).catch(() => {});
  }, []);

  const discardOpenedTab = useCallback((
    id: string,
    restore: PreviousBrowserView | null = null,
  ): void => {
    const index = tabsRef.current.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const discarded = tabsRef.current[index];
    release(discarded);
    const remaining = commitTabs((current) => current.filter((tab) => tab.id !== id));
    if (activeRef.current === id) {
      const restored = restore?.activeId
        ? remaining.find((tab) => tab.id === restore.activeId)
        : null;
      const next = restored || remaining[Math.min(index, remaining.length - 1)] || null;
      if (next && !restore?.historyActive) {
        commitTabs((current) => current.map((tab) => (
          tab.id === next.id ? { ...tab, deadline: null } : tab
        )));
      }
      commitActive(next?.id || null);
      commitHistory(restore?.historyActive ?? !next);
      if (restore) commitOpen(restore.open);
    }
  }, [commitActive, commitHistory, commitOpen, commitTabs, release]);

  const enqueueProfileOperation = useCallback(<T,>(work: () => Promise<T> | T): Promise<T> => {
    const operation = profileQueue.current.catch(() => {}).then(work);
    profileQueue.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, []);

  const applyBinding = useCallback((
    id: string,
    binding: BrowserBinding,
  ): RuntimeBrowserTab | null => {
    if (binding.generation != null && proxyGeneration.current !== binding.generation) {
      proxyGeneration.current = binding.generation;
      commitTabs((current) => current.map((item) => (
        item.mode === 'proxy' && item.id !== id
          ? withoutBinding(item)
          : item
      )));
    }
    let result: RuntimeBrowserTab | null = null;
    commitTabs((current) => current.map((item) => {
      if (item.id !== id || item.mode !== 'proxy') return item;
      const bound: RuntimeBrowserTab = {
        ...withoutBinding(item),
        url: binding.url,
        ...(binding.channel !== undefined ? { channel: binding.channel } : {}),
        ...(binding.generation !== undefined ? { generation: binding.generation } : {}),
      };
      result = bound;
      return bound;
    }));
    return result;
  }, [commitTabs]);

  const ensureBinding = useCallback((
    id: string,
    { force = false }: { force?: boolean } = {},
  ): Promise<RuntimeBrowserTab | null> => {
    const tab = tabsRef.current.find((item) => item.id === id);
    if (!tab || tab.mode !== 'proxy' || (tab.url && !force)) return Promise.resolve(tab || null);
    if (!browserProxy) {
      setError(new Error(t('browser.proxyUnavailable')));
      return Promise.resolve(null);
    }
    const requestedUrl = tab.originalUrl;
    const requestedSiteVersion = tab.siteVersion === 'desktop' ? 'desktop' : 'mobile';
    const existing = bindingPromises.current.get(id);
    if (existing?.url === requestedUrl && existing.siteVersion === requestedSiteVersion) return existing.promise;
    let profileWarning = false;
    const stillCurrent = () => {
      const current = tabsRef.current.find((item) => item.id === id);
      return current?.mode === 'proxy'
        && current.originalUrl === requestedUrl
        && current.siteVersion === requestedSiteVersion;
    };
    let pending: Promise<RuntimeBrowserTab | null>;
    pending = (async () => {
      for (let attempt = 0; attempt <= PROXY_RETRY_DELAYS.length; attempt += 1) {
        if (!stillCurrent()) return null;
        let status: BrowserProxyStatus | null = null;
        try {
          status = parseProxyStatus(await getBrowserProxyStatus());
        } catch (nextError) {
          if (!transientProxyError(nextError)) throw nextError;
        }
        if (!stillCurrent()) return null;
        let transientFailure = !status?.ready;
        if (status?.ready) {
          try {
            const binding = await enqueueProfileOperation(async () => {
              if (!stillCurrent()) return null;
              let profile;
              try {
                const prefs = readBrowserPrefs();
                profile = parseProfileResponse(await setBrowserProxyProfilePrefs({
                  persist: prefs.persistProxyLogin,
                  retentionDays: prefs.proxyLoginRetentionDays,
                }));
              } catch (nextError) {
                if (!transientProxyError(nextError)) {
                  throw new Error(t('browser.profileSyncFailed'));
                }
                throw nextError;
              }
              if (!stillCurrent()) return null;
              profileWarning = profile?.warning === 'profile-recovery-failed';
              if (profileWarning && !recoveryWarningShown.current) {
                recoveryWarningShown.current = true;
                setError(new Error(t('browser.profileRecoveryWarning')));
              }
              return parseBinding(await acquireBrowserProxyLease(
                id,
                requestedUrl,
                requestedSiteVersion,
              ));
            });
            if (!stillCurrent()) return null;
            return binding;
          } catch (nextError) {
            if (!transientProxyError(nextError)) throw nextError;
            transientFailure = true;
          }
        }
        if (!transientFailure) return null;
        if (attempt === PROXY_RETRY_DELAYS.length) {
          throw new Error(t('browser.loadFailed'));
        }
        const delay = PROXY_RETRY_DELAYS[attempt];
        if (delay === undefined) throw new Error(t('browser.loadFailed'));
        await wait(delay);
      }
      return null;
    })().then((binding): RuntimeBrowserTab | null => {
      if (!binding) return null;
      const current = tabsRef.current.find((item) => item.id === id);
      if (!current
        || current.mode !== 'proxy'
        || current.originalUrl !== requestedUrl
        || current.siteVersion !== requestedSiteVersion) {
        deleteBrowserProxyLease(id).catch(() => {});
        return null;
      }
      const result = applyBinding(id, binding);
      if (!profileWarning) setError(null);
      return result;
    }).catch((nextError: unknown) => {
      if (stillCurrent()) {
        const message = errorRecord(nextError).message || t('browser.loadFailed');
        setError(nextError instanceof Error ? nextError : new Error(message));
      }
      return null;
    }).finally(() => {
      if (bindingPromises.current.get(id)?.promise === pending) {
        bindingPromises.current.delete(id);
      }
    });
    bindingPromises.current.set(id, {
      url: requestedUrl, siteVersion: requestedSiteVersion, promise: pending,
    });
    return pending;
  }, [applyBinding, browserProxy, enqueueProfileOperation]);

  const recoverBinding = useCallback((id: string): Promise<RuntimeBrowserTab | null> => {
    commitTabs((current) => current.map((tab) => tab.id === id && tab.mode === 'proxy'
      ? withoutBinding(tab)
      : tab));
    return ensureBinding(id, { force: true });
  }, [commitTabs, ensureBinding]);

  const refreshProxyStatus = useCallback(async () => {
    if (!enabled || !accessEnabled || !browserProxy) return;
    try {
      const status = parseProxyStatus(await getBrowserProxyStatus());
      if (status.generation == null) return;
      const changed = proxyGeneration.current != null && proxyGeneration.current !== status.generation;
      proxyGeneration.current = status.generation;
      if (changed) {
        commitTabs((current) => current.map((tab) => tab.mode === 'proxy'
          ? withoutBinding(tab)
          : tab));
      }
    } catch {
      // Status is advisory: device-owned tabs survive proxy worker outages.
    }
  }, [accessEnabled, browserProxy, commitTabs, enabled]);

  const hideTab = useCallback((
    tab: RuntimeBrowserTab,
    duration: number | null = closeAfter,
  ): RuntimeBrowserTab => ({
    ...tab,
    deadline: duration == null ? null : Date.now() + duration * 60_000,
  }), [closeAfter]);

  const pruneExpired = useCallback(() => {
    const now = Date.now();
    const expired = tabsRef.current.filter((tab) => tab.deadline != null && tab.deadline <= now);
    if (!expired.length) return;
    const ids = new Set(expired.map((tab) => tab.id));
    expired.forEach((tab) => { recordHistory(tab); release(tab); });
    const remaining = commitTabs((current) => current.filter((tab) => !ids.has(tab.id)));
    if (activeRef.current && ids.has(activeRef.current)) {
      const next = remaining[0] || null;
      commitActive(next?.id || null);
      commitHistory(!next);
    }
  }, [commitActive, commitHistory, commitTabs, recordHistory, release]);

  useEffect(() => {
    pruneExpired();
    void refreshProxyStatus();
    const onVisibility = () => {
      if (!document.hidden) {
        pruneExpired();
        void refreshProxyStatus();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [pruneExpired, refreshProxyStatus]);

  useEffect(() => {
    const deadlines = tabs.flatMap((tab) => tab.deadline == null ? [] : [tab.deadline]);
    if (!deadlines.length) return undefined;
    const timer = setTimeout(pruneExpired, Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => clearTimeout(timer);
  }, [pruneExpired, tabs]);

  const openUrl = useCallback(async (
    input: unknown,
    { mode = 'direct', force = false, signal }: OpenBrowserOptions = {},
  ): Promise<RuntimeBrowserTab | PendingOpenResult | null> => {
    if (signal?.aborted) return null;
    const sequence = ++openSequence.current;
    const url = normalizeBrowserInput(input);
    if (!url) { setError(new Error(t('browser.urlInvalid'))); return null; }
    if (!accessEnabled && !force) {
      const pending: PendingBrowserUrl = { url, mode };
      pendingUrlRef.current = pending;
      setPendingUrl(pending);
      setConsentOpen(true);
      return { pending: true };
    }
    if (mode === 'proxy' && !browserProxy) {
      setError(new Error(t('browser.proxyUnavailable')));
      return null;
    }
    const id = localId();
    const previousView = {
      activeId: activeRef.current,
      historyActive: historyRef.current,
      open: openRef.current,
    };
    const created = runtimeTab({
      id, mode, originalUrl: url, title: '', deadline: null, createdAt: Date.now(),
      ...(mode === 'proxy' ? { siteVersion: 'mobile' } : {}),
    });
    commitTabs((current) => [...current.map((tab) => (
      tab.id === activeRef.current && openRef.current && !historyRef.current ? hideTab(tab) : tab
    )), created]);
    commitActive(id);
    commitHistory(false);
    commitOpen(true);
    setError(null);
    try {
      if (mode === 'proxy') await abortable(ensureBinding(id), signal);
      else await abortable(Promise.resolve(), signal);
    } catch (nextError: unknown) {
      discardOpenedTab(id, previousView);
      if (errorRecord(nextError).name === 'AbortError') return null;
      throw nextError;
    }
    if (signal?.aborted) {
      discardOpenedTab(id, previousView);
      return null;
    }
    if (sequence !== openSequence.current) {
      discardOpenedTab(id);
      return null;
    }
    return tabsRef.current.find((tab) => tab.id === id) || created;
  }, [accessEnabled, browserProxy, commitActive, commitHistory, commitOpen, commitTabs, discardOpenedTab, ensureBinding, hideTab]);

  const enableAccess = useCallback(() => {
    if (enablePromise.current) return enablePromise.current;
    const pending = pendingUrlRef.current;
    pendingUrlRef.current = null;
    setPendingUrl(null);
    const operation = (async () => {
      setBrowserAccessEnabled(true);
      setAccessEnabled(true);
      setConsentOpen(false);
      if (pending) return openUrl(pending.url, { mode: pending.mode, force: true });
      commitOpen(true);
      return true;
    })().finally(() => {
      if (enablePromise.current === operation) enablePromise.current = null;
    });
    enablePromise.current = operation;
    return operation;
  }, [commitOpen, openUrl]);

  const cancelAccess = useCallback(() => {
    pendingUrlRef.current = null;
    setPendingUrl(null);
    setConsentOpen(false);
  }, []);

  const disableAccess = useCallback(() => {
    tabsRef.current.forEach(release);
    commitTabs([]);
    commitActive(null);
    commitHistory(true);
    commitOpen(false);
    clearBrowserTabs();
    setBrowserAccessEnabled(false);
    setAccessEnabled(false);
    setConsentOpen(false);
    pendingUrlRef.current = null;
  }, [commitActive, commitHistory, commitOpen, commitTabs, release]);
  const setEnabled = useCallback((value: boolean): boolean => {
    if (!value) {
      disableAccess();
      return false;
    }
    setBrowserAccessEnabled(true);
    setAccessEnabled(true);
    return true;
  }, [disableAccess]);

  const switchTab = useCallback(async (id: string): Promise<boolean> => {
    if (id === 'history') {
      setError(null);
      if (openRef.current && activeRef.current && !historyRef.current) {
        commitTabs((current) => current.map((tab) => tab.id === activeRef.current ? hideTab(tab) : tab));
      }
      commitHistory(true);
      return true;
    }
    const target = tabsRef.current.find((tab) => tab.id === id);
    if (!target) return false;
    if (openRef.current && target.mode === 'proxy') await refreshProxyStatus();
    setError(null);
    commitTabs((current) => current.map((tab) => {
      if (tab.id === id) return { ...tab, deadline: null };
      if (tab.id === activeRef.current && openRef.current && !historyRef.current) return hideTab(tab);
      return tab;
    }));
    commitActive(id);
    commitHistory(false);
    if (openRef.current) await ensureBinding(id);
    return true;
  }, [commitActive, commitHistory, commitTabs, ensureBinding, hideTab, refreshProxyStatus]);

  const setOpen = useCallback(async (visible: boolean): Promise<boolean> => {
    if (visible && !accessEnabled) { setConsentOpen(true); return false; }
    const active = tabsRef.current.find((tab) => tab.id === activeRef.current);
    if (visible && !historyRef.current && active?.mode === 'proxy') await refreshProxyStatus();
    if (activeRef.current && !historyRef.current) {
      commitTabs((current) => current.map((tab) => (
        tab.id === activeRef.current ? (visible ? { ...tab, deadline: null } : hideTab(tab)) : tab
      )));
    }
    commitOpen(visible);
    if (visible && activeRef.current && !historyRef.current) await ensureBinding(activeRef.current);
    return true;
  }, [accessEnabled, commitOpen, commitTabs, ensureBinding, hideTab, refreshProxyStatus]);

  const closeTab = useCallback((id: string): void => {
    const index = tabsRef.current.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    setError(null);
    const closing = tabsRef.current[index];
    recordHistory(closing);
    release(closing);
    const remaining = commitTabs((current) => current.filter((tab) => tab.id !== id));
    if (activeRef.current === id) {
      const next = remaining[Math.min(index, remaining.length - 1)] || null;
      commitActive(next?.id || null);
      commitHistory(!next);
      if (next && openRef.current) {
        commitTabs((current) => current.map((tab) => tab.id === next.id ? { ...tab, deadline: null } : tab));
        void ensureBinding(next.id);
      }
    }
  }, [commitActive, commitHistory, commitTabs, ensureBinding, recordHistory, release]);

  const navigateTab = useCallback(async (
    id: string,
    input: unknown,
    requestedMode?: BrowserMode,
    requestedSiteVersion?: BrowserSiteVersion,
  ): Promise<RuntimeBrowserTab | null> => {
    const url = normalizeBrowserInput(input);
    const current = tabsRef.current.find((tab) => tab.id === id);
    if (!current) return null;
    if (!url) {
      setError(new Error(t('browser.urlInvalid')));
      return null;
    }
    const mode = requestedMode || current.mode;
    const siteVersion: BrowserSiteVersion = requestedSiteVersion === 'desktop'
      ? 'desktop'
      : requestedSiteVersion === 'mobile'
        ? 'mobile'
        : current.mode === 'proxy' && current.siteVersion === 'desktop' ? 'desktop' : 'mobile';
    if (mode === 'proxy' && !browserProxy) {
      setError(new Error(t('browser.proxyUnavailable')));
      return null;
    }
    setError(null);
    const sequence = (navigateSequence.current.get(id) || 0) + 1;
    navigateSequence.current.set(id, sequence);
    navigatingTabs.current.set(id, sequence);
    if (current.mode === 'proxy' && mode === 'direct') release(current);
    commitTabs((all) => all.map((tab) => {
      if (tab.id !== id) return tab;
      const next: RuntimeBrowserTab = {
        ...tab,
        mode,
        originalUrl: url,
        title: '',
      };
      return mode === 'direct'
        ? { ...withoutProxyState(next), url }
        : { ...withoutBinding(next), siteVersion };
    }));
    if (mode === 'proxy') {
      const prior = navigateQueues.current.get(id) || Promise.resolve();
      const request: Promise<BrowserBinding | null> = prior.catch(() => {}).then(async () => {
        if (current.mode === 'proxy') {
          return parseBinding(await navigateBrowserProxyLease(id, url, siteVersion));
        }
        const bound = await ensureBinding(id, { force: true });
        if (!bound?.url) return null;
        return {
          url: bound.url,
          ...(bound.channel ? { channel: bound.channel } : {}),
          ...(bound.generation != null ? { generation: bound.generation } : {}),
        };
      });
      navigateQueues.current.set(id, request);
      try {
        const binding = await request;
        if (navigateQueues.current.get(id) === request) navigateQueues.current.delete(id);
        const latest = tabsRef.current.find((tab) => tab.id === id);
        if (latest && navigateSequence.current.get(id) === sequence
          && latest.mode === mode
          && latest.originalUrl === url
          && latest.siteVersion === siteVersion) {
          if (binding?.url) {
            applyBinding(id, binding);
            setError(null);
          } else {
            navigatingTabs.current.delete(id);
          }
        }
      } catch (nextError: unknown) {
        if (navigateQueues.current.get(id) === request) navigateQueues.current.delete(id);
        const latest = tabsRef.current.find((tab) => tab.id === id);
        if (latest && navigateSequence.current.get(id) === sequence
          && latest.mode === mode
          && latest.originalUrl === url
          && latest.siteVersion === siteVersion) {
          commitTabs((all) => all.map((tab) => tab.id === id
            ? withoutBinding(tab)
            : tab));
          const message = errorRecord(nextError).message || t('browser.loadFailed');
          setError(nextError instanceof Error ? nextError : new Error(message));
          navigatingTabs.current.delete(id);
        }
      }
    } else if (navigateSequence.current.get(id) === sequence) {
      navigatingTabs.current.delete(id);
    }
    return tabsRef.current.find((tab) => tab.id === id) || null;
  }, [applyBinding, browserProxy, commitTabs, ensureBinding, release]);

  const updateTabMeta = useCallback((
    id: string,
    patch?: { url?: unknown; title?: unknown } | null,
  ): RuntimeBrowserTab | null | undefined => {
    if (navigatingTabs.current.has(id)) return null;
    const tab = tabsRef.current.find((candidate) => candidate.id === id);
    if (!tab) return undefined;
    const updated: RuntimeBrowserTab = {
      ...tab,
      originalUrl: normalizeBrowserInput(patch?.url) || tab.originalUrl,
      title: typeof patch?.title === 'string' ? patch.title : tab.title,
    };
    commitTabs((all) => all.map((candidate) => candidate.id === id ? updated : candidate));
    if (updated.title) {
      upsertBrowserHistory({
        url: updated.originalUrl, title: updated.title, lastMode: updated.mode,
        visitedAt: Date.now(), sessionId: updated.id,
      });
      setHistory(readBrowserHistory());
    }
    return undefined;
  }, [commitTabs]);

  const markBindingReady = useCallback((id: string, channel: string): void => {
    const tab = tabsRef.current.find((item) => item.id === id);
    if (tab?.mode === 'proxy' && tab.channel === channel) navigatingTabs.current.delete(id);
  }, []);

  const setCloseAfter = useCallback((value: unknown): BrowserCloseAfter => {
    setBrowserCloseAfter(value);
    const saved = readBrowserPrefs().closeAfter;
    setCloseAfterState(saved);
    return saved;
  }, []);
  const setHistoryMode = useCallback((
    entry: BrowserHistoryEntry,
    mode: BrowserMode,
  ): BrowserHistoryEntry | null => {
    if (entry.kind === 'static') return null;
    upsertBrowserHistory({ ...entry, lastMode: mode });
    const next = readBrowserHistory();
    setHistory(next);
    return next.find((item) => item.kind !== 'static' && item.url === entry.url) || null;
  }, []);
  const recordStaticHistory = useCallback((entry: unknown): void => {
    const candidate = recordOf(entry);
    upsertBrowserHistory({
      kind: 'static',
      dir: candidate?.dir,
      title: candidate?.title,
      visitedAt: Date.now(),
    });
    setHistory(readBrowserHistory());
  }, []);

  const saveProfilePrefs = useCallback(async (
    change: Partial<ProxyProfilePrefs>,
  ): Promise<boolean> => {
    const next: ProxyProfilePrefs = {
      persist: change.persist ?? pendingProfilePrefs.current.persist,
      retentionDays: change.retentionDays !== undefined
        ? change.retentionDays
        : pendingProfilePrefs.current.retentionDays,
    };
    pendingProfilePrefs.current = next;
    try {
      const response = await enqueueProfileOperation(async () => {
        const saved = parseProfileResponse(await setBrowserProxyProfilePrefs(next));
        persistProxyLoginLocally(saved.persist);
        persistProxyLoginRetentionLocally(saved.retentionDays);
        return saved;
      });
      setPersistProxyLoginState(response.persist);
      setProxyLoginRetentionDaysState(response.retentionDays);
      return true;
    } catch {
      setError(new Error(t('browser.profileSaveFailed')));
      return false;
    }
  }, [enqueueProfileOperation]);

  const clearProxyLogin = useCallback(async (origin: string | null = null): Promise<boolean> => {
    try {
      await clearBrowserProxyProfile(origin);
      return true;
    } catch {
      setError(new Error(t('browser.profileClearFailed')));
      return false;
    }
  }, []);

  return {
    open, accessEnabled, consentOpen, tabs, activeId, historyActive, closeAfter,
    persistProxyLogin, proxyLoginRetentionDays, proxyAvailable: browserProxy, history, error,
    openUrl, enableAccess, disableAccess, setEnabled, cancelAccess, switchTab, closeTab, setOpen,
    setCloseAfter,
    setPersistProxyLogin: (value: unknown) => saveProfilePrefs({ persist: !!value }),
    setProxyLoginRetentionDays: (value: BrowserProfileRetention) => saveProfilePrefs({ retentionDays: value }),
    setProxyLoginPolicy: ({ persist, retentionDays }: ProxyProfilePrefs) => (
      saveProfilePrefs({ persist, retentionDays })
    ),
    clearProxyLogin, setHistoryMode, recordStaticHistory, navigateTab, ensureBinding, recoverBinding,
    markBindingReady, updateTabMeta,
    deleteHistory: (entry: BrowserHistoryEntry) => {
      deleteBrowserHistoryEntry(entry);
      setHistory(readBrowserHistory());
    },
    clearHistory: () => { clearBrowserHistory(); setHistory([]); },
  };
}
