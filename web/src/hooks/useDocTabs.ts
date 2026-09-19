import { useCallback, useState } from 'react';
import { t } from '../i18n';

export interface DocTabMeta {
  type?: string;
  name?: string;
  content?: unknown;
  mtime?: number | null;
  /** File-info fields (viewer's info popover): byte size + creation time. */
  size?: number;
  birthtimeMs?: number | null;
  /** The bytes are still being fetched: the tab is already open and the viewer shows its loading page. */
  loading?: boolean;
  /** A one-shot "jump to this heading" request from the opener (terminal/chat `file.md#heading` links).
   *  `at` makes every request a distinct object, so re-tapping the same link jumps again; null clears. */
  anchorRequest?: { anchor: string; at: number } | null;
}

export interface OpenDocMeta extends DocTabMeta {
  type: string;
  name: string;
}

export interface DocTab extends DocTabMeta {
  key: string;
  type: string;
  name: string;
  path?: string;
}

export interface DocTabsState {
  tabs: DocTab[];
  active: string;
}

export const HOME_TAB: DocTab = {
  key: 'home',
  type: 'home',
  name: t('doc.home'),
};

// Undefined content/mtime/size/birthtime means "reuse the existing value" (not "clear it").
const mergeMeta = (tab: DocTab, meta: DocTabMeta): DocTab => {
  const merged: DocTab = {
    ...tab,
    type: meta.type ?? tab.type,
    name: meta.name ?? tab.name,
  };
  const content = meta.content !== undefined ? meta.content : tab.content;
  const mtime = meta.mtime !== undefined ? meta.mtime : tab.mtime;
  const size = meta.size !== undefined ? meta.size : tab.size;
  const birthtimeMs = meta.birthtimeMs !== undefined ? meta.birthtimeMs : tab.birthtimeMs;
  if (content !== undefined) merged.content = content;
  else delete merged.content;
  if (mtime !== undefined) merged.mtime = mtime;
  else delete merged.mtime;
  if (size !== undefined) merged.size = size;
  else delete merged.size;
  if (birthtimeMs !== undefined) merged.birthtimeMs = birthtimeMs;
  else delete merged.birthtimeMs;
  // anchorRequest: undefined reuses, null clears, an object replaces (a new request).
  if (meta.loading !== undefined) merged.loading = meta.loading;
  else if (tab.loading !== undefined) merged.loading = tab.loading;
  if (meta.anchorRequest === null) delete merged.anchorRequest;
  else if (meta.anchorRequest !== undefined) merged.anchorRequest = meta.anchorRequest;
  else if (tab.anchorRequest !== undefined) merged.anchorRequest = tab.anchorRequest;
  return merged;
};

export function openDocState(state: DocTabsState, path: string, meta: OpenDocMeta): DocTabsState {
  if (state.tabs.some((tab) => tab.key === path)) {
    return {
      tabs: state.tabs.map((tab) => (tab.key === path ? mergeMeta(tab, meta) : tab)),
      active: path,
    };
  }
  const tab: DocTab = {
    key: path,
    type: meta.type,
    name: meta.name,
    ...(meta.content !== undefined ? { content: meta.content } : {}),
    ...(meta.mtime !== undefined ? { mtime: meta.mtime } : {}),
    ...(meta.size !== undefined ? { size: meta.size } : {}),
    ...(meta.birthtimeMs !== undefined ? { birthtimeMs: meta.birthtimeMs } : {}),
    ...(meta.loading !== undefined ? { loading: meta.loading } : {}),
    ...(meta.anchorRequest ? { anchorRequest: meta.anchorRequest } : {}),
    path,
  };
  return { tabs: [...state.tabs, tab], active: path };
}

export function refreshDocState(
  state: DocTabsState,
  key: string,
  meta: DocTabMeta,
): DocTabsState {
  if (!state.tabs.some((tab) => tab.key === key)) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.key === key ? mergeMeta(tab, meta) : tab)),
  };
}

export function closeTabState(state: DocTabsState, key: string): DocTabsState {
  const index = state.tabs.findIndex((tab) => tab.key === key);
  if (index <= 0) return state;
  const tabs = state.tabs.filter((tab) => tab.key !== key);
  const active = state.active === key ? state.tabs[index - 1]?.key ?? 'home' : state.active;
  return { tabs, active };
}

export function useDocTabs() {
  const [state, setState] = useState<DocTabsState>({ tabs: [HOME_TAB], active: 'home' });
  const openDoc = useCallback((path: string, meta: OpenDocMeta): void => {
    setState((current) => openDocState(current, path, meta));
  }, []);
  const refreshDoc = useCallback((key: string, meta: DocTabMeta): void => {
    setState((current) => refreshDocState(current, key, meta));
  }, []);
  const closeTab = useCallback((key: string): void => {
    setState((current) => closeTabState(current, key));
  }, []);
  const activate = useCallback((key: string): void => {
    setState((current) => ({ ...current, active: key }));
  }, []);
  return { tabs: state.tabs, active: state.active, openDoc, refreshDoc, closeTab, activate };
}
