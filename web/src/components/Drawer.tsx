// The drawer lists only the sessions this device has bound (stored locally) — not every live
// tmux session. Binding/validation happens in the BindSession modal; here we just show the
// pinned names, let the user open or unbind one, and open the bind modal. Below that, a collapsible
// "未接管会话" section surfaces coding-agent sessions running outside tmux (orphans) — tap 接管 to resume
// one into tmux (the takeover sheet, handled in App); see server/src/orphans.js.
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { relTime } from '../inbox.js';
import WorkspaceRecoveryCard from './WorkspaceRecoveryCard.jsx';
import { listProjects } from '../projectTask/api.js';
import type { Project } from '../projectTask/contracts.js';
import { getSessions, getWindowsForSessions } from '../api.js';
import type { TmuxSession, TmuxWindow } from '../api.js';
import type { MouseEvent } from 'react';
import type { WorkspaceRecoveryPlan, WorkspaceRestoreOperation } from '../workspaceRecovery.js';
import type { WorkspaceLens } from './LensSwitch.jsx';
import ActionSheet from './ActionSheet.jsx';
import { ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, CommandIcon, FolderIcon, GearIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, XIcon } from './icons.jsx';

const EXPANDED_SESSIONS_KEY = 'handmux.drawer.expanded-sessions';

function hasHorizontalScrollAhead(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  for (let element: Element | null = target; element; element = element.parentElement) {
    const style = window.getComputedStyle(element);
    const horizontalOverflow = style.overflowX === 'auto' || style.overflowX === 'scroll';
    if (horizontalOverflow && element.scrollWidth > element.clientWidth + 1 && element.scrollLeft > 1) return true;
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
  activeLens?: WorkspaceLens;
  onSwitchProject?: () => void;
  onSwitchSession?: () => void;
  onOpenSettings?: () => void;
  onNewWindow?: (sessionName: string) => void;
  onManageWindow?: (sessionName: string, window: TmuxWindow) => void;
  onRenameSession?: (sessionName: string) => void;
  onDeleteSession?: (sessionName: string) => void;
  onMoveSession?: (sessionName: string, direction: 'up' | 'down') => void;
  windowOrderVersion?: number;
  rootView?: 'session' | 'project';
  currentProjectId?: string | null;
  onSelectProject?: (id: string) => void;
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
}

export default function Drawer({
  open, onOpen = () => {}, currentSessionName, currentWindowId = null, bound, onSelectSession, onUnbind, onBind, onClose,
  orphans = [], onTakeoverRequest,
  recoveryPlan = null, recoveryOperation = null, onOpenRecovery = () => {},
  projectTaskBeta = false, activeLens = 'terminal', onSwitchProject = () => {}, onSwitchSession = () => {}, onOpenSettings = () => {}, onNewWindow = () => {}, onManageWindow = () => {}, onRenameSession = () => {}, onDeleteSession = () => {}, onMoveSession = () => {}, windowOrderVersion = 0, rootView = 'session', currentProjectId = null,
  onSelectProject = () => {},
}: DrawerProps) {
  const [orphOpen, setOrphOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [sessionWindows, setSessionWindows] = useState<Record<string, TmuxWindow[]>>({});
  const [sessionsReady, setSessionsReady] = useState(false);
  const [topologyError, setTopologyError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
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
  const swipeRef = useRef<{ startX: number | null; startY: number; active: boolean; baseOpen: boolean; touchId: number | null }>({ startX: null, startY: 0, active: false, baseOpen: open, touchId: null });
  const swipeOffsetRef = useRef(0);
  const [swipeOffset, setSwipeOffset] = useState<number | null>(null);

  useEffect(() => {
    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;
      const target = event.target;
      const insideDrawer = target instanceof Node && drawerRef.current?.contains(target) === true;
      const onDrawerBackdrop = target instanceof Element && Boolean(target.closest('.drawer-backdrop'));
      const startsInDock = target instanceof Element && Boolean(target.closest('.bottom-dock'));
      if (!open && startsInTabStrip(target)) return;
      // In chat mode the BottomDock owns its own horizontal pager. The conversation surface
      // remains eligible for opening the drawer; only a gesture that starts on the dock is reserved.
      if (!open && activeLens === 'chat' && startsInDock) return;
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
      event.preventDefault();
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
    window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    window.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    window.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });
    return () => {
      window.removeEventListener('touchstart', onTouchStart, true);
      window.removeEventListener('touchmove', onTouchMove, true);
      window.removeEventListener('touchend', onTouchEnd, true);
      window.removeEventListener('touchcancel', onTouchCancel, true);
    };
  }, [activeLens, open, onClose, onOpen]);

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

  const boundKey = JSON.stringify(bound);
  const expandedKey = JSON.stringify([...expandedSessions]);
  useEffect(() => {
    if (rootView !== 'session' || !open) return;
    let alive = true;
    setTopologyError(null);
    void (async () => {
      try {
        const cached = topologyCache.current;
        const names: string[] = JSON.parse(boundKey);
        const expanded: string[] = JSON.parse(expandedKey);
        const now = Date.now();
        const orderChanged = cached.orderVersion !== windowOrderVersion;
        const sessionsStale = !cached.sessionsAt || now - cached.sessionsAt >= 5000
          || names.some((name) => !cached.ids[name]) || orderChanged;
        const ids = sessionsStale
          ? Object.fromEntries((await getSessions()).map((session) => [session.name, session.id]))
          : cached.ids;
        if (!alive) return;
        // A session name may have been deleted and recreated with a different tmux ID.
        const windows = Object.fromEntries(names.filter((name) => ids[name] && ids[name] === cached.ids[name] && cached.windows[name])
          .map((name) => [name, cached.windows[name]!]));
        const fetchedAt = Object.fromEntries(names.filter((name) => windows[name]).map((name) => [name, cached.fetchedAt[name]!]));
        const targets = expanded.filter((name) => ids[name] && (!windows[name] || now - (fetchedAt[name] || 0) >= 5000 || orderChanged));
        if (targets.length) {
          const rows = await getWindowsForSessions(targets.map((name) => ids[name]!));
          if (!alive) return;
          for (const name of targets) {
            windows[name] = rows[ids[name]!] || [];
            fetchedAt[name] = Date.now();
          }
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
  useEffect(() => {
    if (rootView !== 'project') {
      setProjectsLoading(false);
      return;
    }
    let alive = true;
    setProjectsLoading(true);
    setProjectsError(null);
    void listProjects().then((rows) => { if (alive) setProjects(rows); })
      .catch((error: unknown) => { if (alive) setProjectsError(error instanceof Error ? error.message : 'Project list unavailable'); })
      .finally(() => { if (alive) setProjectsLoading(false); });
    return () => { alive = false; };
  }, [rootView]);
  const drawerWidth = drawerRef.current?.getBoundingClientRect().width || 360;
  const backdropOpacity = swipeOffset === null
    ? (open ? 1 : 0)
    : (open ? 1 + swipeOffset / drawerWidth : swipeOffset / drawerWidth);
  const menuSessionIndex = menuSession ? bound.indexOf(menuSession) : -1;
  return (
    <>
      <div id="session-drawer" ref={drawerRef} className={`drawer${rootView === 'project' ? ' project-drawer' : ''} ${open ? 'open' : ''}${swipeOffset !== null ? ' is-dragging' : ''}`} style={swipeOffset === null ? undefined : { transform: `translateX(calc(${open ? '0px' : '-100%'} + ${swipeOffset}px))` }} onContextMenu={(event) => event.preventDefault()}>
        <div className="drawer-list">
        <div className="drawer-fixed-header">
        <div className="drawer-brand">
          <img src="/icons/logo.svg" alt="" aria-hidden="true" />
            <strong className="drawer-brand-wordmark">hand<span>mux</span></strong>
            <button type="button" className="drawer-settings" onClick={onOpenSettings} aria-label={t('app.settings')} title={t('app.settings')}><GearIcon /></button>
          </div>
          {projectTaskBeta && (
            <div className="project-root-switch" role="group" aria-label={`${t('project.root.projects')} / ${t('project.root.sessions')}`}>
              <button type="button" aria-pressed={rootView === 'project'} onClick={onSwitchProject}>{t('project.root.projects')}</button>
              <button type="button" aria-pressed={rootView === 'session'} onClick={onSwitchSession}>{t('project.root.sessions')}</button>
            </div>
          )}
          <div className="drawer-section-heading"><span>{t(rootView === 'project' ? 'project.root.projects' : 'drawer.sessionWindowTitle')}</span><small>{rootView === 'project' ? projects.length : bound.length}</small></div>
        </div>
        <div ref={drawerScrollRef} className="drawer-scroll">
        <div ref={drawerScrollContentRef} className="drawer-scroll-content">
          {rootView === 'project' ? <>
            {projectsLoading && <div className="drawer-empty">{t('common.loading')}</div>}
            {!projectsLoading && projectsError && <div className="drawer-empty" role="alert">{projectsError}</div>}
            {!projectsLoading && !projectsError && projects.length === 0 && <div className="drawer-empty">{t('project.empty')}</div>}
            {projects.map((project) => (
              <button key={project.id} type="button" aria-current={project.id === currentProjectId ? 'page' : undefined} className={`drawer-project-row${project.id === currentProjectId ? ' active' : ''}`}
                onClick={() => { onSelectProject(project.id); }}>
                <FolderIcon /><span>{project.name}</span>{project.id === currentProjectId && <i aria-hidden="true" />}
              </button>
            ))}
          </> : <>
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
              <div className="session-section-header" role="treeitem" aria-expanded={expandedSessions.has(name)} onClick={() => toggleSession(name)}>
                <button type="button" aria-expanded={expandedSessions.has(name)} aria-current={name === currentSessionName ? 'page' : undefined} className="session-section-title">
                  <span className="session-section-icon"><CommandIcon /></span><span className="session-section-label">{name}</span>
                </button>
                <button
                  type="button"
                  className={`session-section-toggle${expandedSessions.has(name) ? ' is-open' : ''}`}
                  aria-expanded={expandedSessions.has(name)}
                  aria-label={`${name} — ${t(expandedSessions.has(name) ? 'doc.tocCollapse' : 'doc.tocExpand')}`}
                ><ChevronDownIcon /></button>
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
                  {(sessionWindows[name] || []).map((window) => (
                    <div
                      key={window.id}
                      role="button"
                      aria-current={(name === currentSessionName && window.id === currentWindowId)
                        || (pendingWindow?.sessionName === name && pendingWindow.windowId === window.id) ? 'page' : undefined}
                      tabIndex={expandedSessions.has(name) ? 0 : -1}
                      className={`session-window-row ${(name === currentSessionName && window.id === currentWindowId)
                        || (pendingWindow?.sessionName === name && pendingWindow.windowId === window.id) ? 'is-current' : ''}`}
                      onClick={() => {
                        const sessionId = topologyCache.current.ids[name];
                        const windows = sessionWindows[name] || [];
                        if (!sessionId) return;
                        setPendingWindow({ sessionName: name, windowId: window.id });
                        onSelectSession({ session: { id: sessionId, name }, windows, window });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          const sessionId = topologyCache.current.ids[name];
                          const windows = sessionWindows[name] || [];
                          if (!sessionId) return;
                          setPendingWindow({ sessionName: name, windowId: window.id });
                          onSelectSession({ session: { id: sessionId, name }, windows, window });
                        }
                      }}
                    ><span className="session-window-label">{window.name || window.id}</span><span className="session-window-count" aria-label={`${window.panes} panes`}>{window.panes}个窗格</span><button type="button" className="session-window-menu" aria-label={`${window.name || window.id} ${t('common.more')}`} onClick={(event) => { event.stopPropagation(); onManageWindow(name, window); }}><MoreHorizontalIcon /></button></div>
                  ))}
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
      <div
        className={`drawer-backdrop${open ? ' open' : ''}${swipeOffset !== null ? ' is-dragging' : ''}`}
        style={swipeOffset === null ? undefined : { opacity: Math.max(0, Math.min(1, backdropOpacity)) }}
        onClick={open ? onClose : undefined}
        aria-hidden="true"
      />
      <ActionSheet
        open={!!menuSession}
        title={menuSession || ''}
        onClose={() => setMenuSession(null)}
        actions={menuSession ? [
          { key: 'new-window', icon: <PlusIcon />, label: t('windowbar.newWindow'), onClick: () => { onNewWindow(menuSession); setMenuSession(null); } },
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
