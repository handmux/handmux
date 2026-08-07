import fs from 'node:fs';
import net from 'node:net';
import WebSocket from 'ws';
import { codexAppSocketPath } from './cli/codexManaged.js';

const RPC_TIMEOUT_MS = 8_000;
const SOCKET_SCAN_MS = 2_000;
const MAX_QUEUED_MESSAGES = 20;
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);
const USER_INPUT_METHOD = 'item/tool/requestUserInput';
const SIMPLE_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);

function structuredDecision(value, index) {
  const execpolicy = value?.acceptWithExecpolicyAmendment?.execpolicy_amendment;
  if (Array.isArray(execpolicy) && execpolicy.length && execpolicy.every((part) => typeof part === 'string')) {
    return { id: `structured:${index}`, type: 'execpolicy', rule: execpolicy };
  }
  const network = value?.applyNetworkPolicyAmendment?.network_policy_amendment;
  if (network && typeof network.host === 'string' && ['allow', 'deny'].includes(network.action)) {
    return { id: `structured:${index}`, type: 'networkPolicy', host: network.host, action: network.action };
  }
  return null;
}

function approvalDecision(value, index) {
  return typeof value === 'string' && SIMPLE_DECISIONS.has(value)
    ? value
    : structuredDecision(value, index);
}

function asError(error) {
  if (error instanceof Error) return error;
  if (error?.message) return new Error(error.message);
  return new Error(typeof error === 'string' ? error : JSON.stringify(error));
}

function inputText(content) {
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (!item || typeof item !== 'object') return '';
    if (item.type === 'text' || item.type === 'inputText') return item.text || '';
    if (item.type === 'localImage') return item.path || '';
    if (item.type === 'image') return item.url || '';
    return '';
  }).filter(Boolean).join('\n');
}

function diffInfo(change) {
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

function jsonText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function collabToolName(tool) {
  return ({
    spawnAgent: 'spawn_agent',
    sendInput: 'send_message',
    resumeAgent: 'followup_task',
    wait: 'wait_agent',
    closeAgent: 'interrupt_agent',
  })[tool] || `collaboration:${tool || 'agent'}`;
}

function toolFromItem(item, fileChange = item.changes?.[0] || {}) {
  if (item.type === 'commandExecution') {
    return {
      name: 'exec_command',
      input: { cmd: item.command, cwd: item.cwd },
      result: item.status === 'inProgress' ? null : (item.aggregatedOutput || ''),
      isError: item.status === 'failed' || item.status === 'declined',
    };
  }
  if (item.type === 'fileChange') {
    return {
      name: 'apply_patch',
      input: { file_path: fileChange.path || '', patch: fileChange.diff || '' },
      result: item.status === 'inProgress' ? null : (item.status === 'completed' ? '' : item.status),
      isError: item.status === 'failed' || item.status === 'declined',
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

function projectedMessageId(turn, turnIndex, item, itemIndex) {
  const turnId = turn?.id || `turn-${turnIndex}`;
  // When a completed snapshot canonicalizes a live notification under a different item id, retain the
  // connection-local first id. It is identity metadata only; all content/order still comes from snapshot.
  const itemId = item?._handmuxId || item?.id || `item-${itemIndex}`;
  return `codex:${turnId}:${itemId}`;
}

// Project App Server's partial item snapshot for connection-level tests/debugging. This is deliberately not
// the conversation transcript source: current App Server snapshots can omit completed tools. The durable
// transcript route reads Codex's exact rollout instead.
export function projectCodexThread(thread) {
  const messages = [];
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
  return messages.map((message, k) => ({ ...message, k }));
}

function normalizeApproval(message) {
  const { params = {} } = message;
  const permissions = message.method === 'item/permissions/requestApproval';
  const supplied = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.map(approvalDecision).filter(Boolean)
    : null;
  return {
    id: String(message.id),
    type: permissions ? 'permissions' : message.method === 'item/fileChange/requestApproval' ? 'file' : 'command',
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    command: params.command || null,
    cwd: params.cwd || null,
    reason: params.reason || null,
    decisions: permissions
      ? ['accept', 'acceptForSession', 'decline']
      : supplied || ['accept', 'acceptForSession', 'decline', 'cancel'],
  };
}

function resolveApprovalDecision(request, selected) {
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

function permissionResponse(request, decision) {
  const requested = request.params?.permissions || {};
  const permissions = {};
  if (decision !== 'decline') {
    if (requested.network != null) permissions.network = requested.network;
    if (requested.fileSystem != null) permissions.fileSystem = requested.fileSystem;
  }
  return { permissions, scope: decision === 'acceptForSession' ? 'session' : 'turn' };
}

function normalizeUserInput(message) {
  const { params = {} } = message;
  return {
    id: String(message.id),
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    autoResolutionMs: params.autoResolutionMs ?? null,
    questions: Array.isArray(params.questions) ? params.questions.map((question) => ({
      id: String(question.id || ''),
      header: String(question.header || ''),
      question: String(question.question || ''),
      isOther: !!question.isOther,
      isSecret: !!question.isSecret,
      options: Array.isArray(question.options) ? question.options.map((option) => ({
        label: String(option.label || ''),
        description: String(option.description || ''),
      })) : null,
    })).filter((question) => question.id && question.question) : [],
  };
}

function turnSummary(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const message = [...items].reverse().find((item) => item?.type === 'agentMessage' && item.text?.trim());
  return message?.text || turn?.error?.message || '';
}

function activeKind(status) {
  if (status?.type !== 'active') return null;
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  return flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput') ? 'permission' : 'working';
}

function liveItemSignature(item) {
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
function mergeTurnWithLive(previous, fresh, liveIds) {
  if (!previous) return fresh;
  const previousById = new Map((previous.items || []).filter((item) => item?.id).map((item) => [item.id, item]));
  const freshItems = (Array.isArray(fresh?.items) ? fresh.items : []).map((item) => {
    const stableId = previousById.get(item?.id)?._handmuxId;
    return stableId && !item._handmuxId ? { ...item, _handmuxId: stableId } : item;
  });
  if (!liveIds?.size) return { ...previous, ...fresh, items: freshItems };
  const freshById = new Map(freshItems.filter((item) => item?.id).map((item) => [item.id, item]));
  const freshMatches = new Map();
  for (const item of freshItems) {
    const signature = liveItemSignature(item);
    if (!signature || !item?.id) continue;
    if (!freshMatches.has(signature)) freshMatches.set(signature, []);
    freshMatches.get(signature).push(item);
  }
  const matchedFreshIds = new Set((previous.items || [])
    .filter((item) => item?.id && !liveIds.has(item.id) && freshById.has(item.id))
    .map((item) => item.id));
  const overlays = [];
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

function mergeThreadWithLive(previous, fresh, liveItemIds) {
  if (!previous || !fresh) return fresh;
  const previousTurns = new Map((previous.turns || []).map((turn) => [turn.id, turn]));
  const seen = new Set();
  const turns = (fresh.turns || []).map((turn) => {
    seen.add(turn.id);
    const merged = mergeTurnWithLive(previousTurns.get(turn.id), turn, liveItemIds.get(turn.id));
    if (liveItemIds.get(turn.id)?.size === 0) liveItemIds.delete(turn.id);
    return merged;
  });
  for (const turn of previous.turns || []) {
    if (!seen.has(turn.id) && liveItemIds.has(turn.id)) turns.push(turn);
  }
  return { ...previous, ...fresh, turns };
}

function settingsFromResume(result) {
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

function contextUsageFromNotification(tokenUsage) {
  const usedTokens = tokenUsage?.last?.totalTokens;
  const totalTokens = tokenUsage?.modelContextWindow;
  if (!Number.isFinite(usedTokens) || usedTokens < 0
    || !Number.isFinite(totalTokens) || totalTokens <= 0) return null;
  return { usedTokens, totalTokens };
}

function sandboxMode(policy) {
  if (policy?.type === 'readOnly') return 'read-only';
  if (policy?.type === 'workspaceWrite') return 'workspace-write';
  if (policy?.type === 'dangerFullAccess') return 'danger-full-access';
  return null;
}

function clearThreadParams(settings = {}) {
  const params = { sessionStartSource: 'clear' };
  for (const key of ['model', 'modelProvider', 'serviceTier', 'cwd', 'approvalPolicy', 'approvalsReviewer']) {
    if (settings[key] != null) params[key] = settings[key];
  }
  if (Array.isArray(settings.runtimeWorkspaceRoots)) params.runtimeWorkspaceRoots = settings.runtimeWorkspaceRoots;
  const profile = settings.activePermissionProfile?.id;
  if (profile) params.permissions = profile;
  else {
    const sandbox = sandboxMode(settings.sandboxPolicy);
    if (sandbox) params.sandbox = sandbox;
  }
  return params;
}

function connectUnixWebSocket(socketPath) {
  return new WebSocket('ws://localhost/rpc', {
    createConnection: () => net.createConnection(socketPath),
    perMessageDeflate: false,
  });
}

class CodexAppConnection {
  constructor({
    pane, socketPath, connect = connectUnixWebSocket, timeoutMs = RPC_TIMEOUT_MS,
    now = () => Date.now(), baseline = false, onStateChange = () => {}, onClose = () => {},
    queueStore = new Map(), nextQueueId = () => `${Date.now()}`,
  }) {
    this.pane = pane;
    this.socketPath = socketPath;
    this.connect = connect;
    this.timeoutMs = timeoutMs;
    this.onClose = onClose;
    this.now = now;
    this.baseline = baseline;
    this.onStateChange = onStateChange;
    this.queueStore = queueStore;
    this.nextQueueId = nextQueueId;
    this.nextId = 1;
    this.pending = new Map();
    this.approvals = new Map();
    this.userInputs = new Map();
    this.threadState = new Map();
    this.subscribed = new Set();
    this.lastStartedThreadId = null;
    this.currentThreadId = null;
    this.inbox = { kind: null, msg: '', ts: 0, key: 'idle', suppressPush: false };
    this.opening = null;
    this.closed = false;
  }

  open() {
    if (this.opening) return this.opening;
    this.opening = this._open().catch((error) => {
      this.fail(error);
      throw error;
    });
    return this.opening;
  }

  async _open() {
    this.ws = this.connect(this.socketPath);
    this.ws.on('message', (data) => this.onLine(data.toString()));
    this.ws.once('close', () => this.fail(new Error('Codex App Server connection closed')));
    // Keep a lifetime error listener, not only the startup rejector: otherwise a stale socket that errors
    // once during connect and again while closing can become an unhandled EventEmitter error.
    this.ws.on('error', (error) => this.fail(error));
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    await this.rpc('initialize', {
      clientInfo: { name: 'handmux', title: 'Handmux', version: process.env.npm_package_version || 'unknown' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
    return this;
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(asError(message.error));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id != null && APPROVAL_METHODS.has(message.method)) {
      this.approvals.set(String(message.id), message);
      const approval = normalizeApproval(message);
      this.markWaiting(approval.threadId, 'waitingOnApproval');
      if (this.isCurrentThread(approval.threadId)) {
        this.setInbox('permission', approval.reason || approval.command || '', `approval:${message.id}`);
      }
      this.bump(message.params?.threadId);
      return;
    }
    if (message.id != null && message.method === USER_INPUT_METHOD) {
      this.userInputs.set(String(message.id), message);
      const input = normalizeUserInput(message);
      this.markWaiting(input.threadId, 'waitingOnUserInput');
      if (this.isCurrentThread(input.threadId)) {
        this.setInbox('permission', input.questions[0]?.question || '', `input:${message.id}`);
      }
      this.bump(message.params?.threadId);
      return;
    }
    if (!message.method) return;
    const params = message.params || {};
    if ((message.method === 'item/started' || message.method === 'item/completed') && params.item) {
      this.upsertLiveItem(params.threadId, params.turnId, params.item);
    } else if (message.method === 'serverRequest/resolved') {
      this.approvals.delete(String(params.requestId));
      this.userInputs.delete(String(params.requestId));
      this.markWorking(params.threadId);
      if (this.isCurrentThread(params.threadId)) this.setInbox('working', '', `resolved:${params.requestId}`);
    } else if (message.method === 'thread/status/changed') {
      this.state(params.threadId).status = params.status;
      const kind = activeKind(params.status);
      if (!this.isCurrentThread(params.threadId)) {
        /* retain the state for that thread, but never let a late background event rebind this pane */
      } else if (kind === 'working' && this.inbox.kind === 'compacting') {
        /* keep the more specific state until thread/compacted or idle */
      } else if (kind) {
        this.setInbox(kind, kind === 'permission' && this.inbox.kind === kind ? this.inbox.msg : '', `status:${params.threadId}:${kind}`);
      } else if (params.status?.type === 'idle' && this.inbox.kind === 'compacting') {
        this.setInbox(null, '', `thread:${params.threadId}:compacted`);
      }
    } else if (message.method === 'turn/started') {
      const state = this.state(params.threadId);
      state.activeTurnId = params.turn?.id || params.turnId || null;
      state.status = { type: 'active', activeFlags: [] };
      this.upsertTurn(params.threadId, params.turn);
      if (this.isCurrentThread(params.threadId)) {
        this.setInbox('working', '', `turn:${params.turn?.id || params.turnId}:started`);
      }
    } else if (message.method === 'turn/completed') {
      const state = this.state(params.threadId);
      state.activeTurnId = null;
      state.status = { type: 'idle' };
      const turn = this.upsertTurn(params.threadId, params.turn) || params.turn || null;
      state.lastTurn = turn;
      const status = turn?.status;
      if (!this.isCurrentThread(params.threadId)) {
        /* stale/background completion: update only its own thread state */
      } else if (status === 'completed' || status === 'failed') {
        const completedAt = typeof turn?.completedAt === 'number' ? turn.completedAt * 1000 : undefined;
        this.setInbox('done', turnSummary(turn), `turn:${turn?.id || params.turnId}:${status}`, completedAt);
      } else {
        this.setInbox(null, '', `turn:${params.turn?.id || params.turnId}:${status || 'ended'}`);
      }
      if (status === 'completed') {
        void this.drainQueue(params.threadId).catch(() => {});
      }
    } else if (message.method === 'thread/settings/updated') {
      this.state(params.threadId).settings = params.threadSettings || null;
    } else if (message.method === 'thread/tokenUsage/updated') {
      this.state(params.threadId).contextUsage = contextUsageFromNotification(params.tokenUsage);
    } else if (message.method === 'thread/compacted') {
      this.state(params.threadId).status = { type: 'idle' };
      if (this.isCurrentThread(params.threadId)) this.setInbox(null, '', `thread:${params.threadId}:compacted`);
      void this.drainQueue(params.threadId).catch(() => {});
    } else if (message.method === 'thread/started') {
      const previous = this.currentThreadId;
      this.lastStartedThreadId = params.thread?.id || params.threadId || null;
      this.currentThreadId = this.lastStartedThreadId;
      if (previous && previous !== this.lastStartedThreadId) {
        this.setInbox(null, '', `thread:${this.lastStartedThreadId || 'unknown'}:started`);
      }
    }
    this.bump(params.threadId);
  }

  setInbox(kind, msg = '', key = `${kind || 'idle'}`, ts = undefined) {
    if (this.inbox.key === key && this.inbox.kind === kind && this.inbox.msg === msg) return;
    this.inbox = { kind, msg, ts: ts ?? this.now(), key, suppressPush: this.baseline };
    queueMicrotask(() => Promise.resolve(this.onStateChange(this.pane)).catch(() => {}));
  }

  takeInbox() {
    const snapshot = { ...this.inbox };
    this.inbox.suppressPush = false;
    return snapshot;
  }

  state(threadId) {
    if (!this.threadState.has(threadId)) this.threadState.set(threadId, {
      revision: 0, readRevision: -1, thread: null, status: null, activeTurnId: null, settings: null,
      contextUsage: null, lastTurn: null, loadedOnly: false, liveItemIds: new Map(),
    });
    return this.threadState.get(threadId);
  }

  queueKey(threadId) { return `${this.pane}\0${threadId}`; }

  queueState(threadId, create = true) {
    const key = this.queueKey(threadId);
    let state = this.queueStore.get(key);
    if (!state && create) {
      state = { items: [], starting: false, draining: false, steering: new Set() };
      this.queueStore.set(key, state);
    }
    return state || null;
  }

  queuedFor(threadId) {
    return (this.queueState(threadId, false)?.items || []).map((item) => ({ ...item }));
  }

  cleanupQueue(threadId) {
    const state = this.queueState(threadId, false);
    if (state && !state.items.length && !state.starting && !state.draining && !state.steering.size) {
      this.queueStore.delete(this.queueKey(threadId));
    }
  }

  discardQueue(threadId) {
    this.queueStore.delete(this.queueKey(threadId));
    this.bump(threadId);
  }

  activeTurn(threadId) {
    const state = this.state(threadId);
    return state.activeTurnId
      || [...(state.thread?.turns || [])].reverse().find((turn) => turn.status === 'inProgress')?.id
      || null;
  }

  enqueue(threadId, text) {
    const queue = this.queueState(threadId);
    if (queue.items.length >= MAX_QUEUED_MESSAGES) throw new Error('pending message queue is full');
    const item = { id: this.nextQueueId(), text, createdAt: this.now() };
    queue.items.push(item);
    this.bump(threadId);
    return { ...item };
  }

  async startTurn(threadId, text) {
    const queue = this.queueState(threadId);
    queue.starting = true;
    try {
      const state = this.state(threadId);
      const result = await this.rpc('turn/start', { threadId, input: [{ type: 'text', text }] });
      state.activeTurnId = result.turn?.id || null;
      state.status = { type: 'active', activeFlags: [] };
      this.currentThreadId ||= threadId;
      this.setInbox('working', '', `turn:${result.turn?.id || 'starting'}:started`);
      this.bump(threadId);
      if (state.loadedOnly) {
        // turn/start normally persists the first rollout synchronously; attach this observer immediately.
        await this.ensureThread(threadId);
      }
      return result;
    } finally {
      queue.starting = false;
      this.cleanupQueue(threadId);
    }
  }

  async submit(threadId, text) {
    const state = await this.ensureThread(threadId);
    const queue = this.queueState(threadId);
    if (this.activeTurn(threadId) || state.status?.type === 'active'
      || queue.items.length || queue.starting || queue.draining) {
      return { queued: true, item: this.enqueue(threadId, text) };
    }
    return this.startTurn(threadId, text);
  }

  async drainQueue(threadId) {
    this.assertCurrentThread(threadId);
    const queue = this.queueState(threadId, false);
    if (!queue?.items.length || queue.draining || queue.starting || this.activeTurn(threadId)
      || this.state(threadId).status?.type === 'active') return;
    queue.draining = true;
    const item = queue.items[0];
    try {
      await this.startTurn(threadId, item.text);
      if (queue.items[0]?.id === item.id) queue.items.shift();
      else queue.items = queue.items.filter((candidate) => candidate.id !== item.id);
      this.bump(threadId);
    } finally {
      queue.draining = false;
      this.cleanupQueue(threadId);
    }
  }

  async steerQueued(threadId, itemId) {
    await this.ensureThread(threadId);
    const queue = this.queueState(threadId, false);
    const item = queue?.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('queued message is no longer pending');
    if (queue.draining && queue.items[0]?.id === itemId) {
      throw new Error('queued message is already being sent');
    }
    if (queue.steering.has(itemId)) throw new Error('queued message is already being sent');
    queue.steering.add(itemId);
    try {
      const turnId = this.activeTurn(threadId);
      let result;
      if (turnId) {
        result = await this.rpc('turn/steer', {
          threadId, expectedTurnId: turnId, input: [{ type: 'text', text: item.text }],
        });
      } else {
        if (queue.starting || queue.draining) throw new Error('queued message is already being sent');
        result = await this.startTurn(threadId, item.text);
      }
      queue.items = queue.items.filter((candidate) => candidate.id !== itemId);
      this.bump(threadId);
      return { steered: true, item: { ...item }, result };
    } finally {
      queue.steering.delete(itemId);
      this.cleanupQueue(threadId);
    }
  }

  removeQueued(threadId, itemId) {
    const queue = this.queueState(threadId, false);
    const index = queue?.items.findIndex((candidate) => candidate.id === itemId) ?? -1;
    if (index < 0) throw new Error('queued message is no longer pending');
    if (queue.draining && index === 0) throw new Error('queued message is already being sent');
    if (queue.steering.has(itemId)) throw new Error('queued message is already being sent');
    queue.items.splice(index, 1);
    this.bump(threadId);
    this.cleanupQueue(threadId);
    return { removed: true };
  }

  isCurrentThread(threadId) {
    if (!threadId) return false;
    if (!this.currentThreadId) this.currentThreadId = threadId;
    return this.currentThreadId === threadId;
  }

  assertCurrentThread(threadId) {
    if (!this.isCurrentThread(threadId)) throw new Error('Codex session changed');
  }

  upsertTurn(threadId, incoming) {
    if (!threadId || !incoming?.id) return null;
    const state = this.state(threadId);
    state.thread ||= { id: threadId, turns: [], status: { type: 'active', activeFlags: [] } };
    state.thread.turns ||= [];
    const index = state.thread.turns.findIndex((turn) => turn.id === incoming.id);
    const previous = index >= 0 ? state.thread.turns[index] : null;
    const turn = mergeTurnWithLive(previous, incoming, state.liveItemIds.get(incoming.id));
    if (index >= 0) state.thread.turns[index] = turn;
    else state.thread.turns.push(turn);
    return turn;
  }

  upsertLiveItem(threadId, turnId, item) {
    if (!threadId || !turnId || !item?.id) return;
    const state = this.state(threadId);
    let ids = state.liveItemIds.get(turnId);
    if (!ids) {
      ids = new Set();
      state.liveItemIds.set(turnId, ids);
      if (state.liveItemIds.size > 20) state.liveItemIds.delete(state.liveItemIds.keys().next().value);
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
  }

  bump(threadId) {
    if (threadId) this.state(threadId).revision++;
  }

  markWaiting(threadId, flag) {
    if (!threadId) return;
    this.state(threadId).status = { type: 'active', activeFlags: [flag] };
  }

  markWorking(threadId) {
    if (!threadId) return;
    const state = this.state(threadId);
    if (state.status?.type === 'active') state.status = { ...state.status, activeFlags: [] };
  }

  write(message) {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) throw new Error('Codex App Server is unavailable');
    this.ws.send(JSON.stringify(message));
  }

  rpc(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
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

  notify(method, params = {}) { this.write({ jsonrpc: '2.0', method, params }); }
  respond(id, result) { this.write({ jsonrpc: '2.0', id, result }); }

  async ensureThread(threadId) {
    await this.open();
    const state = this.state(threadId);
    if (this.subscribed.has(threadId)) return state;
    try {
      const result = await this.rpc('thread/resume', { threadId });
      this.subscribed.add(threadId);
      state.thread = result.thread || null;
      state.readRevision = state.revision;
      state.status = result.thread?.status || state.status;
      state.settings = settingsFromResume(result);
      state.loadedOnly = false;
      state.activeTurnId = [...(result.thread?.turns || [])].reverse()
        .find((turn) => turn.status === 'inProgress')?.id || null;
      this.currentThreadId ||= threadId;
      if (this.isCurrentThread(threadId)) {
        const kind = activeKind(state.status);
        if (kind) {
          this.setInbox(kind, '', `status:${threadId}:${kind}`);
        } else {
          const last = [...(result.thread?.turns || [])].reverse().find((turn) => turn.status !== 'inProgress');
          if (last?.status === 'completed' || last?.status === 'failed') {
            const completedAt = typeof last.completedAt === 'number' ? last.completedAt * 1000 : undefined;
            this.setInbox('done', turnSummary(last), `turn:${last.id}:${last.status}`, completedAt);
          }
        }
      }
    } catch (error) {
      // A newly opened TUI thread is authoritative but has no rollout until its first turn. It cannot yet
      // be resumed by a second client, so verify it against this pane's loaded-thread set and keep an empty
      // projection. turn/start persists it; the next poll then resumes normally and subscribes to events.
      if (!/no rollout found/i.test(error?.message || '')) throw error;
      const loaded = await this.loadedThreads();
      if (!loaded.includes(threadId)) throw error;
      state.thread ||= { id: threadId, turns: [], status: { type: 'idle' } };
      state.status ||= state.thread.status;
      state.readRevision = state.revision;
      state.loadedOnly = true;
    }
    return state;
  }

  async readThread(threadId) {
    await this.ensureThread(threadId);
    const state = this.state(threadId);
    if (state.loadedOnly) return state.thread;
    // Keep refreshing this internal partial view while it still contains event-only overlays.
    const hasLiveOverlays = [...state.liveItemIds.values()].some((ids) => ids.size > 0);
    if (state.thread && state.readRevision === state.revision && !hasLiveOverlays) return state.thread;
    const requestedRevision = state.revision;
    const result = await this.rpc('thread/read', { threadId, includeTurns: true });
    state.thread = mergeThreadWithLive(state.thread, result.thread, state.liveItemIds);
    state.readRevision = requestedRevision;
    state.status = result.thread?.status || state.status;
    const active = [...(state.thread?.turns || [])].reverse().find((turn) => turn.status === 'inProgress');
    if (active) state.activeTurnId = active.id;
    return state.thread;
  }

  async loadedThreads() {
    await this.open();
    const result = await this.rpc('thread/loaded/list', {});
    return Array.isArray(result?.data) ? result.data.filter((id) => typeof id === 'string') : [];
  }

  async discoverThread() {
    if (this.currentThreadId) return this.currentThreadId;
    const loaded = await this.loadedThreads();
    if (this.lastStartedThreadId && loaded.includes(this.lastStartedThreadId)) return this.lastStartedThreadId;
    if (loaded.length <= 1) return loaded[0] || null;
    const threads = await Promise.all(loaded.map(async (threadId, index) => {
      try {
        const result = await this.rpc('thread/read', { threadId, includeTurns: false });
        const thread = result?.thread || {};
        return { threadId, order: Number(thread.updatedAt ?? thread.createdAt ?? index) };
      } catch { return { threadId, order: index }; }
    }));
    threads.sort((a, b) => b.order - a.order);
    return threads[0]?.threadId || null;
  }

  approvalsFor(threadId) {
    return [...this.approvals.values()]
      .filter((request) => request.params?.threadId === threadId)
      .map(normalizeApproval);
  }

  userInputsFor(threadId) {
    return [...this.userInputs.values()]
      .filter((request) => request.params?.threadId === threadId)
      .map(normalizeUserInput);
  }

  decide(threadId, requestId, decision) {
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
    this.setInbox('working', '', `approval:${key}:resolved`);
    this.bump(threadId);
  }

  answerInput(threadId, requestId, answers) {
    const key = String(requestId);
    const request = this.userInputs.get(key);
    if (!request || request.params?.threadId !== threadId) throw new Error('user input request is no longer pending');
    const input = normalizeUserInput(request);
    const expected = new Set(input.questions.map((question) => question.id));
    const normalized = {};
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
    this.setInbox('working', '', `input:${key}:resolved`);
    this.bump(threadId);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    try { this.ws?.close(); } catch { /* already failed */ }
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(asError(error));
    }
    this.pending.clear();
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
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  const connections = new Map();
  const queues = new Map();
  let queueSequence = 0;
  let scanTimer = null;
  let started = false;
  let priming = false;

  async function connection(pane, { baseline = false } = {}) {
    const socketPath = codexAppSocketPath(pane, home);
    if (!exists(socketPath)) return null;
    let current = connections.get(pane);
    if (!current || current.closed) {
      current = new CodexAppConnection({
        pane, socketPath, connect, now, baseline: baseline || priming, onStateChange,
        queueStore: queues, nextQueueId: () => `${now().toString(36)}-${(++queueSequence).toString(36)}`,
        onClose: (closed) => { if (connections.get(pane) === closed) connections.delete(pane); },
      });
      connections.set(pane, current);
    }
    await current.open();
    return current;
  }

  async function observe(pane, { baseline = false } = {}) {
    const client = await connection(pane, { baseline });
    if (!client) return null;
    const threadId = await client.discoverThread();
    if (threadId) await client.ensureThread(threadId);
    client.baseline = false;
    return { client, threadId };
  }

  async function scan({ baseline = false } = {}) {
    const dir = codexAppSocketPath('%0', home).replace(/\/0\.sock$/, '');
    let names = [];
    try { names = readdir(dir); } catch { return; }
    await Promise.all(names.filter((name) => /^\d+\.sock$/.test(name)).map((name) => {
      const pane = `%${name.slice(0, -5)}`;
      return observe(pane, { baseline }).catch(() => {});
    }));
  }

  return {
    async read(pane, threadId) {
      const client = await connection(pane);
      if (!client) return null;
      return { client, thread: await client.readThread(threadId) };
    },
    async discover(pane) {
      const observed = await observe(pane);
      if (!observed) return { managed: false, threadId: null };
      return { managed: true, threadId: observed.threadId };
    },
    async inboxStates(livePanes = []) {
      const out = {};
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
    async status(pane, threadId) {
      const client = await connection(pane);
      if (!client) return { managed: false };
      const state = await client.ensureThread(threadId);
      return {
        managed: true,
        threadId,
        gitBranch: state.thread?.gitInfo?.branch || null,
        status: state.status || state.thread?.status,
        activeTurnId: state.activeTurnId,
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
    async send(pane, threadId, text) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      client.assertCurrentThread(threadId);
      return client.submit(threadId, text);
    },
    async steerQueued(pane, threadId, itemId) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      client.assertCurrentThread(threadId);
      return client.steerQueued(threadId, itemId);
    },
    async removeQueued(pane, threadId, itemId) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      client.assertCurrentThread(threadId);
      return client.removeQueued(threadId, itemId);
    },
    async compact(pane, threadId) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      client.assertCurrentThread(threadId);
      const state = await client.ensureThread(threadId);
      const result = await client.rpc('thread/compact/start', { threadId });
      state.status = { type: 'active', activeFlags: [] };
      client.setInbox('compacting', '', `thread:${threadId}:compacting`);
      client.bump(threadId);
      return result;
    },
    async clear(pane, threadId) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      client.assertCurrentThread(threadId);
      const current = await client.ensureThread(threadId);
      const result = await client.rpc('thread/start', clearThreadParams(current.settings));
      const nextThreadId = result.thread?.id;
      if (!nextThreadId) throw new Error('Codex App Server did not start a new thread');
      const next = client.state(nextThreadId);
      next.thread = result.thread;
      next.status = result.thread?.status || { type: 'idle' };
      next.settings = settingsFromResume(result);
      next.loadedOnly = false;
      next.revision++;
      next.readRevision = next.revision;
      client.subscribed.add(nextThreadId);
      client.lastStartedThreadId = nextThreadId;
      client.currentThreadId = nextThreadId;
      client.discardQueue(threadId);
      client.setInbox(null, '', `thread:${nextThreadId}:started`);
      return { threadId: nextThreadId };
    },
    async models(pane, threadId) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      client.assertCurrentThread(threadId);
      await client.ensureThread(threadId);
      const data = [];
      let cursor = null;
      do {
        const result = await client.rpc('model/list', cursor ? { cursor } : {});
        if (Array.isArray(result?.data)) data.push(...result.data);
        cursor = result?.nextCursor || null;
      } while (cursor && data.length < 1_000);
      return data;
    },
    async updateSettings(pane, threadId, updates) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      client.assertCurrentThread(threadId);
      const state = await client.ensureThread(threadId);
      await client.rpc('thread/settings/update', { threadId, ...updates });
      state.settings = { ...(state.settings || {}), ...updates };
      client.bump(threadId);
      return state.settings;
    },
    async interrupt(pane, threadId) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      client.assertCurrentThread(threadId);
      const thread = await client.readThread(threadId);
      const state = client.state(threadId);
      const turnId = state.activeTurnId || [...(thread.turns || [])].reverse().find((turn) => turn.status === 'inProgress')?.id;
      if (!turnId) return { interrupted: false };
      await client.rpc('turn/interrupt', { threadId, turnId });
      client.setInbox(null, '', `turn:${turnId}:interrupted`);
      return { interrupted: true, turnId };
    },
    async decide(pane, threadId, requestId, decision) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      client.assertCurrentThread(threadId);
      await client.ensureThread(threadId);
      client.decide(threadId, requestId, decision);
      return { ok: true };
    },
    async answerInput(pane, threadId, requestId, answers) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      client.assertCurrentThread(threadId);
      await client.ensureThread(threadId);
      client.answerInput(threadId, requestId, answers);
      return { ok: true };
    },
    start() {
      if (started) return;
      started = true;
      priming = true;
      scan({ baseline: true }).catch(() => {}).finally(() => { priming = false; });
      scanTimer = setTimer(() => scan().catch(() => {}), scanIntervalMs);
      scanTimer?.unref?.();
    },
    close() {
      started = false;
      if (scanTimer) clearTimer(scanTimer);
      scanTimer = null;
      for (const client of connections.values()) client.close();
      connections.clear();
      queues.clear();
    },
  };
}
