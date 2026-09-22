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
import { getSessions, getWindows } from '../api.js';
import type { TmuxWindow } from '../api.js';
import type { MouseEvent } from 'react';
import type { WorkspaceRecoveryPlan, WorkspaceRestoreOperation } from '../workspaceRecovery.js';
import ActionSheet from './ActionSheet.jsx';
import { FolderIcon, GearIcon, MonitorIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, XIcon } from './icons.jsx';

const EXPANDED_SESSIONS_KEY = 'handmux.drawer.expanded-sessions';

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
  onSelectSession: (name: string, windowId?: string) => void;
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
  onNewWindow?: (sessionName: string) => void;
  onRenameSession?: (sessionName: string) => void;
  onDeleteSession?: (sessionName: string) => void;
  rootView?: 'session' | 'project';
  currentProjectId?: string | null;
  onSelectProject?: (id: string) => void;
}

export default function Drawer({
  open, onOpen = () => {}, currentSessionName, currentWindowId = null, bound, onSelectSession, onUnbind, onBind, onClose,
  orphans = [], onTakeoverRequest,
  recoveryPlan = null, recoveryOperation = null, onOpenRecovery = () => {},
  projectTaskBeta = false, onSwitchProject = () => {}, onSwitchSession = () => {}, onOpenSettings = () => {}, onNewWindow = () => {}, onRenameSession = () => {}, onDeleteSession = () => {}, rootView = 'session', currentProjectId = null,
  onSelectProject = () => {},
}: DrawerProps) {
  const [orphOpen, setOrphOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [sessionWindows, setSessionWindows] = useState<Record<string, TmuxWindow[]>>({});
  const [expandedPreferences, setExpandedPreferences] = useState<Record<string, boolean>>(() => readExpandedSessions(bound));
  const expandedSessions = new Set(bound.filter((name) => expandedPreferences[name] !== false));
  const [menuSession, setMenuSession] = useState<string | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const swipeRef = useRef<{ startX: number | null; startY: number; active: boolean; baseOpen: boolean }>({ startX: null, startY: 0, active: false, baseOpen: open });
  const swipeOffsetRef = useRef(0);
  const [swipeOffset, setSwipeOffset] = useState<number | null>(null);

  useEffect(() => {
    const onTouchStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (!touch) return;
      const target = event.target;
      const insideDrawer = target instanceof Node && drawerRef.current?.contains(target) === true;
      // Opening starts at the viewport edge. Closing starts inside the drawer so a swipe on the
      // backdrop remains its normal tap-to-dismiss interaction.
      if (open ? !insideDrawer : touch.clientX > 28) return;
      swipeRef.current = { startX: touch.clientX, startY: touch.clientY, active: false, baseOpen: open };
    };
    const onTouchMove = (event: TouchEvent): void => {
      const touch = event.touches[0];
      const gesture = swipeRef.current;
      if (!touch || gesture.startX === null) return;
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
    const onTouchEnd = (): void => {
      const gesture = swipeRef.current;
      if (!gesture.active) { swipeRef.current.startX = null; return; }
      const width = drawerRef.current?.getBoundingClientRect().width || 360;
      const offset = swipeOffsetRef.current;
      swipeOffsetRef.current = 0;
      setSwipeOffset(null);
      swipeRef.current.startX = null;
      if (gesture.baseOpen && offset < -width * .28) onClose();
      else if (!gesture.baseOpen && offset > width * .22) onOpen();
    };
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [open, onClose, onOpen]);

  useEffect(() => {
    try { localStorage.setItem(EXPANDED_SESSIONS_KEY, JSON.stringify(expandedPreferences)); } catch { /* best effort */ }
  }, [expandedPreferences]);

  useEffect(() => {
    if (rootView !== 'session' || !open) return;
    let alive = true;
    // A new open/selection starts a fresh topology read; never carry a previous
    // window list across a refresh that may fail.
    setSessionWindows({});
    void (async () => {
      try {
        const sessions = await getSessions();
        const names = new Set(bound);
        const rows = await Promise.all(sessions
          .filter((session) => names.has(session.name))
          .map(async (session) => [session.name, await getWindows(session.id)] as const));
        if (!alive) return;
        setSessionWindows(Object.fromEntries(rows));
      } catch {
        // Keep the pinned Session names usable if a topology refresh is temporarily unavailable.
      }
    })();
    return () => { alive = false; };
  }, [rootView, open, bound]);

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
  return (
    <>
      <div id="session-drawer" ref={drawerRef} className={`drawer${rootView === 'project' ? ' project-drawer' : ''} ${open ? 'open' : ''}${swipeOffset !== null ? ' is-dragging' : ''}`} style={swipeOffset === null ? undefined : { transform: `translateX(calc(${open ? '0px' : '-100%'} + ${swipeOffset}px))` }}>
        <div className="drawer-list">
          <div className="drawer-brand">
            <img src="/icons/logo.svg" alt="" aria-hidden="true" />
            <div><strong>handmux</strong><span>{rootView === 'project' ? t('project.root.projects') : t('project.root.sessions')}</span></div>
          </div>
          {projectTaskBeta && (
            <div className="project-root-switch" role="group" aria-label={`${t('project.root.projects')} / ${t('project.root.sessions')}`}>
              <button type="button" aria-pressed={rootView === 'project'} onClick={onSwitchProject}>{t('project.root.projects')}</button>
              <button type="button" aria-pressed={rootView === 'session'} onClick={onSwitchSession}>{t('project.root.sessions')}</button>
            </div>
          )}
          {rootView === 'project' ? <>
            <div className="drawer-title"><FolderIcon />{t('project.root.projects')}</div>
            {projectsLoading && <div className="drawer-empty">{t('common.loading')}</div>}
            {!projectsLoading && projectsError && <div className="drawer-empty" role="alert">{projectsError}</div>}
            {!projectsLoading && !projectsError && projects.length === 0 && <div className="drawer-empty">{t('project.empty')}</div>}
            {projects.map((project) => (
              <button key={project.id} type="button" aria-current={project.id === currentProjectId ? 'page' : undefined} className={`drawer-project-row${project.id === currentProjectId ? ' active' : ''}`}
                onClick={() => { onSelectProject(project.id); onClose(); }}>
                <FolderIcon /><span>{project.name}</span>{project.id === currentProjectId && <i aria-hidden="true" />}
              </button>
            ))}
          </> : <>
          <div className="drawer-title"><MonitorIcon />{t('drawer.title')}</div>
          {bound.length === 0 && <div className="drawer-empty">{t('drawer.empty')}</div>}
          {bound.map((name) => (
            <div key={name} className="drawer-session-tree">
              <div className={`drawer-row drawer-session ${name === currentSessionName ? 'active' : ''}`}>
                <button
                  type="button"
                  className="drawer-tree-toggle"
                  aria-expanded={expandedSessions.has(name)}
                  aria-label={`${name} — ${t(expandedSessions.has(name) ? 'doc.tocCollapse' : 'doc.tocExpand')}`}
                  onClick={() => toggleSession(name)}
                >{expandedSessions.has(name) ? '⌄' : '›'}</button>
                <button type="button" aria-current={name === currentSessionName ? 'page' : undefined} className="drawer-name" onClick={() => toggleSession(name)}>
                  <MonitorIcon /><span>{name}</span>{name === currentSessionName && <i aria-hidden="true" />}
                </button>
              <button
                type="button"
                className="drawer-more"
                onClick={(event: MouseEvent<HTMLButtonElement>) => {
                  event.stopPropagation(); setMenuSession(name);
                }}
                aria-label={`${name} ${t('common.more')}`}
                title={t('common.more')}
              ><MoreHorizontalIcon /></button>
              </div>
              {expandedSessions.has(name) && (
                <div className="drawer-window-list">
                  {(sessionWindows[name] || []).map((window) => (
                    <button
                      key={window.id}
                      type="button"
                      aria-current={name === currentSessionName && window.id === currentWindowId ? 'page' : undefined}
                      className={`drawer-window ${name === currentSessionName && window.id === currentWindowId ? 'active' : ''}`}
                      onClick={() => onSelectSession(name, window.id)}
                    ><span className="drawer-window-mark" aria-hidden="true" />{window.name || window.id}{name === currentSessionName && window.id === currentWindowId && <i aria-hidden="true" />}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <button className="drawer-bind" onClick={onBind}>＋ {t('drawer.bind')}</button>

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
        <div className="drawer-footer">
          <button type="button" onClick={onOpenSettings}><GearIcon /><span>{t('app.settings')}</span></button>
        </div>
      </div>
      {open && <div className="drawer-backdrop" onClick={onClose} />}
      <ActionSheet
        open={!!menuSession}
        title={menuSession || ''}
        onClose={() => setMenuSession(null)}
        actions={menuSession ? [
          { key: 'new-window', icon: <PlusIcon />, label: t('windowbar.newWindow'), onClick: () => { onNewWindow(menuSession); setMenuSession(null); } },
          { key: 'rename', icon: <PencilIcon />, label: t('common.rename'), onClick: () => { onRenameSession(menuSession); setMenuSession(null); } },
          { key: 'unbind', icon: <XIcon />, label: t('drawer.unbind'), onClick: () => { onUnbind(menuSession); setMenuSession(null); } },
          { key: 'delete', icon: <XIcon />, label: t('app.deleteSession'), danger: true, confirm: true, confirmLabel: t('app.deleteSessionConfirm'), onClick: () => { onDeleteSession(menuSession); setMenuSession(null); } },
        ] : []}
      />
    </>
  );
}
