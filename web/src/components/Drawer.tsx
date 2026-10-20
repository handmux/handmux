// The drawer lists only the sessions this device has bound (stored locally) — not every live
// tmux session. Binding/validation happens in the BindSession modal; here we just show the
// pinned names, let the user open or unbind one, and open the bind modal. Below that, a collapsible
// "未接管会话" section surfaces coding-agent sessions running outside tmux (orphans) — tap 接管 to resume
// one into tmux (the takeover sheet, handled in App); see server/src/orphans.js.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { t } from '../i18n';
import { claimTouchGesture } from '../touchGestureClaim.js';
import { relTime, VIEW_LABEL } from '../inbox.js';
import type { InboxView } from '../inbox.js';
import WorkspaceRecoveryCard from './WorkspaceRecoveryCard.jsx';
import { getPanes, getSessions, getSessionTopology } from '../api.js';
import { getLastPane } from '../storage.js';
import type { TmuxPane, TmuxSession, TmuxWindow } from '../api.js';
import type { MouseEvent } from 'react';
import type { WorkspaceRecoveryPlan, WorkspaceRestoreOperation } from '../workspaceRecovery.js';
import ActionSheet from './ActionSheet.jsx';
import { OverlayPortal } from '../overlays/OverlayHost.js';
import { AgentMark, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, CommandIcon, GearIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, RefreshIcon, XIcon } from './icons.jsx';

const EXPANDED_SESSIONS_KEY = 'handmux.drawer.expanded-sessions';
const EMPTY_WINDOW_AGENTS: Readonly<Record<string, string | null | undefined>> = {};
const EMPTY_SESSION_INBOX: Readonly<Record<string, InboxView | null | undefined>> = {};
const EMPTY_PANES: readonly TmuxPane[] = [];
const CIRCLED_PANES = '①②③④⑤⑥⑦⑧⑨';
const paneSeq = (index: number): string => CIRCLED_PANES[index] ?? String(index + 1);
const paneShape = (pane: TmuxPane): string => [
  pane.id, pane.index, pane.active, pane.command,
  pane.left, pane.top, pane.width, pane.height,
].map((value) => String(value ?? '')).join('\0');
const INBOX_VIEW_RANK: Record<InboxView, number> = { working: 1, done: 2, needs: 3, error: 4 };

function nonDefaultPaneInboxView(
  panes: readonly TmuxPane[],
  defaultPaneId: string | null | undefined,
  paneInboxViews: Readonly<Record<string, InboxView | null | undefined>>,
): InboxView | null {
  let best: InboxView | null = null;
  for (const pane of panes) {
    if (pane.id === defaultPaneId) continue;
    const view = paneInboxViews[pane.id];
    if (view && (!best || INBOX_VIEW_RANK[view] > INBOX_VIEW_RANK[best])) best = view;
  }
  return best;
}

function hasHorizontalScrollAhead(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  for (let element: Element | null = target; element; element = element.parentElement) {
    const style = window.getComputedStyle(element);
    const horizontalOverflow = style.overflowX === 'auto' || style.overflowX === 'scroll';
    // scrollLeft is fractional on mobile. Even a subpixel remainder belongs to this scroller;
    // Drawer must not seize the next return gesture before it has actually reached zero.
    if (horizontalOverflow && element.scrollWidth > element.clientWidth + 1 && element.scrollLeft > 0) return true;
  }
  return false;
}

function startsInTabStrip(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    '.windowbar, .windowbar-scroll, .file-tabs, .file-tabs-scroll, .git-tabs, .git-tabs-scroll, .browser-tabs, .browser-tabs-scroll, [role="tablist"]',
  ));
}

function isOverlayTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    '[role="dialog"], .settings-backdrop, .file-sheet, .cmd-backdrop, .upload-overlay, .drawer-backdrop',
  ));
}

function isCopyGestureTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    '.chat-copy-active, .chat-copy-handle, .chat-copy-callout, .terminal-copy-active',
  ));
}

function hasActiveCopySurface(): boolean {
  return Boolean(document.querySelector('.chat-copy-active, .terminal-copy-active'));
}

function hasExpandedTextSelection(): boolean {
  const selection = window.getSelection?.();
  return !!selection && !selection.isCollapsed;
}

function readExpandedSessions(bound: string[]): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPANDED_SESSIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
      }
    }
  } catch { /* use the default below */ }
  return Object.fromEntries(bound.map((name) => [name, true]));
}

function WindowSkeleton() {
  return <div className="session-window-skeleton" role="status" aria-label={t('common.loading')} aria-busy="true">
    {[0, 1].map((row) => <div className="session-window-skeleton-row" key={row} aria-hidden="true"><i /><i /></div>)}
  </div>;
}

export interface DrawerOrphan {
  pid: number;
  cwd: string;
  cwdLabel?: string;
  sessionId?: string | null;
  state?: string;
  snippet?: string;
  agentLabel?: string;
  startedAt?: number | null;
  lastActivity?: number | null;
}

interface DrawerProps {
  open: boolean;
  onOpen?: () => void;
  currentSessionName?: string | null;
  currentWindowId?: string | null;
  currentPaneId?: string | null;
  currentPanes?: readonly TmuxPane[];
  bound: string[];
  onSelectSession: (selection: DrawerSelection) => void;
  onUnbind: (name: string) => void;
  onBind: () => void;
  onClose: () => void;
  orphans?: DrawerOrphan[];
  onTakeoverRequest?: (orphan: DrawerOrphan) => void;
  recoveryPlan?: WorkspaceRecoveryPlan | null;
  recoveryOperation?: WorkspaceRestoreOperation | null;
  onOpenRecovery?: () => void;
  projectTaskBeta?: boolean;
  onSwitchProject?: () => void;
  onSwitchSession?: () => void;
  onOpenSettings?: () => void;
  reloadRequired?: boolean;
  onReloadApp?: () => void;
  onNewWindow?: (sessionName: string) => void;
  onManageWindow?: (sessionName: string, window: TmuxWindow, sessionId?: string, windows?: TmuxWindow[]) => void;
  onRenameSession?: (sessionName: string) => void;
  onDeleteSession?: (sessionName: string) => void;
  onMoveSession?: (sessionName: string, direction: 'up' | 'down') => void;
  windowOrderVersion?: number;
  revealRevision?: number;
  boundRevealRevision?: number;
  rootView?: 'session' | 'project';
  sessionInboxViews?: Readonly<Record<string, InboxView | null | undefined>>;
  paneInboxViews?: Readonly<Record<string, InboxView | null | undefined>>;
  windowAgents?: Readonly<Record<string, string | null | undefined>>;
}

/**
 * The drawer already fetched this topology before it rendered the row. Pass it
 * through on selection so App can move the visible workspace immediately and
 * only fetch the pane details that are not part of the drawer outline.
 */
export interface DrawerSelection {
  session: TmuxSession;
  windows: TmuxWindow[];
  window: TmuxWindow;
  /** Optional pane target supplied by Inbox deep-links. Drawer rows do not need this. */
  paneId?: string | null;
  /** Structural pane data already included in the Drawer topology snapshot. */
  panes?: TmuxPane[];
  /** True when panes came from the identity-enriched /panes route. */
  panesAreEnriched?: boolean;
}

export default function Drawer({
  open, onOpen = () => {}, currentSessionName, currentWindowId = null, currentPaneId = null, currentPanes = EMPTY_PANES, bound, onSelectSession, onUnbind, onBind, onClose,
  orphans = [], onTakeoverRequest,
  recoveryPlan = null, recoveryOperation = null, onOpenRecovery = () => {},
  projectTaskBeta = false, onSwitchProject = () => {}, onSwitchSession = () => {}, onOpenSettings = () => {}, reloadRequired = false, onReloadApp = () => window.location.reload(), onNewWindow = () => {}, onManageWindow = () => {}, onRenameSession = () => {}, onDeleteSession = () => {}, onMoveSession = () => {}, windowOrderVersion = 0, rootView = 'session',
  revealRevision = 0, boundRevealRevision = 0, sessionInboxViews = EMPTY_SESSION_INBOX,
  windowAgents = EMPTY_WINDOW_AGENTS, paneInboxViews = EMPTY_SESSION_INBOX,
}: DrawerProps) {
  const [orphOpen, setOrphOpen] = useState(false);
  const [sessionWindows, setSessionWindows] = useState<Record<string, TmuxWindow[]>>({});
  const [windowPanes, setWindowPanes] = useState<Record<string, TmuxPane[]>>({});
  const paneDetailsLoadedRef = useRef(new Set<string>());
  const [openPaneWindow, setOpenPaneWindow] = useState<string | null>(null);
  const [paneLoadingWindow, setPaneLoadingWindow] = useState<string | null>(null);
  const [paneErrorWindow, setPaneErrorWindow] = useState<string | null>(null);
  const paneTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const paneMenuRef = useRef<HTMLDivElement | null>(null);
  const [paneMenuPosition, setPaneMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [topologyError, setTopologyError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const topologyInFlightRef = useRef(new Map<string, Promise<TmuxWindow[]>>());
  const topologyCache = useRef<{
    ids: Record<string, string>; sessionsAt: number;
    windows: Record<string, TmuxWindow[]>; fetchedAt: Record<string, number>; orderVersion: number;
  }>({ ids: {}, sessionsAt: 0, windows: {}, fetchedAt: {}, orderVersion: -1 });
  const [expandedPreferences, setExpandedPreferences] = useState<Record<string, boolean>>(() => readExpandedSessions(bound));
  const expandedSessions = new Set(bound.filter((name) => expandedPreferences[name] !== false));
  const [pendingWindow, setPendingWindow] = useState<{ sessionName: string; windowId: string } | null>(null);
  const [menuSession, setMenuSession] = useState<string | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerScrollRef = useRef<HTMLDivElement>(null);
  const drawerScrollContentRef = useRef<HTMLDivElement>(null);
  const drawerRevealKeyRef = useRef<string | null>(null);
  const boundRevealKeyRef = useRef<number | null>(null);
  const swipeRef = useRef<{ startX: number | null; startY: number; active: boolean; baseOpen: boolean; touchId: number | null }>({ startX: null, startY: 0, active: false, baseOpen: open, touchId: null });
  const swipeOffsetRef = useRef(0);
  const [swipeOffset, setSwipeOffset] = useState<number | null>(null);

  useEffect(() => {
    const cancelSwipe = (): void => {
      swipeRef.current.startX = null;
      swipeRef.current.touchId = null;
      swipeRef.current.active = false;
      swipeOffsetRef.current = 0;
      setSwipeOffset(null);
    };
    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;
      const target = event.target;
      if (isCopyGestureTarget(target) || hasActiveCopySurface() || hasExpandedTextSelection()) {
        cancelSwipe();
        return;
      }
      const insideDrawer = target instanceof Node && drawerRef.current?.contains(target) === true;
      const onDrawerBackdrop = target instanceof Element && Boolean(target.closest('.drawer-backdrop'));
      const startsInChatDock = target instanceof Element
        && Boolean(target.closest('.bottom-dock[data-dock-mode="agent"]'));
      const startsInConversationQuickReplies = target instanceof Element
        && Boolean(target.closest('.agent-conversation-composer .cc-quick .quick-scroll'));
      if (!open && startsInTabStrip(target)) return;
      // Chat controls keep their horizontal gestures even at the left edge. The rest of the Agent
      // conversation page can still reveal the drawer.
      if (!open && (startsInChatDock || startsInConversationQuickReplies)) return;
      // Closing starts inside the drawer so a swipe on the backdrop remains its normal tap-to-dismiss
      // interaction. Opening is available across the normal page, unless a horizontal scroller still
      // has content to reveal on its left side.
      if ((!open && isOverlayTarget(target)) || (open && isOverlayTarget(target) && !insideDrawer && !onDrawerBackdrop)
        || (!open && hasHorizontalScrollAhead(target))) return;
      swipeOffsetRef.current = 0;
      swipeRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        active: false,
        baseOpen: open,
        touchId: touch.identifier,
      };
    };
    const onTouchMove = (event: TouchEvent): void => {
      const gesture = swipeRef.current;
      if (gesture.startX === null || event.touches.length !== 1) return;
      if (isCopyGestureTarget(event.target) || hasActiveCopySurface() || hasExpandedTextSelection()) {
        cancelSwipe();
        return;
      }
      const touch = Array.from(event.touches).find((candidate) => candidate.identifier === gesture.touchId);
      if (!touch) return;
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      if (!gesture.active) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { swipeRef.current.startX = null; return; }
        if (Math.abs(dx) < 12) return;
        if ((!gesture.baseOpen && dx < 0) || (gesture.baseOpen && dx > 0)) { swipeRef.current.startX = null; return; }
        gesture.active = true;
      }
      claimTouchGesture(event);
      const width = drawerRef.current?.getBoundingClientRect().width || 360;
      const offset = gesture.baseOpen ? Math.max(-width, Math.min(0, dx)) : Math.min(width, Math.max(0, dx));
      swipeOffsetRef.current = offset;
      setSwipeOffset(offset);
    };
    const onTouchEnd = (event: TouchEvent, cancelled = false): void => {
      const gesture = swipeRef.current;
      if (!gesture.active) { swipeRef.current.startX = null; swipeRef.current.touchId = null; return; }
      const changedTouches = event.changedTouches ? Array.from(event.changedTouches) : [];
      if (!cancelled && changedTouches.length > 0 && !changedTouches.some((touch) => touch.identifier === gesture.touchId)) return;
      const width = drawerRef.current?.getBoundingClientRect().width || 360;
      const offset = swipeOffsetRef.current;
      swipeOffsetRef.current = 0;
      setSwipeOffset(null);
      swipeRef.current.startX = null;
      swipeRef.current.touchId = null;
      if (cancelled) return;
      if (gesture.baseOpen && offset < -width * .28) onClose();
      else if (!gesture.baseOpen && offset > width * .22) onOpen();
    };
    const onTouchCancel = (event: TouchEvent): void => onTouchEnd(event, true);
    const onSelectionChange = (): void => {
      if (swipeRef.current.startX !== null && hasExpandedTextSelection()) cancelSwipe();
    };
    window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    window.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    window.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      window.removeEventListener('touchstart', onTouchStart, true);
      window.removeEventListener('touchmove', onTouchMove, true);
      window.removeEventListener('touchend', onTouchEnd, true);
      window.removeEventListener('touchcancel', onTouchCancel, true);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [open, onClose, onOpen]);

  // Browsers other than iOS do not expose Safari's rubber-band affordance. Keep the
  // native scroll path for regular movement, but add a small damped translation when
  // the list is pulled past either edge. This is deliberately local to the scroll
  // region so it cannot move the fixed header/footer or steal the drawer swipe.
  useEffect(() => {
    const scroll = drawerScrollRef.current;
    const content = drawerScrollContentRef.current;
    if (!scroll || !content) return;

    type Edge = 'top' | 'bottom';
    const MAX_OFFSET = 88;
    const RESISTANCE = 0.35;
    let edge: Edge | null = null;
    let touchId: number | null = null;
    let lastY = 0;
    let overscrollStartY = 0;
    let active = false;
    let rawOffset = 0;
    let visualOffset = 0;
    let wheelTimer: number | null = null;

    // Match the iOS rubber-band curve: the first pixels track the finger, then
    // the response gradually eases toward its limit instead of stopping at a
    // hard clamp halfway through a long pull.
    const rubberBand = (value: number): number => {
      const distance = Math.abs(value);
      return Math.sign(value) * MAX_OFFSET * (1 - Math.exp(-(distance * RESISTANCE) / MAX_OFFSET));
    };
    const clearWheelTimer = (): void => {
      if (wheelTimer !== null) window.clearTimeout(wheelTimer);
      wheelTimer = null;
    };
    const setOffset = (value: number): void => {
      rawOffset = value;
      visualOffset = rubberBand(value);
      content.style.transition = 'none';
      content.style.transform = `translate3d(0, ${visualOffset}px, 0)`;
    };
    const release = (): void => {
      clearWheelTimer();
      if (visualOffset !== 0) {
        content.style.transition = 'transform 220ms cubic-bezier(.22,.8,.25,1)';
        content.style.transform = 'translate3d(0, 0, 0)';
        visualOffset = 0;
      }
      rawOffset = 0;
      edge = null;
      touchId = null;
      active = false;
    };
    const cancel = (): void => {
      clearWheelTimer();
      content.style.transition = 'none';
      content.style.transform = 'translate3d(0, 0, 0)';
      rawOffset = 0;
      visualOffset = 0;
      edge = null;
      touchId = null;
      active = false;
    };
    const atTop = (): boolean => scroll.scrollTop <= 1;
    const atBottom = (): boolean => scroll.scrollTop >= Math.max(0, scroll.scrollHeight - scroll.clientHeight - 1);
    const findTouch = (event: TouchEvent): Touch | undefined => Array.from(event.touches).find((touch) => touch.identifier === touchId);

    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;
      cancel();
      touchId = touch.identifier;
      lastY = touch.clientY;
      overscrollStartY = touch.clientY;
      edge = atTop() ? 'top' : atBottom() ? 'bottom' : null;
    };
    const onTouchMove = (event: TouchEvent): void => {
      const touch = findTouch(event);
      if (!touch) return;
      const deltaY = touch.clientY - lastY;
      lastY = touch.clientY;

      // A gesture that began in the middle of the list can still reach an edge.
      // Start the visual feedback from the first movement that hits that edge.
      if (!edge) {
        if (atTop() && deltaY > 0) {
          edge = 'top';
          overscrollStartY = touch.clientY - deltaY;
        } else if (atBottom() && deltaY < 0) {
          edge = 'bottom';
          overscrollStartY = touch.clientY - deltaY;
        } else {
          return;
        }
      }

      const totalDelta = touch.clientY - overscrollStartY;
      const pullingTowardEdge = edge === 'top' ? totalDelta > 0 : totalDelta < 0;
      if (!pullingTowardEdge) {
        if (active) cancel();
        else edge = null;
        return;
      }
      if (!active) {
        // The browser may advance scrollTop by a fractional pixel before this
        // listener runs. The edge was captured at touchstart, so do not recheck
        // it here or the bottom pull can disappear on the first move.
        active = true;
      }
      event.preventDefault();
      setOffset(totalDelta * RESISTANCE);
    };
    const onTouchEnd = (event: TouchEvent): void => {
      if (touchId === null || !Array.from(event.changedTouches).some((touch) => touch.identifier === touchId)) return;
      release();
    };
    const onWheel = (event: WheelEvent): void => {
      if ((event.deltaY < 0 && !atTop()) || (event.deltaY > 0 && !atBottom()) || event.deltaY === 0) return;
      event.preventDefault();
      setOffset(rawOffset - event.deltaY);
      clearWheelTimer();
      wheelTimer = window.setTimeout(release, 110);
    };

    scroll.addEventListener('touchstart', onTouchStart, { passive: true });
    scroll.addEventListener('touchmove', onTouchMove, { passive: false });
    scroll.addEventListener('touchend', onTouchEnd, { passive: true });
    scroll.addEventListener('touchcancel', release, { passive: true });
    scroll.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      scroll.removeEventListener('touchstart', onTouchStart);
      scroll.removeEventListener('touchmove', onTouchMove);
      scroll.removeEventListener('touchend', onTouchEnd);
      scroll.removeEventListener('touchcancel', release);
      scroll.removeEventListener('wheel', onWheel);
      cancel();
    };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(EXPANDED_SESSIONS_KEY, JSON.stringify(expandedPreferences)); } catch { /* best effort */ }
  }, [expandedPreferences]);

  useEffect(() => {
    if (!pendingWindow) return undefined;
    const timer = window.setTimeout(() => setPendingWindow(null), 420);
    return () => window.clearTimeout(timer);
  }, [pendingWindow]);

  useEffect(() => {
    if (!currentWindowId || !currentPanes?.length) return;
    setWindowPanes((current) => ({ ...current, [currentWindowId]: [...currentPanes] }));
  }, [currentWindowId, currentPanes]);

  // The active workspace is authoritative even while the Drawer is closed. If navigation comes
  // from a WindowBar or Inbox row, make the target session expandable for the next open. It runs
  // when the active Session/Window changes, so a user can still collapse the current session by hand.
  useEffect(() => {
    if (rootView !== 'session' || !currentSessionName || expandedPreferences[currentSessionName] !== false) return;
    setExpandedPreferences((current) => current[currentSessionName] === false
      ? { ...current, [currentSessionName]: true }
      : current);
  }, [currentSessionName, currentWindowId, revealRevision, rootView]); // eslint-disable-line react-hooks/exhaustive-deps -- preference map is intentionally read at the event edge

  // Once the Drawer is visible and its outline is ready, bring the shared current Window into view.
  // The query uses data attributes rather than interpolating tmux ids into a CSS selector.
  useLayoutEffect(() => {
    if (!open || rootView !== 'session') {
      drawerRevealKeyRef.current = null;
      return;
    }
    if (!sessionsReady || !currentSessionName || !currentWindowId) return;
    const target = Array.from(drawerScrollRef.current?.querySelectorAll<HTMLElement>('[data-session-name][data-window-id]') || [])
      .find((node) => node.dataset.sessionName === currentSessionName && node.dataset.windowId === currentWindowId);
    const revealKey = `${revealRevision}\0${currentSessionName}\0${currentWindowId}`;
    if (target && drawerRevealKeyRef.current === revealKey) return;
    target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    if (target) drawerRevealKeyRef.current = revealKey;
  }, [open, rootView, sessionsReady, currentSessionName, currentWindowId, revealRevision, sessionWindows, expandedPreferences]);

  // A newly pinned session is appended to the list. Keep the drawer open and move to its end only
  // when that new row (or its loaded window list) falls outside the visible scroll region.
  useLayoutEffect(() => {
    if (!open || rootView !== 'session' || !sessionsReady || boundRevealRevision === 0) return;
    const latestName = bound[bound.length - 1];
    if (!latestName) return;
    const scroll = drawerScrollRef.current;
    const section = Array.from(scroll?.querySelectorAll<HTMLElement>('.session-section') || [])
      .find((node) => node.querySelector('.session-section-label')?.textContent === latestName);
    if (!scroll || !section) return;
    if (boundRevealKeyRef.current === boundRevealRevision) return;
    const rect = section.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const isVisible = rect.top >= scrollRect.top && rect.bottom <= scrollRect.bottom;
    if (!isVisible) scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' });
    boundRevealKeyRef.current = boundRevealRevision;
  }, [open, rootView, sessionsReady, boundRevealRevision, bound, sessionWindows[bound[bound.length - 1] || '']]);

  const boundKey = JSON.stringify(bound);
  const expandedKey = JSON.stringify([...expandedSessions]);
  const lastExpandedKeyRef = useRef<string | null>(null);
  const requestSessionWindows = (sessionIds: readonly string[]): Promise<TmuxWindow[][]> => {
    const uniqueIds = [...new Set(sessionIds)];
    const missingIds = uniqueIds.filter((id) => !topologyInFlightRef.current.has(id));
    if (missingIds.length) {
      const batch = getSessionTopology(missingIds);
      for (const id of missingIds) {
        const rowPromise = batch.then((rows) => rows.find((row) => row.session.id === id)?.windows || []);
        topologyInFlightRef.current.set(id, rowPromise);
        const clear = (): void => {
          if (topologyInFlightRef.current.get(id) === rowPromise) topologyInFlightRef.current.delete(id);
        };
        rowPromise.then(clear, clear);
      }
    }
    return Promise.all(uniqueIds.map((id) => topologyInFlightRef.current.get(id)!));
  };
  useEffect(() => {
    if (rootView !== 'session' || !open) return;
    let alive = true;
    setTopologyError(null);
    void (async () => {
      try {
        const cached = topologyCache.current;
        const names: string[] = JSON.parse(boundKey);
        const expanded: string[] = JSON.parse(expandedKey);
        const previousExpanded = lastExpandedKeyRef.current
          ? new Set<string>(JSON.parse(lastExpandedKeyRef.current) as string[])
          : null;
        const expansionChanged = previousExpanded !== null && lastExpandedKeyRef.current !== expandedKey;
        const newlyExpanded = new Set(expanded.filter((name) => !previousExpanded?.has(name)));
        lastExpandedKeyRef.current = expandedKey;
        const now = Date.now();
        const orderChanged = cached.orderVersion !== windowOrderVersion;
        const sessionsStale = !cached.sessionsAt || now - cached.sessionsAt >= 5000
          || names.some((name) => !cached.ids[name]) || orderChanged;
        let ids = cached.ids;
        let windows = Object.fromEntries(names.filter((name) => cached.ids[name] && cached.windows[name])
          .map((name) => [name, cached.windows[name]!]));
        let fetchedAt = Object.fromEntries(names.filter((name) => windows[name])
          .map((name) => [name, cached.fetchedAt[name]!]));
        if (sessionsStale) {
          const sessions = await getSessions();
          if (!alive) return;
          ids = Object.fromEntries(sessions.flatMap((session) => (
            names.includes(session.name) ? [[session.name, session.id] as const] : []
          )));
        }
        const targets = expanded.filter((name) => {
          if (!ids[name]) return false;
          const sessionIdentityChanged = ids[name] !== cached.ids[name];
          if (expansionChanged) {
            // Toggling one Session must not refresh another already-visible
            // Session. A newly opened Session is the only active target; an
            // absent cache is still fetched so an interrupted first load can
            // recover without requiring a second toggle.
            return newlyExpanded.has(name) || !windows[name] || sessionIdentityChanged;
          }
          return !windows[name] || now - (fetchedAt[name] || 0) >= 5000 || orderChanged || sessionIdentityChanged;
        });
        if (targets.length) {
          const requestedIds = targets.flatMap((name) => ids[name] ? [ids[name]!] : []);
          const windowRows = await requestSessionWindows(requestedIds);
          if (!alive) return;
          const fetchedNow = Date.now();
          windows = { ...windows };
          fetchedAt = { ...fetchedAt };
          targets.forEach((name, index) => {
            windows[name] = windowRows[index] || [];
            fetchedAt[name] = fetchedNow;
          });
          const paneSnapshots = windowRows.flatMap((rows) => rows).flatMap((window) => (
            window.paneList ? [{ id: window.id, panes: window.paneList }] : []
          ));
          setWindowPanes((current) => {
            let next = current;
            for (const snapshot of paneSnapshots) {
              // `/sessions/topology` reads windows and panes in parallel. During a split/close or
              // reconnect those two reads can describe different instants, so a paneList shorter
              // than the window's declared count is an incomplete snapshot. Keep the last complete
              // value visible until a coherent snapshot arrives; publishing the partial list here
              // would make a later tap briefly render a plain Window before App fetches the rest.
              const sourceWindow = windowRows.flatMap((rows) => rows).find((window) => window.id === snapshot.id);
              if (sourceWindow && snapshot.panes.length < sourceWindow.panes) continue;
              const previous = current[snapshot.id] || [];
              const previousById = new Map(previous.map((pane) => [pane.id, pane] as const));
              const merged = snapshot.panes.map((pane) => {
                const old = previousById.get(pane.id);
                return old && Object.hasOwn(old, 'agent') && old.agent !== undefined && !Object.hasOwn(pane, 'agent')
                  ? { ...pane, agent: old.agent } : pane;
              });
              const shapeChanged = previous.length !== merged.length
                || previous.some((pane, index) => paneShape(pane) !== paneShape(merged[index]!));
              const agentChanged = merged.some((pane) => {
                const old = previousById.get(pane.id);
                return Object.hasOwn(pane, 'agent') && old?.agent !== pane.agent;
              });
              if (!shapeChanged && !agentChanged) continue;
              if (next === current) next = { ...current };
              next[snapshot.id] = merged;
              // A topology change invalidates the enriched /panes snapshot;
              // the next picker open will refresh Agent metadata.
              paneDetailsLoadedRef.current.delete(snapshot.id);
            }
            return next;
          });
        }
        // Publish one complete outline. Never reveal parent rows while the initial
        // expanded children are still in flight; retain the previous outline on refresh.
        topologyCache.current = { ids, sessionsAt: sessionsStale ? Date.now() : cached.sessionsAt, windows, fetchedAt, orderVersion: windowOrderVersion };
        setSessionWindows(windows);
        setSessionsReady(true);
      } catch (error) {
        if (alive) setTopologyError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { alive = false; };
  }, [rootView, open, boundKey, expandedKey, retry, windowOrderVersion]);

  const toggleSession = (name: string): void => {
    setExpandedPreferences((current) => ({ ...current, [name]: !expandedSessions.has(name) }));
  };
  const paneRequestRef = useRef(0);
  const loadWindowPanes = (window: TmuxWindow): void => {
    const cached = windowPanes[window.id];
    // The topology snapshot intentionally omits Agent identity. Reopen the full
    // pane route only when the picker needs those enriched rows. An enriched row
    // may omit `agent` when identity is currently unknown, so track completion
    // separately instead of inspecting individual fields.
    if (cached && paneDetailsLoadedRef.current.has(window.id)) return;
    if (cached?.length && cached.every((pane) => Object.hasOwn(pane, 'agent'))) {
      paneDetailsLoadedRef.current.add(window.id);
      return;
    }
    setPaneErrorWindow(null);
    const request = ++paneRequestRef.current;
    setPaneLoadingWindow(window.id);
    void getPanes(window.id).then((panes) => {
      if (paneRequestRef.current !== request) return;
      setWindowPanes((current) => ({ ...current, [window.id]: panes }));
      paneDetailsLoadedRef.current.add(window.id);
      setPaneLoadingWindow(null);
    }).catch(() => {
      if (paneRequestRef.current !== request) return;
      setPaneLoadingWindow(null);
      setPaneErrorWindow(window.id);
    });
  };
  const togglePanePicker = (event: SyntheticEvent, window: TmuxWindow): void => {
    event.stopPropagation();
    if (window.panes <= 1) return;
    if (openPaneWindow === window.id) {
      paneRequestRef.current += 1;
      setOpenPaneWindow(null);
      setPaneLoadingWindow(null);
      setPaneErrorWindow(null);
      return;
    }
    setOpenPaneWindow(window.id);
    loadWindowPanes(window);
  };
  useLayoutEffect(() => {
    if (!openPaneWindow) {
      setPaneMenuPosition(null);
      return undefined;
    }
    const place = (): void => {
      const trigger = paneTriggerRefs.current[openPaneWindow];
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const menu = paneMenuRef.current;
      const width = menu?.offsetWidth || 220;
      const paneCount = windowPanes[openPaneWindow]?.length || 0;
      const height = menu?.offsetHeight || Math.min(360, 48 + paneCount * 44);
      const margin = 8;
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      let top = rect.bottom + 6;
      if (top + height + margin > window.innerHeight) {
        top = Math.max(margin, rect.top - height - 6);
      }
      setPaneMenuPosition((current) => (
        current && current.top === top && current.left === left ? current : { top, left }
      ));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [openPaneWindow, paneErrorWindow, paneLoadingWindow, paneMenuPosition?.left, paneMenuPosition?.top, windowPanes]);

  useEffect(() => {
    if (!openPaneWindow) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      const trigger = paneTriggerRefs.current[openPaneWindow];
      if (target instanceof Node && (trigger?.contains(target) || paneMenuRef.current?.contains(target))) return;
      paneRequestRef.current += 1;
      setOpenPaneWindow(null);
      setPaneLoadingWindow(null);
      setPaneErrorWindow(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, [openPaneWindow]);

  useEffect(() => {
    if (open) return;
    paneRequestRef.current += 1;
    setOpenPaneWindow(null);
    setPaneLoadingWindow(null);
    setPaneErrorWindow(null);
  }, [open]);
  const drawerWidth = drawerRef.current?.getBoundingClientRect().width || 360;
  const backdropOpacity = swipeOffset === null
    ? (open ? 1 : 0)
    : (open ? 1 + swipeOffset / drawerWidth : swipeOffset / drawerWidth);
  const menuSessionIndex = menuSession ? bound.indexOf(menuSession) : -1;
  let paneMenuSessionName: string | null = null;
  let paneMenuWindow: TmuxWindow | null = null;
  if (openPaneWindow) {
    for (const [name, windows] of Object.entries(sessionWindows)) {
      const target = windows.find((window) => window.id === openPaneWindow);
      if (target) {
        paneMenuSessionName = name;
        paneMenuWindow = target;
        break;
      }
    }
  }
  return (
    <>
      <div id="session-drawer" ref={drawerRef} className={`drawer${rootView === 'project' ? ' project-drawer' : ''} ${open ? 'open' : ''}${swipeOffset !== null ? ' is-dragging' : ''}`} style={swipeOffset === null ? undefined : { transform: `translateX(calc(${open ? '0px' : '-100%'} + ${swipeOffset}px))` }} onContextMenu={(event) => event.preventDefault()}>
        <div className="drawer-list">
        <div className="drawer-fixed-header">
        <div className="drawer-brand">
          <img src="/icons/logo.svg" alt="" aria-hidden="true" />
            <strong className="drawer-brand-wordmark">hand<span>mux</span></strong>
            {reloadRequired && <button type="button" className="drawer-reload" onClick={onReloadApp}
              aria-label={t('app.serverUpdatedReload')} title={t('app.serverUpdatedReload')}>
              <RefreshIcon />
              <span className="drawer-reload-dot" aria-hidden="true" />
            </button>}
            <button type="button" className="drawer-settings" onClick={onOpenSettings} aria-label={t('app.settings')} title={t('app.settings')}><GearIcon /></button>
          </div>
          {projectTaskBeta && (
            <div className="project-root-switch" role="group" aria-label={`${t('project.root.projects')} / ${t('project.root.sessions')}`}>
              <button type="button" aria-pressed={rootView === 'project'} onClick={onSwitchProject}>{t('project.root.projects')}</button>
              <button type="button" aria-pressed={rootView === 'session'} onClick={onSwitchSession}>{t('project.root.sessions')}</button>
            </div>
          )}
          <div className="drawer-section-heading"><span>{t(rootView === 'project' ? 'project.root.title' : 'drawer.sessionWindowTitle')}</span>{rootView === 'session' && <small>{bound.length}</small>}</div>
        </div>
        <div ref={drawerScrollRef} className="drawer-scroll">
        <div ref={drawerScrollContentRef} className="drawer-scroll-content">
          {rootView === 'project' ? (
            <div className="drawer-project-coming-soon" role="status">
              <strong>{t('project.comingSoon')}</strong>
              <span>{t('project.comingSoonHint')}</span>
            </div>
          ) : <>
          {!sessionsReady && !topologyError && bound.length > 0 && (
            <div className="session-sections session-sections-skeleton" role="status" aria-label={t('common.loading')} aria-busy="true">
              {bound.slice(0, 6).map((name) => <div className="session-section-skeleton" key={name} aria-hidden="true">
                <div className="session-section-skeleton-row"><i /><i /></div>
                {expandedSessions.has(name) && <WindowSkeleton />}
              </div>)}
            </div>
          )}
          {topologyError && <div className="workspace-load-error" role="alert">
            <span>{topologyError}</span><button type="button" onClick={() => { topologyCache.current.sessionsAt = 0; setRetry((value) => value + 1); }}>{t('common.retry')}</button>
          </div>}
          {bound.length === 0 && <div className="drawer-empty">{t('drawer.empty')}</div>}
          {sessionsReady && <div className="session-sections" role="tree" aria-label={t('drawer.sessionWindowTitle')}>
          {bound.map((name) => (
            <section key={name} className={`session-section${name === currentSessionName ? ' is-current' : ''}`}>
              <div className={`session-section-header${expandedSessions.has(name) ? ' is-open' : ''}`} role="treeitem" aria-expanded={expandedSessions.has(name)} onClick={() => toggleSession(name)}>
                  <button type="button" aria-expanded={expandedSessions.has(name)} aria-current={name === currentSessionName ? 'page' : undefined} className="session-section-title">
                  <span className="session-section-icon"><CommandIcon />{sessionInboxViews[name] && <span
                    className={`session-inbox-dot ${sessionInboxViews[name]}`}
                    role="img"
                    aria-label={VIEW_LABEL[sessionInboxViews[name] as InboxView]}
                  />}</span><span className="session-section-label">{name}</span>
                </button>
                <button
                type="button"
                  className={`session-section-toggle${expandedSessions.has(name) ? ' is-open' : ''}`}
                  aria-expanded={expandedSessions.has(name)}
                  aria-label={`${name} — ${t(expandedSessions.has(name) ? 'doc.tocCollapse' : 'doc.tocExpand')}`}
                ><ChevronDownIcon /></button>
              <button
                type="button"
                className="session-section-new"
                onClick={(event: MouseEvent<HTMLButtonElement>) => {
                  event.stopPropagation(); onNewWindow(name);
                }}
                aria-label={`${name} ${t('windowbar.newWindow')}`}
                title={t('windowbar.newWindow')}
              ><PlusIcon /></button>
              <button
                type="button"
                className="session-section-menu"
                onClick={(event: MouseEvent<HTMLButtonElement>) => {
                  event.stopPropagation(); setMenuSession(name);
                }}
                aria-label={`${name} ${t('common.more')}`}
                title={t('common.more')}
              ><MoreHorizontalIcon /></button>
              </div>
              <div className={`session-section-body${expandedSessions.has(name) ? ' is-open' : ''}`} aria-hidden={!expandedSessions.has(name)}>
                <div className="session-window-list">
                  {expandedSessions.has(name) && topologyCache.current.ids[name] && !sessionWindows[name] && !topologyError && <WindowSkeleton />}
                  {(sessionWindows[name] || []).map((window) => {
                    const windowIsCurrent = name === currentSessionName && window.id === currentWindowId;
                    const windowIsPending = pendingWindow?.sessionName === name && pendingWindow.windowId === window.id;
                    const panePickerOpen = openPaneWindow === window.id;
                    const panes = windowPanes[window.id] || [];
                    const rememberedPaneId = getLastPane(window.id);
                    const paneTargetId = windowIsCurrent ? currentPaneId
                      : (rememberedPaneId && panes.some((pane) => pane.id === rememberedPaneId)
                        ? rememberedPaneId : window.activePaneId);
                    const paneIndex = Math.max(0, panes.findIndex((pane) => pane.id === paneTargetId));
                    const paneValue = paneSeq(paneIndex);
                    const selectedPaneInboxView = paneTargetId ? paneInboxViews[paneTargetId] : null;
                    const paneInboxView = window.panes > 1
                      ? nonDefaultPaneInboxView(panes, paneTargetId, paneInboxViews) : null;
                    return (
                      <div key={window.id} className="session-window-entry">
                        <div
                          data-session-name={name}
                          data-window-id={window.id}
                          role="button"
                          aria-current={windowIsCurrent || windowIsPending ? 'page' : undefined}
                          tabIndex={expandedSessions.has(name) ? 0 : -1}
                          className={`session-window-row ${windowIsCurrent || windowIsPending ? 'is-current' : ''}`}
                          onClick={() => {
                            const sessionId = topologyCache.current.ids[name];
                            const windows = sessionWindows[name] || [];
                            if (!sessionId) return;
                            setPendingWindow({ sessionName: name, windowId: window.id });
                            onSelectSession({ session: { id: sessionId, name }, windows, window,
                              ...(paneTargetId ? { paneId: paneTargetId } : {}),
                              ...(panes.length ? { panes } : {}) });
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              const sessionId = topologyCache.current.ids[name];
                              const windows = sessionWindows[name] || [];
                              if (!sessionId) return;
                              setPendingWindow({ sessionName: name, windowId: window.id });
                              onSelectSession({ session: { id: sessionId, name }, windows, window,
                                ...(paneTargetId ? { paneId: paneTargetId } : {}),
                                ...(panes.length ? { panes } : {}) });
                            }
                          }}
                        >
                          {selectedPaneInboxView && <span
                            className={`session-window-inbox-dot ${selectedPaneInboxView}`}
                            role="img"
                            aria-label={VIEW_LABEL[selectedPaneInboxView]}
                          />}
                          {windowAgents[window.id] && <AgentMark agent={windowAgents[window.id] ?? null} />}
                          <span className="session-window-label">{window.name || window.id}</span>
                          <span className="session-window-actions">
                            {window.panes > 1 && <button
                              type="button"
                              className={`session-window-pane-trigger${panePickerOpen ? ' is-open' : ''}`}
                              ref={(element) => { paneTriggerRefs.current[window.id] = element; }}
                              aria-expanded={panePickerOpen}
                              aria-label={`${window.name || window.id} ${t('drawer.paneSwitcher')}`}
                              onClick={(event) => togglePanePicker(event, window)}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              {paneInboxView && <span
                                className={`session-window-pane-inbox-dot ${paneInboxView}`}
                                role="img"
                                aria-label={VIEW_LABEL[paneInboxView]}
                              />}
                              <span className="session-window-pane-value">{paneValue || paneSeq(0)}</span><ChevronDownIcon />
                            </button>}
                            <button type="button" className="session-window-menu" aria-label={`${window.name || window.id} ${t('common.more')}`} onClick={(event) => {
                              event.stopPropagation();
                              onManageWindow(name, window, topologyCache.current.ids[name], sessionWindows[name] || []);
                            }}><MoreHorizontalIcon /></button>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          ))}
          </div>}
          {orphans.length > 0 && (
            <div className="drawer-orphans">
              <button className="drawer-orphans-head" onClick={() => setOrphOpen((o) => !o)}>
                <span>{t('drawer.orphans.title', { n: orphans.length })}</span>
                <span className="drawer-orphans-caret" aria-hidden="true">{orphOpen ? '▾' : '▸'}</span>
              </button>
              {orphOpen && (
                <>
                  <div className="drawer-orphans-hint">{t('drawer.orphans.hint')}</div>
                  {orphans.map((o) => {
                    const noSession = !o.sessionId;
                    const disabled = o.state === 'busy' || noSession;
                    return (
                      <div key={o.pid} className="drawer-orphan-row">
                        <div className="drawer-orphan-head">
                          <span className="drawer-orphan-cwd" title={o.cwd}>{o.cwdLabel || o.cwd}</span>
                          <button
                            className="drawer-orphan-btn"
                            disabled={disabled}
                            title={noSession ? t('inbox.orphans.noSession') : undefined}
                            onClick={() => onTakeoverRequest?.(o)}
                          >
                            {t('inbox.orphans.takeover')}
                          </button>
                        </div>
                        <div className="drawer-orphan-meta">
                          {o.agentLabel && <span className="drawer-orphan-agent">{o.agentLabel}</span>}
                          <span className={`drawer-orphan-state ${o.state === 'busy' ? 'busy' : 'idle'}`}>
                            {o.state === 'busy' ? t('inbox.orphans.busy') : t('inbox.orphans.idle')}
                          </span>
                          <span className="drawer-orphan-time">{relTime(o.startedAt || o.lastActivity || 0, Date.now())}</span>
                          {o.snippet && <span className="drawer-orphan-msg">{o.snippet}</span>}
                        </div>
                      </div>
                    );
                  })}
                </>
          )}
          </div>
          )}
          {recoveryPlan && (
            <WorkspaceRecoveryCard plan={recoveryPlan} operation={recoveryOperation} onOpen={onOpenRecovery} />
          )}
          </>}
        </div>
        </div>
        </div>
        {rootView === 'session' && <div className="drawer-footer drawer-bind-footer">
          <button type="button" className="drawer-bind" onClick={onBind}>
            <PlusIcon />
            <span>{t('drawer.bind')}</span>
            <ChevronRightIcon />
          </button>
        </div>}
      </div>
      {paneMenuWindow && paneMenuPosition && paneMenuSessionName && <OverlayPortal>
        <div
          ref={paneMenuRef}
          className="dd-menu wt-menu drawer-pane-menu"
          role="listbox"
          aria-label={`${paneMenuWindow.name || paneMenuWindow.id} panes`}
          style={{ top: paneMenuPosition.top, left: paneMenuPosition.left }}
        >
          {paneLoadingWindow === paneMenuWindow.id && !(windowPanes[paneMenuWindow.id] || []).length && (
            <div className="drawer-pane-menu-loading" aria-hidden="true"><i /><i /></div>
          )}
          {paneErrorWindow === paneMenuWindow.id && <div className="drawer-pane-menu-error" role="alert">
            <span>{t('api.loadFailed')}</span>
            <button type="button" onClick={(event) => { event.stopPropagation(); loadWindowPanes(paneMenuWindow!); }}>{t('common.retry')}</button>
          </div>}
          {paneLoadingWindow !== paneMenuWindow.id && paneErrorWindow !== paneMenuWindow.id
            && !(windowPanes[paneMenuWindow.id] || []).length && <div className="drawer-pane-menu-empty">{t('drawer.panesEmpty')}</div>}
          {(windowPanes[paneMenuWindow.id] || []).map((pane, index) => {
            const paneIsCurrent = paneMenuSessionName === currentSessionName
              && paneMenuWindow!.id === currentWindowId && pane.id === currentPaneId;
            const paneView = paneInboxViews[pane.id];
            return <button
              type="button"
              role="option"
              aria-selected={paneIsCurrent}
              className={`dd-option${paneIsCurrent ? ' is-selected' : ''}`}
              key={pane.id}
              onClick={(event) => {
                event.stopPropagation();
                const sessionId = topologyCache.current.ids[paneMenuSessionName!];
                const windows = sessionWindows[paneMenuSessionName!] || [];
                if (!sessionId) return;
                setPendingWindow({ sessionName: paneMenuSessionName!, windowId: paneMenuWindow!.id });
                setOpenPaneWindow(null);
                onSelectSession({ session: { id: sessionId, name: paneMenuSessionName! }, windows, window: paneMenuWindow!, paneId: pane.id,
                  panes: windowPanes[paneMenuWindow!.id] || [], panesAreEnriched: true });
              }}
            >
              <span className="dd-option-label">
                <span className="dd-pane-seq" aria-hidden="true">{paneSeq(index)}</span>
                {pane.agent && <AgentMark agent={pane.agent} />}
                <span className="dd-pane-cmd">{pane.command || pane.id}{paneView && <span className={`pane-menu-inbox-dot ${paneView}`} role="img" aria-label={VIEW_LABEL[paneView]} />}</span>
              </span>
              {paneIsCurrent && <span className="dd-check" aria-hidden="true">✓</span>}
            </button>;
          })}
        </div>
      </OverlayPortal>}
      <div
        className={`drawer-backdrop${open ? ' open' : ''}${swipeOffset !== null ? ' is-dragging' : ''}`}
        style={swipeOffset === null ? undefined : { opacity: Math.max(0, Math.min(1, backdropOpacity)) }}
        onClick={open ? onClose : undefined}
        aria-hidden="true"
      />
      <ActionSheet
        open={!!menuSession}
        title={t('app.manageSession')}
        subtitle={menuSession
          ? [menuSession, topologyCache.current.ids[menuSession]].filter(Boolean).join(' · ')
          : ''}
        onClose={() => setMenuSession(null)}
        actions={menuSession ? [
          ...(bound.length > 1 ? [[
            {
              key: 'move-session-up', icon: <ArrowUpIcon />, label: t('app.moveLeft'),
              disabled: menuSessionIndex <= 0,
              onClick: () => onMoveSession(menuSession, 'up'),
            },
            {
              key: 'move-session-down', icon: <span className="drawer-order-icon-down"><ArrowUpIcon /></span>, label: t('app.moveRight'),
              disabled: menuSessionIndex < 0 || menuSessionIndex >= bound.length - 1,
              onClick: () => onMoveSession(menuSession, 'down'),
            },
          ]] : []),
          { key: 'rename', icon: <PencilIcon />, label: t('common.rename'), onClick: () => { onRenameSession(menuSession); setMenuSession(null); } },
          { key: 'unbind', icon: <XIcon />, label: t('drawer.unbind'), onClick: () => { onUnbind(menuSession); setMenuSession(null); } },
          { key: 'delete', icon: <XIcon />, label: t('app.deleteSession'), danger: true, confirm: true, confirmLabel: t('app.deleteSessionConfirm'), onClick: () => { onDeleteSession(menuSession); setMenuSession(null); } },
        ] : []}
      />
    </>
  );
}
