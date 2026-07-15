import { useEffect, useState, useCallback, useRef } from 'react';
import { t } from './i18n';
import {
  getToken, getLastSession, getLastWindow, getLastPane, remember, clearToken,
  getBoundSessions, addBoundSession, removeBoundSession, renameBoundSession,
  getFavorites, addFavorite, removeFavorite, getRecent, pushRecent, removeRecent,
  pushRecentDoc, getPaneBase, setPaneBase,
  getInboxSeen, markInboxSeen, getInboxReadTs, setInboxReadTs,
  renameWindowIdeas, getChangelogSeen, setChangelogSeen,
  getVersionSeen, setVersionSeen,
  getPreviewDir, getIdeas,
} from './storage.js';
import { LATEST_RELEASE } from './changelog.js';
import {
  getSessions, getWindows, getPanes, resizeWindow, resizePane, getWindowLayout,
  restoreWindowSize, sendKeys, sendText, createWindow,
  renameSession, renameWindow, deleteWindow, swapWindows, fetchDoc, fetchImageUrl,
  getStates, getOrphans, takeoverOrphan,
  getServerVersion,
  splitPane as apiSplitPane, closePane as apiClosePane,
} from './api.js';
import { runSplitPane, runClosePane } from './paneActions.js';
import PreviewSheet from './components/PreviewSheet.jsx';
import { inboxRows, topView, maxTs } from './inbox.js';
import { moveTarget } from './windowOrder.js';
import { reportBound, clearPaneNotification } from './push.js';
import { isAbsolute, joinPath } from './docPath.js';
import { isImageName } from './mime.js';
import { useDocTabs } from './hooks/useDocTabs.js';
import { usePreviews } from './hooks/usePreviews.js';
import { usePollingLoop } from './hooks/usePollingLoop.js';
import { authHandled } from './authGuard.js';

import Drawer from './components/Drawer.jsx';
import WindowBar from './components/WindowBar.jsx';
import Terminal from './components/Terminal.jsx';
import BottomDock from './components/BottomDock.jsx';
import TokenPrompt from './components/TokenPrompt.jsx';
import Settings from './components/Settings.jsx';
import UsagePage from './components/UsagePage.jsx';
import Inbox from './components/Inbox.jsx';
import OrphanTakeoverSheet from './components/OrphanTakeoverSheet.jsx';
import AddToHome from './components/AddToHome.jsx';
import { useClaudeHooks } from './useClaudeHooks.js';
import BindSession from './components/BindSession.jsx';
import NewWindowModal from './components/NewWindowModal.jsx';
import RenameModal from './components/RenameModal.jsx';
import ActionSheet from './components/ActionSheet.jsx';
import FileManager from './components/FileManager.jsx';
import GitPanel from './components/GitPanel.jsx';
import UploadOverlay from './components/UploadOverlay.jsx';
import DirPicker from './components/DirPicker.jsx';
import DocLinkPopover from './components/DocLinkPopover.jsx';
import IdeaPanel from './components/IdeaPanel.jsx';
import Changelog from './components/Changelog.jsx';
import { FolderIcon, GearIcon, BulbIcon, MonitorIcon, GitIcon, GaugeIcon, SplitHIcon, SplitVIcon, PaneMapIcon, XIcon } from './components/icons.jsx';
import { useKeyboardInset } from './hooks/useKeyboardInset.js';
import { usePageScrollLock } from './hooks/usePageScrollLock.js';
import { useLongPress } from './hooks/useLongPress.js';
import { useBackButton } from './hooks/useBackButton.js';
import { useExitConfirm } from './hooks/useExitConfirm.js';
import { readRoute, writeSessionHash } from './hashRoute.js';
import { hasShareFlag, takeSharedFile, clearShareFlag } from './shareIntake.js';

const COL_STEP = 10; // columns added/removed per ⊟/⊞ tap
const CIRCLED = '①②③④⑤⑥⑦⑧⑨'; // pane-sheet title numbering, mirrors WindowBar's seq()

// Pick the remembered id if it still exists, else the first. We deliberately don't fall back
// to tmux's "active" — the local last-opened choice wins, first is the fallback.
const pickId = (items, prefer) =>
  (prefer && items.some((x) => x.id === prefer) ? prefer : items[0].id);

export default function App() {
  const [needToken, setNeedToken] = useState(!getToken());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [newWinOpen, setNewWinOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null); // { kind:'session'|'window', id, name } | null
  const [manageWindow, setManageWindow] = useState(null); // the window long-pressed for its action menu
  const [managePane, setManagePane] = useState(null); // pane id long-pressed in the map
  const [openMapFor, setOpenMapFor] = useState(null); // window id whose split map "管理分屏" asked to open
  const [fileManagerOpen, setFileManagerOpen] = useState(false); // file-viewer bottom-sheet visibility
  const [gitOpen, setGitOpen] = useState(false);
  const [pendingShare, setPendingShare] = useState(null); // a File shared in via Web Share Target, awaiting a destination
  const [basePrompt, setBasePrompt] = useState(null); // { rawPath } while asking for a relative path's base dir
  const [docToast, setDocToast] = useState(null); // transient error toast for absolute-path doc failures
  const [exitHint, setExitHint] = useState(false); // "press Back again to exit" hint (double-back guard)
  const [docLinkPrompt, setDocLinkPrompt] = useState(null); // { path, x, y } confirm popover for a tapped terminal path
  const docTabs = useDocTabs(); // file-viewer tab state, kept across sheet open/close
  const [bound, setBound] = useState(getBoundSessions); // session names pinned on this device
  const [favorites, setFavorites] = useState(getFavorites); // global favorite commands
  const [recent, setRecent] = useState([]); // current session's recent commands (keyed by session name)
  const [current, setCurrent] = useState(null); // { session, windows, window, panes, paneId }
  const [booting, setBooting] = useState(true);
  const [states, setStates] = useState({}); // pane → {session,window,kind,…} from /api/states
  const [orphans, setOrphans] = useState([]); // claude sessions running outside tmux (/api/orphans)
  const [takeoverTarget, setTakeoverTarget] = useState(null); // orphan being taken over (opens the sheet)
  const [inboxOpen, setInboxOpen] = useState(false); // inbox dropdown open
  const { status: hooksStatus, enable: enableHooks } = useClaudeHooks();
  const [ideaOpen, setIdeaOpen] = useState(false); // per-window idea sheet open
  const [ideaCount, setIdeaCount] = useState(0);   // idea count for the current window (badge)
  const [changelogOpen, setChangelogOpen] = useState(false); // "what's new" sheet open
  const [clSeen, setClSeen] = useState(getChangelogSeen); // latest changelog id the user has opened
  const [updateInfo, setUpdateInfo] = useState(null); // { current, latest, updateAvailable } — npm update hint (checked once per launch)
  const [verSeen, setVerSeen] = useState(getVersionSeen); // npm "latest" already acknowledged by opening Settings
  const [seen, setSeen] = useState(getInboxSeen); // pane → last-viewed ts (inbox read state)
  const [readTs, setReadTs] = useState(getInboxReadTs); // server-ts high-water mark for done history (null=unset)
  const termRef = useRef(null);
  const dockRef = useRef(null); // imperative handle into BottomDock — idea panel fills its input box
  const tmuxColsRef = useRef(null); // target col count, so taps accumulate (term.cols lags ~1s)
  const savedLayoutRef = useRef(null); // window_layout captured before our first resize, for ↺

  const onAuthFail = useCallback(() => setNeedToken(true), []);
  // Shared catch prelude: bounce to the token prompt on an auth failure, and report whether it WAS one so
  // each handler keeps its own non-auth control flow (swallow / return / rethrow). See authGuard.js.
  const handledAuth = useCallback((e) => authHandled(e, onAuthFail), [onAuthFail]);

  // The in-app preview subsystem (registry state, active-preview derivation, start/stop/renew/open),
  // extracted verbatim into a hook — it coordinates with Settings' history entry via settingsOpen.
  const {
    previewDomain, dynamicEnabled, previewSheetOpen, setPreviewSheetOpen,
    activePreview, openPreviewSheet,
    startPreview, startDynamicPreview, stopPreview, renewPreview,
  } = usePreviews(current, { settingsOpen, setSettingsOpen });

  // Update check: once per app launch (not polled), ask the server whether the installed CLI is behind the
  // latest npm release. The result lights the gear's dot and drives the "run `handmux update`" hint in Settings.
  useEffect(() => {
    if (needToken) return;
    getServerVersion().then(setUpdateInfo).catch(() => { /* best-effort; no hint on failure */ });
  }, [needToken]);

  // Drop the saved token and bounce back to the token prompt — handy for testing the login flow.
  const logout = useCallback(() => {
    clearToken();
    setSettingsOpen(false);
    setBindOpen(false);
    setDrawerOpen(false);
    setCurrent(null);
    setBooting(true);
    setNeedToken(true);
  }, []);

  usePageScrollLock(); // keyboard-up: stop the browser panning the whole page (see hook) — also keeps inset honest
  const inset = useKeyboardInset();

  // Hardware Back closes the open overlay (→ one level up) instead of exiting the app.
  // FileManager and GitPanel own their OWN multi-level Back handling (each Back pops one level —
  // preview→dir→close for files, drill→home→close for git — so Back never blows the whole sheet away
  // mid-navigation).
  useBackButton(previewSheetOpen, () => setPreviewSheetOpen(false));
  useBackButton(drawerOpen, () => setDrawerOpen(false));
  useBackButton(inboxOpen, () => setInboxOpen(false));
  useBackButton(usageOpen, () => setUsageOpen(false));
  useBackButton(bindOpen, () => setBindOpen(false));
  useBackButton(newWinOpen, () => setNewWinOpen(false));
  useBackButton(ideaOpen, () => setIdeaOpen(false));
  useBackButton(!!basePrompt, () => setBasePrompt(null));
  // Settings → 更新日志 is a *swap* (opening the changelog closes settings in the same commit). One
  // combined guard keeps history at a single entry across the swap — Back closes whichever is on top.
  useBackButton(settingsOpen || changelogOpen, () => {
    if (changelogOpen) setChangelogOpen(false); else setSettingsOpen(false);
  });
  // Same for 长按窗口管理 → 重命名 (and the topbar long-press rename, which opens the modal alone).
  useBackButton(!!manageWindow || !!renameTarget, () => {
    if (renameTarget) setRenameTarget(null); else setManageWindow(null);
  });
  useBackButton(!!managePane, () => setManagePane(null));
  // Root double-back-to-exit: on the main page (a pane is showing, all the overlays above push their own
  // entries first), the first Back only surfaces a hint — a second within the window actually exits. The
  // hook toggles the hint (show on arm, hide when the window lapses), so its visibility IS the arm window —
  // the moment it hides, the guard is re-armed and the next Back re-prompts (no separate display timer).
  useExitConfirm(!!current, setExitHint);

  const sendKey = useCallback(async (name) => {
    const paneId = current?.paneId;
    if (!paneId) return;
    try { await sendKeys(paneId, [name]); termRef.current?.wake?.(); } // input landed → poll for output now
    catch (e) { handledAuth(e); }
  }, [current, onAuthFail]);

  const sendChar = useCallback(async (ch) => {
    const paneId = current?.paneId;
    if (!paneId) return;
    try { await sendText(paneId, ch, false); termRef.current?.wake?.(); }
    catch (e) { handledAuth(e); }
  }, [current, onAuthFail]);

  // ⊟/⊞ : purely resize the tmux window's columns by COL_STEP (resize-window). Font is NOT
  // touched here — that's the two-finger pinch on the terminal. We step a tracked target
  // (not the live term.cols, which only catches up on the next ~1s refresh) so repeated
  // taps add up instead of all stepping from the same stale value. Mutates the shared
  // window (the PC follows); "恢复默认" hands sizing back.
  const tmuxResizeCols = useCallback(async (delta) => {
    const windowId = current?.window?.id;
    // tmuxColsRef is seeded to the pane's real width when the window opens (see openSession /
    // selectWindow), so the first tap steps from the true width — not the 80-col xterm
    // default that term.cols shows until the first ~1s refresh. Falls back to the live grid.
    const base = tmuxColsRef.current ?? termRef.current?.getSize()?.cols;
    if (!windowId || !base) return;
    const cols = Math.max(20, Math.min(500, base + delta));
    tmuxColsRef.current = cols;
    termRef.current?.flash?.(); // flash the cols×rows·font readout for ~3s
    try {
      // Capture the original layout once, before our first change, so ↺ can restore it.
      if (savedLayoutRef.current == null) {
        savedLayoutRef.current = await getWindowLayout(windowId).then((r) => r.layout || '').catch(() => '');
      }
      // A pane in a split → resize just that pane (resize-window would shrink the whole
      // window and halve the pane). A lone pane fills the window, so resize the window.
      if (current.panes && current.panes.length > 1) await resizePane(current.paneId, cols);
      else await resizeWindow(windowId, cols);
    } catch (e) {
      handledAuth(e);
    }
  }, [current, onAuthFail]);

  const tmuxRestore = useCallback(async () => {
    const windowId = current?.window?.id;
    if (!windowId) return;
    const layout = savedLayoutRef.current; // restores a split's ratio; window-size for a lone pane
    tmuxColsRef.current = null; // re-seed from the live size after tmux reclaims it
    savedLayoutRef.current = null;
    try {
      await restoreWindowSize(windowId, layout);
    } catch (e) {
      handledAuth(e);
    }
  }, [current, onAuthFail]);

  // Open a session: load its windows (prefer remembered → active → first), then that window's
  // panes (prefer remembered → active → first). Writes the session name into the URL hash so
  // the location deep-links back here. Returns false if the session has no windows/panes.
  const openSession = useCallback(async (session, target = null) => {
    const windows = await getWindows(session.id);
    if (!windows.length) return false;
    const window = (target?.window && windows.find((w) => w.id === target.window))
      || windows.find((w) => w.id === pickId(windows, getLastWindow(session.id)));
    const panes = await getPanes(window.id);
    if (!panes.length) return false;
    const paneId = (target?.pane && panes.some((p) => p.id === target.pane))
      ? target.pane
      : pickId(panes, getLastPane(window.id));
    setCurrent({ session, windows, window, panes, paneId });
    remember({ sessionId: session.id, windowId: window.id, paneId });
    writeSessionHash(session.name);
    // Seed the resize target from this pane's real width so the first ⊟/⊞ tap steps from the
    // true width (not the 80-col xterm default); arm layout capture for the new window.
    tmuxColsRef.current = panes.find((p) => p.id === paneId)?.width ?? null;
    savedLayoutRef.current = null;
    return true;
  }, []);

  // Switch to another window within the current session (its active pane). Session/hash unchanged.
  const selectWindow = useCallback(async (window) => {
    try {
      const panes = await getPanes(window.id);
      if (!panes.length) return;
      const paneId = pickId(panes, getLastPane(window.id));
      setCurrent((c) => (c ? { ...c, window, panes, paneId } : c));
      remember({ sessionId: current.session.id, windowId: window.id, paneId });
      tmuxColsRef.current = panes.find((p) => p.id === paneId)?.width ?? null;
      savedLayoutRef.current = null;
    } catch (e) {
      handledAuth(e);
    }
  }, [current, onAuthFail]);

  // Create a new window in the current session (in the current pane's dir, see POST /windows), with
  // an optional name, then switch to it. Mirrors selectWindow's post-switch bookkeeping. Lets
  // generic errors propagate so the modal re-enables its button; auth errors are handled here.
  const createNewWindow = useCallback(async (name, cwd, cmd) => {
    const sessionId = current?.session?.id;
    const paneId = current?.paneId;
    if (!sessionId || !paneId) return;
    try {
      const { id } = await createWindow(sessionId, paneId, name || undefined, cwd, cmd);
      const windows = await getWindows(sessionId);
      const window = windows.find((w) => w.id === id) || windows[windows.length - 1];
      const panes = await getPanes(window.id);
      if (!panes.length) return;
      const newPaneId = pickId(panes, getLastPane(window.id));
      setCurrent((c) => (c ? { ...c, windows, window, panes, paneId: newPaneId } : c));
      remember({ sessionId, windowId: window.id, paneId: newPaneId }); // sessionId → remembered as this session's last window
      tmuxColsRef.current = panes.find((p) => p.id === newPaneId)?.width ?? null;
      savedLayoutRef.current = null;
      setNewWinOpen(false);
      termRef.current?.wake?.();
    } catch (e) {
      if (handledAuth(e)) return;
      throw e; // let the modal re-enable its button on a generic failure
    }
  }, [current, onAuthFail]);

  // Rename the open session or a window. tmux rename is a shared, global change — the PC follows
  // (same family as the opt-in 适配宽度 resize). For a session we also migrate the local name pin +
  // recent history (the session id is unchanged, so tw_win survives) and update the URL hash.
  // onSubmit throws a user-facing message so RenameModal can show it inline and re-enable.
  const submitRename = useCallback(async (newName) => {
    const t = renameTarget;
    if (!t) return;
    const sessionId = current?.session?.id;
    if (t.kind === 'session') {
      try {
        await renameSession(t.id, newName);
      } catch (e) {
        if (handledAuth(e)) throw e;
        if (e.status === 409) throw new Error(t('app.nameExists')); // ApiError carries the status precisely
        throw new Error(t('app.renameFailed'));
      }
      setBound(renameBoundSession(t.name, newName));
      reportBound();
      writeSessionHash(newName);
      setCurrent((c) => (c && c.session.id === t.id
        ? { ...c, session: { ...c.session, name: newName } } : c)); // the recent effect reloads off the new name
    } else {
      try {
        await renameWindow(t.id, newName);
      } catch (e) {
        if (handledAuth(e)) throw e;
        throw new Error(t('app.renameFailed'));
      }
      // Ideas are keyed by window NAME (id falls back when unnamed) — carry them to the new name.
      renameWindowIdeas(current?.session?.name, t.name || t.id, newName);
      const windows = await getWindows(sessionId);
      setCurrent((c) => (c
        ? { ...c, windows, window: windows.find((w) => w.id === c.window.id) || c.window } : c));
    }
    setRenameTarget(null);
  }, [renameTarget, current, onAuthFail]);

  // Delete the long-pressed window. Deleting the session's ONLY window takes the whole session down
  // with it (the menu warns about this first) — so we drop the now-dead device pin and fall back to
  // the empty state, mirroring unbind. Otherwise: if we deleted the OPEN window, jump to tmux's
  // now-active window (else the first); otherwise just drop it from the list.
  const deleteManagedWindow = useCallback(async () => {
    const w = manageWindow;
    const session = current?.session;
    if (!w || !session) return;
    const sessionId = session.id;
    const lastWindow = current.windows.length <= 1;
    try {
      await deleteWindow(w.id);
    } catch (e) {
      if (handledAuth(e)) return;
      window.alert(t('app.deleteFailed'));
      setManageWindow(null);
      return;
    }
    setManageWindow(null);
    if (lastWindow) {
      // Session is gone now — unpin it from this device and clear the view (same as unbind).
      setBound(removeBoundSession(session.name));
      reportBound();
      setCurrent(null);
      return;
    }
    const windows = await getWindows(sessionId);
    if (w.id === current.window.id && windows.length) {
      const next = windows.find((x) => x.active) || windows[0];
      const panes = await getPanes(next.id);
      if (!panes.length) return;
      const paneId = pickId(panes, getLastPane(next.id));
      setCurrent((c) => (c ? { ...c, windows, window: next, panes, paneId } : c));
      remember({ sessionId, windowId: next.id, paneId });
      tmuxColsRef.current = panes.find((p) => p.id === paneId)?.width ?? null;
      savedLayoutRef.current = null;
    } else {
      setCurrent((c) => (c ? { ...c, windows } : c));
    }
  }, [manageWindow, current, onAuthFail]);

  // Nudge the long-pressed window one slot left/right by swapping it with its neighbour. tmux window
  // index is shared, so the PC's order follows (same opt-in family as 适配宽度). The sheet stays open —
  // manageWindow re-points at the refreshed window so positions can be nudged repeatedly; it closes
  // only if the window vanished (e.g. killed on the PC). The open pane/window is unchanged: swap only
  // reorders, and the active highlight follows the window id.
  const moveManagedWindow = useCallback(async (dir) => {
    const w = manageWindow;
    const sessionId = current?.session?.id;
    if (!w || !sessionId) return;
    const target = moveTarget(current.windows, w.id, dir);
    if (!target) return; // at the edge — the button is disabled anyway
    try {
      await swapWindows(w.id, target.id);
      const windows = await getWindows(sessionId);
      setCurrent((c) => (c
        ? { ...c, windows, window: windows.find((x) => x.id === c.window.id) || c.window } : c));
      setManageWindow(windows.find((x) => x.id === w.id) || null); // refresh in place (or close if gone)
    } catch (e) {
      if (handledAuth(e)) { setManageWindow(null); return; }
      window.alert(t('app.moveFailed'));
      setManageWindow(null);
    }
  }, [manageWindow, current, onAuthFail]);

  // Long-press the topbar session name → rename it (a plain tap is inert, as before).
  const sessionNameLongPress = useLongPress(() => {
    if (current?.session) setRenameTarget({ kind: 'session', id: current.session.id, name: current.session.name });
  });

  // Drawer rows carry a bound NAME — resolve it to the live session before opening, since the
  // tmux id can have changed (or the session may be gone) since it was pinned.
  const selectSession = useCallback(async (name) => {
    try {
      const session = (await getSessions()).find((s) => s.name === name);
      if (!session) { window.alert(t('app.sessionGone', { name })); return; }
      if (await openSession(session)) setDrawerOpen(false);
    } catch (e) {
      handledAuth(e);
    }
  }, [openSession, onAuthFail]);

  // Tap an inbox row → mark it seen and deep-link to that pane (cross-session safe). Mirrors the
  // notification-tap resolver: resolve the live session by name, then openSession with the target.
  const openInboxRow = useCallback(async (row) => {
    setInboxOpen(false);
    setSeen(markInboxSeen(row.pane, row.ts));
    try {
      const session = (await getSessions()).find((s) => s.name === row.session);
      if (!session) { window.alert(t('app.sessionGone', { name: row.session })); return; }
      setDrawerOpen(false);
      await openSession(session, { window: row.window, pane: row.pane });
    } catch (e) { handledAuth(e); }
  }, [openSession, onAuthFail]);

  // Take over an orphan (claude running outside tmux): the server spawns `claude --resume` in the chosen
  // target (new session, or a new window of an existing session) and — if kill — SIGTERMs the original,
  // returning the new {session,window,pane}; we navigate into it. Throws on failure (409 gone / session
  // changed / spawn failed) so the takeover sheet can surface it; success closes the sheet + inbox.
  const doTakeover = useCallback(async ({ target, kill, name }) => {
    const o = takeoverTarget;
    const out = await takeoverOrphan({ pid: o.pid, sessionId: o.sessionId, target, kill, name });
    // Pin the target session into this device's list so the taken-over session is reachable later —
    // without this a brand-new `cc-…` session would vanish from the drawer the moment you navigate away.
    if (out.name) { setBound(addBoundSession(out.name)); reportBound(); }
    setTakeoverTarget(null);
    setInboxOpen(false);
    try {
      if (out.name) { setDrawerOpen(false); await openSession({ id: out.session, name: out.name }, { window: out.window, pane: out.pane }); }
    } catch (e) { handledAuth(e); }
    try { setOrphans(await getOrphans()); } catch { /* refresh best-effort */ }
  }, [takeoverTarget, openSession, onAuthFail]);

  // 清除已完成: advance the high-water mark to the current max ts → all present done rows become history
  // (working/needs are never filtered, so this only clears completed). Button is hidden when no done row.
  const markAllRead = useCallback(() => {
    const m = maxTs(states);
    setInboxReadTs(m); setReadTs(m);
  }, [states]);

  // Save a validated name locally, then open it immediately so "绑定上" is usable right away.
  const bindSession = useCallback((name) => {
    setBound(addBoundSession(name));
    reportBound();
    setBindOpen(false);
    selectSession(name);
  }, [selectSession]);

  const unbindSession = useCallback((name) => {
    setBound(removeBoundSession(name));
    reportBound();
    // If the open session was the one removed, fall back to the empty state.
    setCurrent((c) => (c && c.session.name === name ? null : c));
  }, []);

  const selectPane = useCallback((paneId) => {
    setCurrent((c) => {
      if (!c) return c;
      remember({ windowId: c.window.id, paneId });
      return { ...c, paneId };
    });
  }, []);

  // Refetch the open window's panes after a structural change (split/close) and splice them into `current`.
  const refreshPanes = useCallback((windowId, panes) => {
    setCurrent((c) => (c && c.window.id === windowId ? { ...c, panes } : c));
  }, []);

  // Split `paneId` into two (dir 'h' left|right, 'v' top/bottom); jump the phone to the new pane. The
  // decision logic (call the api, refetch, pick the new pane) lives in paneActions.js — unit-tested there.
  const splitPaneAction = useCallback(async (paneId, dir) => {
    const windowId = current?.window?.id;
    if (!windowId) return;
    setManagePane(null);
    setManageWindow(null);
    try {
      const { panes, selectPaneId } = await runSplitPane({
        paneId, dir, windowId, api: { splitPane: apiSplitPane }, getPanes,
      });
      refreshPanes(windowId, panes);
      selectPane(selectPaneId); // you split to work in the new pane
      savedLayoutRef.current = null; // the window's split layout changed
    } catch (e) {
      if (handledAuth(e)) return;
      window.alert(t('pane.splitFailed'));
    }
  }, [current, refreshPanes, selectPane, onAuthFail]);

  // Close `paneId`; if it was the pane being viewed, re-target to a survivor (via pickId).
  const closeManagedPane = useCallback(async () => {
    const paneId = managePane;
    const windowId = current?.window?.id;
    const viewedPaneId = current?.paneId;
    if (!paneId || !windowId) return;
    try {
      const { panes, selectPaneId } = await runClosePane({
        paneId, windowId, viewedPaneId, api: { closePane: apiClosePane }, getPanes, pickId,
      });
      setManagePane(null);
      refreshPanes(windowId, panes);
      if (selectPaneId) selectPane(selectPaneId);
      savedLayoutRef.current = null;
    } catch (e) {
      setManagePane(null);
      if (handledAuth(e)) return;
      window.alert(t('pane.closeFailed'));
    }
  }, [managePane, current, refreshPanes, selectPane, onAuthFail]);

  // Split a SINGLE-pane window straight from its manage sheet — works whether or not it's the open
  // window (a background window has no map to long-press). We split its active pane, then switch the
  // view to that window and land on the new pane, so you actually see the split you just made.
  const splitWindowAction = useCallback(async (win, dir) => {
    const sessionId = current?.session?.id;
    if (!win || !sessionId) return;
    setManageWindow(null);
    try {
      const src = await getPanes(win.id);
      const base = src.find((p) => p.active) || src[0];
      if (!base) return;
      const { panes, selectPaneId } = await runSplitPane({
        paneId: base.id, dir, windowId: win.id, api: { splitPane: apiSplitPane }, getPanes,
      });
      setCurrent((c) => (c ? { ...c, window: win, panes, paneId: selectPaneId } : c));
      remember({ sessionId, windowId: win.id, paneId: selectPaneId });
      tmuxColsRef.current = panes.find((p) => p.id === selectPaneId)?.width ?? null;
      savedLayoutRef.current = null;
    } catch (e) {
      if (handledAuth(e)) return;
      window.alert(t('pane.splitFailed'));
    }
  }, [current, onAuthFail]);

  // "管理分屏" on a multi-pane window's manage sheet → jump to the split map. If that window isn't the
  // open one, switch to it first (only the active window renders a map), then ask its PaneTab to open.
  const manageSplit = useCallback(async (win) => {
    if (!win) return;
    setManageWindow(null);
    if (win.id !== current?.window?.id) await selectWindow(win);
    setOpenMapFor(win.id);
  }, [current, selectWindow]);

  // Reload the recent (send) history whenever the open session OR window changes — history is
  // window-level, keyed by session NAME + window ID. Use the tmux window ID (@N), which is stable for the
  // window's life — NOT window.name, which tmux auto-renames to the running command, so keying by name
  // made the key drift under you and the history "vanish" moments after a send.
  const recentSession = current?.session?.name;
  const recentWin = current?.window?.id;
  useEffect(() => {
    setRecent(recentSession && recentWin ? getRecent(recentSession, recentWin) : []);
  }, [recentSession, recentWin]);

  // Sync idea count for the badge when the active window changes.
  const ideaSession = current?.session?.name;
  const ideaWin = current?.window?.name || current?.window?.id;
  useEffect(() => {
    setIdeaCount(ideaSession && ideaWin ? getIdeas(ideaSession, ideaWin).length : 0);
  }, [ideaSession, ideaWin]);

  // Seeing a pane clears its pending notification (you've arrived; the alert has done its job).
  useEffect(() => {
    if (current?.paneId) clearPaneNotification(current.paneId);
  }, [current?.paneId]);

  // While a pane is open, keep it marked "seen" as new events land — you're watching it live, so its
  // idle/permission shouldn't show as unread. Re-renders only when its ts actually advances.
  useEffect(() => {
    const pane = current?.paneId;
    if (!pane) return;
    const ts = states[pane]?.ts;
    if (ts != null && getInboxSeen()[pane] !== ts) setSeen(markInboxSeen(pane, ts));
  }, [current?.paneId, states]);

  // Web Share Target: when launched from the system share sheet (Android only — iOS Safari has no
  // share target, so this never fires there), sw.js stashed the file in a cache and redirected with
  // ?share. Pull it out and open the file browser to pick a destination + upload. Runs once on launch;
  // clearing the flag up front keeps StrictMode's double-invoke (and any refresh) from re-triggering.
  useEffect(() => {
    if (!hasShareFlag()) return;
    clearShareFlag();
    let cancelled = false;
    (async () => {
      const file = await takeSharedFile();
      if (cancelled || !file) return;
      setPendingShare(file);
      docTabs.activate('home');
      setFileManagerOpen(true);
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- launch-time intake, run once

  // A notification tap deep-links here. Two delivery paths converge on one resolver:
  //  • SW WindowClient.navigate() changes our hash → 'hashchange' (live app), or reloads → boot effect.
  //  • SW postMessage({type:'navigate'}) — fallback for engines without navigate().
  // openSession's own writeSessionHash uses replaceState (no hashchange), so this can't self-loop.
  useEffect(() => {
    if (needToken || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const go = async ({ session, window, pane }) => {
      if (!session) return;
      try {
        const sessions = await getSessions();
        const s = sessions.find((x) => x.name === session);
        if (s) { setDrawerOpen(false); await openSession(s, { window, pane }); }
      } catch (e) { handledAuth(e); }
    };
    const onMsg = (e) => { const d = e.data; if (d && d.type === 'navigate') go(d); };
    const onHash = () => { const r = readRoute(); if (r.session && (r.window || r.pane)) go(r); };
    navigator.serviceWorker.addEventListener('message', onMsg);
    window.addEventListener('hashchange', onHash);
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMsg);
      window.removeEventListener('hashchange', onHash);
    };
  }, [needToken, openSession, onAuthFail]);

  // Record a just-sent command into this WINDOW's recent history (deduped + capped in storage).
  const onCommandSent = useCallback((cmd) => {
    termRef.current?.wake?.(); // a dock send/fill landed → wake the poll loop (covers BottomDock too)
    const name = current?.session?.name;
    const win = current?.window?.id; // stable window ID, not the auto-renamed window.name
    if (name && win) setRecent(pushRecent(name, win, cmd));
  }, [current]);

  // ★/☆ on a panel row: toggle membership of the global favorites list.
  const toggleFavorite = useCallback((cmd) => {
    setFavorites(getFavorites().includes(cmd) ? removeFavorite(cmd) : addFavorite(cmd));
  }, []);
  // ✕ on a history row: drop that one entry from THIS window's recent history.
  const removeRecentCmd = useCallback((cmd) => {
    const name = current?.session?.name;
    const win = current?.window?.id; // stable window ID, not the auto-renamed window.name
    if (name && win) setRecent(removeRecent(name, win, cmd));
  }, [current]);

  // The current pane's cwd (from /panes), used as the default base when resolving a relative doc path.
  const currentPaneCwd = current?.panes?.find((p) => p.id === current.paneId)?.cwd || null;

  // Fetch + open a doc by ABSOLUTE path: dedupe into a tab, record the recent, reveal the sheet.
  // Throws on fetch failure so callers can decide (prompt for a base dir, or surface inline).
  const openAbsDoc = async (abs) => {
    // Images open in the inline viewer. Fetch the bytes HERE (not in DocView) so a bad path THROWS
    // just like fetchDoc does — that way a relative/ambiguous tap falls into the same "pick the base
    // dir" recovery below, instead of opening a dead tab. The object URL rides on the tab as content;
    // DocView revokes it on unmount. Re-tapping an already-open image just re-activates (no refetch).
    if (isImageName(abs)) {
      const name = abs.split('/').pop() || abs;
      // Re-tapping an already-open image re-activates it and refreshes (conditional — re-downloads only
      // if the file changed on disk); a first open fetches the bytes and records the mtime for later.
      if (docTabs.tabs.some((t) => t.key === abs)) { docTabs.activate(abs); refreshDocTab(abs); setFileManagerOpen(true); return; }
      const { url, mtimeMs } = await fetchImageUrl(abs); // throws on 404/401 → caller's recovery (toast / base prompt)
      docTabs.openDoc(abs, { type: 'image', name, content: url, mtime: mtimeMs });
      pushRecentDoc({ path: abs, name, type: 'image', ts: Date.now() });
      setFileManagerOpen(true);
      return;
    }
    const res = await fetchDoc(abs); // throws on non-2xx (404/400/…)
    docTabs.openDoc(abs, { type: res.type, name: res.name, content: res.content, mtime: res.mtimeMs });
    pushRecentDoc({ path: abs, name: res.name, type: res.type, ts: Date.now() });
    setFileManagerOpen(true);
  };

  // Closing an image tab frees its object URL (created in openAbsDoc). The URL must outlive tab
  // SWITCHES — DocView unmounts on every switch — so we revoke here, on actual close, not on unmount.
  const closeDocTab = (key) => {
    const tab = docTabs.tabs.find((t) => t.key === key);
    if (tab?.type === 'image' && tab.content) URL.revokeObjectURL(tab.content);
    docTabs.closeTab(key);
  };

  // Refetch a doc tab's content IN PLACE so it's never stale — whenever a doc becomes visible again:
  // switching to its tab, or re-opening the sheet. (Re-tapping a file goes through openAbsDoc, which
  // refetches too.) A CONDITIONAL GET (passes the tab's last-known mtime): if the file is unchanged the
  // server answers { notModified } and we do nothing — no content transfer, no re-render (so scroll and
  // read-aloud aren't disturbed when nothing changed). Images work the same way over /download (304 when
  // unchanged); a changed image swaps in a fresh object URL and revokes the old blob. Uses refreshDoc,
  // not openDoc, so an async result landing after the user has switched away doesn't steal focus back.
  // Best-effort: a since-deleted/moved/unreadable file keeps its last-good content.
  const refreshDocTab = (key) => {
    const tab = docTabs.tabs.find((t) => t.key === key);
    if (!tab || tab.type === 'home') return;
    if (tab.type === 'image') {
      fetchImageUrl(key, tab.mtime ?? null)
        .then((res) => {
          if (res.notModified) return; // unchanged → keep the same object URL (no re-download, no flash)
          const old = tab.content;
          docTabs.refreshDoc(key, { content: res.url, mtime: res.mtimeMs });
          if (old) URL.revokeObjectURL(old); // free the superseded blob (the <img> is already re-pointed)
        })
        .catch(() => { /* keep the last-good image */ });
      return;
    }
    fetchDoc(key, tab.mtime ?? null)
      .then((res) => {
        if (res.notModified) return; // unchanged on disk → leave the tab (and its scroll/TTS) alone
        docTabs.refreshDoc(key, { type: res.type, name: res.name, content: res.content, mtime: res.mtimeMs });
      })
      .catch(() => { /* keep the last-good content */ });
  };

  // Switching to a doc tab is instant (activate), then its content refreshes in the background.
  const activateDocTab = (key) => { docTabs.activate(key); refreshDocTab(key); };

  // Topbar file button: reveal the sheet and refresh whatever doc it lands on ("switch away & back").
  const reopenFiles = () => { setFileManagerOpen(true); refreshDocTab(docTabs.active); };

  // req() throws Error("/api/... -> 404"); map the trailing status to a readable reason.
  const friendlyDocError = (err) => {
    const m = /-> (\d+)/.exec(err?.message || '');
    const status = m ? Number(m[1]) : 0;
    if (status === 404) return t('app.docNotFound');
    if (status === 413) return t('app.docTooLarge');
    if (status === 400) return t('app.docUnsupported');
    return t('app.docOpenFailed');
  };

  // Entry from a terminal tap or the home path box. Absolute → open directly. Relative → resolve
  // against the pane's stored base (or its cwd); if that doesn't open, prompt for the base dir.
  const onOpenDoc = async (rawPath) => {
    if (isAbsolute(rawPath)) {
      // No base to fill for an absolute path → surface the reason as a transient toast.
      try { await openAbsDoc(rawPath); } catch (e) { setDocToast(friendlyDocError(e)); }
      return;
    }
    const base = getPaneBase(current?.paneId) ?? currentPaneCwd;
    if (base) {
      try { await openAbsDoc(joinPath(base, rawPath)); return; }
      catch { /* fall through to prompt */ }
    }
    setBasePrompt({ rawPath });
  };

  // DirPicker pick: resolve+open the unresolved relative path against the chosen base dir, then
  // remember it for this pane. On failure (still not found there), keep the picker open and surface
  // the reason as a toast so the user can pick another directory.
  const pickBaseDir = async (baseDir) => {
    try {
      await openAbsDoc(joinPath(baseDir, basePrompt.rawPath));
    } catch (e) {
      setDocToast(friendlyDocError(e));
      return;
    }
    if (current?.paneId) setPaneBase(current.paneId, baseDir);
    // Defer the picker close by a tick. openAbsDoc just opened FileManager, whose layered-Back effect
    // synchronously pushes a history entry. If we closed the picker in THIS commit, useBackButton's
    // cleanup (cleanups run before setups) would fire history.back() to reclaim the picker's entry
    // BEFORE FileManager's push — and FileManager's freshly-bound popstate handler would catch that
    // stray pop and step "back" out of the just-opened preview into its directory (so the doc never
    // shows and you had to tap again). One tick later, FileManager's entry is already on top, so the
    // cleanup sees a non-overlay state and skips the reclaim — no stray pop.
    setTimeout(() => setBasePrompt(null), 0);
  };

  // A tapped terminal path doesn't open straight away (anti-误触): pop a confirm card near the tap.
  // Pass the raw tap point — DocLinkPopover clamps its own measured box inside the viewport.
  const onDocLinkTap = (path, cx, cy) => setDocLinkPrompt({ path, x: cx, y: cy });
  const confirmDocLink = (path) => { setDocLinkPrompt(null); onOpenDoc(path); };

  // Auto-dismiss the doc toast after a few seconds (also dismissible by tap).
  useEffect(() => {
    if (!docToast) return;
    const id = setTimeout(() => setDocToast(null), 4000);
    return () => clearTimeout(id);
  }, [docToast]);

  // Initial open: resolve the target session by precedence hash > last > first, then open it.
  // The URL hash (#session-name) deep-links to a session; otherwise the last-opened session;
  // otherwise the first. openSession itself restores that session's remembered window/pane.
  useEffect(() => {
    if (needToken) return;
    const names = getBoundSessions();
    if (!names.length) { setBooting(false); return; } // nothing pinned → land on the empty state
    let cancelled = false;
    (async () => {
      try {
        const sessions = await getSessions();
        if (cancelled || !sessions.length) return;
        // Only auto-open a session that's BOTH pinned on this device and currently alive.
        const alive = sessions.filter((s) => names.includes(s.name));
        if (!alive.length) return;
        const route = readRoute();
        let session = route.session ? alive.find((s) => s.name === route.session) : null;
        const target = session ? { window: route.window, pane: route.pane } : null;
        if (!session) {
          const lastId = getLastSession();
          if (lastId) session = alive.find((s) => s.id === lastId);
        }
        if (!session) session = alive[0];
        if (!cancelled) await openSession(session, target);
      } catch (e) {
        handledAuth(e); // onAuthFail === setNeedToken(true)
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [needToken, openSession]);

  // Poll pane states for the inbox. Light cadence; paused while the tab is hidden. This is
  // separate from the terminal's own poll — it only feeds the inbox roster / unread count. Re-polls
  // immediately when `bound` changes (the deps) so a bind/unbind updates the filtered roster at once.
  usePollingLoop({
    fetch: () => getStates(bound),
    apply: (s) => setStates(s || {}),
    intervalMs: 5000,
    enabled: !needToken,
    deps: [bound],
  });

  // First non-empty /states with no stored read-ts: treat everything already there as history (seed the
  // high-water mark to the current max ts) so a cold start doesn't flood the inbox with old completions.
  useEffect(() => {
    if (readTs != null) return;
    const m = maxTs(states);
    if (m > 0) { setInboxReadTs(m); setReadTs(m); }
  }, [states, readTs]);

  // Poll orphan claude sessions for the inbox footer. Slower cadence than /states (a ps+lsof scan is
  // heavier and orphans change rarely), paused while the tab is hidden.
  usePollingLoop({
    fetch: getOrphans,
    apply: (o) => setOrphans(Array.isArray(o) ? o : []),
    intervalMs: 15000,
    enabled: !needToken,
  });

  if (needToken) {
    return <TokenPrompt onSaved={() => { setNeedToken(false); setBooting(true); }} />;
  }

  const inboxList = inboxRows(states, seen, readTs == null ? Infinity : readTs);
  const inboxTop = topView(inboxList);
  // windowId → agent id, for the per-window agent logo on a collapsed WindowTab (a single-pane window, or an
  // inactive multi-pane one where we only have this aggregate). The active multi-pane window renders per-pane
  // instead (paneAgents below), so it doesn't rely on this squash. A state entry exists only for a pane
  // actually running an agent, so this is its agent.
  const windowAgents = {};
  for (const st of Object.values(states)) if (st.window && st.agent) windowAgents[st.window] = st.agent;
  // paneId → agent id, for the per-pane agent logo inside the active window's pane menu (states is keyed by
  // pane, so this is the live truth for each one; a pane not running an agent simply has no entry → no logo).
  const paneAgents = {};
  for (const [pane, st] of Object.entries(states)) if (st.agent) paneAgents[pane] = st.agent;
  const changelogUnread = !!LATEST_RELEASE && clSeen !== LATEST_RELEASE;
  // The gear's dot fuses two phases of "there's something new": an available npm update (before you upgrade)
  // and, after upgrading+reloading, the unread changelog it brought. `updateDot` stays off once the user has
  // opened Settings for this `latest` (verSeen), even if they don't upgrade — it relights only on a newer release.
  const updateDot = !!updateInfo?.updateAvailable && updateInfo.latest !== verSeen;
  const gearDot = changelogUnread || updateDot;
  const openSettings = () => {
    setSettingsOpen(true);
    if (updateInfo?.latest) { setVersionSeen(updateInfo.latest); setVerSeen(updateInfo.latest); } // acknowledge → clears updateDot
  };
  const openChangelog = () => {
    setSettingsOpen(false);
    setChangelogOpen(true);
    setChangelogSeen(LATEST_RELEASE); setClSeen(LATEST_RELEASE); // opening clears the unread dot
  };

  return (
    // When the soft keyboard opens, slide the WHOLE app up by the keyboard height so it moves
    // as one unit: the keys + input land just above the keyboard and the terminal's bottom sits
    // right above the keys (the topbar scrolls off the top, which is fine while typing). Uses a
    // transform — the same lift that worked on the dock — so iOS can't undo it by re-scrolling.
    <div className="app" style={inset ? { transform: `translateY(-${inset}px)` } : undefined}>
      <header className="topbar">
        <button className="hamburger" onClick={() => setDrawerOpen(true)}>☰</button>
        <span className="session-name" {...sessionNameLongPress}>{current?.session?.name ?? '—'}</span>
        {/* Leftmost of the right-hand icon group; steady green signals a live preview. */}
        {activePreview && (
          <button className="topbar-icon preview-live" onClick={() => setPreviewSheetOpen(true)}
            aria-label={t('app.preview')} title={t('app.openPreview')}><MonitorIcon /></button>
        )}
        {/* Always render so it doesn't pop in late once `current` loads — just disable until ready. */}
        <button className="topbar-icon" onClick={() => setIdeaOpen(true)} aria-label={t('app.ideas')} title={t('app.ideas')}
          disabled={!current}>
          <BulbIcon />
          {ideaCount > 0 && <span className="idea-badge">{ideaCount}</span>}
        </button>
        <Inbox
          rows={inboxList}
          top={inboxTop}
          open={inboxOpen}
          onToggle={() => setInboxOpen((o) => !o)}
          onClose={() => setInboxOpen(false)}
          onSelectRow={openInboxRow}
          onMarkAllRead={markAllRead}
          hooksStatus={hooksStatus}
          onEnableHooks={enableHooks}
        />
        <button className="topbar-icon" onClick={() => setUsageOpen(true)} aria-label={t('usage.title')} title={t('usage.title')}><GaugeIcon /></button>
        <button className="topbar-icon" onClick={reopenFiles} aria-label={t('app.files')} title={t('app.files')}><FolderIcon /></button>
        <button className="topbar-icon" onClick={() => setGitOpen(true)} aria-label="Git" title="Git"><GitIcon /></button>
        <button className="topbar-icon" onClick={openSettings} aria-label={t('app.settings')} title={t('app.settings')}>
          <GearIcon />
          {gearDot && <span className="topbar-dot" aria-hidden="true" />}
        </button>
      </header>
      <UsagePage
        open={usageOpen}
        onClose={() => setUsageOpen(false)}
        onAuthFail={onAuthFail}
      />
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        termRef={termRef}
        getColCount={() => tmuxColsRef.current ?? termRef.current?.getSize()?.cols}
        onColAdjust={(d) => tmuxResizeCols(d)}
        onColRestore={tmuxRestore}
        onOpenChangelog={openChangelog}
        changelogUnread={changelogUnread}
        updateInfo={updateInfo}
        activePreview={activePreview}
        pane={current?.paneId}
        lastPreviewDir={getPreviewDir(current?.window?.id)}
        dynamicEnabled={dynamicEnabled}
        onStartPreview={startPreview}
        onStartDynamicPreview={startDynamicPreview}
        onOpenPreview={openPreviewSheet}
        onRenew={renewPreview}
        onStop={stopPreview}
      />
      <Changelog open={changelogOpen} onClose={() => setChangelogOpen(false)} />
      <Drawer
        open={drawerOpen}
        currentSessionName={current?.session?.name}
        bound={bound}
        onSelectSession={selectSession}
        onUnbind={unbindSession}
        onBind={() => setBindOpen(true)}
        onClose={() => setDrawerOpen(false)}
        onLogout={logout}
        orphans={orphans}
        onTakeoverRequest={setTakeoverTarget}
      />
      <BindSession
        open={bindOpen}
        bound={bound}
        onBound={bindSession}
        onClose={() => setBindOpen(false)}
        onAuthFail={onAuthFail}
        inset={inset}
      />
      <NewWindowModal
        open={newWinOpen}
        onClose={() => setNewWinOpen(false)}
        onCreate={createNewWindow}
        paneId={current?.paneId}
        inset={inset}
      />
      <RenameModal
        open={!!renameTarget}
        title={renameTarget?.kind === 'session' ? t('app.renameSession') : t('app.renameWindow')}
        currentName={renameTarget?.name || ''}
        onClose={() => setRenameTarget(null)}
        onSubmit={submitRename}
        inset={inset}
      />
      <OrphanTakeoverSheet
        open={!!takeoverTarget}
        orphan={takeoverTarget}
        onConfirm={doTakeover}
        onClose={() => setTakeoverTarget(null)}
        inset={inset}
      />
      <ActionSheet
        open={!!manageWindow}
        title={manageWindow ? (manageWindow.name || manageWindow.id) : ''}
        onClose={() => setManageWindow(null)}
        actions={manageWindow ? [
          // A single-pane window has nothing to reorder-within, but IS splittable — offer it here so a
          // lone pane can be split from the window-level menu (the per-pane menu only appears once there's
          // a map to long-press). Shown for ANY single-pane window, current or not (split switches to it).
          ...(manageWindow.panes === 1 ? [
            { key: 'split-h', icon: <SplitHIcon />, label: t('pane.splitH'), onClick: () => splitWindowAction(manageWindow, 'h') },
            { key: 'split-v', icon: <SplitVIcon />, label: t('pane.splitV'), onClick: () => splitWindowAction(manageWindow, 'v') },
          ] : []),
          // A window that ALREADY has a split → jump straight to its split map to manage the panes.
          ...(manageWindow.panes > 1 ? [
            { key: 'manage-split', icon: <PaneMapIcon />, label: t('pane.manage'), onClick: () => manageSplit(manageWindow) },
          ] : []),
          // Reorder: shown only with >1 window (nothing to reorder otherwise, mirrors delete). Each
          // direction disables at its edge so positions stay put during repeated taps. onClick does
          // NOT close the sheet — moveManagedWindow keeps it open for the next nudge.
          ...(current && current.windows.length > 1 ? [[
            {
              key: 'move-left', label: t('app.moveLeft'),
              disabled: !moveTarget(current.windows, manageWindow.id, 'left'),
              onClick: () => moveManagedWindow('left'),
            },
            {
              key: 'move-right', label: t('app.moveRight'),
              disabled: !moveTarget(current.windows, manageWindow.id, 'right'),
              onClick: () => moveManagedWindow('right'),
            },
          ]] : []),
          {
            key: 'rename', label: t('common.rename'),
            onClick: () => { setRenameTarget({ kind: 'window', id: manageWindow.id, name: manageWindow.name || '' }); setManageWindow(null); },
          },
          // Deleting the session's last window takes the whole session down — still allowed, but the
          // confirm step warns about it explicitly (a normal window just confirms the delete).
          {
            key: 'delete', label: t('app.deleteWindow'), danger: true, confirm: true,
            confirmLabel: current && current.windows.length <= 1
              ? t('app.deleteLastWindowConfirm')
              : t('app.deleteConfirm'),
            onClick: deleteManagedWindow,
          },
        ] : []}
      />
      <ActionSheet
        open={!!managePane}
        title={(() => {
          if (!managePane || !current) return '';
          const idx = current.panes.findIndex((p) => p.id === managePane);
          const p = current.panes[idx];
          if (!p) return '';
          const seq = idx < CIRCLED.length ? CIRCLED[idx] : String(idx + 1);
          return `${seq} ${p.command || p.id}`;
        })()}
        onClose={() => setManagePane(null)}
        actions={managePane ? [
          { key: 'split-h', icon: <SplitHIcon />, label: t('pane.splitH'), onClick: () => splitPaneAction(managePane, 'h') },
          { key: 'split-v', icon: <SplitVIcon />, label: t('pane.splitV'), onClick: () => splitPaneAction(managePane, 'v') },
          {
            key: 'close', icon: <XIcon />, label: t('pane.close'), danger: true, confirm: true,
            confirmLabel: t('pane.closeConfirm'), onClick: closeManagedPane,
          },
        ] : []}
      />
      <FileManager
        open={fileManagerOpen}
        pane={current?.paneId}
        windowId={current?.window?.id}
        tabs={docTabs.tabs}
        active={docTabs.active}
        onActivate={activateDocTab}
        onCloseTab={closeDocTab}
        onMinimize={() => setFileManagerOpen(false)}
        onOpenDoc={onOpenDoc}
        pendingShare={pendingShare}
        onPendingConsumed={() => setPendingShare(null)}
      />
      <GitPanel open={gitOpen} pane={current?.paneId} windowId={current?.window?.id} inset={inset} onClose={() => setGitOpen(false)} />
      {/* App-wide upload lock (portal on <body>) — driven by the shared uploadJob store from either the
          chat ＋ or the file browser; blocks interaction during a transfer, Cancel is the only control. */}
      <UploadOverlay />
      {/* One-time "Add to Home Screen" coach — self-gates (standalone / dismissed / desktop → nothing). */}
      <AddToHome />
      {/* Auto-closes when there's no active preview (stopped/expired); 收起 just slides it down. */}
      <PreviewSheet
        open={previewSheetOpen && !!activePreview}
        name={activePreview?.name}
        kind={activePreview?.kind}
        domain={previewDomain}
        port={activePreview?.port}
        dir={activePreview?.dir}
        expiresAt={activePreview?.expiresAt}
        onRenew={renewPreview}
        onStop={stopPreview}
        onMinimize={() => setPreviewSheetOpen(false)}
      />
      {docToast && (
        <div className="doc-toast" role="alert" onClick={() => setDocToast(null)}>{docToast}</div>
      )}
      {exitHint && (
        <div className="exit-toast" role="status">{t('app.backToExit')}</div>
      )}
      {docLinkPrompt && (
        <DocLinkPopover
          path={docLinkPrompt.path}
          x={docLinkPrompt.x}
          y={docLinkPrompt.y}
          onOpen={confirmDocLink}
          onClose={() => setDocLinkPrompt(null)}
        />
      )}
      <IdeaPanel
        open={ideaOpen}
        session={current?.session?.name}
        window={current?.window?.name || current?.window?.id}
        onClose={() => setIdeaOpen(false)}
        onSend={(text) => { dockRef.current?.fill(text); setIdeaOpen(false); }}
        onCountChange={setIdeaCount}
      />
      <DirPicker
        open={!!basePrompt}
        seedCwd={getPaneBase(current?.paneId) ?? currentPaneCwd ?? null}
        pane={current?.paneId ?? null}
        hint={basePrompt ? <>{t('app.cannotLocate')} <code>{basePrompt.rawPath}</code>{t('app.pickItsDir')}</> : null}
        onPick={pickBaseDir}
        onClose={() => setBasePrompt(null)}
        inset={inset}
      />
      {current ? (
        <>
          <WindowBar
            windows={current.windows}
            windowAgents={windowAgents}
            paneAgents={paneAgents}
            currentAgent={states[current.paneId]?.agent}
            currentWindowId={current.window.id}
            panes={current.panes}
            currentPaneId={current.paneId}
            onSelectWindow={selectWindow}
            onSelectPane={selectPane}
            onNewWindow={() => setNewWinOpen(true)}
            onManageWindow={(w) => setManageWindow(w)}
            onManagePane={(paneId) => setManagePane(paneId)}
            paneSheetOpen={!!managePane}
            openMapFor={openMapFor}
            onMapOpened={() => setOpenMapFor(null)}
            trackWindowId={manageWindow?.id}
          />
          {current.paneId && (
            <Terminal
              ref={termRef}
              key={current.paneId}
              pane={current.paneId}
              inset={inset}
              onAuthFail={onAuthFail}
              onDocLinkTap={onDocLinkTap}
              onTap={() => dockRef.current?.hideKeyboard()}
            />
          )}
          <BottomDock
            ref={dockRef}
            pane={current.paneId}
            onAuthFail={onAuthFail}
            onKey={sendKey}
            onText={sendChar}
            cwd={currentPaneCwd}
            agent={states[current.paneId]?.agent}
            windowId={current.window?.id}
            recent={recent}
            favorites={favorites}
            onSent={onCommandSent}
            onToggleFav={toggleFavorite}
            onRemoveRecent={removeRecentCmd}
            inset={inset}
          />
        </>
      ) : booting ? (
        <div className="loading">{t('common.loading')}</div>
      ) : bound.length === 0 ? (
        <button className="empty-cta" onClick={() => setBindOpen(true)}>
          {t('app.noBoundSession')}<span>{t('app.tapToBind')}</span>
        </button>
      ) : (
        <div className="loading">{t('app.selectSessionHint')}</div>
      )}
    </div>
  );
}
