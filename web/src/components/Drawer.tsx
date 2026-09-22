// The drawer lists only the sessions this device has bound (stored locally) — not every live
// tmux session. Binding/validation happens in the BindSession modal; here we just show the
// pinned names, let the user open or unbind one, and open the bind modal. Below that, a collapsible
// "未接管会话" section surfaces coding-agent sessions running outside tmux (orphans) — tap 接管 to resume
// one into tmux (the takeover sheet, handled in App); see server/src/orphans.js.
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { relTime } from '../inbox.js';
import WorkspaceRecoveryCard from './WorkspaceRecoveryCard.jsx';
import { listProjects } from '../projectTask/api.js';
import type { Project } from '../projectTask/contracts.js';
import { getSessions, getWindows } from '../api.js';
import type { TmuxWindow } from '../api.js';
import type { MouseEvent } from 'react';
import type { WorkspaceRecoveryPlan, WorkspaceRestoreOperation } from '../workspaceRecovery.js';
import { FolderIcon, GaugeIcon, GearIcon, MonitorIcon } from './icons.jsx';

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
  onOpenUsage?: () => void;
  onOpenSettings?: () => void;
  rootView?: 'session' | 'project';
  currentProjectId?: string | null;
  onSelectProject?: (id: string) => void;
}

export default function Drawer({
  open, currentSessionName, currentWindowId = null, bound, onSelectSession, onUnbind, onBind, onClose,
  orphans = [], onTakeoverRequest,
  recoveryPlan = null, recoveryOperation = null, onOpenRecovery = () => {},
  projectTaskBeta = false, onSwitchProject = () => {}, onSwitchSession = () => {}, onOpenUsage = () => {}, onOpenSettings = () => {}, rootView = 'session', currentProjectId = null,
  onSelectProject = () => {},
}: DrawerProps) {
  const [orphOpen, setOrphOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [sessionWindows, setSessionWindows] = useState<Record<string, TmuxWindow[]>>({});
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (currentSessionName) {
      setExpandedSessions((current) => current.has(currentSessionName)
        ? current : new Set(current).add(currentSessionName));
    }
  }, [currentSessionName]);

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
    setExpandedSessions((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
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
      <div id="session-drawer" className={`drawer${rootView === 'project' ? ' project-drawer' : ''} ${open ? 'open' : ''}`}>
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
              <button key={project.id} type="button" className={`drawer-row drawer-name${project.id === currentProjectId ? ' active' : ''}`}
                onClick={() => { onSelectProject(project.id); onClose(); }}>{project.name}</button>
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
                <button type="button" className="drawer-name" onClick={() => onSelectSession(name)}>{name}</button>
              <button
                className="drawer-unbind"
                onClick={(event: MouseEvent<HTMLButtonElement>) => {
                  event.stopPropagation(); onUnbind(name);
                }}
                aria-label={t('drawer.unbind')}
                title={t('drawer.unbind')}
              >✕</button>
              </div>
              {expandedSessions.has(name) && (sessionWindows[name] || []).map((window) => (
                <button
                  key={window.id}
                  type="button"
                  className={`drawer-window ${name === currentSessionName && window.id === currentWindowId ? 'active' : ''}`}
                  onClick={() => onSelectSession(name, window.id)}
                >{window.name || window.id}</button>
              ))}
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
          <button type="button" onClick={onOpenUsage}><GaugeIcon /><span>{t('usage.title')}</span></button>
          <button type="button" onClick={onOpenSettings}><GearIcon /><span>{t('app.settings')}</span></button>
        </div>
      </div>
      {open && <div className="drawer-backdrop" onClick={onClose} />}
    </>
  );
}
