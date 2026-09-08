import type { ConversationTimelineMessage } from './conversationTimelineTypes.js';
import type { AgentConversationViewItem } from './hooks/useAgentConversation.js';
import type {
  ConversationDiff,
  ConversationToolProjection,
} from './components/ConversationTool.js';
import type {
  ConversationContentBlock,
  ConversationItem,
  ConversationItemDraft,
  ConversationTruncation,
  JsonValue,
} from './agentConversationTypes.js';

type NormalizedItem = ConversationItem | ConversationItemDraft;
type TranscriptMessage = ConversationTimelineMessage;

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue> : null;
}

export function conversationContentText(blocks: ConversationContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'json') {
      try { return JSON.stringify(block.value, null, 2); } catch { return ''; }
    }
    return block.type === 'external_link' ? block.name || block.url : block.name || '';
  }).filter(Boolean).join('\n');
}

function resources(blocks: ConversationContentBlock[]): ConversationContentBlock[] {
  return blocks.filter((block) => block.type === 'resource');
}

function itemTimestamp(item: NormalizedItem): string | undefined {
  return 'sourceCreatedAt' in item && item.sourceCreatedAt !== undefined
    ? new Date(item.sourceCreatedAt).toISOString() : undefined;
}

function presentationGroupingId(item: NormalizedItem): string | undefined {
  return item.groupingId ?? item.correlationId;
}

function itemTruncation(item: NormalizedItem): ConversationTruncation | undefined {
  return 'truncation' in item ? item.truncation : undefined;
}

function baseMessage(value: AgentConversationViewItem, index: number) {
  const { item, key } = value;
  const timestamp = itemTimestamp(item);
  const groupingId = presentationGroupingId(item);
  return {
    id: `conversation-${key}`,
    conversationAnchorId: key,
    k: index,
    ...(groupingId ? { turnId: groupingId } : {}),
    ...(timestamp ? { ts: timestamp } : {}),
    ...(value.live ? { live: true } : {}),
  };
}

function itemStatus(item: NormalizedItem) {
  if (!('status' in item) || item.status === 'complete') return {};
  return {
    conversationStatus: item.status,
    ...(item.status === 'error' && item.error?.message
      ? { conversationStatusMessage: item.error.message } : {}),
  };
}

function conversationDiff(value: JsonValue | undefined): ConversationDiff | undefined {
  const diff = jsonRecord(value);
  if (!diff || !Number.isInteger(diff.added) || !Number.isInteger(diff.removed)
    || Number(diff.added) < 0 || Number(diff.removed) < 0) return undefined;
  let hunks: ConversationDiff['hunks'] = null;
  if (diff.hunks !== null && diff.hunks !== undefined) {
    if (!Array.isArray(diff.hunks)) return undefined;
    hunks = diff.hunks.flatMap((candidate) => {
      const hunk = jsonRecord(candidate);
      const oldStart = hunk?.oldStart === null ? null : Number.isInteger(hunk?.oldStart)
        ? Number(hunk?.oldStart) : undefined;
      const newStart = hunk?.newStart === null ? null : Number.isInteger(hunk?.newStart)
        ? Number(hunk?.newStart) : undefined;
      return hunk && oldStart !== undefined && newStart !== undefined && Array.isArray(hunk.lines)
        && hunk.lines.every((line) => typeof line === 'string')
        ? [{ oldStart, newStart, lines: hunk.lines as string[] }] : [];
    });
    if (hunks.length !== diff.hunks.length) return undefined;
  }
  return {
    added: Number(diff.added), removed: Number(diff.removed), hunks,
    ...(diff.created === true ? { created: true as const } : {}),
  };
}

function nativeTool(
  item: Extract<NormalizedItem, { kind: 'tool_call' }>,
): ConversationToolProjection | null {
  const native = jsonRecord(item.extensions?.['conversation.tool']);
  if (!native || typeof native.name !== 'string' || !native.name
    || typeof native.isError !== 'boolean'
    || (native.result !== null && typeof native.result !== 'string')) return null;
  const input = Array.isArray(native.input) ? native.input : jsonRecord(native.input);
  if (!input) return null;
  const outcomes = ['running', 'success', 'failed', 'declined', 'completed'] as const;
  const outcome = native.outcome === undefined ? undefined
    : outcomes.find((candidate) => candidate === native.outcome);
  if (native.outcome !== undefined && !outcome) return null;
  const diff = native.diff === undefined ? undefined : conversationDiff(native.diff);
  if (native.diff !== undefined && !diff) return null;
  return {
    name: native.name, input, result: native.result, isError: native.isError,
    ...(outcome ? { outcome } : {}), ...(diff ? { diff } : {}),
  };
}

function normalizedTool(
  call: Extract<NormalizedItem, { kind: 'tool_call' }>,
  result: Extract<NormalizedItem, { kind: 'tool_result' }> | undefined,
  running: boolean,
  diffTruncation?: ConversationTruncation,
): ConversationToolProjection {
  const parsed = nativeTool(call);
  const inputTruncation = itemTruncation(call);
  const outputTruncation = result ? itemTruncation(result) : undefined;
  const truncations = {
    ...(inputTruncation ? { inputTruncation } : {}),
    ...(outputTruncation ? { outputTruncation } : {}),
    ...(diffTruncation ? { diffTruncation } : {}),
  };
  const isError = result?.isError === true
    || ('status' in call && call.status === 'error')
    || (!!result && 'status' in result && result.status === 'error');
  if (parsed) {
    return {
      ...parsed,
      ...(result ? { result: conversationContentText(result.content) } : {}),
      isError: result ? isError : parsed.isError || isError,
      ...(running ? { outcome: 'running' as const }
        : result ? { outcome: isError ? 'failed' as const : 'success' as const }
          : parsed.outcome ? { outcome: parsed.outcome } : {}),
      ...truncations,
    };
  }
  return {
    name: call.name,
    input: call.input !== null && typeof call.input === 'object'
      ? call.input as ConversationToolProjection['input'] : {},
    result: result ? conversationContentText(result.content) : null,
    isError,
    outcome: running ? 'running' : result ? (isError ? 'failed' : 'success') : 'completed',
    ...truncations,
  };
}

/**
 * The provider-neutral timeline projection. Provider adapters stop at normalized Conversation items;
 * presentation pairing and visibility rules live here once for every Agent.
 */
export function projectConversationMessages(
  items: AgentConversationViewItem[],
): TranscriptMessage[] {
  const results = new Map<string, AgentConversationViewItem>();
  for (const value of items) {
    if (value.item.kind === 'tool_result') results.set(value.item.callId, value);
  }
  const coveredDiffIndices = new Set<number>();
  const claimedNativeCalls = new Set<number>();
  const diffTruncations = new Map<number, ConversationTruncation>();
  items.forEach((value, diffIndex) => {
    if (value.item.kind !== 'diff') return;
    for (let callIndex = diffIndex - 1; callIndex >= 0; callIndex--) {
      if (claimedNativeCalls.has(callIndex)) continue;
      const candidate = items[callIndex]?.item;
      if (!candidate || candidate.kind !== 'tool_call') continue;
      const diffGroup = presentationGroupingId(value.item);
      const callGroup = presentationGroupingId(candidate);
      if (diffGroup && callGroup && diffGroup !== callGroup) continue;
      const tool = nativeTool(candidate);
      if (!tool?.diff) continue;
      const input = !Array.isArray(tool.input) ? tool.input : {};
      const toolPath = typeof input.file_path === 'string' ? input.file_path : null;
      if (value.item.path && toolPath && value.item.path !== toolPath) continue;
      claimedNativeCalls.add(callIndex);
      coveredDiffIndices.add(diffIndex);
      const truncation = itemTruncation(value.item);
      if (truncation) diffTruncations.set(callIndex, truncation);
      break;
    }
  });

  return items.flatMap((value, index): TranscriptMessage[] => {
    const item = value.item;
    const base = baseMessage(value, index);
    if (item.kind === 'message') {
      return [{
        ...base,
        type: 'text', role: item.role,
        text: conversationContentText(item.content),
        conversationResources: resources(item.content),
        streaming: value.provisional && item.role === 'assistant',
        completed: !value.provisional,
        ...itemStatus(item),
      }];
    }
    if (item.kind === 'reasoning_summary') {
      return [{ ...base, type: 'thinking', role: 'assistant', text: item.text }];
    }
    if (item.kind === 'tool_call') {
      const resultValue = results.get(item.callId);
      const result = resultValue?.item.kind === 'tool_result' ? resultValue.item : undefined;
      const running = value.provisional || resultValue?.provisional === true;
      return [{
        ...base,
        type: 'tool', role: 'assistant', callId: item.callId,
        tool: normalizedTool(item, result, running, diffTruncations.get(index)),
        conversationResources: result ? resources(result.content) : [],
        streaming: running,
        completed: !running,
        ...itemStatus(result ?? item),
      }];
    }
    if (item.kind === 'tool_result') {
      // A result is detail of its call, never a second top-level transcript row. If a paged/live window
      // sees the result first, keep it latent until its call enters the same bounded projection.
      return [];
    }
    if (item.kind === 'diff') {
      if (coveredDiffIndices.has(index)) return [];
      const diffTruncation = itemTruncation(item);
      return [{
        ...base, type: 'tool', role: 'assistant',
        tool: {
          name: 'apply_patch', input: item.path ? { file_path: item.path } : {},
          result: item.patch || item.summary || null,
          isError: 'status' in item && item.status === 'error', outcome: 'completed',
          ...(diffTruncation ? { diffTruncation } : {}),
        },
        ...itemStatus(item),
      }];
    }
    if (item.kind === 'compaction') return [{
      ...base, type: 'compact', role: 'assistant',
      ...(item.summary ? { summary: item.summary } : {}),
      ...('status' in item && item.status === 'truncated' ? { summaryTruncated: true } : {}),
    }];
    if (item.kind === 'interrupt') return [{ ...base, type: 'interrupt', role: 'assistant' }];
    if (item.kind === 'notice' && item.code === 'plan_updated') {
      return [{
        ...base, type: 'plan', role: 'assistant', explanation: item.message,
        plan: Array.isArray(item.extensions?.['conversation.plan'])
          ? item.extensions?.['conversation.plan'] as unknown as NonNullable<TranscriptMessage['plan']> : [],
      }];
    }
    if (item.kind === 'notice' && item.code === 'goal_updated') {
      const goal = jsonRecord(item.extensions?.['conversation.goal']);
      const event = typeof item.extensions?.['conversation.goalEvent'] === 'string'
        ? item.extensions['conversation.goalEvent'] : undefined;
      return goal ? [{
        ...base, type: 'goal', role: 'assistant',
        goal: goal as unknown as NonNullable<TranscriptMessage['goal']>,
        ...(event ? { event: event as NonNullable<TranscriptMessage['event']> } : {}),
      }] : [];
    }
    if (item.kind === 'notice' && item.code === 'slash_command') {
      const slash = jsonRecord(item.extensions?.['conversation.slash']);
      return [{
        ...base, type: 'slash', role: 'assistant',
        name: typeof slash?.name === 'string' ? slash.name : item.message,
        ...(typeof slash?.args === 'string' ? { args: slash.args } : {}),
        ...(typeof slash?.result === 'string' ? { result: slash.result } : {}),
      }];
    }
    return item.kind === 'notice'
      ? [{
        ...base, type: 'notice', role: 'assistant', text: item.message,
        noticeLevel: item.level, ...(item.code ? { noticeCode: item.code } : {}),
      }]
      : [];
  });
}
