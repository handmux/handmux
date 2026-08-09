import { useCallback, useState } from 'react';
import { t } from '../i18n';

export interface DocTabMeta {
  type?: string;
  name?: string;
  content?: unknown;
  mtime?: number | null;
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

// Undefined content/mtime means "reuse the existing value" (not "clear it").
const mergeMeta = (tab: DocTab, meta: DocTabMeta): DocTab => ({
  ...tab,
  type: meta.type ?? tab.type,
  name: meta.name ?? tab.name,
  content: meta.content !== undefined ? meta.content : tab.content,
  mtime: meta.mtime !== undefined ? meta.mtime : tab.mtime,
});

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
    content: meta.content,
    mtime: meta.mtime,
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
