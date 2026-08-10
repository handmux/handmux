import fs from 'node:fs';
import net from 'node:net';
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
  CodexQueueItem, CodexQueueRecord, CodexSubmissionReceipt,
} from './codexQueueProtocol.js';
import type {
  CodexGoal, CodexProjectedStreamEvent, CodexStreamEvent,
} from './codexStreamProtocol.js';

const RPC_TIMEOUT_MS = 8_000;
const SOCKET_SCAN_MS = 2_000;
const MAX_QUEUED_MESSAGES = 20;
const MAX_SUBMISSION_RECEIPTS = 256;
const SUBMISSION_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_STREAM_EVENTS = 512;
const MAX_STREAM_MESSAGE_IDS = 100;
const QUEUE_EDIT_LEASE_MS = 30_000;
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);
const USER_INPUT_METHOD = 'item/tool/requestUserInput';
const SIMPLE_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
const TERMINAL_GOAL_STATUSES = new Set(['blocked', 'usageLimited', 'budgetLimited', 'complete']);

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
  goalTurnId: string | null;
}

interface InboxState {
  kind: InboxKind;
  msg: string;
  ts: number;
  key: string;
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

interface NormalizedApproval {
  id: string;
  type: 'permissions' | 'file' | 'command';
  threadId: string;
  turnId?: string;
  itemId?: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  decisions: Array<string | StructuredDecision>;
}

interface NormalizedQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

interface NormalizedUserInput {
  id: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  autoResolutionMs: unknown;
  questions: NormalizedQuestion[];
}

interface ScanTimer { unref?(): void }

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
  outboxStore?: { read?: () => unknown; write?: (value: unknown) => unknown } | null;
  rpcTimeoutMs?: number;
}

interface LivePane extends UnknownRecord { id: string }

interface CodexAppStatus extends UnknownRecord {
  managed: boolean;
  queue: CodexQueueItem[];
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

function turnSummary(turn: AppTurn | null | undefined): string {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const message = [...items].reverse().find((item) => item?.type === 'agentMessage' && item.text?.trim());
  return message?.text || turn?.error?.message || '';
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
  readonly threadState: Map<string, ThreadState>;
  readonly subscribed: Set<string>;
  lastStartedThreadId: string | null;
  currentThreadId: string | null;
  inbox: InboxState;
  opening: Promise<this> | null;
  closed: boolean;
  ws?: WebSocket;

  constructor({
    pane, socketPath, connect = connectUnixWebSocket, timeoutMs = RPC_TIMEOUT_MS,
    now = () => Date.now(), baseline = true, onStateChange = () => {}, onClose = () => {},
    queueStore = new Map(), submissionStore = new Map(), nextQueueId = () => `${Date.now()}`,
    persistOutbox = () => {}, streamEventStore = new Map(),
  }: CodexAppConnectionOptions) {
    this.pane = pane;
    this.socketPath = socketPath;
    this.connect = connect;
    this.timeoutMs = timeoutMs;
    this.onClose = onClose;
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
    this.threadState = new Map();
    this.subscribed = new Set();
    this.lastStartedThreadId = null;
    this.currentThreadId = null;
    this.inbox = { kind: null, msg: '', ts: 0, key: 'idle', suppressPush: false };
    this.opening = null;
    this.closed = false;
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
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await this.rpc('initialize', {
      clientInfo: { name: 'handmux', title: 'Handmux', version: process.env.npm_package_version || 'unknown' },
      capabilities: { experimentalApi: true },
    });
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
        );
      }
      this.bump(message.params?.threadId);
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
        );
      }
      this.bump(message.params?.threadId);
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
      if (params.item.type === 'agentMessage') {
        const state = this.state(params.threadId);
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
      const state = this.state(params.threadId);
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
      this.approvals.delete(String(params.requestId));
      this.userInputs.delete(String(params.requestId));
      this.markWorking(params.threadId);
      if (this.isCurrentThread(params.threadId)) {
        this.setInbox(
          'working', activeTurnPrompt(this.state(params.threadId)) || this.inbox.msg,
          `resolved:${params.requestId}`,
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
        this.setInbox(kind, pendingMessage || activeMessage, `status:${params.threadId}:${kind}`);
      } else if (params.status?.type === 'idle' && this.inbox.kind === 'compacting') {
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
        this.setInbox('done', turnSummary(turn) || prompt, `turn:${turn?.id || params.turnId}:${status}`, completedAt);
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
      // Native Goal notifications do not consistently carry turnId. A terminal transition is agent-side
      // work, so bind it to the turn that is currently producing it instead of emitting an unanchored card
      // that the chat can only append at the live tail.
      const state = this.state(params.threadId);
      const notifiedGoal = parseCodexGoal(params.goal);
      const turnId = params.turnId || (notifiedGoal && TERMINAL_GOAL_STATUSES.has(notifiedGoal.status)
        ? state.activeTurnId : null);
      this.applyGoalSnapshot(params.threadId, notifiedGoal, turnId);
    } else if (message.method === 'thread/goal/cleared') {
      if (this.applyGoalSnapshot(params.threadId, null, params.turnId)) {
        this.emitStream({ type: 'goalCleared', threadId: params.threadId, turnId: params.turnId || null });
      }
    } else if (message.method === 'thread/settings/updated') {
      const state = this.state(params.threadId);
      state.settings = params.threadSettings
        ? { ...(state.settings || {}), ...params.threadSettings }
        : state.settings;
    } else if (message.method === 'thread/tokenUsage/updated') {
      this.state(params.threadId).contextUsage = contextUsageFromNotification(params.tokenUsage);
    } else if (message.method === 'thread/compacted') {
      this.state(params.threadId).status = { type: 'idle' };
      if (this.isCurrentThread(params.threadId)) this.setInbox(null, '', `thread:${params.threadId}:compacted`);
      void this.drainQueue(params.threadId).catch(() => {});
    } else if (message.method === 'thread/started') {
      const startedThreadId = params.thread?.id || params.threadId || null;
      // Collaboration child threads share this App Server connection. They are independent work, not a
      // replacement for the root TUI conversation represented by this pane.
      if (startedThreadId && params.thread?.parentThreadId == null) {
        const previous = this.currentThreadId;
        this.lastStartedThreadId = startedThreadId;
        this.currentThreadId = startedThreadId;
        if (previous && previous !== startedThreadId) {
          // A TUI-originated /clear switches this pane without going through Handmux's request path. Any
          // pending messages still belong to the old conversation and must never drain after the switch.
          this.discardQueue(previous);
          this.setInbox(null, '', `thread:${startedThreadId}:started`);
        }
      }
    }
    this.bump(params.threadId);
  }

  setInbox(kind: InboxKind, msg = '', key = `${kind || 'idle'}`, ts?: number): void {
    if (this.inbox.key === key && this.inbox.kind === kind && this.inbox.msg === msg) return;
    this.inbox = { kind, msg, ts: ts ?? this.now(), key, suppressPush: this.baseline };
    queueMicrotask(() => Promise.resolve(this.onStateChange(this.pane)).catch(() => {}));
  }

  takeInbox() {
    const snapshot = { ...this.inbox };
    this.inbox.suppressPush = false;
    return snapshot;
  }

  state(threadId: string): ThreadState {
    if (!this.threadState.has(threadId)) this.threadState.set(threadId, {
      revision: 0, readRevision: -1, thread: null, status: null, activeTurnId: null, settings: null,
      activePrompt: '', contextUsage: null, lastTurn: null, loadedOnly: false, liveItemIds: new Map(),
      completedAgentItemIds: new Set(), plans: new Map(), goal: undefined, goalTurnId: null,
    });
    return this.threadState.get(threadId)!;
  }

  applyGoalSnapshot(
    threadId: string | null | undefined,
    goal: unknown,
    turnId: string | null | undefined = null,
    { emit = true }: { emit?: boolean } = {},
  ): boolean {
    if (!threadId) return false;
    const normalizedGoal = goal == null ? null : parseCodexGoal(goal);
    if (goal != null && !normalizedGoal) return false;
    const goalValue = normalizedGoal;
    const state = this.state(threadId);
    const previous = state.goal;
    const replaced = !!goalValue && (!previous || previous.createdAt !== goalValue.createdAt
      || previous.objective !== goalValue.objective);
    state.goal = goalValue;
    if (!goalValue || !TERMINAL_GOAL_STATUSES.has(goalValue.status)) state.goalTurnId = null;
    else if (turnId) state.goalTurnId = turnId;
    else if (replaced) state.goalTurnId = null;
    if (!emit || !goalValue) return previous !== state.goal;
    const enteredTerminal = TERMINAL_GOAL_STATUSES.has(goalValue.status)
      && previous?.status !== goalValue.status;
    const restarted = !!previous && TERMINAL_GOAL_STATUSES.has(previous.status) && goalValue.status === 'active';
    if (!replaced && !enteredTerminal && !restarted) return false;
    // A terminal Goal without an originating turn can be read as state, but cannot be placed truthfully in
    // the conversation. Its durable rollout entry will render at the exact historical position instead.
    if (TERMINAL_GOAL_STATUSES.has(goalValue.status) && !turnId) return true;
    this.emitStream({
      type: 'goal', threadId, turnId: turnId || null,
      event: restarted ? 'restarted'
        : TERMINAL_GOAL_STATUSES.has(goalValue.status) ? goalValue.status : 'set',
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
    if (!queue?.items.length || queue.editing || state.status?.type !== 'idle'
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

  reconcileQueuedDeliveries(
    threadId: string,
    source: AppThread | AppTurn | AppItem | null | undefined,
  ): boolean {
    const delivered = deliveredClientMessages(source);
    if (!delivered.size) return false;
    const queue = this.queueState(threadId, false);
    if (!queue?.items.length) return false;
    const removed = queue.items.filter((item) => delivered.has(item.clientId));
    const removedIds = new Set(removed.map((item) => item.id));
    if (!removedIds.size) return false;
    for (const item of removed) {
      this.markSubmissionAccepted(threadId, item, delivered.get(item.clientId) ?? null);
    }
    queue.items = queue.items.filter((item) => !removedIds.has(item.id));
    if (queue.editing && removedIds.has(queue.editing.itemId)) {
      this.clearQueueEditTimer(queue);
      queue.editing = null;
    }
    this.bump(threadId);
    this.cleanupQueue(threadId);
    this.persistOutbox();
    return true;
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
    this.persistOutbox();
    this.bump(threadId);
  }

  activeTurn(threadId: string): string | null {
    const state = this.state(threadId);
    return state.activeTurnId
      || [...(state.thread?.turns || [])].reverse().find((turn) => turn.status === 'inProgress')?.id
      || null;
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
      this.setInbox('working', state.activePrompt, `turn:${result.turn?.id || 'starting'}:started`);
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
    const queue = this.queueState(threadId);
    const knownState = this.state(threadId);
    if (this.activeTurn(threadId) || knownState.status?.type === 'active'
      || queue.items.length || queue.starting || queue.draining) {
      return { queued: true, item: this.enqueue(threadId, text, requestId) };
    }
    const state = await this.ensureThread(threadId);
    if (this.activeTurn(threadId) || state.status?.type === 'active'
      || queue.items.length || queue.starting || queue.draining) {
      return { queued: true, item: this.enqueue(threadId, text, requestId) };
    }
    return this.startTurn(threadId, text, requestId);
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
    let thread: AppThread | null;
    try { thread = await this.readThread(threadId, { force: true }); } catch (error) {
      if (!/no rollout found/i.test(asError(error).message)) throw error;
      thread = this.state(threadId).thread;
    }
    const delivered = deliveredClientMessages(thread);
    if (delivered.has(receipt.requestId)) {
      receipt.status = 'accepted';
      receipt.updatedAt = this.now();
      receipt.settled = true;
      delete receipt.queueItemId;
      const turnId = delivered.get(receipt.requestId);
      if (turnId) receipt.turnId = turnId;
      this.persistOutbox();
      return this.submissionResult(threadId, receipt);
    }
    return this.runSubmission(threadId, receipt);
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
    if (!queue?.items.length || queue.draining || queue.starting || queue.editing || this.activeTurn(threadId)
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
      this.bump(threadId);
      this.persistOutbox();
    } finally {
      queue.draining = false;
      this.cleanupQueue(threadId);
    }
  }

  async steerQueued(threadId: string, itemId: string) {
    await this.ensureThread(threadId);
    const queue = this.queueState(threadId, false);
    if (!queue) throw new Error('queued message is no longer pending');
    const item = queue?.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('queued message is no longer pending');
    if (queue.draining && queue.items[0]?.id === itemId) {
      throw new Error('queued message is already being sent');
    }
    if (queue.editing?.itemId === itemId) throw new Error('queued message is being edited');
    if (queue.steering.has(itemId)) throw new Error('queued message is already being sent');
    queue.steering.add(itemId);
    try {
      const turnId = this.activeTurn(threadId);
      let result;
      if (turnId) {
        result = await this.rpc('turn/steer', {
          threadId, expectedTurnId: turnId, input: [{ type: 'text', text: item.text }],
          clientUserMessageId: item.clientId,
        });
      } else {
        if (queue.starting || queue.draining) throw new Error('queued message is already being sent');
        result = await this.startTurn(threadId, item.text, item.clientId);
      }
      this.markSubmissionAccepted(threadId, item, result?.turn?.id || result?.turnId || turnId || null);
      queue.items = queue.items.filter((candidate) => candidate.id !== itemId);
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

  async assertCurrentThread(threadId: string): Promise<void> {
    if (!this.currentThreadId) await this.discoverThread();
    if (!this.isCurrentThread(threadId)) throw new Error('Codex session changed');
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
    if (state?.goal && TERMINAL_GOAL_STATUSES.has(state.goal.status) && state.goalTurnId) {
      this.emitStream({
        type: 'goal', threadId, turnId: state.goalTurnId,
        event: state.goal.status, goal: state.goal,
      });
    }
    return () => this.streamListeners.delete(subscription);
  }

  emitStream(event: unknown): void {
    const parsed = parseCodexStreamEvent(event);
    if (!parsed || parsed.type === 'error' || !parsed.threadId) return;
    const projected = this.recordStreamEvent(parsed);
    if (!projected) return;
    for (const subscription of this.streamListeners) {
      if (subscription.threadId !== projected.threadId) continue;
      try { subscription.listener(projected); } catch { /* one browser must not break the App Server observer */ }
    }
  }

  closeStreamListeners() {
    for (const subscription of this.streamListeners) {
      try { subscription.listener({ type: 'disconnected', threadId: subscription.threadId }); } catch { /* closing */ }
    }
    this.streamListeners.clear();
  }

  bump(threadId: string | null | undefined): void {
    if (threadId) this.state(threadId).revision++;
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
    await this.open();
    const state = this.state(threadId);
    if (this.subscribed.has(threadId)) return state;
    try {
      const result = await this.rpc('thread/resume', { threadId });
      this.subscribed.add(threadId);
      state.thread = result.thread || null;
      this.reconcileQueuedDeliveries(threadId, state.thread);
      state.readRevision = state.revision;
      state.status = result.thread?.status || state.status;
      state.settings = settingsFromResume(result);
      state.loadedOnly = false;
      const previousActiveTurnId = state.activeTurnId;
      const previousActivePrompt = state.activePrompt;
      state.activeTurnId = [...(result.thread?.turns || [])].reverse()
        .find((turn) => turn.status === 'inProgress')?.id || null;
      const resumedPrompt = state.activeTurnId
        ? turnPrompt((result.thread?.turns || []).find((turn) => turn.id === state.activeTurnId))
        : '';
      const last = [...(result.thread?.turns || [])].reverse().find((turn) => turn.status !== 'inProgress') || null;
      state.lastTurn = last;
      const samePendingTurn = state.activeTurnId
        && (!previousActiveTurnId || previousActiveTurnId === state.activeTurnId);
      state.activePrompt = resumedPrompt || (samePendingTurn ? previousActivePrompt : '');
      this.currentThreadId ||= threadId;
      if (this.isCurrentThread(threadId)) {
        const kind = activeKind(state.status);
        if (kind) {
          this.setInbox(kind, activeTurnPrompt(state), `status:${threadId}:${kind}`);
        } else {
          if (last?.status === 'completed' || last?.status === 'failed') {
            const completedAt = typeof last.completedAt === 'number' ? last.completedAt * 1000 : undefined;
            this.setInbox('done', turnSummary(last) || turnPrompt(last), `turn:${last.id}:${last.status}`, completedAt);
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
      if (!/no rollout found/i.test(asError(error).message)) throw error;
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
    const requestedRevision = state.revision;
    const result = await this.rpc('thread/read', { threadId, includeTurns: true });
    state.thread = mergeThreadWithLive(state.thread, result.thread, state.liveItemIds);
    state.loadedOnly = false;
    this.reconcileQueuedDeliveries(threadId, state.thread);
    state.readRevision = requestedRevision;
    state.status = result.thread?.status || state.status;
    const active = [...(state.thread?.turns || [])].reverse().find((turn) => turn.status === 'inProgress');
    if (active?.id) state.activeTurnId = active.id;
    return state.thread;
  }

  async loadedThreads(): Promise<string[]> {
    await this.open();
    const result = await this.rpc('thread/loaded/list', {});
    return Array.isArray(result?.data)
      ? result.data.filter((id): id is string => typeof id === 'string')
      : [];
  }

  async discoverThread(): Promise<string | null> {
    if (this.currentThreadId) return this.currentThreadId;
    const loaded = await this.loadedThreads();
    if (this.lastStartedThreadId && loaded.includes(this.lastStartedThreadId)) {
      this.currentThreadId = this.lastStartedThreadId;
      return this.currentThreadId;
    }
    if (!loaded.length) return null;
    const threads = await Promise.all(loaded.map(async (threadId, index) => {
      try {
        const result = await this.rpc('thread/read', { threadId, includeTurns: false });
        const thread = result?.thread || {};
        return {
          threadId,
          order: Number(thread.updatedAt ?? thread.createdAt ?? index),
          root: thread.parentThreadId == null,
          known: true,
        };
      } catch { return { threadId, order: index, root: false, known: false }; }
    }));
    const roots = threads.filter((thread) => thread.root);
    const candidates = roots.length ? roots : threads.filter((thread) => !thread.known);
    candidates.sort((a, b) => b.order - a.order);
    this.currentThreadId = candidates[0]?.threadId || null;
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
    this.respond(request.id, request.method === 'item/permissions/requestApproval'
      ? permissionResponse(request, decision)
      : { decision: resolved });
    this.approvals.delete(key);
    this.markWorking(threadId);
    this.setInbox('working', activeTurnPrompt(this.state(threadId)) || this.inbox.msg, `approval:${key}:resolved`);
    this.bump(threadId);
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
    this.respond(request.id, { answers: normalized });
    this.userInputs.delete(key);
    this.markWorking(threadId);
    this.setInbox('working', activeTurnPrompt(this.state(threadId)) || this.inbox.msg, `input:${key}:resolved`);
    this.bump(threadId);
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
  const persisted = parseCodexOutboxSnapshot(outboxStore?.read?.());
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
  let queueSequence = 0;
  let scanTimer: ScanTimer | null = null;
  let started = false;

  async function connection(pane: string): Promise<CodexAppConnection | null> {
    const socketPath = codexAppSocketPath(pane, home);
    if (!exists(socketPath)) return null;
    let current = connections.get(pane);
    if (!current || current.closed) {
      current = new CodexAppConnection({
        pane, socketPath, connect, now, baseline: true, onStateChange, timeoutMs: rpcTimeoutMs,
        queueStore: queues, submissionStore: submissions,
        persistOutbox, streamEventStore: streamEvents,
        nextQueueId: () => `${now().toString(36)}-${(++queueSequence).toString(36)}`,
        onClose: (closed) => { if (connections.get(pane) === closed) connections.delete(pane); },
      });
      connections.set(pane, current);
    }
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
      if (!client) return { managed: false, queue: [], approvals: [], userInputs: [] };
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
        lastTurn: state.lastTurn,
        approvals: client.approvalsFor(threadId),
        userInputs: client.userInputsFor(threadId),
        queue: client.queuedFor(threadId),
        revision: state.revision,
      };
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
      const result = await client.rpc('thread/compact/start', { threadId });
      state.status = { type: 'active', activeFlags: [] };
      client.setInbox('compacting', '', `thread:${threadId}:compacting`);
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
      const result = await client.rpc('thread/goal/get', { threadId });
      const goal = result?.goal == null ? null : parseCodexGoal(result.goal);
      if (result?.goal != null && !goal) throw new Error('Codex App Server returned an invalid Goal');
      client.applyGoalSnapshot(threadId, goal, null, {
        emit: !!goal && TERMINAL_GOAL_STATUSES.has(goal.status),
      });
      return goal;
    },
    async updateGoal(pane: string, threadId: string, updates: UnknownRecord) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      await client.ensureThread(threadId);
      const result = await client.rpc('thread/goal/set', { threadId, ...updates });
      const goal = result?.goal == null ? null : parseCodexGoal(result.goal);
      if (result?.goal != null && !goal) throw new Error('Codex App Server returned an invalid Goal');
      client.applyGoalSnapshot(threadId, goal);
      client.bump(threadId);
      return goal;
    },
    async clearGoal(pane: string, threadId: string) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      await client.ensureThread(threadId);
      await client.rpc('thread/goal/clear', { threadId });
      if (client.applyGoalSnapshot(threadId, null, null, { emit: false })) {
        client.emitStream({ type: 'goalCleared', threadId, turnId: null });
      }
      client.bump(threadId);
      return { cleared: true };
    },
    async updateSettings(pane: string, threadId: string, updates: UnknownRecord) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.assertCurrentThread(threadId);
      const state = await client.ensureThread(threadId);
      await client.rpc('thread/settings/update', { threadId, ...updates });
      state.settings = { ...(state.settings || {}), ...updates };
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
        turnId = [...(thread?.turns || [])].reverse().find((turn) => turn.status === 'inProgress')?.id || null;
      }
      if (!turnId) return { interrupted: false };
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
