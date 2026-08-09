import { useState, useEffect, useRef } from 'react';
import { fetchDir, fetchPaneCwd } from '../api.js';
import { getBrowseDir, setBrowseDir } from '../storage.js';
import HomeView from './HomeView.jsx';
import FileBrowser from './FileBrowser.jsx';
import DocView from './DocView.jsx';
import { FolderIcon, ClockIcon, ChevronDownIcon } from './icons.jsx';
import { t as tr } from '../i18n';
import { useHistoryLayer, unwindHistory } from '../hooks/useBackButton.js';
import { OverlayPortal } from '../overlays/OverlayHost.js';
import { HOME_TAB } from '../hooks/useDocTabs.js';
import type { DocTab } from '../hooks/useDocTabs.js';

type HomeMode = 'recent' | 'browse';

type FileHistoryEntry =
  | { type: 'nav'; prev: string | null }
  | { type: 'doc' };

export interface FileManagerProps {
  open: boolean;
  pane?: string | null;
  windowId?: string | null;
  tabs: readonly DocTab[];
  active: string;
  onActivate: (key: string) => void;
  onCloseTab: (key: string) => void;
  onMinimize: () => void;
  onOpenDoc: (path: string) => void | Promise<void>;
  pendingShare?: File | null;
  onPendingConsumed?: () => void;
}

function cwdOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const cwd = (value as Record<string, unknown>).cwd;
  return typeof cwd === 'string' && cwd ? cwd : null;
}

// Bottom-sheet shell for the file viewer. Rendered through a portal on <body> — NOT inside .app —
// so the app's keyboard-inset transform (which makes .app the containing block for fixed children)
// can't drag this full-screen sheet off-screen when the browser's path input is focused. Always
// mounted; `open` toggles the .open class that drives the slide-up transform (CSS).
//
// The home tab is a single 文件 tab with a 最近 / 目录 segmented switch. 最近 lists history; 目录 is
// the directory browser. browsePath holds the browser's current directory at THIS level (not in
// FileBrowser, which unmounts when a doc tab takes over) so opening a file and coming back lands on
// the same directory.
//
// On each open the browser lands on THIS WINDOW's remembered dir (persisted per window in
// localStorage), or — a window's first open / a stale memory — the active pane's cwd, so an upload
// drops straight into the session's directory.
export default function FileManager({
  open,
  pane,
  windowId,
  tabs,
  active,
  onActivate,
  onCloseTab,
  onMinimize,
  onOpenDoc,
  pendingShare,
  onPendingConsumed,
}: FileManagerProps) {
  const cur = tabs.find((tab) => tab.key === active) ?? tabs[0] ?? HOME_TAB;
  const [homeMode, setHomeMode] = useState<HomeMode>('recent');
  const [browsePath, setBrowsePath] = useState<string | null>(null); // browser dir to show (null → $HOME)
  // Bumped on every (re)open so the directory listing / recents re-fetch even when nothing changed. The
  // sheet is always mounted (portal) and FileBrowser/HomeView stay mounted while minimized, so without an
  // explicit signal a reopen to the SAME dir would keep showing the stale listing captured on first open.
  const [refreshKey, setRefreshKey] = useState(0);
  const isHome = cur.type === 'home';
  const seededForRef = useRef<string | null | undefined>(null); // windowId seeded for this open; null when closed

  // ── Layered Back ──────────────────────────────────────────────────────────────────────────────
  // Hardware/browser Back RETRACES the user's actual forward path, one recorded action at a time
  // (mirrors GitPanel): each dir move and each preview opened from inside the sheet pushes an action;
  // Back pops and reverses it (doc → home exactly as it was, nav → the previous path). A doc opened
  // DIRECTLY (sheet was closed — e.g. a terminal link or a recent) records nothing beyond the base,
  // so Back simply hides the sheet — it never invents a "file's directory" level the user was never
  // at (doing so consumed the only history entry and made the NEXT Back exit the app).
  // We mirror the stack into browser history — one entry for the open sheet plus one per action.
  // popstate only *reads* state + decrements a counter (never pushState()s inside the handler — some
  // Android WebViews drop that, unbalancing history). Refs keep the popstate closure (bound once per
  // open) reading live values.
  const browsePathRef = useRef(browsePath); browsePathRef.current = browsePath;
  const activeRef = useRef(active); activeRef.current = active;
  const windowIdRef = useRef(windowId); windowIdRef.current = windowId;
  const onMinimizeRef = useRef(onMinimize); onMinimizeRef.current = onMinimize;
  const onActivateRef = useRef(onActivate); onActivateRef.current = onActivate;
  const prevActiveRef = useRef(active); // last active tab — to spot a home→doc transition (a preview opening)
  const depthRef = useRef(0);           // # of our live history entries (base + recorded actions)
  const histRef = useRef<FileHistoryEntry[]>([]); // nav dir move | doc preview opened
  const pushHist = (): void => { window.history.pushState({ fileOverlay: true }, ''); depthRef.current += 1; };
  useHistoryLayer(open, () => {
    depthRef.current = Math.max(0, depthRef.current - 1);
    const entry = histRef.current.pop();
    if (entry?.type === 'doc') {
      onActivateRef.current?.('home');
      return;
    }
    if (entry?.type === 'nav') {
      setBrowsePath(entry.prev);
      if (entry.prev) setBrowseDir(windowIdRef.current, entry.prev);
      return;
    }
    onMinimizeRef.current?.();
  });

  // Persist every directory the browser lands on, keyed by window → next open returns here. A real
  // move (new path) also records where we came from and mirrors one history entry so Back retraces.
  const onNavigate = (absPath: string): void => {
    if (open && absPath !== browsePathRef.current) { histRef.current.push({ type: 'nav', prev: browsePathRef.current }); pushHist(); }
    setBrowsePath(absPath);
    setBrowseDir(windowId, absPath);
  };

  // A file opening into a preview FROM INSIDE the sheet (home→doc while already open) is one more
  // back-level. A doc that opens TOGETHER with the sheet (open flips in the same commit) is a direct
  // open — the base entry already covers it, so Back hides the sheet in one step. Returning to home
  // (our own Back, or a tab tap) never pushes; the initial mount (prev === active) doesn't either.
  const prevOpenRef = useRef(open);
  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = active;
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && wasOpen && prev === 'home' && active !== 'home') { histRef.current.push({ type: 'doc' }); pushHist(); }
  }, [active, open]);

  // popstate handler + base entry, bound once per open. Cleanup unwinds any entries we still own when
  // the sheet is dismissed by a button (minimize / tab ✕) rather than by Back.
  useEffect(() => {
    if (!open) return undefined;
    histRef.current = [];
    depthRef.current = 0;
    pushHist(); // base entry for the open sheet
    return () => {
      if (depthRef.current > 0) { unwindHistory(depthRef.current); depthRef.current = 0; }
    };
  }, [open]);
  // Snap to the active pane's LIVE cwd (re-fetched each press, so a mid-session `cd` is honored).
  const jumpToCwd = async (): Promise<void> => {
    if (!pane) return;
    try {
      const cwd = cwdOf(await fetchPaneCwd(pane));
      if (cwd) setBrowsePath(cwd);
    } catch { /* ignore */ }
  };

  // A file shared in (Web Share Target) needs the directory browser to pick its destination — force
  // the 目录 segment so the upload banner is visible the moment the sheet opens.
  useEffect(() => { if (pendingShare) setHomeMode('browse'); }, [pendingShare]);

  // Every time the sheet (re)opens, force a fresh directory listing + recents — the views stay mounted
  // while minimized, so a reopen must re-fetch even if the remembered dir is unchanged.
  useEffect(() => { if (open) setRefreshKey((k) => k + 1); }, [open]);

  // Land on the remembered dir (validated) or the pane's cwd, in the 目录 segment. Re-seeds when the
  // window changes while the sheet stays open (e.g. a notification-tap navigation), so each window
  // lands on its own dir and onNavigate persists under the right windowId — not once-per-open, which
  // would strand the new window on the old one's dir.
  useEffect(() => {
    if (!open) { seededForRef.current = null; return undefined; }
    if (seededForRef.current === windowId) return undefined; // already seeded for this window this open
    seededForRef.current = windowId;
    histRef.current = []; // a fresh window starts a fresh back history (the seed dir is the base)
    setHomeMode('browse');
    let cancelled = false;
    (async () => {
      const storedDir: unknown = getBrowseDir(windowId);
      const remembered = typeof storedDir === 'string' && storedDir ? storedDir : null;
      let target: string | null = null;
      if (remembered) { try { await fetchDir(remembered); target = remembered; } catch { /* stale → cwd */ } }
      if (!target && pane) { try { target = cwdOf(await fetchPaneCwd(pane)); } catch { /* → $HOME */ } }
      if (!cancelled && target) setBrowsePath(target);
    })();
    return () => { cancelled = true; };
  }, [open, windowId, pane]);

  return (
    <OverlayPortal>
      <div className={`file-sheet ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="file-tabs">
        <div className="file-tabs-scroll">
          {tabs.map((t) => (
            <div key={t.key} className={`file-tab ${t.key === active ? 'active' : ''}`}>
              <button className="file-tab-label" onClick={() => onActivate(t.key)}>
                {t.key === 'home' ? <><FolderIcon />{tr('filemanager.files')}</> : t.name}
              </button>
              {t.key !== 'home' && (
                <button className="file-tab-x" aria-label={tr('filemanager.closeTab')} onClick={() => onCloseTab(t.key)}>✕</button>
              )}
            </div>
          ))}
        </div>
        <button className="file-min" aria-label={tr('filemanager.minimize')} title={tr('filemanager.minimize')} onClick={onMinimize}><ChevronDownIcon /></button>
      </div>
      <div className="file-body">
        {isHome ? (
          <div className="home-pane">
            <div className="file-seg" role="tablist">
              <button className={`file-seg-btn ${homeMode === 'recent' ? 'on' : ''}`}
                role="tab" aria-selected={homeMode === 'recent'} onClick={() => setHomeMode('recent')}>
                <ClockIcon />{tr('filemanager.recent')}
              </button>
              <button className={`file-seg-btn ${homeMode === 'browse' ? 'on' : ''}`}
                role="tab" aria-selected={homeMode === 'browse'} onClick={() => setHomeMode('browse')}>
                <FolderIcon />{tr('filemanager.directory')}
              </button>
            </div>
            {homeMode === 'recent'
              ? <HomeView onOpenDoc={onOpenDoc} refreshKey={refreshKey} />
              : <FileBrowser path={browsePath} onNavigate={onNavigate} onOpenDoc={onOpenDoc}
                  onJumpToCwd={pane ? jumpToCwd : null} refreshKey={refreshKey}
                  pendingFile={pendingShare} onPendingConsumed={onPendingConsumed} overlayActive={open} />}
          </div>
        ) : <DocView type={cur.type} name={cur.name} content={cur.content} />}
      </div>
    </div>
    </OverlayPortal>
  );
}
