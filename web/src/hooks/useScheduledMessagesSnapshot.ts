import { useCallback, useEffect, useRef, useState } from 'react';
import { scheduledRequest } from '../scheduledMessagesApi.js';
import type { ScheduledSnapshot } from '../scheduledMessagesApi.js';
import { t } from '../i18n';

export interface ScheduledMessagesSnapshotController {
  snapshot: ScheduledSnapshot | null;
  error: string;
  refresh(): Promise<void>;
}

/** One owner in the composer feeds both the shortcut and its sheet, including while the sheet is closed. */
export function useScheduledMessagesSnapshot(scope: string, enabled = true): ScheduledMessagesSnapshotController {
  const [state, setState] = useState<{ scope: string; snapshot: ScheduledSnapshot | null; error: string }>({
    scope, snapshot: null, error: '',
  });
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!enabled || !scope) { refreshRef.current = async () => {}; return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let pending: Promise<void> | null = null;
    setState({ scope, snapshot: null, error: '' });
    const read = (): Promise<void> => {
      if (pending) return pending;
      const operation = (async () => {
        try {
          const snapshot = await scheduledRequest<ScheduledSnapshot>(scope, null, 'snapshot');
          if (!Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.exceptions)
            || !Number.isFinite(snapshot.serverNow) || typeof snapshot.timeZone !== 'string') {
            throw new Error(t('scheduled.loadFailed'));
          }
          if (active) setState({ scope, snapshot, error: '' });
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
  }, [scope, enabled]);
  const refresh = useCallback(async () => { await refreshRef.current(); }, []);
  return {
    snapshot: enabled && state.scope === scope ? state.snapshot : null,
    error: enabled && state.scope === scope ? state.error : '',
    refresh,
  };
}
