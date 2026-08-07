import { useCallback, useEffect, useState } from 'react';
import { getCodexSession } from '../api.js';
import { usePollingLoop } from './usePollingLoop.js';

const EMPTY = {
  loaded: false, managed: false, threadId: null, status: null, activeTurnId: null, settings: null,
  approvals: [], userInputs: [], queue: [], error: null,
};

export function useCodexSession(pane, enabled, refreshToken = null, softRefreshToken = null) {
  const [session, setSession] = useState(EMPTY);
  useEffect(() => { setSession(EMPTY); }, [pane, enabled, refreshToken]);
  const fetch = useCallback(() => getCodexSession(pane), [pane]);
  const apply = useCallback((result) => {
    if (!result) return;
    setSession({
      ...EMPTY, ...result, loaded: true, error: null,
      approvals: result.approvals || [], userInputs: result.userInputs || [], queue: result.queue || [],
    });
  }, []);
  const fail = useCallback((error) => {
    setSession((current) => ({
      ...current,
      loaded: true,
      error: error?.message || 'Codex connection unavailable',
    }));
  }, []);
  usePollingLoop({
    fetch,
    apply,
    onError: fail,
    intervalMs: 750,
    enabled: enabled && !!pane,
    deps: [pane, refreshToken, softRefreshToken],
  });
  return session;
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
