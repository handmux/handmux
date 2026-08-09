import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ChevronDownIcon,
  FolderIcon,
  GlobeIcon,
  HomeIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshIcon,
  StopIcon,
  XIcon,
} from './icons.jsx';
import { BROWSER_CLOSE_AFTER_OPTIONS } from '../browserState.js';
import { fetchPaneCwd } from '../api.js';
import { t } from '../i18n';
import { useModalFocusTrap } from '../hooks/useModalFocusTrap.js';
import DirPicker from './DirPicker.jsx';
import { OverlayPortal } from '../overlays/OverlayHost.js';
import type { BrowserCloseAfter, BrowserHistoryEntry, BrowserMode } from '../browserState.js';
import type { RuntimeBrowserTab, useBrowser } from '../hooks/useBrowser.js';
import type { StaticPreviewTab, usePreviews } from '../hooks/usePreviews.js';
import type { ComponentType, CSSProperties, FormEvent } from 'react';

type BrowserController = ReturnType<typeof useBrowser>;
type StaticPreviewController = ReturnType<typeof usePreviews>;
type BrowserSiteVersion = 'mobile' | 'desktop';

interface BrowserSheetProps {
  browser: BrowserController;
  staticPreview: StaticPreviewController;
}

interface DirPickerProps {
  open: boolean;
  seedCwd?: string | null;
  pane?: string | null;
  hint?: string;
  onPick: (dir: string) => void | Promise<void>;
  onClose: () => void;
}

const TypedDirPicker = DirPicker as unknown as ComponentType<DirPickerProps>;

interface StaticOpenTab {
  name: string;
  dir: string;
  createdAt?: number;
}

type OpenTabEntry = {
  kind: 'web';
  tab: RuntimeBrowserTab;
  legacyIndex: number;
  createdAt: number;
} | {
  kind: 'static';
  tab: StaticPreviewTab;
  legacyIndex: number;
  createdAt: number;
};

type ClearConfirmation =
  | { type: 'site'; origin: string }
  | { type: 'all' | 'help-profile' | 'help-site' | 'help-about' };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// URL pages are cross-origin (the target origin in direct mode, a dedicated origin in proxy mode),
// so same-origin is needed for normal site compatibility without exposing the Handmux app origin.
const FRAME_SANDBOX = 'allow-scripts allow-forms allow-downloads allow-modals allow-popups allow-same-origin';
// Static content is served by the Handmux HTTP process, so it must keep an opaque origin even though the
// capability URL itself is same-origin. Otherwise project JavaScript could read the parent app's token.
const STATIC_FRAME_SANDBOX = 'allow-scripts allow-forms allow-downloads allow-modals allow-popups';
const PAGE_ZOOM_STEPS = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const SESSION_RECOVERY_LOCK_MS = 15_000;

function tabLabel(tab: RuntimeBrowserTab): string {
  if (tab.title) return tab.title;
  try { return new URL(tab.originalUrl).hostname; } catch { return tab.originalUrl; }
}

function staticTabLabel(tab: StaticOpenTab): string {
  return tab.dir?.split('/').filter(Boolean).at(-1) || tab.name;
}

function orderedOpenTabs(
  webTabs: RuntimeBrowserTab[],
  staticTabs: StaticPreviewTab[],
): OpenTabEntry[] {
  const entries = [
    ...webTabs.map((tab) => ({ kind: 'web' as const, tab })),
    ...staticTabs.map((tab) => ({ kind: 'static' as const, tab })),
  ].map((entry, legacyIndex) => ({
    ...entry,
    legacyIndex,
    createdAt: Number(entry.tab.createdAt),
  }));
  return entries.sort((left, right) => {
    const leftOrdered = Number.isFinite(left.createdAt) && left.createdAt > 0;
    const rightOrdered = Number.isFinite(right.createdAt) && right.createdAt > 0;
    if (leftOrdered !== rightOrdered) return leftOrdered ? 1 : -1;
    if (leftOrdered && left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return left.legacyIndex - right.legacyIndex;
  });
}

export default function BrowserSheet({ browser, staticPreview }: BrowserSheetProps) {
  const {
    open, accessEnabled, consentOpen, tabs, activeId, historyActive, closeAfter, history, error,
    persistProxyLogin, proxyAvailable,
    openUrl, switchTab, closeTab, setOpen, setCloseAfter,
    navigateTab, ensureBinding, recoverBinding, markBindingReady, updateTabMeta,
    clearHistory, setHistoryMode, enableAccess, cancelAccess,
    setProxyLoginPolicy, recordStaticHistory,
    clearProxyLogin, deleteHistory,
  } = browser;
  const webActive = tabs.find((tab) => tab.id === activeId) || null;
  const staticActive = staticPreview?.selected ? staticPreview.shownPreview : null;
  const staticSelected = !!staticActive;
  const homeActive = historyActive && !staticSelected;
  const active = staticActive || webActive;
  const proxied = webActive?.mode === 'proxy' && !staticSelected;
  const [newPageMode, setNewPageMode] = useState<BrowserMode>('direct');
  const menuMode = staticSelected ? 'static' : (homeActive || !webActive ? newPageMode : webActive.mode);
  const [address, setAddress] = useState(webActive?.originalUrl || '');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const [pageWidth, setPageWidth] = useState<'narrow' | 'wide'>('narrow');
  const [bodySize, setBodySize] = useState({ width: 0, height: 0 });
  const [loadedTabs, setLoadedTabs] = useState(() => new Set<string>());
  const [refreshingTabs, setRefreshingTabs] = useState(() => new Set<string>());
  const [reloadKeys, setReloadKeys] = useState<Record<string, number>>({});
  const [historyModeOpen, setHistoryModeOpen] = useState<string | null>(null);
  const [clearConfirmation, setClearConfirmation] = useState<ClearConfirmation | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [mountedTabs, setMountedTabs] = useState(() => new Set<string>());
  const [unhealthyTabs, setUnhealthyTabs] = useState(() => new Set<string>());
  const [pageZoom, setPageZoom] = useState(1);
  const [dirOpen, setDirOpen] = useState(false);
  const [seedCwd, setSeedCwd] = useState<string | null>(null);
  const [mountedStaticTabs, setMountedStaticTabs] = useState(() => new Set<string>());
  const [loadedStaticTabs, setLoadedStaticTabs] = useState(() => new Set<string>());
  const [staticReloadKeys, setStaticReloadKeys] = useState<Record<string, number>>({});
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const frameUrls = useRef(new Map<string, string | undefined>());
  const staticFrameUrls = useRef(new Map<string, string | null>());
  const refreshSequences = useRef(new Map<string, number>());
  const recoveringSessions = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const activeIdRef = useRef(activeId);
  const openRef = useRef(open);
  const activeTabRef = useRef<HTMLSpanElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const clearTriggerRef = useRef<HTMLElement | null>(null);
  const clearCancelRef = useRef<HTMLButtonElement | null>(null);
  const clearDialogRef = useRef<HTMLDivElement | null>(null);
  activeIdRef.current = activeId;
  openRef.current = open;

  const clearSessionRecovery = useCallback((id: string): void => {
    const timer = recoveringSessions.current.get(id);
    if (timer != null) clearTimeout(timer);
    recoveringSessions.current.delete(id);
  }, []);

  useEffect(() => {
    setAddress(staticSelected ? (staticActive?.dir || '') : (homeActive ? '' : (webActive?.originalUrl || '')));
  }, [homeActive, staticActive?.dir, staticSelected, webActive?.originalUrl]);

  useEffect(() => {
    if (!proxyAvailable) setNewPageMode('direct');
  }, [proxyAvailable]);

  useEffect(() => {
    setOptionsOpen(false);
    setTimeOpen(false);
    if (!homeActive) setHistoryModeOpen(null);
  }, [activeId, homeActive, open, staticActive?.name]);

  useEffect(() => {
    setPageZoom(1);
  }, [activeId, pageWidth, homeActive, staticActive?.name]);

  useEffect(() => {
    if (!staticSelected || !staticActive) return;
    setMountedStaticTabs((current) => new Set(current).add(staticActive.name));
  }, [staticActive?.name, staticSelected]);

  useEffect(() => {
    if (!staticSelected || staticActive?.status !== 'ready') return;
    recordStaticHistory?.({ dir: staticActive.dir, title: staticTabLabel(staticActive) });
  }, [recordStaticHistory, staticActive?.dir, staticActive?.name, staticActive?.status, staticSelected]);

  useLayoutEffect(() => {
    if (!open || homeActive || (!activeId && !staticActive?.name)) return;
    activeTabRef.current?.scrollIntoView?.({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [activeId, homeActive, open, staticActive?.name, staticPreview?.tabs?.length, tabs.length]);

  useEffect(() => {
    if (!accessEnabled) {
      setMountedTabs(new Set());
      return;
    }
    if (!open || historyActive || staticSelected || !webActive) return;
    setMountedTabs((current) => new Set(current).add(webActive.id));
    if (webActive.mode === 'proxy' && unhealthyTabs.has(webActive.id)) {
      setUnhealthyTabs((current) => {
        const next = new Set(current);
        next.delete(webActive.id);
        return next;
      });
      void recoverBinding(webActive.id);
    } else if (webActive.mode === 'proxy' && !webActive.url) {
      void ensureBinding(webActive.id);
    }
  }, [
    accessEnabled, ensureBinding, historyActive, open, recoverBinding, staticSelected, unhealthyTabs,
    webActive?.id, webActive?.mode, webActive?.url,
  ]);

  useModalFocusTrap({
    active: !!clearConfirmation,
    dialogRef: clearDialogRef,
    initialFocusRef: clearCancelRef,
    returnFocusRef: clearTriggerRef,
    onClose: () => setClearConfirmation(null),
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = recordOf(event.data);
      if (data?.source !== 'handmux-browser') return;
      const frameEntry = [...frames.current.entries()]
        .find(([, frame]) => frame.contentWindow === event.source);
      const tab = frameEntry && tabs.find((item) => item.id === frameEntry[0]);
      if (!tab || tab.mode !== 'proxy') return;
      if (data.type === 'session-unavailable') {
        if (tab.channel !== data.channel) return;
        if (!openRef.current || activeIdRef.current !== tab.id) {
          setUnhealthyTabs((current) => new Set(current).add(tab.id));
          return;
        }
        if (recoveringSessions.current.has(tab.id)) return;
        const timer = setTimeout(() => {
          if (recoveringSessions.current.get(tab.id) === timer) {
            recoveringSessions.current.delete(tab.id);
          }
        }, SESSION_RECOVERY_LOCK_MS);
        recoveringSessions.current.set(tab.id, timer);
        void recoverBinding(tab.id).then((binding) => {
          if (!binding) clearSessionRecovery(tab.id);
        });
        return;
      }
      if (tab.channel !== data.channel) return;
      if (data.type === 'ready') {
        clearSessionRecovery(tab.id);
        if (typeof data.channel === 'string') markBindingReady(tab.id, data.channel);
        setUnhealthyTabs((current) => {
          if (!current.has(tab.id)) return current;
          const next = new Set(current);
          next.delete(tab.id);
          return next;
        });
      }
      if (data.type === 'navigate') {
        setRefreshingTabs((current) => new Set(current).add(tab.id));
      }
      if (typeof data.type === 'string' && ['ready', 'load', 'urlchange', 'title'].includes(data.type)) {
        updateTabMeta(tab.id, { url: data.url, title: data.title });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [clearSessionRecovery, markBindingReady, recoverBinding, tabs, updateTabMeta]);

  useEffect(() => {
    const live = new Set(tabs.map((tab) => tab.id));
    const liveProxy = new Set(tabs.filter((tab) => tab.mode === 'proxy').map((tab) => tab.id));
    for (const id of refreshSequences.current.keys()) {
      if (!live.has(id)) refreshSequences.current.delete(id);
    }
    for (const id of recoveringSessions.current.keys()) {
      if (!liveProxy.has(id)) clearSessionRecovery(id);
    }
    setLoadedTabs((current) => {
      const next = new Set<string>();
      for (const tab of tabs) {
        if (current.has(tab.id) && frameUrls.current.get(tab.id) === tab.url) next.add(tab.id);
      }
      frameUrls.current = new Map(tabs.map((tab) => [tab.id, tab.url]));
      return next;
    });
    setMountedTabs((current) => new Set([...current].filter((id) => live.has(id))));
    setUnhealthyTabs((current) => {
      return new Set([...current].filter((id) => live.has(id)));
    });
  }, [clearSessionRecovery, tabs]);

  useEffect(() => () => {
    for (const timer of recoveringSessions.current.values()) clearTimeout(timer);
    recoveringSessions.current.clear();
  }, []);

  useEffect(() => {
    const staticTabs = staticPreview?.tabs || [];
    const live = new Set(staticTabs.map((tab) => tab.name));
    setLoadedStaticTabs((current) => {
      const next = new Set<string>();
      for (const tab of staticTabs) {
        if (current.has(tab.name) && staticFrameUrls.current.get(tab.name) === tab.url) next.add(tab.name);
      }
      staticFrameUrls.current = new Map(staticTabs.map((tab) => [tab.name, tab.url]));
      return next;
    });
    setMountedStaticTabs((current) => new Set([...current].filter((name) => live.has(name))));
    setStaticReloadKeys((current) => Object.fromEntries(
      Object.entries(current).filter(([name]) => live.has(name)),
    ));
  }, [staticPreview?.tabs]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!open || !body) return undefined;
    const measure = () => setBodySize({
      width: body.clientWidth,
      height: body.clientHeight,
    });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [open]);

  const postTabCommand = useCallback((
    tab: RuntimeBrowserTab | null,
    command: string,
  ): void => {
    if (!tab || tab.mode !== 'proxy') return;
    frames.current.get(tab.id)?.contentWindow?.postMessage({
      source: 'handmux-browser-parent',
      channel: tab.channel,
      command,
    }, '*');
  }, []);

  const postCommand = (command: string): void => postTabCommand(webActive, command);

  const selectTab = (tab: RuntimeBrowserTab): void => {
    setOptionsOpen(false);
    setHistoryError(null);
    staticPreview?.deactivate();
    switchTab(tab.id);
  };

  const selectStaticTab = (tab: StaticPreviewTab): void => {
    setOptionsOpen(false);
    setHistoryError(null);
    switchTab('history');
    staticPreview?.switchTab(tab.name);
  };

  const selectHistory = () => {
    setOptionsOpen(false);
    setHistoryError(null);
    setNewPageMode('direct');
    staticPreview?.deactivate();
    return switchTab('history');
  };

  const refreshActive = async () => {
    if (!active) return;
    if (staticSelected) {
      if (staticActive.status === 'error') await staticPreview.retryPreview(staticActive.name);
      else if (staticActive.status === 'ready') {
        setLoadedStaticTabs((current) => {
          const next = new Set(current);
          next.delete(staticActive.name);
          return next;
        });
        setStaticReloadKeys((current) => ({
          ...current,
          [staticActive.name]: (current[staticActive.name] || 0) + 1,
        }));
      }
      return;
    }
    if (!webActive) return;
    const tab = webActive;
    const sequence = (refreshSequences.current.get(tab.id) || 0) + 1;
    refreshSequences.current.set(tab.id, sequence);
    setRefreshingTabs((current) => new Set(current).add(tab.id));
    if (!proxied) {
      setReloadKeys((current) => ({ ...current, [tab.id]: (current[tab.id] || 0) + 1 }));
      return;
    }
    const navigated = await navigateTab(tab.id, tab.originalUrl, tab.mode);
    if (refreshSequences.current.get(tab.id) !== sequence) return;
    if (navigated?.id === tab.id && navigated.mode === 'proxy' && navigated.url) {
      setReloadKeys((current) => ({ ...current, [tab.id]: (current[tab.id] || 0) + 1 }));
      return;
    }
    setRefreshingTabs((current) => {
      const next = new Set(current);
      next.delete(tab.id);
      return next;
    });
  };

  const stopActive = () => {
    if (!webActive) return;
    refreshSequences.current.set(webActive.id, (refreshSequences.current.get(webActive.id) || 0) + 1);
    postCommand('stop');
    frameUrls.current.set(webActive.id, webActive.url);
    setLoadedTabs((current) => new Set(current).add(webActive.id));
    setRefreshingTabs((current) => {
      const next = new Set(current);
      next.delete(webActive.id);
      return next;
    });
  };

  const frameLoaded = (tab: RuntimeBrowserTab): void => {
    frameUrls.current.set(tab.id, tab.url);
    setLoadedTabs((current) => new Set(current).add(tab.id));
    setRefreshingTabs((current) => {
      const next = new Set(current);
      next.delete(tab.id);
      return next;
    });
  };

  const staticFrameLoaded = (tab: StaticPreviewTab): void => {
    staticFrameUrls.current.set(tab.name, tab.url);
    setLoadedStaticTabs((current) => new Set(current).add(tab.name));
  };

  const submitAddress = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (staticSelected) return;
    setHistoryError(null);
    staticPreview?.deactivate();
    if (homeActive || !webActive) openUrl(address, { mode: newPageMode });
    else navigateTab(webActive.id, address);
  };

  const chooseMode = (mode: BrowserMode): void => {
    if (staticSelected || mode === menuMode || (mode === 'proxy' && !proxyAvailable)) return;
    setHistoryError(null);
    if (homeActive || !webActive) {
      setNewPageMode(mode);
      return;
    }
    navigateTab(webActive.id, webActive.originalUrl, mode);
  };

  const requestSiteVersion = async (siteVersion: BrowserSiteVersion): Promise<void> => {
    if (!proxied || !webActive || webActive.siteVersion === siteVersion) return;
    setRefreshingTabs((current) => new Set(current).add(webActive.id));
    const navigated = await navigateTab(
      webActive.id,
      webActive.originalUrl,
      'proxy',
      siteVersion,
    );
    if (navigated?.id === webActive.id && navigated.url) return;
    setRefreshingTabs((current) => {
      const next = new Set(current);
      next.delete(webActive.id);
      return next;
    });
  };

  const openHistory = (
    entry: BrowserHistoryEntry,
    mode: BrowserMode = entry.kind === 'static' ? 'direct' : entry.lastMode || 'direct',
    persistMode = false,
  ): void => {
    setHistoryModeOpen(null);
    if (entry.kind === 'static') {
      setHistoryError(null);
      void staticPreview?.startPreview(entry.dir);
      return;
    }
    if (mode === 'proxy' && !proxyAvailable) {
      setHistoryError(t('browser.proxyUnavailable'));
      return;
    }
    setHistoryError(null);
    if (persistMode) setHistoryMode(entry, mode);
    openUrl(entry.url, { mode });
  };

  const requestActiveSiteClear = () => {
    if (!webActive) return;
    let origin: string;
    try { origin = new URL(webActive.originalUrl).origin; } catch { return; }
    clearTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setClearConfirmation({ type: 'site', origin });
  };

  const confirmSiteClear = () => {
    const pending = clearConfirmation;
    setClearConfirmation(null);
    if (pending?.type === 'site') clearProxyLogin(pending.origin);
    if (pending?.type === 'all') clearProxyLogin(null);
  };

  const removeHistory = (entry: BrowserHistoryEntry): void => {
    setHistoryModeOpen(null);
    deleteHistory(entry);
  };

  const newTab = () => {
    selectHistory();
    setAddress('');
    requestAnimationFrame(() => addressRef.current?.focus());
  };

  const openDirPicker = async () => {
    addressRef.current?.blur();
    let seed = staticPreview?.lastPreviewDir || null;
    if (!seed && staticPreview?.pane) {
      try {
        const response = recordOf(await fetchPaneCwd(staticPreview.pane));
        seed = typeof response?.cwd === 'string' ? response.cwd : null;
      } catch { /* picker falls back home */ }
    }
    setSeedCwd(seed);
    setDirOpen(true);
  };

  const pickDirectory = async (dir: string): Promise<void> => {
    setDirOpen(false);
    await staticPreview?.startPreview(dir);
  };

  const pickTime = (value: BrowserCloseAfter): void => {
    setCloseAfter(value);
    setTimeOpen(false);
  };
  const zoomPageBy = (direction: number): void => setPageZoom((current) => {
    if (direction > 0) return PAGE_ZOOM_STEPS.find((value) => value > current) || current;
    return [...PAGE_ZOOM_STEPS].reverse().find((value) => value < current) || current;
  });
  const previewWidth = pageWidth === 'wide' ? 1280 : 390;
  const previewScale = bodySize.width > 0
    ? (pageWidth === 'wide'
      ? bodySize.width / previewWidth
      : Math.min(1, bodySize.width / previewWidth))
    : 1;
  const scalerStyleFor = (zoom: number): CSSProperties => {
    const scaledWidth = Math.round(previewWidth * previewScale * zoom * 1000) / 1000;
    const scaledHeight = Math.round(bodySize.height * zoom * 1000) / 1000;
    const scaledPercent = Math.round(zoom * 1000) / 10;
    return {
      width: `${scaledWidth}px`,
      height: bodySize.height > 0 ? `${scaledHeight}px` : `${scaledPercent}%`,
      marginInline: pageWidth === 'narrow' && previewScale === 1 ? 'auto' : undefined,
    };
  };
  const frameStyleFor = (zoom: number): CSSProperties => {
    return {
      width: `${previewWidth}px`,
      height: bodySize.height > 0 ? `${bodySize.height / previewScale}px` : '100%',
      transform: `scale(${previewScale * zoom})`,
      transformOrigin: '0 0',
    };
  };
  const activeLoading = staticSelected
    ? staticActive.status === 'ensuring' || (staticActive.status === 'ready'
      && (!loadedStaticTabs.has(staticActive.name)
        || staticFrameUrls.current.get(staticActive.name) !== staticActive.url))
    : !!webActive && (!loadedTabs.has(webActive.id)
      || frameUrls.current.get(webActive.id) !== webActive.url || refreshingTabs.has(webActive.id));
  const displayedError = historyError
    || (homeActive ? staticPreview?.error : null)
    || (!staticSelected ? error : null);
  const tabStripEntries = orderedOpenTabs(tabs, staticPreview?.tabs || []);

  if (consentOpen) return (
    <OverlayPortal>
      <div className="file-sheet browser-sheet open browser-consent" role="dialog" aria-modal="true" aria-label={t('browser.consentTitle')}>
        <div className="browser-consent-card">
          <GlobeIcon />
          <h2>{t('browser.consentTitle')}</h2>
          <p>{t('browser.consentBody')}</p>
          <ul>
            <li>{t('browser.consentComputer')}</li>
            <li>{t('browser.consentPrivate')}</li>
            <li>{t('browser.consentLimits')}</li>
            <li>{t('browser.consentIdle')}</li>
          </ul>
          <div className="browser-consent-actions">
            <button onClick={cancelAccess}>{t('common.cancel')}</button>
            <button className="browser-consent-enable" onClick={enableAccess}>{t('browser.acknowledge')}</button>
          </div>
        </div>
      </div>
    </OverlayPortal>
  );

  return (
    <OverlayPortal>
      <div className={`file-sheet browser-sheet ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="browser-tabs" role="tablist" aria-label={t('browser.openTabs')}
        inert={clearConfirmation ? '' : undefined}>
        <button className={`browser-tab browser-history-tab ${homeActive ? 'active' : ''}`} role="tab"
          aria-selected={homeActive} aria-label={t('browser.history')} title={t('browser.history')}
          onClick={selectHistory}>
          <HomeIcon />
        </button>
        <div className="browser-tabs-scroll">
          {tabStripEntries.map(({ kind, tab }) => {
            if (kind === 'web') {
              const selected = !staticSelected && !historyActive && tab.id === activeId;
              const label = tabLabel(tab);
              return (
                <span ref={selected ? activeTabRef : null}
                  className={`browser-tab-wrap ${tab.mode} ${selected ? 'active' : ''}`} key={tab.id}>
                  <button className="browser-tab" role="tab" aria-selected={selected} title={tab.originalUrl}
                    onClick={() => selectTab(tab)}>
                    <span className="browser-tab-label">{label}</span>
                  </button>
                  {selected && (
                    <button className="browser-tab-close" aria-label={t('browser.closeTab', { title: label })}
                      onClick={() => closeTab(tab.id)}><XIcon /></button>
                  )}
                </span>
              );
            }
            const selected = staticSelected && tab.name === staticActive?.name;
            const label = staticTabLabel(tab);
            return (
              <span ref={selected ? activeTabRef : null}
                className={`browser-tab-wrap static ${selected ? 'active' : ''}`} key={`static:${tab.name}`}>
                <button className="browser-tab" role="tab" aria-selected={selected} title={tab.dir}
                  onClick={() => selectStaticTab(tab)}>
                  <span className="browser-tab-label">{label}</span>
                </button>
                {selected && (
                  <button className="browser-tab-close" aria-label={t('browser.closeTab', { title: label })}
                    onClick={() => { void staticPreview.closeTab(tab.name); }}><XIcon /></button>
                )}
              </span>
            );
          })}
        </div>
        <button className="browser-head-button" aria-label={t('browser.newTab')} title={t('browser.newTab')} onClick={newTab}><PlusIcon /></button>
        <button className="browser-head-button" aria-label={t('browser.minimize')} title={t('browser.minimize')}
          onClick={() => { setOptionsOpen(false); setOpen(false); }}><ChevronDownIcon /></button>
      </div>

      <div className="browser-nav" inert={clearConfirmation ? '' : undefined}>
        <form className="browser-address-form" onSubmit={submitAddress}>
          <GlobeIcon />
          <span className={`browser-address-mode ${menuMode}`}>
            {t(menuMode === 'static'
              ? 'browser.staticBadge'
              : menuMode === 'proxy' ? 'browser.proxyBadge' : 'browser.directBadge')}
          </span>
          <input ref={addressRef} className="browser-address" aria-label={t('browser.address')}
            value={address} onChange={(event) => setAddress(event.target.value)}
            readOnly={staticSelected}
            placeholder={t(homeActive ? 'browser.addressOrDirectoryPlaceholder' : 'browser.addressPlaceholder')}
            autoCapitalize="none" autoCorrect="off" spellCheck="false" />
          {homeActive && (
            <button type="button" className="browser-address-folder"
              aria-label={t('browser.chooseDirectory')} title={t('browser.chooseDirectory')}
              onClick={openDirPicker}><FolderIcon /></button>
          )}
        </form>
        <button className={`browser-nav-button browser-refresh ${activeLoading ? 'loading' : ''}`}
          aria-label={t(activeLoading && proxied ? 'browser.stop' : 'browser.refresh')} aria-busy={activeLoading}
          disabled={!active || homeActive || (staticSelected && staticActive.status === 'ensuring')}
          onClick={activeLoading && proxied ? stopActive : refreshActive}>
          {activeLoading && proxied ? <StopIcon /> : <RefreshIcon />}
        </button>
        <button className="browser-nav-button browser-options-trigger" aria-label={t('browser.menu')}
          aria-expanded={optionsOpen} onClick={() => setOptionsOpen((value) => !value)}><MoreHorizontalIcon /></button>
        {optionsOpen && open && (
          <>
            <div className="browser-options-backdrop" onClick={() => setOptionsOpen(false)} />
            <div className="browser-options-card" role="dialog" aria-label={t('browser.menu')}>
              {!staticSelected && (
                <div className="browser-options-section browser-current-mode">
                  <strong>{t('browser.connectionMode')}</strong>
                  <div className="browser-mode-segment" role="group" aria-label={t('browser.switchMode')}>
                    <button aria-pressed={menuMode === 'direct'}
                      onClick={() => chooseMode('direct')}>{t('browser.directMode')}</button>
                    <button className="proxy" aria-pressed={menuMode === 'proxy'}
                      disabled={!proxyAvailable}
                      aria-describedby={!proxyAvailable ? 'browser-options-proxy-unavailable' : undefined}
                      onClick={() => chooseMode('proxy')}>{t('browser.proxyMode')}</button>
                  </div>
                  {proxyAvailable
                    ? <p className="browser-options-hint browser-proxy-limit">{t('browser.proxyLimitHint')}</p>
                    : <p id="browser-options-proxy-unavailable"
                      className="browser-options-hint">{t('browser.proxyUnavailable')}</p>}
                </div>
              )}

              <div className="browser-options-row browser-width-row">
                <strong>{t('browser.pageWidth')}</strong>
                <div className="browser-view-segment" role="group" aria-label={t('browser.viewMode')}>
                  <button aria-pressed={pageWidth === 'narrow'}
                    onClick={() => setPageWidth('narrow')}>{t('browser.narrowWidth')}</button>
                  <button aria-pressed={pageWidth === 'wide'}
                    onClick={() => setPageWidth('wide')}>{t('browser.wideWidth')}</button>
                </div>
              </div>

              {proxied && (
                <div className="browser-options-row browser-site-version-row">
                  <strong>{t('browser.requestSiteVersion')}</strong>
                  <div className="browser-view-segment" role="group"
                    aria-label={t('browser.requestSiteVersion')}>
                    <button aria-pressed={webActive.siteVersion !== 'desktop'}
                      onClick={() => requestSiteVersion('mobile')}>{t('browser.mobileSite')}</button>
                    <button aria-pressed={webActive.siteVersion === 'desktop'}
                      onClick={() => requestSiteVersion('desktop')}>{t('browser.desktopSite')}</button>
                  </div>
                </div>
              )}

              {active && !homeActive && (
                <div className="browser-options-section">
                  <div className="browser-options-row browser-zoom-row">
                    <strong>{t('browser.zoomPage')}</strong>
                    <div className="browser-zoom-stepper" role="group" aria-label={t('browser.zoomPage')}>
                      <button onClick={() => zoomPageBy(-1)} disabled={pageZoom <= PAGE_ZOOM_STEPS[0]}
                        aria-label={t('preview.zoomOut')}>−</button>
                      <button className="browser-zoom-value" onClick={() => setPageZoom(1)}
                        aria-label={t('browser.resetZoom')}>{Math.round(pageZoom * 100)}%</button>
                      <button onClick={() => zoomPageBy(1)}
                        disabled={pageZoom >= PAGE_ZOOM_STEPS[PAGE_ZOOM_STEPS.length - 1]}
                        aria-label={t('preview.zoomIn')}>＋</button>
                    </div>
                  </div>
                </div>
              )}

              {webActive && !homeActive && !staticSelected && (
                <div className="browser-options-section">
                  <a className="browser-options-action browser-open-external"
                    href={webActive.originalUrl} target="_blank" rel="noopener noreferrer"
                    onClick={() => setOptionsOpen(false)}>{t('browser.openExternal')}</a>
                </div>
              )}

              {!staticSelected && (
                <div className="browser-options-section">
                  <button className="browser-close-trigger" aria-expanded={timeOpen}
                    onClick={() => setTimeOpen((value) => !value)}>
                    <strong>{t('browser.closeTiming')}</strong>
                    <span>{t('browser.minutes', { value: closeAfter })} ▾</span>
                  </button>
                  {timeOpen && (
                    <div className="browser-time-options" role="group" aria-label={t('browser.closeTiming')}>
                      {BROWSER_CLOSE_AFTER_OPTIONS.map((value) => (
                        <button key={value} className="browser-time-option" aria-pressed={closeAfter === value}
                          onClick={() => pickTime(value)}>{t('browser.minutes', { value })}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {proxyAvailable && homeActive && (
                <div className="browser-options-section browser-profile-options">
                  <div className="browser-options-row browser-profile-persist">
                    <span className="browser-options-title">
                      <label htmlFor="browser-profile-persist-toggle">
                        <strong>{t('settings.browserPersistLogin')}</strong>
                      </label>
                      <button type="button" className="settings-close browser-title-help"
                        aria-label={t('browser.proxyLoginHelpLabel')}
                        onClick={(event) => {
                          event.preventDefault();
                          clearTriggerRef.current = event.currentTarget;
                          setClearConfirmation({ type: 'help-profile' });
                        }}>?</button>
                    </span>
                    <span className="browser-options-control">
                      <span className="cmd-switch">
                        <input id="browser-profile-persist-toggle" type="checkbox" checked={!!persistProxyLogin}
                          onChange={(event) => setProxyLoginPolicy({
                            persist: event.target.checked,
                            retentionDays: null,
                          })} />
                        <span className="cmd-switch-track" aria-hidden="true" />
                        <span className="cmd-switch-knob" aria-hidden="true" />
                      </span>
                    </span>
                  </div>
                  <button className="browser-options-danger" onClick={() => {
                    clearTriggerRef.current = document.activeElement instanceof HTMLElement
                      ? document.activeElement
                      : null;
                    setClearConfirmation({ type: 'all' });
                  }}>{t('browser.clearAllLogin')}</button>
                </div>
              )}

              {proxyAvailable && webActive?.mode === 'proxy' && !homeActive && !staticSelected && (
                <div className="browser-options-section">
                  <div className="browser-site-cookie-row">
                    <button className="browser-options-danger" onClick={requestActiveSiteClear}>
                      {t('browser.clearSiteLogin')}
                    </button>
                    <button className="settings-close browser-title-help"
                      aria-label={t('browser.siteCookieHelpLabel')}
                      onClick={(event) => {
                        clearTriggerRef.current = event.currentTarget;
                        setClearConfirmation({ type: 'help-site' });
                      }}>?</button>
                  </div>
                </div>
              )}

              {homeActive && (
                <div className="browser-options-section">
                  <button className="browser-options-action" onClick={() => {
                    clearTriggerRef.current = document.activeElement instanceof HTMLElement
                      ? document.activeElement
                      : null;
                    setClearConfirmation({ type: 'help-about' });
                  }}>{t('browser.about')}</button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div ref={bodyRef} className={`browser-content ${pageWidth}`}
        inert={clearConfirmation ? '' : undefined}>
        <section className="browser-history" hidden={!homeActive}>
          <div className="browser-history-head">
            <h2>{t('browser.history')}</h2>
            {history.length > 0 && <button onClick={clearHistory}>{t('browser.clearHistory')}</button>}
          </div>
          {history.length === 0 ? <p className="browser-empty">{t('browser.emptyHistory')}</p> : (
            <div className="browser-history-list">
              {history.map((entry, index) => {
                const staticEntry = entry.kind === 'static';
                const key = `${entry.visitedAt}-${staticEntry ? entry.dir : entry.url}-${index}`;
                return (
                  <div className="browser-history-row" key={key}>
                    <button className="browser-history-main" onClick={() => openHistory(entry)}>
                      <strong>{entry.title || (staticEntry ? entry.dir : entry.url)}</strong>
                      <span className="browser-history-meta">
                        <span className={`browser-history-mode ${staticEntry ? 'static' : (entry.lastMode || 'direct')}`}>
                          {t(staticEntry
                            ? 'browser.staticBadge'
                            : entry.lastMode === 'proxy' ? 'browser.proxyBadge' : 'browser.directBadge')}
                        </span>
                        <span className="browser-history-url">{staticEntry ? entry.dir : entry.url}</span>
                      </span>
                    </button>
                    <button className="browser-history-more"
                      aria-label={t(staticEntry ? 'browser.historyActions' : 'browser.historyMore')}
                      aria-expanded={historyModeOpen === key}
                      onClick={() => setHistoryModeOpen((value) => value === key ? null : key)}>…</button>
                    {historyModeOpen === key && (
                      <div className="browser-history-mode-menu" role="dialog"
                        aria-label={t(staticEntry ? 'browser.historyActions' : 'browser.openMode')}>
                        {!staticEntry && (
                          <>
                            <button className="browser-history-mode-option" onClick={() => openHistory(entry, 'direct', true)}>{t('browser.directMode')}</button>
                            <button className="browser-history-mode-option proxy" disabled={!proxyAvailable}
                              aria-describedby={!proxyAvailable ? `browser-history-proxy-unavailable-${index}` : undefined}
                              onClick={() => openHistory(entry, 'proxy', true)}>{t('browser.proxyMode')}</button>
                          </>
                        )}
                        <button className="browser-history-mode-option danger"
                          onClick={() => removeHistory(entry)}>{t('browser.deleteHistoryEntry')}</button>
                        {!staticEntry && !proxyAvailable && <p id={`browser-history-proxy-unavailable-${index}`}>{t('browser.proxyUnavailable')}</p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
        {tabs.filter((tab) => mountedTabs.has(tab.id)).map((tab) => {
          const selected = !staticSelected && !historyActive && tab.id === activeId;
          const loading = selected && (!loadedTabs.has(tab.id) || frameUrls.current.get(tab.id) !== tab.url || refreshingTabs.has(tab.id));
          return (
          <div key={tab.id} className={`browser-pane ${tab.mode} ${selected ? 'active' : ''}`}
            aria-hidden={!selected}>
            <div className="browser-frame-scaler" style={scalerStyleFor(selected ? pageZoom : 1)}>
              <iframe key={`${tab.id}-${reloadKeys[tab.id] || 0}`}
                ref={(node) => { if (node) frames.current.set(tab.id, node); else frames.current.delete(tab.id); }}
                data-tab-id={tab.id}
                className="browser-frame"
                title={tabLabel(tab)}
                src={tab.url}
                sandbox={FRAME_SANDBOX}
                style={frameStyleFor(selected ? pageZoom : 1)}
                onLoad={() => frameLoaded(tab)}
                onError={() => {
                  if (tab.mode !== 'proxy') return;
                  if (openRef.current && activeIdRef.current === tab.id) void recoverBinding(tab.id);
                  else setUnhealthyTabs((current) => new Set(current).add(tab.id));
                }}
              />
              {loading && (
                <div className="browser-page-loading" role="status" aria-live="polite">
                  <div className="browser-page-progress" role="progressbar" aria-label={t('common.loading')} />
                </div>
              )}
            </div>
          </div>
          );
        })}
        {(staticPreview?.tabs || []).filter((tab) => mountedStaticTabs.has(tab.name)).map((tab) => {
          const selected = staticSelected && tab.name === staticActive?.name;
          const loading = selected && tab.status === 'ready'
            && (!loadedStaticTabs.has(tab.name) || staticFrameUrls.current.get(tab.name) !== tab.url);
          return (
          <div key={`static-pane:${tab.name}`} className={`browser-pane static ${selected ? 'active' : ''}`}
            aria-hidden={!selected}>
            {tab.status === 'ready' ? (
              <div className="browser-frame-scaler" style={scalerStyleFor(selected ? pageZoom : 1)}>
                <iframe key={`${tab.name}-${staticReloadKeys[tab.name] || 0}`}
                  className="browser-frame"
                  data-static-tab-name={tab.name}
                  title={tab.name}
                  src={tab.url ?? undefined}
                  sandbox={STATIC_FRAME_SANDBOX}
                  style={frameStyleFor(selected ? pageZoom : 1)}
                  onLoad={() => staticFrameLoaded(tab)}
                />
                {loading && (
                  <div className="browser-page-loading" role="status" aria-live="polite">
                    <div className="browser-page-progress static" role="progressbar" aria-label={t('common.loading')} />
                  </div>
                )}
              </div>
            ) : (
              <div className="browser-static-state" role={tab.status === 'error' ? 'alert' : 'status'}>
                <strong>{tab.status === 'error'
                  ? (tab.error?.message || t('browser.loadFailed'))
                  : t('browser.staticOpening')}</strong>
                <span>{tab.dir}</span>
                {tab.status === 'error' && (
                  <button onClick={() => staticPreview.retryPreview(tab.name)}>
                    {t('browser.retry')}
                  </button>
                )}
              </div>
            )}
          </div>
          );
        })}
        {displayedError && (
          <div className="browser-error" role="alert">
            <span>{typeof displayedError === 'string'
              ? displayedError
              : displayedError.message || t('browser.loadFailed')}</span>
            {!staticSelected && !historyError && webActive && webActive.mode === 'direct' && proxyAvailable
              ? <button onClick={() => navigateTab(webActive.id, webActive.originalUrl, 'proxy')}>{t('browser.tryProxy')}</button>
              : !staticSelected && !historyError && webActive && <button onClick={() => (
                webActive.mode === 'proxy'
                  ? recoverBinding(webActive.id)
                  : navigateTab(webActive.id, webActive.originalUrl, webActive.mode)
              )}>{t('browser.retry')}</button>}
          </div>
        )}
      </div>
      <TypedDirPicker
        open={dirOpen}
        seedCwd={seedCwd}
        pane={staticPreview?.pane}
        hint={t('browser.directoryPickerHint')}
        onPick={pickDirectory}
        onClose={() => setDirOpen(false)}
      />
      {clearConfirmation && (
        <div className="browser-profile-confirm-backdrop">
          <div ref={clearDialogRef} className="browser-profile-confirm"
            role={clearConfirmation.type.startsWith('help-') ? 'dialog' : 'alertdialog'} aria-modal="true"
            aria-label={t(clearConfirmation.type === 'help-about'
              ? 'browser.about'
              : clearConfirmation.type === 'help-profile'
              ? 'browser.proxyLogin'
              : clearConfirmation.type === 'help-site'
                ? 'browser.siteProxyCookie'
                : clearConfirmation.type === 'site'
              ? 'browser.clearSiteLogin'
              : clearConfirmation.type === 'all'
                ? 'browser.clearAllLogin'
                : 'browser.proxyLogin')}>
            {clearConfirmation.type === 'help-about' ? (
              <>
                <h2>{t('browser.consentTitle')}</h2>
                <p>{t('browser.consentBody')}</p>
                <ul>
                  <li>{t('browser.consentComputer')}</li>
                  <li>{t('browser.consentPrivate')}</li>
                  <li>{t('browser.consentLimits')}</li>
                  <li>{t('browser.consentIdle')}</li>
                </ul>
              </>
            ) : (
              <p>{t(clearConfirmation.type === 'help-profile'
                ? 'browser.proxyLoginHelp'
                : clearConfirmation.type === 'help-site'
                  ? 'browser.siteCookieHelp'
                  : clearConfirmation.type === 'site'
                    ? 'browser.clearSiteLoginConfirm'
                    : clearConfirmation.type === 'all'
                      ? 'browser.clearAllLoginConfirm'
                      : 'browser.proxyLoginHelp')}</p>
            )}
            <div>
              {clearConfirmation.type.startsWith('help-') ? (
                <button ref={clearCancelRef} onClick={() => setClearConfirmation(null)}>{t('browser.acknowledge')}</button>
              ) : (
                <>
                  <button ref={clearCancelRef} onClick={() => setClearConfirmation(null)}>{t('common.cancel')}</button>
                  <button className="danger" onClick={confirmSiteClear}>{t('common.confirm')}</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
    </OverlayPortal>
  );
}
