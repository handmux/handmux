import fs from 'node:fs';
import net from 'node:net';
import WebSocket from 'ws';
import { codexAppSocketPath } from './cli/codexManaged.js';

const RPC_TIMEOUT_MS = 8_000;
const SOCKET_SCAN_MS = 2_000;
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);
const USER_INPUT_METHOD = 'item/tool/requestUserInput';
const SIMPLE_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);

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

// App Server already returns one stable ordered item list. Project that authoritative state into the same
// small message contract ChatView uses; k is the stable flattened ordinal and therefore keeps pagination,
// deduplication, and /clear replacement behavior unchanged on the phone.
export function projectCodexThread(thread) {
  const messages = [];
  for (const turn of thread?.turns || []) {
    const ts = typeof turn.startedAt === 'number' ? new Date(turn.startedAt * 1000).toISOString() : undefined;
    for (const item of turn.items || []) {
      if (item.type === 'userMessage') {
        const text = inputText(item.content);
        if (text.trim()) messages.push({ type: 'text', role: 'user', text, ts });
      } else if (item.type === 'agentMessage') {
        if (item.text?.trim()) messages.push({ type: 'text', role: 'assistant', text: item.text, ts });
      } else if (item.type === 'reasoning') {
        const text = [...(item.summary || []), ...(item.content || [])].join('\n');
        if (text.trim()) messages.push({ type: 'thinking', role: 'assistant', text, ts });
      } else if (item.type === 'contextCompaction') {
        messages.push({ type: 'compact', ts });
      } else if (item.type === 'fileChange') {
        const changes = item.changes?.length ? item.changes : [{}];
        for (const change of changes) messages.push({ type: 'tool', role: 'assistant', tool: toolFromItem(item, change), ts });
      } else {
        const tool = toolFromItem(item);
        if (tool) messages.push({ type: 'tool', role: 'assistant', tool, ts });
      }
    }
    if (turn.status === 'interrupted') messages.push({ type: 'interrupt', ts });
  }
  return messages.map((message, k) => ({ ...message, k }));
}

function normalizeApproval(message) {
  const { params = {} } = message;
  const supplied = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.filter((value) => SIMPLE_DECISIONS.has(value))
    : null;
  return {
    id: String(message.id),
    type: message.method === 'item/fileChange/requestApproval' ? 'file' : 'command',
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    command: params.command || null,
    cwd: params.cwd || null,
    reason: params.reason || null,
    decisions: supplied?.length ? supplied : ['accept', 'acceptForSession', 'decline', 'cancel'],
  };
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

function liveMessageSignature(item) {
  if (item?.type === 'userMessage') {
    const text = inputText(item.content);
    return text ? `userMessage\0${text}` : null;
  }
  if (item?.type === 'agentMessage') {
    return item.text ? `agentMessage\0${item.text}` : null;
  }
  return null;
}

// App Server snapshots are the durable source of truth. Item notifications are only a temporary overlay
// because a concurrent thread/read can briefly omit an item that just started or completed. As soon as a
// snapshot contains that item (by id, or by matching user/agent content), retire the overlay and use the
// snapshot copy; the two channels must never become parallel transcript stores.
function mergeTurnWithLive(previous, fresh, liveIds) {
  if (!previous || !liveIds?.size) return fresh;
  const freshItems = Array.isArray(fresh?.items) ? fresh.items : [];
  const freshById = new Map(freshItems.filter((item) => item?.id).map((item) => [item.id, item]));
  const freshMessages = new Map();
  for (const item of freshItems) {
    const signature = liveMessageSignature(item);
    if (!signature || !item?.id) continue;
    if (!freshMessages.has(signature)) freshMessages.set(signature, []);
    freshMessages.get(signature).push(item);
  }
  const merged = [];
  const seen = new Set();
  for (const item of previous.items || []) {
    let next = freshById.get(item?.id);
    if (liveIds.has(item?.id)) {
      if (next) {
        liveIds.delete(item.id);
      } else {
        const signature = liveMessageSignature(item);
        const canonical = signature
          ? freshMessages.get(signature)?.find((candidate) => !seen.has(candidate.id))
          : null;
        if (canonical) {
          next = canonical;
          liveIds.delete(item.id);
        } else {
          next = item;
        }
      }
    }
    if (!next?.id || seen.has(next.id)) continue;
    merged.push(next);
    seen.add(next.id);
  }
  for (const item of freshItems) {
    if (!item?.id || seen.has(item.id)) continue;
    merged.push(item);
    seen.add(item.id);
  }
  return { ...previous, ...fresh, items: merged };
}

function mergeThreadWithLive(previous, fresh, liveItemIds) {
  if (!previous || !fresh || !liveItemIds.size) return fresh;
  const previousTurns = new Map((previous.turns || []).map((turn) => [turn.id, turn]));
  const seen = new Set();
  const turns = (fresh.turns || []).map((turn) => {
    seen.add(turn.id);
    return mergeTurnWithLive(previousTurns.get(turn.id), turn, liveItemIds.get(turn.id));
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
  constructor({ pane, socketPath, connect = connectUnixWebSocket, timeoutMs = RPC_TIMEOUT_MS, now = () => Date.now(), baseline = false, onStateChange = () => {}, onClose = () => {} }) {
    this.pane = pane;
    this.socketPath = socketPath;
    this.connect = connect;
    this.timeoutMs = timeoutMs;
    this.onClose = onClose;
    this.now = now;
    this.baseline = baseline;
    this.onStateChange = onStateChange;
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
      this.currentThreadId = approval.threadId || this.currentThreadId;
      this.markWaiting(approval.threadId, 'waitingOnApproval');
      this.setInbox('permission', approval.reason || approval.command || '', `approval:${message.id}`);
      this.bump(message.params?.threadId);
      return;
    }
    if (message.id != null && message.method === USER_INPUT_METHOD) {
      this.userInputs.set(String(message.id), message);
      const input = normalizeUserInput(message);
      this.currentThreadId = input.threadId || this.currentThreadId;
      this.markWaiting(input.threadId, 'waitingOnUserInput');
      this.setInbox('permission', input.questions[0]?.question || '', `input:${message.id}`);
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
      this.setInbox('working', '', `resolved:${params.requestId}`);
    } else if (message.method === 'thread/status/changed') {
      this.state(params.threadId).status = params.status;
      this.currentThreadId = params.threadId || this.currentThreadId;
      const kind = activeKind(params.status);
      if (kind === 'working' && this.inbox.kind === 'compacting') {
        /* keep the more specific state until thread/compacted or idle */
      } else if (kind) {
        this.setInbox(kind, kind === 'permission' && this.inbox.kind === kind ? this.inbox.msg : '', `status:${params.threadId}:${kind}`);
      } else if (params.status?.type === 'idle' && this.inbox.kind === 'compacting') {
        this.setInbox(null, '', `thread:${params.threadId}:compacted`);
      }
    } else if (message.method === 'turn/started') {
      const state = this.state(params.threadId);
      state.activeTurnId = params.turn?.id || params.turnId || null;
      this.upsertTurn(params.threadId, params.turn);
      this.currentThreadId = params.threadId || this.currentThreadId;
      this.setInbox('working', '', `turn:${params.turn?.id || params.turnId}:started`);
    } else if (message.method === 'turn/completed') {
      const state = this.state(params.threadId);
      state.activeTurnId = null;
      const turn = this.upsertTurn(params.threadId, params.turn) || params.turn || null;
      state.lastTurn = turn;
      this.currentThreadId = params.threadId || this.currentThreadId;
      const status = turn?.status;
      if (status === 'completed' || status === 'failed') {
        const completedAt = typeof turn?.completedAt === 'number' ? turn.completedAt * 1000 : undefined;
        this.setInbox('done', turnSummary(turn), `turn:${turn?.id || params.turnId}:${status}`, completedAt);
      } else {
        this.setInbox(null, '', `turn:${params.turn?.id || params.turnId}:${status || 'ended'}`);
      }
    } else if (message.method === 'thread/settings/updated') {
      this.state(params.threadId).settings = params.threadSettings || null;
    } else if (message.method === 'thread/compacted') {
      this.setInbox(null, '', `thread:${params.threadId}:compacted`);
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
      lastTurn: null, loadedOnly: false, liveItemIds: new Map(),
    });
    return this.threadState.get(threadId);
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
      this.currentThreadId = threadId;
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
    if (state.thread && state.readRevision === state.revision) return state.thread;
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
    if (!SIMPLE_DECISIONS.has(decision)) throw new Error('unsupported approval decision');
    const key = String(requestId);
    const request = this.approvals.get(key);
    if (!request || request.params?.threadId !== threadId) throw new Error('approval request is no longer pending');
    const approval = normalizeApproval(request);
    if (!approval.decisions.includes(decision)) throw new Error('approval decision is unavailable');
    this.respond(request.id, { decision });
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
        status: state.status || state.thread?.status,
        activeTurnId: state.activeTurnId,
        settings: state.settings,
        activityKind: client.inbox.kind,
        lastTurn: state.lastTurn,
        approvals: client.approvalsFor(threadId),
        userInputs: client.userInputsFor(threadId),
        revision: state.revision,
      };
    },
    async send(pane, threadId, text) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      const state = await client.ensureThread(threadId);
      const result = await client.rpc('turn/start', { threadId, input: [{ type: 'text', text }] });
      state.activeTurnId = result.turn?.id || null;
      state.status = { type: 'active', activeFlags: [] };
      client.currentThreadId = threadId;
      client.setInbox('working', '', `turn:${result.turn?.id || 'starting'}:started`);
      client.bump(threadId);
      if (state.loadedOnly) {
        // turn/start normally writes the first rollout synchronously. Try to attach this observer now;
        // if persistence is still settling, the 750 ms status poll retries the same verified resume.
        await client.ensureThread(threadId);
      }
      return result;
    },
    async compact(pane, threadId) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
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
      client.setInbox(null, '', `thread:${nextThreadId}:started`);
      return { threadId: nextThreadId };
    },
    async models(pane, threadId) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
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
      const state = await client.ensureThread(threadId);
      await client.rpc('thread/settings/update', { threadId, ...updates });
      state.settings = { ...(state.settings || {}), ...updates };
      client.bump(threadId);
      return state.settings;
    },
    async interrupt(pane, threadId) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
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
      await client.ensureThread(threadId);
      client.decide(threadId, requestId, decision);
      return { ok: true };
    },
    async answerInput(pane, threadId, requestId, answers) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
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
    },
  };
}
