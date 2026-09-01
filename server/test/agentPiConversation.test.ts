import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentBridge } from '../src/agent-runtime/bridge.js';
import { ConversationService } from '../src/agent-runtime/conversation.js';
import type {
  ConversationActivitySnapshot,
  ConversationEvent,
} from '../src/agent-runtime/conversationTypes.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';
import type { AgentRunLease, ScopedAgentRunController } from '../src/agent-runtime/run.js';
import {
  createPiConversationActivityReader,
  createPiConversationAdapter,
} from '../src/agents/piConversation.js';
import { PiConversationHistory } from '../src/agents/piConversationHistory.js';

const tempDirectories: string[] = [];
const bridges: LocalAgentBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function header() {
  return { type: 'session', version: 3, id: 'session-1', timestamp: '2026-08-12T00:00:00Z' };
}

function userEntry(id = 'entry001', parentId: string | null = null, text = 'hello') {
  return {
    type: 'message', id, parentId, timestamp: '2026-08-12T00:00:01Z',
    message: { role: 'user', content: text, timestamp: 1_786_492_801_000 },
  };
}

function writeSession(file: string, entries: unknown[]): void {
  fs.writeFileSync(file, `${[header(), ...entries].map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

function appendSession(file: string, entry: unknown): void {
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

interface Harness {
  runtime: AgentRunRuntime;
  controller: ScopedAgentRunController;
  lease: AgentRunLease;
  bridge: LocalAgentBridge;
  connection: ReturnType<LocalAgentBridge['connect']>;
  channel: ReturnType<ReturnType<LocalAgentBridge['connect']>['channel']>;
  file: string;
  adapter: ReturnType<typeof createPiConversationAdapter>;
  service: ConversationService;
}

async function harness(options: {
  snapshot?: unknown;
  withSnapshot?: boolean;
  implementationVersion?: number | null;
  activity?: ConversationActivitySnapshot;
} = {}): Promise<Harness> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-conversation-'));
  tempDirectories.push(directory);
  const file = path.join(directory, 'session-1.jsonl');
  writeSession(file, [userEntry()]);
  const runtime = new AgentRunRuntime({ newRunId: () => 'run-1' });
  const controller = runtime.controller('pi', async () => true);
  const lease = await controller.attach({
    paneId: '%1', attachmentId: 'pi-extension', sessionId: 'session-1',
    ...(options.implementationVersion === null ? {}
      : { implementationVersion: options.implementationVersion ?? 6 }),
    process: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
  });
  const bridge = new LocalAgentBridge({
    runs: runtime, adapterIds: ['pi'], newConnectionId: () => 'connection-1',
  });
  bridges.push(bridge);
  const connection = bridge.connect(lease);
  const channel = connection.channel('conversation');
  if (options.withSnapshot !== false) {
    await channel.setSnapshot(options.snapshot ?? {
      implementationVersion: 6,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
    });
  }
  const history = new PiConversationHistory({
    sessionsRoot: directory,
    resolveFile: async (_root, sessionId) => sessionId === 'session-1' ? file : null,
  });
  const adapter = createPiConversationAdapter({ host: bridge.hostFor('pi'), history });
  const service = new ConversationService({
    runs: runtime, adapters: { pi: adapter },
    activitySource: { read: async () => options.activity ?? ({
      activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-1',
    }) },
  });
  return { runtime, controller, lease, bridge, connection, channel, file, adapter, service };
}

async function open(h: Harness): Promise<{
  events: ConversationEvent[];
  handle: Awaited<ReturnType<ConversationService['open']>>;
}> {
  const events: ConversationEvent[] = [];
  const handle = await h.service.open(h.lease, {}, (event) => { events.push(event); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { events, handle };
}

describe('Pi Conversation Bridge adapter', () => {
  it('forwards the Pi completion token through the Runtime activity reader contract', async () => {
    const h = await harness();
    h.channel.handle('activity', async () => ({
      activity: 'idle', activeTurn: { state: 'none' }, completionToken: 'pi-completed:7',
    }));
    await expect(createPiConversationActivityReader(h.bridge.hostFor('pi')).read(h.lease))
      .resolves.toEqual({
        activity: 'idle', activeTurn: { state: 'none' }, completionToken: 'pi-completed:7',
      });
  });

  it('opens a running empty Pi session before Pi creates its deferred JSONL', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-pi-empty-conversation-'));
    tempDirectories.push(directory);
    const runtime = new AgentRunRuntime({ newRunId: () => 'run-empty' });
    const controller = runtime.controller('pi', async () => true);
    const lease = await controller.attach({
      paneId: '%2', attachmentId: 'pi-extension-empty', sessionId: 'session-empty',
      process: { pid: 102, startedAt: 2_000, tty: '/dev/ttys002' },
    });
    const bridge = new LocalAgentBridge({
      runs: runtime, adapterIds: ['pi'], newConnectionId: () => 'connection-empty',
    });
    bridges.push(bridge);
    const connection = bridge.connect(lease);
    const channel = connection.channel('conversation');
    await channel.setSnapshot({
      sessionId: 'session-empty', leafId: 'entry-pending', viewId: 'branch-empty',
      pendingItems: [{
        id: 'pi:entry-pending', sessionId: 'session-empty', status: 'complete', kind: 'message',
        role: 'user', content: [{ type: 'text', text: 'pending prompt' }],
      }],
    });
    const history = new PiConversationHistory({
      sessionsRoot: directory, resolveFile: async () => null,
    });
    const service = new ConversationService({
      runs: runtime,
      adapters: { pi: createPiConversationAdapter({ host: bridge.hostFor('pi'), history }) },
      activitySource: { read: async () => ({
        activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-empty',
      }) },
    });

    expect(await service.discover({ agentId: 'pi', sessionId: 'session-empty' })).toBeNull();
    const descriptor = await service.discover(lease.ref);
    expect(descriptor?.capabilities.live).toBe('delta');
    const page = await service.readPage(
      { agentId: 'pi', sessionId: 'session-empty' }, { limit: 20 },
    );
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('expected empty Pi history');
    expect(page.page.items).toEqual([]);

    const opened = await service.open(lease, {}, () => {});
    const livePage = await service.readPage(
      { agentId: 'pi', sessionId: 'session-empty' }, { limit: 20 },
    );
    expect(livePage.status).toBe('ok');
    if (livePage.status !== 'ok') throw new Error('expected live Pi history');
    expect(livePage.page.items).toMatchObject([{ kind: 'message', role: 'user' }]);
    opened.close();
  });

  it('uses the Bridge snapshot as the history baseline and exposes live capabilities', async () => {
    const h = await harness();
    const descriptor = await h.service.discover(h.lease.ref);
    expect(descriptor?.capabilities).toEqual({
      history: true, live: 'delta', sendable: true, steer: true, send: ['prompt'],
      interrupt: true, branching: true,
    });
    const page = await h.service.readPage({ agentId: 'pi', sessionId: 'session-1' }, { limit: 20 });
    if (page.status !== 'ok') throw new Error('expected Pi history');
    expect(page.page.items).toMatchObject([{ kind: 'message', role: 'user' }]);
    expect(JSON.stringify(page)).not.toContain(h.file);
  });

  it('marks an already-running legacy Connector for reload and accepts the current implementation', async () => {
    const legacy = await harness({ implementationVersion: null, snapshot: {
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
    } });
    const legacyDescriptor = await legacy.service.discover(legacy.lease.ref);
    expect(legacyDescriptor?.implementation).toEqual({ version: 1, reloadRequired: true });
    expect(legacyDescriptor?.capabilities).toEqual({
      history: true, live: 'delta', branching: true,
    });

    for (const version of [2, 3]) {
      const stale = await harness({ implementationVersion: version, snapshot: {
        implementationVersion: version,
        sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
      } });
      expect((await stale.service.discover(stale.lease.ref))?.implementation)
        .toEqual({ version, reloadRequired: true });
      expect((await stale.service.discover(stale.lease.ref))?.capabilities).toEqual({
        history: true, live: 'delta', branching: true,
      });
    }

    for (const version of [4, 5]) {
      const previous = await harness({ implementationVersion: version, snapshot: {
        implementationVersion: version,
        sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
      } });
      const previousDescriptor = await previous.service.discover(previous.lease.ref);
      expect(previousDescriptor?.implementation).toEqual({ version, reloadRequired: true });
      expect(previousDescriptor?.capabilities).toEqual({
        history: true, live: 'delta', sendable: true, send: ['prompt'],
        interrupt: true, branching: true,
      });
      expect(await previous.service.queueSnapshot(previous.lease)).toMatchObject({
        canSteer: false, canEdit: true, canRemove: true,
      });
    }

    const current = await harness({ implementationVersion: 6, snapshot: {
      implementationVersion: 6,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
    } });
    const currentDescriptor = await current.service.discover(current.lease.ref);
    expect(currentDescriptor?.implementation).toEqual({ version: 6 });
    expect(await current.service.queueSnapshot(current.lease)).toMatchObject({
      canSteer: true, canEdit: true, canRemove: true,
    });
  });

  it('keeps v5 prompt delivery available while refusing steer before Connector v6', async () => {
    const h = await harness({ implementationVersion: 5, snapshot: {
      implementationVersion: 5,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
    } });
    const send = vi.fn(async () => ({ status: 'accepted' }));
    h.channel.handle('send', send);

    await expect(h.adapter.dispatchPrompt?.(h.lease, {
      clientRequestId: 'v5-prompt', text: 'ordinary prompt',
    })).resolves.toEqual({ outcome: 'accepted' });
    await expect(h.adapter.dispatchSteer?.(h.lease, {
      clientRequestId: 'v5-steer', text: 'private steer',
      plan: { kind: 'start-turn-fallback', activityEpoch: 'run-1', activityRevision: 1 },
      anchor: { viewId: 'branch-main' },
    })).resolves.toEqual({ outcome: 'rejected', nativeMutation: false, reason: 'unsupported' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      clientRequestId: 'v5-prompt', text: 'ordinary prompt', delivery: 'prompt',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('projects an empty start, text delta, and settlement in Bridge order', async () => {
    const h = await harness();
    const { events } = await open(h);
    await h.channel.publish({ payload: {
      type: 'item.opened', provisionalId: 'answer-1',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    } });
    await h.channel.publish({ payload: {
      type: 'item.delta', provisionalId: 'answer-1',
      delta: { op: 'text.append', target: 'message.content', text: 'Hello' },
    } });
    await h.channel.publish({ payload: {
      type: 'item.settled', provisionalId: 'answer-1', item: {
        id: 'pi:entry002', sessionId: 'session-1', kind: 'message', status: 'complete',
        role: 'assistant', content: [{ type: 'text', text: 'Hello' }],
      },
    } });
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events.map((event) => event.type)).toEqual(['item.opened', 'item.delta', 'item.settled']);
  });

  it('does not expose a tool-result credential split across live text chunks', async () => {
    const h = await harness();
    const { events } = await open(h);
    await h.channel.publish({ payload: {
      type: 'item.opened', provisionalId: 'tool-result-1',
      draft: {
        kind: 'tool_result', callId: 'pi:call-secret',
        content: [{ type: 'text', text: '' }],
      },
    } });
    await h.channel.publish({ payload: {
      type: 'item.delta', provisionalId: 'tool-result-1',
      delta: { op: 'text.append', target: 'tool_result.content', text: 'Authorization: Bear' },
    } });
    await h.channel.publish({ payload: {
      type: 'item.delta', provisionalId: 'tool-result-1',
      delta: { op: 'text.append', target: 'tool_result.content', text: 'er split-secret' },
    } });
    await h.channel.publish({ payload: {
      type: 'item.settled', provisionalId: 'tool-result-1', item: {
        id: 'pi:tool-result-1', sessionId: 'session-1', status: 'complete',
        kind: 'tool_result', callId: 'pi:call-secret',
        content: [{ type: 'text', text: 'Authorization: Bearer split-secret' }],
      },
    } });

    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events.map((event) => event.type)).toEqual(['item.opened', 'item.settled']);
    expect(events[1]).toMatchObject({
      type: 'item.settled',
      item: { status: 'complete' },
    });
    expect(events[1]).not.toHaveProperty('item.truncation');
    expect(JSON.stringify(events)).not.toContain('split-secret');
  });

  it('restores a running tool from the opening snapshot and settles it exactly once', async () => {
    const draft = {
      kind: 'tool_call', callId: 'pi:call-reconnect', name: 'read',
      input: {
        path: 'README.md', cwd: '/Users/alice/project', apiKey: 'snapshot-secret',
        endpoint: 'http://localhost:9000/mcp', documentationUrl: 'https://docs.example.com/pi',
      },
    };
    const h = await harness({ snapshot: {
      implementationVersion: 5,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
      activeTools: [{ provisionalId: 'tool:reconnect', draft }],
    } });
    const { events } = await open(h);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      type: 'item.opened', provisionalId: 'tool:reconnect',
      draft: {
        kind: 'tool_call', callId: 'pi:call-reconnect',
        input: { path: 'README.md', documentationUrl: 'https://docs.example.com/pi' },
      },
    });
    expect(JSON.stringify(events[0])).not.toContain('snapshot-secret');
    expect(JSON.stringify(events[0])).not.toContain('/Users/alice');
    expect(JSON.stringify(events[0])).not.toContain('localhost');

    const durableItemId = 'pi:live_reconnect:tool';
    const item = {
      id: durableItemId, sessionId: 'session-1', status: 'complete', kind: 'tool_call',
      callId: 'pi:call-reconnect', name: 'read', input: {
        path: 'README.md', Authorization: 'Bearer settled-secret',
        savedPath: '/private/tmp/pi-result',
      },
      extensions: { 'pi.live': true },
    };
    await h.channel.setSnapshot({
      implementationVersion: 5,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
      activeTools: [{
        provisionalId: 'tool:reconnect', draft,
        settlement: { durableItemId, item },
      }],
    });
    await h.channel.publish({ payload: {
      type: 'item.settled', provisionalId: 'tool:reconnect', durableItemId, item,
    } });

    await vi.waitFor(() => expect(events.map((event) => event.type))
      .toEqual(['item.opened', 'item.settled']));
    expect(events.filter((event) => event.type === 'item.opened')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'item.settled')).toHaveLength(1);
    expect(events.find((event) => event.type === 'item.settled')).toMatchObject({
      item: { status: 'complete' },
    });
    expect(events.find((event) => event.type === 'item.settled'))
      .not.toHaveProperty('item.truncation');
    expect(JSON.stringify(events)).not.toContain('settled-secret');
    expect(JSON.stringify(events)).not.toContain('/private/tmp');
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
  });

  it('keeps a live tool when a v4 snapshot omits activeTools during a send update', async () => {
    const draft = {
      kind: 'tool_call', callId: 'pi:call-v4', name: 'read', input: { path: 'README.md' },
    };
    const h = await harness({ implementationVersion: 4, snapshot: {
      implementationVersion: 4,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
      activeTools: [{ provisionalId: 'tool:v4', draft }],
    } });
    const { events } = await open(h);
    await vi.waitFor(() => expect(events).toMatchObject([{
      type: 'item.opened', provisionalId: 'tool:v4',
    }]));

    await h.channel.setSnapshot({
      implementationVersion: 4,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
      pendingItems: [{
        id: 'pi-user:queued', sessionId: 'session-1', status: 'complete',
        kind: 'message', role: 'user', content: [{ type: 'text', text: 'queued' }],
      }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.filter((event) => event.type === 'item.cancelled')).toEqual([]);
    expect(events.filter((event) => event.type === 'item.opened')).toHaveLength(1);
  });

  it('restores multiple opening tools without checkpoint sequence collisions', async () => {
    const h = await harness({ snapshot: {
      implementationVersion: 5,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
      activeTools: [
        {
          provisionalId: 'tool:first',
          draft: { kind: 'tool_call', callId: 'pi:first', name: 'read', input: { path: 'a' } },
        },
        {
          provisionalId: 'tool:second',
          draft: { kind: 'tool_call', callId: 'pi:second', name: 'read', input: { path: 'b' } },
        },
      ],
    } });
    const { events } = await open(h);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events).toMatchObject([
      { type: 'item.opened', provisionalId: 'tool:first' },
      { type: 'item.opened', provisionalId: 'tool:second' },
    ]);
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);
  });

  it('prefers late native history over an uncommitted timed-out tool settlement on reconnect', async () => {
    const draft = {
      kind: 'tool_call', callId: 'pi:call-late', name: 'read', input: { path: 'late.md' },
    };
    const durableItemId = 'pi:live_late:tool';
    const item = {
      id: durableItemId, sessionId: 'session-1', status: 'complete', kind: 'tool_call',
      callId: 'pi:call-late', name: 'read', input: { path: 'late.md' },
      extensions: { 'pi.live': true },
    };
    const h = await harness({ snapshot: {
      implementationVersion: 5,
      sessionId: 'session-1', leafId: 'entry002', viewId: 'branch-main',
      activeTools: [{
        provisionalId: 'tool:late', draft, settlement: { durableItemId, item },
      }],
    } });
    appendSession(h.file, {
      type: 'message', id: 'entry002', parentId: 'entry001',
      timestamp: '2026-08-12T00:00:02Z',
      message: {
        role: 'assistant', stopReason: 'toolUse', timestamp: 1_786_492_802_000,
        content: [{
          type: 'toolCall', id: 'call-late', name: 'read', arguments: { path: 'late.md' },
        }],
      },
    });

    const { events } = await open(h);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);
    const page = await h.service.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    if (page.status !== 'ok') throw new Error('expected late native Pi history');
    expect(page.page.items.filter((candidate) => (
      candidate.kind === 'tool_call' && candidate.callId === 'pi:call-late'
    ))).toHaveLength(1);
  });

  it('deduplicates uninterrupted tool snapshots and hands the completed tool to history', async () => {
    const h = await harness();
    const { events, handle } = await open(h);
    const draft = {
      kind: 'tool_call', callId: 'pi:call-live', name: 'read', input: { path: 'README.md' },
    };
    await h.channel.setSnapshot({
      implementationVersion: 5,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
      activeTools: [{ provisionalId: 'tool:live', draft }],
    });
    await h.channel.publish({ payload: {
      type: 'item.opened', provisionalId: 'tool:live', draft,
    } });

    const durableItemId = 'pi:live_tool:tool';
    const item = {
      id: durableItemId, sessionId: 'session-1', status: 'complete', kind: 'tool_call',
      callId: 'pi:call-live', name: 'read', input: { path: 'README.md' },
      extensions: { 'pi.live': true },
    };
    await h.channel.setSnapshot({
      implementationVersion: 5,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
      activeTools: [{
        provisionalId: 'tool:live', draft, settlement: { durableItemId, item },
      }],
    });
    await h.channel.publish({ payload: {
      type: 'item.settled', provisionalId: 'tool:live', durableItemId, item,
    } });
    await vi.waitFor(() => expect(events.map((event) => event.type))
      .toEqual(['item.opened', 'item.settled']));

    appendSession(h.file, {
      type: 'message', id: 'entry002', parentId: 'entry001',
      timestamp: '2026-08-12T00:00:02Z',
      message: {
        role: 'assistant', stopReason: 'toolUse', timestamp: 1_786_492_802_000,
        content: [{
          type: 'toolCall', id: 'call-live', name: 'read', arguments: { path: 'README.md' },
        }],
      },
    });
    await h.channel.setSnapshot({
      implementationVersion: 5,
      sessionId: 'session-1', leafId: 'entry002', viewId: 'branch-main',
      activeTools: [{
        provisionalId: 'tool:live', draft,
        settlement: { durableItemId, item }, committedLeafId: 'entry002',
      }],
    });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('history.changed'));

    const page = await h.service.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    if (page.status !== 'ok') throw new Error('expected committed Pi tool history');
    expect(page.page.items.filter((candidate) => (
      candidate.kind === 'tool_call' && candidate.callId === 'pi:call-live'
    ))).toHaveLength(1);
    expect(events.filter((event) => event.type === 'item.opened')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'item.settled')).toHaveLength(1);
    expect(events.some((event) => event.type === 'item.cancelled')).toBe(false);
    expect(events.some((event) => event.type === 'stream.gap')).toBe(false);

    await handle.close();
    const reopenedEvents: ConversationEvent[] = [];
    const reopened = await h.service.open(h.lease, {}, (event) => { reopenedEvents.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reopenedEvents).toEqual([]);
    reopened.close();
  });

  it('invalidates provisional state when the Extension reports lost live deltas', async () => {
    const h = await harness();
    const { events } = await open(h);
    await h.channel.publish({ payload: { type: 'stream.gap' } });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'stream.gap' });
  });

  it('buffers events accepted while the history baseline is being checked', async () => {
    const h = await harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalRead = fs.promises.readFile;
    const readSpy = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      await gate;
      return originalRead(...args as Parameters<typeof originalRead>);
    });
    const events: ConversationEvent[] = [];
    const opening = h.service.open(h.lease, {}, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.channel.publish({ payload: {
      type: 'item.opened', provisionalId: 'buffered-1',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    } });
    release();
    await opening;
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'item.opened', provisionalId: 'buffered-1' });
    readSpy.mockRestore();
  });

  it('publishes history.changed only after the appended leaf is readable', async () => {
    const h = await harness();
    const { events } = await open(h);
    appendSession(h.file, userEntry('entry002', 'entry001', 'next'));
    await h.channel.publish({ payload: {
      type: 'history.changed', leafId: 'entry002', viewId: 'branch-main',
    } });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.type).toBe('history.changed');
    const page = await h.service.readPage({ agentId: 'pi', sessionId: 'session-1' }, { limit: 20 });
    if (page.status !== 'ok') throw new Error('expected changed history');
    expect(page.page.items).toHaveLength(2);
  });

  it('treats a readable same-view snapshot leaf advance as a recoverable history commit', async () => {
    const h = await harness();
    const { events } = await open(h);
    appendSession(h.file, userEntry('entry002', 'entry001', 'next'));

    await h.channel.setSnapshot({
      sessionId: 'session-1', leafId: 'entry002', viewId: 'branch-main',
    });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.type).toBe('history.changed');
    const page = await h.service.readPage({ agentId: 'pi', sessionId: 'session-1' }, { limit: 20 });
    if (page.status !== 'ok') throw new Error('expected advanced history');
    expect(page.page.items).toHaveLength(2);
  });

  it('publishes a history commit when same-view same-leaf pending items change', async () => {
    const h = await harness();
    const { events } = await open(h);

    await h.channel.setSnapshot({
      implementationVersion: 5,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
      pendingItems: [{
        id: 'pi-user:pending-snapshot', sessionId: 'session-1', status: 'complete',
        kind: 'message', role: 'user', content: [{ type: 'text', text: 'snapshot fallback' }],
        extensions: { 'pi.live': true, 'pi.pendingClientRequestId': 'request-snapshot' },
      }],
    });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.type).toBe('history.changed');
    const page = await h.service.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    if (page.status !== 'ok') throw new Error('expected pending snapshot history');
    expect(page.page.items.map((item) => item.id)).toEqual([
      'pi:entry001', 'pi-user:pending-snapshot',
    ]);

    await h.channel.setSnapshot({
      implementationVersion: 5,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
      pendingItems: [],
    });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    const cleared = await h.service.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    if (cleared.status !== 'ok') throw new Error('expected cleared snapshot history');
    expect(cleared.page.items.map((item) => item.id)).toEqual(['pi:entry001']);
  });

  it('fails a same-view snapshot leaf advance closed when its history is not readable', async () => {
    const h = await harness();
    const { events } = await open(h);

    await h.channel.setSnapshot({
      sessionId: 'session-1', leafId: 'notready', viewId: 'branch-main',
    });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.type).toBe('stream.gap');
  });

  it('fails a premature history change closed instead of publishing an unreadable version', async () => {
    const h = await harness();
    const { events } = await open(h);
    await h.channel.publish({ payload: {
      type: 'history.changed', leafId: 'notready', viewId: 'branch-main',
    } });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.type).toBe('stream.gap');
  });

  it('turns a readable tree leaf switch into a gap and a new view', async () => {
    const h = await harness();
    const { events } = await open(h);
    const before = await h.service.discover(h.lease.ref);
    await h.channel.setSnapshot({
      implementationVersion: 5,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
      activeTools: [{
        provisionalId: 'tool:old-view',
        draft: { kind: 'tool_call', callId: 'pi:old-view', name: 'read', input: {} },
      }],
    });
    await vi.waitFor(() => expect(events).toMatchObject([{
      type: 'item.opened', provisionalId: 'tool:old-view',
    }]));
    appendSession(h.file, userEntry('branch001', 'entry001', 'branch'));
    await h.channel.setSnapshot({
      implementationVersion: 5,
      sessionId: 'session-1', leafId: 'branch001', viewId: 'branch-alternate',
      activeTools: [],
    });
    await vi.waitFor(() => expect(events.map((event) => event.type))
      .toEqual(['item.opened', 'stream.gap']));
    const after = await h.service.discover(h.lease.ref);
    expect(after?.viewId).not.toBe(before?.viewId);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const reopenedEvents: ConversationEvent[] = [];
    const reopened = await h.service.open(h.lease, {}, (event) => { reopenedEvents.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reopenedEvents).toEqual([]);
    reopened.close();
  });

  it('maps ordinary prompt and interrupt while rejecting provider delivery selection', async () => {
    const h = await harness();
    const send = vi.fn(async (value: unknown) => ({ status: 'accepted', nativeId: 'native-1', echo: value }));
    const interrupt = vi.fn(async () => ({ status: 'accepted' }));
    h.channel.handle('send', send);
    h.channel.handle('interrupt', interrupt);
    expect(await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'now', delivery: 'prompt',
    })).toMatchObject({ status: 'accepted', nativeId: 'native-1' });
    expect(await h.service.send(h.lease, {
      clientRequestId: 'request-2', text: 'steer', delivery: 'steer',
    })).toEqual({ status: 'rejected', reason: 'invalid_request', nativeMutation: false });
    expect(await h.service.send(h.lease, {
      clientRequestId: 'request-3', text: 'later', delivery: 'follow_up',
    })).toEqual({ status: 'rejected', reason: 'invalid_request', nativeMutation: false });
    expect(send.mock.calls.map(([value]) => value)).toEqual([
      { clientRequestId: 'request-1', text: 'now', delivery: 'prompt' },
    ]);
    expect(await h.service.interrupt(h.lease)).toEqual({ status: 'accepted' });
    expect(interrupt).toHaveBeenCalledWith({}, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('preserves steer origin when a fallback uses native prompt delivery', async () => {
    const h = await harness();
    const send = vi.fn(async () => ({ status: 'accepted' }));
    h.channel.handle('send', send);

    await expect(h.adapter.dispatchSteer?.(h.lease, {
      clientRequestId: 'request-fallback', text: 'private fallback guide',
      plan: { kind: 'start-turn-fallback', activityEpoch: 'run-1', activityRevision: 1 },
      anchor: { viewId: 'branch-main' },
    })).resolves.toEqual({ outcome: 'accepted' });
    expect(send).toHaveBeenCalledWith({
      clientRequestId: 'request-fallback', text: 'private fallback guide',
      origin: 'steer', delivery: 'prompt',
      plan: { kind: 'start-turn-fallback', activityEpoch: 'run-1', activityRevision: 1 },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('accepts a native queued steer receipt while preserving true uncertainty', async () => {
    const queued = await harness({ activity: {
      activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-1' },
      revision: 2, epoch: 'run-1',
    } });
    const nativeSend = vi.fn(async () => ({ status: 'queued', nativeId: 'native-queued' }));
    queued.channel.handle('send', nativeSend);
    const submitted = await queued.service.send(queued.lease, {
      clientRequestId: 'request-queued', text: 'guide Pi now', delivery: 'prompt',
    });
    expect(submitted).toMatchObject({ status: 'queued', submission: { state: 'queued' } });
    const baseRevision = submitted.submission?.revision;
    if (baseRevision === undefined) throw new Error('expected queued revision');
    await expect(queued.service.queueAction(queued.lease, {
      action: 'steer', itemId: 'request-queued', actionId: 'steer-1', baseRevision,
      anchor: { viewId: 'branch-main', afterItemId: 'pi:entry001' },
    })).resolves.toMatchObject({
      actionId: 'steer-1', result: 'accepted', nativeMutation: true,
    });
    expect(nativeSend).toHaveBeenCalledWith(expect.objectContaining({
      clientRequestId: 'request-queued', text: 'guide Pi now', delivery: 'steer',
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));

    const unknown = await harness();
    unknown.channel.handle('send', async () => ({
      status: 'unknown', reason: 'native_delivery_unconfirmed',
    }));
    await expect(unknown.service.send(unknown.lease, {
      clientRequestId: 'request-unknown', text: 'uncertain delivery', delivery: 'prompt',
    })).resolves.toMatchObject({
      status: 'unknown', nativeMutation: 'unknown',
    });
  });

  it('sanitizes raw receipt reasons from a legacy v2 Connector at the Pi Adapter boundary', async () => {
    const h = await harness({ implementationVersion: 2, snapshot: {
      implementationVersion: 2,
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
    } });
    expect((await h.service.discover(h.lease.ref))?.implementation)
      .toEqual({ version: 2, reloadRequired: true });
    h.channel.handle('send', async () => ({
      status: 'rejected', reason: '/Users/private/provider.sock RPC rejected input',
    }));
    h.channel.handle('interrupt', async () => ({
      status: 'rejected', reason: '/Users/private/provider.sock RPC interrupt failed',
    }));

    const send = await h.service.send(h.lease, {
      clientRequestId: 'legacy-v2-raw-error', text: 'keep private details hidden', delivery: 'prompt',
    });
    const interrupt = await h.service.interrupt(h.lease);
    expect(send).toEqual({ status: 'rejected', reason: 'provider_rejected', nativeMutation: false });
    expect(interrupt).toEqual({ status: 'rejected', reason: 'temporarily_unavailable' });
    expect(JSON.stringify({ send, interrupt })).not.toContain('/Users/private');
    expect(JSON.stringify({ send, interrupt })).not.toContain('RPC');
  });

  it('shows the sent user item before assistant output and converges to one durable history item', async () => {
    const h = await harness();
    const { events } = await open(h);
    h.channel.handle('send', async (value) => {
      const request = value as { clientRequestId: string; text: string };
      await h.channel.publish({ payload: {
        type: 'item.opened', provisionalId: `user-${request.clientRequestId}`,
        draft: {
          kind: 'message', role: 'user', correlationId: request.clientRequestId,
          content: [{ type: 'text', text: request.text }],
        },
      } });
      await h.channel.publish({ payload: {
        type: 'item.opened', provisionalId: 'assistant-for-request',
        draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
      } });
      return { status: 'accepted' };
    });

    await expect(h.service.send(h.lease, {
      clientRequestId: 'request-live', text: 'visible immediately', delivery: 'prompt',
    })).resolves.toEqual({ status: 'accepted' });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events).toMatchObject([
      { type: 'item.opened', draft: { role: 'user', correlationId: 'request-live' } },
      { type: 'item.opened', draft: { role: 'assistant' } },
    ]);

    appendSession(h.file, userEntry('entry002', 'entry001', 'visible immediately'));
    await h.channel.publish({ payload: {
      type: 'history.changed', leafId: 'entry002', viewId: 'branch-main',
    } });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('history.changed'));
    const page = await h.service.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    if (page.status !== 'ok') throw new Error('expected committed Pi history');
    const matching = page.page.items.filter((item) => (
      item.kind === 'message' && item.role === 'user'
      && item.content.some((block) => block.type === 'text' && block.text === 'visible immediately')
    ));
    expect(matching).toHaveLength(1);
    expect(h.service.querySubmission(h.lease, 'request-live')).toEqual({
      status: 'accepted',
    });
    expect(events.filter((event) => (
      event.type === 'item.opened' && event.draft.kind === 'message' && event.draft.role === 'user'
    ))).toHaveLength(1);
  });

  it('restores a pending user from the Connector snapshot across reconnect without duplicating JSONL', async () => {
    const pendingItem = {
      id: 'pi-user:pending', sessionId: 'session-1', status: 'complete', kind: 'message',
      role: 'user', content: [{ type: 'text', text: 'survive reconnect' }],
      sourceCreatedAt: 1_786_492_802_000,
      extensions: { 'pi.pendingClientRequestId': 'request-reconnect' },
    };
    const h = await harness({ snapshot: {
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
      pendingItems: [pendingItem],
    } });
    const { events } = await open(h);
    let page = await h.service.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    if (page.status !== 'ok') throw new Error('expected pending Pi history');
    expect(page.page.items.map((item) => item.id)).toEqual(['pi:entry001', 'pi-user:pending']);

    appendSession(h.file, {
      type: 'message', id: 'entry002', parentId: 'entry001',
      timestamp: '2026-08-12T00:00:02Z',
      message: { role: 'user', content: 'survive reconnect', timestamp: 1_786_492_802_000 },
    });
    await h.channel.setSnapshot({
      sessionId: 'session-1', leafId: 'entry002', viewId: 'branch-main',
      pendingItems: [pendingItem],
    });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('history.changed'));
    page = await h.service.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    if (page.status !== 'ok') throw new Error('expected committed Pi history');
    expect(page.page.items.filter((item) => (
      item.kind === 'message' && item.role === 'user'
      && item.content.some((block) => block.type === 'text' && block.text === 'survive reconnect')
    ))).toHaveLength(1);
    expect(page.page.items.map((item) => item.id)).toEqual(['pi:entry001', 'pi:entry002']);
  });

  it('fails closed when the snapshot is unavailable, invalid, or ahead of durable history', async () => {
    const unavailable = await harness({ withSnapshot: false });
    await expect(unavailable.service.open(unavailable.lease, {}, () => {}))
      .rejects.toThrow(/snapshot is unavailable/i);

    const invalid = await harness({ snapshot: { sessionId: 'another', leafId: 'entry001' } });
    await expect(invalid.service.open(invalid.lease, {}, () => {}))
      .rejects.toThrow(/snapshot is invalid/i);

    const unreadable = await harness({
      snapshot: { sessionId: 'session-1', leafId: 'notready', viewId: 'branch-main' },
    });
    await expect(unreadable.service.open(unreadable.lease, {}, () => {}))
      .rejects.toThrow(/not readable yet/i);
  });

  it('closes on Bridge gaps without colliding with the next Bridge event sequence', async () => {
    const h = await harness();
    const { events } = await open(h);
    const tiny = new LocalAgentBridge({
      runs: h.runtime, adapterIds: ['pi'],
      limits: { maxQueuedEventsPerChannel: 1, burstEvents: 10 },
      newConnectionId: () => 'tiny-connection',
    });
    bridges.push(tiny);
    const tinyConnection = tiny.connect(h.lease);
    const tinyChannel = tinyConnection.channel('conversation');
    await tinyChannel.setSnapshot({
      sessionId: 'session-1', leafId: 'entry001', viewId: 'branch-main',
    });
    const adapter = createPiConversationAdapter({
      host: tiny.hostFor('pi'),
      history: new PiConversationHistory({
        sessionsRoot: path.dirname(h.file), resolveFile: async () => h.file,
      }),
    });
    const service = new ConversationService({ runs: h.runtime, adapters: { pi: adapter } });
    const gapEvents: ConversationEvent[] = [];
    await service.open(h.lease, {}, (event) => { gapEvents.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tinyChannel.publish({ payload: {
      type: 'item.opened', provisionalId: 'first',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    } });
    await tinyChannel.publish({ payload: {
      type: 'item.opened', provisionalId: 'overflow',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    } });
    await tinyChannel.publish({ payload: {
      type: 'item.opened', provisionalId: 'newer',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    } });
    await vi.waitFor(() => expect(gapEvents.some((event) => event.type === 'stream.gap')).toBe(true));
    expect(events).toEqual([]);
  });

  it('stops old callbacks and requests after lease revoke or transport replacement', async () => {
    const h = await harness();
    const { events } = await open(h);
    const oldChannel = h.channel;
    const replacement = h.bridge.connect(h.lease);
    const replacementChannel = replacement.channel('conversation');
    expect(await oldChannel.publish({ payload: {
      type: 'item.opened', provisionalId: 'stale',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    } })).toEqual({ accepted: false, reason: 'stale_lease' });
    await h.controller.revoke(h.lease, 'provider_clear');
    expect(await replacementChannel.publish({ payload: {
      type: 'item.opened', provisionalId: 'revoked',
      draft: { kind: 'message', role: 'assistant', content: [{ type: 'text', text: '' }] },
    } })).toEqual({ accepted: false, reason: 'stale_lease' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);
    expect(await h.service.send(h.lease, {
      clientRequestId: 'stale-request', text: 'no', delivery: 'prompt',
    })).toEqual({ status: 'rejected', reason: 'stale_run', nativeMutation: false });
  });
});
