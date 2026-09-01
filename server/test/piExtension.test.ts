import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import handmuxPiExtension from '../connectors/pi/index.js';
import { PiBridgeClient } from '../connectors/pi/bridgeClient.js';
import { ConversationService } from '../src/agent-runtime/conversation.js';
import type {
  AgentConversationAdapterV1,
  ConversationAdapterEvent,
  ConversationAdapterEventSink,
  ConversationEvent,
} from '../src/agent-runtime/conversationTypes.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';

interface TestContext {
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string;
    getLeafId(): string;
    getBranch(): unknown[];
  };
  modelRegistry?: {
    refresh(options?: { force?: boolean }): Promise<unknown>;
    getAvailable(): Array<{
      id: string; name: string; provider: string; reasoning: boolean;
      thinkingLevelMap?: Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>;
    }>;
  };
  model?: {
    id: string; name: string; provider: string; reasoning: boolean;
    thinkingLevelMap?: Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>;
  };
  scopedModels?: Array<{ model: NonNullable<TestContext['model']>; thinkingLevel?: 'high' }>;
  abort: ReturnType<typeof vi.fn>;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
}
type Handler = (event: Record<string, unknown>, context: TestContext) => void;
const directories: string[] = [];
const originalPane = process.env.TMUX_PANE;
const originalRuntimeDirectory = process.env.HANDMUX_AGENT_RUNTIME_DIR;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = originalPane;
  if (originalRuntimeDirectory === undefined) delete process.env.HANDMUX_AGENT_RUNTIME_DIR;
  else process.env.HANDMUX_AGENT_RUNTIME_DIR = originalRuntimeDirectory;
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function context(
  sessionFile = '/tmp/pi-session.jsonl',
  sessionId = 'session-1',
  branch: unknown[] = [],
): TestContext {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getLeafId: () => 'entry001',
      getBranch: () => branch,
    },
    abort: vi.fn(),
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
}

function connectorState(root: string) {
  const file = fs.readdirSync(path.join(root, 'connectors'))[0]!;
  return JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
}

describe('Handmux Pi Extension', () => {
  it('advances a stable completion token only after each Pi turn becomes idle', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%completion-token';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    const bridgeHandlers = new Map<string, Parameters<PiBridgeClient['handle']>[2]>();
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      bridgeHandlers.set(`${channel}/${method}`, handler);
      return () => {};
    });
    let idle = true;
    const ctx = context();
    ctx.isIdle = () => idle;
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    handlers.get('session_start')?.({}, ctx);
    const activity = bridgeHandlers.get('conversation/activity');
    const request = {
      requestId: 'activity', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    };
    expect(activity?.({}, request)).toMatchObject({
      activity: 'idle', completionToken: 'pi-completed:0',
    });

    idle = false;
    handlers.get('agent_start')?.({}, ctx);
    expect(activity?.({}, request)).toEqual({
      activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'pi-turn:1' },
    });
    idle = true;
    handlers.get('agent_end')?.({ messages: [] }, ctx);
    expect(activity?.({}, request)).toMatchObject({
      activity: 'idle', completionToken: 'pi-completed:1',
    });
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('uses the scoped native model catalogue and Pi thinking-level rules for Session Control', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%session-control';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    const bridgeHandlers = new Map<string, Parameters<PiBridgeClient['handle']>[2]>();
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      bridgeHandlers.set(`${channel}/${method}`, handler);
      return () => {};
    });
    const scoped = {
      id: 'reasoner', name: 'Reasoner', provider: 'deepseek', reasoning: true,
      thinkingLevelMap: { xhigh: 'xhigh-native', max: null },
    };
    const unscoped = {
      id: 'other', name: 'Other', provider: 'openai', reasoning: true,
    };
    let thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'high';
    const refresh = vi.fn(async () => ({}));
    const ctx = context();
    ctx.model = scoped;
    ctx.scopedModels = [{ model: scoped, thinkingLevel: 'high' }];
    ctx.modelRegistry = { refresh, getAvailable: () => [scoped, unscoped] };
    const setModel = vi.fn(async () => true);
    const setThinkingLevel = vi.fn((level: typeof thinking) => { thinking = level; });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(), setModel,
      getThinkingLevel: () => thinking, setThinkingLevel,
    });
    handlers.get('session_start')?.({}, ctx);

    const read = bridgeHandlers.get('session-control/read');
    await expect(read?.({ refresh: true }, {
      requestId: 'read', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      models: [{
        id: 'deepseek/reasoner', label: 'Reasoner',
        efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
          .map((id) => ({ id, label: id })),
      }],
      selected: { model: 'deepseek/reasoner', effort: 'high' },
    });
    expect(refresh).toHaveBeenCalledWith({ force: true });

    const update = bridgeHandlers.get('session-control/update');
    await update?.({ effort: 'low' }, {
      requestId: 'update', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    });
    expect(setThinkingLevel).toHaveBeenCalledWith('low');
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('snapshots the visible in-memory branch before Pi creates its deferred JSONL', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%6';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    const sessionFile = path.join(root, 'deferred.jsonl');
    handlers.get('session_start')?.({}, context(sessionFile, 'session-1', [{
      type: 'message', id: 'entry001', parentId: null,
      message: { role: 'user', content: 'pending prompt' },
    }]));

    const file = fs.readdirSync(path.join(root, 'connectors'))[0]!;
    const state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    expect(state.snapshots.conversation).toMatchObject({
      sessionId: 'session-1', leafId: 'entry001', sessionFile,
      pendingItems: [{ kind: 'message', role: 'user' }],
    });
  });

  it('maps native lifecycle callbacks into recoverable snapshots and a durable terminal event', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%7';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    const pi = {
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    };
    handmuxPiExtension(pi);
    const ctx = context(path.join(root, 'session.jsonl'));
    fs.writeFileSync(ctx.sessionManager.getSessionFile(), [
      JSON.stringify({ type: 'session', version: 3, id: 'session-1' }),
      JSON.stringify({ type: 'message', id: 'entry001', parentId: null }),
    ].join('\n'));

    handlers.get('session_start')?.({}, ctx);
    handlers.get('agent_start')?.({}, ctx);
    handlers.get('agent_end')?.({
      messages: [{
        role: 'assistant', stopReason: 'stop', content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'Finished the task' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} },
        ],
      }],
    }, ctx);
    handlers.get('agent_settled')?.({}, ctx);

    const connectorFiles = fs.readdirSync(path.join(root, 'connectors'));
    expect(connectorFiles).toHaveLength(1);
    const stateFile = path.join(root, 'connectors', connectorFiles[0]!);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.snapshots.inbox).toMatchObject({
      availability: 'ready', current: { state: 'done', message: 'Finished the task' },
    });
    expect(JSON.stringify(state.snapshots.inbox)).not.toContain('agent_end_idle');
    expect(JSON.stringify(state.snapshots.inbox)).not.toContain('hidden');
    expect(state.snapshots.conversation).toMatchObject({
      sessionId: 'session-1', leafId: 'entry001',
    });
    expect(state.durable).toHaveLength(1);
    expect(state.durable[0]).toMatchObject({
      channel: 'inbox', payload: { kind: 'set', state: 'done', message: 'Finished the task' },
    });
    handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
  });

  it.each([
    ['prompt', undefined],
    ['steer', { deliverAs: 'steer' }],
    ['followUp', { deliverAs: 'followUp' }],
  ] as const)('waits for native user evidence before publishing correlated %s delivery', async (delivery, options) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = `%send-${delivery}`;
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    const order: string[] = [];
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    let ctx: TestContext;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral').mockImplementation((channel, payload) => {
      if (channel === 'conversation') {
        const operation = payload as { type?: string };
        order.push(operation.type ?? 'unknown');
      }
    });
    const sendUserMessage = vi.fn((_text: string, _options?: { deliverAs: 'steer' | 'followUp' }) => {
      order.push('native.sendUserMessage');
      handlers.get('before_agent_start')?.({ prompt: _text }, ctx);
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage,
    });
    ctx = context(path.join(root, 'session.jsonl'));
    handlers.get('session_start')?.({}, ctx);

    const result = await sendHandler?.({
      clientRequestId: `request-${delivery}`, text: `message-${delivery}`, delivery,
    }, { requestId: 'bridge-request', deadlineAt: Date.now() + 1_000, signal: new AbortController().signal });

    expect(result).toEqual({ status: 'accepted' });
    expect(order).toEqual(['native.sendUserMessage']);
    if (options) expect(sendUserMessage).toHaveBeenCalledWith(`message-${delivery}`, options);
    else expect(sendUserMessage).toHaveBeenCalledWith(`message-${delivery}`);
    const file = fs.readdirSync(path.join(root, 'connectors'))[0]!;
    const state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    expect(state.snapshots.inbox).toMatchObject({
      availability: 'ready',
      current: {
        state: 'working',
        correlationId: `request-${delivery}`,
      },
    });
    if (delivery === 'steer') {
      expect(state.snapshots.inbox.current).not.toHaveProperty('message');
      expect(JSON.stringify(state.snapshots)).not.toContain(`message-${delivery}`);
    } else {
      expect(state.snapshots.inbox.current.message).toBe(`message-${delivery}`);
    }
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('accepts the next idle before_agent_start after input transform and tracks its native text', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-transformed';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    let ctx: TestContext;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: () => {
        handlers.get('before_agent_start')?.({ prompt: 'transformed native prompt' }, ctx);
      },
    });
    ctx = context(path.join(root, 'session.jsonl'));
    handlers.get('session_start')?.({ reason: 'startup' }, ctx);

    await expect(sendHandler?.({
      clientRequestId: 'request-transformed', text: 'original display prompt', delivery: 'prompt',
    }, {
      requestId: 'bridge-request', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'accepted' });
    handlers.get('message_start')?.({ message: {
      role: 'user', content: 'transformed native prompt', timestamp: 321,
    } }, ctx);

    const stateFile = path.join(root, 'connectors', fs.readdirSync(path.join(root, 'connectors'))[0]!);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.snapshots.conversation.pendingItems).toMatchObject([{
      correlationId: 'request-transformed', sourceCreatedAt: 321,
      content: [{ text: 'original display prompt' }],
      extensions: { 'pi.pendingNativeText': 'transformed native prompt' },
    }]);
    expect(state.snapshots.inbox.current).toMatchObject({
      state: 'working', correlationId: 'request-transformed', message: 'original display prompt',
    });
    handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
  });

  it('returns unknown and cancels the provisional when idle delivery has no native proof', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-unconfirmed';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    const events: unknown[] = [];
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral').mockImplementation((channel, payload) => {
      if (channel === 'conversation') events.push(payload);
    });
    const sendUserMessage = vi.fn();
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage,
    });
    const ctx = context(path.join(root, 'session.jsonl'));
    handlers.get('session_start')?.({}, ctx);
    const controller = new AbortController();

    const pending = sendHandler?.({
      clientRequestId: 'request-unconfirmed', text: 'do not lose me', delivery: 'prompt',
    }, { requestId: 'bridge-request', deadlineAt: Date.now() + 10_000, signal: controller.signal });
    controller.abort();

    await expect(pending).resolves.toEqual({
      status: 'unknown', reason: 'native_delivery_unconfirmed',
    });
    expect(sendUserMessage).toHaveBeenCalledWith('do not lose me');
    expect(events.filter((event) => {
      const value = event as { type?: string; item?: { correlationId?: string } };
      return value.type === 'item.opened' || value.type === 'item.cancelled'
        || (value.type === 'item.settled' && value.item?.correlationId === 'request-steer');
    })).toEqual([]);
    const file = fs.readdirSync(path.join(root, 'connectors'))[0]!;
    const state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    expect(state.snapshots.inbox).toEqual({ availability: 'ready' });
    expect(state.snapshots.conversation.pendingItems).toEqual([]);
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('fails closed for concurrent idle sends and accepts user message_start as native proof', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-concurrent-idle';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    const sendUserMessage = vi.fn();
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage,
    });
    const ctx = context(path.join(root, 'session.jsonl'));
    handlers.get('session_start')?.({}, ctx);
    const requestContext = {
      requestId: 'bridge-request', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    };

    const first = sendHandler?.({
      clientRequestId: 'request-first', text: 'first prompt', delivery: 'prompt',
    }, requestContext);
    await expect(sendHandler?.({
      clientRequestId: 'request-second', text: 'second prompt', delivery: 'prompt',
    }, requestContext)).resolves.toEqual({ status: 'rejected', reason: 'agent_busy' });
    handlers.get('message_start')?.({
      message: { role: 'user', content: 'first prompt', timestamp: 123 },
    }, ctx);
    await expect(first).resolves.toEqual({ status: 'accepted' });
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('returns unknown when a busy steer cannot be proven in Pi native queue state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-busy-unconfirmed';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    const events: unknown[] = [];
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral').mockImplementation((channel, payload) => {
      if (channel === 'conversation') events.push(payload);
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    const ctx = context(path.join(root, 'session.jsonl'));
    ctx.isIdle = () => false;
    ctx.hasPendingMessages = () => false;
    handlers.get('session_start')?.({}, ctx);

    await expect(sendHandler?.({
      clientRequestId: 'request-steer', text: 'change direction', delivery: 'steer',
    }, {
      requestId: 'bridge-request', deadlineAt: Date.now() + 80,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'unknown', reason: 'native_delivery_unconfirmed' });
    expect(events.filter((event) => {
      const value = event as { type?: string; item?: { correlationId?: string } };
      return value.type === 'item.opened' || value.type === 'item.cancelled'
        || (value.type === 'item.settled' && value.item?.correlationId === 'request-steer');
    })).toEqual([]);
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('waits for an async Pi input transform before proving a busy queue edge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-async-queue';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    let queued = false;
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: () => {
        const timer = setTimeout(() => { queued = true; }, 40);
        timer.unref?.();
      },
    });
    const ctx = context(path.join(root, 'session.jsonl'));
    ctx.isIdle = () => false;
    ctx.hasPendingMessages = () => queued;
    handlers.get('session_start')?.({}, ctx);

    await expect(sendHandler?.({
      clientRequestId: 'request-async-queue', text: 'async follow-up', delivery: 'followUp',
    }, {
      requestId: 'bridge-request', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'queued' });
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('accepts when a busy send starts directly after the old turn settles during async input', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-busy-to-idle';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const sessionFile = path.join(root, 'session.jsonl');
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'session-1' }),
      JSON.stringify({ type: 'message', id: 'entry001', parentId: null }),
    ].join('\n'));
    const handlers = new Map<string, Handler>();
    const events: unknown[] = [];
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    let idle = false;
    let ctx: TestContext;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral').mockImplementation((channel, payload) => {
      if (channel === 'conversation') events.push(payload);
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: () => {
        const timer = setTimeout(() => {
          idle = true;
          handlers.get('agent_settled')?.({}, ctx);
          handlers.get('before_agent_start')?.({ prompt: 'native transformed direct prompt' }, ctx);
          handlers.get('message_start')?.({ message: {
            role: 'user', content: 'native transformed direct prompt', timestamp: 456,
          } }, ctx);
        }, 40);
        timer.unref?.();
      },
    });
    ctx = context(sessionFile);
    ctx.isIdle = () => idle;
    ctx.hasPendingMessages = () => false;
    handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    handlers.get('agent_start')?.({}, ctx);
    handlers.get('agent_end')?.({ messages: [{
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'old reply' }],
    }] }, ctx);

    await expect(sendHandler?.({
      clientRequestId: 'request-direct-start', text: 'original direct prompt', delivery: 'followUp',
    }, {
      requestId: 'bridge-request', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'accepted' });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'item.settled',
      item: expect.objectContaining({ correlationId: 'request-direct-start' }),
    }));
    const stateFile = path.join(root, 'connectors', fs.readdirSync(path.join(root, 'connectors'))[0]!);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.snapshots.conversation.pendingItems).toMatchObject([{
      correlationId: 'request-direct-start', sourceCreatedAt: 456,
      content: [{ text: 'original direct prompt' }],
      extensions: { 'pi.pendingNativeText': 'native transformed direct prompt' },
    }]);
    expect(state.snapshots.inbox.current).toMatchObject({
      state: 'working', correlationId: 'request-direct-start', message: 'original direct prompt',
    });
    handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
  });

  it('does not treat a pre-existing Pi queue as proof that this busy send was accepted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-preexisting-queue';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    const events: unknown[] = [];
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral').mockImplementation((channel, payload) => {
      if (channel === 'conversation') events.push(payload);
    });
    const sendUserMessage = vi.fn();
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage,
    });
    const ctx = context(path.join(root, 'session.jsonl'));
    ctx.isIdle = () => false;
    ctx.hasPendingMessages = () => true;
    handlers.get('session_start')?.({}, ctx);

    await expect(sendHandler?.({
      clientRequestId: 'request-behind-existing', text: 'queue this too', delivery: 'followUp',
    }, {
      requestId: 'bridge-request', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'unknown', reason: 'native_delivery_unconfirmed' });
    expect(sendUserMessage).toHaveBeenCalledWith('queue this too', { deliverAs: 'followUp' });
    expect(events).toEqual([]);
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('confirms repeated sends behind a Connector-tracked Pi queue', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-paired-queue';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    let queued = false;
    const sendUserMessage = vi.fn(() => { queued = true; });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage,
    });
    const ctx = context(path.join(root, 'session.jsonl'));
    ctx.isIdle = () => false;
    ctx.hasPendingMessages = () => queued;
    handlers.get('session_start')?.({}, ctx);
    const requestContext = {
      requestId: 'bridge-request', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    };

    await expect(sendHandler?.({
      clientRequestId: 'paired-1', text: 'first guide', delivery: 'steer',
    }, requestContext)).resolves.toEqual({ status: 'queued' });
    await expect(sendHandler?.({
      clientRequestId: 'paired-2', text: 'second guide', delivery: 'steer',
    }, { ...requestContext, requestId: 'bridge-request-2' })).resolves.toEqual({ status: 'queued' });
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('does not persist native-started steer text in the Connector snapshot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-steer-private';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    let ctx: TestContext;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: (text: string) => {
        handlers.get('message_start')?.({ message: { role: 'user', content: text } }, ctx);
      },
    });
    ctx = context(path.join(root, 'session.jsonl'));
    ctx.isIdle = () => false;
    handlers.get('session_start')?.({}, ctx);

    await expect(sendHandler?.({
      clientRequestId: 'private-steer', text: 'never persist this guide', delivery: 'steer',
    }, {
      requestId: 'bridge-request', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'accepted' });
    const persisted = connectorState(root);
    expect(persisted.snapshots.conversation.pendingItems).toEqual([]);
    expect(JSON.stringify(persisted.snapshots.conversation)).not.toContain('never persist this guide');
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('does not persist fallback steer text sent through native prompt delivery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-fallback-steer-private';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    let ctx: TestContext;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: (text: string) => {
        handlers.get('message_start')?.({ message: { role: 'user', content: text } }, ctx);
        handlers.get('agent_start')?.({}, ctx);
      },
    });
    ctx = context(path.join(root, 'session.jsonl'));
    ctx.isIdle = () => true;
    handlers.get('session_start')?.({}, ctx);

    await expect(sendHandler?.({
      clientRequestId: 'private-fallback-steer', text: 'never persist fallback guide',
      origin: 'steer', delivery: 'prompt',
      plan: { kind: 'start-turn-fallback', activityEpoch: 'run-1', activityRevision: 1 },
    }, {
      requestId: 'bridge-request', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'accepted' });
    const persisted = connectorState(root);
    expect(persisted.snapshots.conversation.pendingItems).toEqual([]);
    expect(JSON.stringify(persisted.snapshots)).not.toContain('never persist fallback guide');
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('keeps the user event ahead of synchronous agent and assistant callbacks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-synchronous';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    const order: string[] = [];
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    let ctx: TestContext;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral').mockImplementation((channel, payload) => {
      if (channel !== 'conversation') return;
      const operation = payload as { type?: string; draft?: { role?: string } };
      order.push(`${operation.type}:${operation.draft?.role ?? ''}`);
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: () => {
        order.push('native.sendUserMessage');
        handlers.get('before_agent_start')?.({ prompt: 'answer this now' }, ctx);
        handlers.get('agent_start')?.({}, ctx);
        handlers.get('message_start')?.({ message: { role: 'user', content: 'answer this now' } }, ctx);
        handlers.get('message_start')?.({ message: { role: 'assistant' } }, ctx);
      },
    });
    ctx = context(path.join(root, 'session.jsonl'));
    handlers.get('session_start')?.({}, ctx);

    expect(await sendHandler?.({
      clientRequestId: 'request-sync', text: 'answer this now', delivery: 'prompt',
    }, { requestId: 'bridge-request', deadlineAt: Date.now() + 1_000, signal: new AbortController().signal }))
      .toEqual({ status: 'accepted' });
    expect(order).toEqual([
      'native.sendUserMessage', 'item.opened:user', 'item.settled:', 'item.opened:assistant',
    ]);
    const file = fs.readdirSync(path.join(root, 'connectors'))[0]!;
    const state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    expect(state.snapshots.inbox.current).toEqual({
      state: 'working', message: 'answer this now', correlationId: 'request-sync',
    });
    expect(JSON.stringify(state.snapshots.inbox)).not.toContain('agent_start');
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('publishes a correlated user open then settlement that Conversation Core accepts without a gap', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-core-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-core-contract';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    let sink: ConversationAdapterEventSink | undefined;
    let sourceSequence = 0;
    let targetDelivery = Promise.resolve();
    const targetConnectorEvents: Array<Record<string, unknown>> = [];
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral').mockImplementation((channel, payload) => {
      if (channel !== 'conversation' || !sink) return;
      const event = payload as Record<string, unknown>;
      const draft = event.draft as Record<string, unknown> | undefined;
      const item = event.item as Record<string, unknown> | undefined;
      if (draft?.correlationId !== 'request-core' && item?.correlationId !== 'request-core') return;
      targetConnectorEvents.push(event);
      const adapted = {
        ...(payload as Omit<ConversationAdapterEvent, 'sourceSequence'>),
        sourceSequence: ++sourceSequence,
      } as ConversationAdapterEvent;
      targetDelivery = targetDelivery.then(() => sink!(adapted));
    });

    const runs = new AgentRunRuntime({ newRunId: () => 'run-core-contract' });
    const lease = await runs.controller('pi', async () => true).attach({
      paneId: '%send-core-contract', attachmentId: 'pi-extension', sessionId: 'session-1',
      implementationVersion: 4, process: { pid: 101 },
    });
    const adapter: AgentConversationAdapterV1 = {
      apiVersion: 1,
      discoverNative: async (target) => ({
        session: { agentId: 'pi', sessionId: target.sessionId! },
        ...('runId' in target ? { run: target } : {}), sourceViewId: 'pi-view',
        capabilities: {
          history: true, live: 'delta',
          ...('runId' in target ? { sendable: true as const } : {}),
        },
      }),
      readNativePage: async (session) => ({
        sessionId: session.sessionId, sourceViewId: 'pi-view',
        sourceHistoryToken: 'pi-history', items: [], hasMore: false,
      }),
      observeNative: async (_run, nextSink) => {
        sink = nextSink;
        return {
          checkpoint: { sourceViewId: 'pi-view', sourceSequence: 0 },
          close: () => { sink = undefined; },
        };
      },
      dispatchPrompt: async (_run, request) => {
        if (!sendHandler) throw new Error('Pi Connector send handler is unavailable');
        const receipt = await sendHandler({ ...request, delivery: 'prompt' }, {
          requestId: request.clientRequestId, deadlineAt: Date.now() + 1_000,
          signal: new AbortController().signal,
        });
        return (receipt as { status?: string }).status === 'accepted'
          ? { outcome: 'accepted' as const }
          : { outcome: 'unknown' as const, nativeMutation: 'unknown' as const };
      },
    };
    const service = new ConversationService({
      runs, adapters: { pi: adapter },
      activitySource: { read: async () => ({
        activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-core-contract',
      }) },
    });
    const coreEvents: ConversationEvent[] = [];
    const live = await service.open(lease, {}, (event) => { coreEvents.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));

    let ctx: TestContext;
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: (text: string) => {
        handlers.get('before_agent_start')?.({ prompt: text }, ctx);
        handlers.get('message_start')?.({ message: { role: 'user', content: text } }, ctx);
      },
    });
    ctx = context(path.join(root, 'session.jsonl'));
    handlers.get('session_start')?.({}, ctx);

    await expect(service.send(lease, {
      clientRequestId: 'request-core', text: 'prove the lifecycle', delivery: 'prompt',
    })).resolves.toEqual({ status: 'accepted' });
    await vi.waitFor(() => expect(targetConnectorEvents).toHaveLength(2));
    await targetDelivery;
    await vi.waitFor(() => expect(coreEvents.length).toBeGreaterThanOrEqual(2));
    expect(service.querySubmission(lease, 'request-core')).toMatchObject({
      status: 'accepted', nativeId: expect.any(String),
    });
    expect(coreEvents.map((event) => event.type)).toEqual(['item.opened', 'item.settled']);
    expect(targetConnectorEvents.map((event) => event.type)).toEqual(['item.opened', 'item.settled']);
    expect(coreEvents[0]).toMatchObject({
      type: 'item.opened', draft: { role: 'user', correlationId: 'request-core' },
    });
    expect(coreEvents.some((event) => event.type === 'stream.gap')).toBe(false);
    live.close();
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('hands a real user/assistant/tool turn to durable history without deleting visible live items', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%live-handoff';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    const events: Array<Record<string, unknown>> = [];
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    let ctx: TestContext;
    let activeLeaf = 'root';
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral').mockImplementation((channel, payload) => {
      if (channel === 'conversation') events.push(payload as Record<string, unknown>);
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: (text: string) => {
        handlers.get('before_agent_start')?.({ prompt: text }, ctx);
      },
    });
    const sessionFile = path.join(root, 'session.jsonl');
    ctx = context(sessionFile);
    ctx.sessionManager.getLeafId = () => activeLeaf;
    handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    const connectorStateFile = path.join(
      root, 'connectors', fs.readdirSync(path.join(root, 'connectors'))[0]!,
    );

    await expect(sendHandler?.({
      clientRequestId: 'request-live', text: 'inspect this', delivery: 'prompt',
    }, {
      requestId: 'bridge-request', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'accepted' });
    handlers.get('message_start')?.({
      message: { role: 'user', content: 'inspect this', timestamp: 100 },
    }, ctx);
    handlers.get('agent_start')?.({}, ctx);
    handlers.get('message_start')?.({
      message: { role: 'assistant', content: [], timestamp: 200 },
    }, ctx);
    handlers.get('message_update')?.({
      assistantMessageEvent: { type: 'text_delta', delta: 'first answer' },
    }, ctx);
    handlers.get('message_end')?.({
      message: {
        role: 'assistant', stopReason: 'toolUse', timestamp: 200,
        content: [
          { type: 'text', text: 'first answer' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
        ],
      },
    }, ctx);
    handlers.get('tool_execution_start')?.({
      toolCallId: 'call-1', toolName: 'bash', args: { command: 'pwd' },
    }, ctx);
    let connectorState = JSON.parse(fs.readFileSync(connectorStateFile, 'utf8'));
    expect(connectorState.snapshots.conversation.activeTools).toMatchObject([{
      provisionalId: expect.stringMatching(/^tool:/),
      draft: {
        kind: 'tool_call', callId: 'pi:call-1', name: 'exec_command', input: { cmd: 'pwd' },
      },
    }]);
    expect(connectorState.snapshots.conversation.activeTools[0].settlement).toBeUndefined();
    handlers.get('tool_execution_end')?.({
      toolCallId: 'call-1', toolName: 'bash', args: { command: 'pwd' },
      result: { content: [{ type: 'text', text: 'contents' }] }, isError: false,
    }, ctx);
    connectorState = JSON.parse(fs.readFileSync(connectorStateFile, 'utf8'));
    expect(connectorState.snapshots.conversation.activeTools[0].settlement).toMatchObject({
      durableItemId: expect.any(String),
      item: { status: 'complete', kind: 'tool_call', callId: 'pi:call-1', name: 'exec_command' },
    });
    handlers.get('message_start')?.({
      message: { role: 'assistant', content: [], timestamp: 400 },
    }, ctx);
    handlers.get('message_update')?.({
      assistantMessageEvent: { type: 'text_delta', delta: 'final answer' },
    }, ctx);
    handlers.get('message_end')?.({
      message: {
        role: 'assistant', stopReason: 'stop', timestamp: 400,
        content: [{ type: 'text', text: 'final answer' }],
      },
    }, ctx);

    expect(events.filter((event) => event.type === 'item.opened')).toHaveLength(4);
    expect(events.filter((event) => event.type === 'item.delta')).toHaveLength(2);
    expect(events.some((event) => event.type === 'item.cancelled')).toBe(false);
    expect(events.filter((event) => event.type === 'item.settled')).toHaveLength(4);

    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'session-1' }),
      JSON.stringify({
        type: 'message', id: 'entry001', parentId: null,
        message: { role: 'user', content: 'inspect this', timestamp: 100 },
      }),
      JSON.stringify({
        type: 'message', id: 'entry002', parentId: 'entry001',
        message: {
          role: 'assistant', stopReason: 'toolUse', timestamp: 200,
          content: [
            { type: 'text', text: 'first answer' },
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'message', id: 'entry003', parentId: 'entry002',
        message: {
          role: 'toolResult', toolCallId: 'call-1', timestamp: 300,
          content: [{ type: 'text', text: 'contents' }], isError: false,
        },
      }),
      JSON.stringify({
        type: 'message', id: 'entry004', parentId: 'entry003',
        message: {
          role: 'assistant', stopReason: 'stop', timestamp: 400,
          content: [{ type: 'text', text: 'final answer' }],
        },
      }),
    ].join('\n'));
    activeLeaf = 'entry004';
    handlers.get('agent_end')?.({ messages: [{
      role: 'assistant', stopReason: 'stop', timestamp: 400,
      content: [{ type: 'text', text: 'final answer' }],
    }] }, ctx);
    handlers.get('agent_settled')?.({}, ctx);

    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: 'history.changed', leafId: 'entry004',
    })));
    connectorState = JSON.parse(fs.readFileSync(connectorStateFile, 'utf8'));
    expect(connectorState.snapshots.conversation.activeTools).toMatchObject([{
      committedLeafId: 'entry004', settlement: { item: { callId: 'pi:call-1' } },
    }]);
    expect(events.some((event) => event.type === 'item.cancelled')).toBe(false);
    handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
  });

  it('keeps a timed-out tool uncommitted when its native leaf never becomes durable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-timeout-'));
    directories.push(root);
    process.env.TMUX_PANE = '%tool-timeout';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    const events: Array<Record<string, unknown>> = [];
    vi.spyOn(PiBridgeClient.prototype, 'start').mockImplementation(() => {});
    vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral').mockImplementation((channel, payload) => {
      if (channel === 'conversation') events.push(payload as Record<string, unknown>);
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    const ctx = context(path.join(root, 'never-created.jsonl'));
    ctx.sessionManager.getLeafId = () => 'entry-timeout';
    handlers.get('session_start')?.({}, ctx);
    handlers.get('agent_start')?.({}, ctx);
    handlers.get('tool_execution_start')?.({
      toolCallId: 'call-timeout', toolName: 'read', args: { path: 'missing.md' },
    }, ctx);
    handlers.get('tool_execution_end')?.({
      toolCallId: 'call-timeout', toolName: 'read', args: { path: 'missing.md' },
    }, ctx);
    handlers.get('agent_end')?.({ messages: [{
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'late' }],
    }] }, ctx);
    handlers.get('agent_settled')?.({}, ctx);

    await vi.waitFor(() => expect(events.some((event) => event.type === 'stream.gap')).toBe(true), {
      timeout: 5_000,
    });
    const state = connectorState(root);
    expect(state.snapshots.conversation.activeTools).toMatchObject([{
      draft: { callId: 'pi:call-timeout' }, settlement: expect.any(Object),
    }]);
    expect(state.snapshots.conversation.activeTools[0].committedLeafId).toBeUndefined();
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('does not let an old durability wait commit tools after session_tree replaces its view', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-view-race-'));
    directories.push(root);
    process.env.TMUX_PANE = '%tool-view-race';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    const events: Array<Record<string, unknown>> = [];
    vi.spyOn(PiBridgeClient.prototype, 'start').mockImplementation(() => {});
    vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral').mockImplementation((channel, payload) => {
      if (channel === 'conversation') events.push(payload as Record<string, unknown>);
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    const sessionFile = path.join(root, 'session.jsonl');
    fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'session-1' }));
    let currentLeaf = 'turn-one';
    const ctx = context(sessionFile);
    ctx.sessionManager.getLeafId = () => currentLeaf;
    handlers.get('session_start')?.({}, ctx);
    handlers.get('agent_start')?.({}, ctx);
    handlers.get('tool_execution_start')?.({
      toolCallId: 'call-old-view', toolName: 'read', args: {},
    }, ctx);
    handlers.get('tool_execution_end')?.({
      toolCallId: 'call-old-view', toolName: 'read', args: {},
    }, ctx);
    handlers.get('agent_end')?.({ messages: [{
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'old view' }],
    }] }, ctx);
    handlers.get('agent_settled')?.({}, ctx);

    currentLeaf = 'branch-two';
    handlers.get('session_tree')?.({}, ctx);
    fs.appendFileSync(sessionFile, [
      JSON.stringify({ type: 'message', id: 'turn-one', parentId: null }),
      JSON.stringify({ type: 'message', id: 'branch-two', parentId: 'turn-one' }),
    ].map((line) => `\n${line}`).join(''));

    await vi.waitFor(() => expect(events.some((event) => (
      event.type === 'history.changed' && event.leafId === 'branch-two'
    ))).toBe(true));
    expect(events.some((event) => (
      event.type === 'history.changed' && event.leafId === 'turn-one'
    ))).toBe(false);
    const state = connectorState(root);
    expect(state.snapshots.conversation.activeTools).toEqual([]);
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('commits only tools captured before an overlapping later turn adds another tool', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-turn-race-'));
    directories.push(root);
    process.env.TMUX_PANE = '%tool-turn-race';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    const events: Array<Record<string, unknown>> = [];
    vi.spyOn(PiBridgeClient.prototype, 'start').mockImplementation(() => {});
    vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral').mockImplementation((channel, payload) => {
      if (channel === 'conversation') events.push(payload as Record<string, unknown>);
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    const sessionFile = path.join(root, 'session.jsonl');
    fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'session-1' }));
    const ctx = context(sessionFile);
    ctx.sessionManager.getLeafId = () => 'turn-one';
    handlers.get('session_start')?.({}, ctx);
    handlers.get('agent_start')?.({}, ctx);
    handlers.get('tool_execution_start')?.({
      toolCallId: 'call-turn-one', toolName: 'read', args: {},
    }, ctx);
    handlers.get('tool_execution_end')?.({
      toolCallId: 'call-turn-one', toolName: 'read', args: {},
    }, ctx);
    handlers.get('agent_end')?.({ messages: [{
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'turn one' }],
    }] }, ctx);
    handlers.get('agent_settled')?.({}, ctx);

    handlers.get('agent_start')?.({}, ctx);
    handlers.get('tool_execution_start')?.({
      toolCallId: 'call-turn-two', toolName: 'read', args: {},
    }, ctx);
    handlers.get('tool_execution_end')?.({
      toolCallId: 'call-turn-two', toolName: 'read', args: {},
    }, ctx);
    fs.appendFileSync(sessionFile, '\n' + JSON.stringify({
      type: 'message', id: 'turn-one', parentId: null,
    }));

    await vi.waitFor(() => expect(events.some((event) => (
      event.type === 'history.changed' && event.leafId === 'turn-one'
    ))).toBe(true));
    const tools = connectorState(root).snapshots.conversation.activeTools as Array<{
      draft: { callId: string }; committedLeafId?: string;
    }>;
    expect(tools.find((tool) => tool.draft.callId === 'pi:call-turn-one')?.committedLeafId)
      .toBe('turn-one');
    expect(tools.find((tool) => tool.draft.callId === 'pi:call-turn-two')?.committedLeafId)
      .toBeUndefined();
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('returns queued without delaying the follow-up user provisional', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-queued';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    const events: unknown[] = [];
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral').mockImplementation((channel, payload) => {
      if (channel === 'conversation') events.push(payload);
    });
    let queued = false;
    const sendUserMessage = vi.fn(() => { queued = true; });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage,
    });
    const ctx = context(path.join(root, 'session.jsonl'));
    ctx.isIdle = () => false;
    ctx.hasPendingMessages = () => queued;
    handlers.get('session_start')?.({}, ctx);

    expect(await sendHandler?.({
      clientRequestId: 'request-queued', text: 'do this next', delivery: 'followUp',
    }, { requestId: 'bridge-request', deadlineAt: Date.now() + 1_000, signal: new AbortController().signal }))
      .toEqual({ status: 'queued' });
    expect(events).toEqual([]);
    expect(sendUserMessage).toHaveBeenCalledWith('do this next', { deliverAs: 'followUp' });
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('does not replace an external active turn until the queued request starts natively', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-after-external';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    let queued = false;
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(() => { queued = true; }),
    });
    const ctx = context(path.join(root, 'session.jsonl'), 'session-1', [{
      type: 'message', id: 'entry001', parentId: null,
      message: { role: 'user', content: 'external terminal request' },
    }]);
    ctx.isIdle = () => false;
    ctx.hasPendingMessages = () => queued;
    handlers.get('session_start')?.({}, ctx);
    handlers.get('agent_start')?.({}, ctx);
    const requestContext = {
      requestId: 'bridge-request', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    };

    await expect(sendHandler?.({
      clientRequestId: 'queued-one', text: 'first queued request', delivery: 'followUp',
    }, requestContext)).resolves.toEqual({ status: 'queued' });
    let file = fs.readdirSync(path.join(root, 'connectors'))[0]!;
    let state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    expect(state.snapshots.inbox.current).toEqual({
      state: 'working', message: 'external terminal request',
    });

    handlers.get('agent_end')?.({ messages: [{
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'external reply' }],
    }] }, ctx);
    state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    expect(state.snapshots.inbox.current.message).toBe('external terminal request');
    expect(state.durable).toEqual([]);

    handlers.get('message_start')?.({ message: {
      role: 'user', content: 'first queued request', timestamp: 101,
    } }, ctx);
    state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    expect(state.snapshots.inbox.current).toMatchObject({
      state: 'working', message: 'first queued request', correlationId: 'queued-one',
    });
    handlers.get('agent_end')?.({ messages: [{
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'final queued reply' }],
    }] }, ctx);
    handlers.get('agent_settled')?.({}, ctx);
    file = fs.readdirSync(path.join(root, 'connectors'))[0]!;
    state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    expect(state.snapshots.inbox.current).toMatchObject({
      state: 'done', message: 'final queued reply', correlationId: 'queued-one',
    });
    expect(state.durable).toHaveLength(1);
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('publishes no correlated user evidence and restores Inbox when native delivery throws', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-failure';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    const events: unknown[] = [];
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    let interruptHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      if (channel === 'conversation' && method === 'interrupt') interruptHandler = handler;
      return () => {};
    });
    vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral').mockImplementation((channel, payload) => {
      if (channel === 'conversation') events.push(payload);
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: () => { throw new Error('/Users/private/provider.sock RPC rejected input'); },
    });
    const ctx = context(path.join(root, 'session.jsonl'));
    handlers.get('session_start')?.({}, ctx);

    expect(await sendHandler?.({
      clientRequestId: 'request-failed', text: 'keep this visible', delivery: 'prompt',
    }, { requestId: 'bridge-request', deadlineAt: Date.now() + 1_000, signal: new AbortController().signal }))
      .toEqual({ status: 'rejected', reason: 'provider_rejected' });
    expect(events).toEqual([]);
    ctx.abort.mockImplementation(() => { throw new Error('/Users/private/provider.sock'); });
    expect(interruptHandler?.({}, {
      requestId: 'interrupt', deadlineAt: Date.now() + 1_000,
      signal: new AbortController().signal,
    })).toEqual({ status: 'rejected', reason: 'temporarily_unavailable' });
    expect(JSON.stringify(events)).not.toContain('/Users/private');
    const file = fs.readdirSync(path.join(root, 'connectors'))[0]!;
    const state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    expect(state.snapshots.inbox).toEqual({ availability: 'ready' });
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('accepts bounded Unicode clientRequestId and rejects only empty or oversized IDs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%send-invalid';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    const publish = vi.spyOn(PiBridgeClient.prototype, 'publishEphemeral');
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    let ctx: TestContext;
    const sendUserMessage = vi.fn((text: string) => {
      handlers.get('before_agent_start')?.({ prompt: text }, ctx);
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage,
    });
    ctx = context(path.join(root, 'session.jsonl'));
    handlers.get('session_start')?.({}, ctx);

    expect(await sendHandler?.({
      clientRequestId: '中文 id with spaces', text: 'hello', delivery: 'prompt',
    }, { requestId: 'bridge-request', deadlineAt: Date.now() + 1_000, signal: new AbortController().signal }))
      .toEqual({ status: 'accepted' });
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    for (const clientRequestId of ['', 'x'.repeat(257)]) {
      expect(await sendHandler?.({ clientRequestId, text: 'hello', delivery: 'prompt' }, {
        requestId: 'bridge-request', deadlineAt: Date.now() + 1_000,
        signal: new AbortController().signal,
      })).toEqual({ status: 'rejected', reason: 'invalid_request' });
    }
    expect(publish).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('falls back to the normal completed state when no assistant text is visible', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%done-without-text';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    const ctx = context(path.join(root, 'session.jsonl'));
    handlers.get('session_start')?.({}, ctx);
    handlers.get('agent_start')?.({}, ctx);
    handlers.get('agent_end')?.({ messages: [{
      role: 'assistant', stopReason: 'toolUse', content: [
        { type: 'thinking', thinking: 'secret status' },
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} },
      ],
    }] }, ctx);
    handlers.get('agent_settled')?.({}, ctx);

    const file = fs.readdirSync(path.join(root, 'connectors'))[0]!;
    const state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    expect(state.snapshots.inbox.current).toMatchObject({ state: 'done' });
    expect(state.snapshots.inbox.current).not.toHaveProperty('message');
    expect(state.snapshots.inbox.current).not.toHaveProperty('reason');
    expect(JSON.stringify(state.snapshots.inbox)).not.toContain('secret status');
    expect(JSON.stringify(state.snapshots.inbox)).not.toContain('agent_end');
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('uses only the last assistant visible text and caps the Inbox preview', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%done-preview';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    const ctx = context(path.join(root, 'session.jsonl'));
    handlers.get('session_start')?.({}, ctx);
    handlers.get('agent_start')?.({}, ctx);
    handlers.get('agent_end')?.({ messages: [
      { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'obsolete' }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'private tool output' }] },
      { role: 'assistant', stopReason: 'stop', content: [
        { type: 'thinking', thinking: 'private thought' },
        { type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: '/secret' } },
        { type: 'text', text: `final:${'x'.repeat(5_000)}` },
      ] },
    ] }, ctx);
    handlers.get('agent_settled')?.({}, ctx);

    const file = fs.readdirSync(path.join(root, 'connectors'))[0]!;
    const state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    const preview = state.snapshots.inbox.current.message as string;
    expect(preview).toHaveLength(4096);
    expect(preview.startsWith('final:')).toBe(true);
    expect(preview).not.toContain('obsolete');
    expect(preview).not.toContain('private');
    expect(JSON.stringify(state.snapshots.inbox)).not.toContain('/secret');
    handlers.get('session_shutdown')?.({}, ctx);
  });

  it('keeps a new prompt and current correlation while the previous settled barrier finishes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%settled-barrier-race';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const sessionFile = path.join(root, 'session.jsonl');
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'session-1' }),
      JSON.stringify({ type: 'message', id: 'entry001', parentId: null }),
    ].join('\n'));
    const handlers = new Map<string, Handler>();
    let sendHandler: Parameters<PiBridgeClient['handle']>[2] | undefined;
    let ctx: TestContext;
    vi.spyOn(PiBridgeClient.prototype, 'handle').mockImplementation((channel, method, handler) => {
      if (channel === 'conversation' && method === 'send') sendHandler = handler;
      return () => {};
    });
    const sendUserMessage = vi.fn((text: string) => {
      handlers.get('before_agent_start')?.({ prompt: text }, ctx);
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage,
    });
    ctx = context(sessionFile);
    let activeLeaf = 'entry001';
    ctx.sessionManager.getLeafId = () => activeLeaf;
    handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    const requestContext = {
      requestId: 'bridge-request', deadlineAt: Date.now() + 2_000,
      signal: new AbortController().signal,
    };
    await expect(sendHandler?.({
      clientRequestId: 'old-request', text: 'old prompt', delivery: 'prompt',
    }, requestContext)).resolves.toEqual({ status: 'accepted' });
    handlers.get('agent_start')?.({}, ctx);
    handlers.get('agent_end')?.({ messages: [{
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'old reply' }],
    }] }, ctx);

    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const originalRead = fs.promises.readFile;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      if (String(args[0]) === sessionFile) { entered(); await gate; }
      return originalRead(...args as Parameters<typeof originalRead>);
    });
    handlers.get('agent_settled')?.({}, ctx);
    await reading;

    await expect(sendHandler?.({
      clientRequestId: 'new-request', text: 'new prompt', delivery: 'prompt',
    }, requestContext)).resolves.toEqual({ status: 'accepted' });
    fs.appendFileSync(sessionFile, `\n${JSON.stringify({
      type: 'message', id: 'entry002', parentId: 'entry001',
      message: { role: 'user', content: 'new prompt' },
    })}\n`);
    activeLeaf = 'entry002';
    release();
    const stateFile = path.join(root, 'connectors', fs.readdirSync(path.join(root, 'connectors'))[0]!);
    await vi.waitFor(() => {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state.snapshots.conversation.pendingItems).toEqual([]);
      expect(state.snapshots.inbox.current).toMatchObject({
        state: 'working', correlationId: 'new-request', message: 'new prompt',
      });
    });

    handlers.get('agent_start')?.({}, ctx);
    handlers.get('agent_end')?.({ messages: [{
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'new reply' }],
    }] }, ctx);
    handlers.get('agent_settled')?.({}, ctx);
    const finalState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(finalState.snapshots.inbox.current).toMatchObject({
      state: 'done', correlationId: 'new-request', message: 'new reply',
    });
    handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
  });

  it.each(['new', 'resume'] as const)(
    'handles the native shutdown→%s start lifecycle without authorizing before old durable drain',
    async (reason) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = `%lifecycle-${reason}`;
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const oldHandlers = new Map<string, Handler>();
    const newHandlers = new Map<string, Handler>();
    let release!: () => void;
    const drained = new Promise<void>((resolve) => { release = resolve; });
    const started: PiBridgeClient[] = [];
    const closed: PiBridgeClient[] = [];
    vi.spyOn(PiBridgeClient.prototype, 'start').mockImplementation(function start(
      this: PiBridgeClient,
    ) {
      started.push(this);
    });
    vi.spyOn(PiBridgeClient.prototype, 'waitForDurableDrain').mockImplementationOnce(() => drained);
    vi.spyOn(PiBridgeClient.prototype, 'closeAndRemoveIfDrained').mockImplementation(function close(
      this: PiBridgeClient,
    ) {
      closed.push(this);
      return true;
    });
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { oldHandlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    const first = context('/tmp/first.jsonl', 'session-old');
    const second = context('/tmp/second.jsonl', 'session-new');
    oldHandlers.get('session_start')?.({ reason: 'startup' }, first);
    oldHandlers.get('session_shutdown')?.({ reason }, first);
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { newHandlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    newHandlers.get('session_start')?.({ reason }, second);

    expect(started).toHaveLength(1);
    expect(closed).toHaveLength(0);
    const files = fs.readdirSync(path.join(root, 'connectors'));
    expect(files).toHaveLength(2);
    const sessions = files.map((file) => JSON.parse(
      fs.readFileSync(path.join(root, 'connectors', file), 'utf8'),
    ).snapshots.conversation.sessionId);
    expect(sessions).toEqual(expect.arrayContaining(['session-old', 'session-new']));
    release();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(closed).toEqual([started[0]]);
    newHandlers.get('session_shutdown')?.({ reason: 'quit' }, second);
    },
  );

  it('replaces the process-global generation when a reloaded Extension reports startup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%lifecycle-reload';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const oldHandlers = new Map<string, Handler>();
    const newHandlers = new Map<string, Handler>();
    const started: PiBridgeClient[] = [];
    vi.spyOn(PiBridgeClient.prototype, 'start').mockImplementation(function start(
      this: PiBridgeClient,
    ) { started.push(this); });
    vi.spyOn(PiBridgeClient.prototype, 'waitForDurableDrain').mockResolvedValue();
    vi.spyOn(PiBridgeClient.prototype, 'closeAndRemoveIfDrained').mockReturnValue(true);

    handmuxPiExtension({
      on: (event: string, handler: Handler) => { oldHandlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    const ctx = context('/tmp/reload.jsonl', 'session-reload');
    oldHandlers.get('session_start')?.({ reason: 'startup' }, ctx);
    oldHandlers.get('session_shutdown')?.({ reason: 'reload' }, ctx);

    // `/reload` evaluates a fresh module instance, but Pi can surface its first session_start as
    // startup rather than reload. The process-global predecessor must still force replacement.
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { newHandlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    newHandlers.get('session_start')?.({ reason: 'startup' }, ctx);

    await vi.waitFor(() => expect(started).toHaveLength(2));
    const files = fs.readdirSync(path.join(root, 'connectors'));
    expect(files).toHaveLength(2);
    expect(new Set(files)).toHaveLength(2);
    for (const file of files) {
      const state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
      expect(state.snapshots.conversation.implementationVersion).toBe(6);
    }
    newHandlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
  });

  it('keeps working after agent_end because Pi may still retry or continue', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%9';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    const ctx = context();
    handlers.get('session_start')?.({}, ctx);
    handlers.get('agent_start')?.({}, ctx);
    handlers.get('agent_end')?.({
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: '429 rate limit' }],
    }, ctx);
    const file = fs.readdirSync(path.join(root, 'connectors'))[0]!;
    const state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    expect(state.snapshots.inbox).toMatchObject({
      availability: 'ready', current: { state: 'working' },
    });
    expect(state.durable).toEqual([]);
  });

  it('publishes a durable error when Pi will not retry the failed agent_end', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%11';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    const ctx = context();
    handlers.get('session_start')?.({}, ctx);
    handlers.get('agent_start')?.({}, ctx);
    handlers.get('agent_end')?.({
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'Authentication failed' }],
    }, ctx);
    handlers.get('agent_settled')?.({}, ctx);
    const file = fs.readdirSync(path.join(root, 'connectors'))[0]!;
    const state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    expect(state.snapshots.inbox).toMatchObject({
      availability: 'ready',
      current: { state: 'error', reason: 'provider_error', message: 'Pi generation failed' },
    });
    expect(JSON.stringify(state)).not.toContain('Authentication failed');
    expect(state.durable).toHaveLength(1);
    expect(state.durable[0]).toMatchObject({
      channel: 'inbox',
      payload: { kind: 'set', state: 'error', reason: 'provider_error' },
    });
  });

  it('clears working after an aborted agent_end because Pi does not retry user cancellation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-extension-'));
    directories.push(root);
    process.env.TMUX_PANE = '%10';
    process.env.HANDMUX_AGENT_RUNTIME_DIR = root;
    const handlers = new Map<string, Handler>();
    handmuxPiExtension({
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
      sendUserMessage: vi.fn(),
    });
    const ctx = context();
    handlers.get('session_start')?.({}, ctx);
    handlers.get('agent_start')?.({}, ctx);
    handlers.get('agent_end')?.({
      messages: [{ role: 'assistant', stopReason: 'aborted' }],
    }, ctx);
    handlers.get('agent_settled')?.({}, ctx);
    const file = fs.readdirSync(path.join(root, 'connectors'))[0]!;
    const state = JSON.parse(fs.readFileSync(path.join(root, 'connectors', file), 'utf8'));
    expect(state.snapshots.inbox).toEqual({ availability: 'ready' });
    expect(state.durable).toEqual([]);
  });
});
