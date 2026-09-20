// The shared Hook-event layer. Claude Code and CodeBuddy both drive Handmux through filesystem Hooks, and
// CodeBuddy's Hook protocol is Claude Code's: the same `src` argument convention, the same raw payload on
// stdin, and the same JSON latest-state file plus bounded durable spool written by the SHARED
// server/hooks/handmux-write.cjs. So the two things those providers genuinely have in common live here:
//
//   1. the lifecycle VOCABULARY every Hook-driven Inbox state is normalized into;
//   2. the on-disk RECORD FORMAT (state row, spool event, owning-process fingerprint).
//
// What stays per-Agent — and therefore does NOT live here — is which `src` string means what, which payload
// fields carry the message, and how a pane proves the Agent is still its foreground process. Those are
// product facts and belong with the provider (agents/claude.ts, codebuddyEvents.ts).
import fs from 'node:fs';
import type { InboxState } from '../agent-runtime/inboxTypes.js';
import type { ForegroundProcessIdentity } from '../agent-runtime/adapter.js';

// The normalized kind language. `working`/`permission`/`done`/`error` are canonical Inbox states;
// `compacting` is an activity that renders as working; `idle` is a reminder rather than a lifecycle;
// `end` closes the pane's projection. Everything a provider can express must land in this set.
export type AgentHookKind = 'done' | 'working' | 'permission' | 'compacting' | 'error' | 'end' | 'idle';
export interface AgentHookClassification { kind: AgentHookKind; msg?: string }

const EVENT_KINDS: ReadonlySet<AgentHookKind> = new Set([
  'done', 'working', 'permission', 'compacting', 'error', 'end', 'idle',
]);

// Validate an untrusted kind string against the shared vocabulary.
export function hookEventKind(value: unknown): AgentHookKind | null {
  return typeof value === 'string' && EVENT_KINDS.has(value as AgentHookKind)
    ? value as AgentHookKind : null;
}

// A normalized kind → the Inbox state the Core understands, or null when it carries no state at all
// (`end`/`idle`/unknown). Compacted work is still work; a permission gate is waiting on the user.
export function canonicalInboxState(kind: unknown): InboxState | null {
  if (kind === 'working' || kind === 'compacting') return 'working';
  if (kind === 'permission') return 'waiting';
  if (kind === 'done') return 'done';
  if (kind === 'error') return 'error';
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

// ---------------------------------------------------------------------------------------------
// On-disk format shared with server/hooks/handmux-write.cjs
// ---------------------------------------------------------------------------------------------

export const HOOK_EVENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

// The owning Agent process captured by the Hook shell (pid + platform start value + tty). It lets a reader
// reject an offline event after tmux has reused the pane for a different process generation.
export interface HookProcessFingerprint {
  pid: number;
  startedAt: number;
  tty: string;
}

export interface HookStateRow {
  ts: number;
  src: string;
  payload: Record<string, unknown>;
  agent?: string;
  sequence?: number;
  process?: HookProcessFingerprint;
}

export interface HookBridgeEvent {
  version: 1;
  type: 'event' | 'gap';
  agent?: string;
  eventId: string;
  sequence?: number;
  paneId: string;
  src?: string;
  sessionId?: string;
  sourceOccurredAt?: number;
  process?: HookProcessFingerprint;
  payload?: Record<string, unknown>;
}

export function parseHookProcessFingerprint(value: unknown): HookProcessFingerprint | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
    || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)
    || value.startedAt < 0 || !bounded(value.tty, 1024)) return null;
  return { pid: Number(value.pid), startedAt: value.startedAt, tty: value.tty };
}

export function normalizedTty(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('/dev/') ? value : `/dev/${value}`;
}

// An absent fingerprint is accepted: it is the additive field of a newer writer, and records produced by an
// older installed Hook must keep working.
export function matchesHookProcess(
  source: HookProcessFingerprint | undefined,
  current: ForegroundProcessIdentity,
): boolean {
  if (!source) return true;
  return source.pid === current.pid
    && source.startedAt === current.startedAt
    && normalizedTty(source.tty) === normalizedTty(current.tty);
}

// `acceptAgent` decides which provider's marking a row may carry: an absent `agent` is always legacy
// compatibility, and every explicit foreign marking must fail closed rather than borrow another Agent's state.
export function readHookStateRows(
  file: string,
  acceptAgent: (agent: unknown) => boolean,
): Map<string, HookStateRow> {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!isRecord(value)) return new Map();
    return new Map(Object.entries(value).flatMap(([paneId, raw]) => {
      const row = isRecord(raw) ? raw : null;
      const payload = isRecord(row?.payload) ? row.payload : null;
      if (!bounded(paneId, 256) || !row || !payload || !bounded(row.src, 64)
        || (row.agent !== undefined && !acceptAgent(row.agent))) return [];
      const ts = typeof row.ts === 'number' && Number.isFinite(row.ts) ? row.ts : 0;
      const sequence = Number.isSafeInteger(row.sequence) && Number(row.sequence) > 0
        ? Number(row.sequence) : undefined;
      const process = row.process === undefined ? undefined : parseHookProcessFingerprint(row.process);
      if (process === null) return [];
      return [[paneId, {
        ts,
        src: row.src,
        ...(typeof row.agent === 'string' ? { agent: row.agent } : {}),
        payload,
        ...(sequence === undefined ? {} : { sequence }),
        ...(process === undefined ? {} : { process }),
      } satisfies HookStateRow]];
    }));
  } catch { return new Map(); }
}

export function parseHookBridgeEvent(
  value: unknown,
  acceptAgent: (agent: unknown) => boolean,
): HookBridgeEvent | null {
  if (!isRecord(value) || value.version !== 1 || (value.type !== 'event' && value.type !== 'gap')
    || (value.agent !== undefined && !acceptAgent(value.agent))
    || !bounded(value.eventId, 256) || !HOOK_EVENT_ID_RE.test(value.eventId)
    || !bounded(value.paneId, 256)
    || (value.sequence !== undefined && (!Number.isSafeInteger(value.sequence) || Number(value.sequence) <= 0))
    || (value.src !== undefined && !bounded(value.src, 64))
    || (value.sessionId !== undefined && !bounded(value.sessionId, 1024))
    || (value.sourceOccurredAt !== undefined
      && (typeof value.sourceOccurredAt !== 'number' || !Number.isFinite(value.sourceOccurredAt)))
    || (value.process !== undefined && parseHookProcessFingerprint(value.process) === null)
    || (value.payload !== undefined && !isRecord(value.payload))) return null;
  return {
    ...value,
    ...(value.process === undefined ? {} : { process: parseHookProcessFingerprint(value.process)! }),
  } as unknown as HookBridgeEvent;
}

// The durable source sequence embedded in a spool event ID (`<agent>-hook-<n>`). The writer is shared, so
// this deliberately reads the suffix rather than pinning one Agent's prefix: the prefix is the writer's
// choice, not a contract this reader may tighten.
export function hookEventSequence(eventId: string): number | null {
  const match = /^[a-z][a-z0-9-]*-hook-([1-9]\d*)$/.exec(eventId);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

// Friendly Chinese for an API-error turn end. The payload shape for a StopFailure is not verified against
// every provider, so read the type defensively from several likely fields and always fall back to a bare
// 本轮出错 — a wrong field name degrades to the generic label, never throws.
const ERROR_LABEL: Record<string, string> = {
  rate_limit: '触发限流', overloaded: '服务过载', authentication_failed: '认证失败',
  oauth_org_not_allowed: '组织未授权', billing_error: '额度/账单问题', invalid_request: '请求无效',
  model_not_found: '模型不可用', server_error: '服务端错误', max_output_tokens: '输出超长', unknown: '未知错误',
};

export function hookErrorMessage(body: Record<string, unknown>): string {
  const error = isRecord(body.error) ? body.error : null;
  const type = typeof body.error_type === 'string' ? body.error_type
    : typeof body.reason === 'string' ? body.reason
      : typeof body.type === 'string' ? body.type
        : typeof body.error === 'string' ? body.error
          : typeof error?.type === 'string' ? error.type : '';
  const label = ERROR_LABEL[type];
  if (label) return label;
  const raw = typeof body.error === 'string' ? body.error
    : typeof body.message === 'string' ? body.message : '';
  return raw ? raw.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}
