import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { t } from './i18n';
import {
  getToken, getLastSession, getLastWindow, getLastPane, remember, clearToken,
  getBoundSessions, addBoundSession, removeBoundSession, renameBoundSession,
  getFavorites, addFavorite, removeFavorite, getRecent, pushRecent, removeRecent,
  pushRecentDoc, getPaneBase, setPaneBase,
  getInboxSeen, markInboxSeen, getInboxReadTs, setInboxReadTs,
  renameWindowIdeas, getChangelogSeen, setChangelogSeen,
  getVersionSeen, setVersionSeen,
  getReadInboxIds, addReadInboxId, pruneReadInboxIds, getNotifSeenTs, setNotifSeenTs,
  getIdeas, getChatTone, setChatTone, getAgentConversationEnabled, setAgentConversationEnabled,
  getWorkspacePromptState, markWorkspaceAutoShown, ignoreWorkspaceCheckpoint,
  applyWorkspaceRestoreMapping, removeRestoredSessionBindings, setRootView,
} from './storage.js';
import type { ChatTone, RootView } from './storage.js';
import { LATEST_RELEASE } from './changelog.js';
import {
  getSessions, getWindows, getPanes, resizeWindow, resizePane, getWindowLayout,
  applyWindowLayout, restoreWindowSize, sendKeys, sendText, createWindow,
  renameSession, renameWindow, deleteWindow, swapWindows, fetchDoc, fetchImageUrl,
  getStates, getOrphans, takeoverOrphan, getAgentDiscovery, markAgentTerminalNotificationsRead,
  getServerVersion,
  getWorkspaceProtectionStatus, getWorkspaceRestorePlan, startWorkspaceRestore, getWorkspaceRestoreOperation,
  ApiError,
  splitPane as apiSplitPane, closePane as apiClosePane,
} from './api.js';
import { runSplitPane, runClosePane } from './paneActions.js';
import BrowserSheet from './components/BrowserSheet.jsx';
import { applyTerminalReads, inboxRows, topView, maxTs, visibleCurrentPaneState } from './inbox.js';
import type { PaneInboxState } from './inbox.js';
import { moveTarget } from './windowOrder.js';
import { reportBound, clearPaneNotification, getNotifications, deleteNotification } from './push.js';
import type { PushInboxItem } from './push.js';
import InboxPage from './components/InboxPage.jsx';
import { isAbsolute, joinPath } from './docPath.js';
import { isImageName } from './mime.js';
import { useDocTabs } from './hooks/useDocTabs.js';
import { usePreviews } from './hooks/usePreviews.js';
import { useBrowser } from './hooks/useBrowser.js';
import { browserEntryStatus } from './browserState.js';
import { usePollingLoop } from './hooks/usePollingLoop.js';
import { useServerConfig } from './hooks/useServerConfig.js';
import { authHandled } from './authGuard.js';
import {
  clearPaneConversationIdentities,
  currentPaneAgent,
  hasCanonicalCurrentPaneAgent,
  navigationAgentMaps,
} from './paneAgents.js';
import { OverlayProvider } from './overlays/OverlayHost.js';
import { useOverlayActivity } from './hooks/useOverlayActivity.js';

import Drawer from './components/Drawer.jsx';
import type { DrawerOrphan } from './components/Drawer.jsx';
import WindowBar from './components/WindowBar.jsx';
import type { WorkspacePane, WorkspaceWindow } from './components/WindowBar.jsx';
import Terminal from './components/Terminal.jsx';
import type { TerminalHandle } from './components/Terminal.jsx';
import type { TerminalOutputLink } from './terminalXterm.js';
import BottomDock from './components/BottomDock.jsx';
import type { BottomDockHandle } from './components/BottomDock.jsx';
import LensSwitch from './components/LensSwitch.jsx';
import type { WorkspaceLens } from './components/LensSwitch.jsx';
import AgentConversationView, { AgentConversationErrorView } from './components/AgentConversationView.jsx';
import AgentConversationComposer from './components/AgentConversationComposer.jsx';
import AgentInteractionLayer from './components/AgentInteractionLayer.jsx';
import AgentConversationActivationGuide from './components/AgentConversationActivationGuide.jsx';
import AgentModelControl from './components/AgentModelControl.jsx';
import {
  AgentConversationActionControls,
  AgentConversationMilestoneControls,
  AgentConversationQueueControl,
} from './components/AgentConversationCapabilityControls.js';
import PaneSurfaceHost from './components/PaneSurfaceHost.jsx';
import TokenPrompt from './components/TokenPrompt.jsx';
import Settings from './components/Settings.jsx';
import WorkspaceRestoreDialog from './components/WorkspaceRestoreDialog.jsx';
import UsagePage from './components/UsagePage.jsx';
import Inbox from './components/Inbox.jsx';
import OrphanTakeoverSheet from './components/OrphanTakeoverSheet.jsx';
import type { OrphanSession, OrphanTakeoverRequest } from './components/OrphanTakeoverSheet.jsx';
import AddToHome from './components/AddToHome.jsx';
import { useClaudeHooks } from './useClaudeHooks.js';
import BindSession from './components/BindSession.jsx';
import NewWindowModal from './components/NewWindowModal.jsx';
import RenameModal from './components/RenameModal.jsx';
import ActionSheet from './components/ActionSheet.jsx';
import ColumnStepper from './components/ColumnStepper.jsx';
import FileManager from './components/FileManager.jsx';
import GitPanel from './components/GitPanel.jsx';
import UploadOverlay from './components/UploadOverlay.jsx';
import DirPicker from './components/DirPicker.jsx';
import DocLinkPopover from './components/DocLinkPopover.jsx';
import IdeaPanel from './components/IdeaPanel.jsx';
import Changelog from './components/Changelog.jsx';
import { FolderIcon, GearIcon, BulbIcon, MonitorIcon, GlobeIcon, GitIcon, GaugeIcon, SplitHIcon, SplitVIcon, PaneMapIcon, XIcon } from './components/icons.jsx';
import { useKeyboardInset } from './hooks/useKeyboardInset.js';
import { useAsrAvailable } from './voice/useAsrAvailable.js';
import { usePageScrollLock } from './hooks/usePageScrollLock.js';
import { useLongPress } from './hooks/useLongPress.js';
import { useBrowserBackStack } from './hooks/useBrowserBackStack.js';
import { useBackButton, useHistoryLayer, unwindHistory } from './hooks/useBackButton.js';
import { useExitConfirm } from './hooks/useExitConfirm.js';
import { readRoute, writeSessionHash } from './hashRoute.js';
import { hasShareFlag, takeSharedFile, clearShareFlag } from './shareIntake.js';
import { windowManageSubtitle, paneManageSubtitle } from './manageLabels.js';
import { DEFAULT_SERVER_SHORTCUTS } from './shortcutMerge.js';
import { recoveryPromptMode } from './workspaceRecovery.js';
import type {
  WorkspaceRecoveryPlan,
  WorkspaceRestoreOperation,
  WorkspaceRestoreResult,
} from './workspaceRecovery.js';
import { canResizePaneWidth } from './paneLayout.js';
import { AgentCatalogProvider, inboxReconnectNeeded } from './agentCatalog.js';
import type { AgentCatalogDescriptor, AgentDiscoverySnapshot, AgentRunRef } from './agentCatalog.js';
import { canSendConversation, useAgentConversation } from './hooks/useAgentConversation.js';
import { useAgentInteraction } from './hooks/useAgentInteraction.js';
import { useAgentSessionControl } from './hooks/useAgentSessionControl.js';
import { useAgentIntegrations } from './hooks/useAgentIntegrations.js';
import { useAgentConversationControls } from './hooks/useAgentConversationControls.js';
import {
  projectConversationActivity,
  projectConversationSubmissions,
  projectConversationTimeline,
} from './conversationSubmissionProjection.js';
import { useAgentConversationActivation } from './hooks/useAgentConversationActivation.js';
import type { AgentConversationIdentity } from './hooks/useAgentConversation.js';
import {
  desktopInputEnvironment,
  getKeyboardMode,
  keyboardModeUsesDesktop,
  setKeyboardMode,
} from './desktopInput.js';
import { useDesktopTerminalInput } from './hooks/useDesktopTerminalInput.js';
import ProjectRoot from './projectTask/ProjectRoot.js';
import type { ShortcutItem } from './shortcutMerge.js';
import type { BrowserMode } from './browserState.js';
import { isDraftShortcut, shouldRouteTerminalPageKey } from './terminalPageKeyboard.js';
import {
  getSnapshotInterval,
  getTerminalTransport,
  setSnapshotInterval,
  setTerminalTransport,
  terminalStreamEnabled,
} from './terminalTransport.js';

interface HostSession {
  id: string;
  name: string;
}

const EMPTY_AGENT_CATALOG: readonly AgentCatalogDescriptor[] = [];

interface HostWindow extends WorkspaceWindow {
  name: string;
  width?: number;
  activePaneId?: string;
}

interface HostPane extends WorkspacePane {
  id: string;
  cwd?: string | null;
}

interface CurrentWorkspace {
  session: HostSession;
  windows: HostWindow[];
  window: HostWindow;
  panes: HostPane[];
  paneId: string;
}

interface RenameTarget {
  kind: 'session' | 'window';
  id: string;
  name: string;
}

interface CompletedChatEntryRequest {
  paneId: string;
  session: string;
  window: string;
  request: number;
}

interface UpdateInfo {
  current?: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
  whatsNew?: { version: string; zh?: string; en?: string }[];
}

interface WorkspaceProtection {
  status?: string;
  errorCode?: string | null;
}

interface RecoveryOperationState extends WorkspaceRestoreOperation {
  id?: string;
}

interface RecoveryContext {
  generation: number;
  checkpointId: string;
  operationId: string | null;
}

interface WorkspaceTarget {
  window?: string | null;
  pane?: string | null;
}

interface OpenSessionOptions {
  isCancelled?: () => boolean;
}

interface DocLinkPrompt { path: string; x: number; y: number }
interface LocalUrlPrompt { raw: string; x: number; y: number }
interface OutputLink {
  kind: 'url' | 'doc';
  path?: string;
  raw?: string;
  protocol?: string;
  port?: string | number;
  urlPath?: string;
}
interface BasePrompt { rawPath: string }
type FocusOwner = 'terminal' | 'composer';

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

const hostWindow = (window: WorkspaceWindow): HostWindow => ({
  ...window,
  name: window.name || window.id,
});

const clampCols = (cols: number): number => Math.max(20, Math.min(500, cols));
const MAX_REMEMBERED_PANES = 128;

function rememberRecent<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_REMEMBERED_PANES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// Pick the remembered id if it still exists, else the first. We deliberately don't fall back
// to tmux's "active" — the local last-opened choice wins, first is the fallback.
const pickId = <T extends { id: string }>(items: readonly T[], prefer?: string | null): string => {
  if (prefer && items.some((item) => item.id === prefer)) return prefer;
  const first = items[0];
  if (!first) throw new Error('Cannot pick from an empty item list');
  return first.id;
};

export default function App() {
  const detectedDesktopInput = useMemo(() => desktopInputEnvironment(), []);
  const [keyboardMode, setKeyboardModeState] = useState(getKeyboardMode);
  const desktopInput = keyboardModeUsesDesktop(keyboardMode, detectedDesktopInput);
  const [terminalTransport, setTerminalTransportState] = useState(getTerminalTransport);
  const [snapshotInterval, setSnapshotIntervalState] = useState(getSnapshotInterval);
  const terminalStream = typeof window !== 'undefined'
    && terminalStreamEnabled(window.location, terminalTransport);
  const [needToken, setNeedToken] = useState(!getToken());
  const serverConfig = useServerConfig({ enabled: !needToken });
  const serverShortcuts = serverConfig?.shortcuts || DEFAULT_SERVER_SHORTCUTS;
  const micAvailable = useAsrAvailable(serverConfig);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Keep the unfinished Project Task control plane dormant until it can actually run and advance work.
  // In particular, ignore any development-only browser flag left behind by an earlier local build.
  const projectTaskBeta = false;
  const [rootView, setRootViewState] = useState<RootView>('session');
  const chooseRootView = (view: RootView): void => {
    if (view === 'project' && !projectTaskBeta) return;
    setRootView(view);
    setRootViewState(view);
    setDrawerOpen(false);
  };
  const [chatTone, setChatToneState] = useState(getChatTone); // 对话-lens colour tone (persisted); default 深墨
  const pickChatTone = (tone: ChatTone) => { setChatTone(tone); setChatToneState(tone); };
  const [conversationEnabledByAgent, setConversationEnabledByAgent] = useState<Record<string, boolean>>({});
  const [usageOpen, setUsageOpen] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [newWinOpen, setNewWinOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null); // { kind:'session'|'window', id, name } | null
  const [manageWindow, setManageWindow] = useState<HostWindow | null>(null); // the window long-pressed for its action menu
  const [managePane, setManagePane] = useState<string | null>(null); // pane id long-pressed in the map
  const [managedPaneWidth, setManagedPaneWidth] = useState<number | null>(null);
  const [paneLayoutRestoreReady, setPaneLayoutRestoreReady] = useState(false);
  const [windowResizePending, setWindowResizePending] = useState(0);
  const [paneResizePending, setPaneResizePending] = useState(0);
  const [openMapFor, setOpenMapFor] = useState<string | null>(null); // window id whose split map "管理分屏" asked to open
  const [paneMapOpen, setPaneMapOpen] = useState(false);
  const [fileManagerOpen, setFileManagerOpen] = useState(false); // file-viewer bottom-sheet visibility
  const [gitOpen, setGitOpen] = useState(false);
  const [pendingShare, setPendingShare] = useState<File | null>(null); // a File shared in via Web Share Target, awaiting a destination
  const [basePrompt, setBasePrompt] = useState<BasePrompt | null>(null); // { rawPath } while asking for a relative path's base dir
  const [chatFollowLatest, setChatFollowLatest] = useState({ paneId: '', request: 0 });
  const [completedChatEntry, setCompletedChatEntry] = useState<CompletedChatEntryRequest | null>(null);
  const completedChatEntrySeqRef = useRef(0);
  const conversationIdentityByPaneRef = useRef(new Map<string, AgentConversationIdentity>());
  const [docToast, setDocToast] = useState<string | null>(null); // transient error toast for absolute-path doc failures
  const [exitHint, setExitHint] = useState(false); // "press Back again to exit" hint (double-back guard)
  const [docLinkPrompt, setDocLinkPrompt] = useState<DocLinkPrompt | null>(null); // { path, x, y } confirm popover for a tapped terminal path
  const [docLinkOpening, setDocLinkOpening] = useState(false);
  const pendingDocLinkRef = useRef<string | null>(null);
  const [localUrlPrompt, setLocalUrlPrompt] = useState<LocalUrlPrompt | null>(null); // { raw, x, y } for a tapped web URL
  const docTabs = useDocTabs(); // file-viewer tab state, kept across sheet open/close
  const browser = useBrowser({ enabled: !needToken, browserProxy: !!serverConfig?.browserProxy });
  const [bound, setBound] = useState(getBoundSessions); // session names pinned on this device
  const [favorites, setFavorites] = useState(getFavorites); // global favorite commands
  const [recent, setRecent] = useState<string[]>([]); // current session's recent commands (keyed by session name)
  const [current, setCurrent] = useState<CurrentWorkspace | null>(null); // { session, windows, window, panes, paneId }
  const currentRef = useRef<CurrentWorkspace | null>(null); currentRef.current = current;
  const windowSwitchRef = useRef(0); // only the newest async pane lookup may finish a window switch
  const topologyRecoveryRef = useRef<Promise<void> | null>(null);
  const [booting, setBooting] = useState(true);
  const [recoveryPlan, setRecoveryPlan] = useState<WorkspaceRecoveryPlan | null>(null);
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [recoveryOperation, setRecoveryOperation] = useState<RecoveryOperationState | null>(null);
  const [recoverySubmitting, setRecoverySubmitting] = useState(false);
  const [workspaceProtection, setWorkspaceProtection] = useState<WorkspaceProtection | null>(null);
  const [states, setStates] = useState<Record<string, PaneInboxState>>({}); // pane → {session,window,kind,…} from /api/states
  const [agentDiscovery, setAgentDiscovery] = useState<AgentDiscoverySnapshot | null>(null);
  const currentPaneId = current?.paneId ?? null;
  const [lensSelection, setLensSelection] = useState<{
    paneId: string | null;
    value: WorkspaceLens;
  }>({ paneId: null, value: 'terminal' });
  // Resolve a pane's saved lens during render. Waiting for an effect would commit the previous pane's
  // lens once, briefly mounting the wrong Terminal/Conversation consumer and issuing avoidable requests.
  const lens: WorkspaceLens = lensSelection.paneId === currentPaneId
    ? lensSelection.value
    : localStorage.getItem('tw_lens_' + currentPaneId) === 'chat' ? 'chat' : 'terminal';
  const setLens = useCallback((value: WorkspaceLens): void => {
    setLensSelection({ paneId: currentPaneId, value });
  }, [currentPaneId]);
  const [orphans, setOrphans] = useState<DrawerOrphan[]>([]); // claude sessions running outside tmux (/api/orphans)
  const [takeoverTarget, setTakeoverTarget] = useState<OrphanSession | null>(null); // orphan being taken over (opens the sheet)
  const [inboxOpen, setInboxOpen] = useState(false); // inbox dropdown open
  const { status: hooksStatus, enable: enableHooks } = useClaudeHooks(serverConfig);
  const agentIntegrations = useAgentIntegrations({ enabled: settingsOpen });
  const [ideaOpen, setIdeaOpen] = useState(false); // per-window idea sheet open
  const [ideaCount, setIdeaCount] = useState(0);   // idea count for the current window (badge)
  const [changelogOpen, setChangelogOpen] = useState(false); // "what's new" sheet open
  const [clSeen, setClSeen] = useState(getChangelogSeen); // latest changelog id the user has opened
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null); // { current, latest, updateAvailable } — npm update hint (checked once per launch)
  const [verSeen, setVerSeen] = useState(getVersionSeen); // npm "latest" already acknowledged by opening Settings
  const [seen, setSeen] = useState(getInboxSeen); // pane → last-viewed ts (inbox read state)
  const [readTs, setReadTs] = useState(getInboxReadTs); // server-ts high-water mark for done history (null=unset)
  const [notifItems, setNotifItems] = useState<PushInboxItem[]>([]);            // manual-push inbox records (newest-first)
  const [notifError, setNotifError] = useState('');            // load/delete failure; last good items stay visible
  const [notifRetrySeq, setNotifRetrySeq] = useState(0);       // explicit retry trigger for the non-polling inbox
  const [notifDeletingId, setNotifDeletingId] = useState<string | null>(null);// server-confirmed delete in flight
  const notifDeleteRef = useRef(false);                        // synchronous double-tap guard (state updates lag)
  const notifMutationRef = useRef(0);                          // stale loads cannot undo a confirmed delete
  const [readIds, setReadIds] = useState(getReadInboxIds);      // ids already opened (per-device)
  const [notifInboxOpen, setNotifInboxOpen] = useState(false);  // full-screen inbox list page
  const [notifDetailId, setNotifDetailId] = useState<string | null>(null);     // open message detail (null = list only)
  const [pendingNotifDetail, setPendingNotifDetail] = useState<string | null>(null); // deep-link: drill here once the list is open
  const [notifSeenTs, setNotifSeenTsState] = useState(getNotifSeenTs); // newest ts seen by opening the inbox (top-dot high-water)
  // Manual-push inbox open/close/detail/delete — declared this early (ahead of the SW-message and
  // boot deep-link effects further down) so nothing references them before their const initializer runs.
  // Settings remains mounted underneath: the inbox is a real child history layer, not a swap to root.
  const openNotifInbox = () => setNotifInboxOpen(true);
  // Multi-level Back for the inbox, mirroring GitPanel/FileManager (see the comment on their useBackButton
  // group): we MIRROR the nav depth into browser history — one entry for the open list, one more for a drill
  // into a message detail. Back pops one entry → the popstate handler (below) pops one level; at the base
  // (list) Back closes the panel. CRITICAL: the popstate handler only READS state + decrements the counter —
  // it NEVER pushState()s, because some Android WebViews DROP a pushState made inside a popstate handler,
  // unbalancing history so the next Back exits the app (the exact bug the naive re-push approach hit). Every
  // level change (row tap drills, on-screen ‹, hardware Back) flows through history push/back → the one handler.
  const notifDepthRef = useRef(0);
  const notifDetailRef = useRef<string | null>(null); notifDetailRef.current = notifDetailId;
  const pushNotifHist = () => { window.history.pushState({ overlay: true }, ''); notifDepthRef.current += 1; };
  const openNotifDetail = (id: string) => {
    pushNotifHist();                 // drill entry (a click handler — safe to pushState here)
    setNotifDetailId(id);
    addReadInboxId(id);
    setReadIds(getReadInboxIds());
  };
  const closeNotifDetail = () => window.history.back(); // route the ‹ through Back → the popstate handler
  const closeNotifInbox = () => { setNotifDetailId(null); setNotifInboxOpen(false); }; // ⌄ collapse → cleanup unwinds
  const markAllNotifRead = () => { notifItems.forEach((n) => addReadInboxId(n.id)); setReadIds(getReadInboxIds()); };
  const deleteNotifItem = async (id: string): Promise<boolean> => {
    if (notifDeleteRef.current) return false;
    notifDeleteRef.current = true;
    notifMutationRef.current += 1;
    setNotifDeletingId(id); setNotifError('');
    try {
      await deleteNotification(id);
      setNotifItems((cur) => cur.filter((n) => n.id !== id));
      return true;
    } catch (e) {
      if (!handledAuth(e)) setNotifError(t('pushInbox.deleteFailed'));
      return false;
    } finally {
      // Also invalidate refreshes that started WHILE the DELETE was in flight; an early GET response must
      // not re-add a record after the server has confirmed its deletion (or clear a delete-failure banner).
      notifMutationRef.current += 1;
      notifDeleteRef.current = false;
      setNotifDeletingId(null);
    }
  };
  const termRef = useRef<TerminalHandle | null>(null);
  const dockRef = useRef<BottomDockHandle | null>(null); // imperative handle into BottomDock — idea panel fills its input box
  const [terminalFocused, setTerminalFocused] = useState(false);
  const terminalFocusedRef = useRef(false);
  terminalFocusedRef.current = terminalFocused;
  const focusTerminal = useCallback(() => termRef.current?.focusInput?.(), []);
  const focusDraft = useCallback(() => {
    termRef.current?.blurInput?.();
    dockRef.current?.focusComposer?.();
  }, []);
  const focusOwnerAtPointerRef = useRef<{ owner: FocusOwner | null; at: number }>({ owner: null, at: 0 });
  const captureTerminalOwner = useCallback(() => {
    if (!desktopInput) return;
    focusOwnerAtPointerRef.current = {
      owner: terminalFocusedRef.current
        ? 'terminal'
        : (dockRef.current?.composerFocused?.() ? 'composer' : null),
      at: Date.now(),
    };
  }, [desktopInput]);
  // Pane-width undo is scoped to one open management flow. Map values may briefly be the in-flight
  // layout request so rapid taps share one pre-resize snapshot instead of racing to capture later ratios.
  const savedLayoutsRef = useRef<Map<string, unknown | Promise<unknown>>>(new Map());
  const managePaneWindowRef = useRef<string | null>(null);
  const recoveryPlanRef = useRef<WorkspaceRecoveryPlan | null>(null); recoveryPlanRef.current = recoveryPlan;
  const recoveryOperationRef = useRef<RecoveryOperationState | null>(null); recoveryOperationRef.current = recoveryOperation;
  const restoreInFlightRef = useRef(false);
  const liveSessionCountRef = useRef<number | null>(null);
  const lastRecoveryCheckpointRef = useRef<string | null>(null);
  const recoveryGenerationRef = useRef(0);
  const recoveryContextRef = useRef<RecoveryContext | null>(null);
  const drawerMenuRef = useRef<HTMLButtonElement | null>(null);

  const onAuthFail = useCallback(() => setNeedToken(true), []);
  const enqueueDesktopInput = useDesktopTerminalInput({
    enabled: desktopInput,
    currentPane: current?.paneId ?? null,
    terminalRef: termRef,
    onAuthFail,
  });
  // Shared catch prelude: bounce to the token prompt on an auth failure, and report whether it WAS one so
  // each handler keeps its own non-auth control flow (swallow / return / rethrow). See authGuard.js.
  const handledAuth = useCallback((error: unknown) => authHandled(error, onAuthFail), [onAuthFail]);
  const clearRecoveryOperation = useCallback(() => {
    recoveryGenerationRef.current += 1;
    recoveryContextRef.current = null;
    restoreInFlightRef.current = false;
    setRecoverySubmitting(false);
    setRecoveryOperation(null);
  }, []);
  const closeRecovery = useCallback(() => {
    const checkpointId = recoveryPlanRef.current?.checkpointId;
    if (checkpointId) markWorkspaceAutoShown(checkpointId);
    if (!restoreInFlightRef.current
      && ['succeeded', 'partial'].includes(recoveryOperationRef.current?.status || '')) {
      clearRecoveryOperation();
      setRecoveryPlan(null);
    }
    setRecoveryDialogOpen(false);
  }, [clearRecoveryOperation]);
  const rebindAfterRecovery = useCallback(() => {
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      window.removeEventListener('popstate', onPop);
      clearTimeout(fallback);
      setBindOpen(true);
    };
    const onPop = () => open();
    window.addEventListener('popstate', onPop);
    const fallback = setTimeout(open, 300);
    closeRecovery();
  }, [closeRecovery]);
  const openRecoveryFromDrawer = useCallback(() => {
    setDrawerOpen(false);
    setRecoveryDialogOpen(true);
  }, []);
  const ignoreRecovery = useCallback(() => {
    const checkpointId = recoveryPlanRef.current?.checkpointId;
    if (checkpointId) {
      ignoreWorkspaceCheckpoint(checkpointId);
      lastRecoveryCheckpointRef.current = checkpointId;
    }
    clearRecoveryOperation();
    setRecoveryDialogOpen(false);
    setRecoveryPlan(null);
  }, [clearRecoveryOperation]);

  const staticPreview = usePreviews(current);
  const browserStatus = browserEntryStatus([
    ...browser.tabs,
    ...staticPreview.tabs.map((tab) => ({ ...tab, mode: 'static' })),
  ]);
  // Every visible layer registers with the shared Overlay Stack. That stack is the single focus/keyboard
  // ownership signal, so a component-internal Overlay cannot be forgotten in a hand-maintained App list.
  const terminalOverlayOpen = useOverlayActivity();
  const terminalOverlayWasOpenRef = useRef(false);
  const restoreFocusAfterOverlayRef = useRef<FocusOwner | null>(null);
  const chooseKeyboardMode = useCallback((mode: ReturnType<typeof getKeyboardMode>) => {
    setKeyboardMode(mode);
    if (mode === 'desktop' && terminalOverlayOpen) restoreFocusAfterOverlayRef.current = 'terminal';
    setKeyboardModeState(mode);
  }, [terminalOverlayOpen]);
  const chooseTerminalTransport = useCallback((mode: ReturnType<typeof getTerminalTransport>) => {
    setTerminalTransportState(setTerminalTransport(mode));
  }, []);
  const chooseSnapshotInterval = useCallback((intervalMs: ReturnType<typeof getSnapshotInterval>) => {
    setSnapshotIntervalState(setSnapshotInterval(intervalMs));
  }, []);
  useEffect(() => {
    const wasOpen = terminalOverlayWasOpenRef.current;
    if (desktopInput && terminalOverlayOpen) {
      if (!wasOpen) {
        const pointerOwner = focusOwnerAtPointerRef.current;
        const liveOwner = terminalFocusedRef.current
          ? 'terminal'
          : (dockRef.current?.composerFocused?.() ? 'composer' : null);
        restoreFocusAfterOverlayRef.current = liveOwner
          || (Date.now() - pointerOwner.at < 1000 ? pointerOwner.owner : null);
        focusOwnerAtPointerRef.current = { owner: null, at: 0 };
      }
      termRef.current?.blurInput?.();
      dockRef.current?.hideKeyboard?.();
    } else if (desktopInput && wasOpen && restoreFocusAfterOverlayRef.current) {
      const owner = restoreFocusAfterOverlayRef.current;
      restoreFocusAfterOverlayRef.current = null;
      const raf = requestAnimationFrame(() => {
        if (lens !== 'terminal') return;
        if (owner === 'terminal') focusTerminal();
        else dockRef.current?.focusComposer?.();
      });
      terminalOverlayWasOpenRef.current = terminalOverlayOpen;
      return () => cancelAnimationFrame(raf);
    }
    terminalOverlayWasOpenRef.current = terminalOverlayOpen;
    return undefined;
  }, [desktopInput, terminalOverlayOpen, current?.paneId, lens, focusTerminal]);
  useEffect(() => {
    if (!desktopInput || terminalOverlayOpen || lens !== 'terminal' || !current?.paneId) return undefined;
    const onPageKeyDown = (event: KeyboardEvent) => {
      if (!shouldRouteTerminalPageKey(event)) return;
      if (isDraftShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        focusDraft();
        return;
      }
      if (termRef.current?.forwardPageKey?.(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onPageKeyDown, true);
    return () => window.removeEventListener('keydown', onPageKeyDown, true);
  }, [desktopInput, terminalOverlayOpen, lens, current?.paneId, focusDraft]);
  useEffect(() => {
    if (!desktopInput || terminalOverlayOpen || lens !== 'chat' || !current?.paneId) return undefined;
    const onPageKeyDown = (event: KeyboardEvent): void => {
      // Outside an editor, Shift+Enter is the one page-wide way into the chat composer. Once focused,
      // shouldRouteTerminalPageKey returns false and the textarea keeps native Shift+Enter newlines.
      if (!isDraftShortcut(event) || !shouldRouteTerminalPageKey(event)) return;
      const input = document.querySelector<HTMLTextAreaElement>('.chat-composer textarea.cc-text');
      if (!input) return;
      event.preventDefault();
      event.stopPropagation();
      input.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onPageKeyDown, true);
    return () => window.removeEventListener('keydown', onPageKeyDown, true);
  }, [desktopInput, terminalOverlayOpen, lens, current?.paneId]);

  // Update check: once per app launch (not polled), ask the server whether the installed CLI is behind the
  // latest npm release. The result lights the gear's dot and drives the "run `handmux update`" hint in Settings.
  useEffect(() => {
    if (needToken) return;
    getServerVersion().then(setUpdateInfo).catch(() => { /* best-effort; no hint on failure */ });
  }, [needToken]);

  // Drop the saved token and bounce back to the token prompt — handy for testing the login flow.
  const logout = useCallback(() => {
    clearToken();
    clearRecoveryOperation();
    setSettingsOpen(false);
    setBindOpen(false);
    setDrawerOpen(false);
    setCurrent(null);
    setBooting(true);
    setNeedToken(true);
  }, [clearRecoveryOperation]);

  usePageScrollLock(); // keyboard-up: stop the browser panning the whole page (see hook) — also keeps inset honest
  const inset = useKeyboardInset();

  // Hardware Back closes the open overlay (→ one level up) instead of exiting the app.
  // Multi-level tools pop one level at a time instead of closing mid-navigation. FileManager and GitPanel
  // own their stacks; Browser mirrors History→page through the dedicated hook below.
  useBrowserBackStack({
    open: browser.open,
    historyActive: browser.historyActive && !staticPreview.selected,
    switchTab: () => {
      staticPreview.deactivate();
      browser.switchTab('history');
    },
    setOpen: browser.setOpen,
  });
  useBackButton(drawerOpen || recoveryDialogOpen, () => {
    if (recoveryDialogOpen) closeRecovery(); else setDrawerOpen(false);
  });
  useBackButton(inboxOpen, () => setInboxOpen(false));
  useBackButton(usageOpen, () => setUsageOpen(false));
  useBackButton(bindOpen, () => setBindOpen(false));
  useBackButton(newWinOpen, () => setNewWinOpen(false));
  useBackButton(ideaOpen, () => setIdeaOpen(false));
  useBackButton(!!takeoverTarget, () => setTakeoverTarget(null));
  useBackButton(!!docLinkPrompt || !!localUrlPrompt, () => {
    if (localUrlPrompt) closeLocalUrl(); else setDocLinkPrompt(null);
  });
  useBackButton(settingsOpen, () => setSettingsOpen(false));
  useBackButton(changelogOpen, () => setChangelogOpen(false));
  // Same for 长按窗口管理 → 重命名 (and the topbar long-press rename, which opens the modal alone).
  useBackButton(!!manageWindow || !!renameTarget, () => {
    if (renameTarget) setRenameTarget(null); else setManageWindow(null);
  });
  useBackButton(!!managePane, () => {
    if (managePaneWindowRef.current) savedLayoutsRef.current.delete(managePaneWindowRef.current);
    managePaneWindowRef.current = null;
    setManagedPaneWidth(null);
    setPaneLayoutRestoreReady(false);
    setManagePane(null);
  });
  // This page owns a multi-level history stack. Register it in the shared layer order so it can sit
  // above Settings and consume Back/Escape before the parent.
  useHistoryLayer(notifInboxOpen, () => {
    notifDepthRef.current = Math.max(0, notifDepthRef.current - 1);
    if (notifDetailRef.current) { setNotifDetailId(null); return; }
    setNotifInboxOpen(false);
  });
  // Inbox multi-level Back (GitPanel pattern — see notifDepthRef above): push the base entry on open, pop one
  // level per Back, close at the base. The handler NEVER pushState()s (Android-WebView-safe). Close-by-button
  // (⌄) sets notifInboxOpen=false → the cleanup unwinds any entries we still own so history stays balanced.
  useEffect(() => {
    if (!notifInboxOpen) return undefined;
    pushNotifHist();                          // base entry for the open list
    return () => {
      if (notifDepthRef.current > 0) { unwindHistory(notifDepthRef.current); notifDepthRef.current = 0; }
    };
  }, [notifInboxOpen]); // eslint-disable-line react-hooks/exhaustive-deps -- refs/handlers are stable-by-ref
  // Deep-link (SW postMessage / cold boot) targets a specific message: once the list is open (base entry
  // pushed above), drill into it — so history is base-then-drill in order (Back: detail→list→close).
  useEffect(() => {
    if (notifInboxOpen && pendingNotifDetail) {
      openNotifDetail(pendingNotifDetail);
      setPendingNotifDetail(null);
    }
  }, [notifInboxOpen, pendingNotifDetail]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opening the inbox = "seen": advance the top-dot high-water to the newest ts present (covers items that
  // load right after open). Clears the gear / 通知记录 dot even if some messages inside stay unread.
  useEffect(() => {
    const newest = notifItems[0];
    if (notifInboxOpen && newest && newest.ts > notifSeenTs) {
      setNotifSeenTs(newest.ts); setNotifSeenTsState(newest.ts);
    }
  }, [notifInboxOpen, notifItems, notifSeenTs]);
  // Root double-back-to-exit: on the main page (a pane is showing, all the overlays above push their own
  // entries first), the first Back only surfaces a hint — a second within the window actually exits. The
  // hook toggles the hint (show on arm, hide when the window lapses), so its visibility IS the arm window —
  // the moment it hides, the guard is re-armed and the next Back re-prompts (no separate display timer).
  useExitConfirm(!!current, setExitHint);

  const sendKey = useCallback(async (name: string) => {
    const paneId = current?.paneId;
    if (!paneId) return;
    try { await sendKeys(paneId, [name]); termRef.current?.wake?.(); } // input landed → poll for output now
    catch (e) { handledAuth(e); }
  }, [current, onAuthFail]);

  const sendChar = useCallback(async (ch: string) => {
    const paneId = current?.paneId;
    if (!paneId) return;
    try { await sendText(paneId, ch, false); termRef.current?.wake?.(); }
    catch (e) { handledAuth(e); }
  }, [current, onAuthFail]);

  // Open a session: load its windows (prefer remembered → active → first), then that window's
  // panes (prefer remembered → active → first). Writes the session name into the URL hash so
  // the location deep-links back here. Returns false if the session has no windows/panes.
  const openSession = useCallback(async (
    session: HostSession,
    target: WorkspaceTarget | null = null,
    { isCancelled = () => false }: OpenSessionOptions = {},
  ): Promise<boolean> => {
    const switchEpoch = ++windowSwitchRef.current;
    if (isCancelled()) return false;
    const windows = await getWindows(session.id);
    if (isCancelled() || switchEpoch !== windowSwitchRef.current) return false;
    if (!windows.length) return false;
    const selectedWindow = (target?.window && windows.find((w) => w.id === target.window))
      || windows.find((w) => w.id === pickId(windows, getLastWindow(session.id)))
      || windows[0];
    if (!selectedWindow) return false;
    const panes = await getPanes(selectedWindow.id);
    if (isCancelled() || switchEpoch !== windowSwitchRef.current) return false;
    if (!panes.length) return false;
    const paneId = (target?.pane && panes.some((p) => p.id === target.pane))
      ? target.pane
      : pickId(panes, getLastPane(selectedWindow.id));
    setCurrent({ session, windows, window: selectedWindow, panes, paneId });
    remember({ sessionId: session.id, windowId: selectedWindow.id, paneId });
    writeSessionHash(session.name);
    return true;
  }, []);

  // A phone can keep its React tree alive while the host or tmux restarts. tmux then recreates every
  // session/window/pane id, so retrying the old pane forever can never recover. A precise 404 from the
  // topology routes means the target is gone (not merely offline): resolve the same pinned session by
  // name and reopen it against the new ids. Coalesce the 5s poll and mobile foreground bursts, and cancel
  // if the user navigates elsewhere while discovery is in flight.
  const recoverCurrentTopology = useCallback((error: unknown): void => {
    if (handledAuth(error)) return;
    if (!(error instanceof ApiError) || error.status !== 404 || topologyRecoveryRef.current) return;
    const expected = currentRef.current;
    if (!expected) return;
    const recovery = (async () => {
      try {
        const sessions = await getSessions();
        const replacement = sessions.find((session) => session.name === expected.session.name);
        if (!replacement) {
          // An empty list is normal while tmux/workspace recovery is still starting. Keep the old target
          // so the next poll retries instead of stranding the user on a non-retrying empty screen.
          if (sessions.length) {
            setCurrent((value) => (value?.session.name === expected.session.name
              && value.window.id === expected.window.id ? null : value));
          }
          return;
        }
        await openSession(replacement, null, {
          isCancelled: () => {
            const latest = currentRef.current;
            return !latest
              || latest.session.name !== expected.session.name
              || latest.window.id !== expected.window.id;
          },
        });
      } catch (recoveryError) {
        handledAuth(recoveryError);
      }
    })().finally(() => {
      if (topologyRecoveryRef.current === recovery) topologyRecoveryRef.current = null;
    });
    topologyRecoveryRef.current = recovery;
  }, [handledAuth, openSession]);

  const applyRecoveryMapping = useCallback((mapping: unknown) => {
    if (!mapping) return;
    applyWorkspaceRestoreMapping(mapping);
    // A restored `-restored` name may have been added to the persisted bindings by the mapping.
    // Refresh React state from that same source so the Drawer reflects it immediately.
    setBound(getBoundSessions());
  }, []);

  const consumeRecoveryPlan = useCallback((plan: WorkspaceRecoveryPlan | null, liveSessionCount: number) => {
    // The operation monitor owns plan/checkpoint transitions until it reaches a terminal state.
    // In particular, a newer periodic plan must not invalidate a still-live persisted operation.
    if (restoreInFlightRef.current) return;
    if (plan?.mapping) applyRecoveryMapping(plan.mapping);
    const checkpointId = plan?.checkpointId || null;
    const retainsCompletedResult = checkpointId
      && checkpointId === lastRecoveryCheckpointRef.current
      && ['succeeded', 'partial'].includes(recoveryOperationRef.current?.status || '');
    if (retainsCompletedResult) return;
    const changedCheckpoint = Boolean(checkpointId
      && lastRecoveryCheckpointRef.current
      && lastRecoveryCheckpointRef.current !== checkpointId);
    if (changedCheckpoint) clearRecoveryOperation();
    if (checkpointId) lastRecoveryCheckpointRef.current = checkpointId;
    const prompt = getWorkspacePromptState(plan?.checkpointId);
    const mode = recoveryPromptMode(plan, { ...prompt, liveSessionCount });
    if (mode === 'none') {
      clearRecoveryOperation();
      setRecoveryPlan(null);
      setRecoveryDialogOpen(false);
      return;
    }
    setRecoveryPlan(plan);
    if (mode === 'auto-dialog' && plan) {
      if (plan.checkpointId) markWorkspaceAutoShown(plan.checkpointId);
      setDrawerOpen(false);
      setRecoveryDialogOpen(true);
    } else if (changedCheckpoint) {
      setRecoveryDialogOpen(false);
    }
  }, [applyRecoveryMapping, clearRecoveryOperation]);

  const startRecovery = useCallback(async () => {
    const plan = recoveryPlanRef.current;
    if (!plan?.checkpointId || restoreInFlightRef.current) return;
    const context = {
      generation: recoveryGenerationRef.current + 1,
      checkpointId: plan.checkpointId,
      operationId: null as string | null,
    };
    recoveryGenerationRef.current = context.generation;
    recoveryContextRef.current = context;
    restoreInFlightRef.current = true;
    setRecoverySubmitting(true);
    const isCurrent = () => recoveryContextRef.current === context
      && recoveryGenerationRef.current === context.generation
      && recoveryPlanRef.current?.checkpointId === context.checkpointId;
    try {
      const started = await startWorkspaceRestore({ checkpointId: plan.checkpointId });
      if (!isCurrent()) return;
      if (!started?.operationId) throw new Error('restore operation id missing');
      context.operationId = started.operationId;
      setRecoveryOperation({
        id: started.operationId,
        status: started.status || 'pending',
        progress: { completed: 0, total: (plan.planSummary?.create || 0) + (plan.planSummary?.renamed || 0) },
        results: [],
      });
    } catch (error) {
      if (!isCurrent()) return;
      restoreInFlightRef.current = false;
      setRecoverySubmitting(false);
      if (!handledAuth(error)) {
        setRecoveryOperation({ status: 'failed', errorCode: 'restore-failed', progress: { completed: 0, total: 0 }, results: [] });
      }
    }
  }, [handledAuth]);

  const recoveryOperationId = recoveryOperation?.id;
  useEffect(() => {
    if (!recoveryOperationId || needToken) return undefined;
    const context = recoveryContextRef.current;
    if (!context || context.operationId !== recoveryOperationId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const isCurrent = () => !cancelled
      && recoveryContextRef.current === context
      && recoveryGenerationRef.current === context.generation
      && context.operationId === recoveryOperationId;
    const schedule = () => {
      if (isCurrent()) timer = setTimeout(poll, 1000);
    };
    const finish = async (result: RecoveryOperationState): Promise<boolean> => {
      if (!isCurrent()) return true;
      const finishedPlan = recoveryPlanRef.current;
      const finishedCheckpointId = finishedPlan?.checkpointId;
      setRecoveryOperation(result);
      applyRecoveryMapping(result.mapping);

      const restoredCount = (result.results || []).filter((row: WorkspaceRestoreResult) => row.status === 'restored').length;
      if (restoredCount > 0) {
        setBound(removeRestoredSessionBindings(result.results));
        reportBound();
      }

      restoreInFlightRef.current = false;
      setRecoverySubmitting(false);

      if (!isCurrent()) return true;
      const [planResult, protectionResult] = await Promise.allSettled([
        getWorkspaceRestorePlan(),
        getWorkspaceProtectionStatus(),
      ]);
      if (!isCurrent()) return true;
      if (protectionResult.status === 'fulfilled') setWorkspaceProtection(protectionResult.value);
      else handledAuth(protectionResult.reason);
      if (planResult.status === 'fulfilled' && liveSessionCountRef.current !== null) {
        const refreshedPlan = planResult.value;
        // Plan resolution and operation completion are separate server writes. If this refresh
        // briefly sees the just-completed checkpoint as eligible, do not resurrect its prompt.
        if (result.status === 'succeeded' && refreshedPlan?.checkpointId === finishedCheckpointId) {
          applyRecoveryMapping(refreshedPlan?.mapping);
        } else {
          consumeRecoveryPlan(refreshedPlan, liveSessionCountRef.current);
        }
      } else if (planResult.status === 'rejected') {
        handledAuth(planResult.reason);
      }
      return true;
    };
    const poll = async () => {
      if (!isCurrent()) return;
      try {
        const result = await getWorkspaceRestoreOperation(recoveryOperationId);
        if (!isCurrent()) return;
        if (!result) throw new Error('restore operation missing');
        setRecoveryOperation(result);
        if (['succeeded', 'partial', 'failed', 'interrupted'].includes(result.status || '')) {
          const complete = await finish(result);
          if (!isCurrent()) return;
          if (!complete) schedule();
          return;
        }
      } catch (error) {
        // A transport failure does not discard the persisted operation id. Keep polling that exact id;
        // a 401 still returns to the token prompt through the normal auth path.
        if (!isCurrent() || handledAuth(error)) return;
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        ) {
          restoreInFlightRef.current = false;
          setRecoverySubmitting(false);
          setRecoveryOperation({
            id: recoveryOperationId,
            status: 'failed',
            errorCode:
              error.status === 404 ? 'operation-not-found' : 'restore-failed',
            progress: { completed: 0, total: 0 },
            results: [],
          });
          return;
        }
      }
      schedule();
    };
    poll();
    return () => { cancelled = true; if (timer !== null) clearTimeout(timer); };
  }, [recoveryOperationId, needToken, applyRecoveryMapping, consumeRecoveryPlan, handledAuth]);

  // Switch to another window within the current session (its active pane). Session/hash unchanged.
  const selectWindow = useCallback(async (sourceWindow: WorkspaceWindow): Promise<string | null | undefined> => {
    const window = hostWindow(sourceWindow);
    const switchEpoch = ++windowSwitchRef.current;
    const rememberedPaneId = getLastPane(window.id);
    const immediatePaneId = rememberedPaneId || window.activePaneId || null;
    // Commit the user's choice before touching the network. With activePaneId supplied by the existing
    // window listing, Terminal mounts now and shows its own loading surface while pane metadata catches up.
    if (!immediatePaneId || !current) return null;
    setCurrent((c) => (c ? { ...c, window, panes: [], paneId: immediatePaneId } : c));
    remember({ sessionId: current.session.id, windowId: window.id, paneId: immediatePaneId });
    try {
      const panes = await getPanes(window.id);
      if (switchEpoch !== windowSwitchRef.current) return null;
      if (!panes.length) return;
      const paneId = pickId(panes, getLastPane(window.id));
      setCurrent((c) => (c && c.window.id === window.id ? { ...c, window, panes, paneId } : c));
      remember({ sessionId: current.session.id, windowId: window.id, paneId });
      return paneId; // callers (管理分屏) need the now-current pane to open its manage sheet
    } catch (e) {
      handledAuth(e);
      return null;
    }
  }, [current, onAuthFail]);

  // Create a new window in the current session (in the current pane's dir, see POST /windows), with
  // an optional name, then switch to it. Mirrors selectWindow's post-switch bookkeeping. Lets
  // generic errors propagate so the modal re-enables its button; auth errors are handled here.
  const createNewWindow = useCallback(async (name: string, cwd?: string, cmd?: string): Promise<void> => {
    const sessionId = current?.session?.id;
    const paneId = current?.paneId;
    if (!sessionId || !paneId) return;
    try {
      const { id } = await createWindow(sessionId, paneId, name || undefined, cwd, cmd);
      const windows = await getWindows(sessionId);
      const window = windows.find((w) => w.id === id) || windows[windows.length - 1];
      if (!window) return;
      const panes = await getPanes(window.id);
      if (!panes.length) return;
      const newPaneId = pickId(panes, getLastPane(window.id));
      setCurrent((c) => (c ? { ...c, windows, window, panes, paneId: newPaneId } : c));
      remember({ sessionId, windowId: window.id, paneId: newPaneId }); // sessionId → remembered as this session's last window
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
  const submitRename = useCallback(async (newName: string): Promise<void> => {
    const target = renameTarget;
    if (!target) return;
    const sessionId = current?.session?.id;
    if (target.kind === 'session') {
      try {
        await renameSession(target.id, newName);
      } catch (e) {
        if (handledAuth(e)) throw e;
        if (e instanceof ApiError && e.status === 409) throw new Error(t('app.nameExists')); // ApiError carries the status precisely
        throw new Error(t('app.renameFailed'));
      }
      setBound(renameBoundSession(target.name, newName));
      reportBound();
      writeSessionHash(newName);
      setCurrent((c) => (c && c.session.id === target.id
        ? { ...c, session: { ...c.session, name: newName } } : c)); // the recent effect reloads off the new name
    } else {
      try {
        await renameWindow(target.id, newName);
      } catch (e) {
        if (handledAuth(e)) throw e;
        throw new Error(t('app.renameFailed'));
      }
      // Ideas are keyed by window NAME (id falls back when unnamed) — carry them to the new name.
      if (!current?.session?.name || !sessionId) return;
      renameWindowIdeas(current.session.name, target.name || target.id, newName);
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
      if (!next) return;
      const panes = await getPanes(next.id);
      if (!panes.length) return;
      const paneId = pickId(panes, getLastPane(next.id));
      setCurrent((c) => (c ? { ...c, windows, window: next, panes, paneId } : c));
      remember({ sessionId, windowId: next.id, paneId });
    } else {
      setCurrent((c) => (c ? { ...c, windows } : c));
    }
  }, [manageWindow, current, onAuthFail]);

  // Nudge the long-pressed window one slot left/right by swapping it with its neighbour. tmux window
  // index is shared, so the PC's order follows (same opt-in family as 适配宽度). The sheet stays open —
  // manageWindow re-points at the refreshed window so positions can be nudged repeatedly; it closes
  // only if the window vanished (e.g. killed on the PC). The open pane/window is unchanged: swap only
  // reorders, and the active highlight follows the window id.
  const moveManagedWindow = useCallback(async (dir: 'left' | 'right') => {
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
  const selectSession = useCallback(async (name: string) => {
    try {
      const session = (await getSessions()).find((s) => s.name === name);
      if (!session) { window.alert(t('app.sessionGone', { name })); return; }
      if (await openSession(session)) setDrawerOpen(false);
    } catch (e) {
      handledAuth(e);
    }
  }, [openSession, onAuthFail]);

  const markCanonicalTerminalRead = useCallback(async (notificationIds: readonly string[]) => {
    if (!notificationIds.length) return;
    try {
      await markAgentTerminalNotificationsRead(notificationIds);
      const ids = new Set(notificationIds);
      setStates((currentStates) => applyTerminalReads(currentStates, ids));
    } catch (error) { handledAuth(error); }
  }, [handledAuth]);

  // Tap an inbox row → mark it seen and deep-link to that pane (cross-session safe). Mirrors the
  // notification-tap resolver: resolve the live session by name, then openSession with the target.
  const openInboxRow = useCallback(async (
    row: ReturnType<typeof inboxRows>[number],
  ): Promise<boolean> => {
    setInboxOpen(false);
    setCompletedChatEntry(null);
    if (row.terminalNotificationId) {
      void markCanonicalTerminalRead([row.terminalNotificationId]);
    } else setSeen(markInboxSeen(row.pane, row.ts));
    try {
      const session = (await getSessions()).find((s) => s.name === row.session);
      if (!session) { window.alert(t('app.sessionGone', { name: row.session })); return false; }
      setDrawerOpen(false);
      const opened = await openSession(session, { window: row.window, pane: row.pane });
      if (opened && row.view === 'done') {
        setCompletedChatEntry({
          paneId: row.pane,
          session: row.session,
          window: row.window,
          request: ++completedChatEntrySeqRef.current,
        });
      }
      return opened;
    } catch (e) {
      handledAuth(e);
      return false;
    }
  }, [openSession, handledAuth, markCanonicalTerminalRead]);

  // Take over an orphan (claude running outside tmux): the server spawns `claude --resume` in the chosen
  // target (new session, or a new window of an existing session) and — if kill — SIGTERMs the original,
  // returning the new {session,window,pane}; we navigate into it. Throws on failure (409 gone / session
  // changed / spawn failed) so the takeover sheet can surface it; success closes the sheet + inbox.
  const doTakeover = useCallback(async ({ target, kill, name }: OrphanTakeoverRequest) => {
    const o = takeoverTarget;
    if (!o) return;
    const out = await takeoverOrphan({ pid: o.pid, sessionId: o.sessionId, target, kill, name });
    // Pin the target session into this device's list so the taken-over session is reachable later —
    // without this a brand-new `cc-…` session would vanish from the drawer the moment you navigate away.
    if (out.name) { setBound(addBoundSession(out.name)); reportBound(); }
    setTakeoverTarget(null);
    setInboxOpen(false);
    try {
      if (out.name && out.session) {
        setDrawerOpen(false);
        await openSession({ id: out.session, name: out.name }, {
          window: out.window ?? null,
          pane: out.pane ?? null,
        });
      }
    } catch (e) { handledAuth(e); }
    try { setOrphans(await getOrphans()); } catch { /* refresh best-effort */ }
  }, [takeoverTarget, openSession, onAuthFail]);

  // 清除已完成: advance the high-water mark to the current max ts → all present done rows become history
  // (working/needs are never filtered, so this only clears completed). Button is hidden when no done row.
  const markAllRead = useCallback(() => {
    const canonicalIds = inboxRows(states, seen, readTs == null ? Infinity : readTs)
      .flatMap((row) => row.terminalNotificationId ? [row.terminalNotificationId] : []);
    if (canonicalIds.length) void markCanonicalTerminalRead(canonicalIds);
    const m = maxTs(states);
    setInboxReadTs(m); setReadTs(m);
  }, [states, seen, readTs, markCanonicalTerminalRead]);

  // Save a validated name locally, then open it immediately so "绑定上" is usable right away.
  const bindSession = useCallback((name: string) => {
    setBound(addBoundSession(name));
    reportBound();
    setBindOpen(false);
    selectSession(name);
  }, [selectSession]);

  const unbindSession = useCallback((name: string) => {
    setBound(removeBoundSession(name));
    reportBound();
    // If the open session was the one removed, fall back to the empty state.
    setCurrent((c) => (c && c.session.name === name ? null : c));
  }, []);

  const selectPane = useCallback((paneId: string) => {
    setCurrent((c) => {
      if (!c) return c;
      remember({ windowId: c.window.id, paneId });
      return { ...c, paneId };
    });
  }, []);

  // Splice a window's post-split/close panes into `current`: the pane list (when it's the open window)
  // AND that window's cached pane COUNT in the windows strip, so the long-press menu immediately offers
  // the right actions (分屏 for a lone pane vs 管理分屏 once split) instead of a stale count until the
  // next getWindows.
  const refreshPanes = useCallback((windowId: string, panes: HostPane[]) => {
    setCurrent((c) => {
      if (!c) return c;
      const windows = c.windows.map((w) => (w.id === windowId ? { ...w, panes: panes.length } : w));
      if (c.window.id !== windowId) return { ...c, windows };
      const paneId = panes.some((pane) => pane.id === c.paneId) || !panes.length
        ? c.paneId
        : pickId(panes, getLastPane(windowId));
      return { ...c, windows, panes, paneId };
    });
  }, []);

  // Persist automatic pane replacement as well as explicit navigation. Without this, a reload after an
  // externally closed pane would briefly retry the same stale id before the topology poll corrected it.
  useEffect(() => {
    if (current) remember({
      sessionId: current.session.id,
      windowId: current.window.id,
      paneId: current.paneId,
    });
  }, [current?.session.id, current?.window.id, current?.paneId]);

  // Sizes can change outside handmux (another tmux client, terminal resize, etc.). Management sheets
  // must therefore resolve their target from tmux when they open instead of reusing the dimensions
  // captured when the session/window was first selected. If the refresh itself fails, keep the existing
  // management action available with the last known snapshot; auth failures still return to login.
  const openWindowManagement = useCallback(async (sourceWindow: WorkspaceWindow) => {
    const win = hostWindow(sourceWindow);
    if (!win) return;
    const sessionId = current?.session?.id;
    if (!sessionId) { setManageWindow(win); return; }
    try {
      const windows = await getWindows(sessionId);
      const freshWindow = windows.find((w) => w.id === win.id);
      if (!freshWindow) return;
      setCurrent((c) => {
        if (!c || c.session.id !== sessionId) return c;
        return { ...c, windows, window: windows.find((w) => w.id === c.window.id) || c.window };
      });
      setManageWindow(freshWindow);
    } catch (e) {
      if (!handledAuth(e)) setManageWindow(win);
    }
  }, [current?.session?.id, handledAuth]);

  const openPaneManagement = useCallback(async (paneId: string, targetWindowId = current?.window?.id) => {
    if (!paneId) return;
    if (!targetWindowId) { setManagePane(paneId); return; }
    try {
      const panes = await getPanes(targetWindowId);
      if (!panes.some((pane) => pane.id === paneId)) return;
      refreshPanes(targetWindowId, panes);
      if (managePaneWindowRef.current !== targetWindowId) {
        if (managePaneWindowRef.current) savedLayoutsRef.current.delete(managePaneWindowRef.current);
        savedLayoutsRef.current.delete(targetWindowId);
        setPaneLayoutRestoreReady(false);
      }
      managePaneWindowRef.current = targetWindowId;
      setManagedPaneWidth(panes.find((pane) => pane.id === paneId)?.width ?? null);
      setManagePane(paneId);
    } catch (e) {
      if (!handledAuth(e)) {
        managePaneWindowRef.current = targetWindowId;
        setManagedPaneWidth(current?.panes?.find((pane) => pane.id === paneId)?.width ?? null);
        setManagePane(paneId);
      }
    }
  }, [current?.window?.id, current?.panes, refreshPanes, handledAuth]);

  const refreshPaneMap = useCallback(async (targetWindowId = current?.window?.id) => {
    if (!targetWindowId) return;
    try {
      refreshPanes(targetWindowId, await getPanes(targetWindowId));
    } catch (e) {
      handledAuth(e);
    }
  }, [current?.window?.id, refreshPanes, handledAuth]);

  const setManagedWindowWidth = useCallback((windowId: string, width: number) => {
    setManageWindow((win) => (win?.id === windowId ? { ...win, width } : win));
    setCurrent((state) => {
      if (!state) return state;
      const windows = state.windows.map((win) => (win.id === windowId ? { ...win, width } : win));
      return {
        ...state,
        windows,
        window: state.window.id === windowId ? { ...state.window, width } : state.window,
      };
    });
  }, []);

  // Window width exists only for a lone-pane window in this UI. A multi-pane window exposes the
  // independently adjustable target in Pane Management instead, so this action has one clear scope.
  const resizeManagedWindowCols = useCallback(async (delta: number, displayedCols: number) => {
    const win = manageWindow;
    if (!win || win.panes !== 1 || !Number.isFinite(displayedCols)) return;
    const cols = clampCols(displayedCols + delta);
    setManagedWindowWidth(win.id, cols);
    if (current?.window?.id === win.id) termRef.current?.flash?.();
    setWindowResizePending((count) => count + 1);
    try {
      await resizeWindow(win.id, cols);
    } catch (e) {
      if (handledAuth(e)) return;
      try {
        const sessionId = current?.session?.id;
        if (!sessionId) return;
        const windows = await getWindows(sessionId);
        const fresh = windows.find((item) => item.id === win.id);
        if (fresh?.width !== undefined) setManagedWindowWidth(win.id, fresh.width);
      } catch (refreshError) { handledAuth(refreshError); }
    } finally { setWindowResizePending((count) => Math.max(0, count - 1)); }
  }, [manageWindow, current?.window?.id, current?.session?.id, handledAuth, setManagedWindowWidth]);

  const restoreManagedWindowCols = useCallback(async () => {
    const win = manageWindow;
    const sessionId = current?.session?.id;
    if (!win || win.panes !== 1 || !sessionId) return;
    try {
      await restoreWindowSize(win.id);
      const windows = await getWindows(sessionId);
      const fresh = windows.find((item) => item.id === win.id);
      setCurrent((state) => {
        if (!state || state.session.id !== sessionId) return state;
        return { ...state, windows, window: windows.find((item) => item.id === state.window.id) || state.window };
      });
      if (fresh) setManageWindow(fresh);
    } catch (e) { handledAuth(e); }
  }, [manageWindow, current?.session?.id, handledAuth]);

  const resizeManagedPaneCols = useCallback(async (delta: number, displayedCols: number) => {
    const windowId = current?.window?.id;
    const pane = current?.panes?.find((item) => item.id === managePane);
    if (!windowId || !pane || !canResizePaneWidth(current.panes, pane.id) || !Number.isFinite(displayedCols)) return;
    const cols = clampCols(displayedCols + delta);
    setManagedPaneWidth(cols);
    termRef.current?.flash?.();
    setPaneResizePending((count) => count + 1);
    try {
      let saved = savedLayoutsRef.current.get(windowId);
      if (saved == null) {
        saved = getWindowLayout(windowId)
          .then((result) => {
            const layout = recordOf(result)?.layout;
            return typeof layout === 'string' ? layout : '';
          })
          .catch(() => '');
        savedLayoutsRef.current.set(windowId, saved);
      }
      const layout = await saved;
      if (layout) {
        savedLayoutsRef.current.set(windowId, layout);
        if (managePaneWindowRef.current === windowId) setPaneLayoutRestoreReady(true);
      } else {
        savedLayoutsRef.current.delete(windowId);
      }
      await resizePane(pane.id, cols);
    } catch (e) {
      if (handledAuth(e)) return;
      try {
        const panes = await getPanes(windowId);
        refreshPanes(windowId, panes);
        setManagedPaneWidth(panes.find((item) => item.id === pane.id)?.width ?? null);
      }
      catch (refreshError) { handledAuth(refreshError); }
    } finally { setPaneResizePending((count) => Math.max(0, count - 1)); }
  }, [current, managePane, refreshPanes, handledAuth]);

  const restoreManagedPaneLayout = useCallback(async () => {
    const windowId = current?.window?.id;
    if (!windowId) return;
    const saved = savedLayoutsRef.current.get(windowId);
    const layout = saved && await saved;
    if (!layout) return;
    try {
      await applyWindowLayout(windowId, layout);
      const panes = await getPanes(windowId);
      refreshPanes(windowId, panes);
      setManagedPaneWidth(panes.find((item) => item.id === managePane)?.width ?? null);
      savedLayoutsRef.current.delete(windowId);
      setPaneLayoutRestoreReady(false);
    } catch (e) { handledAuth(e); }
  }, [current?.window?.id, managePane, refreshPanes, handledAuth]);

  // Split `paneId` into two (dir 'h' left|right, 'v' top/bottom); jump the phone to the new pane. The
  // decision logic (call the api, refetch, pick the new pane) lives in paneActions.js — unit-tested there.
  const splitPaneAction = useCallback(async (paneId: string, dir: string) => {
    const windowId = current?.window?.id;
    if (!windowId) return;
    setManagePane(null);
    setManageWindow(null);
    savedLayoutsRef.current.delete(windowId);
    managePaneWindowRef.current = null;
    setManagedPaneWidth(null);
    setPaneLayoutRestoreReady(false);
    try {
      const { panes, selectPaneId } = await runSplitPane({
        paneId, dir, windowId, api: { splitPane: apiSplitPane }, getPanes,
      });
      refreshPanes(windowId, panes);
      selectPane(selectPaneId); // you split to work in the new pane
    } catch (e) {
      if (handledAuth(e)) return;
      window.alert(t('pane.splitFailed'));
    }
  }, [current, refreshPanes, selectPane, onAuthFail]);

  // Close `paneId`; if it was the pane being viewed, re-target to a survivor (via pickId).
  const closeManagedPane = useCallback(async () => {
    const paneId = managePane;
    const windowId = current?.window?.id;
      const viewedPaneId = current?.paneId ?? null;
    if (!paneId || !windowId) return;
    savedLayoutsRef.current.delete(windowId);
    managePaneWindowRef.current = null;
    setManagedPaneWidth(null);
    setPaneLayoutRestoreReady(false);
    try {
      const { panes, selectPaneId } = await runClosePane({
        paneId, windowId, viewedPaneId, api: { closePane: apiClosePane }, getPanes, pickId,
      });
      setManagePane(null);
      refreshPanes(windowId, panes);
      if (selectPaneId) selectPane(selectPaneId);
    } catch (e) {
      setManagePane(null);
      if (handledAuth(e)) return;
      window.alert(t('pane.closeFailed'));
    }
  }, [managePane, current, refreshPanes, selectPane, onAuthFail]);

  // Split a SINGLE-pane window straight from its manage sheet — works whether or not it's the open
  // window (a background window has no map to long-press). We split its active pane, then switch the
  // view to that window and land on the new pane, so you actually see the split you just made.
  const splitWindowAction = useCallback(async (win: HostWindow, dir: string) => {
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
      setCurrent((c) => {
        if (!c) return c;
        const windows = c.windows.map((w) => (w.id === win.id ? { ...w, panes: panes.length } : w));
        return { ...c, windows, window: win, panes, paneId: selectPaneId };
      });
      remember({ sessionId, windowId: win.id, paneId: selectPaneId });
    } catch (e) {
      if (handledAuth(e)) return;
      window.alert(t('pane.splitFailed'));
    }
  }, [current, onAuthFail]);

  // "管理分屏" on a multi-pane window's manage sheet → open the split map AND its pane-manage sheet on the
  // current pane, so you land straight in "manage the split" (tap another tile to re-target). If that
  // window isn't the open one, switch to it first (only the active window renders a map).
  //
  // History-stack ordering matters: closing the manage-window sheet unwinds its back-button entry via a
  // DEFERRED history.back(). If we push the pane sheet's OWN back-button entry before that fires, the
  // deferred back() pops the pane sheet's fresh entry and its popstate slams the sheet shut — you'd see
  // only the map. So the manage-window entry must unwind BEFORE the pane sheet opens: the non-current
  // branch gets that gap for free from selectWindow's network await; the current-window branch explicitly
  // waits for the unwinding popstate.
  const manageSplit = useCallback(async (sourceWindow: WorkspaceWindow) => {
    const win = hostWindow(sourceWindow);
    if (!win) return;
    let paneId = current?.paneId;
    if (win.id !== current?.window?.id) {
      setManageWindow(null);
      paneId = (await selectWindow(win)) ?? undefined;
    } else {
      await new Promise<void>((resolve) => {
        const fin = () => { clearTimeout(timer); window.removeEventListener('popstate', fin); resolve(); };
        const timer = setTimeout(fin, 80); // fallback: no overlay entry to unwind → no popstate
        window.addEventListener('popstate', fin);
        setManageWindow(null);
      });
    }
    if (!paneId) return; // switch failed (no panes / auth) — don't strand an openMapFor for a window that never mounts
    setOpenMapFor(win.id);
    await openPaneManagement(paneId, win.id);
  }, [current, selectWindow, openPaneManagement]);

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
    // The remembered session stays mounted behind Project view, but the user has not arrived at that pane.
    // Full-screen tools also obscure the workspace, so completing behind Files/Git/Browser/Settings must
    // remain unread until the user actually returns to the pane.
    if (rootView === 'session' && !terminalOverlayOpen && current?.paneId) {
      clearPaneNotification(current.paneId);
    }
  }, [rootView, terminalOverlayOpen, current?.paneId]);

  // While a pane is open, keep it marked "seen" as new events land — you're watching it live. New Core
  // terminal events use the service-level read ledger; only an older Server falls back to device-local ts.
  useEffect(() => {
    // The session workspace remains mounted in state behind the project root. It is not visible there,
    // so treating its current pane as watched would make fresh project-inbox rows disappear unread.
    const pane = current?.paneId;
    if (!pane || terminalOverlayOpen) return;
    const state = visibleCurrentPaneState(rootView, pane, states);
    if (!state) return;
    if (state?.terminalUnread && state.terminalNotificationId) {
      void markCanonicalTerminalRead([state.terminalNotificationId]);
      return;
    }
    const ts = state?.ts;
    if (ts != null && getInboxSeen()[pane] !== ts) setSeen(markInboxSeen(pane, ts));
  }, [rootView, terminalOverlayOpen, current?.paneId, states, markCanonicalTerminalRead]);

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
    const go = async ({ session, window, pane }: { session?: string | null; window?: string | null; pane?: string | null }) => {
      if (!session) return;
      try {
        const sessions = await getSessions();
        const s = sessions.find((x) => x.name === session);
        if (s) {
          const opened = await openSession(s, { window: window ?? null, pane: pane ?? null });
          if (opened) {
            setRootView('session');
            setRootViewState('session');
            setDrawerOpen(false);
          }
        }
      } catch (e) { handledAuth(e); }
    };
    const onMsg = (event: MessageEvent<unknown>) => {
      const data = recordOf(event.data);
      if (!data) return;
      if (data.type === 'navigate') void go({
        session: typeof data.session === 'string' ? data.session : null,
        window: typeof data.window === 'string' ? data.window : null,
        pane: typeof data.pane === 'string' ? data.pane : null,
      });
      else if (data.type === 'navigate-inbox' && typeof data.id === 'string') {
        setNotifInboxOpen(true); setPendingNotifDetail(data.id);
      }
    };
    const onHash = () => { const r = readRoute(); if (r.session && (r.window || r.pane)) go(r); };
    navigator.serviceWorker.addEventListener('message', onMsg);
    window.addEventListener('hashchange', onHash);
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMsg);
      window.removeEventListener('hashchange', onHash);
    };
  }, [needToken, openSession, handledAuth]);

  // Cold-launch deep-link: a notification tap opened `/#/inbox/<id>`. Open the page+detail, mark read, then
  // clean the hash (replaceState) so the back-button/exit-guard state machines aren't left on an inbox URL.
  useEffect(() => {
    if (needToken) return;
    const r = readRoute();
    if (r.inbox) {
      setNotifInboxOpen(true);
      if (r.inboxId) setPendingNotifDetail(r.inboxId);
      history.replaceState(history.state, '', '#');
    }
  }, [needToken]); // eslint-disable-line react-hooks/exhaustive-deps -- launch-time deep-link, run once

  // Fetch the manual-push inbox: on mount, on foreground, and each time the inbox page opens/closes (so a
  // delete/open-detail reconciles). Manual pushes are low-frequency → no live polling. Prune the read-id
  // set to ids still present so it can't grow unbounded.
  useEffect(() => {
    if (needToken) return;
    let alive = true;
    const refresh = async () => {
      const mutation = notifMutationRef.current;
      try {
        const list = await getNotifications();
        if (!alive || mutation !== notifMutationRef.current) return;
        setNotifItems(list);
        setReadIds(pruneReadInboxIds(list.map((n) => n.id)));
        setNotifError('');
      } catch (e) {
        if (alive && !handledAuth(e)) {
          // Preserve known client stages (SW/config timeouts) and HTTP status instead of collapsing
          // every real failure into the same generic text. Unknown network errors stay user-friendly.
          const error = recordOf(e);
          const detail = typeof error?.code === 'string' && error.code.startsWith('push.')
            ? (typeof error.message === 'string' ? error.message : '')
            : (typeof error?.status === 'number' ? `HTTP ${error.status}` : '');
          setNotifError(detail ? `${t('pushInbox.loadFailed')} (${detail})` : t('pushInbox.loadFailed'));
        }
      }
    };
    refresh();
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVis); };
  }, [needToken, notifInboxOpen, notifRetrySeq, handledAuth]);

  // A controlled takeover briefly replaces the old Codex with a shell before the managed Codex child is
  // visible. Pin that pane's identity through the gap so the chat page and its App Server poll do not
  // disappear halfway through startup.
  const currentAgent = currentPaneAgent(current, states);
  const canonicalCurrentAgent = hasCanonicalCurrentPaneAgent(current);
  // The pane's last verified Agent owns an explicitly selected chat view until the user leaves it. Runtime
  // and tmux discovery are asynchronous health signals: a transient null must not replace the Conversation Surface with a
  // freshly mounted Terminal and then switch back on the next poll.
  const chatAgentByPaneRef = useRef(new Map<string, string>());
  if (current?.paneId && currentAgent) {
    if (chatAgentByPaneRef.current.get(current.paneId) !== currentAgent) {
      rememberRecent(chatAgentByPaneRef.current, current.paneId, currentAgent);
      localStorage.setItem(`tw_chat_agent_${current.paneId}`, currentAgent);
    }
  } else if (current?.paneId && canonicalCurrentAgent) {
    // A canonical `agent:null` means the process exited to a shell; it is not a discovery gap. Forget the
    // previous owner so this pane cannot resurrect a stale chat/run if a later legacy response is sparse.
    chatAgentByPaneRef.current.delete(current.paneId);
    clearPaneConversationIdentities(conversationIdentityByPaneRef.current, current.paneId);
    localStorage.removeItem(`tw_chat_agent_${current.paneId}`);
  }
  const persistedChatAgent = current?.paneId
    ? localStorage.getItem(`tw_chat_agent_${current.paneId}`) : null;
  const chatAgent = current?.paneId
    ? currentAgent ?? (canonicalCurrentAgent ? null : chatAgentByPaneRef.current.get(current.paneId)
      ?? (persistedChatAgent && persistedChatAgent.length <= 64 ? persistedChatAgent : null))
    : null;
  const rawCurrentKind = current?.paneId ? states[current.paneId]?.kind : null;
  const currentKind = rawCurrentKind === 'working' || rawCurrentKind === 'permission'
    || rawCurrentKind === 'compacting' || rawCurrentKind === 'error' ? rawCurrentKind : null;

  const requestChatFollowLatest = useCallback((paneId: string): void => {
    setChatFollowLatest((currentRequest) => ({
      paneId,
      request: currentRequest.request + 1,
    }));
  }, []);

  const consumeCompletedChatEntry = useCallback((request: number): void => {
    setCompletedChatEntry((currentRequest) => (
      currentRequest?.request === request ? null : currentRequest
    ));
  }, []);

  // Record a just-sent command into this WINDOW's recent history (deduped + capped in storage).
  const onCommandSent = useCallback((cmd: string) => {
    termRef.current?.wake?.(); // a dock send/fill landed → wake the poll loop (covers BottomDock too)
    const paneId = current?.paneId;
    const name = current?.session?.name;
    const win = current?.window?.id; // stable window ID, not the auto-renamed window.name
    if (name && win) setRecent(pushRecent(name, win, cmd));
  }, [current]);

  // ★/☆ on a panel row: toggle membership of the global favorites list.
  const toggleFavorite = useCallback((cmd: string) => {
    setFavorites(getFavorites().includes(cmd) ? removeFavorite(cmd) : addFavorite(cmd));
  }, []);
  // ✕ on a history row: drop that one entry from THIS window's recent history.
  const removeRecentCmd = useCallback((cmd: string) => {
    const name = current?.session?.name;
    const win = current?.window?.id; // stable window ID, not the auto-renamed window.name
    if (name && win) setRecent(removeRecent(name, win, cmd));
  }, [current]);

  // The current pane's cwd (from /panes), used as the default base when resolving a relative doc path.
  const currentPaneCwd = current?.panes?.find((p) => p.id === current.paneId)?.cwd || null;

  const refreshAgentRun = useCallback(async (stale: AgentRunRef): Promise<AgentRunRef | null> => {
    const next = await getAgentDiscovery();
    setAgentDiscovery(next);
    return next.runs.find((candidate) => (
      candidate.agentId === stale.agentId && candidate.paneId === stale.paneId
      && candidate.sessionId === stale.sessionId
    )) ?? null;
  }, []);
  const discoverActivatedRun = useCallback(async (stale: AgentRunRef): Promise<AgentRunRef | null> => {
    const next = await getAgentDiscovery();
    setAgentDiscovery(next);
    return next.runs.find((candidate) => (
      candidate.agentId === stale.agentId && candidate.paneId === stale.paneId
      && candidate.sessionId !== undefined
    )) ?? null;
  }, []);

  const discoveredAgentRun: AgentRunRef | null = agentDiscovery?.runs.find((run) => (
    run.paneId === current?.paneId && run.agentId === chatAgent
  )) ?? null;
  // Run leases are process-local and revoked authoritatively. Keeping the previous lease across a missing
  // discovery snapshot creates an infinite stale-run loop after exit/restart; the selected chat lens stays
  // mounted without it and reconnects as soon as Runtime publishes the replacement.
  const currentAgentRun = discoveredAgentRun;
  const currentAgentDescriptor = agentDiscovery?.descriptors.find((descriptor) => (
    descriptor.id === chatAgent
  )) ?? null;
  const conversationEnabled = chatAgent
    ? conversationEnabledByAgent[chatAgent] ?? getAgentConversationEnabled(chatAgent) : false;
  const conversationIdentityKey = current?.paneId && chatAgent
    ? `${current.paneId}\0${chatAgent}` : null;
  if (conversationIdentityKey && currentAgentRun?.sessionId) {
    rememberRecent(conversationIdentityByPaneRef.current, conversationIdentityKey, {
      agentId: currentAgentRun.agentId,
      paneId: currentAgentRun.paneId,
      sessionId: currentAgentRun.sessionId,
    });
  }
  // A current Runtime lease is authoritative: a newly started raw run must never inherit the previous
  // managed session remembered for this pane. The remembered identity is only a discovery-gap fallback.
  const currentConversationIdentity = currentAgentRun
    ? currentAgentRun.sessionId ? conversationIdentityByPaneRef.current.get(conversationIdentityKey!) ?? null : null
    : conversationIdentityKey
      ? conversationIdentityByPaneRef.current.get(conversationIdentityKey) ?? null : null;
  // Conversation capability owns one normalized Web Surface for every Agent. Provider identity stops at
  // Runtime discovery; Timeline and Composer never select a provider-specific implementation.
  const normalizedConversationRun = currentAgentDescriptor?.capabilities.conversation === true
    && currentAgentRun?.sessionId
    ? currentAgentRun : null;
  const normalizedConversationIdentity = currentAgentDescriptor?.capabilities.conversation === true
    ? currentConversationIdentity : null;
  const chatLensAvailable = currentAgentDescriptor?.capabilities.conversation === true
    && conversationEnabled
    && (!!normalizedConversationRun || !!normalizedConversationIdentity
      || (currentAgentDescriptor.capabilities.conversationActivation === true && !!currentAgentRun));
  // `lens` is the sole view owner. Availability controls only whether a terminal pane can opt into chat;
  // it must never evict an already selected chat view during a transient discovery or connection outage.
  const chatLens = lens === 'chat' && conversationEnabled;
  useEffect(() => {
    if (lens !== 'chat' || conversationEnabled || !current?.paneId) return;
    setLens('terminal');
    localStorage.setItem(`tw_lens_${current.paneId}`, 'terminal');
  }, [conversationEnabled, current?.paneId, lens, setLens]);
  const conversationAgents = (agentDiscovery?.descriptors ?? [])
    .filter((descriptor) => descriptor.capabilities.conversation)
    .map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      enabled: conversationEnabledByAgent[descriptor.id]
        ?? getAgentConversationEnabled(descriptor.id),
      experimental: descriptor.capabilityMetadata?.conversation?.experimental === true,
    }));
  const toggleAgentConversation = useCallback((agentId: string, enabled: boolean): void => {
    setAgentConversationEnabled(agentId, enabled);
    setConversationEnabledByAgent((currentValue) => ({ ...currentValue, [agentId]: enabled }));
    if (!enabled && agentId === chatAgent && current?.paneId) {
      setLens('terminal');
      localStorage.setItem(`tw_lens_${current.paneId}`, 'terminal');
    }
  }, [chatAgent, current?.paneId, setLens]);
  const genericConversation = useAgentConversation(
    chatLens && normalizedConversationRun ? normalizedConversationRun : null,
    onAuthFail,
    refreshAgentRun,
    chatLens ? normalizedConversationIdentity : null,
  );
  const conversationActivation = useAgentConversationActivation(
    chatLens && !normalizedConversationIdentity
      && currentAgentDescriptor?.capabilities.conversationActivation === true
      ? currentAgentRun : null,
    chatLens && !normalizedConversationIdentity
      && currentAgentDescriptor?.capabilities.conversationActivation === true,
    discoverActivatedRun,
    onAuthFail,
  );
  const agentInteraction = useAgentInteraction(
    chatLens && normalizedConversationRun ? normalizedConversationRun : null,
    currentAgentDescriptor?.capabilities.interaction === true,
    onAuthFail,
  );
  const agentSessionControl = useAgentSessionControl(
    chatLens && currentAgentDescriptor?.capabilities.sessionControl === true
      ? currentAgentRun : null,
    onAuthFail,
  );
  const conversationControlCapabilities = currentAgentDescriptor?.capabilities;
  const conversationSendable = canSendConversation(genericConversation.descriptor?.capabilities);
  const conversationControlsEnabled = !!conversationControlCapabilities && [
    conversationControlCapabilities.conversationGoal,
    conversationControlCapabilities.conversationPlan,
    conversationControlCapabilities.conversationContext,
    conversationControlCapabilities.conversationPermission,
    conversationControlCapabilities.conversationCommands,
  ].some(Boolean) || conversationSendable;
  const agentConversationControls = useAgentConversationControls(
    chatLens && conversationControlsEnabled ? currentAgentRun : null,
    chatLens && conversationControlsEnabled,
    onAuthFail,
  );
  const serverConversationActivity = agentConversationControls.snapshot?.activity
    ?? agentConversationControls.snapshot?.context?.activity
    ?? (genericConversation.status === 'loading' || genericConversation.status === 'reconnecting'
      ? 'unknown'
      : currentKind === 'compacting' ? 'compacting'
        : currentKind === 'permission' ? 'waiting'
          : currentKind === 'working' ? 'working' : 'idle');
  const canonicalConversationItems = genericConversation.canonicalItems ?? genericConversation.items;
  const conversationSubmissionProjection = useMemo(() => projectConversationSubmissions(
    canonicalConversationItems,
    genericConversation.localSubmissions ?? [],
    agentConversationControls.snapshot?.queue?.items ?? [],
  ), [canonicalConversationItems, genericConversation.localSubmissions,
    agentConversationControls.snapshot?.queue?.items]);
  const conversationActivity = projectConversationActivity(
    serverConversationActivity,
    conversationSubmissionProjection.timeline,
  );
  const projectedConversation = useMemo(() => ({
    ...genericConversation,
    items: projectConversationTimeline(
      canonicalConversationItems,
      conversationSubmissionProjection.timeline,
    ),
  }), [canonicalConversationItems, conversationSubmissionProjection.timeline, genericConversation]);
  const [conversationControlRequest, setConversationControlRequest] = useState({
    identity: '', goal: 0, goalEdit: 0, model: 0,
  });
  const conversationRequestIdentity = normalizedConversationIdentity
    ? `${normalizedConversationIdentity.agentId}\0${normalizedConversationIdentity.sessionId}` : '';
  const requestForCurrentConversation = conversationControlRequest.identity === conversationRequestIdentity
    ? conversationControlRequest : { identity: conversationRequestIdentity, goal: 0, goalEdit: 0, model: 0 };
  const handleConversationSlash = useCallback(async (text: string): Promise<boolean> => {
    const match = text.trim().match(/^\/(model|effort|goal|compact|clear)(?:\s+([\s\S]+))?$/i);
    if (!match) return false;
    const command = match[1]!.toLowerCase();
    const argument = match[2]?.trim() ?? '';
    if (command === 'model' || command === 'effort') {
      if (!conversationControlCapabilities?.sessionControl) return false;
      if (!argument) {
        setConversationControlRequest((current) => ({
          ...current, identity: conversationRequestIdentity, model: current.model + 1,
        }));
        return true;
      }
      await agentSessionControl.update(command === 'model' ? { model: argument } : { effort: argument });
      return true;
    }
    if (command === 'goal') {
      if (!conversationControlCapabilities?.conversationGoal) return false;
      const action = argument.toLowerCase();
      if (!argument || action === 'edit') {
        setConversationControlRequest((current) => {
          const request = current.goal + 1;
          return {
            ...current, identity: conversationRequestIdentity, goal: request,
            goalEdit: action === 'edit' ? request : 0,
          };
        });
        return true;
      }
      const goalActions = agentConversationControls.snapshot?.goalActions ?? [];
      if (action === 'clear') {
        if (!goalActions.includes('clear')) return false;
        await agentConversationControls.goalAction('clear');
      }
      else if (action === 'pause' || action === 'resume') {
        if (!goalActions.includes('update')) return false;
        await agentConversationControls.goalAction('update', {
          status: action === 'pause' ? 'paused' : 'active',
        });
      } else {
        if (!goalActions.includes('start')) return false;
        await agentConversationControls.goalAction('start', { objective: argument });
      }
      return true;
    }
    if (!conversationControlCapabilities?.conversationCommands
      || !agentConversationControls.snapshot?.commands?.includes(command as 'compact' | 'clear')) return false;
    await agentConversationControls.command(command as 'compact' | 'clear');
    return true;
  }, [agentConversationControls, agentSessionControl, conversationControlCapabilities,
    conversationRequestIdentity]);
  const paneSurfaceIdentity = !chatLens
    ? 'terminal'
    : normalizedConversationIdentity
      ? `conversation\0${normalizedConversationIdentity.agentId}\0${normalizedConversationIdentity.sessionId}`
      : currentAgentRun && currentAgentDescriptor?.capabilities.conversationActivation === true
        ? `conversation-activation\0${currentAgentRun.runId}` : 'chat-unavailable';
  const paneSurfaceOwnerKey = `${currentPaneId ?? 'none'}\0${paneSurfaceIdentity}`;
  const completedEntryRequest = completedChatEntry
    && completedChatEntry.paneId === current?.paneId
    && completedChatEntry.window === current?.window.id
    && completedChatEntry.session === current?.session.name
    ? completedChatEntry.request : 0;
  useEffect(() => {
    if (!completedChatEntry || !current) return;
    if (completedChatEntry.paneId !== current.paneId
      || completedChatEntry.window !== current.window.id
      || completedChatEntry.session !== current.session.name) setCompletedChatEntry(null);
  }, [completedChatEntry, current]);

  // Fetch + open a doc by ABSOLUTE path: dedupe into a tab, record the recent, reveal the sheet.
  // Throws on fetch failure so callers can decide (prompt for a base dir, or surface inline).
  const openAbsDoc = async (abs: string): Promise<void> => {
    // Images open in the inline viewer. Fetch the bytes HERE (not in DocView) so a bad path THROWS
    // just like fetchDoc does — that way a relative/ambiguous tap falls into the same "pick the base
    // dir" recovery below, instead of opening a dead tab. The object URL rides on the tab as content;
    // DocView revokes it on unmount. Re-tapping an already-open image just re-activates (no refetch).
    if (isImageName(abs)) {
      const name = abs.split('/').pop() || abs;
      // Re-tapping an already-open image re-activates it and refreshes (conditional — re-downloads only
      // if the file changed on disk); a first open fetches the bytes and records the mtime for later.
      if (docTabs.tabs.some((t) => t.key === abs)) { docTabs.activate(abs); refreshDocTab(abs); setFileManagerOpen(true); return; }
      const image = await fetchImageUrl(abs); // throws on 404/401 → caller's recovery (toast / base prompt)
      if ('notModified' in image) return;
      docTabs.openDoc(abs, { type: 'image', name, content: image.url, mtime: image.mtimeMs });
      pushRecentDoc({ path: abs, name, type: 'image', ts: Date.now() });
      setFileManagerOpen(true);
      return;
    }
    const res = await fetchDoc(abs); // throws on non-2xx (404/400/…)
    if ('notModified' in res) return;
    docTabs.openDoc(abs, {
      type: res.type,
      name: res.name,
      content: res.content,
      ...(res.mtimeMs !== undefined ? { mtime: res.mtimeMs } : {}),
    });
    pushRecentDoc({ path: abs, name: res.name, type: res.type, ts: Date.now() });
    setFileManagerOpen(true);
  };

  // Closing an image tab frees its object URL (created in openAbsDoc). The URL must outlive tab
  // SWITCHES — DocView unmounts on every switch — so we revoke here, on actual close, not on unmount.
  const closeDocTab = (key: string) => {
    const tab = docTabs.tabs.find((t) => t.key === key);
    if (tab?.type === 'image' && typeof tab.content === 'string') URL.revokeObjectURL(tab.content);
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
  const refreshDocTab = (key: string) => {
    const tab = docTabs.tabs.find((t) => t.key === key);
    if (!tab || tab.type === 'home') return;
    if (tab.type === 'image') {
      fetchImageUrl(key, tab.mtime ?? null)
        .then((res) => {
          if ('notModified' in res) return; // unchanged → keep the same object URL (no re-download, no flash)
          const old = tab.content;
          docTabs.refreshDoc(key, { content: res.url, mtime: res.mtimeMs });
          if (typeof old === 'string') URL.revokeObjectURL(old); // free the superseded blob (the <img> is already re-pointed)
        })
        .catch(() => { /* keep the last-good image */ });
      return;
    }
    fetchDoc(key, tab.mtime ?? null)
      .then((res) => {
        if ('notModified' in res) return; // unchanged on disk → leave the tab (and its scroll/TTS) alone
        docTabs.refreshDoc(key, {
          type: res.type,
          name: res.name,
          content: res.content,
          ...(res.mtimeMs !== undefined ? { mtime: res.mtimeMs } : {}),
        });
      })
      .catch(() => { /* keep the last-good content */ });
  };

  // Switching to a doc tab is instant (activate), then its content refreshes in the background.
  const activateDocTab = (key: string) => { docTabs.activate(key); refreshDocTab(key); };

  // Topbar file button: reveal the sheet and refresh whatever doc it lands on ("switch away & back").
  const reopenFiles = () => { setFileManagerOpen(true); refreshDocTab(docTabs.active); };

  // req() throws Error("/api/... -> 404"); map the trailing status to a readable reason.
  const friendlyDocError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : '';
    const m = /-> (\d+)/.exec(message);
    const status = m ? Number(m[1]) : 0;
    if (status === 404) return t('app.docNotFound');
    if (status === 413) return t('app.docTooLarge');
    if (status === 400 || status === 415) return t('app.docUnsupported');
    return t('app.docOpenFailed');
  };

  // Entry from a terminal tap or the home path box. Absolute → open directly. Relative → resolve
  // against the pane's stored base (or its cwd); if that doesn't open, prompt for the base dir.
  const onOpenDoc = async (rawPath: string): Promise<void> => {
    if (isAbsolute(rawPath)) {
      // No base to fill for an absolute path → surface the reason as a transient toast.
      try { await openAbsDoc(rawPath); } catch (e) { setDocToast(friendlyDocError(e)); }
      return;
    }
    const base = current?.paneId ? getPaneBase(current.paneId) ?? currentPaneCwd : currentPaneCwd;
    if (base) {
      try { await openAbsDoc(joinPath(base, rawPath)); return; }
      catch { /* fall through to prompt */ }
    }
    setBasePrompt({ rawPath });
  };

  // Opening a confirmed link is a history transition, not two independent overlay changes. First let
  // Back pop the confirmation card's own entry; only after that pop has closed the card may the file
  // sheet (or relative-path picker) push its entry. Otherwise the delayed pop can immediately close the
  // newly opened layer, producing the visible "flash and disappear" failure.
  useEffect(() => {
    if (docLinkPrompt || !pendingDocLinkRef.current) return undefined;
    const path = pendingDocLinkRef.current;
    pendingDocLinkRef.current = null;
    const timer = window.setTimeout(() => {
      void onOpenDoc(path).finally(() => setDocLinkOpening(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [docLinkPrompt]); // eslint-disable-line react-hooks/exhaustive-deps -- run once after this prompt's history pop

  // DirPicker pick: resolve+open the unresolved relative path against the chosen base dir, then
  // remember it for this pane. On failure (still not found there), keep the picker open and surface
  // the reason as a toast so the user can pick another directory.
  const pickBaseDir = async (baseDir: string): Promise<void> => {
    if (!basePrompt) return;
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

  // A tapped terminal link doesn't act straight away (anti-误触): pop a confirm card near the tap. The
  // link carries its kind — a doc path opens the reader/image viewer; a web URL asks to open Browser.
  // Pass the raw tap point — DocLinkPopover clamps its own measured box inside the viewport.
  const onDocLinkTap = (link: TerminalOutputLink | OutputLink, cx: number, cy: number): void => {
    if (link.kind === 'url') {
      const raw = link.raw || link.path;
      if (raw) setLocalUrlPrompt({ raw, x: cx, y: cy });
    } else if (link.path) setDocLinkPrompt({ path: link.path, x: cx, y: cy });
  };
  const confirmDocLink = (path: string) => {
    if (docLinkOpening) return;
    pendingDocLinkRef.current = path;
    setDocLinkOpening(true);
    window.history.back();
  };

  // Confirm a terminal web link → open it as a new built-in browser tab.
  const [localUrlError, setLocalUrlError] = useState<string | null>(null);
  const [localUrlOpening, setLocalUrlOpening] = useState(false);
  const [localUrlBusyMode, setLocalUrlBusyMode] = useState<BrowserMode | null>(null);
  const localUrlAbortRef = useRef<AbortController | null>(null);
  const localUrlRequestRef = useRef(0);
  const confirmLocalUrl = async (_path: string, mode: BrowserMode = 'direct'): Promise<void> => {
    const p = localUrlPrompt;
    if (!p) return;
    localUrlAbortRef.current?.abort();
    const requestId = ++localUrlRequestRef.current;
    const controller = new AbortController();
    localUrlAbortRef.current = controller;
    setLocalUrlBusyMode(mode);
    setLocalUrlOpening(true);
    try {
      const opened = await browser.openUrl(p.raw, { mode, signal: controller.signal });
      if (requestId !== localUrlRequestRef.current) return;
      if (!opened) { setLocalUrlError(t('localurl.failed')); return; }
      setLocalUrlPrompt(null);
      setLocalUrlError(null);
    } catch (e) {
      if (requestId !== localUrlRequestRef.current) return;
      if (handledAuth(e)) return;
      setLocalUrlError(e instanceof Error && e.message ? e.message : t('localurl.failed'));
    } finally {
      if (requestId === localUrlRequestRef.current) {
        localUrlAbortRef.current = null;
        setLocalUrlBusyMode(null);
        setLocalUrlOpening(false);
      }
    }
  };
  const closeLocalUrl = () => {
    localUrlRequestRef.current += 1;
    localUrlAbortRef.current?.abort();
    localUrlAbortRef.current = null;
    setLocalUrlBusyMode(null);
    setLocalUrlOpening(false);
    setLocalUrlPrompt(null);
    setLocalUrlError(null);
  };

  // Auto-dismiss the doc toast after a few seconds (also dismissible by tap).
  useEffect(() => {
    if (!docToast) return;
    const id = setTimeout(() => setDocToast(null), 4000);
    return () => clearTimeout(id);
  }, [docToast]);

  // Workspace recovery is a light authenticated poll: the server owns expiry/eligibility, while this
  // browser owns only per-checkpoint autoShown/ignored state. allSettled keeps the protection warning
  // fresh even when there is no checkpoint (restore-plan may legitimately be unavailable).
  usePollingLoop({
    fetch: async () => {
      const [sessions, plan, protection] = await Promise.allSettled([
        getSessions(), getWorkspaceRestorePlan(), getWorkspaceProtectionStatus(),
      ]);
      for (const row of [sessions, plan, protection]) if (row.status === 'rejected') handledAuth(row.reason);
      return {
        sessions: sessions.status === 'fulfilled' ? sessions.value : undefined,
        plan: plan.status === 'fulfilled' ? plan.value : undefined,
        protection: protection.status === 'fulfilled' ? protection.value : undefined,
      };
    },
    apply: ({ sessions, plan, protection }) => {
      if (protection !== undefined) setWorkspaceProtection(protection);
      if (Array.isArray(sessions)) liveSessionCountRef.current = sessions.length;
      if (plan?.mapping && liveSessionCountRef.current === null) applyRecoveryMapping(plan.mapping);
      if (plan !== undefined && liveSessionCountRef.current !== null) {
        consumeRecoveryPlan(plan, liveSessionCountRef.current);
      }
    },
    intervalMs: 15000,
    enabled: !needToken,
  });

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
        if (!cancelled && session) {
          const opened = await openSession(session, target, { isCancelled: () => cancelled });
          if (!cancelled && route.session && opened) {
            setRootView('session');
            setRootViewState('session');
          }
        }
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
    apply: (s) => {
      const next = s || {};
      setStates(next);
    },
    intervalMs: 5000,
    enabled: !needToken,
    deps: [bound],
  });

  // Pane identity belongs to Runtime's /panes projection, not the Inbox compatibility roster. Refresh only
  // the open window so process exits/switches clear or replace its logo without probing every host pane.
  usePollingLoop({
    fetch: () => getPanes(current?.window?.id || ''),
    apply: (panes) => {
      const windowId = current?.window?.id;
      if (windowId) refreshPanes(windowId, panes);
    },
    onError: recoverCurrentTopology,
    intervalMs: 5_000,
    enabled: !needToken && !!current?.window?.id,
    deps: [current?.window?.id],
  });

  usePollingLoop({
    fetch: getAgentDiscovery,
    apply: setAgentDiscovery,
    onError: handledAuth,
    intervalMs: 5_000,
    enabled: !needToken,
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
  const inboxReconnecting = inboxReconnectNeeded(agentDiscovery);
  // windowId → agent id, for the per-window agent logo on a collapsed WindowTab (a single-pane window, or an
  // inactive multi-pane one where we only have this aggregate). The active multi-pane window renders per-pane
  // instead (paneAgents below), so it doesn't rely on this squash. A state entry exists only for a pane
  // actually running an agent, so this is its agent.
  const { windowAgents, paneAgents } = navigationAgentMaps(current, states);
  // paneId → agent id, for the per-pane agent logo inside the active window's pane menu (states is keyed by
  // pane, so this is the live truth for each one; a pane not running an agent simply has no entry → no logo).
  const changelogUnread = !!LATEST_RELEASE && clSeen !== LATEST_RELEASE;
  // The gear's dot fuses two phases of "there's something new": an available npm update (before you upgrade)
  // and, after upgrading+reloading, the unread changelog it brought. `updateDot` stays off once the user has
  // opened Settings for this `latest` (verSeen), even if they don't upgrade — it relights only on a newer release.
  const updateDot = !!updateInfo?.updateAvailable && updateInfo.latest !== verSeen;
  const readSet = new Set(readIds);
  const notifUnreadCount = notifItems.filter((n) => !readSet.has(n.id)).length; // per-message → in-page count
  // Top red dot follows the LATEST-time high-water: it shows only while a notification newer than the last
  // one you've SEEN (by opening the page) exists. Opening the page clears it even if messages inside are
  // still unread; a newer push relights it. (Per-message unread lives on the rows / the count, not here.)
  const hasNewNotif = (notifItems[0]?.ts ?? -Infinity) > notifSeenTs; // items are newest-first
  const gearDot = changelogUnread || updateDot || hasNewNotif;
  const openSettings = () => {
    setSettingsOpen(true);
    if (updateInfo?.latest) { setVersionSeen(updateInfo.latest); setVerSeen(updateInfo.latest); } // acknowledge → clears updateDot
  };
  const openChangelog = () => {
    setChangelogOpen(true);
    if (LATEST_RELEASE) { setChangelogSeen(LATEST_RELEASE); setClSeen(LATEST_RELEASE); } // opening clears the unread dot
  };
  const managedPane = current?.panes?.find((pane) => pane.id === managePane);
  const showManagedPaneWidth = Number.isFinite(managedPaneWidth)
    && !!managedPane && !!managePane && canResizePaneWidth(current?.panes, managePane);
  const managedPaneSubtitlePanes = managedPaneWidth == null ? current?.panes : current?.panes?.map((pane) => (
    pane.id === managePane ? { ...pane, width: managedPaneWidth } : pane
  ));
  const closePaneManagement = () => {
    if (managePaneWindowRef.current) savedLayoutsRef.current.delete(managePaneWindowRef.current);
    managePaneWindowRef.current = null;
    setManagedPaneWidth(null);
    setPaneLayoutRestoreReady(false);
    setManagePane(null);
  };
  const inboxControl = (
    <Inbox
      rows={inboxList}
      top={inboxTop}
      open={inboxOpen}
      onToggle={() => setInboxOpen((o) => !o)}
      onClose={() => setInboxOpen(false)}
      onSelectRow={openInboxRow}
      onMarkAllRead={markAllRead}
      reconnecting={inboxReconnecting}
      hooksStatus={hooksStatus}
      onEnableHooks={enableHooks}
    />
  );
  const projectInboxControl = (
    <Inbox
      rows={inboxList}
      top={inboxTop}
      open={inboxOpen}
      onToggle={() => setInboxOpen((o) => !o)}
      onClose={() => setInboxOpen(false)}
      onSelectRow={(row) => {
        void openInboxRow(row).then((opened) => {
          if (opened) chooseRootView('session');
        });
      }}
      onMarkAllRead={markAllRead}
      reconnecting={inboxReconnecting}
      hooksStatus={hooksStatus}
      onEnableHooks={enableHooks}
    />
  );

  return (
    // When the soft keyboard opens, slide the WHOLE app up by the keyboard height so it moves
    // as one unit: the keys + input land just above the keyboard and the terminal's bottom sits
    // right above the keys (the topbar scrolls off the top, which is fine while typing). Uses a
    // transform — the same lift that worked on the dock — so iOS can't undo it by re-scrolling.
    <AgentCatalogProvider descriptors={agentDiscovery?.descriptors ?? EMPTY_AGENT_CATALOG}
      runs={agentDiscovery?.runs ?? []} loaded={agentDiscovery !== null}>
    <OverlayProvider keyboardInset={inset} chatTone={chatTone}>
      <div className="app" data-chat-tone={chatTone}
        data-desktop-input={detectedDesktopInput || undefined}
        onPointerDownCapture={captureTerminalOwner}
        style={inset ? { transform: `translateY(-${inset}px)` } : undefined}>
      {rootView === 'session' && <header className="topbar">
        <button ref={drawerMenuRef} className="hamburger" onClick={() => setDrawerOpen(true)}>☰</button>
        <span className="session-name" {...sessionNameLongPress}>{current?.session?.name ?? '—'}</span>
        {/* Always render so it doesn't pop in late once `current` loads — just disable until ready. */}
        <button className="topbar-icon" onClick={() => setIdeaOpen(true)} aria-label={t('app.ideas')} title={t('app.ideas')}
          disabled={!current}>
          <BulbIcon />
          {ideaCount > 0 && <span className="idea-badge">{ideaCount}</span>}
        </button>
        {inboxControl}
        <button className="topbar-icon" onClick={() => setUsageOpen(true)} aria-label={t('usage.title')} title={t('usage.title')}><GaugeIcon /></button>
        <button className={`topbar-icon browser-entry${browserStatus ? ` ${browserStatus}` : ''}`}
          onClick={() => browser.setOpen(true)} aria-label={t('app.browser')} title={t('app.browser')}>
          <GlobeIcon />
        </button>
        <button className="topbar-icon" onClick={reopenFiles} aria-label={t('app.files')} title={t('app.files')}><FolderIcon /></button>
        <button className="topbar-icon" onClick={() => setGitOpen(true)} aria-label="Git" title="Git"><GitIcon /></button>
        <button className="topbar-icon" onClick={openSettings} aria-label={t('app.settings')} title={t('app.settings')}>
          <GearIcon />
          {gearDot && <span className="topbar-dot" aria-hidden="true" />}
        </button>
      </header>}
      <UsagePage
        open={usageOpen}
        onClose={() => setUsageOpen(false)}
        onAuthFail={onAuthFail}
      />
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        workspaceProtection={workspaceProtection}
        chatTone={chatTone}
        onChatTone={pickChatTone}
        conversationAgents={conversationAgents}
        onConversationAgentEnabled={toggleAgentConversation}
        keyboardMode={keyboardMode}
        onKeyboardMode={chooseKeyboardMode}
        terminalTransport={terminalTransport}
        onTerminalTransport={chooseTerminalTransport}
        snapshotInterval={snapshotInterval}
        onSnapshotInterval={chooseSnapshotInterval}
        agentIntegrations={agentIntegrations}
        termRef={termRef}
        onOpenChangelog={openChangelog}
        changelogUnread={changelogUnread}
        notifUnread={hasNewNotif}
        onOpenInbox={openNotifInbox}
        updateInfo={updateInfo}
        voiceEnabled={serverConfig?.asr ?? false}
        voiceProvider={serverConfig?.asrProvider ?? null}
        voiceMode={serverConfig?.asrMode ?? null}
        voiceFillerFilterSupported={serverConfig?.asrFillerFilter ?? false}
      />
      <Changelog open={changelogOpen} onClose={() => setChangelogOpen(false)} />
      <InboxPage
        open={notifInboxOpen}
        detailId={notifDetailId}
        items={notifItems}
        readIds={readIds}
        onOpenDetail={openNotifDetail}
        onCloseDetail={closeNotifDetail}
        onClose={closeNotifInbox}
        onDelete={deleteNotifItem}
        deletingId={notifDeletingId}
        error={notifError}
        onRetry={() => setNotifRetrySeq((n) => n + 1)}
        onMarkAllRead={markAllNotifRead}
        unreadCount={notifUnreadCount}
      />
      {rootView === 'session' && <Drawer
        open={drawerOpen}
        currentSessionName={current?.session?.name ?? null}
        bound={bound}
        onSelectSession={selectSession}
        onUnbind={unbindSession}
        onBind={() => setBindOpen(true)}
        onClose={() => setDrawerOpen(false)}
        onLogout={logout}
        orphans={orphans}
        onTakeoverRequest={(orphan) => {
          if (orphan.sessionId) setTakeoverTarget({ ...orphan, sessionId: orphan.sessionId });
        }}
        recoveryPlan={recoveryPlan}
        recoveryOperation={recoveryOperation}
        onOpenRecovery={openRecoveryFromDrawer}
        projectTaskBeta={projectTaskBeta}
        onSwitchProject={() => chooseRootView('project')}
      />}
      <WorkspaceRestoreDialog
        open={recoveryDialogOpen}
        plan={recoveryPlan}
        operation={recoveryOperation}
        submitting={recoverySubmitting}
        returnFocusRef={drawerMenuRef}
        onRestore={startRecovery}
        onIgnore={ignoreRecovery}
        onClose={closeRecovery}
        onRebind={rebindAfterRecovery}
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
        paneId={current?.paneId ?? null}
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
        title={t('app.manageWindow')}
        subtitle={windowManageSubtitle(manageWindow)}
        onClose={() => setManageWindow(null)}
        actions={manageWindow ? [
          // A single-pane window has nothing to reorder-within, but IS splittable — offer it here so a
          // lone pane can be split from the window-level menu (the per-pane menu only appears once there's
          // a map to long-press). Shown for ANY single-pane window, current or not (split switches to it).
          ...(manageWindow.panes === 1 ? [
            [
              { key: 'split-h', icon: <SplitHIcon />, label: t('pane.splitH'), onClick: () => splitWindowAction(manageWindow, 'h') },
              { key: 'split-v', icon: <SplitVIcon />, label: t('pane.splitV'), onClick: () => splitWindowAction(manageWindow, 'v') },
            ],
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
      >
        {manageWindow?.panes === 1 && typeof manageWindow.width === 'number' && Number.isFinite(manageWindow.width) && (
          <ColumnStepper
            label={t('resize.windowWidth')}
            cols={manageWindow.width}
            onAdjust={resizeManagedWindowCols}
            onRestore={restoreManagedWindowCols}
            restoreLabel={t('resize.restoreAutoWidth')}
            restoreDisabled={windowResizePending > 0}
          />
        )}
      </ActionSheet>
      <ActionSheet
        open={!!managePane}
        title={t('pane.manageTitle')}
        subtitle={paneManageSubtitle(managedPaneSubtitlePanes?.map((pane) => {
          const { width, height, ...rest } = pane;
          return {
            ...rest,
            ...(width != null ? { width } : {}),
            ...(height != null ? { height } : {}),
          };
        }), managePane)}
        onClose={closePaneManagement}
        actions={managePane ? [
          { key: 'split-h', icon: <SplitHIcon />, label: t('pane.splitH'), onClick: () => splitPaneAction(managePane, 'h') },
          { key: 'split-v', icon: <SplitVIcon />, label: t('pane.splitV'), onClick: () => splitPaneAction(managePane, 'v') },
          {
            key: 'close', icon: <XIcon />, label: t('pane.close'), danger: true, confirm: true,
            confirmLabel: t('pane.closeConfirm'), onClick: closeManagedPane,
          },
        ] : []}
      >
        {showManagedPaneWidth && (
          <ColumnStepper
            label={t('resize.paneWidth')}
            cols={managedPaneWidth ?? 0}
            onAdjust={resizeManagedPaneCols}
            onRestore={restoreManagedPaneLayout}
            restoreLabel={t('resize.restoreRatio')}
            restoreDisabled={!paneLayoutRestoreReady || paneResizePending > 0}
          />
        )}
      </ActionSheet>
      <FileManager
        open={fileManagerOpen}
        pane={current?.paneId ?? null}
        windowId={current?.window?.id ?? null}
        tabs={docTabs.tabs}
        active={docTabs.active}
        onActivate={activateDocTab}
        onCloseTab={closeDocTab}
        onMinimize={() => setFileManagerOpen(false)}
        onOpenDoc={onOpenDoc}
        pendingShare={pendingShare}
        onPendingConsumed={() => setPendingShare(null)}
      />
      <GitPanel open={gitOpen} pane={current?.paneId ?? null} windowId={current?.window?.id ?? null}
        inset={inset} onClose={() => setGitOpen(false)} />
      {/* App-wide upload lock (portal on <body>) — driven by the shared uploadJob store from either the
          chat ＋ or the file browser; blocks interaction during a transfer, Cancel is the only control. */}
      <UploadOverlay />
      {/* One-time "Add to Home Screen" coach — self-gates (standalone / dismissed / desktop → nothing). */}
      <AddToHome />
      <BrowserSheet browser={browser} staticPreview={staticPreview} />
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
          busy={docLinkOpening}
          onOpen={confirmDocLink}
          onClose={() => { if (!docLinkOpening) setDocLinkPrompt(null); }}
        />
      )}
      {localUrlPrompt && (
        <DocLinkPopover
          icon={<GlobeIcon />}
          name={t('localurl.title')}
          path={localUrlPrompt.raw}
          openLabel={t('localurl.open')}
          {...(localUrlError ? { note: localUrlError } : {})}
          x={localUrlPrompt.x}
          y={localUrlPrompt.y}
          busy={localUrlOpening}
          busyMode={localUrlBusyMode}
          allowRepeat={true}
          modeChoices={true}
          proxyAvailable={browser.proxyAvailable}
          onOpen={confirmLocalUrl}
          onClose={closeLocalUrl}
        />
      )}
      <IdeaPanel
        open={ideaOpen}
        session={current?.session?.name || ''}
        window={current?.window?.name || current?.window?.id || ''}
        micAvailable={!!micAvailable}
        voiceMode={serverConfig?.asrMode ?? 'streaming'}
        onClose={() => setIdeaOpen(false)}
        onSend={(text) => { dockRef.current?.fill(text); setIdeaOpen(false); }}
        onCountChange={setIdeaCount}
      />
      <DirPicker
        open={!!basePrompt}
        seedCwd={current?.paneId ? getPaneBase(current.paneId) ?? currentPaneCwd ?? null : currentPaneCwd ?? null}
        pane={current?.paneId ?? null}
        hint={basePrompt ? <>{t('app.cannotLocate')} <code>{basePrompt.rawPath}</code>{t('app.pickItsDir')}</> : null}
        onPick={pickBaseDir}
        onClose={() => setBasePrompt(null)}
        inset={inset}
      />
      {rootView === 'project' ? (
        <ProjectRoot drawerOpen={drawerOpen} inbox={projectInboxControl} inset={inset}
          onOpenDrawer={() => setDrawerOpen(true)} onCloseDrawer={() => setDrawerOpen(false)}
          onSwitchSession={() => chooseRootView('session')}
          onOpenUsage={() => setUsageOpen(true)}
          onOpenSettings={openSettings} />
      ) : current ? (
        <>
          <WindowBar
            windows={current.windows}
            windowAgents={windowAgents}
            paneAgents={paneAgents}
            currentAgent={currentAgent}
            currentWindowId={current.window.id}
            panes={current.panes}
            currentPaneId={current.paneId}
            onSelectWindow={selectWindow}
            onSelectPane={selectPane}
            onNewWindow={() => setNewWinOpen(true)}
            onManageWindow={openWindowManagement}
            onManagePane={openPaneManagement}
            onBeforePaneMapOpen={refreshPaneMap}
            paneSheetOpen={!!managePane}
            openMapFor={openMapFor}
            onMapOpened={() => setOpenMapFor(null)}
            onPaneMapOpenChange={setPaneMapOpen}
            trackWindowId={manageWindow?.id ?? null}
            lens={lens}
            chatLensEnabled={chatLensAvailable || chatLens}
            onLensChange={(v) => { setLens(v); localStorage.setItem('tw_lens_' + current.paneId, v); }}
          />
          {/* The host replaces the primary Surface and its matching controls as one keyed bundle. */}
          <PaneSurfaceHost
            key={paneSurfaceOwnerKey}
            ownerKey={paneSurfaceOwnerKey}
            primary={current.paneId && (
            chatLens ? (
              normalizedConversationIdentity ? (
                <AgentConversationView
                  key={`conversation-view\0${normalizedConversationIdentity.agentId}\0${normalizedConversationIdentity.sessionId}`}
                  conversation={projectedConversation}
                  working={conversationActivity === 'working'}
                  activity={conversationActivity}
                  onDocLinkTap={onDocLinkTap}
                  completedEntryRequest={completedEntryRequest}
                  onCompletedEntryConsumed={consumeCompletedChatEntry}
                  followLatestRequest={chatFollowLatest.paneId === current.paneId
                    ? chatFollowLatest.request : 0} />
              ) : currentAgentRun
                && currentAgentDescriptor?.capabilities.conversationActivation === true ? (
                <AgentConversationActivationGuide controller={conversationActivation} onCancel={() => {
                  setLens('terminal');
                  localStorage.setItem(`tw_lens_${current.paneId}`, 'terminal');
                }} />
              ) : (
                <AgentConversationErrorView message={t('chat.session.connectionTitle')}
                  resetKey={`${current.paneId}\0${chatAgent ?? ''}`} />
              )
            ) : (
              <Terminal
                ref={termRef}
                key={current.paneId}
                pane={current.paneId}
                stream={terminalStream}
                snapshotIntervalMs={snapshotInterval}
                desktop={desktopInput}
                autoFocusInput={!terminalOverlayOpen}
                inset={inset}
                onAuthFail={onAuthFail}
                onDocLinkTap={onDocLinkTap}
                onInputFocusChange={setTerminalFocused}
                onInputData={enqueueDesktopInput}
                onRequestDraft={focusDraft}
                onKeepKeyboard={() => dockRef.current?.keepKeyboardForGesture?.() ?? false}
                onTap={() => {
                  if (desktopInput) focusTerminal();
                  else dockRef.current?.hideKeyboard();
                }}
              />
            )
          )}
            controls={chatLens ? (
            normalizedConversationIdentity ? (<>
              <AgentInteractionLayer controller={agentInteraction} waiting={currentKind === 'permission'}
                onOpenTerminal={() => {
                setLens('terminal');
                localStorage.setItem(`tw_lens_${current.paneId}`, 'terminal');
              }} />
              <AgentConversationComposer
                key={`conversation-controls\0${normalizedConversationIdentity.agentId}\0${normalizedConversationIdentity.sessionId}`}
                agentId={normalizedConversationIdentity.agentId}
                sessionId={normalizedConversationIdentity.sessionId}
                desktop={desktopInput}
                busy={currentKind === 'working' || currentKind === 'permission'
                  || currentKind === 'compacting'
                  || genericConversation.items.some((item) => item.provisional)}
                activity={conversationActivity}
                conversation={projectedConversation}
                onSendStart={() => requestChatFollowLatest(current.paneId)}
                cwd={currentPaneCwd}
                shortcuts={serverShortcuts}
                micAvailable={!!micAvailable}
                voiceMode={serverConfig?.asrMode ?? 'streaming'}
                onAuthFail={onAuthFail}
                onSlashCommand={handleConversationSlash}
                headerContent={<>
                  {(conversationControlCapabilities?.conversationGoal
                    || conversationControlCapabilities?.conversationPlan)
                    ? <AgentConversationMilestoneControls controller={agentConversationControls}
                      goalOpenRequest={requestForCurrentConversation.goal}
                      goalEditRequest={requestForCurrentConversation.goalEdit}
                      chatTone={chatTone} keyboardInset={inset} /> : null}
                </>}
                queueContent={conversationSendable
                  ? <AgentConversationQueueControl controller={agentConversationControls}
                    conversation={projectedConversation}
                    items={conversationSubmissionProjection.queue}
                    activity={serverConversationActivity}
                    chatTone={chatTone} keyboardInset={inset} /> : undefined}
                actionContent={(conversationControlCapabilities?.conversationContext
                  || conversationControlCapabilities?.conversationPermission)
                  ? <AgentConversationActionControls controller={agentConversationControls}
                    sessionId={normalizedConversationIdentity.sessionId}
                    showPermission={conversationControlCapabilities.conversationPermission === true}
                    showContext={conversationControlCapabilities.conversationContext === true} /> : undefined}
                sessionControl={currentAgentDescriptor?.capabilities.sessionControl === true
                  ? <AgentModelControl control={agentSessionControl} busy={currentKind === 'working'
                    || currentKind === 'permission' || currentKind === 'compacting'
                    || genericConversation.items.some((item) => item.provisional)}
                    openRequest={requestForCurrentConversation.model} />
                  : undefined}
                chatTone={chatTone}
                keyboardInset={inset}
              />
            </>) : null
          ) : (
            <BottomDock
              ref={dockRef}
              pane={current.paneId}
              onAuthFail={onAuthFail}
              onKey={sendKey}
              onText={sendChar}
              cwd={currentPaneCwd}
              agent={currentAgent ?? null}
              windowId={current.window?.id}
              recent={recent}
              favorites={favorites.map((text): ShortcutItem => ({ kind: 'cmd', text, source: 'local' }))}
              onSent={onCommandSent}
              onToggleFav={(item) => toggleFavorite(item.text)}
              onRemoveRecent={removeRecentCmd}
              inset={inset}
              shortcuts={serverShortcuts}
              micAvailable={!!micAvailable}
              voiceMode={serverConfig?.asrMode ?? 'streaming'}
              desktopUnified={desktopInput}
              terminalFocused={terminalFocused}
              onLeaveTerminal={() => termRef.current?.blurInput?.()}
              onReturnToTerminal={() => { focusTerminal(); }}
            />
          )} />
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
    </OverlayProvider>
    </AgentCatalogProvider>
  );
}
