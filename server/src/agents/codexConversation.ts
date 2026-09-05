import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { AgentRunLease, AgentRunRef, AgentSessionRef } from '../agent-runtime/run.js';
import type {
  AgentConversationAdapterV1,
  ConversationAdapterEvent,
  ConversationAdapterEventSink,
  ConversationAdapterPage,
  ConversationItem,
  ConversationItemDraft,
  ConversationDispatchReceipt,
  ConversationPromptRequest,
  ConversationSteerRequest,
  InterruptReceipt,
  JsonValue,
} from '../agent-runtime/conversationTypes.js';
import { transcriptReader } from '../transcriptReader.js';
import type { TranscriptReader } from '../transcriptReader.js';
import {
  createCodexTranscriptParser,
} from '../codexTranscriptParse.js';
import type { CodexTranscriptMessage } from '../codexTranscriptParse.js';
import { projectCodexConversationMutation } from '../codexConversationProjection.js';
import { parseCodexStreamEvent } from '../codexStreamProtocol.js';
import type { CodexStreamEvent } from '../codexStreamProtocol.js';
import { resolveCodexRollout, sessionsDir } from './codex.js';
import {
  clipConversationText,
  safeProviderDiffPath,
  sanitizeToolInputWithMetadata,
  sanitizeToolResultText,
} from './conversationProjectionSafety.js';

const DURABLE_QUIET_MS = 100;
const DEFAULT_DURABLE_SETTLE_TIMEOUT_MS = 15_000;
const MAX_OPENING_NATIVE_EVENTS = 4_096;
const MAX_SEEN_GOAL_LIFECYCLES = 2_048;
const MAX_DURABLE_CHECKPOINTS = 64;
const HISTORY_HASH_SEED = createHash('sha256').update('codex-conversation-v1').digest('hex');

interface CodexConversationApp {
  discover(paneId: string): Promise<{ managed?: boolean; threadId?: string | null } | null | undefined>;
  observeConversation(
    paneId: string,
    threadId: string,
    listener: (event: unknown) => void,
  ): Promise<{ cursor: number; close(): unknown }>;
  compactorItemKeys(paneId: string, threadId: string): Promise<string[]>;
  send(paneId: string, threadId: string, text: string, requestId?: string | null): Promise<unknown>;
  dispatchPrompt(paneId: string, threadId: string, text: string, requestId: string): Promise<unknown>;
  dispatchSteer(
    paneId: string,
    threadId: string,
    text: string,
    requestId: string,
    plan: ConversationSteerRequest['plan'],
  ): Promise<unknown>;
  interrupt(paneId: string, threadId: string): Promise<unknown>;
}

interface CodexConversationAdapterOptions {
  app: CodexConversationApp;
  sessionsRoot?: string;
  reader?: TranscriptReader;
  findRollout?: (root: string, sessionId: string) => Promise<string | null>;
  rolloutSize?: (file: string) => Promise<number | null>;
  durablePollMs?: number;
  durableSettleTimeoutMs?: number;
}

interface LiveProjection {
  sink: ConversationAdapterEventSink;
  sourceSequence: number;
  closed: boolean;
  provisional: Map<string, { draft: ConversationItemDraft; turnId: string | null }>;
  pendingDurableItems: Map<string, {
    item: ConversationItem;
    baselineMatches: number;
    settledAt: number;
    uncoveredAdvanceAt?: number;
    baselineTurnIds: Set<string>;
  }>;
  observedTurnIds: Set<string>;
  tail: Promise<void>;
  closeNative: (() => unknown) | undefined;
  durableToken: string | undefined;
  durableItems: ConversationItem[];
  durableCandidateToken: string | undefined;
  durableCandidateAt: number | undefined;
  pollTimer: ReturnType<typeof setTimeout> | undefined;
  pollDueAt: number | undefined;
  openingPagePending: boolean;
}

interface CodexDurableSnapshot {
  sessionId: string;
  sourceViewId: string;
  sourceHistoryToken: string;
  items: ConversationItem[];
}

interface CodexDurableCutoff {
  file: string | null;
  endExclusive: number;
}

interface CodexOpeningSnapshot {
  owner: LiveProjection;
  snapshot: CodexDurableSnapshot;
  release(): void;
}

interface CodexDurableCheckpoint {
  file: string | null;
  version?: string;
  readerGeneration?: number;
  suppressionKey: string;
  messageCount: number;
  itemOffsets: number[];
  historyHashes: string[];
  snapshot: CodexDurableSnapshot;
}

interface GoalIdentity {
  objective: string;
  status: string;
  event: string;
  createdAt: number | null;
}

function goalIdentity(item: ConversationItem): GoalIdentity | null {
  if (item.kind !== 'notice' || item.code !== 'goal_updated') return null;
  const goal = item.extensions?.['conversation.goal'];
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return null;
  const event = item.extensions?.['conversation.goalEvent'];
  const objective = typeof goal.objective === 'string' ? goal.objective : null;
  const status = typeof goal.status === 'string' ? goal.status : null;
  const createdAt = typeof goal.createdAt === 'number' && Number.isFinite(goal.createdAt)
    ? goal.createdAt : null;
  if (!objective || !status || typeof event !== 'string') return null;
  return { objective, status, event, createdAt };
}

function sameGoal(left: GoalIdentity, right: GoalIdentity): boolean {
  const lifecycle = (goal: GoalIdentity): string => (
    goal.status === 'active' && ['set', 'restarted', 'active'].includes(goal.event)
      ? 'active' : goal.event
  );
  return left.objective === right.objective && left.status === right.status
    && lifecycle(left) === lifecycle(right)
    // The injected durable Goal context does not carry App Server's createdAt. If both sides have it,
    // use it to distinguish a genuinely repeated Goal with the same objective and lifecycle.
    && (left.createdAt === null || right.createdAt === null || left.createdAt === right.createdAt);
}

function durableOwnsSettledItem(pending: ConversationItem, durable: ConversationItem): boolean {
  if (durable.id !== pending.id || durable.kind !== pending.kind) return false;
  if (pending.kind === 'message' && durable.kind === 'message') {
    return pending.role === durable.role
      && JSON.stringify(pending.content) === JSON.stringify(durable.content);
  }
  const pendingGoal = goalIdentity(pending);
  const durableGoal = goalIdentity(durable);
  if (pendingGoal || durableGoal) {
    return pendingGoal !== null && durableGoal !== null && sameGoal(pendingGoal, durableGoal);
  }
  return true;
}

function durableMatchCount(pending: ConversationItem, durableItems: readonly ConversationItem[]): number {
  // A Goal's immediate App Server card uses its lifecycle timestamp, while the injected rollout
  // context uses the source item identity. Match that one documented identity handoff semantically.
  const pendingGoal = goalIdentity(pending);
  if (pendingGoal) {
    return durableItems.filter((item) => {
      const durableGoal = goalIdentity(item);
      return durableGoal !== null && sameGoal(pendingGoal, durableGoal);
    }).length;
  }
  return durableItems.filter((item) => item.id === pending.id).length;
}

function waitsForNextTurn(item: ConversationItem): boolean {
  return goalIdentity(item)?.status === 'active';
}

function sameDurableItem(left: ConversationItem, right: ConversationItem): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function trustedCheckpointLength(
  checkpoint: CodexDurableCheckpoint | undefined,
  cutoff: CodexDurableCutoff,
  baseline: CodexDurableSnapshot,
): number | null {
  if (!checkpoint || checkpoint.file !== cutoff.file
    || checkpoint.snapshot.items.length > baseline.items.length) return null;
  return checkpoint.snapshot.items.every((item, index) => (
    sameDurableItem(item, baseline.items[index]!)
  )) ? checkpoint.snapshot.items.length : null;
}

function goalLifecycleKey(sessionId: string, messageId: string): string {
  return `${sessionId}\0${messageId}`;
}

function rememberGoalLifecycle(seen: Set<string>, sessionId: string, messageId: string): void {
  const key = goalLifecycleKey(sessionId, messageId);
  // Refresh insertion order so this bounded Set behaves like a small LRU. Reconnect repair only needs
  // recent lifecycle knowledge; evicting an old ID safely falls back to showing a possibly duplicate card.
  seen.delete(key);
  seen.add(key);
  if (seen.size <= MAX_SEEN_GOAL_LIFECYCLES) return;
  const oldest = seen.values().next().value;
  if (typeof oldest === 'string') seen.delete(oldest);
}

function suppressedOpeningEventIndexes(
  values: readonly unknown[],
  sessionId: string,
  baseline: CodexDurableSnapshot,
  knownLength: number | null,
  durablyOwnedGoalLifecycleIds: ReadonlySet<string>,
): { suppressed: Set<number>; durablyOwnedGoalIds: Set<string> } {
  const groups = new Map<string, {
    messageId: string;
    messageType: 'text' | 'goal';
    indexes: number[];
    draft: ConversationItemDraft | null;
    text: string | null;
    settled: ConversationItem | null;
    repairOnly: boolean;
  }>();
  values.forEach((value, index) => {
    const event = parseCodexStreamEvent(value);
    if (!event || event.type === 'ready' || event.type === 'cursorReset'
      || event.type === 'conversationSnapshot' || event.type === 'disconnected'
      || event.type === 'error') return;
    const mutation = projectCodexConversationMutation(event);
    if (!mutation || mutation.operation !== 'upsert') return;
    const draft = liveDraft(mutation.message);
    if (!draft) return;
    let group = groups.get(mutation.message.id);
    if (!group) {
      group = {
        messageId: mutation.message.id,
        messageType: mutation.message.type,
        indexes: [],
        draft: null,
        text: null,
        settled: null,
        repairOnly: event.observationSnapshot === true,
      };
      groups.set(mutation.message.id, group);
    }
    group.indexes.push(index);
    // A stable ID can appear as both a setup snapshot and a real journal lifecycle. Such a mixed group
    // is real lifecycle evidence and must never inherit the snapshot's weaker semantic suppression rule.
    group.repairOnly &&= event.observationSnapshot === true;
    if (mutation.message.type === 'text') {
      group.text = mutation.mode === 'append'
        ? `${group.text ?? ''}${mutation.message.text}` : mutation.message.text;
      group.draft = liveDraft({ ...mutation.message, text: group.text });
    } else {
      group.draft = draft;
    }
    if (mutation.message.completed) {
      group.settled = finalItem(mutation.message.id, sessionId, group.draft ?? draft);
    }
  });

  const suppressed = new Set<number>();
  const durablyOwnedGoalIds = new Set<string>();
  const claimedDurableIndexes = new Set<number>();
  const suppress = (group: { indexes: number[] }): void => {
    for (const index of group.indexes) suppressed.add(index);
  };

  // Exact native identity is authoritative. Reserve those durable occurrences globally and drop every
  // lifecycle event for that entity, not merely the terminal event after an opened card already flashed.
  for (const group of groups.values()) {
    const projected = group.settled ?? (group.messageType === 'text' && group.draft
      ? finalItem(group.messageId, sessionId, group.draft) : null);
    if (!projected) continue;
    const durableIndex = baseline.items.findIndex((item, index) => (
      !claimedDurableIndexes.has(index)
      && durableOwnsSettledItem(projected, item)
    ));
    if (durableIndex < 0) continue;
    claimedDurableIndexes.add(durableIndex);
    if (goalIdentity(projected)) durablyOwnedGoalIds.add(group.messageId);
    suppress(group);
  }

  // A tagged Goal is a repair of current App Server state, not evidence of a newly created historical
  // lifecycle. Semantic suppression is allowed only after a prior durable reconciliation proved that this
  // stable lifecycle ID owns an occurrence; otherwise an old same-objective Goal could swallow a new one.
  for (const group of groups.values()) {
    if (!group.repairOnly || !group.settled
      || !durablyOwnedGoalLifecycleIds.has(goalLifecycleKey(sessionId, group.messageId))
      || group.indexes.every((index) => suppressed.has(index))) continue;
    const pendingGoal = goalIdentity(group.settled);
    if (!pendingGoal) continue;
    const candidates = baseline.items.flatMap((item, index) => {
      if (claimedDurableIndexes.has(index)) return [];
      const durableGoal = goalIdentity(item);
      return durableGoal !== null && sameGoal(pendingGoal, durableGoal) ? [index] : [];
    });
    const durableIndex = candidates.find((index) => (
      group.settled!.groupingId
      && baseline.items[index]?.groupingId === group.settled!.groupingId
    )) ?? candidates[0] ?? -1;
    if (durableIndex < 0) continue;
    claimedDurableIndexes.add(durableIndex);
    suppress(group);
  }

  // Active Goal context uses a rollout item identity rather than App Server's timestamp identity. Only a
  // proven addition after a previously read durable prefix may bridge that identity, one occurrence each.
  // With no trustworthy checkpoint, retaining the native card is safer than swallowing a repeated Goal.
  if (knownLength === null) return { suppressed, durablyOwnedGoalIds };
  const semanticGroups = [...groups.values()].filter((group) => (
    !group.repairOnly && group.settled
    && !group.indexes.every((index) => suppressed.has(index))
    && goalIdentity(group.settled) !== null
  ));
  // Reserve correlation matches before FIFO fallback, so an earlier unanchored Goal cannot steal the
  // durable occurrence explicitly tied to a later opening Goal.
  for (const group of semanticGroups) {
    const pendingGoal = goalIdentity(group.settled!);
    const groupingId = group.settled!.groupingId;
    if (!pendingGoal || !groupingId) continue;
    const durableIndex = baseline.items.findIndex((item, index) => {
      if (index < knownLength || claimedDurableIndexes.has(index)
        || item.groupingId !== groupingId) return false;
      const durableGoal = goalIdentity(item);
      return durableGoal !== null && sameGoal(pendingGoal, durableGoal);
    });
    if (durableIndex < 0) continue;
    claimedDurableIndexes.add(durableIndex);
    durablyOwnedGoalIds.add(group.messageId);
    suppress(group);
  }
  for (const group of semanticGroups) {
    if (group.indexes.every((index) => suppressed.has(index))) continue;
    const pendingGoal = goalIdentity(group.settled!);
    if (!pendingGoal) continue;
    const durableIndex = baseline.items.findIndex((item, index) => {
      if (index < knownLength || claimedDurableIndexes.has(index)) return false;
      const durableGoal = goalIdentity(item);
      return durableGoal !== null && sameGoal(pendingGoal, durableGoal);
    });
    if (durableIndex < 0) continue;
    claimedDurableIndexes.add(durableIndex);
    durablyOwnedGoalIds.add(group.messageId);
    suppress(group);
  }
  return { suppressed, durablyOwnedGoalIds };
}

function coveredPendingItemIds(
  pendingItems: ReadonlyMap<string, {
    item: ConversationItem;
    baselineMatches: number;
    settledAt: number;
    uncoveredAdvanceAt?: number;
    baselineTurnIds: Set<string>;
  }>,
  durableItems: readonly ConversationItem[],
): string[] {
  const covered = new Set<string>();
  const claimedDurableIndexes = new Set<number>();
  // Reserve stable-ID ownership globally before any Goal is allowed to claim a semantic occurrence.
  // Otherwise an earlier Goal can steal the exact durable item that belongs to a later pending Goal.
  for (const [pendingId, pending] of pendingItems) {
    const exactIndex = durableItems.findIndex((item, index) => (
      !claimedDurableIndexes.has(index) && durableOwnsSettledItem(pending.item, item)
    ));
    if (exactIndex >= 0) {
      claimedDurableIndexes.add(exactIndex);
      covered.add(pendingId);
    }
  }
  for (const [pendingId, pending] of pendingItems) {
    if (covered.has(pendingId)) continue;
    const pendingGoal = goalIdentity(pending.item);
    if (!pendingGoal) continue;
    const candidates = durableItems.flatMap((item, index) => {
      const durableGoal = goalIdentity(item);
      return durableGoal && sameGoal(pendingGoal, durableGoal) ? [index] : [];
    });
    // The first N equivalent occurrences were already in the committed baseline when this live card
    // settled. Allocate only a later occurrence, and allocate every durable occurrence at most once.
    const candidate = candidates.slice(pending.baselineMatches)
      .find((index) => !claimedDurableIndexes.has(index));
    if (candidate === undefined) continue;
    claimedDurableIndexes.add(candidate);
    covered.add(pendingId);
  }
  return [...covered];
}

type WithoutSourceSequence<T> = T extends { sourceSequence: number }
  ? Omit<T, 'sourceSequence'> : never;
type ConversationAdapterEventBody = WithoutSourceSequence<ConversationAdapterEvent>;

function isRun(target: AgentSessionRef | AgentRunRef): target is AgentRunRef {
  return 'runId' in target;
}

function viewId(sessionId: string): string {
  return `codex-thread:${sessionId}`;
}

function stableId(message: CodexTranscriptMessage, suffix = ''): string {
  const base = typeof message.id === 'string' && message.id
    ? message.id : `codex:line-${message.i}:${message.type}`;
  return suffix ? `${base}:${suffix}` : base;
}

function sourceTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function json(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol') out[key] = json(entry);
    }
    return out;
  }
  return String(value ?? '');
}

function itemBase(message: CodexTranscriptMessage, sessionId: string, id = stableId(message)) {
  const createdAt = sourceTime(message.ts);
  return {
    id,
    sessionId,
    status: 'complete' as const,
    ...(createdAt === undefined ? {} : { sourceCreatedAt: createdAt }),
    ...(typeof message.turnId === 'string' && message.turnId
      ? { groupingId: message.turnId } : {}),
    ...(typeof message.correlationId === 'string' && message.correlationId
      ? { correlationId: message.correlationId } : {}),
  };
}

function compactorItemKey(message: CodexTranscriptMessage): string | null {
  return typeof message.turnId === 'string' && message.turnId
    && typeof message.itemId === 'string' && message.itemId
    ? `${message.turnId}\0${message.itemId}` : null;
}

function projectDurableMessage(
  message: CodexTranscriptMessage,
  sessionId: string,
  suppressedCompactorItems: ReadonlySet<string>,
): ConversationItem[] {
  const sourceKey = compactorItemKey(message);
  if (message.type === 'text' && message.role === 'assistant'
    && sourceKey && suppressedCompactorItems.has(sourceKey)) return [];
  if (message.type === 'text' && message.role && typeof message.text === 'string') {
    const output = clipConversationText(message.text);
    return [{
      ...itemBase(message, sessionId), kind: 'message', role: message.role,
      content: [{ type: 'text', text: output.text }],
      ...(output.truncated ? {
        status: 'truncated' as const,
        truncation: { reason: 'size_limit' as const, originalBytes: output.originalBytes },
      } : {}),
    }];
  }
  if (message.type === 'thinking' && typeof message.text === 'string') {
    // Codex rollout stores the provider's public reasoning summary, not hidden reasoning content.
    const output = clipConversationText(message.text);
    return [{
      ...itemBase(message, sessionId), kind: 'reasoning_summary', text: output.text,
      ...(output.truncated ? {
        status: 'truncated' as const,
        truncation: { reason: 'size_limit' as const, originalBytes: output.originalBytes },
      } : {}),
    }];
  }
  if (message.type === 'tool' && message.tool) {
    const callId = stableId(message, 'call');
    const inputProjection = sanitizeToolInputWithMetadata(message.tool.input);
    const input = inputProjection.value;
    const name = clipConversationText(message.tool.name || 'tool', 512).text || 'tool';
    const rawResult = message.tool.result === null || message.tool.result === undefined
      ? null : String(message.tool.result);
    const result = rawResult === null ? null : sanitizeToolResultText(rawResult);
    const extensionInput = input !== null && typeof input === 'object' ? input : {};
    const diffProjection = message.tool.diff === undefined
      ? undefined : sanitizeToolInputWithMetadata(message.tool.diff);
    const safeDiff = diffProjection?.value;
    const outcomes = ['running', 'success', 'failed', 'declined', 'completed'];
    const outcome = typeof message.tool.outcome === 'string' && outcomes.includes(message.tool.outcome)
      ? message.tool.outcome : undefined;
    const items: ConversationItem[] = [{
      ...itemBase(message, sessionId, callId), kind: 'tool_call', callId,
      name, ...(input === undefined ? {} : { input }),
      ...(inputProjection.truncated ? {
        status: 'truncated' as const,
        truncation: { reason: 'size_limit' as const, originalBytes: inputProjection.originalBytes },
      } : {}),
      extensions: {
        'conversation.tool': {
          name, input: extensionInput, result: result?.text ?? null,
          isError: message.tool.isError === true,
          ...(outcome === undefined ? {} : { outcome }),
          ...(safeDiff === undefined ? {} : { diff: safeDiff }),
        },
      },
    }];
    // A successful tool may legitimately produce no stdout. Do not manufacture an empty durable text
    // block: Core intentionally rejects those because they have no user-visible content.
    if (rawResult !== null && rawResult.length > 0 && result) {
      items.push({
        ...itemBase(message, sessionId, stableId(message, 'result')),
        kind: 'tool_result', callId,
        content: [{ type: 'text', text: result.text }],
        ...(message.tool.isError ? { isError: true } : {}),
        ...(result.truncated ? {
          status: 'truncated' as const,
          truncation: { reason: 'size_limit' as const, originalBytes: result.originalBytes },
        } : {}),
      });
    }
    const rawInput = message.tool.input && typeof message.tool.input === 'object'
      && !Array.isArray(message.tool.input) ? message.tool.input as Record<string, unknown> : {};
    if (message.tool.diff) {
      const rawPath = rawInput.file_path ?? rawInput.path;
      const path = safeProviderDiffPath(rawPath);
      const patch = typeof rawInput.patch === 'string'
        ? sanitizeToolResultText(rawInput.patch) : undefined;
      items.push({
        ...itemBase(message, sessionId, stableId(message, 'diff')),
        kind: 'diff',
        ...(path === undefined ? {} : { path }),
        ...(patch === undefined ? {} : { patch: patch.text }),
        summary: `+${message.tool.diff.added} -${message.tool.diff.removed}`,
        ...(patch?.truncated || diffProjection?.truncated ? {
          status: 'truncated' as const,
          truncation: {
            reason: 'size_limit' as const,
            originalBytes: (patch?.originalBytes ?? 0) + (diffProjection?.originalBytes ?? 0),
          },
        } : {}),
      });
    }
    return items;
  }
  if (message.type === 'compact') {
    const summary = typeof message.summary === 'string' && message.summary
      ? clipConversationText(message.summary) : null;
    const truncated = message.summaryTruncated === true || summary?.truncated === true;
    const originalBytes = typeof message.summaryOriginalBytes === 'number'
      ? message.summaryOriginalBytes : summary?.originalBytes;
    return [{
      ...itemBase(message, sessionId), kind: 'compaction',
      ...(summary ? { summary: summary.text } : {}),
      ...(truncated ? {
        status: 'truncated' as const,
        truncation: { reason: 'size_limit' as const, originalBytes: originalBytes ?? 0 },
      } : {}),
    }];
  }
  if (message.type === 'interrupt') {
    return [{ ...itemBase(message, sessionId), kind: 'interrupt', actor: 'user' }];
  }
  if (message.type === 'slash') {
    return [{
      ...itemBase(message, sessionId), kind: 'notice', level: 'info', code: 'slash_command',
      message: `${message.name ?? '/command'}${message.args ? ` ${message.args}` : ''}`,
      extensions: {
        'conversation.slash': json({
          name: message.name ?? '/command',
          ...(typeof message.args === 'string' ? { args: message.args } : {}),
          ...(typeof message.result === 'string' ? { result: message.result } : {}),
        }),
      },
    }];
  }
  if (message.type === 'plan') {
    return [{
      ...itemBase(message, sessionId), kind: 'notice', level: 'info', code: 'plan_updated',
      message: typeof message.explanation === 'string' && message.explanation
        ? message.explanation : 'Plan updated',
      extensions: { 'conversation.plan': json(message.plan ?? []) },
    }];
  }
  if (message.type === 'goal') {
    const goal = message.goal && typeof message.goal === 'object' ? message.goal : {};
    const objective = typeof goal.objective === 'string' ? goal.objective : 'Goal updated';
    const status = typeof goal.status === 'string' ? goal.status : message.event ?? 'updated';
    return [{
      ...itemBase(message, sessionId), kind: 'notice', level: 'info', code: 'goal_updated',
      message: `${objective} · ${status}`,
      extensions: {
        'conversation.goal': json(goal),
        ...(typeof message.event === 'string' ? { 'conversation.goalEvent': message.event } : {}),
      },
    }];
  }
  return [];
}

function liveDraft(message: {
  type: string; text?: string; goal?: unknown; event?: unknown; turnId?: string | null;
}): ConversationItemDraft | null {
  const grouping = typeof message.turnId === 'string' && message.turnId
    ? { groupingId: message.turnId } : {};
  if (message.type === 'text') {
    return {
      kind: 'message', role: 'assistant',
      content: [{ type: 'text', text: message.text ?? '' }],
      ...grouping,
    };
  }
  if (message.type === 'goal') {
    const goal = message.goal && typeof message.goal === 'object'
      ? message.goal as Record<string, unknown> : {};
    const objective = typeof goal.objective === 'string' ? goal.objective : 'Goal updated';
    const status = typeof goal.status === 'string' ? goal.status : 'updated';
    return {
      kind: 'notice', level: 'info', code: 'goal_updated', message: `${objective} · ${status}`,
      ...grouping,
      extensions: {
        'conversation.goal': json(goal),
        ...(typeof message.event === 'string' ? { 'conversation.goalEvent': message.event } : {}),
      },
    };
  }
  return null;
}

function finalItem(
  provisionalId: string,
  sessionId: string,
  draft: ConversationItemDraft,
): ConversationItem {
  return { id: provisionalId, sessionId, status: 'complete', ...draft } as ConversationItem;
}

export function createCodexConversationAdapter({
  app,
  sessionsRoot = sessionsDir(),
  reader = transcriptReader,
  findRollout = resolveCodexRollout,
  rolloutSize = async (file: string) => {
    try {
      const snapshot = await stat(file);
      return snapshot.isFile() ? snapshot.size : null;
    } catch {
      return null;
    }
  },
  durablePollMs = 500,
  durableSettleTimeoutMs = DEFAULT_DURABLE_SETTLE_TIMEOUT_MS,
}: CodexConversationAdapterOptions): AgentConversationAdapterV1 {
  if (!app || typeof app.discover !== 'function' || typeof app.observeConversation !== 'function') {
    throw new TypeError('Codex Conversation adapter requires App Server');
  }
  if (!Number.isFinite(durablePollMs) || durablePollMs <= 0) {
    throw new TypeError('Codex Conversation adapter requires a positive durable poll interval');
  }
  if (!Number.isFinite(durableSettleTimeoutMs) || durableSettleTimeoutMs <= 0) {
    throw new TypeError('Codex Conversation adapter requires a positive durable settle timeout');
  }
  if (!reader.readPrefix) {
    throw new TypeError('Codex Conversation adapter requires immutable transcript prefix reads');
  }
  const readPrefix: NonNullable<TranscriptReader['readPrefix']> = reader.readPrefix.bind(reader);
  const durableCheckpoints = new Map<string, CodexDurableCheckpoint>();
  const durablyOwnedGoalLifecycleIds = new Set<string>();
  // Core reads its authoritative opening page immediately after observeNative returns. Freeze that one
  // read at the same byte cutoff as the adapter baseline so later rollout suffixes cannot appear in both
  // the page and the already-buffered native stream.
  const openingSnapshots = new Map<string, CodexOpeningSnapshot>();
  const suppressedCompactorItemsBySession = new Map<string, ReadonlySet<string>>();

  function cloneCheckpoint(checkpoint: CodexDurableCheckpoint): CodexDurableCheckpoint {
    return {
      ...checkpoint,
      itemOffsets: [...checkpoint.itemOffsets],
      historyHashes: [...checkpoint.historyHashes],
      snapshot: { ...checkpoint.snapshot, items: [...checkpoint.snapshot.items] },
    };
  }

  const suppressionKeyOf = (values: ReadonlySet<string>): string => [...values].sort().join('\n');

  async function readCompactorItemKeys(paneId: string, sessionId: string): Promise<ReadonlySet<string>> {
    const values = new Set((await app.compactorItemKeys(paneId, sessionId)).filter((value) => (
      typeof value === 'string' && value.includes('\0')
    )));
    suppressedCompactorItemsBySession.delete(sessionId);
    suppressedCompactorItemsBySession.set(sessionId, values);
    while (suppressedCompactorItemsBySession.size > MAX_DURABLE_CHECKPOINTS) {
      const oldest = suppressedCompactorItemsBySession.keys().next().value;
      if (typeof oldest !== 'string') break;
      suppressedCompactorItemsBySession.delete(oldest);
    }
    return values;
  }

  function rememberCheckpoint(sessionId: string, checkpoint: CodexDurableCheckpoint): void {
    durableCheckpoints.delete(sessionId);
    durableCheckpoints.set(sessionId, checkpoint);
    while (durableCheckpoints.size > MAX_DURABLE_CHECKPOINTS) {
      const oldest = durableCheckpoints.keys().next().value;
      if (oldest === undefined) break;
      durableCheckpoints.delete(oldest);
    }
  }

  function snapshotFromMessages(
    session: AgentSessionRef,
    parsed: readonly CodexTranscriptMessage[],
    file: string | null,
    version: string | undefined,
    readerGeneration: number | undefined,
    changedFrom: number | null,
    checkpoint: CodexDurableCheckpoint | undefined,
    suppressedCompactorItems: ReadonlySet<string>,
  ): CodexDurableCheckpoint {
    const suppressionKey = suppressionKeyOf(suppressedCompactorItems);
    const sameReader = readerGeneration === undefined || checkpoint?.readerGeneration === undefined
      || checkpoint.readerGeneration === readerGeneration;
    const reusable = checkpoint?.file === file && sameReader && changedFrom !== null
      && checkpoint.suppressionKey === suppressionKey
      && changedFrom >= 0 && changedFrom <= checkpoint.messageCount
      && changedFrom <= parsed.length;
    // Build transactionally. A backwards/truncated read must not corrupt the last readable checkpoint
    // before the floor check rejects it.
    const next = reusable && checkpoint ? cloneCheckpoint(checkpoint) : undefined;
    const from = next ? changedFrom! : 0;
    const durableFloor = checkpoint?.suppressionKey === suppressionKey
      ? checkpoint.snapshot.items.length : 0;
    const items = next?.snapshot.items ?? [];
    const itemOffsets = next?.itemOffsets ?? [0];
    const historyHashes = next?.historyHashes ?? [];
    const prefixItems = itemOffsets[from] ?? 0;
    items.length = prefixItems;
    itemOffsets.length = from + 1;
    historyHashes.length = from;
    let historyHash = historyHashes.at(-1) ?? HISTORY_HASH_SEED;
    for (let index = from; index < parsed.length; index++) {
      const projected = projectDurableMessage(
        parsed[index]!, session.sessionId, suppressedCompactorItems,
      );
      items.push(...projected);
      itemOffsets.push(items.length);
      // A suppressed compactor record is not a visible history revision. Keep the token unchanged until
      // the parser replaces it with the durable compact marker, avoiding an identical-page refresh.
      if (projected.length > 0) {
        historyHash = createHash('sha256')
          .update(historyHash)
          .update('\0')
          .update(JSON.stringify(projected))
          .digest('hex');
      }
      historyHashes.push(historyHash);
    }
    if (items.length < durableFloor) {
      throw new Error('Codex durable rollout projection moved backwards');
    }
    return {
      file,
      ...(version === undefined ? {} : { version }),
      ...(readerGeneration === undefined ? {} : { readerGeneration }),
      suppressionKey,
      messageCount: parsed.length,
      itemOffsets,
      historyHashes,
      snapshot: {
        sessionId: session.sessionId,
        sourceViewId: viewId(session.sessionId),
        sourceHistoryToken: historyHash,
        items,
      },
    };
  }

  async function readDurableSnapshot(
    session: AgentSessionRef,
    suppressionProvider?: () => Promise<ReadonlySet<string>>,
  ): Promise<CodexDurableSnapshot> {
    const file = await findRollout(sessionsRoot, session.sessionId);
    const read = file && reader.readSnapshot
      ? await reader.readSnapshot(file, createCodexTranscriptParser)
      : {
        messages: file ? await reader.read(file, createCodexTranscriptParser) : [],
        version: undefined,
        changedFrom: 0,
        generation: undefined,
      };
    const suppressedCompactorItems = suppressionProvider
      ? await suppressionProvider()
      : suppressedCompactorItemsBySession.get(session.sessionId) ?? new Set<string>();
    const suppressionKey = suppressionKeyOf(suppressedCompactorItems);
    const known = durableCheckpoints.get(session.sessionId);
    if (known && known.file === file && known.suppressionKey === suppressionKey
      && read.version !== undefined && known.version === read.version) {
      rememberCheckpoint(session.sessionId, known);
      return known.snapshot;
    }
    const sameReader = read.generation === undefined || known?.readerGeneration === undefined
      || known.readerGeneration === read.generation;
    if (known && known.file === file && sameReader && read.changedFrom === null) {
      if (read.version === undefined) delete known.version;
      else known.version = read.version;
      rememberCheckpoint(session.sessionId, known);
      return known.snapshot;
    }
    const checkpoint = snapshotFromMessages(
      session, read.messages, file, read.version, read.generation, read.changedFrom, known,
      suppressedCompactorItems,
    );
    rememberCheckpoint(session.sessionId, checkpoint);
    return checkpoint.snapshot;
  }

  async function captureDurableCutoff(sessionId: string): Promise<CodexDurableCutoff> {
    const file = await findRollout(sessionsRoot, sessionId);
    if (!file) return { file: null, endExclusive: 0 };
    const endExclusive = await rolloutSize(file);
    return typeof endExclusive === 'number' && Number.isSafeInteger(endExclusive) && endExclusive >= 0
      ? { file, endExclusive }
      : { file: null, endExclusive: 0 };
  }

  async function readDurablePrefix(
    session: AgentSessionRef,
    cutoff: CodexDurableCutoff,
    suppressionProvider?: () => Promise<ReadonlySet<string>>,
  ): Promise<{ snapshot: CodexDurableSnapshot; checkpoint: CodexDurableCheckpoint }> {
    const known = durableCheckpoints.get(session.sessionId);
    const working = known ? cloneCheckpoint(known) : undefined;
    const read = cutoff.file && reader.readPrefixSnapshot
      ? await reader.readPrefixSnapshot(
        cutoff.file, cutoff.endExclusive, createCodexTranscriptParser,
      )
      : {
        messages: cutoff.file
          ? await readPrefix(cutoff.file, cutoff.endExclusive, createCodexTranscriptParser) : [],
        version: undefined,
        changedFrom: 0,
        generation: undefined,
      };
    const suppressedCompactorItems = suppressionProvider
      ? await suppressionProvider()
      : suppressedCompactorItemsBySession.get(session.sessionId) ?? new Set<string>();
    const suppressionKey = suppressionKeyOf(suppressedCompactorItems);
    const checkpoint = working && working.file === cutoff.file
      && working.suppressionKey === suppressionKey
      && read.version !== undefined && working.version === read.version
      ? working
      : snapshotFromMessages(
        session, read.messages, cutoff.file, read.version, read.generation,
        read.changedFrom, working, suppressedCompactorItems,
      );
    return {
      checkpoint,
      snapshot: { ...checkpoint.snapshot, items: [...checkpoint.snapshot.items] },
    };
  }

  async function readPage(
    session: AgentSessionRef,
    request: { beforeSourceCursor?: string; limit: number },
  ): Promise<ConversationAdapterPage> {
    const opening = request.beforeSourceCursor === undefined
      ? openingSnapshots.get(session.sessionId) : undefined;
    const snapshot = opening?.snapshot ?? await readDurableSnapshot(session);
    let end = snapshot.items.length;
    if (request.beforeSourceCursor !== undefined) {
      if (!/^\d+$/.test(request.beforeSourceCursor)) throw new Error('Invalid Codex source cursor');
      const cursor = Number(request.beforeSourceCursor);
      if (!Number.isSafeInteger(cursor)) throw new Error('Invalid Codex source cursor');
      end = Math.min(cursor, snapshot.items.length);
    }
    const start = Math.max(0, end - request.limit);
    const page = {
      sessionId: snapshot.sessionId,
      sourceViewId: snapshot.sourceViewId,
      sourceHistoryToken: snapshot.sourceHistoryToken,
      items: snapshot.items.slice(start, end),
      ...(start > 0 ? { previousSourceCursor: String(start) } : {}),
      hasMore: start > 0,
    };
    if (opening && openingSnapshots.get(session.sessionId) === opening) {
      openingSnapshots.delete(session.sessionId);
      opening.release();
    }
    return page;
  }

  return {
    apiVersion: 1,
    async discoverNative(target) {
      if (target.agentId !== 'codex' || !target.sessionId) return null;
      if (isRun(target)) {
        const discovered = await app.discover(target.paneId);
        if (!discovered?.managed || discovered.threadId !== target.sessionId) return null;
        return {
          session: { agentId: 'codex', sessionId: target.sessionId },
          run: target,
          sourceViewId: viewId(target.sessionId),
          capabilities: {
            history: true, live: 'delta', sendable: true, steer: true,
            send: ['prompt'], interrupt: true,
          },
        };
      }
      const file = await findRollout(sessionsRoot, target.sessionId);
      if (!file) return null;
      return {
        session: target,
        sourceViewId: viewId(target.sessionId),
        capabilities: { history: true, live: 'poll' },
      };
    },
    readNativePage: readPage,
    async observeNative(run: AgentRunLease, sink: ConversationAdapterEventSink) {
      if (!run.ref.sessionId) throw new Error('Codex run has no thread');
      const sessionId = run.ref.sessionId;
      const knownCheckpoint = durableCheckpoints.get(sessionId);
      const live: LiveProjection = {
        sink, sourceSequence: 0, closed: false, provisional: new Map(),
        pendingDurableItems: new Map(),
        observedTurnIds: new Set(),
        tail: Promise.resolve(), closeNative: undefined, durableToken: undefined,
        durableItems: [],
        durableCandidateToken: undefined, durableCandidateAt: undefined,
        pollTimer: undefined, pollDueAt: undefined,
        openingPagePending: true,
      };
      const emit = async (event: ConversationAdapterEventBody): Promise<void> => {
        if (live.closed) return;
        await sink({ ...event, sourceSequence: ++live.sourceSequence } as ConversationAdapterEvent);
      };
      const closeLive = async (): Promise<void> => {
        if (live.closed) return;
        live.closed = true;
        if (live.pollTimer) clearTimeout(live.pollTimer);
        live.pollTimer = undefined;
        live.pollDueAt = undefined;
        live.durableCandidateToken = undefined;
        live.durableCandidateAt = undefined;
        live.provisional.clear();
        live.pendingDurableItems.clear();
        live.observedTurnIds.clear();
        live.durableItems = [];
        const opening = openingSnapshots.get(sessionId);
        if (opening?.owner === live) openingSnapshots.delete(sessionId);
        await live.closeNative?.();
      };
      const failClosed = async (): Promise<void> => {
        if (live.closed) return;
        try {
          await emit({ type: 'stream.gap', afterSourceSequence: live.sourceSequence });
        } catch { /* the sink itself is already unavailable */ }
        await closeLive();
      };
      const reconcileDurable = async (retryReadFailure: boolean): Promise<void> => {
        if (live.closed || live.openingPagePending) return;
        const deadlineReached = (pending: {
          item: ConversationItem;
          settledAt: number;
          uncoveredAdvanceAt?: number;
        }, now: number): boolean => (
          waitsForNextTurn(pending.item)
            ? pending.uncoveredAdvanceAt !== undefined
              && now - pending.uncoveredAdvanceAt >= durableSettleTimeoutMs
            : now - pending.settledAt >= durableSettleTimeoutMs
        );
        let page: CodexDurableSnapshot;
        try {
          page = await readDurableSnapshot(
            { agentId: 'codex', sessionId },
            () => readCompactorItemKeys(run.ref.paneId, sessionId),
          );
        } catch (error) {
          // A writer can transiently rotate or replace the rollout. Periodic reconciliation retries
          // read failures; the initial baseline still fails the open because Core has no safe checkpoint.
          if (retryReadFailure) {
            if ([...live.pendingDurableItems.values()].some((pending) => (
              deadlineReached(pending, Date.now())
            ))) throw new Error('Codex settled item did not become durable');
            live.durableCandidateToken = undefined;
            live.durableCandidateAt = undefined;
            return;
          }
          throw error;
        }
        if (live.closed) return;
        const now = Date.now();
        if (live.durableToken === undefined) {
          live.durableToken = page.sourceHistoryToken;
          live.durableItems = [...page.items];
          live.durableCandidateToken = undefined;
          live.durableCandidateAt = undefined;
          return;
        }
        let coveredPendingIds: string[] = [];
        const rememberCoveredGoals = (ids: readonly string[]): void => {
          for (const id of ids) {
            const pending = live.pendingDurableItems.get(id);
            if (pending && goalIdentity(pending.item)) {
              rememberGoalLifecycle(durablyOwnedGoalLifecycleIds, sessionId, id);
            }
          }
        };
        if (live.pendingDurableItems.size > 0) {
          coveredPendingIds = coveredPendingItemIds(live.pendingDurableItems, page.items);
          // A settled live item remains part of the visible frontier until an equivalent durable item
          // is readable. Publishing an earlier user/tool-only token would erase that reply on page seed.
          if (coveredPendingIds.length !== live.pendingDurableItems.size) {
            const covered = new Set(coveredPendingIds);
            let expired = false;
            for (const [id, pending] of live.pendingDurableItems) {
              if (covered.has(id)) continue;
              if (waitsForNextTurn(pending.item)) {
                const nextTurnVisible = [...live.observedTurnIds].some((turnId) => (
                  !pending.baselineTurnIds.has(turnId)
                )) || page.items.some((item) => (
                  typeof item.groupingId === 'string' && item.groupingId
                  && !pending.baselineTurnIds.has(item.groupingId)
                ));
                if (!nextTurnVisible) {
                  delete pending.uncoveredAdvanceAt;
                  continue;
                }
                pending.uncoveredAdvanceAt ??= now;
              }
              if (deadlineReached(pending, now)) expired = true;
            }
            // An item that never becomes durable must not poison every later history token forever.
            // An active Goal starts this deadline only after a new native turn or durable correlation;
            // the current turn may keep appending long after the Goal was set. Fail closed via Core's gap.
            if (expired) throw new Error('Codex settled item did not become durable');
            live.durableCandidateToken = undefined;
            live.durableCandidateAt = undefined;
            return;
          }
        }
        if (page.sourceHistoryToken === live.durableToken) {
          rememberCoveredGoals(coveredPendingIds);
          for (const id of coveredPendingIds) live.pendingDurableItems.delete(id);
          live.durableCandidateToken = undefined;
          live.durableCandidateAt = undefined;
          return;
        }
        // Do not advance the durable barrier while a provisional reply is still streaming: the page seed
        // would otherwise replace a live frontier whose remaining native deltas are not durable yet.
        if (live.provisional.size > 0) {
          live.durableCandidateToken = undefined;
          live.durableCandidateAt = undefined;
          return;
        }
        // Require the same readable token twice. Codex appends several adjacent rollout records per
        // action; this quiet-read barrier avoids publishing a token that changes before Core verifies it.
        if (live.durableCandidateToken !== page.sourceHistoryToken) {
          live.durableCandidateToken = page.sourceHistoryToken;
          live.durableCandidateAt = Date.now();
          return;
        }
        if (live.durableCandidateAt === undefined
          || Date.now() - live.durableCandidateAt < DURABLE_QUIET_MS) return;
        live.durableToken = page.sourceHistoryToken;
        live.durableItems = [...page.items];
        rememberCoveredGoals(coveredPendingIds);
        for (const id of coveredPendingIds) live.pendingDurableItems.delete(id);
        live.durableCandidateToken = undefined;
        live.durableCandidateAt = undefined;
        await emit({
          type: 'history.committed', sourceViewId: page.sourceViewId,
          sourceHistoryToken: page.sourceHistoryToken,
        });
      };
      const armDurablePoll = (delay = durablePollMs): void => {
        if (live.closed || live.openingPagePending) return;
        const dueAt = Date.now() + delay;
        if (live.pollTimer && live.pollDueAt !== undefined && live.pollDueAt <= dueAt) return;
        if (live.pollTimer) clearTimeout(live.pollTimer);
        live.pollDueAt = dueAt;
        live.pollTimer = setTimeout(() => {
          live.pollTimer = undefined;
          live.pollDueAt = undefined;
          const pending = live.tail.then(() => reconcileDurable(true));
          live.tail = pending.catch(failClosed);
          void live.tail.finally(() => {
            armDurablePoll(live.durableCandidateToken ? DURABLE_QUIET_MS : durablePollMs);
          }).catch(() => {});
        }, delay);
        live.pollTimer.unref?.();
      };
      const process = async (value: unknown, suppressMutation = false): Promise<void> => {
        const event = parseCodexStreamEvent(value);
        if (!event || live.closed) return;
        if ('turnId' in event && typeof event.turnId === 'string' && event.turnId) {
          live.observedTurnIds.add(event.turnId);
          const observedAt = Date.now();
          for (const pending of live.pendingDurableItems.values()) {
            if (waitsForNextTurn(pending.item) && !pending.baselineTurnIds.has(event.turnId)) {
              pending.uncoveredAdvanceAt ??= observedAt;
            }
          }
        }
        if (event.type === 'cursorReset' || event.type === 'disconnected' || event.type === 'error') {
          await emit({ type: 'stream.gap', afterSourceSequence: live.sourceSequence });
          return;
        }
        if (event.type === 'conversationSnapshot') {
          await reconcileDurable(true);
          armDurablePoll(DURABLE_QUIET_MS);
          return;
        }
        if (event.type === 'turnCompleted') {
          for (const [provisionalId, current] of live.provisional) {
            if (current.turnId !== event.turnId) continue;
            live.provisional.delete(provisionalId);
            await emit({
              type: 'item.cancelled', provisionalId,
              reason: event.status === 'interrupted' ? 'interrupted' : 'stream_reset',
            });
          }
          await reconcileDurable(true);
          armDurablePoll(DURABLE_QUIET_MS);
          return;
        }
        if (event.type === 'goalCleared') {
          for (const [id, pending] of live.pendingDurableItems) {
            if (waitsForNextTurn(pending.item) && pending.uncoveredAdvanceAt === undefined) {
              live.pendingDurableItems.delete(id);
            }
          }
          await reconcileDurable(true);
          armDurablePoll(DURABLE_QUIET_MS);
          return;
        }
        if (event.type === 'ready') return;
        const mutation = projectCodexConversationMutation(event);
        if (!mutation || mutation.operation !== 'upsert') return;
        const message = mutation.message;
        const draft = liveDraft(message);
        if (!draft) return;
        const provisionalId = message.id;
        const current = live.provisional.get(provisionalId);
        const completedItem = message.completed ? finalItem(provisionalId, sessionId, draft) : null;
        if (completedItem && goalIdentity(completedItem)) {
          // App Server has only one current Goal. A later Goal lifecycle supersedes any older active card
          // that never reached rollout, otherwise the impossible old occurrence blocks every future token.
          for (const [id, pending] of live.pendingDurableItems) {
            if (id !== provisionalId && waitsForNextTurn(pending.item)
              && pending.uncoveredAdvanceAt === undefined) {
              live.pendingDurableItems.delete(id);
            }
          }
        }
        if (suppressMutation) return;
        if (completedItem
          && live.durableItems.some((item) => durableOwnsSettledItem(completedItem, item))) {
          if (goalIdentity(completedItem)) {
            rememberGoalLifecycle(durablyOwnedGoalLifecycleIds, sessionId, provisionalId);
          }
          // The durable baseline can race ahead of a native event with the same stable item identity.
          // The page already owns that position, so do not append a redundant live card.
          if (current) {
            live.provisional.delete(provisionalId);
            await emit({ type: 'item.cancelled', provisionalId, reason: 'superseded' });
          }
          return;
        }
        if (!current) {
          live.provisional.set(provisionalId, { draft, turnId: message.turnId });
          await emit({ type: 'item.opened', provisionalId, draft });
        } else if (mutation.mode === 'append' && message.type === 'text') {
          await emit({
            type: 'item.delta', provisionalId,
            delta: { op: 'text.append', target: 'message.content', blockIndex: 0, text: message.text },
          });
        } else {
          live.provisional.set(provisionalId, { draft, turnId: message.turnId });
          await emit({ type: 'item.delta', provisionalId, delta: { op: 'item.replace', draft } });
        }
        if (message.completed) {
          const settled = live.provisional.get(provisionalId)?.draft ?? draft;
          live.provisional.delete(provisionalId);
          const item = finalItem(provisionalId, sessionId, settled);
          live.pendingDurableItems.set(provisionalId, {
            item,
            baselineMatches: durableMatchCount(item, live.durableItems),
            settledAt: Date.now(),
            baselineTurnIds: new Set([
              ...live.observedTurnIds,
              ...live.durableItems.flatMap((durable) => (
                durable.groupingId ? [durable.groupingId] : []
              )),
            ]),
          });
          await emit({
            type: 'item.settled', provisionalId, durableItemId: provisionalId,
            item,
          });
          await reconcileDurable(true);
          armDurablePoll(DURABLE_QUIET_MS);
        }
      };
      const enqueueNative = (event: unknown, suppressMutation = false): void => {
        live.tail = live.tail.then(() => process(event, suppressMutation)).catch(failClosed);
      };
      // The native observer must exist before the durable cutoff/read, but no event may calculate its
      // Goal occurrence baseline until that prefix finishes. Buffer this short opening window explicitly.
      let opening = true;
      let openingOverflow = false;
      const openingEvents: unknown[] = [];
      try {
        const native = await app.observeConversation(run.ref.paneId, sessionId, (event) => {
          if (live.closed) return;
          if (opening) {
            if (openingEvents.length >= MAX_OPENING_NATIVE_EVENTS) openingOverflow = true;
            else openingEvents.push(event);
            return;
          }
          enqueueNative(event);
        });
        live.closeNative = native.close;
        if (live.closed) {
          await native.close();
          throw new Error('Codex Conversation observation failed while opening');
        }
        if (openingOverflow) throw new Error('Codex Conversation opening event buffer overflowed');
        // Capture the append-only byte boundary only after the observer owns the native suffix. Anything
        // appended later belongs to that buffered suffix or the first post-open durable reconciliation.
        const cutoff = await captureDurableCutoff(sessionId);
        const openingRead = await readDurablePrefix(
          { agentId: 'codex', sessionId }, cutoff,
          () => readCompactorItemKeys(run.ref.paneId, sessionId),
        );
        const baseline = openingRead.snapshot;
        live.durableToken = baseline.sourceHistoryToken;
        live.durableItems = [...baseline.items];
        if (openingOverflow) throw new Error('Codex Conversation opening event buffer overflowed');
        const knownLength = trustedCheckpointLength(knownCheckpoint, cutoff, baseline);
        const openingSuppression = suppressedOpeningEventIndexes(
          openingEvents, sessionId, baseline, knownLength, durablyOwnedGoalLifecycleIds,
        );
        for (const id of openingSuppression.durablyOwnedGoalIds) {
          rememberGoalLifecycle(durablyOwnedGoalLifecycleIds, sessionId, id);
        }
        rememberCheckpoint(sessionId, openingRead.checkpoint);
        opening = false;
        openingEvents.forEach((event, index) => (
          enqueueNative(event, openingSuppression.suppressed.has(index))
        ));
        openingEvents.length = 0;
        await live.tail;
        if (live.closed) throw new Error('Codex Conversation observation failed while opening');
        const release = (): void => {
          if (live.closed || !live.openingPagePending) return;
          live.openingPagePending = false;
          armDurablePoll(0);
        };
        openingSnapshots.set(sessionId, { owner: live, snapshot: baseline, release });
      } catch (error) {
        opening = false;
        openingEvents.length = 0;
        await closeLive();
        throw error;
      }
      return {
        checkpoint: { sourceViewId: viewId(sessionId), sourceSequence: 0 },
        close: closeLive,
      };
    },
    async dispatchPrompt(
      run: AgentRunLease,
      request: ConversationPromptRequest,
    ): Promise<ConversationDispatchReceipt> {
      if (!run.ref.sessionId) {
        return { outcome: 'rejected', nativeMutation: false, reason: 'invalid_request' };
      }
      const result = await app.dispatchPrompt(
        run.ref.paneId, run.ref.sessionId, request.text, request.clientRequestId,
      );
      const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      if (record.busy === true) return { outcome: 'busy', nativeMutation: false };
      const body = record.result && typeof record.result === 'object'
        ? record.result as Record<string, unknown> : {};
      const turn = body.turn && typeof body.turn === 'object'
        ? body.turn as Record<string, unknown> : body;
      return {
        outcome: 'accepted',
        ...(typeof turn.id === 'string' ? { nativeId: turn.id } : {}),
      };
    },
    async dispatchSteer(
      run: AgentRunLease,
      request: ConversationSteerRequest,
    ): Promise<ConversationDispatchReceipt> {
      if (!run.ref.sessionId) {
        return { outcome: 'rejected', nativeMutation: false, reason: 'invalid_request' };
      }
      const result = await app.dispatchSteer(
        run.ref.paneId, run.ref.sessionId, request.text, request.clientRequestId, request.plan,
      );
      const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      if (record.busy === true) return { outcome: 'busy', nativeMutation: false };
      const body = record.result && typeof record.result === 'object'
        ? record.result as Record<string, unknown> : {};
      const turn = body.turn && typeof body.turn === 'object'
        ? body.turn as Record<string, unknown> : body;
      return { outcome: 'accepted', ...(typeof turn.id === 'string' ? { nativeId: turn.id } : {}) };
    },
    async dispatchInterrupt(run: AgentRunLease): Promise<InterruptReceipt> {
      if (!run.ref.sessionId) return { status: 'rejected', reason: 'invalid_request' };
      const result = await app.interrupt(run.ref.paneId, run.ref.sessionId);
      const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      return record.interrupted === true
        ? { status: 'accepted' }
        : { status: 'rejected', reason: 'provider_rejected' };
    },
  };
}
