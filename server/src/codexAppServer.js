import fs from 'node:fs';
import net from 'node:net';
import WebSocket from 'ws';
import { codexAppSocketPath } from './cli/codexManaged.js';

const RPC_TIMEOUT_MS = 8_000;
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);
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

function connectUnixWebSocket(socketPath) {
  return new WebSocket('ws://localhost/rpc', {
    createConnection: () => net.createConnection(socketPath),
    perMessageDeflate: false,
  });
}

class CodexAppConnection {
  constructor({ pane, socketPath, connect = connectUnixWebSocket, timeoutMs = RPC_TIMEOUT_MS, onClose = () => {} }) {
    this.pane = pane;
    this.socketPath = socketPath;
    this.connect = connect;
    this.timeoutMs = timeoutMs;
    this.onClose = onClose;
    this.nextId = 1;
    this.pending = new Map();
    this.approvals = new Map();
    this.threadState = new Map();
    this.subscribed = new Set();
    this.lastStartedThreadId = null;
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
      this.bump(message.params?.threadId);
      return;
    }
    if (!message.method) return;
    const params = message.params || {};
    if (message.method === 'serverRequest/resolved') {
      this.approvals.delete(String(params.requestId));
    } else if (message.method === 'thread/status/changed') {
      this.state(params.threadId).status = params.status;
    } else if (message.method === 'turn/started') {
      this.state(params.threadId).activeTurnId = params.turn?.id || params.turnId || null;
    } else if (message.method === 'turn/completed') {
      const state = this.state(params.threadId);
      state.activeTurnId = null;
      state.lastTurn = params.turn || null;
    } else if (message.method === 'thread/settings/updated') {
      this.state(params.threadId).settings = params.threadSettings || null;
    } else if (message.method === 'thread/started') {
      this.lastStartedThreadId = params.thread?.id || params.threadId || null;
    }
    this.bump(params.threadId);
  }

  state(threadId) {
    if (!this.threadState.has(threadId)) this.threadState.set(threadId, {
      revision: 0, readRevision: -1, thread: null, status: null, activeTurnId: null, settings: null, lastTurn: null, loadedOnly: false,
    });
    return this.threadState.get(threadId);
  }

  bump(threadId) {
    if (threadId) this.state(threadId).revision++;
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
      state.loadedOnly = false;
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
    state.thread = result.thread;
    state.readRevision = requestedRevision;
    state.status = result.thread?.status || state.status;
    const active = [...(result.thread?.turns || [])].reverse().find((turn) => turn.status === 'inProgress');
    if (active) state.activeTurnId = active.id;
    return result.thread;
  }

  async loadedThreads() {
    await this.open();
    const result = await this.rpc('thread/loaded/list', {});
    return Array.isArray(result?.data) ? result.data.filter((id) => typeof id === 'string') : [];
  }

  async discoverThread() {
    const loaded = await this.loadedThreads();
    if (this.lastStartedThreadId && loaded.includes(this.lastStartedThreadId)) return this.lastStartedThreadId;
    return loaded.length === 1 ? loaded[0] : null;
  }

  approvalsFor(threadId) {
    return [...this.approvals.values()]
      .filter((request) => request.params?.threadId === threadId)
      .map(normalizeApproval);
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

export function createCodexAppServer({ home, connect = connectUnixWebSocket, exists = fs.existsSync } = {}) {
  const connections = new Map();

  async function connection(pane) {
    const socketPath = codexAppSocketPath(pane, home);
    if (!exists(socketPath)) return null;
    let current = connections.get(pane);
    if (!current || current.closed) {
      current = new CodexAppConnection({
        pane, socketPath, connect,
        onClose: (closed) => { if (connections.get(pane) === closed) connections.delete(pane); },
      });
      connections.set(pane, current);
    }
    await current.open();
    return current;
  }

  return {
    async read(pane, threadId) {
      const client = await connection(pane);
      if (!client) return null;
      return { client, thread: await client.readThread(threadId) };
    },
    async discover(pane) {
      const client = await connection(pane);
      if (!client) return { managed: false, threadId: null };
      return { managed: true, threadId: await client.discoverThread() };
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
        lastTurn: state.lastTurn,
        approvals: client.approvalsFor(threadId),
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
      await client.ensureThread(threadId);
      return client.rpc('thread/compact/start', { threadId });
    },
    async interrupt(pane, threadId) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      const thread = await client.readThread(threadId);
      const state = client.state(threadId);
      const turnId = state.activeTurnId || [...(thread.turns || [])].reverse().find((turn) => turn.status === 'inProgress')?.id;
      if (!turnId) return { interrupted: false };
      await client.rpc('turn/interrupt', { threadId, turnId });
      return { interrupted: true, turnId };
    },
    async decide(pane, threadId, requestId, decision) {
      const client = await connection(pane);
      if (!client) throw new Error('Codex session is not managed by Handmux');
      await client.ensureThread(threadId);
      client.decide(threadId, requestId, decision);
      return { ok: true };
    },
    close() {
      for (const client of connections.values()) client.close();
      connections.clear();
    },
  };
}
