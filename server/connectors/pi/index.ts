import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiBridgeClient } from './bridgeClient.js';
import {
  normalizePiCommandTool,
  projectPiLiveItems,
} from '../../src/agents/piConversationHistory.js';
import type { BridgeRequestContext } from '../../src/agent-runtime/bridgeTypes.js';

type JsonRecord = Record<string, unknown>;

interface PiSessionManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getBranch(): unknown[];
}

interface PiContext {
  cwd?: string;
  sessionManager: PiSessionManager;
  modelRegistry?: {
    refresh(options?: { force?: boolean }): Promise<unknown>;
    getAvailable(): PiNativeModel[];
  };
  model?: PiNativeModel;
  scopedModels?: readonly { model: PiNativeModel; thinkingLevel?: PiThinkingLevel }[];
  abort(): void;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  getContextUsage?(): {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | undefined;
}

type PiEventName =
  | 'session_start'
  | 'session_shutdown'
  | 'session_tree'
  | 'before_agent_start'
  | 'agent_start'
  | 'agent_end'
  | 'agent_settled'
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'tool_execution_start'
  | 'tool_execution_end';

interface PiExtensionApi {
  on(event: PiEventName, handler: (event: JsonRecord, context: PiContext) => unknown): void;
  sendUserMessage(text: string, options?: { deliverAs: 'steer' | 'followUp' }): void;
  setModel?(model: PiNativeModel): Promise<boolean>;
  getThinkingLevel?(): PiThinkingLevel;
  setThinkingLevel?(level: PiThinkingLevel): void;
}

type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface PiNativeModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
}

interface ActiveSession {
  client: PiBridgeClient;
  context: PiContext;
  sessionId: string;
  leafId: string;
  viewId: string;
  turn: number;
  assistantId: string | undefined;
  tools: Map<string, ActiveTool>;
  currentRequest: UserRequest | undefined;
  requests: UserRequest[];
  lastAssistant: JsonRecord | undefined;
  inboxCurrent: PiInboxItem | undefined;
  nativeDispatch: NativeDispatch | undefined;
}

interface ActiveTool {
  id: string;
  name: string;
  input: unknown;
  provisionalId: string;
  committedLeafId?: string;
  settlement?: {
    durableItemId: string;
    item: {
      id: string;
      sessionId: string;
      status: 'complete';
      kind: 'tool_call';
      callId: string;
      name: string;
      input: unknown;
      extensions: { 'pi.live': true };
    };
  };
}

interface ToolCommitCandidate {
  tool: ActiveTool;
  settlement: NonNullable<ActiveTool['settlement']>;
}

interface UserRequest {
  id: string;
  text: string;
  delivery: 'prompt' | 'steer' | 'followUp';
  origin: 'ordinary' | 'steer';
  nativeText?: string;
  nativeTimestamp?: number;
  nativeStarted?: boolean;
  liveSettled?: boolean;
}

interface NativeDispatch {
  request: UserRequest;
  confirm(): void;
  cancel(): void;
}

interface PiInboxItem {
  state: 'working' | 'done' | 'error';
  message?: string;
  reason?: string;
  correlationId?: string;
  eventId?: string;
}

// Increment when a running Pi Extension must be reloaded to satisfy the Connector contract.
// The Server treats an absent version as the legacy v1 implementation and surfaces one actionable
// reload notice instead of silently continuing with stale message/inbox behavior.
const PI_CONNECTOR_IMPLEMENTATION_VERSION = 7;
const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

const GLOBAL_ATTACHMENT = Symbol.for('handmux.pi-extension.attachment-id');
const GLOBAL_GENERATIONS = Symbol.for('handmux.pi-extension.generations');
const GLOBAL_HANDOFFS = Symbol.for('handmux.pi-extension.handoffs');
const processGlobal = globalThis as typeof globalThis & {
  [GLOBAL_ATTACHMENT]?: string;
  [GLOBAL_GENERATIONS]?: Map<string, string>;
  [GLOBAL_HANDOFFS]?: Map<string, Promise<void>>;
};
const attachmentId = processGlobal[GLOBAL_ATTACHMENT] ??= crypto.randomUUID();
const generations = processGlobal[GLOBAL_GENERATIONS] ??= new Map<string, string>();
const handoffs = processGlobal[GLOBAL_HANDOFFS] ??= new Map<string, Promise<void>>();

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : null;
}

function modelReference(model: PiNativeModel): string {
  return `${model.provider}/${model.id}`;
}

function supportedThinkingLevels(model: PiNativeModel): PiThinkingLevel[] {
  if (!model.reasoning) return ['off'];
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level !== 'xhigh' && level !== 'max' || mapped !== undefined;
  });
}

function usableModels(context: PiContext): PiNativeModel[] {
  if (!context.modelRegistry || !context.scopedModels) {
    throw new Error('Pi model registry is unavailable');
  }
  const candidates = context.scopedModels.length
    ? context.scopedModels.map((entry) => entry.model)
    : context.modelRegistry.getAvailable();
  const seen = new Set<string>();
  return candidates.filter((model) => {
    const key = modelReference(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function modelControlSnapshot(pi: PiExtensionApi, context: PiContext) {
  if (!pi.getThinkingLevel) throw new Error('Pi thinking control is unavailable');
  return {
    models: usableModels(context).map((model) => ({
      id: modelReference(model),
      label: model.name || model.id,
      efforts: supportedThinkingLevels(model).map((id) => ({ id, label: id })),
    })),
    selected: {
      model: context.model ? modelReference(context.model) : null,
      effort: pi.getThinkingLevel(),
    },
  };
}

function conversationContextSnapshot(context: PiContext) {
  const usage = context.getContextUsage?.();
  const usedTokens = typeof usage?.tokens === 'number' && Number.isFinite(usage.tokens)
    && usage.tokens >= 0 ? usage.tokens : undefined;
  const totalTokens = typeof usage?.contextWindow === 'number' && Number.isFinite(usage.contextWindow)
    && usage.contextWindow > 0 ? usage.contextWindow : undefined;
  const hasUsage = usedTokens !== undefined && totalTokens !== undefined;
  const cwd = typeof context.cwd === 'string' && context.cwd.trim() ? context.cwd : undefined;
  return {
    activity: context.isIdle() ? 'idle' : 'working',
    ...(hasUsage ? { usedTokens, totalTokens } : {}),
    ...(cwd === undefined ? {} : { cwd }),
  };
}

function boundedText(value: unknown, max = 1024 * 1024): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function leaf(context: PiContext): string {
  const value = context.sessionManager.getLeafId();
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : 'root';
}

function eventId(...parts: unknown[]): string {
  return `pi:${crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

function inboxText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, 4096).join('');
}

function rawMessageText(message: JsonRecord): string | undefined {
  if (typeof message.content === 'string') return message.content || undefined;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content.flatMap((candidate) => {
    const block = record(candidate);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }).join('\n\n');
  return text || undefined;
}

function messageText(message: JsonRecord): string | undefined {
  return inboxText(rawMessageText(message));
}

function lastUserText(context: PiContext): string | undefined {
  const branch = context.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = record(branch[index]);
    const message = record(entry?.message);
    if (message?.role === 'user') return messageText(message);
  }
  return undefined;
}

function setInbox(active: ActiveSession, current?: PiInboxItem): void {
  active.inboxCurrent = current;
  active.client.setSnapshot('inbox', {
    availability: 'ready',
    ...(current === undefined ? {} : { current }),
  });
}

function pendingUserItem(active: ActiveSession, request: UserRequest) {
  return {
    id: provisionalUserId(request.id),
    sessionId: active.sessionId,
    status: 'complete' as const,
    kind: 'message' as const,
    role: 'user' as const,
    content: [{ type: 'text' as const, text: request.text }],
    correlationId: request.id,
    ...(request.nativeTimestamp === undefined ? {} : { sourceCreatedAt: request.nativeTimestamp }),
    extensions: {
      'pi.live': true,
      'pi.pendingClientRequestId': request.id,
      ...(request.nativeText === undefined || request.nativeText === request.text
        ? {} : { 'pi.pendingNativeText': request.nativeText }),
    },
  };
}

function pendingUserItems(active: ActiveSession) {
  // Steer text is a live-only optimistic occurrence. Once native Pi starts it, canonical history
  // becomes the sole durable source; never copy guide text into the Connector snapshot.
  return active.requests.filter((request) => request.nativeStarted && request.origin !== 'steer')
    .map((request) => pendingUserItem(active, request));
}

function activeToolSnapshots(active: ActiveSession) {
  return [...active.tools.values()].map((tool) => ({
    provisionalId: tool.provisionalId,
    draft: {
      kind: 'tool_call' as const,
      callId: `pi:${tool.id}`,
      name: tool.name,
      input: tool.input,
    },
    ...(tool.settlement === undefined ? {} : { settlement: tool.settlement }),
    ...(tool.committedLeafId === undefined ? {} : { committedLeafId: tool.committedLeafId }),
  }));
}

function unsettledTools(active: ActiveSession): ToolCommitCandidate[] {
  return [...active.tools.values()].flatMap((tool) => (
    tool.settlement && !tool.committedLeafId ? [{ tool, settlement: tool.settlement }] : []
  ));
}

function commitSettledTools(
  active: ActiveSession,
  candidates: readonly ToolCommitCandidate[],
  expectedLeaf: string,
): void {
  for (const { tool, settlement } of candidates) {
    if (active.tools.get(tool.id) !== tool || tool.settlement !== settlement) continue;
    tool.committedLeafId = expectedLeaf;
  }
}

function removeCommittedTools(active: ActiveSession): boolean {
  let changed = false;
  for (const [id, tool] of active.tools) {
    if (!tool.committedLeafId) continue;
    active.tools.delete(id);
    changed = true;
  }
  return changed;
}

function provisionalUserId(clientRequestId: string): string {
  return `pi-user:${crypto.createHash('sha256').update(clientRequestId).digest('hex')}`;
}

function removeRequest(active: ActiveSession, request: UserRequest): void {
  active.requests = active.requests.filter((candidate) => candidate !== request);
  if (active.currentRequest === request) active.currentRequest = undefined;
}

function removeRequests(active: ActiveSession, requests: ReadonlySet<UserRequest>): void {
  active.requests = active.requests.filter((request) => !requests.has(request));
  if (active.currentRequest && requests.has(active.currentRequest)) active.currentRequest = undefined;
}

function cancelNativeDispatch(active: ActiveSession): void {
  active.nativeDispatch?.cancel();
}

function enqueueDrain(paneId: string, client: PiBridgeClient): Promise<void> {
  const previous = handoffs.get(paneId) ?? Promise.resolve();
  const pending = previous.then(async () => {
    await client.waitForDurableDrain();
    client.closeAndRemoveIfDrained();
  });
  handoffs.set(paneId, pending);
  void pending.finally(() => {
    if (handoffs.get(paneId) === pending) handoffs.delete(paneId);
  }).catch(() => {});
  return pending;
}

function waitForNativeConfirmation(
  active: ActiveSession,
  request: UserRequest,
  context: BridgeRequestContext,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
      if (active.nativeDispatch === dispatch) active.nativeDispatch = undefined;
      resolve(confirmed);
    };
    const onAbort = (): void => finish(false);
    const dispatch: NativeDispatch = {
      request,
      confirm: () => finish(true),
      cancel: () => finish(false),
    };
    active.nativeDispatch = dispatch;
    const remaining = context.deadlineAt - Date.now();
    if (context.signal.aborted || remaining <= 0) {
      finish(false);
      return;
    }
    context.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(false), remaining);
    timer.unref?.();
  });
}

async function waitForPendingQueue(
  active: ActiveSession,
  context: BridgeRequestContext,
  stop: AbortSignal,
): Promise<boolean> {
  while (!context.signal.aborted && !stop.aborted && Date.now() < context.deadlineAt) {
    try { if (active.context.hasPendingMessages()) return true; }
    catch { /* transient native context failure; retry until the Bridge deadline */ }
    const remaining = context.deadlineAt - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (timer) clearTimeout(timer);
        context.signal.removeEventListener('abort', finish);
        stop.removeEventListener('abort', finish);
        resolve();
      };
      context.signal.addEventListener('abort', finish, { once: true });
      stop.addEventListener('abort', finish, { once: true });
      timer = setTimeout(finish, Math.min(25, remaining));
      timer.unref?.();
    });
  }
  return false;
}

function runtimeDirectory(): string {
  return process.env.HANDMUX_AGENT_RUNTIME_DIR
    ? path.resolve(process.env.HANDMUX_AGENT_RUNTIME_DIR)
    : path.join(os.homedir(), '.handmux', 'agent-runtime');
}

function safePane(paneId: string): string {
  return paneId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

function textDelta(event: JsonRecord): string | null {
  const update = record(event.assistantMessageEvent) ?? record(event.update) ?? event;
  if (update.type === 'thinking_delta' || update.type === 'reasoning_delta') return null;
  if (update.type !== undefined && update.type !== 'text_delta' && update.type !== 'text') return null;
  const value = update.delta ?? update.text;
  return typeof value === 'string' && value ? value : null;
}

function toolIdentity(event: JsonRecord): { id: string; name: string; input: unknown } | null {
  const id = event.toolCallId ?? event.toolCallID ?? event.id;
  const name = event.toolName ?? event.name;
  if (!boundedText(id, 256) || !boundedText(name, 256)) return null;
  return { id, ...normalizePiCommandTool(name, event.args ?? event.arguments ?? {}) };
}

function updateSnapshots(active: ActiveSession): void {
  const sessionFile = active.context.sessionManager.getSessionFile();
  const fallbackItems = !sessionFile || !existsSync(sessionFile)
    ? projectPiLiveItems(active.context.sessionManager.getBranch(), active.sessionId)
    : [];
  const pendingItems = [...fallbackItems, ...pendingUserItems(active)];
  active.client.setSnapshot('conversation', {
    implementationVersion: PI_CONNECTOR_IMPLEMENTATION_VERSION,
    sessionId: active.sessionId,
    leafId: active.leafId,
    viewId: active.viewId,
    ...(sessionFile ? { sessionFile } : {}),
    // An explicit empty list is a tombstone for previously published pending items. Omitting it
    // means "unchanged" to the Adapter so reconnect snapshots can be applied incrementally.
    pendingItems,
    // Running and just-settled tools stay in this Pi-private snapshot through their JSONL handoff.
    // The Adapter restores them through the public provisional lifecycle; a committed marker keeps
    // fresh observers from recreating a tool that is already present in native history.
    activeTools: activeToolSnapshots(active),
  });
}

function liveEntryId(provisionalId: string): string {
  return `live_${crypto.createHash('sha256').update(provisionalId).digest('hex')}`;
}

function settledAssistantItem(
  active: ActiveSession,
  provisionalId: string,
  message: JsonRecord,
) {
  const item = projectPiLiveItems([{
    type: 'message', id: liveEntryId(provisionalId), parentId: null,
    message,
  }], active.sessionId).find((item) => item.kind === 'message' && item.role === 'assistant');
  return item ? {
    ...item,
    extensions: { ...item.extensions, 'pi.live': true },
  } : undefined;
}

async function waitUntilLeafIsDurable(
  active: ActiveSession,
  beforePublish?: (expectedLeaf: string) => void,
): Promise<void> {
  const file = active.context.sessionManager.getSessionFile();
  const expectedLeaf = leaf(active.context);
  const expectedView = active.viewId;
  active.leafId = expectedLeaf;
  if (!file || expectedLeaf === 'root') {
    active.client.publishEphemeral('conversation', { type: 'stream.gap' });
    updateSnapshots(active);
    return;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const lines = (await fsp.readFile(file, 'utf8')).trim().split('\n');
      const readable = lines.some((line) => {
        try { return record(JSON.parse(line))?.id === expectedLeaf; } catch { return false; }
      });
      if (readable) {
        if (active.viewId !== expectedView || leaf(active.context) !== expectedLeaf) {
          updateSnapshots(active);
          return;
        }
        // The callback may mutate recoverable ownership, so it must run only after both identity
        // guards pass. It receives the captured leaf instead of reading mutable session state.
        beforePublish?.(expectedLeaf);
        active.client.publishEphemeral('conversation', {
          type: 'history.changed', leafId: expectedLeaf, viewId: expectedView,
        });
        updateSnapshots(active);
        return;
      }
    } catch { /* JSONL may not have been flushed yet */ }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(200, 20 * (attempt + 1))));
  }
  if (active.viewId !== expectedView || leaf(active.context) !== expectedLeaf) return;
  active.client.publishEphemeral('conversation', { type: 'stream.gap' });
  updateSnapshots(active);
}

export default function handmuxPiExtension(pi: PiExtensionApi): void {
  let active: ActiveSession | undefined;
  const clients = new Set<PiBridgeClient>();

  const attach = (context: PiContext, replacement: boolean): void => {
    const previous = active;
    const paneId = process.env.TMUX_PANE;
    const sessionId = context.sessionManager.getSessionId();
    if (!paneId || !boundedText(sessionId, 1024)) return;
    const inheritedGeneration = generations.get(paneId);
    // Pi `/reload` evaluates this module again inside the same process. The new instance has no local
    // `active`, while the process-global generation still identifies the loaded predecessor. Replace
    // that generation even when Pi reports the next session_start as ordinary startup.
    const replacing = replacement || (previous !== undefined && previous.sessionId !== sessionId)
      || (previous === undefined && inheritedGeneration !== undefined);
    const root = runtimeDirectory();
    const generationId = replacing
      ? crypto.randomUUID()
      : inheritedGeneration ?? attachmentId;
    generations.set(paneId, generationId);
    const client = new PiBridgeClient({
      socketPath: path.join(root, 'bridge', 'agent.sock'),
      credentialFile: path.join(root, 'bridge-credential.json'),
      stateFile: path.join(root, 'connectors', `pi-${safePane(paneId)}-${generationId}.json`),
      candidate: {
        paneId, attachmentId, sessionId,
        implementationVersion: PI_CONNECTOR_IMPLEMENTATION_VERSION,
        process: { pid: process.pid },
      },
      ...(replacing ? { generation: { id: generationId, replace: true as const } } : {}),
    });
    clients.add(client);
    active = {
      client, context, sessionId, leafId: leaf(context),
      viewId: `pi-view:${crypto.randomUUID()}`, turn: 0,
      assistantId: undefined, tools: new Map(), currentRequest: undefined,
      requests: [], lastAssistant: undefined, inboxCurrent: undefined, nativeDispatch: undefined,
    };
    const session = active;
    setInbox(session);
    updateSnapshots(session);
    client.handle('conversation', 'activity', () => {
      const idle = session.context.isIdle();
      return {
        activity: idle ? 'idle' : 'working',
        activeTurn: idle
          ? { state: 'none' }
          : { state: 'active', nativeTurnId: `pi-turn:${session.turn}` },
        ...(idle ? { completionToken: `pi-completed:${session.turn}` } : {}),
      };
    });
    client.handle('conversation', 'context', () => conversationContextSnapshot(session.context));
    client.handle('conversation', 'send', async (payload, requestContext) => {
      const request = record(payload);
      if (!request || !boundedText(request.text, 256 * 1024)
        || Buffer.byteLength(request.text) > 256 * 1024
        || typeof request.clientRequestId !== 'string'
        || request.clientRequestId.length === 0 || request.clientRequestId.length > 256) {
        return { status: 'rejected', reason: 'invalid_request' };
      }
      const delivery = request.delivery;
      if (delivery !== 'prompt' && delivery !== 'steer' && delivery !== 'followUp') {
        return { status: 'rejected', reason: 'unsupported_delivery' };
      }
      const plan = record(request.plan);
      if (request.origin !== undefined && request.origin !== 'steer') {
        return { status: 'rejected', reason: 'invalid_request' };
      }
      if (plan?.kind === 'steer-active-turn'
        && (delivery !== 'steer' || plan.nativeTurnId !== `pi-turn:${session.turn}`
          || session.context.isIdle())) {
        return { status: 'rejected', reason: 'agent_busy' };
      }
      if (plan?.kind === 'start-turn-fallback' && (delivery !== 'prompt' || !session.context.isIdle())) {
        return { status: 'rejected', reason: 'agent_busy' };
      }
      if (delivery === 'prompt' && !session.context.isIdle()) {
        return { status: 'rejected', reason: 'agent_busy' };
      }
      const wasIdle = session.context.isIdle();
      if (session.nativeDispatch) {
        return { status: 'rejected', reason: 'agent_busy' };
      }
      if (requestContext.signal.aborted || requestContext.deadlineAt <= Date.now()) {
        return { status: 'unknown', reason: 'native_delivery_unconfirmed' };
      }
      let hadPendingMessages = false;
      let hadTrackedPendingMessages = false;
      if (!wasIdle) {
        try { hadPendingMessages = session.context.hasPendingMessages(); }
        catch { return { status: 'unknown', reason: 'native_delivery_unconfirmed' }; }
        hadTrackedPendingMessages = hadPendingMessages
          && session.requests.some((candidate) => !candidate.nativeStarted);
      }
      const userRequest: UserRequest = {
        id: request.clientRequestId,
        text: request.text,
        delivery,
        origin: request.origin === 'steer' || delivery === 'steer'
          || plan?.kind === 'steer-active-turn' || plan?.kind === 'start-turn-fallback'
          ? 'steer' : 'ordinary',
      };
      const previousInbox = session.inboxCurrent;
      session.requests.push(userRequest);
      updateSnapshots(session);
      const inboxRequest = wasIdle ? userRequest : session.currentRequest;
      const workingMessage = inboxRequest?.origin === 'steer'
        ? undefined : inboxText(inboxRequest?.text);
      if (inboxRequest) {
        setInbox(session, {
          state: 'working', correlationId: inboxRequest.id,
          ...(workingMessage === undefined ? {} : { message: workingMessage }),
        });
      }
      const nativeConfirmation = wasIdle || !hadPendingMessages
        ? waitForNativeConfirmation(session, userRequest, requestContext)
        : undefined;
      const cancelUnconfirmed = (): { status: 'unknown'; reason: string } => {
        removeRequest(session, userRequest);
        updateSnapshots(session);
        setInbox(session, previousInbox);
        return { status: 'unknown', reason: 'native_delivery_unconfirmed' };
      };
      try {
        if (delivery === 'prompt') pi.sendUserMessage(request.text);
        else pi.sendUserMessage(request.text, { deliverAs: delivery });
        if (wasIdle && nativeConfirmation) {
          return await nativeConfirmation ? { status: 'accepted' } : cancelUnconfirmed();
        }
        if (!hadPendingMessages && nativeConfirmation) {
          const stopQueueWait = new AbortController();
          const proof = await Promise.race([
            nativeConfirmation.then((confirmed) => confirmed ? 'started' as const : 'unknown' as const),
            waitForPendingQueue(session, requestContext, stopQueueWait.signal)
              .then((queued) => queued ? 'queued' as const : 'unknown' as const),
          ]);
          stopQueueWait.abort();
          if (proof === 'started') return { status: 'accepted' };
          if (proof === 'queued') {
            cancelNativeDispatch(session);
            return { status: 'queued' };
          }
        }
        // Pi exposes only a boolean native queue. Once this Connector already owns an item in that
        // queue, a later synchronous send that does not throw is the only per-item acknowledgement
        // available; the pre-existing tracked request prevents an unrelated external queue from
        // being mistaken for proof of this delivery.
        if (hadTrackedPendingMessages) return { status: 'queued' };
        return cancelUnconfirmed();
      } catch {
        cancelNativeDispatch(session);
        removeRequest(session, userRequest);
        updateSnapshots(session);
        setInbox(session, previousInbox);
        return { status: 'rejected', reason: 'provider_rejected' };
      }
    });
    client.handle('conversation', 'interrupt', () => {
      try { session.context.abort(); return { status: 'accepted' }; }
      catch {
        return { status: 'rejected', reason: 'temporarily_unavailable' };
      }
    });
    client.handle('session-control', 'read', async (payload) => {
      const request = record(payload);
      if (request?.refresh === true) {
        if (!session.context.modelRegistry) throw new Error('Pi model registry is unavailable');
        await session.context.modelRegistry.refresh({ force: true });
      }
      return modelControlSnapshot(pi, session.context);
    });
    client.handle('session-control', 'update', async (payload) => {
      const patch = record(payload);
      if (!patch || !Object.keys(patch).length
        || Object.keys(patch).some((key) => key !== 'model' && key !== 'effort')) {
        throw new Error('Invalid Session Control update');
      }
      if (patch.model !== undefined) {
        if (typeof patch.model !== 'string') throw new Error('Invalid model');
        const model = usableModels(session.context)
          .find((candidate) => modelReference(candidate) === patch.model);
        if (!model) throw new Error('Model is unavailable');
        if (!pi.setModel) throw new Error('Pi model control is unavailable');
        if (!await pi.setModel(model)) throw new Error('Model credentials are unavailable');
      }
      if (patch.effort !== undefined) {
        if (typeof patch.effort !== 'string'
          || !PI_THINKING_LEVELS.includes(patch.effort as PiThinkingLevel)) {
          throw new Error('Invalid thinking level');
        }
        if (!pi.setThinkingLevel) throw new Error('Pi thinking control is unavailable');
        pi.setThinkingLevel(patch.effort as PiThinkingLevel);
      }
      return modelControlSnapshot(pi, session.context);
    });
    let predecessor = handoffs.get(paneId);
    if (previous) {
      previous.nativeDispatch?.cancel();
      predecessor = enqueueDrain(paneId, previous.client);
      void predecessor.finally(() => clients.delete(previous.client)).catch(() => {});
    }
    if (!predecessor) {
      client.start();
      return;
    }
    // A replacement must not revoke the old run before its locally durable terminal facts have entered
    // the Server-owned spool. The global handoff survives Pi reloading the Extension instance between
    // session_shutdown and the replacement session_start.
    void predecessor.then(() => client.start()).catch(() => {});
  };

  pi.on('session_start', (event, context) => {
    attach(context, event.reason === 'new' || event.reason === 'resume'
      || event.reason === 'fork' || event.reason === 'reload');
  });

  pi.on('session_shutdown', () => {
    const outgoing = active;
    active = undefined;
    if (!outgoing) return;
    outgoing.nativeDispatch?.cancel();
    const paneId = process.env.TMUX_PANE;
    if (!paneId) { outgoing.client.close(); clients.delete(outgoing.client); return; }
    const drained = enqueueDrain(paneId, outgoing.client);
    void drained.finally(() => clients.delete(outgoing.client)).catch(() => {});
  });

  pi.on('before_agent_start', (event, context) => {
    if (!active) return;
    active.context = context;
    const dispatch = active.nativeDispatch;
    if (!dispatch || typeof event.prompt !== 'string' || !event.prompt) return;
    dispatch.request.nativeText = event.prompt;
    active.currentRequest = dispatch.request;
    updateSnapshots(active);
    dispatch.confirm();
  });

  pi.on('agent_start', (_event, context) => {
    if (!active) return;
    active.context = context;
    if (removeCommittedTools(active)) updateSnapshots(active);
    active.turn += 1;
    active.lastAssistant = undefined;
    const existing = active.inboxCurrent?.state === 'working' ? active.inboxCurrent : undefined;
    const currentText = active.currentRequest?.origin === 'steer'
      ? undefined : existing?.message ?? lastUserText(context);
    setInbox(active, {
      state: 'working',
      ...(currentText === undefined ? {} : { message: currentText }),
      ...(existing?.correlationId === undefined ? {} : { correlationId: existing.correlationId }),
    });
  });

  pi.on('agent_end', (event, context) => {
    if (!active) return;
    active.context = context;
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const assistant = messages.map(record).filter((message) => message?.role === 'assistant').at(-1);
    if (!assistant) return;
    active.lastAssistant = assistant;
  });

  pi.on('agent_settled', (_event, context) => {
    if (!active) return;
    const session = active;
    session.context = context;
    const assistant = session.lastAssistant;
    const settledCurrent = session.currentRequest;
    const unsettledDispatch = session.nativeDispatch?.request;
    const settledRequests = new Set(session.requests.filter((request) => request !== unsettledDispatch));
    const settledTools = unsettledTools(session);
    if (session.currentRequest === settledCurrent) session.currentRequest = undefined;
    if (assistant?.stopReason === 'aborted') {
      session.client.publishEphemeral('inbox', { kind: 'clear' });
      setInbox(session);
      void waitUntilLeafIsDurable(session, (expectedLeaf) => {
        removeRequests(session, settledRequests);
        commitSettledTools(session, settledTools, expectedLeaf);
        updateSnapshots(session);
      });
      return;
    }
    const outcome = assistant?.stopReason === 'error' ? 'error' : 'done';
    const correlationId = settledCurrent?.id;
    const id = eventId(session.sessionId, session.turn, leaf(context), 'agent_settled', outcome);
    const completedText = outcome === 'done' && assistant ? messageText(assistant) : undefined;
    const current: PiInboxItem = {
      state: outcome,
      eventId: id,
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(completedText === undefined ? {} : { message: completedText }),
      ...(outcome === 'error' ? { reason: 'provider_error' } : {}),
      ...(outcome === 'error' ? { message: 'Pi generation failed' } : {}),
    };
    const durable = session.client.publishDurable('inbox', id, { kind: 'set', ...current });
    session.inboxCurrent = current;
    session.client.setSnapshot('inbox', durable
      ? { availability: 'ready', current }
      : {
          availability: 'degraded',
          message: 'Terminal event could not be saved for offline delivery',
          current,
        });
    void waitUntilLeafIsDurable(session, (expectedLeaf) => {
      removeRequests(session, settledRequests);
      commitSettledTools(session, settledTools, expectedLeaf);
      updateSnapshots(session);
    });
  });

  pi.on('session_tree', (_event, context) => {
    if (!active) return;
    active.context = context;
    // A tree switch creates a new Conversation view. All provisional tool ownership belongs to the
    // old view and is invalidated by its stream gap; carrying any of it into the replacement snapshot
    // would resurrect stale running or uncommitted tools on a fresh observer.
    active.tools.clear();
    active.leafId = leaf(context);
    active.viewId = `pi-view:${crypto.randomUUID()}`;
    void waitUntilLeafIsDurable(active);
  });

  pi.on('message_start', (event, context) => {
    if (!active) return;
    const message = record(event.message);
    if (!message) return;
    active.context = context;
    if (message.role === 'user') {
      const rawText = rawMessageText(message);
      const dispatchRequest = active.nativeDispatch?.request;
      const matchedDispatch = rawText !== undefined && dispatchRequest
        && (dispatchRequest.nativeText ?? dispatchRequest.text) === rawText
        ? dispatchRequest : undefined;
      const request = matchedDispatch ?? (rawText === undefined ? undefined : active.requests.find((candidate) => (
        candidate.nativeTimestamp === undefined && (candidate.nativeText ?? candidate.text) === rawText
      )));
      const text = request?.origin === 'steer' ? undefined : inboxText(request?.text ?? rawText);
      if (request && typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
        request.nativeTimestamp = message.timestamp;
      }
      if (request) request.nativeStarted = true;
      active.currentRequest = request;
      if (request && active.nativeDispatch?.request === request) active.nativeDispatch.confirm();
      if (request && !request.liveSettled) {
        request.liveSettled = true;
        const item = pendingUserItem(active, request);
        const provisionalId = provisionalUserId(request.id);
        active.client.publishEphemeral('conversation', {
          type: 'item.opened', provisionalId,
          draft: {
            kind: item.kind, role: item.role, content: item.content,
            correlationId: item.correlationId,
            ...(item.sourceCreatedAt === undefined ? {} : { sourceCreatedAt: item.sourceCreatedAt }),
            extensions: item.extensions,
          },
        });
        active.client.publishEphemeral('conversation', {
          type: 'item.settled', provisionalId,
          durableItemId: item.id, item,
        });
      }
      updateSnapshots(active);
      setInbox(active, {
        state: 'working',
        ...(text === undefined ? {} : { message: text }),
        ...(request === undefined ? {} : { correlationId: request.id }),
      });
      return;
    }
    if (message.role !== 'assistant') return;
    active.assistantId = `assistant:${active.turn}:${crypto.randomUUID()}`;
    active.client.publishEphemeral('conversation', {
      type: 'item.opened', provisionalId: active.assistantId,
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    });
  });

  pi.on('message_update', (event, context) => {
    if (!active?.assistantId) return;
    active.context = context;
    const text = textDelta(event);
    if (!text) return;
    active.client.publishEphemeral('conversation', {
      type: 'item.delta', provisionalId: active.assistantId,
      delta: { op: 'text.append', target: 'message.content', text },
    });
  });

  pi.on('message_end', (event, context) => {
    if (!active?.assistantId) return;
    const message = record(event.message);
    if (message?.role !== 'assistant') return;
    active.context = context;
    const provisionalId = active.assistantId;
    active.assistantId = undefined;
    const item = settledAssistantItem(active, provisionalId, message);
    if (item) {
      active.client.publishEphemeral('conversation', {
        type: 'item.settled', provisionalId, durableItemId: item.id, item,
      });
      return;
    }
    // A tool-only assistant message opened an empty text draft. Its tool calls have their own live
    // rows, so remove only that genuinely invisible placeholder.
    active.client.publishEphemeral('conversation', {
      type: 'item.cancelled', provisionalId, reason: 'superseded',
    });
  });

  pi.on('tool_execution_start', (event, context) => {
    if (!active) return;
    active.context = context;
    const tool = toolIdentity(event);
    if (!tool) return;
    const provisionalId = `tool:${crypto.randomUUID()}`;
    active.tools.set(tool.id, { ...tool, provisionalId });
    // Persist the recoverable owner before publishing the lossy live event. The Adapter suppresses
    // the matching item.opened when both reach an uninterrupted subscription.
    updateSnapshots(active);
    active.client.publishEphemeral('conversation', {
      type: 'item.opened', provisionalId,
      draft: { kind: 'tool_call', callId: `pi:${tool.id}`, name: tool.name, input: tool.input },
    });
  });

  pi.on('tool_execution_end', (event, context) => {
    if (!active) return;
    active.context = context;
    const tool = toolIdentity(event);
    if (!tool) return;
    const running = active.tools.get(tool.id);
    if (!running) return;
    const provisionalId = running.provisionalId;
    const durableItemId = `pi:${liveEntryId(provisionalId)}:tool`;
    const item = {
      id: durableItemId,
      sessionId: active.sessionId,
      status: 'complete' as const,
      kind: 'tool_call' as const,
      callId: `pi:${running.id}`,
      name: running.name,
      input: running.input,
      extensions: { 'pi.live': true as const },
    };
    running.settlement = { durableItemId, item };
    // A completed snapshot makes settlement recoverable if the ephemeral event is lost. Once native
    // history is durable it becomes a committed tombstone, then the next native turn removes it.
    updateSnapshots(active);
    active.client.publishEphemeral('conversation', {
      type: 'item.settled', provisionalId,
      durableItemId, item,
    });
  });
}
