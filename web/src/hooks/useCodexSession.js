import { useCallback, useEffect, useState } from 'react';
import { getCodexSession } from '../api.js';
import { usePollingLoop } from './usePollingLoop.js';

const EMPTY = { loaded: false, managed: false, status: null, activeTurnId: null, settings: null, approvals: [], error: null };

export function useCodexSession(pane, enabled) {
  const [session, setSession] = useState(EMPTY);
  useEffect(() => { setSession(EMPTY); }, [pane, enabled]);
  const fetch = useCallback(() => getCodexSession(pane), [pane]);
  const apply = useCallback((result) => {
    if (!result) return;
    setSession({ ...EMPTY, ...result, loaded: true, error: null, approvals: result.approvals || [] });
  }, []);
  const fail = useCallback((error) => {
    setSession((current) => ({ ...current, loaded: true, error: error?.message || 'Codex connection unavailable' }));
  }, []);
  usePollingLoop({
    fetch,
    apply,
    onError: fail,
    intervalMs: 750,
    enabled: enabled && !!pane,
    deps: [pane],
  });
  return session;
}

export function codexKind(session, fallback = null) {
  if (!session?.managed) return fallback;
  if (session.activityKind === 'compacting') return 'compacting';
  if (session.status?.type === 'active') {
    const waiting = session.status.activeFlags?.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput');
    return waiting ? 'permission' : 'working';
  }
  if (session.status?.type === 'systemError' || session.lastTurn?.status === 'failed') return 'error';
  return null;
}
