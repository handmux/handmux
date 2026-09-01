import type {
  ConversationActivity,
  ConversationQueueItem,
} from './agentConversationControlsApi.js';
import type { AgentConversationViewItem } from './hooks/useAgentConversation.js';

export interface LocalConversationSubmission {
  clientRequestId: string;
  text: string;
  owner: 'timeline' | 'queue';
  status: 'sending' | 'accepted' | 'failed' | 'unknown';
  delivery?: 'prompt' | 'steer' | 'follow_up';
  createdAt: number;
  revision?: number;
  actionId?: string;
  baseRevision?: number;
  anchor?: { viewId: string; afterItemId?: string };
  baselineKeys?: readonly string[];
  baselineTailKey?: string;
  occurrenceNotBefore?: number;
  claimedCanonicalKey?: string;
  error?: string;
}

export function queueSubmissionId(item: ConversationQueueItem): string {
  return item.requestId || item.id;
}

function canonicalUserText(entry: AgentConversationViewItem): string | null {
  if (entry.outgoing || entry.item.kind !== 'message' || entry.item.role !== 'user') return null;
  const value = entry.item.content
    .map((block) => block.type === 'text' ? block.text : '').join('\n').trim();
  return value || null;
}

/**
 * Claim canonical user occurrences before render. Correlation remains authoritative. Providers
 * without it may claim only a new, uncorrelated occurrence beyond that submission's send baseline.
 */
export function resolveConversationSubmissionClaims(
  canonical: readonly AgentConversationViewItem[],
  local: readonly LocalConversationSubmission[],
): { submissionIds: Set<string>; occurrenceKeys: Map<string, string> } {
  const claimedSubmissionIds = new Set<string>();
  const claimedCanonicalKeys = new Set<string>();
  const occurrenceKeys = new Map<string, string>();

  // Reserve every correlated canonical row before occurrence fallback so a same-text local attempt
  // can never steal a row that belongs to another stable submission.
  for (const entry of canonical) {
    if (canonicalUserText(entry) === null) continue;
    const correlationId = entry.item.correlationId;
    if (!correlationId) continue;
    claimedSubmissionIds.add(correlationId);
    claimedCanonicalKeys.add(entry.key);
  }

  // Preserve an earlier one-to-one occurrence reservation while that exact canonical row remains
  // in the retained window. It must not be recomputed from text on every render.
  for (const submission of local) {
    if (!submission.claimedCanonicalKey || claimedSubmissionIds.has(submission.clientRequestId)) continue;
    const entry = canonical.find((candidate) => candidate.key === submission.claimedCanonicalKey);
    if (!entry || claimedCanonicalKeys.has(entry.key) || entry.item.correlationId
      || canonicalUserText(entry) === null) continue;
    claimedCanonicalKeys.add(entry.key);
    claimedSubmissionIds.add(submission.clientRequestId);
    occurrenceKeys.set(submission.clientRequestId, entry.key);
  }

  for (const submission of local) {
    if (claimedSubmissionIds.has(submission.clientRequestId) || submission.claimedCanonicalKey) continue;
    // No send-time baseline means there is no safe occurrence fallback. Stable correlation can
    // still claim above, but historical same-text content must remain unrelated.
    if (submission.baselineKeys === undefined) continue;
    const baselineKeys = new Set(submission.baselineKeys);
    const survivingBaselineIndexes = canonical.flatMap((entry, index) => (
      baselineKeys.has(entry.key) ? [index] : []
    ));
    const tailIndex = submission.baselineTailKey
      ? canonical.findIndex((entry) => entry.key === submission.baselineTailKey)
      : survivingBaselineIndexes.length ? Math.max(...survivingBaselineIndexes) : -1;
    // If a non-empty baseline vanished entirely, its history boundary cannot be reconstructed.
    if (baselineKeys.size > 0 && tailIndex < 0 && survivingBaselineIndexes.length === 0) continue;
    const boundaryIndex = tailIndex >= 0
      ? tailIndex : survivingBaselineIndexes.length ? Math.max(...survivingBaselineIndexes) : -1;
    const candidate = canonical.find((entry, index) => {
      if (index <= boundaryIndex || claimedCanonicalKeys.has(entry.key)
        || baselineKeys.has(entry.key) || entry.item.correlationId
        || canonicalUserText(entry) !== submission.text.trim()) return false;
      const sourceCreatedAt = 'sourceCreatedAt' in entry.item
        ? entry.item.sourceCreatedAt : undefined;
      if (submission.occurrenceNotBefore !== undefined && sourceCreatedAt === undefined
        && entry.live !== true) return false;
      if (submission.occurrenceNotBefore !== undefined && sourceCreatedAt !== undefined
        && sourceCreatedAt < submission.occurrenceNotBefore) return false;
      return sourceCreatedAt === undefined || sourceCreatedAt >= submission.createdAt - 5_000;
    });
    if (!candidate) continue;
    claimedCanonicalKeys.add(candidate.key);
    claimedSubmissionIds.add(submission.clientRequestId);
    occurrenceKeys.set(submission.clientRequestId, candidate.key);
  }
  return { submissionIds: claimedSubmissionIds, occurrenceKeys };
}

export function claimConversationSubmissionIds(
  canonical: readonly AgentConversationViewItem[],
  local: readonly LocalConversationSubmission[],
): Set<string> {
  return resolveConversationSubmissionClaims(canonical, local).submissionIds;
}

/** Persist exact occurrence reservations and retire them once their canonical row leaves the window. */
export function reconcileConversationSubmissionClaims<T extends LocalConversationSubmission>(
  canonical: readonly AgentConversationViewItem[],
  local: readonly T[],
): { local: T[]; claimedSubmissionIds: Set<string> } {
  const claims = resolveConversationSubmissionClaims(canonical, local);
  const correlatedIds = new Set(canonical.flatMap((entry) => (
    canonicalUserText(entry) !== null && entry.item.correlationId
      ? [entry.item.correlationId] : []
  )));
  let changed = false;
  const next = local.flatMap((submission): T[] => {
    if (correlatedIds.has(submission.clientRequestId)) { changed = true; return []; }
    const claimedKey = claims.occurrenceKeys.get(submission.clientRequestId);
    if (submission.claimedCanonicalKey && claimedKey !== submission.claimedCanonicalKey) {
      changed = true;
      return [];
    }
    if (!submission.claimedCanonicalKey && claimedKey) {
      changed = true;
      return [{ ...submission, claimedCanonicalKey: claimedKey } as T];
    }
    return [submission];
  });
  return { local: changed ? next : [...local], claimedSubmissionIds: claims.submissionIds };
}

/** One stable submission has one visible owner: canonical > Timeline outgoing > Queue. */
export function projectConversationSubmissions(
  canonical: readonly AgentConversationViewItem[],
  local: readonly LocalConversationSubmission[],
  queue: readonly ConversationQueueItem[],
): {
  timeline: LocalConversationSubmission[];
  queue: ConversationQueueItem[];
} {
  const canonicalIds = claimConversationSubmissionIds(canonical, local);
  const timelineIds = new Set(local.flatMap((entry) => (
    entry.owner === 'timeline' && !canonicalIds.has(entry.clientRequestId)
      ? [entry.clientRequestId] : []
  )));
  const durableQueueIds = new Set(queue.map(queueSubmissionId));
  const timeline = local.filter((entry) => (
    entry.owner === 'timeline' && !canonicalIds.has(entry.clientRequestId)
  ));
  const durableQueue = queue.filter((entry) => {
    const id = queueSubmissionId(entry);
    return !canonicalIds.has(id) && !timelineIds.has(id);
  });
  const optimisticQueue = local.flatMap((entry): ConversationQueueItem[] => {
    if (entry.owner !== 'queue' || canonicalIds.has(entry.clientRequestId)
      || timelineIds.has(entry.clientRequestId) || durableQueueIds.has(entry.clientRequestId)) return [];
    return [{
      id: entry.clientRequestId,
      requestId: entry.clientRequestId,
      text: entry.text,
      createdAt: entry.createdAt,
      state: entry.status === 'unknown' ? 'unknown' : 'queued',
      ...(entry.status === 'unknown' ? { dispatchOrigin: 'queue' as const } : {}),
    }];
  });
  return { timeline, queue: [...durableQueue, ...optimisticQueue] };
}

export function conversationSubmissionViewItem(
  item: LocalConversationSubmission,
): AgentConversationViewItem {
  return {
    key: `outgoing:${item.clientRequestId}`,
    provisional: true,
    live: true,
    item: {
      kind: 'message', role: 'user', correlationId: item.clientRequestId,
      content: [{ type: 'text', text: item.text }],
    },
    outgoing: {
      clientRequestId: item.clientRequestId,
      text: item.text,
      status: item.status,
      ...(item.error ? { error: item.error } : {}),
    },
  };
}

/** Keep steer outgoing at its click-time transcript occurrence while newer canonical rows arrive. */
export function projectConversationTimeline(
  canonical: readonly AgentConversationViewItem[],
  timeline: readonly LocalConversationSubmission[],
): AgentConversationViewItem[] {
  const canonicalIndexesByKey = new Map(canonical.map((entry, index) => [entry.key, index]));
  const canonicalIndexesByItemId = new Map(canonical.flatMap((entry, index) => {
    const itemId = 'id' in entry.item ? entry.item.id : undefined;
    return itemId ? [[itemId, index] as const] : [];
  }));
  const after = new Map<number, LocalConversationSubmission[]>();
  const atStart: LocalConversationSubmission[] = [];
  const atTail: LocalConversationSubmission[] = [];
  for (const entry of timeline) {
    const baselineIndex = entry.baselineTailKey === undefined
      ? undefined : canonicalIndexesByKey.get(entry.baselineTailKey);
    const durableIndex = entry.anchor?.afterItemId === undefined
      ? undefined : canonicalIndexesByItemId.get(entry.anchor.afterItemId);
    const anchorIndex = baselineIndex ?? durableIndex;
    if (anchorIndex === undefined && entry.baselineTailKey === undefined
      && (entry.baselineKeys === undefined || entry.baselineKeys.length === 0)
      && entry.anchor && entry.anchor.afterItemId === undefined) {
      atStart.push(entry);
      continue;
    }
    if (anchorIndex === undefined) {
      atTail.push(entry);
      continue;
    }
    const entries = after.get(anchorIndex) ?? [];
    entries.push(entry);
    after.set(anchorIndex, entries);
  }
  const result = atStart.map(conversationSubmissionViewItem);
  for (const [index, item] of canonical.entries()) {
    result.push(item);
    const entries = after.get(index);
    if (!entries) continue;
    result.push(...entries.map(conversationSubmissionViewItem));
  }
  result.push(...atTail.map(conversationSubmissionViewItem));
  return result;
}

/** Show immediate interrupt affordance while a local steer awaits authoritative activity. */
export function projectConversationActivity(
  activity: ConversationActivity,
  timeline: readonly LocalConversationSubmission[],
): ConversationActivity {
  if (activity !== 'idle' && activity !== 'unknown') return activity;
  return timeline.some((entry) => entry.owner === 'timeline' && entry.delivery === 'steer'
    && entry.status === 'sending')
    ? 'working' : activity;
}
