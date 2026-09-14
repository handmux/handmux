// The drawer lists only the sessions this device has bound (stored locally) — not every live
// tmux session. Binding/validation happens in the BindSession modal; here we just show the
// pinned names, let the user open or unbind one, and open the bind modal. Below that, a collapsible
// "未接管会话" section surfaces coding-agent sessions running outside tmux (orphans) — tap 接管 to resume
// one into tmux (the takeover sheet, handled in App); see server/src/orphans.js.
import { useState } from 'react';
import { t } from '../i18n';
import { relTime } from '../inbox.js';
import WorkspaceRecoveryCard from './WorkspaceRecoveryCard.jsx';
import type { MouseEvent } from 'react';
import type { WorkspaceRecoveryPlan, WorkspaceRestoreOperation } from '../workspaceRecovery.js';

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
  bound: string[];
  onSelectSession: (name: string) => void;
  onUnbind: (name: string) => void;
  onBind: () => void;
  onClose: () => void;
  onLogout: () => void;
  orphans?: DrawerOrphan[];
  onTakeoverRequest?: (orphan: DrawerOrphan) => void;
  recoveryPlan?: WorkspaceRecoveryPlan | null;
  recoveryOperation?: WorkspaceRestoreOperation | null;
  onOpenRecovery?: () => void;
  projectTaskBeta?: boolean;
  onSwitchProject?: () => void;
}

export default function Drawer({
  open, currentSessionName, bound, onSelectSession, onUnbind, onBind, onClose, onLogout,
  orphans = [], onTakeoverRequest,
  recoveryPlan = null, recoveryOperation = null, onOpenRecovery = () => {},
  projectTaskBeta = false, onSwitchProject = () => {},
}: DrawerProps) {
  const [orphOpen, setOrphOpen] = useState(false);
  return (
    <>
      <div className={`drawer ${open ? 'open' : ''}`}>
        <div className="drawer-list">
          {projectTaskBeta && (
            <div className="project-root-switch" role="group">
              <button type="button" aria-pressed="false" onClick={onSwitchProject}>{t('project.root.projects')}</button>
              <button type="button" aria-pressed="true">{t('project.root.sessions')}</button>
            </div>
          )}
          <div className="drawer-title">SESSIONS</div>
          {bound.length === 0 && <div className="drawer-empty">{t('drawer.empty')}</div>}
          {bound.map((name) => (
            <div
              key={name}
              className={`drawer-row drawer-session ${name === currentSessionName ? 'active' : ''}`}
            >
              <span className="drawer-name" onClick={() => onSelectSession(name)}>{name}</span>
              <button
                className="drawer-unbind"
                onClick={(event: MouseEvent<HTMLButtonElement>) => {
                  event.stopPropagation(); onUnbind(name);
                }}
                aria-label={t('drawer.unbind')}
                title={t('drawer.unbind')}
              >✕</button>
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
        </div>
        <button className="drawer-logout" onClick={onLogout}>{t('drawer.logout')}</button>
      </div>
      {open && <div className="drawer-backdrop" onClick={onClose} />}
    </>
  );
}
