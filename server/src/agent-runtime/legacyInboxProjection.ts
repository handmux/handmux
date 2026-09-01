import type { LivePane } from './adapter.js';
import type { InboxRecord, InboxServiceSnapshot, InboxState } from './inboxTypes.js';
import type { AgentRunRef } from './run.js';

export interface LegacyPaneAgentState {
  session?: string;
  window?: string;
  windowName?: string;
  kind: 'working' | 'permission' | 'done' | 'error' | null;
  msg: string;
  ts?: number;
  agent: string;
  terminalUnread?: boolean;
  terminalNotificationId?: string;
}

const LEGACY_KIND: Readonly<Record<InboxState, Exclude<LegacyPaneAgentState['kind'], null>>> = {
  working: 'working',
  waiting: 'permission',
  done: 'done',
  error: 'error',
};

const LEGACY_MESSAGE: Readonly<Record<InboxState, string>> = {
  working: '进行中',
  waiting: '需要你',
  done: '已完成',
  error: '出错',
};

function sameRun(record: InboxRecord, run: AgentRunRef): boolean {
  return record.run.agentId === run.agentId
    && record.run.paneId === run.paneId
    && record.run.runId === run.runId
    && record.run.sessionId === run.sessionId;
}

function sameTerminalEvent(
  candidate: InboxServiceSnapshot['terminalNotifications'][number],
  run: AgentRunRef,
  eventId: string,
): boolean {
  if (candidate.agentId !== run.agentId || candidate.eventId !== eventId) return false;
  if (candidate.sessionId !== undefined && run.sessionId !== undefined) {
    return candidate.sessionId === run.sessionId;
  }
  return candidate.runId === run.runId && candidate.paneId === run.paneId;
}

// Temporary compatibility projection for the existing phone roster. Runtime/Inbox remain the only
// identity and state authorities; tmux contributes presentation location only.
export function projectLegacyInboxStates({
  snapshot,
  runs,
  panes,
  allowedSessions,
}: {
  snapshot: InboxServiceSnapshot;
  runs: readonly AgentRunRef[];
  panes: readonly LivePane[];
  allowedSessions: readonly string[] | null;
}): Record<string, LegacyPaneAgentState> {
  const allowed = allowedSessions === null ? null : new Set(allowedSessions);
  const paneById = new Map(panes.map((pane) => [pane.paneId, pane]));
  const recordByRun = new Map(snapshot.records.map((record) => [record.run.runId, record]));
  const out: Record<string, LegacyPaneAgentState> = {};
  for (const run of runs) {
    const pane = paneById.get(run.paneId);
    if (allowed && (!pane || !allowed.has(pane.sessionName))) continue;
    const record = recordByRun.get(run.runId);
    const current = record && sameRun(record, run) ? record : undefined;
    const terminal = current && (current.state === 'done' || current.state === 'error');
    const notifications = terminal && current.eventId
      ? snapshot.terminalNotifications.filter((candidate) => (
        sameTerminalEvent(candidate, run, current.eventId!)
      )) : [];
    // One event may have legacy duplicates from Server restarts. Any read copy makes the durable event
    // read; otherwise keep one canonical notification id so a click marks every duplicate together.
    const notification = notifications.find((candidate) => candidate.readAt !== undefined)
      ?? notifications[0];
    const displayTime = terminal
      ? current?.sourceOccurredAt ?? current?.acceptedAt
      : current?.acceptedAt;
    out[run.paneId] = {
      ...(pane === undefined ? {} : {
        session: pane.sessionName,
        window: pane.windowId,
        windowName: pane.windowName,
      }),
      kind: current ? LEGACY_KIND[current.state] : null,
      // `reason` is a machine-readable state code. Adapters may use it for recovery/diagnostics,
      // but the user-facing roster must never render values such as `agent_end_idle` verbatim.
      msg: current?.message ?? (current ? LEGACY_MESSAGE[current.state] : ''),
      ...(displayTime === undefined ? {} : { ts: displayTime }),
      agent: run.agentId,
      ...(terminal ? {
        terminalUnread: notifications.length > 0
          && notifications.every((candidate) => candidate.readAt === undefined),
      } : {}),
      ...(notification === undefined ? {} : { terminalNotificationId: notification.id }),
    };
  }
  return out;
}
