import fs from 'node:fs';
import net from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import WebSocket from 'ws';
import { codexPlanSnapshot } from './codexPlan.js';
import { parseCodexOutboxSnapshot } from './codexQueueProtocol.js';
import {
  parseCodexGoal, parseCodexStreamEvent, projectCodexStreamEvent,
} from './codexStreamProtocol.js';
import { reconcileCodexRolloutMessages } from './codexConversationProjection.js';
import { codexAppSocketPath } from './cli/codexManaged.js';
import { isCodexSyntheticUserText } from './codexTranscriptParse.js';
import type { CodexPlanSnapshot } from './codexPlan.js';
import type {
  CodexQueueItem, CodexQueueRecord, CodexSubmissionReceipt, CodexSubmissionReceiptView,
} from './codexQueueProtocol.js';
import type {
  CodexGoal, CodexGoalEvent, CodexProjectedStreamEvent, CodexStreamEvent,
} from './codexStreamProtocol.js';

const RPC_TIMEOUT_MS = 8_000;
const SOCKET_SCAN_MS = 2_000;
const MAX_QUEUED_MESSAGES = 20;
const MAX_SUBMISSION_RECEIPTS = 256;
const SUBMISSION_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_STREAM_EVENTS = 512;
const MAX_STREAM_MESSAGE_IDS = 100;
const MAX_COMPACTOR_ITEM_KEYS = 128;
const MAX_OBSERVATION_SETUP_EVENTS = 512;
const MAX_GOAL_READ_ATTEMPTS = 3;
const CONTROL_TURN_LIMIT = 2;
const RECEIPT_RECONCILE_PAGE_LIMIT = 10;
// Resource/protocol fuse only. Valid histories are still scanned exhaustively; this permits 10,000 turns
// while preventing a broken server from growing an unbounded cursor set or issuing RPCs forever.
const MAX_RECEIPT_RECONCILE_PAGES = 1_000;
const QUEUE_EDIT_LEASE_MS = 30_000;
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);
const USER_INPUT_METHOD = 'item/tool/requestUserInput';
const SIMPLE_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
const TERMINAL_GOAL_STATUSES = new Set(['blocked', 'usageLimited', 'budgetLimited', 'complete']);
const RESUME_SNAPSHOT_INVALIDATING_METHODS = new Set([
  'item/started',
  'item/completed',
  'serverRequest/resolved',
  'thread/status/changed',
  'turn/started',
  'turn/completed',
  'thread/compacted',
  'thread/started',
]);

type UnknownRecord = Record<string, unknown>;
type StreamListener = (event: CodexStreamEvent) => void;
type ThreadStreamEvent = Exclude<CodexStreamEvent, { type: 'error' }>;
type InboxKind = 'working' | 'permission' | 'compacting' | 'done' | null;

interface AppContent extends UnknownRecord {
  type?: string;
  text?: string;
  path?: string;
  url?: string;
  imageUrl?: string;
}

interface AppFileChange extends UnknownRecord {
  path?: string;
  diff?: string;
  kind?: { type?: string; [key: string]: unknown };
}

interface AppItem extends UnknownRecord {
  id?: string;
  _handmuxId?: string;
  type?: string;
  status?: string;
  text?: string;
  content?: Array<AppContent | string>;
  summary?: string[];
  changes?: AppFileChange[];
  command?: unknown;
  cwd?: string;
  aggregatedOutput?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string; [key: string]: unknown };
  contentItems?: AppContent[];
  success?: boolean;
  receiverThreadIds?: string[];
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  agentsStates?: unknown;
  query?: string;
  action?: unknown;
  path?: string;
  durationMs?: number;
  revisedPrompt?: string;
  savedPath?: string;
  clientId?: string;
}

interface AppStatus extends UnknownRecord {
  type?: string;
  activeFlags?: string[];
}

interface AppTurn extends UnknownRecord {
  id?: string;
  status?: string;
  items?: AppItem[];
  startedAt?: number;
  completedAt?: number;
  error?: { message?: string; [key: string]: unknown };
}

interface AppThread extends UnknownRecord {
  id?: string;
  parentThreadId?: string | null;
  ephemeral?: boolean;
  turns?: AppTurn[];
  status?: AppStatus;
  createdAt?: number;
  updatedAt?: number;
  gitInfo?: { branch?: string; [key: string]: unknown };
}

interface AppSettings extends UnknownRecord {
  model?: unknown;
  modelProvider?: unknown;
  serviceTier?: unknown;
  cwd?: unknown;
  runtimeWorkspaceRoots?: unknown[] | null;
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandboxPolicy?: unknown;
  activePermissionProfile?: unknown;
  effort?: unknown;
  multiAgentMode?: unknown;
}

interface RpcParams extends UnknownRecord {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  requestId?: string | number;
  item?: AppItem;
  turn?: AppTurn;
  thread?: AppThread;
  status?: AppStatus;
  goal?: unknown;
  plan?: unknown;
  explanation?: unknown;
  delta?: string;
  availableDecisions?: unknown[];
  command?: unknown;
  cwd?: unknown;
  reason?: unknown;
  permissions?: UnknownRecord;
  questions?: unknown[];
  autoResolutionMs?: unknown;
  threadSettings?: AppSettings;
  tokenUsage?: unknown;
}

interface RpcMessage extends UnknownRecord {
  id?: string | number;
  method?: string;
  params?: RpcParams;
  result?: unknown;
  error?: unknown;
}

interface RpcResult extends UnknownRecord {
  thread?: AppThread;
  turn?: AppTurn;
  turnId?: string;
  data?: unknown[];
  nextCursor?: string | null;
  initialTurnsPage?: { data?: unknown[]; nextCursor?: string | null; [key: string]: unknown };
  userAgent?: string;
  goal?: unknown;
  model?: unknown;
  modelProvider?: unknown;
  serviceTier?: unknown;
  cwd?: unknown;
  runtimeWorkspaceRoots?: unknown[];
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandbox?: unknown;
  activePermissionProfile?: unknown;
  reasoningEffort?: unknown;
  multiAgentMode?: unknown;
}

interface TurnPage {
  turns: AppTurn[];
  nextCursor: string | null;
}

interface InternalQueueItem extends CodexQueueItem {
  clientId: string;
}

type InternalSendResult =
  | { queued: true; item: CodexQueueItem }
  | ({ queued?: false; turn?: AppTurn | null; turnId?: string } & UnknownRecord);

interface QueueEdit {
  itemId: string;
  token: string;
  expiresAt: number;
}

interface QueueState {
  items: InternalQueueItem[];
  starting: boolean;
  draining: boolean;
  steering: Set<string>;
  editing: QueueEdit | null;
  editTimer: NodeJS.Timeout | null;
}

interface InternalSubmissionReceipt extends CodexSubmissionReceipt {
  settled: boolean;
  promise: Promise<InternalSendResult | null> | null;
  result?: InternalSendResult;
}

interface StreamSnapshot {
  cursor: number;
  fingerprint: string;
  messages: UnknownRecord[];
}

interface StreamJournal {
  sequence: number;
  events: CodexProjectedStreamEvent[];
  durableFingerprints: Map<string, string>;
  liveMessageIds: Set<string>;
  snapshot: StreamSnapshot | null;
}

interface ThreadState {
  revision: number;
  eventRevision: number;
  settingsRevision: number;
  readRevision: number;
  thread: AppThread | null;
  status: AppStatus | null;
  activeTurnId: string | null;
  settings: AppSettings | null;
  activePrompt: string;
  contextUsage: { usedTokens: number; totalTokens: number } | null;
  lastTurn: AppTurn | null;
  loadedOnly: boolean;
  liveItemIds: Map<string, Set<string>>;
  completedAgentItemIds: Set<string>;
  plans: Map<string, CodexPlanSnapshot>;
  goal: CodexGoal | null | undefined;
  goalRevision: number;
  goalEvent: CodexGoalEvent | null;
  goalTurnId: string | null;
  compacting: boolean;
  compactorItemKeys: Set<string>;
  deliveryHistorySafe: boolean;
  deliveryProofClientIds: Set<string>;
}

interface PendingGoalMutation {
  token: symbol;
  turnId: string | null;
}

function compactorItemKey(turnId: string, itemId: string): string {
  return `${turnId}\0${itemId}`;
}

function rememberCompactorItem(state: ThreadState, turnId: string, itemId: string): void {
  const key = compactorItemKey(turnId, itemId);
  state.compactorItemKeys.delete(key);
  state.compactorItemKeys.add(key);
  while (state.compactorItemKeys.size > MAX_COMPACTOR_ITEM_KEYS) {
    const oldest = state.compactorItemKeys.values().next().value;
    if (typeof oldest !== 'string') break;
    state.compactorItemKeys.delete(oldest);
  }
}

interface InboxState {
  kind: InboxKind;
  msg: string;
  ts: number;
  key: string;
  correlationId?: string;
  suppressPush: boolean;
}

interface PendingRpc {
  resolve: (value: RpcResult) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

interface StreamSubscription {
  threadId: string;
  listener: StreamListener;
}

interface CodexAppConnectionOptions {
  pane: string;
  socketPath: string;
  connect?: typeof connectUnixWebSocket;
  timeoutMs?: number;
  now?: () => number;
  baseline?: boolean;
  onStateChange?: (pane: string) => unknown;
  onClose?: (connection: CodexAppConnection) => void;
  onThreadBind?: (connection: CodexAppConnection, threadId: string) => void | Promise<void>;
  queueStore?: Map<string, QueueState>;
  submissionStore?: Map<string, InternalSubmissionReceipt>;
  nextQueueId?: () => string;
  persistOutbox?: () => unknown;
  streamEventStore?: Map<string, StreamJournal>;
}

interface StructuredDecision extends UnknownRecord {
  id: string;
  type: 'execpolicy' | 'networkPolicy';
  rule?: string[];
  host?: string;
  action?: 'allow' | 'deny';
}

export interface NormalizedApproval {
  id: string;
  type: 'permissions' | 'file' | 'command';
  threadId: string;
  turnId?: string;
  itemId?: string;
  correlationId?: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  decisions: Array<string | StructuredDecision>;
}

export interface NormalizedQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export interface NormalizedUserInput {
  id: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  correlationId?: string;
  autoResolutionMs: unknown;
  questions: NormalizedQuestion[];
}

interface ScanTimer { unref?(): void }

export interface CodexInteractionSnapshot {
  cursor: number;
  approvals: NormalizedApproval[];
  userInputs: NormalizedUserInput[];
  disconnected?: true;
}

type InteractionSnapshotListener = (snapshot: CodexInteractionSnapshot) => void;
interface InteractionSubscription {
  threadId: string;
  listener: InteractionSnapshotListener;
}

interface CodexAppServerOptions {
  home?: string;
  connect?: typeof connectUnixWebSocket;
  exists?: typeof fs.existsSync;
  readdir?: (path: fs.PathLike) => string[];
  now?: () => number;
  onStateChange?: (pane: string) => unknown;
  scanIntervalMs?: number;
  setTimer?: (callback: () => void, delay: number) => ScanTimer;
  clearTimer?: (timer: ScanTimer) => void;
  outboxStore?: {
    read?: () => unknown;
    readStrict?: () => unknown;
    write?: (value: unknown) => unknown;
    quarantine?: () => unknown;
  } | null;
  rpcTimeoutMs?: number;
}

interface LivePane extends UnknownRecord { id: string }

interface CodexAppStatus extends UnknownRecord {
  managed: boolean;
  queue: CodexQueueItem[];
  receipts: CodexSubmissionReceiptView[];
  approvals: NormalizedApproval[];
  userInputs: NormalizedUserInput[];
}

export interface CodexDebugTool extends UnknownRecord {
  name: string;
  input: UnknownRecord;
  result: unknown;
  isError: boolean;
  outcome?: string;
}

export interface CodexDebugMessage extends UnknownRecord {
  id: string;
  k: number;
  type: string;
  role?: string;
  text?: string;
  tool?: CodexDebugTool;
  ts?: string;
}

function recordOf(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function rpcMessageOf(value: unknown): RpcMessage | null {
  const record = recordOf(value);
  if (!record) return null;
  if (record.id != null && typeof record.id !== 'string' && typeof record.id !== 'number') return null;
  if (record.method != null && typeof record.method !== 'string') return null;
  const params = record.params == null ? undefined : recordOf(record.params);
  if (record.params != null && !params) return null;
  return { ...record, ...(params ? { params: params as RpcParams } : {}) } as RpcMessage;
}

function rpcResultOf(value: unknown): RpcResult {
  return recordOf(value) as RpcResult | null ?? {};
}

function structuredDecision(value: unknown, index: number): StructuredDecision | null {
  const record = recordOf(value);
  const amendment = recordOf(record?.acceptWithExecpolicyAmendment);
  const execpolicy = amendment?.execpolicy_amendment;
  if (Array.isArray(execpolicy) && execpolicy.length && execpolicy.every((part) => typeof part === 'string')) {
    return { id: `structured:${index}`, type: 'execpolicy', rule: execpolicy };
  }
  const networkRoot = recordOf(record?.applyNetworkPolicyAmendment);
  const network = recordOf(networkRoot?.network_policy_amendment);
  if (network && typeof network.host === 'string'
    && (network.action === 'allow' || network.action === 'deny')) {
    return { id: `structured:${index}`, type: 'networkPolicy', host: network.host, action: network.action };
  }
  return null;
}

function approvalDecision(value: unknown, index: number): string | StructuredDecision | null {
  return typeof value === 'string' && SIMPLE_DECISIONS.has(value)
    ? value
    : structuredDecision(value, index);
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  const record = recordOf(error);
  if (typeof record?.message === 'string') return new Error(record.message);
  return new Error(typeof error === 'string' ? error : JSON.stringify(error));
}

function codexVersion(userAgent: string | null): [number, number, number] | null {
  const match = userAgent?.match(
    /^[a-z0-9._-]+\/v?(\d+)\.(\d+)\.(\d+)(?=$|[\s;(])/i,
  );
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function supportsBoundedTurns(userAgent: string | null): boolean {
  const version = codexVersion(userAgent);
  if (!version) return false;
  const [major, minor] = version;
  return major > 0 || minor >= 149;
}

function boundedTurnParams(limit = CONTROL_TURN_LIMIT, cursor: string | null = null): UnknownRecord {
  return {
    limit,
    sortDirection: 'desc',
    itemsView: 'summary',
    ...(cursor ? { cursor } : {}),
  };
}

function turnPage(value: unknown): TurnPage {
  const page = recordOf(value);
  if (!page || !Array.isArray(page.data)
    || !page.data.every((turn) => recordOf(turn) != null)
    || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) {
    throw new Error('Codex App Server returned an invalid turn page');
  }
  return {
    turns: page.data.map((turn) => recordOf(turn) as AppTurn).reverse(),
    nextCursor: page.nextCursor,
  };
}

function largeThreadUpgradeError(error: unknown, userAgent: string | null): Error {
  const failure = asError(error);
  if (supportsBoundedTurns(userAgent)
    || !failure.message.toLowerCase().includes('max payload size exceeded')) return failure;
  const version = codexVersion(userAgent)?.join('.') || 'unknown';
  return new Error(
    `Codex CLI ${version} cannot safely resume this large conversation; upgrade Codex CLI to 0.149.0 or newer`,
  );
}

function deliveryReconcileError(): Error {
  return new Error(
    'Codex send receipt could not be reconciled safely; retry after the conversation becomes idle',
  );
}

function isMissingThreadRollout(error: unknown): boolean {
  const message = asError(error).message.toLowerCase();
  return message.includes('no rollout found') || (
    message.includes('failed to read session metadata')
    && message.includes('rollout')
    && message.includes('is empty')
  );
}

function inputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    const record = recordOf(item);
    if (!record) return '';
    if (record.type === 'text' || record.type === 'inputText') return typeof record.text === 'string' ? record.text : '';
    if (record.type === 'localImage') return typeof record.path === 'string' ? record.path : '';
    if (record.type === 'image') return typeof record.url === 'string' ? record.url : '';
    return '';
  }).filter(Boolean).join('\n');
}

function userPromptFromItem(item: AppItem | null | undefined): string {
  if (item?.type !== 'userMessage') return '';
  const text = inputText(item.content).trim();
  return text && !isCodexSyntheticUserText(text) ? text : '';
}

function deliveredClientMessages(source: AppThread | AppTurn | AppItem | null | undefined): Map<string, string | null> {
  const turns = Array.isArray(source?.turns)
    ? source.turns
    : (Array.isArray(source?.items) ? [source] : []);
  if (source?.type === 'userMessage') turns.push({ items: [source] });
  const delivered = new Map<string, string | null>();
  for (const turn of turns) {
    for (const item of turn?.items || []) {
      if (item?.type === 'userMessage' && typeof item.clientId === 'string' && item.clientId) {
        delivered.set(item.clientId, turn?.id || null);
      }
    }
  }
  return delivered;
}

function diffInfo(change: AppFileChange | null | undefined) {
  const lines = String(change?.diff || '').split('\n');
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  const kind = change?.kind?.type;
  return {
    added,
    removed,
    hunks: change?.diff ? [{ oldStart: 0, newStart: 0, lines }] : null,
    ...(kind === 'add' ? { created: true } : {}),
  };
}

function jsonText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

function collabToolName(tool: string | undefined): string {
  const names: Record<string, string> = {
    spawnAgent: 'spawn_agent',
    sendInput: 'send_message',
    resumeAgent: 'followup_task',
    wait: 'wait_agent',
    closeAgent: 'interrupt_agent',
  };
  return (tool ? names[tool] : undefined) || `collaboration:${tool || 'agent'}`;
}

function toolFromItem(item: AppItem, fileChange: AppFileChange = item.changes?.[0] || {}) {
  if (item.type === 'commandExecution') {
    return {
      name: 'exec_command',
      input: { cmd: item.command, cwd: item.cwd },
      result: item.status === 'inProgress' ? null : (item.aggregatedOutput || ''),
      isError: item.status === 'failed',
      outcome: item.status === 'declined' ? 'declined' : item.status === 'failed' ? 'failed'
        : item.status === 'completed' ? 'success' : 'running',
    };
  }
  if (item.type === 'fileChange') {
    return {
      name: 'apply_patch',
      input: { file_path: fileChange.path || '', patch: fileChange.diff || '' },
      result: item.status === 'inProgress' ? null : (item.status === 'completed' ? '' : item.status),
      isError: item.status === 'failed',
      outcome: item.status === 'declined' ? 'declined' : item.status === 'failed' ? 'failed'
        : item.status === 'completed' ? 'success' : 'running',
      diff: diffInfo(fileChange),
    };
  }
  if (item.type === 'mcpToolCall') {
    return {
      name: `${item.server || 'mcp'}:${item.tool || 'tool'}`,
      input: item.arguments && typeof item.arguments === 'object' ? item.arguments : { value: item.arguments },
      result: item.status === 'inProgress' ? null : (item.error?.message || JSON.stringify(item.result || '', null, 2)),
      isError: item.status === 'failed',
    };
  }
  if (item.type === 'dynamicToolCall') {
    return {
      name: item.tool || 'tool',
      input: item.arguments && typeof item.arguments === 'object' ? item.arguments : { value: item.arguments },
      result: item.status === 'inProgress' ? null : (item.contentItems || []).map((part) => part?.text || part?.imageUrl || '').filter(Boolean).join('\n'),
      isError: item.status === 'failed' || item.success === false,
      outcome: item.status === 'inProgress' ? 'running'
        : item.status === 'failed' || item.success === false ? 'failed'
          : item.success === true ? 'success' : 'completed',
    };
  }
  if (item.type === 'collabAgentToolCall') {
    return {
      name: collabToolName(item.tool),
      input: {
        target: item.receiverThreadIds?.join(', ') || undefined,
        prompt: item.prompt || undefined,
        model: item.model || undefined,
        reasoning_effort: item.reasoningEffort || undefined,
      },
      result: item.status === 'inProgress' ? null : jsonText(item.agentsStates),
      isError: item.status === 'failed',
    };
  }
  if (item.type === 'webSearch') {
    return {
      name: 'web__run',
      input: { query: item.query, action: item.action || undefined },
      result: item.results == null ? null : jsonText(item.results),
      isError: false,
    };
  }
  if (item.type === 'imageView') {
    return { name: 'view_image', input: { path: item.path }, result: '', isError: false };
  }
  if (item.type === 'sleep') {
    return { name: 'wait', input: { duration_ms: item.durationMs }, result: '', isError: false };
  }
  if (item.type === 'imageGeneration') {
    return {
      name: 'image_gen__imagegen',
      input: { prompt: item.revisedPrompt || undefined },
      result: item.status === 'inProgress' ? null : (item.savedPath || item.result || ''),
      isError: item.status === 'failed',
    };
  }
  return null;
}

function projectedMessageId(turn: AppTurn, turnIndex: number, item: AppItem, itemIndex: number): string {
  const turnId = turn?.id || `turn-${turnIndex}`;
  // When a completed snapshot canonicalizes a live notification under a different item id, retain the
  // connection-local first id. It is identity metadata only; all content/order still comes from snapshot.
  const itemId = item?._handmuxId || item?.id || `item-${itemIndex}`;
  return `codex:${turnId}:${itemId}`;
}

// Project App Server's partial item snapshot for connection-level tests/debugging. This is deliberately not
// the conversation transcript source: current App Server snapshots can omit completed tools. The durable
// transcript route reads Codex's exact rollout instead.
export function projectCodexThread(value: unknown): CodexDebugMessage[] {
  const thread = recordOf(value) as AppThread | null;
  const messages: Array<{ id: string; type: string; [key: string]: unknown }> = [];
  for (const [turnIndex, turn] of (thread?.turns || []).entries()) {
    const ts = typeof turn.startedAt === 'number' ? new Date(turn.startedAt * 1000).toISOString() : undefined;
    for (const [itemIndex, item] of (turn.items || []).entries()) {
      const id = projectedMessageId(turn, turnIndex, item, itemIndex);
      if (item.type === 'userMessage') {
        const text = inputText(item.content);
        if (text.trim()) messages.push({ id, type: 'text', role: 'user', text, ts });
      } else if (item.type === 'agentMessage') {
        if (item.text?.trim()) messages.push({ id, type: 'text', role: 'assistant', text: item.text, ts });
      } else if (item.type === 'reasoning') {
        const text = [...(item.summary || []), ...(item.content || [])].join('\n');
        if (text.trim()) messages.push({ id, type: 'thinking', role: 'assistant', text, ts });
      } else if (item.type === 'contextCompaction') {
        messages.push({ id, type: 'compact', ts });
      } else if (item.type === 'fileChange') {
        const changes = item.changes?.length ? item.changes : [{}];
        const pathCounts = new Map();
        for (const [changeIndex, change] of changes.entries()) {
          const path = change?.path || '';
          const occurrence = pathCounts.get(path) || 0;
          pathCounts.set(path, occurrence + 1);
          const changeId = path
            ? `${id}:change-${encodeURIComponent(path)}-${occurrence}`
            : `${id}:change-${changeIndex}`;
          messages.push({ id: changeId, type: 'tool', role: 'assistant', tool: toolFromItem(item, change), ts });
        }
      } else {
        const tool = toolFromItem(item);
        if (tool) messages.push({ id, type: 'tool', role: 'assistant', tool, ts });
      }
    }
    if (turn.status === 'interrupted') {
      messages.push({ id: `codex:${turn?.id || `turn-${turnIndex}`}:interrupt`, type: 'interrupt', ts });
    }
  }
  return messages.map((message, k): CodexDebugMessage => ({ ...message, k }));
}

function normalizeApproval(message: RpcMessage): NormalizedApproval {
  const { params = {} } = message;
  const permissions = message.method === 'item/permissions/requestApproval';
  const supplied = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.map(approvalDecision)
      .filter((decision): decision is string | StructuredDecision => decision != null)
    : null;
  return {
    id: String(message.id),
    type: permissions ? 'permissions' : message.method === 'item/fileChange/requestApproval' ? 'file' : 'command',
    threadId: params.threadId!,
    ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
    ...(typeof params.itemId === 'string' ? { itemId: params.itemId } : {}),
    ...(typeof params.itemId === 'string' ? { correlationId: params.itemId }
      : typeof params.turnId === 'string' ? { correlationId: params.turnId } : {}),
    command: typeof params.command === 'string' ? params.command : null,
    cwd: typeof params.cwd === 'string' ? params.cwd : null,
    reason: typeof params.reason === 'string' ? params.reason : null,
    decisions: permissions
      ? ['accept', 'acceptForSession', 'decline']
      : supplied || ['accept', 'acceptForSession', 'decline', 'cancel'],
  };
}

function resolveApprovalDecision(request: RpcMessage, selected: string): unknown | null {
  const available = request.params?.availableDecisions;
  if (!Array.isArray(available)) return SIMPLE_DECISIONS.has(selected) ? selected : null;
  if (SIMPLE_DECISIONS.has(selected)) {
    return available.includes(selected) ? selected : null;
  }
  const match = /^structured:(\d+)$/.exec(selected);
  if (!match) return null;
  const index = Number(match[1]);
  const value = available[index];
  return structuredDecision(value, index)?.id === selected ? value : null;
}

function permissionResponse(request: RpcMessage, decision: string) {
  const requested = request.params?.permissions || {};
  const permissions: UnknownRecord = {};
  if (decision !== 'decline') {
    if (requested.network != null) permissions.network = requested.network;
    if (requested.fileSystem != null) permissions.fileSystem = requested.fileSystem;
  }
  return { permissions, scope: decision === 'acceptForSession' ? 'session' : 'turn' };
}

function normalizeUserInput(message: RpcMessage): NormalizedUserInput {
  const { params = {} } = message;
  return {
    id: String(message.id),
    threadId: params.threadId!,
    ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
    ...(typeof params.itemId === 'string' ? { itemId: params.itemId } : {}),
    ...(typeof params.itemId === 'string' ? { correlationId: params.itemId }
      : typeof params.turnId === 'string' ? { correlationId: params.turnId } : {}),
    autoResolutionMs: params.autoResolutionMs ?? null,
    questions: Array.isArray(params.questions) ? params.questions.map((value) => {
      const question = recordOf(value) || {};
      return {
      id: String(question.id || ''),
      header: String(question.header || ''),
      question: String(question.question || ''),
      isOther: !!question.isOther,
      isSecret: !!question.isSecret,
      options: Array.isArray(question.options) ? question.options.map((value) => {
        const option = recordOf(value) || {};
        return {
        label: String(option.label || ''),
        description: String(option.description || ''),
      }; }) : null,
    }; }).filter((question) => question.id && question.question) : [],
  };
}

function turnAssistantSummary(turn: AppTurn | null | undefined): string {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const message = [...items].reverse().find((item) => item?.type === 'agentMessage' && item.text?.trim());
  return message?.text || '';
}

function turnSummary(turn: AppTurn | null | undefined): string {
  return turnAssistantSummary(turn) || turn?.error?.message || '';
}

function inboxTurnSummary(
  canonicalTurn: AppTurn | null | undefined,
  mergedTurn: AppTurn | null | undefined,
): string {
  return turnAssistantSummary(canonicalTurn) || turnSummary(mergedTurn);
}

function turnPrompt(turn: AppTurn | null | undefined): string {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index--) {
    const prompt = userPromptFromItem(items[index]);
    if (prompt) return prompt;
  }
  return '';
}

function activeTurnPrompt(state: ThreadState | null | undefined): string {
  if (state?.activePrompt) return state.activePrompt;
  const turns = Array.isArray(state?.thread?.turns) ? state.thread.turns : [];
  const active = state?.activeTurnId
    ? turns.find((turn) => turn.id === state.activeTurnId)
    : [...turns].reverse().find((turn) => turn.status === 'inProgress');
  return turnPrompt(active);
}

function activeKind(status: AppStatus | null | undefined): InboxKind {
  if (status?.type !== 'active') return null;
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  return flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput') ? 'permission' : 'working';
}

function liveItemSignature(item: AppItem | null | undefined): string | null {
  if (item?.type === 'userMessage') {
    const text = inputText(item.content);
    return text ? `userMessage\0${text}` : null;
  }
  if (item?.type === 'agentMessage') {
    return item.text ? `agentMessage\0${item.text}` : null;
  }
  if (item?.type === 'commandExecution') return `commandExecution\0${jsonText(item.command)}\0${item.cwd || ''}`;
  if (item?.type === 'fileChange') {
    return `fileChange\0${(item.changes || []).map((change) => change?.path || '').join('\0')}`;
  }
  if (item?.type === 'mcpToolCall') return `mcpToolCall\0${item.server || ''}\0${item.tool || ''}\0${jsonText(item.arguments)}`;
  if (item?.type === 'dynamicToolCall') return `dynamicToolCall\0${item.tool || ''}\0${jsonText(item.arguments)}`;
  if (item?.type === 'collabAgentToolCall') {
    return `collabAgentToolCall\0${item.tool || ''}\0${item.prompt || ''}\0${jsonText(item.receiverThreadIds)}`;
  }
  if (item?.type === 'webSearch') return `webSearch\0${item.query || ''}\0${jsonText(item.action)}`;
  if (item?.type === 'imageView') return `imageView\0${item.path || ''}`;
  if (item?.type === 'sleep') return `sleep\0${item.durationMs ?? ''}`;
  if (item?.type === 'imageGeneration') return `imageGeneration\0${item.revisedPrompt || ''}`;
  return null;
}

// Keep a best-effort connection snapshot for status/debugging only. Item notifications temporarily overlay
// thread/read so this internal view remains useful; neither channel feeds the conversation transcript.
function mergeTurnWithLive(
  previous: AppTurn | null | undefined,
  fresh: AppTurn,
  liveIds: Set<string> | undefined,
): AppTurn {
  if (!previous) return fresh;
  const previousById = new Map((previous.items || []).filter((item) => item?.id).map((item) => [item.id, item]));
  const freshItems = (Array.isArray(fresh?.items) ? fresh.items : []).map((item) => {
    const stableId = previousById.get(item?.id)?._handmuxId;
    return stableId && !item._handmuxId ? { ...item, _handmuxId: stableId } : item;
  });
  if (!liveIds?.size) return { ...previous, ...fresh, items: freshItems };
  const freshById = new Map(freshItems.filter((item) => item?.id).map((item) => [item.id, item]));
  const freshMatches = new Map<string, AppItem[]>();
  for (const item of freshItems) {
    const signature = liveItemSignature(item);
    if (!signature || !item?.id) continue;
    if (!freshMatches.has(signature)) freshMatches.set(signature, []);
    freshMatches.get(signature)!.push(item);
  }
  const matchedFreshIds = new Set((previous.items || [])
    .filter((item) => item?.id && !liveIds.has(item.id) && freshById.has(item.id))
    .map((item) => item.id));
  const overlays: AppItem[] = [];
  for (const item of previous.items || []) {
    if (!item?.id || !liveIds.has(item.id)) continue;
    const sameId = freshById.get(item.id);
    const signature = sameId ? null : liveItemSignature(item);
    const canonical = sameId || (signature
      ? freshMatches.get(signature)?.find((candidate) => !matchedFreshIds.has(candidate.id))
      : null);
    if (canonical) {
      if (canonical.id !== item.id && !canonical._handmuxId) {
        const index = freshItems.findIndex((candidate) => candidate?.id === canonical.id);
        if (index >= 0) freshItems[index] = { ...canonical, _handmuxId: item._handmuxId || item.id };
      }
      matchedFreshIds.add(canonical.id);
      liveIds.delete(item.id);
    } else {
      overlays.push(item);
    }
  }
  // For this partial internal view, prefer fresh snapshot order and retain event-only tail items.
  const seen = new Set(freshItems.map((item) => item?.id).filter(Boolean));
  return {
    ...previous,
    ...fresh,
    items: [...freshItems, ...overlays.filter((item) => item?.id && !seen.has(item.id))],
  };
}

function mergeThreadWithLive(
  previous: AppThread | null,
  fresh: AppThread | undefined,
  liveItemIds: Map<string, Set<string>>,
): AppThread | null {
  if (!previous || !fresh) return fresh ?? null;
  const previousTurns = new Map((previous.turns || [])
    .filter((turn): turn is AppTurn & { id: string } => typeof turn.id === 'string')
    .map((turn) => [turn.id, turn]));
  const seen = new Set<string>();
  const turns = (fresh.turns || []).map((turn) => {
    const turnId = turn.id;
    if (!turnId) return mergeTurnWithLive(undefined, turn, undefined);
    seen.add(turnId);
    const merged = mergeTurnWithLive(previousTurns.get(turnId), turn, liveItemIds.get(turnId));
    if (liveItemIds.get(turnId)?.size === 0) liveItemIds.delete(turnId);
    return merged;
  });
  for (const turn of previous.turns || []) {
    if (turn.id && !seen.has(turn.id) && liveItemIds.has(turn.id)) turns.push(turn);
  }
  return { ...previous, ...fresh, turns };
}

function settingsFromResume(result: RpcResult): AppSettings {
  return {
    model: result?.model || null,
    modelProvider: result?.modelProvider || null,
    serviceTier: result?.serviceTier ?? null,
    cwd: result?.cwd || null,
    runtimeWorkspaceRoots: Array.isArray(result?.runtimeWorkspaceRoots) ? result.runtimeWorkspaceRoots : null,
    approvalPolicy: result?.approvalPolicy || null,
    approvalsReviewer: result?.approvalsReviewer || null,
    sandboxPolicy: result?.sandbox || null,
    activePermissionProfile: result?.activePermissionProfile ?? null,
    effort: result?.reasoningEffort ?? null,
    multiAgentMode: result?.multiAgentMode || null,
  };
}

function contextUsageFromNotification(tokenUsage: unknown): { usedTokens: number; totalTokens: number } | null {
  const usage = recordOf(tokenUsage);
  const usedTokens = recordOf(usage?.last)?.totalTokens;
  const totalTokens = usage?.modelContextWindow;
  if (typeof usedTokens !== 'number' || !Number.isFinite(usedTokens) || usedTokens < 0
    || typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens <= 0) return null;
  return { usedTokens, totalTokens };
}

function connectUnixWebSocket(socketPath: string): WebSocket {
  return new WebSocket('ws://localhost/rpc', {
    createConnection: () => net.createConnection(socketPath),
    perMessageDeflate: false,
  });
}

class CodexAppConnection {
  readonly pane: string;
  readonly socketPath: string;
  readonly connect: typeof connectUnixWebSocket;
  readonly timeoutMs: number;
  readonly onClose: (connection: CodexAppConnection) => void;
  readonly onThreadBind: (connection: CodexAppConnection, threadId: string) => void | Promise<void>;
  readonly now: () => number;
  baseline: boolean;
  readonly onStateChange: (pane: string) => unknown;
  readonly queueStore: Map<string, QueueState>;
  readonly submissionStore: Map<string, InternalSubmissionReceipt>;
  readonly nextQueueId: () => string;
  readonly persistOutbox: () => unknown;
  readonly streamEventStore: Map<string, StreamJournal>;
  nextId: number;
  readonly pending: Map<string | number, PendingRpc>;
  readonly approvals: Map<string, RpcMessage>;
  readonly userInputs: Map<string, RpcMessage>;
  readonly streamListeners: Set<StreamSubscription>;
  readonly interactionListeners: Set<InteractionSubscription>;
  readonly threadState: Map<string, ThreadState>;
  readonly ensuringThreads: Map<string, Promise<ThreadState>>;
  readonly pendingGoalMutations: Map<string, PendingGoalMutation[]>;
  readonly goalWriteTails: Map<string, Promise<void>>;
  readonly goalReadTails: Map<string, Promise<void>>;
  readonly subscribed: Set<string>;
  lastStartedThreadId: string | null;
  currentThreadId: string | null;
  threadBindingKnown: boolean;
  inbox: InboxState;
  opening: Promise<this> | null;
  closed: boolean;
  appServerUserAgent: string | null;
  boundedTurns: boolean;
  ws?: WebSocket;

  constructor({
    pane, socketPath, connect = connectUnixWebSocket, timeoutMs = RPC_TIMEOUT_MS,
    now = () => Date.now(), baseline = true, onStateChange = () => {}, onClose = () => {},
    onThreadBind = () => {},
    queueStore = new Map(), submissionStore = new Map(), nextQueueId = () => `${Date.now()}`,
    persistOutbox = () => {}, streamEventStore = new Map(),
  }: CodexAppConnectionOptions) {
    this.pane = pane;
    this.socketPath = socketPath;
    this.connect = connect;
    this.timeoutMs = timeoutMs;
    this.onClose = onClose;
    this.onThreadBind = onThreadBind;
    this.now = now;
    this.baseline = baseline;
    this.onStateChange = onStateChange;
    this.queueStore = queueStore;
    this.submissionStore = submissionStore;
    this.nextQueueId = nextQueueId;
    this.persistOutbox = persistOutbox;
    this.streamEventStore = streamEventStore;
    this.nextId = 1;
    this.pending = new Map();
    this.approvals = new Map();
    this.userInputs = new Map();
    this.streamListeners = new Set();
    this.interactionListeners = new Set();
    this.threadState = new Map();
    this.ensuringThreads = new Map();
    this.pendingGoalMutations = new Map();
    this.goalWriteTails = new Map();
    this.goalReadTails = new Map();
    this.subscribed = new Set();
    this.lastStartedThreadId = null;
    this.currentThreadId = null;
    this.threadBindingKnown = false;
    this.inbox = { kind: null, msg: '', ts: 0, key: 'idle', suppressPush: false };
    this.opening = null;
    this.closed = false;
    this.appServerUserAgent = null;
    this.boundedTurns = false;
  }

  open(): Promise<this> {
    if (this.opening) return this.opening;
    this.opening = this._open().catch((error) => {
      this.fail(error);
      throw error;
    });
    return this.opening;
  }

  async _open(): Promise<this> {
    const ws = this.connect(this.socketPath);
    this.ws = ws;
    ws.on('message', (data) => this.onLine(data.toString()));
    ws.once('close', () => this.fail(new Error('Codex App Server connection closed')));
    // Keep a lifetime error listener, not only the startup rejector: otherwise a stale socket that errors
    // once during connect and again while closing can become an unhandled EventEmitter error.
    ws.on('error', (error) => this.fail(error));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onOpen = (): void => finish(resolve);
      const onError = (error: unknown): void => finish(() => reject(asError(error)));
      const onClose = (): void => finish(() => reject(new Error('Codex App Server connection closed')));
      const timer = setTimeout(() => {
        finish(() => reject(new Error('Codex App Server timed out: open')));
      }, Math.max(1, this.timeoutMs));
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('error', onError);
        ws.off('close', onClose);
        callback();
      };
      timer.unref?.();
      ws.once('open', onOpen);
      ws.once('error', onError);
      ws.once('close', onClose);
    });
    const initialized = await this.rpc('initialize', {
      clientInfo: { name: 'handmux', title: 'Handmux', version: process.env.npm_package_version || 'unknown' },
      capabilities: { experimentalApi: true },
    });
    this.appServerUserAgent = typeof initialized.userAgent === 'string' ? initialized.userAgent : null;
    this.boundedTurns = supportsBoundedTurns(this.appServerUserAgent);
    this.notify('initialized', {});
    return this;
  }

  onLine(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch { return; }
    const message = rpcMessageOf(value);
    if (!message) return;
    if (message.id != null && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(asError(message.error));
      else waiter.resolve(rpcResultOf(message.result));
      return;
    }
    if (message.id != null && message.method && APPROVAL_METHODS.has(message.method)) {
      if (!message.params?.threadId) return;
      this.approvals.set(String(message.id), message);
      const approval = normalizeApproval(message);
      this.markWaiting(approval.threadId, 'waitingOnApproval');
      if (this.isCurrentThread(approval.threadId)) {
        this.setInbox(
          'permission',
          approval.reason || approval.command || activeTurnPrompt(this.state(approval.threadId)),
          `approval:${message.id}`,
          undefined,
          approval.correlationId,
        );
      }
      this.bumpEvent(message.params?.threadId);
      this.emitInteractionSnapshot(message.params.threadId);
      return;
    }
    if (message.id != null && message.method === USER_INPUT_METHOD) {
      if (!message.params?.threadId) return;
      this.userInputs.set(String(message.id), message);
      const input = normalizeUserInput(message);
      this.markWaiting(input.threadId, 'waitingOnUserInput');
      if (this.isCurrentThread(input.threadId)) {
        this.setInbox(
          'permission',
          input.questions[0]?.question || activeTurnPrompt(this.state(input.threadId)),
          `input:${message.id}`,
          undefined,
          input.correlationId,
        );
      }
      this.bumpEvent(message.params?.threadId);
      this.emitInteractionSnapshot(message.params.threadId);
      return;
    }
    if (!message.method) return;
    const rawParams = message.params || {};
    const inferredThreadId = rawParams.threadId
      || (message.method === 'thread/started' ? rawParams.thread?.id : undefined);
    const params: RpcParams = inferredThreadId
      ? { ...rawParams, threadId: inferredThreadId }
      : rawParams;
    if (!params.threadId) return;
    if ((message.method === 'item/started' || message.method === 'item/completed') && params.item) {
      this.upsertLiveItem(params.threadId, params.turnId, params.item);
      const state = this.state(params.threadId);
      if (message.method === 'item/started' && params.item.type === 'contextCompaction') {
        state.compacting = true;
      } else if (message.method === 'item/completed' && params.item.type === 'contextCompaction') {
        state.compacting = false;
      }
      if (params.item.type === 'agentMessage') {
        if (state.compacting && params.turnId && params.item.id) {
          rememberCompactorItem(state, params.turnId, params.item.id);
        }
        const itemKey = `${params.turnId}\0${params.item.id}`;
        if (message.method === 'item/completed') state.completedAgentItemIds.add(itemKey);
        else state.completedAgentItemIds.delete(itemKey);
        this.emitStream({
          type: message.method === 'item/started' ? 'started' : 'completed',
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.item.id,
          text: params.item.text || '',
        });
      }
      const prompt = userPromptFromItem(params.item);
      if (prompt && state.activeTurnId === params.turnId) {
        state.activePrompt = prompt;
        if (this.isCurrentThread(params.threadId)
          && this.inbox.kind !== 'permission' && this.inbox.kind !== 'compacting') {
          this.setInbox('working', prompt, `turn:${params.turnId}:started`);
        }
      }
    } else if (message.method === 'item/agentMessage/delta') {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (params.threadId && params.turnId && params.itemId && delta) {
        this.appendAgentDelta(params.threadId, params.turnId, params.itemId, delta);
        this.emitStream({
          type: 'delta', threadId: params.threadId, turnId: params.turnId,
          itemId: params.itemId, delta,
        });
      }
    } else if (message.method === 'turn/plan/updated') {
      const state = this.state(params.threadId);
      const plan = codexPlanSnapshot(params.turnId, params.plan, params.explanation);
      if (plan) state.plans.set(plan.turnId, plan);
      else if (params.turnId) state.plans.delete(params.turnId);
      while (state.plans.size > 20) {
        const oldest = state.plans.keys().next().value;
        if (!oldest) break;
        state.plans.delete(oldest);
      }
    } else if (message.method === 'serverRequest/resolved') {
      const requestKey = String(params.requestId);
      const native = this.approvals.get(requestKey) ?? this.userInputs.get(requestKey);
      const correlationId = native?.method === USER_INPUT_METHOD
        ? normalizeUserInput(native).correlationId : native ? normalizeApproval(native).correlationId : undefined;
      this.approvals.delete(String(params.requestId));
      this.userInputs.delete(String(params.requestId));
      this.markWorking(params.threadId);
      if (this.isCurrentThread(params.threadId)) {
        this.setInbox(
          'working', activeTurnPrompt(this.state(params.threadId)) || this.inbox.msg,
          `resolved:${params.requestId}`,
          undefined,
          correlationId,
        );
      }
    } else if (message.method === 'thread/status/changed') {
      const state = this.state(params.threadId);
      state.status = params.status ?? null;
      const kind = activeKind(params.status);
      if (!this.isCurrentThread(params.threadId)) {
        /* retain the state for that thread, but never let a late background event rebind this pane */
      } else if (kind === 'working' && this.inbox.kind === 'compacting') {
        /* keep the more specific state until thread/compacted or idle */
      } else if (kind) {
        const pendingMessage = kind === 'permission' && this.inbox.kind === kind ? this.inbox.msg : '';
        const activeMessage = activeTurnPrompt(state)
          || (this.inbox.kind === 'working' || this.inbox.kind === 'permission' ? this.inbox.msg : '');
        this.setInbox(
          kind, pendingMessage || activeMessage, `status:${params.threadId}:${kind}`,
          undefined, kind === 'permission' ? this.inbox.correlationId : undefined,
        );
      } else if (params.status?.type === 'idle' && this.inbox.kind === 'compacting') {
        state.compacting = false;
        this.setInbox(null, '', `thread:${params.threadId}:compacted`);
      }
    } else if (message.method === 'turn/started') {
      const state = this.state(params.threadId);
      const previousTurnId = state.activeTurnId;
      state.activeTurnId = params.turn?.id || params.turnId || null;
      state.status = { type: 'active', activeFlags: [] };
      const turn = this.upsertTurn(params.threadId, params.turn);
      const prompt = turnPrompt(turn);
      if (prompt) state.activePrompt = prompt;
      else if (previousTurnId && previousTurnId !== state.activeTurnId) state.activePrompt = '';
      if (this.isCurrentThread(params.threadId)) {
        this.setInbox(
          'working', activeTurnPrompt(state),
          `turn:${params.turn?.id || params.turnId}:started`,
        );
      }
    } else if (message.method === 'turn/completed') {
      const state = this.state(params.threadId);
      const turn = this.upsertTurn(params.threadId, params.turn) || params.turn || null;
      const prompt = activeTurnPrompt(state) || turnPrompt(turn);
      state.activeTurnId = null;
      state.activePrompt = '';
      state.status = { type: 'idle' };
      state.lastTurn = turn;
      const status = turn?.status;
      if (!this.isCurrentThread(params.threadId)) {
        /* stale/background completion: update only its own thread state */
      } else if (status === 'completed' || status === 'failed') {
        const completedAt = typeof turn?.completedAt === 'number' ? turn.completedAt * 1000 : undefined;
        this.setInbox(
          'done', inboxTurnSummary(params.turn, turn) || prompt,
          `turn:${turn?.id || params.turnId}:${status}`, completedAt,
        );
      } else {
        this.setInbox(null, '', `turn:${params.turn?.id || params.turnId}:${status || 'ended'}`);
      }
      if (status === 'completed') {
        void this.drainQueue(params.threadId).catch(() => {});
      }
      this.emitStream({
        type: 'turnCompleted', threadId: params.threadId,
        turnId: turn?.id || params.turnId || null, status: status || null,
      });
    } else if (message.method === 'thread/goal/updated') {
      // Native Goal notifications do not consistently carry turnId. Bind every live lifecycle transition
      // to the turn that is currently producing it so an active Goal set before the first item event cannot
      // later mistake that same turn for its next durable injection opportunity.
      const state = this.state(params.threadId);
      const notifiedGoal = parseCodexGoal(params.goal);
      const pendingTurnId = this.pendingGoalTurn(params.threadId);
      const turnId = params.turnId
        || (pendingTurnId !== undefined ? pendingTurnId : state.activeTurnId)
        || null;
      this.applyGoalSnapshot(params.threadId, notifiedGoal, turnId, { emitClear: true });
    } else if (message.method === 'thread/goal/cleared') {
      this.applyGoalSnapshot(params.threadId, null, params.turnId, { emitClear: true });
    } else if (message.method === 'thread/settings/updated') {
      const state = this.state(params.threadId);
      state.settings = params.threadSettings
        ? { ...(state.settings || {}), ...params.threadSettings }
        : state.settings;
      state.settingsRevision += 1;
    } else if (message.method === 'thread/tokenUsage/updated') {
      this.state(params.threadId).contextUsage = contextUsageFromNotification(params.tokenUsage);
    } else if (message.method === 'thread/compacted') {
      const state = this.state(params.threadId);
      state.status = { type: 'idle' };
      state.compacting = false;
      if (this.isCurrentThread(params.threadId)) this.setInbox(null, '', `thread:${params.threadId}:compacted`);
      void this.drainQueue(params.threadId).catch(() => {});
    } else if (message.method === 'thread/started') {
      const startedThreadId = params.thread?.id || params.threadId || null;
      // Collaboration children and ephemeral helpers share this App Server connection. They are
      // independent work, not a replacement for the durable root conversation represented by this pane.
      if (startedThreadId && params.thread?.parentThreadId == null
        && params.thread?.ephemeral !== true) {
        const previous = this.currentThreadId;
        this.lastStartedThreadId = startedThreadId;
        this.currentThreadId = startedThreadId;
        this.threadBindingKnown = true;
        if (previous && previous !== startedThreadId) {
          // A TUI-originated /clear switches this pane without going through Handmux's request path. Any
          // pending messages still belong to the old conversation and must never drain after the switch.
          this.discardQueue(previous);
          this.setInbox(null, '', `thread:${startedThreadId}:started`);
        }
      }
    }
    if (RESUME_SNAPSHOT_INVALIDATING_METHODS.has(message.method)) this.bumpEvent(params.threadId);
    else this.bump(params.threadId);
    if (message.method === 'serverRequest/resolved') this.emitInteractionSnapshot(params.threadId);
  }

  setInbox(
    kind: InboxKind,
    msg = '',
    key = `${kind || 'idle'}`,
    ts?: number,
    correlationId?: string,
  ): void {
    if (this.inbox.key === key && this.inbox.kind === kind && this.inbox.msg === msg
      && this.inbox.correlationId === correlationId) return;
    this.inbox = {
      kind, msg, ts: ts ?? this.now(), key,
      ...(correlationId === undefined ? {} : { correlationId }),
      suppressPush: this.baseline,
    };
    queueMicrotask(() => Promise.resolve(this.onStateChange(this.pane)).catch(() => {}));
  }

  takeInbox() {
    const snapshot = { ...this.inbox };
    this.inbox.suppressPush = false;
    return snapshot;
  }

  state(threadId: string): ThreadState {
    if (!this.threadState.has(threadId)) this.threadState.set(threadId, {
      revision: 0, eventRevision: 0, settingsRevision: 0, readRevision: -1,
      thread: null, status: null, activeTurnId: null, settings: null,
      activePrompt: '', contextUsage: null, lastTurn: null, loadedOnly: false, liveItemIds: new Map(),
      completedAgentItemIds: new Set(), plans: new Map(), goal: undefined,
      goalRevision: 0, goalEvent: null, goalTurnId: null,
      compacting: false, compactorItemKeys: new Set(),
      deliveryHistorySafe: true, deliveryProofClientIds: new Set(),
    });
    return this.threadState.get(threadId)!;
  }

  applyGoalSnapshot(
    threadId: string | null | undefined,
    goal: unknown,
    turnId: string | null | undefined = null,
    { emit = true, emitClear = false }: { emit?: boolean; emitClear?: boolean } = {},
  ): boolean {
    if (!threadId) return false;
    const normalizedGoal = goal == null ? null : parseCodexGoal(goal);
    if (goal != null && !normalizedGoal) return false;
    const goalValue = normalizedGoal;
    const state = this.state(threadId);
    state.goalRevision += 1;
    const previous = state.goal;
    const replaced = !!goalValue && (!previous || previous.createdAt !== goalValue.createdAt
      || previous.objective !== goalValue.objective);
    state.goal = goalValue;
    const enteredTerminal = !!goalValue && TERMINAL_GOAL_STATUSES.has(goalValue.status)
      && previous?.status !== goalValue.status;
    const restarted = !!goalValue && !!previous
      && TERMINAL_GOAL_STATUSES.has(previous.status) && goalValue.status === 'active';
    const lifecycle: CodexGoalEvent | null = !goalValue ? null : restarted ? 'restarted'
      : TERMINAL_GOAL_STATUSES.has(goalValue.status) ? goalValue.status as CodexGoalEvent : 'set';
    if (!goalValue) {
      state.goalEvent = null;
      state.goalTurnId = null;
    } else if (replaced || enteredTerminal || restarted) {
      state.goalEvent = lifecycle;
      state.goalTurnId = turnId || null;
    } else {
      state.goalEvent ||= goalValue.status === 'active' ? 'active'
        : TERMINAL_GOAL_STATUSES.has(goalValue.status) ? goalValue.status as CodexGoalEvent : null;
      if (goalValue.status === 'active' && !state.goalTurnId && turnId) state.goalTurnId = turnId;
      if (TERMINAL_GOAL_STATUSES.has(goalValue.status) && turnId) state.goalTurnId = turnId;
    }
    if (emitClear && previous?.status === 'active'
      && (!goalValue || goalValue.status === 'paused')) {
      this.emitGoalCleared(threadId, turnId);
    }
    if (!emit || !goalValue) return previous !== state.goal;
    if (!replaced && !enteredTerminal && !restarted) {
      return false;
    }
    // A terminal Goal without an originating turn can be read as state, but cannot be placed truthfully in
    // the conversation. Its durable rollout entry will render at the exact historical position instead.
    if (TERMINAL_GOAL_STATUSES.has(goalValue.status) && !turnId) return true;
    this.emitStream({
      type: 'goal', threadId, turnId: turnId || null,
      event: lifecycle!,
      goal: goalValue,
    });
    return true;
  }

  queueKey(threadId: string): string { return `${this.pane}\0${threadId}`; }

  queueState(threadId: string, create?: true): QueueState;
  queueState(threadId: string, create: false): QueueState | null;
  queueState(threadId: string, create = true): QueueState | null {
    const key = this.queueKey(threadId);
    let state = this.queueStore.get(key);
    if (!state && create) {
      state = {
        items: [], starting: false, draining: false, steering: new Set(), editing: null, editTimer: null,
      };
      this.queueStore.set(key, state);
    }
    return state || null;
  }

  clearQueueEditTimer(queue: QueueState | null | undefined): void {
    if (!queue?.editTimer) return;
    clearTimeout(queue.editTimer);
    queue.editTimer = null;
  }

  scheduleQueueEditExpiry(threadId: string): void {
    const queue = this.queueState(threadId, false);
    this.clearQueueEditTimer(queue);
    if (!queue?.editing) return;
    const token = queue.editing.token;
    const delay = Math.max(1, queue.editing.expiresAt - this.now());
    queue.editTimer = setTimeout(() => {
      queue.editTimer = null;
      if (queue.editing?.token !== token) return;
      if (!this.expireQueueEdit(threadId)) this.scheduleQueueEditExpiry(threadId);
    }, delay);
    queue.editTimer.unref?.();
  }

  expireQueueEdit(threadId: string, { resume = true }: { resume?: boolean } = {}): boolean {
    const queue = this.queueState(threadId, false);
    if (!queue?.editing || queue.editing.expiresAt > this.now()) return false;
    this.clearQueueEditTimer(queue);
    queue.editing = null;
    this.bump(threadId);
    this.cleanupQueue(threadId);
    if (resume) queueMicrotask(() => { void this.drainQueue(threadId).catch(() => {}); });
    return true;
  }

  wakeQueue(threadId: string): void {
    this.expireQueueEdit(threadId, { resume: false });
    const queue = this.queueState(threadId, false);
    const state = this.state(threadId);
    if (!state.deliveryHistorySafe || !queue?.items.length || queue.editing || state.status?.type !== 'idle'
      || state.lastTurn?.status !== 'completed') return;
    queueMicrotask(() => { void this.drainQueue(threadId).catch(() => {}); });
  }

  queuedFor(threadId: string): CodexQueueItem[] {
    this.wakeQueue(threadId);
    const queue = this.queueState(threadId, false);
    const editingItemId = queue?.editing?.itemId;
    return (queue?.items || []).map((item) => ({
      ...this.queueItemView(item),
      ...(editingItemId === item.id ? { editing: true } : {}),
    }));
  }

  submissionReceiptsFor(threadId: string): CodexSubmissionReceiptView[] {
    return [...this.submissionStore.values()]
      .filter((receipt) => receipt.pane === this.pane && receipt.threadId === threadId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 50)
      .map((receipt) => ({
        requestId: receipt.requestId,
        status: receipt.status,
        ...(receipt.queueItemId ? { queueItemId: receipt.queueItemId } : {}),
        ...(receipt.turnId ? { turnId: receipt.turnId } : {}),
      }));
  }

  queueItemView(item: InternalQueueItem): CodexQueueItem {
    const { clientId: _clientId, ...view } = item;
    return view;
  }

  submissionKey(threadId: string, requestId: string): string {
    return `${this.pane}\0${threadId}\0${requestId}`;
  }

  queuedItemForReceipt(threadId: string, receipt: InternalSubmissionReceipt): InternalQueueItem | null {
    const queue = this.queueState(threadId, false);
    return queue?.items.find((item) => item.id === receipt.queueItemId
      || (item.requestId && item.requestId === receipt.requestId)) || null;
  }

  submissionResult(threadId: string, receipt: InternalSubmissionReceipt): InternalSendResult | null {
    if (receipt.status === 'queued') {
      const item = this.queuedItemForReceipt(threadId, receipt);
      if (item) return { queued: true, item: this.queueItemView(item) };
    }
    if (receipt.status === 'accepted') {
      if (receipt.result) return receipt.result;
      return {
        queued: false,
        ...(receipt.turnId ? { turn: { id: receipt.turnId } } : {}),
      };
    }
    return null;
  }

  markSubmissionAccepted(threadId: string, item: InternalQueueItem, turnId: string | null = null): void {
    if (!item?.requestId) return;
    const receipt = this.submissionStore.get(this.submissionKey(threadId, item.requestId));
    if (!receipt) return;
    receipt.status = 'accepted';
    receipt.updatedAt = this.now();
    receipt.settled = true;
    delete receipt.queueItemId;
    delete receipt.result;
    if (turnId) receipt.turnId = turnId;
  }

  deleteSubmissionForItem(threadId: string, item: InternalQueueItem): void {
    if (item?.requestId) this.submissionStore.delete(this.submissionKey(threadId, item.requestId));
  }

  releaseDeliveryHistoryGuardIfSettled(threadId: string): boolean {
    const state = this.state(threadId);
    state.deliveryHistorySafe = state.deliveryProofClientIds.size === 0;
    return state.deliveryHistorySafe;
  }

  settleDeliveryHistoryProof(threadId: string, clientIds: Iterable<string>): boolean {
    const state = this.state(threadId);
    for (const clientId of clientIds) state.deliveryProofClientIds.delete(clientId);
    return this.releaseDeliveryHistoryGuardIfSettled(threadId);
  }

  requireDeliveryHistoryProof(threadId: string, clientIds: Iterable<string>): void {
    const state = this.state(threadId);
    const unsettled = this.unsettledDeliveryClientIds(threadId);
    for (const clientId of clientIds) {
      if (unsettled.has(clientId)) state.deliveryProofClientIds.add(clientId);
    }
    this.releaseDeliveryHistoryGuardIfSettled(threadId);
  }

  reconcileQueuedDeliveries(
    threadId: string,
    source: AppThread | AppTurn | AppItem | null | undefined,
  ): boolean {
    const delivered = deliveredClientMessages(source);
    if (!delivered.size) return false;
    this.settleDeliveryHistoryProof(threadId, delivered.keys());
    let changed = false;
    const queue = this.queueState(threadId, false);
    const removed = (queue?.items || []).filter((item) => delivered.has(item.clientId));
    const removedIds = new Set(removed.map((item) => item.id));
    for (const item of removed) {
      this.markSubmissionAccepted(threadId, item, delivered.get(item.clientId) ?? null);
    }
    if (queue && removedIds.size) {
      queue.items = queue.items.filter((item) => !removedIds.has(item.id));
      if (queue.editing && removedIds.has(queue.editing.itemId)) {
        this.clearQueueEditTimer(queue);
        queue.editing = null;
      }
      changed = true;
    }
    for (const receipt of this.submissionStore.values()) {
      if (receipt.pane !== this.pane || receipt.threadId !== threadId || receipt.status === 'accepted'
        || !delivered.has(receipt.requestId)) continue;
      receipt.status = 'accepted';
      receipt.updatedAt = this.now();
      receipt.settled = true;
      delete receipt.queueItemId;
      delete receipt.result;
      const turnId = delivered.get(receipt.requestId);
      if (turnId) receipt.turnId = turnId;
      changed = true;
    }
    if (!changed) return false;
    this.releaseDeliveryHistoryGuardIfSettled(threadId);
    this.bump(threadId);
    this.cleanupQueue(threadId);
    this.persistOutbox();
    return true;
  }

  unsettledDeliveryClientIds(threadId: string): Set<string> {
    const ids = new Set((this.queueState(threadId, false)?.items || []).map((item) => item.clientId));
    for (const receipt of this.submissionStore.values()) {
      if (receipt.pane === this.pane && receipt.threadId === threadId && receipt.status !== 'accepted') {
        ids.add(receipt.requestId);
      }
    }
    return ids;
  }

  async reconcileDurableDeliveryHistory(
    threadId: string,
    initial: AppThread | null,
    { initialComplete = false }: { initialComplete?: boolean } = {},
  ): Promise<void> {
    // This scan may overlap a pane migration. It can settle only the proof obligations that existed when
    // it began; a later migration owns a separate scan and must remain fail-closed until that scan finishes.
    const state = this.state(threadId);
    const proofClientIds = new Set(state.deliveryProofClientIds);
    const requestedEventRevision = state.eventRevision;
    this.reconcileQueuedDeliveries(threadId, initial);
    if (![...proofClientIds].some((clientId) => (
      this.state(threadId).deliveryProofClientIds.has(clientId)
    ))) return;
    if (!this.boundedTurns) {
      if (!initialComplete) {
        const result = await this.rpc('thread/read', { threadId, includeTurns: true });
        this.requireCurrentThread(threadId);
        if (this.state(threadId).eventRevision !== requestedEventRevision) return;
        if (!result.thread) throw deliveryReconcileError();
        this.reconcileQueuedDeliveries(threadId, result.thread);
      }
      this.settleDeliveryHistoryProof(threadId, proofClientIds);
      return;
    }
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    // Absence is safe only at the authoritative end of history. Normal histories scan exhaustively in
    // bounded payloads; the high shared page budget exists only as a corrupt-pagination resource fuse.
    for (let pageIndex = 0; pageIndex < MAX_RECEIPT_RECONCILE_PAGES; pageIndex++) {
      const page = await this.listTurns(threadId, RECEIPT_RECONCILE_PAGE_LIMIT, cursor);
      this.reconcileQueuedDeliveries(threadId, { turns: page.turns });
      if (![...proofClientIds].some((clientId) => (
        this.state(threadId).deliveryProofClientIds.has(clientId)
      ))) return;
      if (!page.nextCursor) {
        if (this.state(threadId).eventRevision !== requestedEventRevision) return;
        this.settleDeliveryHistoryProof(threadId, proofClientIds);
        return;
      }
      if (seenCursors.has(page.nextCursor)) return;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw deliveryReconcileError();
  }

  async reconcileMigratedDeliveryHistory(
    threadId: string,
    clientIds: Iterable<string>,
  ): Promise<void> {
    const state = this.state(threadId);
    this.requireDeliveryHistoryProof(threadId, clientIds);
    if (state.deliveryHistorySafe) {
      this.wakeQueue(threadId);
      return;
    }
    if (!this.subscribed.has(threadId)) return;
    try {
      await this.reconcileDurableDeliveryHistory(threadId, state.thread);
    } catch {
      // Keep every remaining proof obligation fail-closed. A concurrent scan may already have settled all
      // of them, so derive the guard from the current set instead of overwriting it with this stale failure.
    }
    this.releaseDeliveryHistoryGuardIfSettled(threadId);
    if (state.deliveryHistorySafe) this.wakeQueue(threadId);
  }

  cleanupQueue(threadId: string): void {
    const state = this.queueState(threadId, false);
    if (state && !state.items.length && !state.starting && !state.draining
      && !state.steering.size && !state.editing) {
      this.clearQueueEditTimer(state);
      this.queueStore.delete(this.queueKey(threadId));
    }
  }

  discardQueue(threadId: string): void {
    this.clearQueueEditTimer(this.queueState(threadId, false));
    this.queueStore.delete(this.queueKey(threadId));
    for (const [key, receipt] of this.submissionStore) {
      if (receipt.pane === this.pane && receipt.threadId === threadId && receipt.status !== 'accepted') {
        this.submissionStore.delete(key);
      }
    }
    this.state(threadId).deliveryProofClientIds.clear();
    this.releaseDeliveryHistoryGuardIfSettled(threadId);
    this.persistOutbox();
    this.bump(threadId);
  }

  activeTurn(threadId: string): string | null {
    const state = this.state(threadId);
    return state.activeTurnId
      || [...(state.thread?.turns || [])].reverse().find((turn) => turn.status === 'inProgress')?.id
      || null;
  }

  beginGoalMutation(threadId: string): PendingGoalMutation {
    const mutation = { token: Symbol('goal-mutation'), turnId: this.activeTurn(threadId) };
    const pending = this.pendingGoalMutations.get(threadId) || [];
    pending.push(mutation);
    this.pendingGoalMutations.set(threadId, pending);
    return mutation;
  }

  async withGoalWrite<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.goalWriteTails.get(threadId) || Promise.resolve();
    let release!: () => void;
    const completion = new Promise<void>((resolve) => { release = resolve; });
    this.goalWriteTails.set(threadId, completion);
    await previous.catch(() => {});
    try {
      return await action();
    } finally {
      release();
      if (this.goalWriteTails.get(threadId) === completion) this.goalWriteTails.delete(threadId);
    }
  }

  async withGoalRead<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.goalReadTails.get(threadId) || Promise.resolve();
    let release!: () => void;
    const completion = new Promise<void>((resolve) => { release = resolve; });
    this.goalReadTails.set(threadId, completion);
    await previous.catch(() => {});
    try {
      return await action();
    } finally {
      release();
      if (this.goalReadTails.get(threadId) === completion) this.goalReadTails.delete(threadId);
    }
  }

  endGoalMutation(threadId: string, token: symbol): void {
    const pending = this.pendingGoalMutations.get(threadId);
    if (!pending) return;
    const index = pending.findIndex((mutation) => mutation.token === token);
    if (index >= 0) pending.splice(index, 1);
    if (!pending.length) this.pendingGoalMutations.delete(threadId);
  }

  pendingGoalTurn(threadId: string): string | null | undefined {
    const pending = this.pendingGoalMutations.get(threadId);
    return pending?.length ? pending[pending.length - 1]?.turnId : undefined;
  }

  enqueue(threadId: string, text: string, requestId: string | null = null): CodexQueueItem {
    const queue = this.queueState(threadId);
    if (queue.items.length >= MAX_QUEUED_MESSAGES) throw new Error('pending message queue is full');
    const id = this.nextQueueId();
    const item = {
      id, text, createdAt: this.now(), clientId: requestId || `handmux-queue:${id}`,
      ...(requestId ? { requestId } : {}),
    };
    queue.items.push(item);
    try { this.persistOutbox(); } catch (error) {
      queue.items.pop();
      this.cleanupQueue(threadId);
      throw error;
    }
    this.bump(threadId);
    return this.queueItemView(item);
  }

  async startTurn(
    threadId: string,
    text: string,
    clientUserMessageId: string | null = null,
  ): Promise<RpcResult> {
    // Keep the ownership check adjacent to the native mutation. Callers may have awaited resume/read after
    // their initial assertion, during which a TUI-originated /clear can switch this pane to another thread.
    this.requireCurrentThread(threadId);
    const queue = this.queueState(threadId);
    queue.starting = true;
    const state = this.state(threadId);
    const previousPrompt = state.activePrompt;
    state.activePrompt = text.trim();
    try {
      const result = await this.rpc('turn/start', {
        threadId, input: [{ type: 'text', text }],
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
      });
      state.activeTurnId = result.turn?.id || null;
      state.status = { type: 'active', activeFlags: [] };
      this.currentThreadId ||= threadId;
      this.threadBindingKnown = true;
      if (this.isCurrentThread(threadId)) {
        this.setInbox('working', state.activePrompt, `turn:${result.turn?.id || 'starting'}:started`);
      }
      this.bump(threadId);
      if (state.loadedOnly) {
        // turn/start normally persists the first rollout synchronously; attach this observer immediately.
        await this.ensureThread(threadId);
      }
      return result;
    } catch (error) {
      state.activePrompt = previousPrompt;
      throw error;
    } finally {
      queue.starting = false;
      this.cleanupQueue(threadId);
    }
  }

  async submitOnce(
    threadId: string,
    text: string,
    requestId: string | null = null,
  ): Promise<InternalSendResult> {
    this.requireCurrentThread(threadId);
    const queue = this.queueState(threadId);
    let knownState = this.state(threadId);
    if (!queue.items.length && !queue.starting && !queue.draining
      && this.activeTurn(threadId) && knownState.status?.type !== 'active') {
      try {
        await this.readThread(threadId, { force: true });
        knownState = this.state(threadId);
      } catch { /* retain the safer queued behavior while App Server is unavailable */ }
      this.requireCurrentThread(threadId);
    }
    if (this.activeTurn(threadId) || knownState.status?.type === 'active'
      || queue.items.length || queue.starting || queue.draining) {
      return { queued: true, item: this.enqueue(threadId, text, requestId) };
    }
    const state = await this.ensureThread(threadId);
    this.requireCurrentThread(threadId);
    if (this.activeTurn(threadId) || state.status?.type === 'active'
      || queue.items.length || queue.starting || queue.draining) {
      return { queued: true, item: this.enqueue(threadId, text, requestId) };
    }
    return this.startTurn(threadId, text, requestId);
  }

  async dispatchPromptDirect(
    threadId: string,
    text: string,
    requestId: string,
  ): Promise<{ busy: true } | { busy: false; result: AppTurn | UnknownRecord | null }> {
    this.requireCurrentThread(threadId);
    const queue = this.queueState(threadId);
    let state = this.state(threadId);
    if (this.activeTurn(threadId) || state.status?.type === 'active'
      || queue.items.length || queue.starting || queue.draining || queue.steering.size) {
      return { busy: true };
    }
    state = await this.ensureThread(threadId);
    this.requireCurrentThread(threadId);
    if (this.activeTurn(threadId) || state.status?.type === 'active'
      || queue.items.length || queue.starting || queue.draining || queue.steering.size) {
      return { busy: true };
    }
    return { busy: false, result: await this.startTurn(threadId, text, requestId) };
  }

  async dispatchSteerDirect(
    threadId: string,
    text: string,
    requestId: string,
    plan: { kind: 'steer-active-turn' | 'start-turn-fallback'; nativeTurnId?: string },
  ): Promise<{ busy: true } | { busy: false; result: AppTurn | UnknownRecord | null }> {
    await this.ensureThread(threadId);
    this.requireCurrentThread(threadId);
    const activeTurnId = this.activeTurn(threadId);
    if (plan.kind === 'steer-active-turn') {
      if (!plan.nativeTurnId || activeTurnId !== plan.nativeTurnId) return { busy: true };
      const result = await this.rpc('turn/steer', {
        threadId, expectedTurnId: plan.nativeTurnId,
        input: [{ type: 'text', text }], clientUserMessageId: requestId,
      });
      return { busy: false, result };
    }
    const queue = this.queueState(threadId);
    if (activeTurnId || this.state(threadId).status?.type === 'active'
      || queue.items.length || queue.starting || queue.draining || queue.steering.size) {
      return { busy: true };
    }
    return { busy: false, result: await this.startTurn(threadId, text, requestId) };
  }

  pruneSubmissionReceipts() {
    const cutoff = this.now() - SUBMISSION_RECEIPT_TTL_MS;
    for (const [key, receipt] of this.submissionStore) {
      if (receipt.status !== 'accepted' || receipt.updatedAt >= cutoff) continue;
      this.submissionStore.delete(key);
    }
    if (this.submissionStore.size <= MAX_SUBMISSION_RECEIPTS) return;
    for (const [key, receipt] of this.submissionStore) {
      if (receipt.status !== 'accepted') continue;
      this.submissionStore.delete(key);
      if (this.submissionStore.size <= MAX_SUBMISSION_RECEIPTS) return;
    }
  }

  async runSubmission(
    threadId: string,
    receipt: InternalSubmissionReceipt,
  ): Promise<InternalSendResult> {
    const result = await this.submitOnce(threadId, receipt.text, receipt.requestId);
    if (result?.queued) {
      receipt.status = 'queued';
      receipt.queueItemId = result.item.id;
      delete receipt.turnId;
      delete receipt.result;
    } else {
      receipt.status = 'accepted';
      delete receipt.queueItemId;
      receipt.result = result;
      const turnId = result?.turn?.id;
      if (turnId) receipt.turnId = turnId;
    }
    receipt.updatedAt = this.now();
    receipt.settled = true;
    this.settleDeliveryHistoryProof(threadId, [receipt.requestId]);
    this.pruneSubmissionReceipts();
    this.persistOutbox();
    return result;
  }

  async reconcilePendingSubmission(
    threadId: string,
    receipt: InternalSubmissionReceipt,
  ): Promise<InternalSendResult | null> {
    const queued = this.queuedItemForReceipt(threadId, receipt);
    if (queued) {
      receipt.status = 'queued';
      receipt.queueItemId = queued.id;
      receipt.updatedAt = this.now();
      receipt.settled = true;
      this.persistOutbox();
      return { queued: true, item: this.queueItemView(queued) };
    }
    let thread: AppThread | null = this.state(threadId).thread;
    if (this.boundedTurns) {
      try { thread = await this.readThread(threadId, { force: true }); } catch (error) {
        if (!isMissingThreadRollout(error)) throw error;
        thread = this.state(threadId).thread;
      }
    }
    this.requireCurrentThread(threadId);
    const delivered = await this.findDeliveredClientMessage(threadId, receipt.requestId, thread);
    if (delivered !== undefined) {
      receipt.status = 'accepted';
      receipt.updatedAt = this.now();
      receipt.settled = true;
      delete receipt.queueItemId;
      const turnId = delivered;
      if (turnId) receipt.turnId = turnId;
      this.settleDeliveryHistoryProof(threadId, [receipt.requestId]);
      this.persistOutbox();
      return this.submissionResult(threadId, receipt);
    }
    return this.runSubmission(threadId, receipt);
  }

  async findDeliveredClientMessage(
    threadId: string,
    requestId: string,
    initial: AppThread | null,
  ): Promise<string | null | undefined> {
    const requestedEventRevision = this.state(threadId).eventRevision;
    const initialDelivered = deliveredClientMessages(initial);
    if (initialDelivered.has(requestId)) return initialDelivered.get(requestId) ?? null;
    if (!this.boundedTurns) {
      const result = await this.rpc('thread/read', { threadId, includeTurns: true });
      this.requireCurrentThread(threadId);
      if (this.state(threadId).eventRevision !== requestedEventRevision || !result.thread) {
        throw deliveryReconcileError();
      }
      const delivered = deliveredClientMessages(result.thread);
      return delivered.has(requestId) ? delivered.get(requestId) ?? null : undefined;
    }
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    // Keep the same exhaustive absence proof and high resource fuse as reconnect recovery.
    for (let pageIndex = 0; pageIndex < MAX_RECEIPT_RECONCILE_PAGES; pageIndex++) {
      const page = await this.listTurns(threadId, RECEIPT_RECONCILE_PAGE_LIMIT, cursor);
      const delivered = deliveredClientMessages({ turns: page.turns });
      if (delivered.has(requestId)) return delivered.get(requestId) ?? null;
      if (this.state(threadId).eventRevision !== requestedEventRevision) {
        throw deliveryReconcileError();
      }
      if (!page.nextCursor) return undefined;
      if (seenCursors.has(page.nextCursor)) {
        throw deliveryReconcileError();
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw deliveryReconcileError();
  }

  async submit(
    threadId: string,
    text: string,
    requestId: string | null = null,
  ): Promise<InternalSendResult | null> {
    if (!requestId) return this.submitOnce(threadId, text);
    const key = this.submissionKey(threadId, requestId);
    const existing = this.submissionStore.get(key);
    if (existing) {
      if (existing.text !== text) throw new Error('Codex request id was already used for another message');
      if (existing.promise) return existing.promise;
      const result = this.submissionResult(threadId, existing);
      if (result) return result;
      existing.promise = this.reconcilePendingSubmission(threadId, existing);
      try { return await existing.promise; } finally { existing.promise = null; }
    }
    const timestamp = this.now();
    const receipt: InternalSubmissionReceipt = {
      pane: this.pane, threadId, requestId, text, status: 'pending',
      createdAt: timestamp, updatedAt: timestamp, settled: false, promise: null,
    };
    this.submissionStore.set(key, receipt);
    this.pruneSubmissionReceipts();
    try { this.persistOutbox(); } catch (error) {
      this.submissionStore.delete(key);
      throw error;
    }
    receipt.promise = this.runSubmission(threadId, receipt);
    try { return await receipt.promise; } finally { receipt.promise = null; }
  }

  async drainQueue(threadId: string): Promise<void> {
    await this.assertCurrentThread(threadId);
    this.expireQueueEdit(threadId, { resume: false });
    const queue = this.queueState(threadId, false);
    if (!this.state(threadId).deliveryHistorySafe
      || !queue?.items.length || queue.draining || queue.starting || queue.steering.size
      || queue.editing || this.activeTurn(threadId)
      || this.state(threadId).status?.type === 'active') return;
    queue.draining = true;
    const item = queue.items[0];
    if (!item) {
      queue.draining = false;
      return;
    }
    try {
      const result = await this.startTurn(threadId, item.text, item.clientId);
      this.markSubmissionAccepted(threadId, item, result?.turn?.id || null);
      if (queue.items[0]?.id === item.id) queue.items.shift();
      else queue.items = queue.items.filter((candidate) => candidate.id !== item.id);
      this.settleDeliveryHistoryProof(threadId, [item.clientId]);
      this.bump(threadId);
      this.persistOutbox();
    } finally {
      queue.draining = false;
      this.cleanupQueue(threadId);
    }
  }

  async steerQueued(threadId: string, itemId: string) {
    await this.ensureThread(threadId);
    this.requireCurrentThread(threadId);
    const queue = this.queueState(threadId, false);
    if (!queue) throw new Error('queued message is no longer pending');
    const item = queue?.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('queued message is no longer pending');
    if (!this.state(threadId).deliveryHistorySafe) {
      throw new Error('Codex delivery status is still being reconciled; the message remains queued');
    }
    if (queue.draining && queue.items[0]?.id === itemId) {
      throw new Error('queued message is already being sent');
    }
    if (queue.editing?.itemId === itemId) throw new Error('queued message is being edited');
    if (queue.steering.has(itemId)) throw new Error('queued message is already being sent');
    queue.steering.add(itemId);
    try {
      if (this.activeTurn(threadId) && this.state(threadId).status?.type !== 'active') {
        try { await this.readThread(threadId, { force: true }); }
        catch { /* steer against the retained active turn while App Server is reconnecting */ }
        this.requireCurrentThread(threadId);
      }
      const turnId = this.activeTurn(threadId);
      let result;
      if (turnId) {
        this.requireCurrentThread(threadId);
        result = await this.rpc('turn/steer', {
          threadId, expectedTurnId: turnId, input: [{ type: 'text', text: item.text }],
          clientUserMessageId: item.clientId,
        });
      } else {
        if (this.state(threadId).status?.type === 'active') {
          throw new Error('Codex is busy without a steerable turn; the message remains queued');
        }
        if (queue.starting || queue.draining) throw new Error('queued message is already being sent');
        result = await this.startTurn(threadId, item.text, item.clientId);
      }
      this.markSubmissionAccepted(threadId, item, result?.turn?.id || result?.turnId || turnId || null);
      queue.items = queue.items.filter((candidate) => candidate.id !== itemId);
      this.settleDeliveryHistoryProof(threadId, [item.clientId]);
      this.bump(threadId);
      this.persistOutbox();
      return { steered: true, item: this.queueItemView(item), result };
    } finally {
      queue.steering.delete(itemId);
      this.cleanupQueue(threadId);
    }
  }

  removeQueued(threadId: string, itemId: string) {
    const queue = this.queueState(threadId, false);
    if (!queue) throw new Error('queued message is no longer pending');
    const index = queue?.items.findIndex((candidate) => candidate.id === itemId) ?? -1;
    if (index < 0) throw new Error('queued message is no longer pending');
    if (queue.draining && index === 0) throw new Error('queued message is already being sent');
    if (queue.editing?.itemId === itemId) throw new Error('queued message is being edited');
    if (queue.steering.has(itemId)) throw new Error('queued message is already being sent');
    const [removed] = queue.items.splice(index, 1);
    if (!removed) throw new Error('queued message is no longer pending');
    this.deleteSubmissionForItem(threadId, removed);
    this.settleDeliveryHistoryProof(threadId, [removed.clientId]);
    this.bump(threadId);
    this.cleanupQueue(threadId);
    this.persistOutbox();
    return { removed: true };
  }

  async beginQueuedEdit(threadId: string, itemId: string) {
    await this.ensureThread(threadId);
    this.expireQueueEdit(threadId);
    const queue = this.queueState(threadId, false);
    if (!queue) throw new Error('queued message is no longer pending');
    const item = queue?.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('queued message is no longer pending');
    if ((queue.draining && queue.items[0]?.id === itemId) || queue.steering.has(itemId)) {
      throw new Error('queued message is already being sent');
    }
    if (queue.editing && queue.editing.itemId !== itemId) {
      throw new Error('another queued message is being edited');
    }
    // Reopening the same editor replaces its token. This lets a reloaded client recover an in-memory edit
    // hold while ensuring an older dialog can no longer overwrite the newer draft.
    const token = this.nextQueueId();
    queue.editing = { itemId, token, expiresAt: this.now() + QUEUE_EDIT_LEASE_MS };
    this.scheduleQueueEditExpiry(threadId);
    this.bump(threadId);
    return {
      editing: true, token, expiresAt: queue.editing.expiresAt,
      item: { ...this.queueItemView(item), editing: true },
    };
  }

  renewQueuedEdit(threadId: string, itemId: string, token: string) {
    this.expireQueueEdit(threadId);
    const queue = this.queueState(threadId, false);
    if (!queue?.editing || queue.editing.itemId !== itemId || queue.editing.token !== token) {
      throw new Error('queued message edit is no longer active');
    }
    queue.editing.expiresAt = this.now() + QUEUE_EDIT_LEASE_MS;
    this.scheduleQueueEditExpiry(threadId);
    return { editing: true, expiresAt: queue.editing.expiresAt };
  }

  commitQueuedEdit(threadId: string, itemId: string, token: string, text: string) {
    this.expireQueueEdit(threadId);
    const queue = this.queueState(threadId, false);
    if (!queue?.editing || queue.editing.itemId !== itemId || queue.editing.token !== token) {
      throw new Error('queued message edit is no longer active');
    }
    const item = queue.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('queued message is no longer pending');
    item.text = text;
    if (item.requestId) {
      const receipt = this.submissionStore.get(this.submissionKey(threadId, item.requestId));
      if (receipt) {
        receipt.text = text;
        receipt.updatedAt = this.now();
      }
    }
    this.clearQueueEditTimer(queue);
    queue.editing = null;
    this.bump(threadId);
    this.cleanupQueue(threadId);
    this.persistOutbox();
    queueMicrotask(() => { void this.drainQueue(threadId).catch(() => {}); });
    return { edited: true, item: this.queueItemView(item) };
  }

  cancelQueuedEdit(threadId: string, itemId: string, token: string) {
    this.expireQueueEdit(threadId);
    const queue = this.queueState(threadId, false);
    if (!queue?.editing || queue.editing.itemId !== itemId || queue.editing.token !== token) {
      throw new Error('queued message edit is no longer active');
    }
    this.clearQueueEditTimer(queue);
    queue.editing = null;
    this.bump(threadId);
    this.cleanupQueue(threadId);
    queueMicrotask(() => { void this.drainQueue(threadId).catch(() => {}); });
    return { editing: false };
  }

  isCurrentThread(threadId: string | null | undefined): boolean {
    return !!threadId && this.currentThreadId === threadId;
  }

  requireCurrentThread(threadId: string): void {
    if (this.closed) throw new Error('Codex App Server connection closed');
    if (!this.isCurrentThread(threadId)) throw new Error('Codex session changed');
  }

  async assertCurrentThread(threadId: string): Promise<void> {
    if (this.closed) throw new Error('Codex App Server connection closed');
    if (!this.currentThreadId) await this.discoverThread();
    this.requireCurrentThread(threadId);
    await this.onThreadBind(this, threadId);
    this.requireCurrentThread(threadId);
  }

  upsertTurn(threadId: string | undefined, incoming: AppTurn | undefined): AppTurn | null {
    if (!threadId || !incoming?.id) return null;
    const state = this.state(threadId);
    state.thread ||= { id: threadId, turns: [], status: { type: 'active', activeFlags: [] } };
    state.thread.turns ||= [];
    const index = state.thread.turns.findIndex((turn) => turn.id === incoming.id);
    const previous = index >= 0 ? state.thread.turns[index] : null;
    const turn = mergeTurnWithLive(previous, incoming, state.liveItemIds.get(incoming.id));
    if (index >= 0) state.thread.turns[index] = turn;
    else state.thread.turns.push(turn);
    this.reconcileQueuedDeliveries(threadId, turn);
    return turn;
  }

  upsertLiveItem(
    threadId: string | undefined,
    turnId: string | undefined,
    item: AppItem | undefined,
  ): void {
    if (!threadId || !turnId || !item?.id) return;
    const state = this.state(threadId);
    let ids = state.liveItemIds.get(turnId);
    if (!ids) {
      ids = new Set();
      state.liveItemIds.set(turnId, ids);
      if (state.liveItemIds.size > 20) {
        const oldestTurnId = state.liveItemIds.keys().next().value;
        if (oldestTurnId) {
          state.liveItemIds.delete(oldestTurnId);
          for (const key of state.completedAgentItemIds) {
            if (key.startsWith(`${oldestTurnId}\0`)) state.completedAgentItemIds.delete(key);
          }
        }
      }
    }
    ids.add(item.id);
    state.thread ||= { id: threadId, turns: [], status: { type: 'active', activeFlags: [] } };
    state.thread.turns ||= [];
    let turn = state.thread.turns.find((candidate) => candidate.id === turnId);
    if (!turn) {
      turn = { id: turnId, status: 'inProgress', items: [] };
      state.thread.turns.push(turn);
    }
    turn.items ||= [];
    const index = turn.items.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) turn.items[index] = item;
    else turn.items.push(item);
    this.reconcileQueuedDeliveries(threadId, item);
  }

  appendAgentDelta(threadId: string, turnId: string, itemId: string, delta: string): void {
    const state = this.state(threadId);
    const turn = state.thread?.turns?.find((candidate) => candidate.id === turnId);
    const item = turn?.items?.find((candidate) => candidate.id === itemId);
    this.upsertLiveItem(threadId, turnId, {
      ...(item || {}), id: itemId, type: 'agentMessage', text: `${item?.text || ''}${delta}`,
    });
  }

  streamJournal(threadId: string): StreamJournal {
    const key = `${this.pane}\0${threadId}`;
    let journal = this.streamEventStore.get(key);
    if (!journal) {
      journal = {
        sequence: 0, events: [], durableFingerprints: new Map(), liveMessageIds: new Set(), snapshot: null,
      };
      this.streamEventStore.set(key, journal);
    }
    journal.durableFingerprints ||= new Map();
    journal.liveMessageIds ||= new Set();
    return journal;
  }

  reconcileTranscript(threadId: string, messages: unknown): number {
    const journal = this.streamJournal(threadId);
    const snapshotMessages = structuredClone(Array.isArray(messages)
      ? messages.map(recordOf).filter((message): message is UnknownRecord => message != null)
      : []);
    const snapshotFingerprint = JSON.stringify(snapshotMessages);
    const reconciled = reconcileCodexRolloutMessages(
      journal.durableFingerprints, journal.liveMessageIds, snapshotMessages,
    );
    journal.durableFingerprints = reconciled.fingerprints;
    for (const mutation of reconciled.mutations) {
      if (mutation.operation !== 'upsert') continue;
      const message = mutation.message;
      this.emitStream({
        type: 'conversation', threadId,
        turnId: message.turnId,
        itemId: message.type === 'text' ? message.itemId : null,
        mutation,
      });
    }
    // The durable snapshot is a cursor-addressable checkpoint, not an out-of-band hint. Advancing the
    // sequence when its contents change lets a reconnecting browser prove that it has (or has not) seen
    // the latest rollout state even when no live text mutation was produced (for example a Tool/Plan/Diff
    // update). The snapshot itself stays outside the bounded event array so one recent transcript page is
    // retained instead of up to MAX_STREAM_EVENTS copies of it.
    const snapshotChanged = journal.snapshot?.fingerprint !== snapshotFingerprint;
    if (snapshotChanged) {
      journal.sequence += 1;
      journal.snapshot = {
        cursor: journal.sequence,
        fingerprint: snapshotFingerprint,
        messages: snapshotMessages,
      };
    }
    if (!snapshotChanged) return reconciled.mutations.length;
    const snapshot = journal.snapshot;
    if (!snapshot) return reconciled.mutations.length;
    for (const subscription of this.streamListeners) {
      if (subscription.threadId !== threadId) continue;
      try {
        subscription.listener({
          type: 'conversationSnapshot', threadId,
          cursor: snapshot.cursor,
          messages: structuredClone(snapshot.messages),
        });
      } catch { /* one browser must not break rollout reconciliation */ }
    }
    return reconciled.mutations.length;
  }

  recordStreamEvent(event: ThreadStreamEvent): CodexProjectedStreamEvent | null {
    const journal = this.streamJournal(event.threadId);
    const projected = projectCodexStreamEvent(event, journal.sequence + 1);
    if (!projected) return null;
    journal.sequence = projected.sequence;
    journal.events.push(projected);
    if (projected.mutation?.operation === 'upsert') {
      const id = projected.mutation.message.id;
      if (projected.type === 'conversation') journal.liveMessageIds.delete(id);
      else {
        journal.liveMessageIds.add(id);
        while (journal.liveMessageIds.size > MAX_STREAM_MESSAGE_IDS) {
          const oldest = journal.liveMessageIds.values().next().value;
          if (!oldest) break;
          journal.liveMessageIds.delete(oldest);
        }
      }
    }
    if (journal.events.length > MAX_STREAM_EVENTS) {
      journal.events.splice(0, journal.events.length - MAX_STREAM_EVENTS);
    }
    return projected;
  }

  subscribeStream(
    threadId: string,
    listener: StreamListener,
    afterSequence: number | null = null,
  ): () => boolean {
    const subscription = { threadId, listener };
    this.streamListeners.add(subscription);
    const journal = this.streamJournal(threadId);
    const firstSequence = journal.events[0]?.sequence ?? journal.sequence + 1;
    const hasCursor = typeof afterSequence === 'number'
      && Number.isSafeInteger(afterSequence) && afterSequence >= 0;
    const cursorInvalid = hasCursor
      && (afterSequence > journal.sequence || afterSequence < firstSequence - 1);
    let replayAfter = hasCursor ? afterSequence : null;
    const snapshot = journal.snapshot;
    const snapshotIsNewer = snapshot
      && (!hasCursor || cursorInvalid || afterSequence! < snapshot.cursor);
    if (snapshotIsNewer) {
      try {
        listener({
          type: 'conversationSnapshot', threadId,
          cursor: snapshot.cursor,
          messages: structuredClone(snapshot.messages),
        });
      } catch { /* snapshot baseline is best effort */ }
      replayAfter = snapshot.cursor;
    } else if (cursorInvalid) {
      try {
        listener({ type: 'cursorReset', threadId, cursor: journal.sequence });
      } catch { /* cursor reset is best effort */ }
      replayAfter = null;
    }
    if (typeof replayAfter === 'number' && Number.isSafeInteger(replayAfter) && replayAfter >= 0) {
      // A snapshot normally covers every durable event before its cursor. If the bounded live-event
      // journal has already discarded a later range, force one HTTP reconciliation rather than pretending
      // that the checkpoint plus a partial tail is complete.
      if (replayAfter < firstSequence - 1) {
        try {
          listener({ type: 'cursorReset', threadId, cursor: journal.sequence });
        } catch { /* cursor reset is best effort */ }
      } else if (replayAfter > journal.sequence) {
        try {
          listener({ type: 'cursorReset', threadId, cursor: journal.sequence });
        } catch { /* cursor reset is best effort */ }
      } else {
        for (const event of journal.events) {
          if (event.sequence <= replayAfter) continue;
          try { listener(event); } catch { /* replay is best effort */ }
        }
      }
    }
    this.emitLiveStreamOverlays(threadId);
    const state = this.threadState.get(threadId);
    if (state?.goal && TERMINAL_GOAL_STATUSES.has(state.goal.status) && state.goalTurnId) {
      this.emitStream({
        type: 'goal', threadId, turnId: state.goalTurnId,
        event: state.goal.status, goal: state.goal,
      });
    }
    return () => this.streamListeners.delete(subscription);
  }

  observeStream(threadId: string, listener: StreamListener): { cursor: number; close(): boolean } {
    const journal = this.streamJournal(threadId);
    const subscription = { threadId, listener };
    this.streamListeners.add(subscription);
    return {
      cursor: journal.sequence,
      close: () => this.streamListeners.delete(subscription),
    };
  }

  emitLiveStreamOverlays(threadId: string): void {
    const state = this.threadState.get(threadId);
    for (const turn of state?.thread?.turns || []) {
      if (!state || !turn.id) continue;
      const liveIds = state.liveItemIds.get(turn.id);
      if (!liveIds?.size) continue;
      for (const item of turn.items || []) {
        if (item?.type !== 'agentMessage' || !item.id || !liveIds.has(item.id) || !item.text) continue;
        // SSE is only a low-latency overlay for the reply that is still being generated. Completed
        // messages belong exclusively to the rollout projection; replaying them on reconnect can append
        // older event-only overlays after the current reply and permanently scramble the visible order.
        if (turn.status !== 'inProgress'
          || state.completedAgentItemIds.has(`${turn.id}\0${item.id}`)) continue;
        this.emitStream({
          type: 'snapshot', threadId, turnId: turn.id, itemId: item.id,
          text: item.text, completed: false,
        });
      }
    }
  }

  currentConversationGoal(threadId: string): ThreadStreamEvent | null {
    const state = this.threadState.get(threadId);
    const goal = state?.goal;
    if (!goal) return null;
    if (goal.status === 'active') {
      return {
        type: 'goal', threadId, turnId: state.goalTurnId,
        event: state.goalEvent || 'active', goal,
      };
    }
    if (TERMINAL_GOAL_STATUSES.has(goal.status) && state?.goalTurnId) {
      return { type: 'goal', threadId, turnId: state.goalTurnId, event: goal.status, goal };
    }
    return null;
  }

  conversationGoalRevision(threadId: string): number {
    return this.state(threadId).goalRevision;
  }

  conversationGoal(threadId: string): CodexGoal | null {
    return this.state(threadId).goal ?? null;
  }

  goalMutationIsCurrent(threadId: string, token: symbol, revision: number): boolean {
    const pending = this.pendingGoalMutations.get(threadId);
    return pending?.[pending.length - 1]?.token === token
      && this.conversationGoalRevision(threadId) === revision;
  }

  goalMutationOwns(threadId: string, token: symbol): boolean {
    const pending = this.pendingGoalMutations.get(threadId);
    return pending?.[pending.length - 1]?.token === token;
  }

  emitGoalCleared(threadId: string, turnId: string | null | undefined): void {
    this.emitStream({ type: 'goalCleared', threadId, turnId: turnId || null });
  }

  emitStream(event: unknown): void {
    const parsed = parseCodexStreamEvent(event);
    if (!parsed || parsed.type === 'error' || !parsed.threadId) return;
    if (this.state(parsed.threadId).compacting
      && ['started', 'snapshot', 'delta', 'completed'].includes(parsed.type)) {
      // Codex exposes the compactor model's generated handoff as a normal agentMessage stream. It is
      // implementation data for the later compaction event, not an assistant reply for the user.
      return;
    }
    const projected = this.recordStreamEvent(parsed);
    if (!projected) return;
    for (const subscription of this.streamListeners) {
      if (subscription.threadId !== projected.threadId) continue;
      try { subscription.listener(projected); } catch { /* one browser must not break the App Server observer */ }
    }
  }

  observeInteractions(threadId: string, listener: InteractionSnapshotListener): CodexInteractionSnapshot & {
    close(): void;
  } {
    const subscription = { threadId, listener };
    this.interactionListeners.add(subscription);
    return {
      ...this.interactionSnapshot(threadId),
      close: () => this.interactionListeners.delete(subscription),
    };
  }

  interactionSnapshot(threadId: string): CodexInteractionSnapshot {
    return {
      cursor: this.state(threadId).revision,
      approvals: this.approvalsFor(threadId),
      userInputs: this.userInputsFor(threadId),
    };
  }

  emitInteractionSnapshot(threadId: string): void {
    if (!threadId) return;
    const snapshot = this.interactionSnapshot(threadId);
    for (const subscription of this.interactionListeners) {
      if (subscription.threadId !== threadId) continue;
      try { subscription.listener(structuredClone(snapshot)); } catch { /* isolate observers */ }
    }
  }

  closeStreamListeners() {
    for (const subscription of this.streamListeners) {
      try { subscription.listener({ type: 'disconnected', threadId: subscription.threadId }); } catch { /* closing */ }
    }
    this.streamListeners.clear();
    const interactionThreads = new Set([...this.interactionListeners].map((item) => item.threadId));
    for (const threadId of interactionThreads) {
      const snapshot: CodexInteractionSnapshot = {
        cursor: this.state(threadId).revision,
        approvals: [],
        userInputs: [],
        disconnected: true,
      };
      for (const subscription of this.interactionListeners) {
        if (subscription.threadId !== threadId) continue;
        try { subscription.listener(structuredClone(snapshot)); } catch { /* closing */ }
      }
    }
    this.interactionListeners.clear();
  }

  bump(threadId: string | null | undefined): void {
    if (threadId) this.state(threadId).revision++;
  }

  bumpEvent(threadId: string | null | undefined): void {
    if (!threadId) return;
    this.state(threadId).eventRevision++;
    this.bump(threadId);
  }

  markWaiting(threadId: string | null | undefined, flag: string): void {
    if (!threadId) return;
    this.state(threadId).status = { type: 'active', activeFlags: [flag] };
  }

  markWorking(threadId: string | null | undefined): void {
    if (!threadId) return;
    const state = this.state(threadId);
    if (state.status?.type === 'active') state.status = { ...state.status, activeFlags: [] };
  }

  write(message: UnknownRecord): void {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) throw new Error('Codex App Server is unavailable');
    this.ws.send(JSON.stringify(message));
  }

  rpc(method: string, params: UnknownRecord = {}): Promise<RpcResult> {
    const id = this.nextId++;
    return new Promise<RpcResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server timed out: ${method}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method: string, params: UnknownRecord = {}): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  respond(id: string | number | undefined, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  async ensureThread(threadId: string): Promise<ThreadState> {
    const state = this.state(threadId);
    if (this.subscribed.has(threadId)) return state;
    const active = this.ensuringThreads.get(threadId);
    if (active) return active;
    const pending = this.resumeThread(threadId).finally(() => {
      if (this.ensuringThreads.get(threadId) === pending) this.ensuringThreads.delete(threadId);
    });
    this.ensuringThreads.set(threadId, pending);
    return pending;
  }

  private async resumeThread(threadId: string): Promise<ThreadState> {
    await this.open();
    const state = this.state(threadId);
    if (this.subscribed.has(threadId)) return state;
    this.requireDeliveryHistoryProof(threadId, this.unsettledDeliveryClientIds(threadId));
    const requestedEventRevision = state.eventRevision;
    const requestedSettingsRevision = state.settingsRevision;
    try {
      if (!codexVersion(this.appServerUserAgent)) {
        throw new Error(
          'Codex App Server version could not be identified; upgrade Codex CLI to 0.149.0 or newer',
        );
      }
      const result = await this.rpc('thread/resume', this.boundedTurns ? {
        threadId,
        excludeTurns: true,
        initialTurnsPage: boundedTurnParams(),
      } : { threadId });
      const resumedThread = this.boundedTurns && result.thread
        ? { ...result.thread, turns: turnPage(result.initialTurnsPage).turns }
        : result.thread;
      this.subscribed.add(threadId);
      this.currentThreadId ||= threadId;
      this.threadBindingKnown = true;
      if (this.isCurrentThread(threadId)) await this.onThreadBind(this, threadId);
      try {
        await this.reconcileDurableDeliveryHistory(
          threadId,
          resumedThread || null,
          {
            initialComplete: !this.boundedTurns
              && state.eventRevision === requestedEventRevision,
          },
        );
      } catch {
        // Opening the conversation is still safe. Keep durable submissions visible and block automatic
        // delivery until their native history can be reconciled without risking duplicate execution.
      }
      this.releaseDeliveryHistoryGuardIfSettled(threadId);
      state.loadedOnly = false;
      const resumedSettings = settingsFromResume(result);
      state.settings = state.settingsRevision === requestedSettingsRevision
        ? resumedSettings
        : { ...resumedSettings, ...(state.settings || {}) };
      if (state.eventRevision === requestedEventRevision) {
        state.thread = resumedThread || null;
        state.readRevision = state.revision;
        state.status = resumedThread?.status || state.status;
        const previousActiveTurnId = state.activeTurnId;
        const previousActivePrompt = state.activePrompt;
        state.activeTurnId = [...(resumedThread?.turns || [])].reverse()
          .find((turn) => turn.status === 'inProgress')?.id || null;
        const resumedPrompt = state.activeTurnId
          ? turnPrompt((resumedThread?.turns || []).find((turn) => turn.id === state.activeTurnId))
          : '';
        const last = [...(resumedThread?.turns || [])].reverse()
          .find((turn) => turn.status !== 'inProgress') || null;
        state.lastTurn = last;
        const samePendingTurn = state.activeTurnId
          && (!previousActiveTurnId || previousActiveTurnId === state.activeTurnId);
        state.activePrompt = resumedPrompt || (samePendingTurn ? previousActivePrompt : '');
        if (this.isCurrentThread(threadId)) {
          const kind = activeKind(state.status);
          if (kind) {
            this.setInbox(kind, activeTurnPrompt(state), `status:${threadId}:${kind}`);
          } else if (last?.status === 'completed' || last?.status === 'failed') {
            const completedAt = typeof last.completedAt === 'number' ? last.completedAt * 1000 : undefined;
            this.setInbox(
              'done', inboxTurnSummary(last, last) || turnPrompt(last),
              `turn:${last.id}:${last.status}`, completedAt,
            );
          }
        }
      }
      // The completion event may have happened while this WebSocket was disconnected. Resume a retained
      // next-turn queue only when the durable snapshot proves the previous turn completed successfully.
      this.wakeQueue(threadId);
    } catch (error) {
      // A newly opened TUI thread is authoritative but has no rollout until its first turn. It cannot yet
      // be resumed by a second client, so verify it against this pane's loaded-thread set and keep an empty
      // projection. turn/start persists it; the next poll then resumes normally and subscribes to events.
      if (!isMissingThreadRollout(error)) throw largeThreadUpgradeError(error, this.appServerUserAgent);
      const loaded = await this.loadedThreads();
      if (!loaded.includes(threadId)) throw error;
      state.thread ||= { id: threadId, turns: [], status: { type: 'idle' } };
      state.status ||= state.thread.status ?? null;
      state.readRevision = state.revision;
      state.loadedOnly = true;
    }
    // Every connection begins by projecting the App Server's resting snapshot. Only events received after
    // that first projection are new activity; this rule is connection-local and must not depend on when
    // Handmux itself happened to start.
    this.baseline = false;
    return state;
  }

  async readThread(threadId: string, { force = false }: { force?: boolean } = {}): Promise<AppThread | null> {
    await this.ensureThread(threadId);
    const state = this.state(threadId);
    if (state.loadedOnly && !force) return state.thread;
    // Keep refreshing this internal partial view while it still contains event-only overlays.
    const hasLiveOverlays = [...state.liveItemIds.values()].some((ids) => ids.size > 0);
    if (!force && state.thread && state.readRevision === state.revision && !hasLiveOverlays) return state.thread;
    const requestedEventRevision = state.eventRevision;
    let fresh: AppThread | undefined;
    try {
      if (this.boundedTurns) {
        const metadata = await this.rpc('thread/read', { threadId, includeTurns: false });
        const page = await this.listTurns(threadId);
        fresh = metadata.thread ? { ...metadata.thread, turns: page.turns } : undefined;
      } else {
        const result = await this.rpc('thread/read', { threadId, includeTurns: true });
        fresh = result.thread;
      }
    } catch (error) {
      throw largeThreadUpgradeError(error, this.appServerUserAgent);
    }
    // Notifications are authoritative after the read begins. A completion or status change can arrive
    // between metadata and turns/list; discard the whole two-RPC snapshot so stale active state cannot
    // overwrite that event. Leaving readRevision behind makes the next read retry convergence.
    if (state.eventRevision !== requestedEventRevision) return state.thread;
    state.thread = mergeThreadWithLive(state.thread, fresh, state.liveItemIds);
    state.loadedOnly = false;
    this.reconcileQueuedDeliveries(threadId, state.thread);
    // Lightweight overlays may advance the public revision while the two RPCs are in flight. The fresh
    // base snapshot still applies, and the cache now represents that current combined projection.
    state.readRevision = state.revision;
    state.status = fresh?.status || state.status;
    const active = [...(state.thread?.turns || [])].reverse().find((turn) => turn.status === 'inProgress');
    const previousActiveTurnId = state.activeTurnId;
    const previousActivePrompt = state.activePrompt;
    state.activeTurnId = active?.id || null;
    const snapshotPrompt = active ? turnPrompt(active) : '';
    const samePendingTurn = state.activeTurnId
      && (!previousActiveTurnId || previousActiveTurnId === state.activeTurnId);
    state.activePrompt = snapshotPrompt || (samePendingTurn ? previousActivePrompt : '');
    const last = [...(state.thread?.turns || [])].reverse()
      .find((turn) => turn.status !== 'inProgress') || null;
    state.lastTurn = last;
    if (this.isCurrentThread(threadId)) {
      const kind = activeKind(state.status);
      if (kind) {
        this.setInbox(kind, activeTurnPrompt(state), `status:${threadId}:${kind}`);
      } else if (last?.status === 'completed' || last?.status === 'failed') {
        const completedAt = typeof last.completedAt === 'number' ? last.completedAt * 1000 : undefined;
        const canonicalLast = (fresh?.turns || []).find((turn) => (
          turn.id === last.id && turn.status !== 'inProgress'
        ));
        this.setInbox(
          'done', inboxTurnSummary(canonicalLast, last) || turnPrompt(last),
          `turn:${last.id}:${last.status}`, completedAt,
        );
      } else if (state.status?.type === 'idle') {
        this.setInbox(null, '', `thread:${threadId}:idle`);
      }
    }
    this.wakeQueue(threadId);
    return state.thread;
  }

  async listTurns(
    threadId: string,
    limit = CONTROL_TURN_LIMIT,
    cursor: string | null = null,
  ): Promise<TurnPage> {
    const result = await this.rpc('thread/turns/list', {
      threadId,
      ...boundedTurnParams(limit, cursor),
    });
    return turnPage(result);
  }

  async loadedThreads(): Promise<string[]> {
    await this.open();
    const result = await this.rpc('thread/loaded/list', {});
    return Array.isArray(result?.data)
      ? result.data.filter((id): id is string => typeof id === 'string')
      : [];
  }

  async discoverThread(): Promise<string | null> {
    if (this.currentThreadId) {
      this.threadBindingKnown = true;
      await this.onThreadBind(this, this.currentThreadId);
      return this.currentThreadId;
    }
    const loaded = await this.loadedThreads();
    // Native thread/started is newer than the startup list/read RPCs. Never let their stale replies
    // overwrite a /clear (or first-thread) event that arrived while discovery was awaiting I/O.
    if (this.currentThreadId) {
      this.threadBindingKnown = true;
      await this.onThreadBind(this, this.currentThreadId);
      return this.currentThreadId;
    }
    if (this.lastStartedThreadId && loaded.includes(this.lastStartedThreadId)) {
      this.currentThreadId = this.lastStartedThreadId;
      this.threadBindingKnown = true;
      await this.onThreadBind(this, this.currentThreadId);
      return this.currentThreadId;
    }
    if (!loaded.length) {
      this.threadBindingKnown = true;
      return null;
    }
    const threads = await Promise.all(loaded.map(async (threadId, index) => {
      try {
        const result = await this.rpc('thread/read', { threadId, includeTurns: false });
        const thread = result?.thread || {};
        return {
          threadId,
          order: Number(thread.updatedAt ?? thread.createdAt ?? index),
          root: thread.parentThreadId == null && thread.ephemeral !== true,
          known: true,
        };
      } catch { return { threadId, order: index, root: false, known: false }; }
    }));
    const roots = threads.filter((thread) => thread.root);
    const candidates = roots.length ? roots : threads.filter((thread) => !thread.known);
    candidates.sort((a, b) => b.order - a.order);
    if (this.currentThreadId) {
      this.threadBindingKnown = true;
      await this.onThreadBind(this, this.currentThreadId);
      return this.currentThreadId;
    }
    this.currentThreadId = candidates[0]?.threadId || null;
    this.threadBindingKnown = true;
    if (this.currentThreadId) await this.onThreadBind(this, this.currentThreadId);
    return this.currentThreadId;
  }

  approvalsFor(threadId: string): NormalizedApproval[] {
    return [...this.approvals.values()]
      .filter((request) => request.params?.threadId === threadId)
      .map(normalizeApproval);
  }

  userInputsFor(threadId: string): NormalizedUserInput[] {
    return [...this.userInputs.values()]
      .filter((request) => request.params?.threadId === threadId)
      .map(normalizeUserInput);
  }

  decide(threadId: string, requestId: string | number, decision: string): void {
    if (typeof decision !== 'string') throw new Error('unsupported approval decision');
    const key = String(requestId);
    const request = this.approvals.get(key);
    if (!request || request.params?.threadId !== threadId) throw new Error('approval request is no longer pending');
    const approval = normalizeApproval(request);
    const resolved = request.method === 'item/permissions/requestApproval'
      ? (approval.decisions.includes(decision) ? decision : null)
      : resolveApprovalDecision(request, decision);
    if (resolved == null) throw new Error('approval decision is unavailable');
    this.requireCurrentThread(threadId);
    this.respond(request.id, request.method === 'item/permissions/requestApproval'
      ? permissionResponse(request, decision)
      : { decision: resolved });
    this.approvals.delete(key);
    this.markWorking(threadId);
    this.setInbox(
      'working', activeTurnPrompt(this.state(threadId)) || this.inbox.msg,
      `approval:${key}:resolved`, undefined, approval.correlationId,
    );
    this.bump(threadId);
    this.emitInteractionSnapshot(threadId);
  }

  answerInput(threadId: string, requestId: string | number, answers: Record<string, string[]>): void {
    const key = String(requestId);
    const request = this.userInputs.get(key);
    if (!request || request.params?.threadId !== threadId) throw new Error('user input request is no longer pending');
    const input = normalizeUserInput(request);
    const expected = new Set(input.questions.map((question) => question.id));
    const normalized: Record<string, { answers: string[] }> = {};
    for (const [questionId, value] of Object.entries(answers || {})) {
      if (!expected.has(questionId) || !Array.isArray(value) || value.some((answer) => typeof answer !== 'string')) {
        throw new Error('bad user input response');
      }
      normalized[questionId] = { answers: value };
    }
    if ([...expected].some((questionId) => !normalized[questionId]?.answers.length)) {
      throw new Error('bad user input response');
    }
    this.requireCurrentThread(threadId);
    this.respond(request.id, { answers: normalized });
    this.userInputs.delete(key);
    this.markWorking(threadId);
    this.setInbox(
      'working', activeTurnPrompt(this.state(threadId)) || this.inbox.msg,
      `input:${key}:resolved`, undefined, input.correlationId,
    );
    this.bump(threadId);
    this.emitInteractionSnapshot(threadId);
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    try { this.ws?.close(); } catch { /* already failed */ }
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(asError(error));
    }
    this.pending.clear();
    this.closeStreamListeners();
    this.onClose(this);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ws?.close(); } catch { /* already closing */ }
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Codex App Server connection closed'));
    }
    this.pending.clear();
    this.closeStreamListeners();
  }
}

export function createCodexAppServer({
  home,
  connect = connectUnixWebSocket,
  exists = fs.existsSync,
  readdir = fs.readdirSync,
  now = () => Date.now(),
  onStateChange = () => {},
  scanIntervalMs = SOCKET_SCAN_MS,
  setTimer = (callback, delay) => setInterval(callback, delay),
  clearTimer = (timer) => clearInterval(timer as NodeJS.Timeout),
  outboxStore = null,
  rpcTimeoutMs = RPC_TIMEOUT_MS,
}: CodexAppServerOptions = {}) {
  const connections = new Map<string, CodexAppConnection>();
  const queues = new Map<string, QueueState>();
  const submissions = new Map<string, InternalSubmissionReceipt>();
  const streamEvents = new Map<string, StreamJournal>();
  let persisted: ReturnType<typeof parseCodexOutboxSnapshot> = null;
  let recoveredCorruptOutbox = false;
  if (outboxStore) {
    let raw: unknown;
    let corrupt = false;
    try {
      raw = outboxStore.readStrict ? outboxStore.readStrict() : outboxStore.read?.();
    } catch (error) {
      if (error instanceof SyntaxError) corrupt = true;
      else throw error;
    }
    if (!corrupt && raw != null) {
      persisted = parseCodexOutboxSnapshot(raw);
      corrupt = persisted == null;
    }
    if (corrupt) {
      if (!outboxStore.quarantine || !outboxStore.write) {
        throw new Error('Codex outbox is corrupt and cannot be quarantined safely');
      }
      outboxStore.quarantine();
      recoveredCorruptOutbox = true;
      persisted = null;
    }
  }
  for (const record of persisted?.queues || []) {
    queues.set(`${record.pane}\0${record.threadId}`, {
      items: record.items.map((item) => ({
        ...item, clientId: item.requestId || `handmux-queue:${item.id}`,
      })),
      starting: false, draining: false, steering: new Set<string>(), editing: null, editTimer: null,
    });
  }
  for (const receipt of persisted?.receipts || []) {
    const queue = queues.get(`${receipt.pane}\0${receipt.threadId}`);
    const queuedItem = queue?.items.find((item) => item.id === receipt.queueItemId
      || (item.requestId && item.requestId === receipt.requestId));
    let normalized: CodexSubmissionReceipt = receipt;
    if (receipt.status === 'queued' && !queuedItem) {
      const { queueItemId: _queueItemId, ...pending } = receipt;
      normalized = { ...pending, status: 'pending' };
    } else if (receipt.status === 'pending' && queuedItem) {
      normalized = { ...receipt, status: 'queued', queueItemId: queuedItem.id };
    }
    submissions.set(`${receipt.pane}\0${receipt.threadId}\0${receipt.requestId}`, {
      ...normalized, settled: normalized.status !== 'pending', promise: null,
    });
  }

  function persistOutbox(): void {
    if (!outboxStore?.write) return;
    const queueRecords: CodexQueueRecord[] = [];
    for (const [key, state] of queues) {
      if (!state.items.length) continue;
      const [pane, threadId] = key.split('\0') as [string, string];
      queueRecords.push({
        pane, threadId,
        items: state.items.map(({ clientId: _clientId, ...item }) => item),
      });
    }
    const receipts = [...submissions.values()].map(({
      promise: _promise, settled: _settled, result: _result, ...receipt
    }) => receipt);
    outboxStore.write({ version: 1, queues: queueRecords, receipts });
  }
  if (recoveredCorruptOutbox) persistOutbox();

  let outboxBindTail: Promise<void> = Promise.resolve();

  function assertOutboxBindTarget(connection: CodexAppConnection, threadId: string): void {
    if (connection.closed) throw new Error('Codex App Server connection closed');
    if (!connection.isCurrentThread(threadId)) throw new Error('Codex session changed');
  }

  async function bindOutboxToCurrentPaneNow(
    boundConnection: CodexAppConnection,
    threadId: string,
  ): Promise<void> {
    assertOutboxBindTarget(boundConnection, threadId);
    const pane = boundConnection.pane;
    const targetQueueKey = `${pane}\0${threadId}`;
    const sourcePanes = new Set<string>();
    for (const key of queues.keys()) {
      const separator = key.indexOf('\0');
      if (separator < 0 || key.slice(separator + 1) !== threadId) continue;
      const sourcePane = key.slice(0, separator);
      if (sourcePane !== pane) sourcePanes.add(sourcePane);
    }
    for (const receipt of submissions.values()) {
      if (receipt.threadId === threadId && receipt.pane !== pane) sourcePanes.add(receipt.pane);
    }
    const movable: string[] = [];
    let blocked = false;
    for (const sourcePane of sourcePanes) {
      let owner = connections.get(sourcePane);
      if ((!owner || owner.closed) && exists(codexAppSocketPath(sourcePane, home))) {
        // A socket pathname can survive SIGKILL. Prove that it still accepts and initializes a client
        // before treating it as live ownership; otherwise a dead file would strand this thread's durable
        // queue forever. A newly reachable source stays blocked until its own thread binding is known.
        try { owner = await connection(sourcePane) ?? undefined; }
        catch { owner = undefined; }
        assertOutboxBindTarget(boundConnection, threadId);
      }
      if (owner && !owner.closed) {
        // `null` means two different things until discovery completes: not inspected yet, or an
        // authoritative empty loaded-thread list. Only the former can still own this outbox.
        if (!owner.threadBindingKnown || owner.currentThreadId === threadId) blocked = true;
        else movable.push(sourcePane);
        continue;
      }
      movable.push(sourcePane);
    }
    if (blocked || !movable.length) return;
    movable.sort();
    const movableSet = new Set(movable);
    const targetQueue = queues.get(targetQueueKey);
    // Never replace a QueueState object still referenced by a target-pane mutation. The next status/send
    // assertion retries binding after that short operation settles.
    const targetBusy = Boolean(targetQueue && (
      targetQueue.starting || targetQueue.draining || targetQueue.steering.size || targetQueue.editing
    )) || [...submissions.values()].some((receipt) => (
      receipt.pane === pane && receipt.threadId === threadId && receipt.promise !== null
    ));
    if (targetBusy) return;

    const sourceQueues = movable.map((sourcePane) => ({
      key: `${sourcePane}\0${threadId}`,
      state: queues.get(`${sourcePane}\0${threadId}`),
    }));
    const queueCandidates = [
      ...(targetQueue?.items || []),
      ...sourceQueues.flatMap(({ state }) => state?.items || []),
    ].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const queueItems: InternalQueueItem[] = [];
    const itemsById = new Map<string, InternalQueueItem>();
    const itemsByRequest = new Map<string, InternalQueueItem>();
    for (const item of queueCandidates) {
      const sameId = itemsById.get(item.id);
      if (sameId) {
        if (sameId.text !== item.text || sameId.requestId !== item.requestId) {
          throw new Error('Codex outbox has conflicting queued message ids');
        }
        continue;
      }
      const sameRequest = item.requestId ? itemsByRequest.get(item.requestId) : undefined;
      if (sameRequest) {
        if (sameRequest.text !== item.text) {
          throw new Error('Codex request id was already used for another message');
        }
        // Multiple old pane snapshots can contain the same retry. Point every historical item id at one
        // canonical queue item so its durable receipt remains idempotent after the merge.
        itemsById.set(item.id, sameRequest);
        continue;
      }
      const copy = { ...item };
      queueItems.push(copy);
      itemsById.set(copy.id, copy);
      if (copy.requestId) itemsByRequest.set(copy.requestId, copy);
    }

    const receiptEntries = [...submissions].filter(([, receipt]) => (
      receipt.threadId === threadId && (receipt.pane === pane || movableSet.has(receipt.pane))
    ));
    const receiptGroups = new Map<string, InternalSubmissionReceipt[]>();
    for (const [, receipt] of receiptEntries) {
      const group = receiptGroups.get(receipt.requestId) || [];
      group.push(receipt);
      receiptGroups.set(receipt.requestId, group);
    }
    const acceptedRequests = new Set<string>();
    const migratedReceipts: InternalSubmissionReceipt[] = [];
    const statusRank = { pending: 0, queued: 1, accepted: 2 } as const;
    for (const [requestId, group] of receiptGroups) {
      const text = group[0]!.text;
      if (group.some((receipt) => receipt.text !== text)) {
        throw new Error('Codex request id was already used for another message');
      }
      const ranked = [...group].sort((left, right) => (
        statusRank[right.status] - statusRank[left.status] || right.updatedAt - left.updatedAt
      ));
      const chosen = ranked[0]!;
      const queueItem = itemsByRequest.get(requestId)
        || (chosen.queueItemId ? itemsById.get(chosen.queueItemId) : undefined);
      if (queueItem && queueItem.text !== text) {
        throw new Error('Codex request id was already used for another message');
      }
      const accepted = ranked.find((receipt) => receipt.status === 'accepted');
      const status: CodexSubmissionReceipt['status'] = accepted
        ? 'accepted' : queueItem ? 'queued' : 'pending';
      if (accepted) acceptedRequests.add(requestId);
      const turnId = ranked.find((receipt) => receipt.status === 'accepted' && receipt.turnId)?.turnId;
      const result = ranked.find((receipt) => receipt.status === 'accepted' && receipt.result)?.result;
      migratedReceipts.push({
        pane,
        threadId,
        requestId,
        text,
        status,
        createdAt: Math.min(...group.map((receipt) => receipt.createdAt)),
        updatedAt: Math.max(...group.map((receipt) => receipt.updatedAt)),
        ...(status === 'queued' && queueItem ? { queueItemId: queueItem.id } : {}),
        ...(status === 'accepted' && turnId ? { turnId } : {}),
        settled: status !== 'pending',
        promise: null,
        ...(status === 'accepted' && result ? { result } : {}),
      });
    }
    const migratedItems = queueItems.filter((item) => (
      !item.requestId || !acceptedRequests.has(item.requestId)
    ));
    const migratedProofClientIds = new Set<string>();
    for (const { state } of sourceQueues) {
      for (const item of state?.items || []) migratedProofClientIds.add(item.clientId);
    }
    for (const [, receipt] of receiptEntries) {
      if (receipt.pane !== pane && receipt.status !== 'accepted') {
        migratedProofClientIds.add(receipt.requestId);
      }
    }
    const hasSourceState = sourceQueues.some(({ state }) => state !== undefined)
      || receiptEntries.some(([, receipt]) => receipt.pane !== pane);
    if (!hasSourceState) return;

    assertOutboxBindTarget(boundConnection, threadId);
    const previousQueues = new Map(queues);
    const previousSubmissions = new Map(submissions);
    for (const { key } of sourceQueues) queues.delete(key);
    if (migratedItems.length) {
      queues.set(targetQueueKey, {
        items: migratedItems,
        starting: false,
        draining: false,
        steering: new Set(),
        editing: null,
        editTimer: null,
      });
    } else queues.delete(targetQueueKey);
    for (const [key] of receiptEntries) submissions.delete(key);
    for (const receipt of migratedReceipts) {
      submissions.set(`${pane}\0${threadId}\0${receipt.requestId}`, receipt);
    }
    try {
      persistOutbox();
    } catch (error) {
      queues.clear();
      for (const [key, state] of previousQueues) queues.set(key, state);
      submissions.clear();
      for (const [key, receipt] of previousSubmissions) submissions.set(key, receipt);
      throw error;
    }
    for (const { state } of sourceQueues) {
      if (state?.editTimer) clearTimeout(state.editTimer);
    }
    await boundConnection.reconcileMigratedDeliveryHistory(threadId, migratedProofClientIds);
  }

  function bindOutboxToCurrentPane(
    connection: CodexAppConnection,
    threadId: string,
  ): Promise<void> {
    const operation = outboxBindTail.then(() => bindOutboxToCurrentPaneNow(connection, threadId));
    outboxBindTail = operation.catch(() => {});
    return operation;
  }
  let queueSequence = 0;
  let scanTimer: ScanTimer | null = null;
  let started = false;

  function connectionCandidate(pane: string): CodexAppConnection | null {
    const socketPath = codexAppSocketPath(pane, home);
    if (!exists(socketPath)) return null;
    let current = connections.get(pane);
    if (!current || current.closed) {
      current = new CodexAppConnection({
        pane, socketPath, connect, now, baseline: true, onStateChange, timeoutMs: rpcTimeoutMs,
        queueStore: queues, submissionStore: submissions,
        persistOutbox, streamEventStore: streamEvents,
        onThreadBind: bindOutboxToCurrentPane,
        nextQueueId: () => `${now().toString(36)}-${(++queueSequence).toString(36)}`,
        onClose: (closed) => { if (connections.get(pane) === closed) connections.delete(pane); },
      });
      connections.set(pane, current);
    }
    return current;
  }

  async function connection(pane: string): Promise<CodexAppConnection | null> {
    const current = connectionCandidate(pane);
    if (!current) return null;
    await current.open();
    return current;
  }

  async function observe(pane: string): Promise<{
    client: CodexAppConnection;
    threadId: string | null;
  } | null> {
    const client = await connection(pane);
    if (!client) return null;
    const threadId = await client.discoverThread();
    if (threadId) {
      await client.ensureThread(threadId);
      client.wakeQueue(threadId);
    }
    // An empty loaded-thread list is also a complete baseline. A thread started after this observation is
    // new work and must not inherit suppression merely because there was no snapshot to resume yet.
    client.baseline = false;
    return { client, threadId };
  }

  async function scan(): Promise<void> {
    const dir = codexAppSocketPath('%0', home).replace(/\/0\.sock$/, '');
    let names: string[] = [];
    try { names = readdir(dir); } catch { return; }
    await Promise.all(names.filter((name) => /^\d+\.sock$/.test(name)).map((name) => {
      const pane = `%${name.slice(0, -5)}`;
      return observe(pane).catch(() => {});
    }));
  }

  function sameGoalSnapshot(left: CodexGoal | null, right: CodexGoal | null): boolean {
    return isDeepStrictEqual(left, right);
  }

  function goalFromRpcResult(result: RpcResult): CodexGoal | null {
    const goal = result?.goal == null ? null : parseCodexGoal(result.goal);
    if (result?.goal != null && !goal) throw new Error('Codex App Server returned an invalid Goal');
    return goal;
  }

  async function readStableGoal({
    client, threadId, canApply = () => true, turnIdFor = () => null,
    emitFor = () => false, emitClear = true,
  }: {
    client: CodexAppConnection;
    threadId: string;
    canApply?: () => boolean;
    turnIdFor?: (goal: CodexGoal | null) => string | null;
    emitFor?: (goal: CodexGoal | null) => boolean;
    emitClear?: boolean;
  }): Promise<CodexGoal | null> {
    return client.withGoalRead(threadId, async () => {
      for (let attempt = 0; attempt < MAX_GOAL_READ_ATTEMPTS; attempt += 1) {
        if (!canApply()) return client.conversationGoal(threadId);
        const revision = client.conversationGoalRevision(threadId);
        const result = await client.rpc('thread/goal/get', { threadId });
        const goal = goalFromRpcResult(result);
        if (!canApply()) return client.conversationGoal(threadId);
        if (client.conversationGoalRevision(threadId) === revision) {
          client.applyGoalSnapshot(threadId, goal, turnIdFor(goal), {
            emit: emitFor(goal), emitClear,
          });
          return client.conversationGoal(threadId);
        }
        if (sameGoalSnapshot(client.conversationGoal(threadId), goal)) {
          return client.conversationGoal(threadId);
        }
      }
      throw new Error('Codex Goal state did not stabilize');
    });
  }

  async function reconcileGoalWriteStage({
    client, threadId, mutation, revision, goal, turnId, emit = true,
  }: {
    client: CodexAppConnection;
    threadId: string;
    mutation: PendingGoalMutation;
    revision: number;
    goal: CodexGoal | null;
    turnId: string | null;
    emit?: boolean;
  }): Promise<void> {
    if (!client.goalMutationOwns(threadId, mutation.token)) return;
    if (client.goalMutationIsCurrent(threadId, mutation.token, revision)) {
      client.applyGoalSnapshot(threadId, goal, turnId, { emit, emitClear: true });
      return;
    }
    if (sameGoalSnapshot(client.conversationGoal(threadId), goal)) return;

    // A different native notification raced with the write response. The response alone cannot prove
    // whether it predates or includes that notification, so refresh App Server state instead of choosing.
    await readStableGoal({
      client,
      threadId,
      canApply: () => client.goalMutationOwns(threadId, mutation.token),
      turnIdFor: (refreshed) => sameGoalSnapshot(refreshed, goal) ? turnId : null,
      emitFor: () => emit,
    });
  }

  return {
    async read(pane: string, threadId: string) {
      const client = await connection(pane);
      if (!client) return null;
      return { client, thread: await client.readThread(threadId) };
    },
    async discover(pane: string) {
      const observed = await observe(pane);
      if (!observed) return { managed: false, threadId: null };
      return { managed: true, threadId: observed.threadId };
    },
    async inboxStates(livePanes: LivePane[] = []) {
      const out: Record<string, UnknownRecord> = {};
      await Promise.all(livePanes.map(async (pane) => {
        if (!exists(codexAppSocketPath(pane.id, home))) return;
        try {
          const observed = await observe(pane.id);
          out[pane.id] = observed
            ? { ...observed.client.takeInbox(), threadId: observed.threadId }
            : { kind: null, msg: '', ts: 0, suppressPush: false, threadId: null, unavailable: true };
        } catch {
          // The pane-owned socket still proves managed ownership. Do not revive a stale Hook row merely
          // because App Server is reconnecting; chat status exposes the connection error separately.
          out[pane.id] = { kind: null, msg: '', ts: 0, suppressPush: false, threadId: null, unavailable: true };
        }
      }));
      return out;
    },
    async status(pane: string, threadId: string): Promise<CodexAppStatus> {
      const client = await connection(pane);
      if (!client) return { managed: false, queue: [], receipts: [], approvals: [], userInputs: [] };
      await client.assertCurrentThread(threadId);
      const state = await client.ensureThread(threadId);
      const activeTurnId = client.activeTurn(threadId);
      return {
        managed: true,
        threadId,
        gitBranch: state.thread?.gitInfo?.branch || null,
        status: state.status || state.thread?.status,
        activeTurnId,
        plan: activeTurnId ? state.plans.get(activeTurnId) || null : null,
        lastPlan: state.lastTurn?.id ? state.plans.get(state.lastTurn.id) || null : null,
        ...(state.goal !== undefined ? { goal: state.goal } : {}),
        settings: state.settings,
        contextUsage: state.contextUsage,
        activityKind: client.inbox.kind,
        // Session status is polled every 750ms. The durable transcript/SSE own turn content; the Web
        // client only needs this terminal status to derive the current kind. Returning the native turn
        // here can resend megabytes of tool items on every poll for a long-running conversation.
        lastTurn: state.lastTurn ? {
          id: state.lastTurn.id || null,
          status: state.lastTurn.status || null,
        } : null,
        approvals: client.approvalsFor(threadId),
        userInputs: client.userInputsFor(threadId),
        queue: client.queuedFor(threadId),
        receipts: client.submissionReceiptsFor(threadId),
        revision: state.revision,
      };
    },
    async compactorItemKeys(pane: string, threadId: string): Promise<string[]> {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      const state = await client.ensureThread(threadId);
      return [...state.compactorItemKeys];
    },
    async subscribe(
      pane: string,
      threadId: string,
      listener: StreamListener,
      afterSequence: number | null = null,
    ) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      await client.ensureThread(threadId);
      return client.subscribeStream(threadId, listener, afterSequence);
    },
    async observeConversation(pane: string, threadId: string, listener: StreamListener) {
      // Reserve the journal suffix synchronously, before opening/resuming the native thread. Goal and
      // message notifications can arrive during any of those awaits and must not fall between the
      // returned baseline cursor and the installed listener.
      const client = connectionCandidate(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      const setupEvents: CodexStreamEvent[] = [];
      let setup = true;
      let closed = false;
      let overflowed = false;
      const observation = client.observeStream(threadId, (event) => {
        if (closed) return;
        if (setup) {
          if (setupEvents.length >= MAX_OBSERVATION_SETUP_EVENTS) overflowed = true;
          else setupEvents.push(event);
          return;
        }
        try { listener(event); } catch { /* isolate the Conversation adapter */ }
      });
      const close = () => {
        if (closed) return false;
        closed = true;
        return observation.close();
      };
      try {
        await client.open();
        await client.assertCurrentThread(threadId);
        await client.ensureThread(threadId);
        // A Goal that already existed before this observer may not have a journal event. Refresh it as
        // state, but never overwrite a newer notification captured during setup with an older RPC reply.
        const goalSetupCount = setupEvents.filter((event) => (
          event.type === 'goal' || event.type === 'goalCleared'
        )).length;
        if (goalSetupCount === 0) {
          try {
            await readStableGoal({
              client,
              threadId,
              canApply: () => setupEvents.filter((event) => (
                event.type === 'goal' || event.type === 'goalCleared'
              )).length === goalSetupCount,
            });
          } catch { /* Goal state is optional on older App Server versions */ }
        }
        client.emitLiveStreamOverlays(threadId);
        if (overflowed) throw new Error('Codex Conversation observation setup buffer overflowed');

        const currentGoal = client.currentConversationGoal(threadId);
        const currentAlreadyBuffered = currentGoal?.type === 'goal' && setupEvents.some((event) => (
          event.type === 'goal'
          && event.goal.objective === currentGoal.goal.objective
          && event.goal.status === currentGoal.goal.status
          && (event.goal.createdAt == null || currentGoal.goal.createdAt == null
            || event.goal.createdAt === currentGoal.goal.createdAt)
        ));
        // This state snapshot is private to the Conversation adapter. Do not record/broadcast it through
        // emitStream: doing so would manufacture a public journal lifecycle every time a view opens.
        if (currentGoal && !currentAlreadyBuffered) {
          try { listener({ ...currentGoal, observationSnapshot: true }); } catch { /* adapter isolation */ }
        }
        // The raw listener is synchronous with journal publication, so insertion order is journal order;
        // retaining it also keeps cursor-addressed control snapshots in their exact arrival position.
        for (const event of setupEvents) {
          if (closed) throw new Error('Codex Conversation observation closed while opening');
          try { listener(event); } catch { /* adapter isolation */ }
        }
        setup = false;
        return { cursor: observation.cursor, close };
      } catch (error) {
        setup = false;
        setupEvents.length = 0;
        close();
        throw error;
      }
    },
    async observeInteractions(
      pane: string,
      threadId: string,
      listener: InteractionSnapshotListener,
    ) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      await client.ensureThread(threadId);
      // Subscribe and capture synchronously after the final await, so no request can open or resolve
      // between the baseline and observer installation.
      return client.observeInteractions(threadId, listener);
    },
    async reconcileTranscript(pane: string, threadId: string, messages: unknown) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      return { reconciled: client.reconcileTranscript(threadId, messages) };
    },
    async send(pane: string, threadId: string, text: string, requestId: string | null = null) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      return client.submit(threadId, text, requestId);
    },
    async dispatchPrompt(pane: string, threadId: string, text: string, requestId: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      return client.dispatchPromptDirect(threadId, text, requestId);
    },
    async dispatchSteer(
      pane: string,
      threadId: string,
      text: string,
      requestId: string,
      plan: { kind: 'steer-active-turn' | 'start-turn-fallback'; nativeTurnId?: string },
    ) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      return client.dispatchSteerDirect(threadId, text, requestId, plan);
    },
    async steerQueued(pane: string, threadId: string, itemId: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      return client.steerQueued(threadId, itemId);
    },
    async removeQueued(pane: string, threadId: string, itemId: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      return client.removeQueued(threadId, itemId);
    },
    async beginQueuedEdit(pane: string, threadId: string, itemId: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      return client.beginQueuedEdit(threadId, itemId);
    },
    async renewQueuedEdit(pane: string, threadId: string, itemId: string, token: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      return client.renewQueuedEdit(threadId, itemId, token);
    },
    async commitQueuedEdit(pane: string, threadId: string, itemId: string, token: string, text: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      return client.commitQueuedEdit(threadId, itemId, token, text);
    },
    async cancelQueuedEdit(pane: string, threadId: string, itemId: string, token: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      return client.cancelQueuedEdit(threadId, itemId, token);
    },
    async compact(pane: string, threadId: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      const state = await client.ensureThread(threadId);
      client.requireCurrentThread(threadId);
      state.compacting = true;
      let result;
      try {
        result = await client.rpc('thread/compact/start', { threadId });
      } catch (error) {
        state.compacting = false;
        throw error;
      }
      state.status = { type: 'active', activeFlags: [] };
      if (client.isCurrentThread(threadId)) {
        client.setInbox('compacting', '', `thread:${threadId}:compacting`);
      }
      client.bump(threadId);
      return result;
    },
    async models(pane: string, threadId: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      await client.ensureThread(threadId);
      const data: unknown[] = [];
      let cursor: string | null = null;
      do {
        const result: RpcResult = await client.rpc('model/list', cursor ? { cursor } : {});
        if (Array.isArray(result?.data)) data.push(...result.data);
        cursor = result?.nextCursor || null;
      } while (cursor && data.length < 1_000);
      return data;
    },
    async getGoal(pane: string, threadId: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      await client.ensureThread(threadId);
      return readStableGoal({
        client,
        threadId,
        emitFor: (goal) => !!goal && TERMINAL_GOAL_STATUSES.has(goal.status),
      });
    },
    async startGoal(pane: string, threadId: string, objective: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      return client.withGoalWrite(threadId, async () => {
        await client.assertCurrentThread(threadId);
        await client.ensureThread(threadId);
        // Keep the initiating turn available to a native notification that can race ahead of the RPC reply.
        const mutation = client.beginGoalMutation(threadId);
        try {
          // App Server treats a repeated non-terminal objective as an update and preserves its status and
          // usage. A user choosing "set/restart" needs a fresh native Goal even when the text is identical,
          // so clear the old native state before setting the new active objective. `active` is what enables
          // Codex's built-in automatic Goal continuation; Handmux does not synthesize a turn or Goal object.
          const clearRevision = client.conversationGoalRevision(threadId);
          client.requireCurrentThread(threadId);
          await client.rpc('thread/goal/clear', { threadId });
          await reconcileGoalWriteStage({
            client, threadId, mutation, revision: clearRevision, goal: null, turnId: null, emit: false,
          });
          const setRevision = client.conversationGoalRevision(threadId);
          client.requireCurrentThread(threadId);
          const result = await client.rpc('thread/goal/set', { threadId, objective, status: 'active' });
          const goal = goalFromRpcResult(result);
          if (!goal) throw new Error('Codex App Server returned an invalid Goal');
          await reconcileGoalWriteStage({
            client, threadId, mutation, revision: setRevision,
            goal, turnId: mutation.turnId,
          });
          client.bump(threadId);
          return client.conversationGoal(threadId);
        } finally {
          client.endGoalMutation(threadId, mutation.token);
        }
      });
    },
    async updateGoal(pane: string, threadId: string, updates: UnknownRecord) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      return client.withGoalWrite(threadId, async () => {
        await client.assertCurrentThread(threadId);
        await client.ensureThread(threadId);
        const mutation = client.beginGoalMutation(threadId);
        try {
          const goalRevision = client.conversationGoalRevision(threadId);
          client.requireCurrentThread(threadId);
          const result = await client.rpc('thread/goal/set', { threadId, ...updates });
          const goal = goalFromRpcResult(result);
          await reconcileGoalWriteStage({
            client, threadId, mutation, revision: goalRevision,
            goal, turnId: mutation.turnId,
          });
          client.bump(threadId);
          return client.conversationGoal(threadId);
        } finally {
          client.endGoalMutation(threadId, mutation.token);
        }
      });
    },
    async clearGoal(pane: string, threadId: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      return client.withGoalWrite(threadId, async () => {
        await client.assertCurrentThread(threadId);
        await client.ensureThread(threadId);
        const mutation = client.beginGoalMutation(threadId);
        try {
          const goalRevision = client.conversationGoalRevision(threadId);
          client.requireCurrentThread(threadId);
          await client.rpc('thread/goal/clear', { threadId });
          await reconcileGoalWriteStage({
            client, threadId, mutation, revision: goalRevision, goal: null, turnId: null, emit: false,
          });
          client.bump(threadId);
          return { cleared: true };
        } finally {
          client.endGoalMutation(threadId, mutation.token);
        }
      });
    },
    async updateSettings(pane: string, threadId: string, updates: UnknownRecord) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      const state = await client.ensureThread(threadId);
      client.requireCurrentThread(threadId);
      await client.rpc('thread/settings/update', { threadId, ...updates });
      state.settings = { ...(state.settings || {}), ...updates };
      state.settingsRevision += 1;
      client.bump(threadId);
      return state.settings;
    },
    async interrupt(pane: string, threadId: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      const state = await client.ensureThread(threadId);
      let turnId = state.activeTurnId;
      if (!turnId) {
        const thread = await client.readThread(threadId);
        client.requireCurrentThread(threadId);
        turnId = [...(thread?.turns || [])].reverse().find((turn) => turn.status === 'inProgress')?.id || null;
      }
      if (!turnId) return { interrupted: false };
      client.requireCurrentThread(threadId);
      await client.rpc('turn/interrupt', { threadId, turnId });
      return { interrupted: true, turnId };
    },
    async decide(pane: string, threadId: string, requestId: string | number, decision: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      await client.ensureThread(threadId);
      client.decide(threadId, requestId, decision);
      return { ok: true };
    },
    async answerInput(
      pane: string,
      threadId: string,
      requestId: string | number,
      answers: Record<string, string[]>,
    ) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      await client.ensureThread(threadId);
      client.answerInput(threadId, requestId, answers);
      return { ok: true };
    },
    start() {
      if (started) return;
      started = true;
      scan().catch(() => {});
      scanTimer = setTimer(() => scan().catch(() => {}), scanIntervalMs);
      scanTimer?.unref?.();
    },
    close() {
      started = false;
      if (scanTimer) clearTimer(scanTimer);
      scanTimer = null;
      for (const client of connections.values()) client.close();
      connections.clear();
      for (const queue of queues.values()) {
        if (queue.editTimer) clearTimeout(queue.editTimer);
      }
      queues.clear();
      submissions.clear();
      streamEvents.clear();
    },
  };
}
