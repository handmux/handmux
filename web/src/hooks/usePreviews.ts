import { useState, useEffect, useCallback, useRef } from 'react';
import type { SetStateAction } from 'react';
import { createPreview, deletePreview } from '../api.js';
import { previewName } from '../previewName.js';
import { getPreviewDir, setPreviewDir } from '../storage.js';

export interface PreviewCurrent {
  session?: { name?: string | null } | null;
  window?: { id?: string | null; name?: string | null } | null;
  paneId?: string | null;
}

export interface SavedPreviewTab {
  name: string;
  dir: string;
  createdAt?: number;
}

export type PreviewStatus = 'ensuring' | 'ready' | 'error';

interface PreviewRuntime {
  status: PreviewStatus;
  url?: string;
  error: Error | null;
}

export interface StaticPreviewTab extends SavedPreviewTab {
  kind: 'static';
  status: PreviewStatus;
  url: string | null;
  error: Error | null;
}

interface RestoredPreviewState {
  tabs: SavedPreviewTab[];
  duplicateNames: string[];
}

interface EnsurePreviewOptions {
  quiet?: boolean;
  allowDetached?: boolean;
}

interface PreviewLease extends Record<string, unknown> {
  url: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function previewLeaseOf(value: unknown): PreviewLease | null {
  const response = recordOf(value);
  return response && typeof response.url === 'string' && response.url
    ? { ...response, url: response.url }
    : null;
}

const STATIC_TABS_KEY = 'hm_static_preview_tabs1';

function readOpenTabState(): RestoredPreviewState {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STATIC_TABS_KEY) || '[]');
    if (!Array.isArray(value)) return { tabs: [], duplicateNames: [] };
    const valid = value.flatMap((candidate): SavedPreviewTab[] => {
      const item = recordOf(candidate);
      if (!item || !/^[A-Za-z0-9._-]+$/.test(String(item.name || ''))
        || typeof item.dir !== 'string' || !item.dir.startsWith('/')) return [];
      const createdAt = Number(item.createdAt);
      return [{
        name: String(item.name),
        dir: item.dir,
        ...(Number.isFinite(createdAt) && createdAt > 0 ? { createdAt } : {}),
      }];
    });
    const seenDirs = new Set<string>();
    const tabs: SavedPreviewTab[] = [];
    const duplicateNames: string[] = [];
    for (const tab of valid) {
      if (seenDirs.has(tab.dir)) duplicateNames.push(tab.name);
      else {
        seenDirs.add(tab.dir);
        tabs.push(tab);
      }
    }
    return { tabs, duplicateNames };
  } catch {
    return { tabs: [], duplicateNames: [] };
  }
}

function writeOpenTabs(tabs: readonly SavedPreviewTab[]): void {
  try {
    localStorage.setItem(STATIC_TABS_KEY, JSON.stringify(tabs.map(({ name, dir, createdAt }) => ({
      name,
      dir,
      ...(typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0
        ? { createdAt }
        : {}),
    }))));
  } catch {
    // Keep the current in-memory tabs usable when device storage is unavailable.
  }
}

// Device-local static tabs backed by server leases. Opening/foregrounding ensures the lease exists;
// actual preview traffic renews it server-side, so there is no client heartbeat or expiry UI.
export function usePreviews(current?: PreviewCurrent | null) {
  const restored = useRef<RestoredPreviewState | null>(null);
  if (!restored.current) restored.current = readOpenTabState();
  const restoredState = restored.current;
  const [openTabs, setOpenTabs] = useState<SavedPreviewTab[]>(restoredState.tabs);
  const [runtime, setRuntime] = useState<Record<string, PreviewRuntime>>({});
  const [activeTabName, setActiveTabName] = useState<string | null>(null);
  const [selected, setSelected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const openTabsRef = useRef(openTabs);
  const runtimeRef = useRef(runtime);
  const previewOperations = useRef(new Map<string, Promise<unknown>>());
  openTabsRef.current = openTabs;
  runtimeRef.current = runtime;

  const commitOpenTabs = useCallback((
    update: SetStateAction<SavedPreviewTab[]>,
  ): SavedPreviewTab[] => {
    const next = typeof update === 'function' ? update(openTabsRef.current) : update;
    openTabsRef.current = next;
    setOpenTabs(next);
    writeOpenTabs(next);
    return next;
  }, []);

  const setTabRuntime = useCallback((name: string, value: PreviewRuntime): void => {
    setRuntime((currentRuntime) => {
      const next = { ...currentRuntime, [name]: value };
      runtimeRef.current = next;
      return next;
    });
  }, []);

  const clearTabRuntime = useCallback((name: string): void => {
    setRuntime((currentRuntime) => {
      if (!(name in currentRuntime)) return currentRuntime;
      const next = { ...currentRuntime };
      delete next[name];
      runtimeRef.current = next;
      return next;
    });
  }, []);

  const enqueuePreviewOperation = useCallback(<T,>(
    name: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    const previous = previewOperations.current.get(name) || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    const tail = pending.catch(() => {});
    previewOperations.current.set(name, tail);
    return pending.finally(() => {
      if (previewOperations.current.get(name) === tail) previewOperations.current.delete(name);
    });
  }, []);

  const ensurePreview = useCallback((
    tab: SavedPreviewTab,
    { quiet = false, allowDetached = false }: EnsurePreviewOptions = {},
  ): Promise<PreviewLease | null> => (
    enqueuePreviewOperation(tab.name, async () => {
      const prior = runtimeRef.current[tab.name];
      if (!quiet || prior?.status !== 'ready') {
        setTabRuntime(tab.name, { ...prior, status: 'ensuring', error: null });
      }
      try {
        const created = previewLeaseOf(await createPreview(tab.name, { dir: tab.dir }));
        if (!created) {
          throw new Error('preview URL unavailable');
        }
        // A user can close a restoring tab while registration is in flight. Release a late result instead
        // of leaving an invisible server lease behind. A newly chosen directory is intentionally detached
        // until registration succeeds and the tab is added below.
        if (!allowDetached && !openTabsRef.current.some((item) => item.name === tab.name)) {
          await deletePreview(tab.name).catch(() => {});
          clearTabRuntime(tab.name);
          return null;
        }
        setTabRuntime(tab.name, {
          status: 'ready',
          url: created.url,
          error: null,
        });
        setError(null);
        return created;
      } catch (nextError) {
        if (!allowDetached && !openTabsRef.current.some((item) => item.name === tab.name)) {
          clearTabRuntime(tab.name);
          return null;
        }
        if (quiet && prior?.status === 'ready') return null;
        const normalized = nextError instanceof Error ? nextError : new Error(String(nextError));
        setTabRuntime(tab.name, { ...prior, status: 'error', error: normalized });
        setError(normalized);
        return null;
      }
    })
  ), [clearTabRuntime, enqueuePreviewOperation, setTabRuntime]);

  useEffect(() => {
    // Older builds could persist the same directory under different tmux-window-derived names. Keep
    // the original tab, repair local state, and release the duplicate leases instead of restoring both.
    writeOpenTabs(openTabsRef.current);
    const duplicateNames = restoredState.duplicateNames.splice(0);
    void Promise.all(duplicateNames.map((name) => deletePreview(name).catch(() => {})));
    void Promise.all(openTabsRef.current.map((tab) => ensurePreview(tab)));
    const onVisibility = () => {
      if (!document.hidden) {
        void Promise.all(openTabsRef.current.map((tab) => ensurePreview(tab, { quiet: true })));
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [ensurePreview]);

  const curPreviewName = current
    ? previewName({
      session: current.session?.name ?? null,
      windowName: current.window?.name ?? null,
      windowId: current.window?.id ?? null,
    })
    : null;
  const tabs: StaticPreviewTab[] = openTabs.map((saved) => ({
    ...saved,
    kind: 'static' as const,
    status: runtime[saved.name]?.status || 'ensuring',
    url: runtime[saved.name]?.url || null,
    error: runtime[saved.name]?.error || null,
  }));
  const activeName = tabs.find((tab) => tab.name === activeTabName)?.name ?? tabs[0]?.name ?? null;
  const shownPreview = selected ? (tabs.find((tab) => tab.name === activeName) || null) : null;

  const startPreview = useCallback(async (dir: string): Promise<(SavedPreviewTab & PreviewLease) | null> => {
    if (!curPreviewName) return null;
    const sameDirectory = openTabsRef.current.find((item) => item.dir === dir);
    if (sameDirectory) {
      setPreviewDir(current?.window?.id ?? undefined, dir);
      setActiveTabName(sameDirectory.name);
      setSelected(true);
      const prior = runtimeRef.current[sameDirectory.name];
      if (prior?.status === 'ready' && prior.url) {
        return { ...sameDirectory, ...prior, url: prior.url };
      }
      const pending = previewOperations.current.get(sameDirectory.name);
      const created = pending
        ? previewLeaseOf(await pending)
        : await ensurePreview(sameDirectory);
      return created ? { ...sameDirectory, ...created } : null;
    }
    const existing = openTabsRef.current.find((item) => item.name === curPreviewName);
    const tab = { name: curPreviewName, dir, createdAt: existing?.createdAt || Date.now() };
    const created = await ensurePreview(tab, { allowDetached: true });
    if (!created) return null;
    setPreviewDir(current?.window?.id ?? undefined, dir);
    commitOpenTabs((currentTabs) => [...currentTabs.filter((item) => item.name !== tab.name), tab]);
    setActiveTabName(tab.name);
    setSelected(true);
    return { ...tab, ...created };
  }, [commitOpenTabs, curPreviewName, current?.window?.id, ensurePreview]);

  const retryPreview = useCallback((name: string | null = activeName): Promise<PreviewLease | null> => {
    const target = openTabsRef.current.find((tab) => tab.name === name);
    return target ? ensurePreview(target) : Promise.resolve(null);
  }, [activeName, ensurePreview]);

  const switchTab = useCallback((name: string): void => {
    if (!openTabsRef.current.some((tab) => tab.name === name)) return;
    setActiveTabName(name);
    setSelected(true);
  }, []);
  const deactivate = useCallback((): void => setSelected(false), []);

  const closeTab = useCallback(async (name: string | null): Promise<void> => {
    if (!name) return;
    setError(null);
    const remaining = commitOpenTabs((currentTabs) => currentTabs.filter((tab) => tab.name !== name));
    clearTabRuntime(name);
    if (activeTabName === name) {
      setActiveTabName(remaining[0]?.name || null);
      if (!remaining.length) setSelected(false);
    }
    try {
      await enqueuePreviewOperation(name, () => deletePreview(name));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError : new Error(String(nextError)));
    }
  }, [activeTabName, clearTabRuntime, commitOpenTabs, enqueuePreviewOperation]);

  return {
    error,
    selected, deactivate,
    curPreviewName,
    tabs, activeName, shownPreview,
    startPreview, retryPreview,
    switchTab, closeTab,
    pane: current?.paneId || null,
    lastPreviewDir: getPreviewDir(current?.window?.id ?? undefined),
  };
}
