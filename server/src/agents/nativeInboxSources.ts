import { createHash } from 'node:crypto';
import type { LivePane } from '../agent-runtime/adapter.js';
import type { InboxState } from '../agent-runtime/inboxTypes.js';
import type { NativeInboxRow, NativeInboxSource } from './nativeInbox.js';

type LegacyKind = 'working' | 'compacting' | 'permission' | 'done' | 'idle' | 'error' | 'end' | null;

interface NativeState {
  kind?: LegacyKind;
  msg?: string;
  ts?: number;
  agent?: string;
  threadId?: string | null;
  correlationId?: string;
  unavailable?: boolean;
}

interface CodexInboxSource {
  inboxStates(panes: Array<{
    id: string; cmd: string; tty: string; session: string; window: string; windowName: string;
  }>): Promise<Record<string, NativeState>>;
}

interface ClaudeInboxSource {
  getStates?(): Promise<Record<string, NativeState & { agent?: string }>>;
  paneSession(paneId: string): { sessionId: string | null } | null;
}

const MAX_INBOX_MESSAGE_LENGTH = 4_096;

function inboxMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= MAX_INBOX_MESSAGE_LENGTH) return value;
  let end = MAX_INBOX_MESSAGE_LENGTH;
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
  return value.slice(0, end);
}

function canonical(kind: LegacyKind | undefined): InboxState | null | 'ignore' {
  if (kind === 'working' || kind === 'compacting') return 'working';
  if (kind === 'permission') return 'waiting';
  if (kind === 'done') return 'done';
  if (kind === 'error') return 'error';
  if (kind === 'idle') return 'ignore';
  return null;
}

function stableId(agentId: string, paneId: string, sessionId: string | undefined, state: NativeState): string {
  return `${agentId}:${createHash('sha256').update(JSON.stringify({
    paneId, sessionId, kind: state.kind, msg: state.msg ?? '', ts: state.ts ?? 0,
  })).digest('hex')}`;
}

function row(agentId: string, paneId: string, sessionId: string | undefined, value: NativeState): NativeInboxRow | null {
  const state = canonical(value.kind);
  if (state === 'ignore') return null;
  const message = inboxMessage(value.msg);
  const normalized = { ...value, ...(message === undefined ? { msg: '' } : { msg: message }) };
  const identity = stableId(agentId, paneId, sessionId, normalized);
  const terminal = state === 'waiting' || state === 'done' || state === 'error';
  return {
    paneId,
    ...(sessionId === undefined ? {} : { sessionId }),
    cursor: identity,
    state,
    ...(message === undefined ? {} : { message }),
    ...(value.correlationId && value.correlationId.length <= 256
      ? { correlationId: value.correlationId } : {}),
    ...(terminal ? { eventId: identity } : {}),
    ...(typeof value.ts === 'number' && Number.isFinite(value.ts)
      ? { sourceOccurredAt: value.ts } : {}),
  };
}

export function createCodexNativeInboxSource(app: CodexInboxSource): NativeInboxSource {
  const lastRows = new Map<string, NativeInboxRow>();
  return {
    async read(panes: readonly LivePane[]) {
      const sourcePanes = panes.map((pane) => ({
        id: pane.paneId,
        cmd: pane.currentCommand,
        tty: pane.tty ?? '',
        session: pane.sessionName,
        window: pane.windowId,
        windowName: pane.windowName,
      }));
      const states = await app.inboxStates(sourcePanes);
      let degraded = false;
      const rows = Object.entries(states).flatMap(([paneId, value]) => {
        if (value.unavailable) degraded = true;
        const sessionId = typeof value.threadId === 'string' && value.threadId
          ? value.threadId : undefined;
        const cached = lastRows.get(paneId);
        const projected = value.unavailable && value.kind == null && cached
          ? cached
          : value.kind === 'idle'
          ? (cached?.sessionId === sessionId ? cached : undefined)
            ?? row('codex', paneId, sessionId, { ...value, kind: null })
          : row('codex', paneId, sessionId, value);
        if (projected) lastRows.set(paneId, projected);
        return projected ? [projected] : [];
      });
      const present = new Set(Object.keys(states));
      for (const paneId of lastRows.keys()) if (!present.has(paneId)) lastRows.delete(paneId);
      return {
        availability: degraded ? 'degraded' as const : 'ready' as const,
        rows,
        ...(degraded ? { message: 'Codex App Server is reconnecting' } : {}),
      };
    },
  };
}

export function createClaudeNativeInboxSource(events: ClaudeInboxSource): NativeInboxSource {
  return {
    async read() {
      const states = await events.getStates?.() ?? {};
      const rows = Object.entries(states).flatMap(([paneId, value]) => {
        if (value.agent !== 'claude') return [];
        const sessionId = events.paneSession(paneId)?.sessionId || undefined;
        const projected = row('claude', paneId, sessionId, {
          ...value,
          // `idle` is a reminder, not a separate Runtime lifecycle. Preserve the verified Claude run
          // as a neutral row instead of revoking and recreating it on the next hook edge.
          kind: value.kind === 'idle' ? null : value.kind ?? null,
        });
        return projected ? [projected] : [];
      });
      return { availability: 'ready' as const, rows };
    },
  };
}
