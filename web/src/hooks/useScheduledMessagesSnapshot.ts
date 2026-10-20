import { useCallback, useEffect, useRef, useState } from 'react';
import { scheduledRequest } from '../scheduledMessagesApi.js';
import type { ScheduledSnapshot, ScheduledScope } from '../scheduledMessagesApi.js';
import { t } from '../i18n';

export interface ScheduledMessagesSnapshotController {
  snapshot: ScheduledSnapshot | null;
  error: string;
  refresh(): Promise<void>;
}

/** One owner in the composer feeds both the shortcut and its sheet, including while the sheet is closed. */
export function useScheduledMessagesSnapshot(scope: ScheduledScope, enabled = true): ScheduledMessagesSnapshotController {
  const { tmuxSession, paneId } = scope;
  const scopeKey = JSON.stringify([tmuxSession, paneId]);
  const [state, setState] = useState<{ scopeKey: string; snapshot: ScheduledSnapshot | null; error: string }>({
    scopeKey, snapshot: null, error: '',
  });
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!enabled || !tmuxSession || !paneId) { refreshRef.current = async () => {}; return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let pending: Promise<void> | null = null;
    setState({ scopeKey, snapshot: null, error: '' });
    const read = (): Promise<void> => {
      if (pending) return pending;
      const operation = (async () => {
        try {
          const snapshot = await scheduledRequest<ScheduledSnapshot>({ tmuxSession, paneId }, null, 'snapshot');
          if (!Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.exceptions)
            || !Number.isFinite(snapshot.serverNow) || typeof snapshot.timeZone !== 'string') {
            throw new Error(t('scheduled.loadFailed'));
          }
          if (active) setState({ scopeKey, snapshot, error: '' });
        } catch (cause) {
          if (active) setState((current) => ({ ...current, error: cause instanceof Error ? cause.message : t('scheduled.loadFailed') }));
          throw cause;
        }
      })();
      pending = operation;
      void operation.finally(() => { if (pending === operation) pending = null; }).catch(() => {});
      return operation;
    };
    // A mutation refresh must read after an older in-flight poll, rather than reuse its stale response.
    refreshRef.current = async () => {
      await pending?.catch(() => {});
      if (active) await read();
    };
    const poll = async () => {
      try { await read(); } catch { /* the sheet can display the error; shortcut colors only reflect task data */ }
      if (active) timer = setTimeout(() => { void poll(); }, 3000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); refreshRef.current = async () => {}; };
  }, [tmuxSession, paneId, enabled]);
  const refresh = useCallback(async () => { await refreshRef.current(); }, []);
  return {
    snapshot: enabled && state.scopeKey === scopeKey ? state.snapshot : null,
    error: enabled && state.scopeKey === scopeKey ? state.error : '',
    refresh,
  };
}
