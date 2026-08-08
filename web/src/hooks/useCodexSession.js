import { useCallback, useEffect, useState } from 'react';
import { getCodexSession } from '../api.js';
import { usePollingLoop } from './usePollingLoop.js';

const EMPTY = {
  loaded: false, managed: false, threadId: null, status: null, activeTurnId: null, settings: null,
  contextUsage: null, approvals: [], userInputs: [], queue: [], error: null,
};

export function useCodexSession(pane, enabled, refreshToken = null) {
  const scope = enabled && pane ? pane : null;
  const [snapshot, setSnapshot] = useState(() => ({ scope, session: EMPTY }));
  useEffect(() => {
    setSnapshot((current) => (current.scope === scope ? current : { scope, session: EMPTY }));
  }, [scope]);
  const fetch = useCallback(() => getCodexSession(pane), [pane]);
  const apply = useCallback((result) => {
    if (!result) return;
    setSnapshot({
      scope,
      session: {
        ...EMPTY, ...result, loaded: true, error: null,
        approvals: result.approvals || [], userInputs: result.userInputs || [], queue: result.queue || [],
      },
    });
  }, [scope]);
  const fail = useCallback((error) => {
    setSnapshot((current) => ({
      scope,
      session: {
        ...(current.scope === scope ? current.session : EMPTY),
        loaded: true,
        error: error?.message || 'Codex connection unavailable',
      },
    }));
  }, [scope]);
  usePollingLoop({
    fetch,
    apply,
    onError: fail,
    intervalMs: 750,
    enabled: enabled && !!pane,
    deps: [pane, refreshToken],
  });
  return snapshot.scope === scope ? snapshot.session : EMPTY;
}

export function codexKind(session) {
  if (!session?.managed) return null;
  if (session.activityKind === 'compacting') return 'compacting';
  if (session.status?.type === 'active') {
    const waiting = session.status.activeFlags?.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput');
    return waiting ? 'permission' : 'working';
  }
  if (session.status?.type === 'systemError' || session.lastTurn?.status === 'failed') return 'error';
  return null;
}
