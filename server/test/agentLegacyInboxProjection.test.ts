import { describe, expect, it } from 'vitest';
import { projectLegacyInboxStates } from '../src/agent-runtime/legacyInboxProjection.js';
import type { LivePane } from '../src/agent-runtime/adapter.js';
import type { InboxServiceSnapshot } from '../src/agent-runtime/inboxTypes.js';
import type { AgentRunRef } from '../src/agent-runtime/run.js';

const panes: LivePane[] = [
  {
    paneId: '%1', sessionName: 'alpha', windowId: '@1', windowName: 'Claude',
    currentCommand: 'claude', tty: '/dev/ttys001',
  },
  {
    paneId: '%2', sessionName: 'beta', windowId: '@2', windowName: 'Codex',
    currentCommand: 'codex', tty: '/dev/ttys002',
  },
];
const runs: AgentRunRef[] = [
  { agentId: 'claude', paneId: '%1', runId: 'claude-current', sessionId: 'claude-session' },
  { agentId: 'codex', paneId: '%2', runId: 'codex-current', sessionId: 'codex-thread' },
];

function snapshot(): InboxServiceSnapshot {
  return {
    serviceEpoch: 'epoch', revision: 3, availability: {}, terminalNotifications: [{
      id: 'codex-notification', agentId: 'codex', runId: 'codex-current',
      sessionId: 'codex-thread', paneId: '%2', eventId: 'codex-done', state: 'done',
      acceptedAt: 2_000, expiresAt: 100_000,
    }],
    records: [
      {
        run: runs[0]!, source: { sourceId: 'claude.hooks', cursor: '1' },
        state: 'waiting', message: 'Approve?', eventId: 'permission-1',
        inboxSequence: 1, acceptedAt: 1_000, receivedAt: 1_000,
      },
      {
        run: runs[1]!, source: { sourceId: 'codex.app-server', cursor: '2' },
        state: 'working', message: 'Building', inboxSequence: 1,
        sourceOccurredAt: 999_999, receivedAt: 2_000,
      },
      {
        run: { agentId: 'claude', paneId: '%1', runId: 'claude-old', sessionId: 'old-session' },
        source: { sourceId: 'claude.hooks', cursor: 'old' }, state: 'done',
        message: 'Old done', eventId: 'old-done', inboxSequence: 1,
        acceptedAt: 500, receivedAt: 500,
      },
    ],
  };
}

describe('legacy Agent Inbox projection', () => {
  it('joins current runs with tmux location and maps only Core state', () => {
    expect(projectLegacyInboxStates({
      snapshot: snapshot(), runs, panes, allowedSessions: null,
    })).toEqual({
      '%1': {
        session: 'alpha', window: '@1', windowName: 'Claude',
        kind: 'permission', msg: 'Approve?', ts: 1_000, agent: 'claude',
      },
      '%2': {
        session: 'beta', window: '@2', windowName: 'Codex',
        kind: 'working', msg: 'Building', agent: 'codex',
      },
    });
  });

  it('does not revive revoked runs or use provider time as unread time', () => {
    const value = projectLegacyInboxStates({
      snapshot: snapshot(), runs: [runs[0]!], panes, allowedSessions: null,
    });
    expect(value['%1']).toMatchObject({ kind: 'permission', ts: 1_000 });
    expect(JSON.stringify(value)).not.toContain('Old done');
    expect(JSON.stringify(value)).not.toContain('999999');
  });

  it('uses a user-facing state label instead of a provider reason when no message exists', () => {
    const base = snapshot();
    const records = base.records.map((record) => {
      if (record.run.runId !== 'codex-current') return record;
      const { message: _message, ...withoutMessage } = record;
      return {
        ...withoutMessage,
        state: 'error' as const,
        reason: 'agent_end_idle',
        eventId: 'codex-error',
        acceptedAt: 2_000,
      };
    });
    const value = projectLegacyInboxStates({
      snapshot: { ...base, records }, runs, panes, allowedSessions: null,
    });

    expect(value['%2']?.msg).toBe('出错');
    expect(JSON.stringify(value)).not.toContain('agent_end_idle');
  });

  it('filters by tmux session name and keeps a neutral current run', () => {
    expect(projectLegacyInboxStates({
      snapshot: { ...snapshot(), records: [] }, runs, panes, allowedSessions: ['beta'],
    })).toEqual({
      '%2': {
        session: 'beta', window: '@2', windowName: 'Codex',
        kind: null, msg: '', agent: 'codex',
      },
    });
    expect(projectLegacyInboxStates({
      snapshot: snapshot(), runs, panes: [], allowedSessions: [],
    })).toEqual({});
  });

  it('carries terminal time and read identity across a Server-restarted run of the same session', () => {
    const base = snapshot();
    const records = base.records.map((record) => record.run.runId === 'codex-current' ? {
      ...record, state: 'done' as const, eventId: 'codex-done', acceptedAt: 2_000,
      sourceOccurredAt: 1_500,
    } : record);
    const previousRun = base.terminalNotifications.map((notification) => ({
      ...notification, runId: 'codex-before-restart',
    }));
    expect(projectLegacyInboxStates({
      snapshot: { ...base, records, terminalNotifications: previousRun },
      runs, panes, allowedSessions: null,
    })['%2']).toMatchObject({
      kind: 'done', ts: 1_500,
      terminalUnread: true, terminalNotificationId: 'codex-notification',
    });

    const read = previousRun.map((notification) => ({ ...notification, readAt: 3_000 }));
    expect(projectLegacyInboxStates({
      snapshot: { ...base, records, terminalNotifications: read }, runs, panes, allowedSessions: null,
    })['%2']).toMatchObject({
      kind: 'done', terminalUnread: false, terminalNotificationId: 'codex-notification',
    });
    expect(projectLegacyInboxStates({
      snapshot: { ...base, records, terminalNotifications: [] }, runs, panes, allowedSessions: null,
    })['%2']).toMatchObject({ kind: 'done', terminalUnread: false });

    const otherSession = previousRun.map((notification) => ({
      ...notification, sessionId: 'another-thread',
    }));
    expect(projectLegacyInboxStates({
      snapshot: { ...base, records, terminalNotifications: otherSession },
      runs, panes, allowedSessions: null,
    })['%2']).toMatchObject({ kind: 'done', terminalUnread: false });
  });
});
