import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationService } from '../src/agent-runtime/conversation.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';
import {
  createClaudeConversationAdapter,
  findClaudeSessionFile,
} from '../src/agents/claudeConversation.js';
import { sendPanePrompt, serializePaneInput } from '../src/paneInput.js';
import type { TranscriptMessage } from '../src/transcriptParse.js';
import type { TranscriptReader } from '../src/transcriptReader.js';

const SESSION = '4442e3d0-8d46-4cce-9822-b86558f69922';
const directories: string[] = [];

function directory(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-claude-conversation-'));
  directories.push(value);
  return value;
}

function fakeReader(messages: TranscriptMessage[]): TranscriptReader {
  return {
    read: vi.fn(async () => messages) as TranscriptReader['read'],
    clear: vi.fn(),
    size: () => 1,
  };
}

function sessionFile(root: string, project = '-tmp-project'): string {
  const dir = path.join(root, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, '{}\n');
  return file;
}

async function controlledClaude(
  messages: TranscriptMessage[],
  runId: string,
): Promise<{
  service: ConversationService;
  lease: Awaited<ReturnType<ReturnType<AgentRunRuntime['controller']>['attach']>>;
  setCompletion(token: string): void;
}> {
  const root = directory();
  const file = sessionFile(root);
  const runtime = new AgentRunRuntime({ newRunId: () => runId });
  const lease = await runtime.controller('claude', async () => true).attach({
    paneId: `%${runId}`, attachmentId: 'claude-hooks', sessionId: SESSION, process: { pid: 120 },
  });
  let completionToken = 'completed:0';
  const adapter = createClaudeConversationAdapter({
    projectsRoot: root,
    sessions: { paneSession: () => ({ sessionId: SESSION, transcriptPath: file, agent: 'claude' }) },
    reader: fakeReader(messages),
    control: { sendPrompt: vi.fn(async () => {}), interrupt: vi.fn(async () => {}) },
  });
  const service = new ConversationService({
    runs: runtime, adapters: { claude: adapter },
    activitySource: { read: async () => ({
      activity: 'idle', activeTurn: { state: 'none' }, revision: 1,
      epoch: runId, completionToken,
    }) },
  });
  return { service, lease, setCompletion(token) { completionToken = token; } };
}

afterEach(() => {
  for (const value of directories.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe('Claude Conversation adapter', () => {
  it('keeps the latest canonical frontier when older history is paged before send', async () => {
    const messages: TranscriptMessage[] = [
      { i: 0, type: 'text', role: 'user', text: 'old', ts: '2026-08-12T00:00:00Z' },
      { i: 1, type: 'text', role: 'assistant', text: 'middle', ts: '2026-08-12T00:00:01Z' },
      { i: 2, type: 'text', role: 'assistant', text: 'latest', ts: '2026-08-12T00:00:02Z' },
    ];
    const h = await controlledClaude(messages, 'run-page-frontier');
    const latest = await h.service.readPage({ agentId: 'claude', sessionId: SESSION }, { limit: 2 });
    if (latest.status !== 'ok' || !latest.page.previousCursor) throw new Error('expected latest cursor');
    await h.service.readPage(
      { agentId: 'claude', sessionId: SESSION },
      { limit: 2, before: latest.page.previousCursor },
    );
    await h.service.send(h.lease, {
      clientRequestId: 'request-new', text: 'new prompt', delivery: 'prompt',
    });
    messages.push({
      i: 3, type: 'text', role: 'user', text: 'new prompt', ts: '2026-08-12T00:00:03Z',
    });
    await h.service.readPage({ agentId: 'claude', sessionId: SESSION }, { limit: 2 });
    expect(h.service.querySubmission(h.lease, 'request-new')).toEqual({
      status: 'accepted', nativeId: expect.any(String),
    });
  });

  it('does not claim a same-text user item from an older page', async () => {
    const messages: TranscriptMessage[] = [
      { i: 0, type: 'text', role: 'user', text: 'repeat', ts: '2026-08-12T00:00:00Z' },
      { i: 1, type: 'text', role: 'assistant', text: 'middle', ts: '2026-08-12T00:00:01Z' },
      { i: 2, type: 'text', role: 'assistant', text: 'latest', ts: '2026-08-12T00:00:02Z' },
    ];
    const h = await controlledClaude(messages, 'run-older-text');
    const latest = await h.service.readPage({ agentId: 'claude', sessionId: SESSION }, { limit: 2 });
    if (latest.status !== 'ok' || !latest.page.previousCursor) throw new Error('expected latest cursor');
    await h.service.send(h.lease, {
      clientRequestId: 'request-repeat', text: 'repeat', delivery: 'prompt',
    });
    await h.service.readPage(
      { agentId: 'claude', sessionId: SESSION },
      { limit: 2, before: latest.page.previousCursor },
    );
    expect(h.service.querySubmission(h.lease, 'request-repeat')).toEqual({ status: 'accepted' });
  });

  it('claims consecutive same-text Claude messages one-to-one', async () => {
    const messages: TranscriptMessage[] = [
      { i: 0, type: 'text', role: 'assistant', text: 'ready', ts: '2026-08-12T00:00:00Z' },
    ];
    const h = await controlledClaude(messages, 'run-same-text');
    await h.service.readPage({ agentId: 'claude', sessionId: SESSION }, { limit: 20 });
    await h.service.send(h.lease, {
      clientRequestId: 'request-1', text: 'repeat', delivery: 'prompt',
    });
    messages.push({
      i: 1, type: 'text', role: 'user', text: 'repeat', ts: '2026-08-12T00:00:01Z',
    });
    await h.service.readPage({ agentId: 'claude', sessionId: SESSION }, { limit: 20 });
    const first = h.service.querySubmission(h.lease, 'request-1');
    expect(first).toEqual({
      status: 'accepted', nativeId: expect.any(String),
    });
    h.setCompletion('completed:1');
    await h.service.queueSnapshot(h.lease);
    await h.service.send(h.lease, {
      clientRequestId: 'request-2', text: 'repeat', delivery: 'prompt',
    });
    const settled = (await h.service.queueSnapshot(h.lease)).settled;
    expect(settled).toEqual([
      { id: 'request-2' },
      { id: 'request-1', nativeId: expect.any(String) },
    ]);
    messages.push({
      i: 2, type: 'text', role: 'user', text: 'repeat', ts: '2026-08-12T00:00:02Z',
    });
    await h.service.readPage({ agentId: 'claude', sessionId: SESSION }, { limit: 20 });
    const second = h.service.querySubmission(h.lease, 'request-2');
    expect(second).toEqual({
      status: 'accepted', nativeId: expect.any(String),
    });
    expect(first.nativeId).not.toBe(second.nativeId);
  });

  it('exposes send/interrupt only for a controlled live run and delegates exact pane operations', async () => {
    const root = directory();
    const file = sessionFile(root);
    const runtime = new AgentRunRuntime({ newRunId: () => 'run-control' });
    const lease = await runtime.controller('claude', async () => true).attach({
      paneId: '%7', attachmentId: 'claude-hooks', sessionId: SESSION, process: { pid: 107 },
    });
    const control = { sendPrompt: vi.fn(async () => {}), interrupt: vi.fn(async () => {}) };
    const adapter = createClaudeConversationAdapter({
      projectsRoot: root,
      sessions: { paneSession: () => ({ sessionId: SESSION, transcriptPath: file, agent: 'claude' }) },
      reader: fakeReader([]), control,
    });

    expect(await adapter.discoverNative(lease.ref)).toMatchObject({
      capabilities: { history: true, live: 'settled', sendable: true, send: ['prompt'], interrupt: true },
    });
    await expect(adapter.dispatchPrompt?.(lease, {
      clientRequestId: 'send-1', text: 'exact prompt',
    })).resolves.toEqual({ outcome: 'accepted' });
    await expect(adapter.dispatchInterrupt?.(lease)).resolves.toEqual({ status: 'accepted' });
    expect(control.sendPrompt).toHaveBeenCalledWith('%7', 'exact prompt');
    expect(control.interrupt).toHaveBeenCalledWith('%7');
  });

  it('does not dispatch a Claude prompt when activity becomes busy before the native call', async () => {
    const root = directory();
    const file = sessionFile(root);
    const runtime = new AgentRunRuntime({ newRunId: () => 'run-busy-race' });
    const lease = await runtime.controller('claude', async () => true).attach({
      paneId: '%9', attachmentId: 'claude-hooks', sessionId: SESSION, process: { pid: 109 },
    });
    const control = { sendPrompt: vi.fn(async () => {}), interrupt: vi.fn(async () => {}) };
    const adapter = createClaudeConversationAdapter({
      projectsRoot: root,
      sessions: { paneSession: () => ({ sessionId: SESSION, transcriptPath: file, agent: 'claude' }) },
      reader: fakeReader([]), control,
    });
    const snapshots = [{
      activity: 'idle' as const, activeTurn: { state: 'none' as const },
      revision: 1, epoch: 'run-busy-race',
    }, {
      activity: 'working' as const,
      activeTurn: { state: 'active' as const, nativeTurnId: 'external-turn' },
      revision: 2, epoch: 'run-busy-race',
    }];
    const service = new ConversationService({
      runs: runtime, adapters: { claude: adapter },
      activitySource: { read: async () => structuredClone(snapshots.shift() ?? snapshots.at(-1) ?? {
        activity: 'working' as const,
        activeTurn: { state: 'active' as const, nativeTurnId: 'external-turn' },
        revision: 2, epoch: 'run-busy-race',
      }) },
    });

    expect(await service.send(lease, {
      clientRequestId: 'request-1', text: 'do not race', delivery: 'prompt',
    })).toMatchObject({ status: 'queued', nativeMutation: false });
    expect(control.sendPrompt).not.toHaveBeenCalled();
  });

  it('rechecks the planned activity generation inside the pane lock before writing', async () => {
    const root = directory();
    const file = sessionFile(root);
    const runtime = new AgentRunRuntime({ newRunId: () => 'run-native-busy-race' });
    const lease = await runtime.controller('claude', async () => true).attach({
      paneId: '%native-busy', attachmentId: 'claude-hooks', sessionId: SESSION, process: { pid: 111 },
    });
    let activity = 'idle' as 'idle' | 'working';
    let revision = 1;
    let releasePane!: () => void;
    let paneLocked!: () => void;
    const paneGate = new Promise<void>((resolve) => { releasePane = resolve; });
    const locked = new Promise<void>((resolve) => { paneLocked = resolve; });
    const blocker = serializePaneInput(lease.ref.paneId, async () => {
      paneLocked();
      await paneGate;
    });
    await locked;
    let controlEntered!: () => void;
    const entered = new Promise<void>((resolve) => { controlEntered = resolve; });
    const commands = {
      exitCopyModeIfActive: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
      sendEnter: vi.fn(async () => {}),
      sendKey: vi.fn(async () => {}),
    };
    const control = {
      sendPrompt: vi.fn(async (...args: unknown[]) => {
        controlEntered();
        return Reflect.apply(sendPanePrompt, undefined, [commands, ...args]);
      }),
      interrupt: vi.fn(async () => {}),
    };
    const adapter = createClaudeConversationAdapter({
      projectsRoot: root,
      sessions: { paneSession: () => ({ sessionId: SESSION, transcriptPath: file, agent: 'claude' }) },
      reader: fakeReader([]), control,
    });
    const service = new ConversationService({
      runs: runtime, adapters: { claude: adapter },
      activitySource: { read: async () => ({
        activity,
        activeTurn: activity === 'idle'
          ? { state: 'none' as const }
          : { state: 'active' as const, nativeTurnId: 'external-turn' },
        revision, epoch: lease.ref.runId,
      }) },
    });

    const sending = service.send(lease, {
      clientRequestId: 'request-native-busy', text: 'must stay queued', delivery: 'prompt',
    });
    await entered;
    activity = 'working';
    revision += 1;
    releasePane();

    await expect(sending).resolves.toMatchObject({ status: 'queued', nativeMutation: false });
    await blocker;
    expect(commands.exitCopyModeIfActive).not.toHaveBeenCalled();
    expect(commands.sendText).not.toHaveBeenCalled();
    expect(commands.sendEnter).not.toHaveBeenCalled();
  });

  it('writes a Claude prompt exactly once when the run and idle generation still match', async () => {
    const root = directory();
    const file = sessionFile(root);
    const runtime = new AgentRunRuntime({ newRunId: () => 'run-native-idle' });
    const lease = await runtime.controller('claude', async () => true).attach({
      paneId: '%native-idle', attachmentId: 'claude-hooks', sessionId: SESSION, process: { pid: 112 },
    });
    const commands = {
      exitCopyModeIfActive: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
      sendEnter: vi.fn(async () => {}),
      sendKey: vi.fn(async () => {}),
    };
    const control = {
      sendPrompt: vi.fn(async (...args: unknown[]) => (
        Reflect.apply(sendPanePrompt, undefined, [commands, ...args])
      )),
      interrupt: vi.fn(async () => {}),
    };
    const adapter = createClaudeConversationAdapter({
      projectsRoot: root,
      sessions: { paneSession: () => ({ sessionId: SESSION, transcriptPath: file, agent: 'claude' }) },
      reader: fakeReader([]), control,
    });
    const service = new ConversationService({
      runs: runtime, adapters: { claude: adapter },
      activitySource: { read: async () => ({
        activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: lease.ref.runId,
      }) },
    });

    await expect(service.send(lease, {
      clientRequestId: 'request-native-idle', text: 'write once', delivery: 'prompt',
    })).resolves.toMatchObject({ status: 'accepted' });
    expect(commands.exitCopyModeIfActive).toHaveBeenCalledTimes(1);
    expect(commands.sendText).toHaveBeenCalledTimes(1);
    expect(commands.sendText).toHaveBeenCalledWith(lease.ref.paneId, 'write once');
    expect(commands.sendEnter).toHaveBeenCalledTimes(1);
  });

  it('does not write an old Claude plan after the run is replaced', async () => {
    const root = directory();
    const file = sessionFile(root);
    const runIds = ['run-native-old', 'run-native-new'];
    const runtime = new AgentRunRuntime({ newRunId: () => runIds.shift() ?? 'unexpected-run' });
    const controller = runtime.controller('claude', async () => true);
    const lease = await controller.attach({
      paneId: '%native-replaced', attachmentId: 'claude-hooks-old', sessionId: SESSION,
      process: { pid: 113 },
    });
    let releasePane!: () => void;
    let paneLocked!: () => void;
    const paneGate = new Promise<void>((resolve) => { releasePane = resolve; });
    const locked = new Promise<void>((resolve) => { paneLocked = resolve; });
    const blocker = serializePaneInput(lease.ref.paneId, async () => {
      paneLocked();
      await paneGate;
    });
    await locked;
    let controlEntered!: () => void;
    let controlSettled!: () => void;
    const entered = new Promise<void>((resolve) => { controlEntered = resolve; });
    const settled = new Promise<void>((resolve) => { controlSettled = resolve; });
    const commands = {
      exitCopyModeIfActive: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
      sendEnter: vi.fn(async () => {}),
      sendKey: vi.fn(async () => {}),
    };
    const control = {
      sendPrompt: vi.fn(async (...args: unknown[]) => {
        controlEntered();
        try {
          return await Reflect.apply(sendPanePrompt, undefined, [commands, ...args]);
        } finally { controlSettled(); }
      }),
      interrupt: vi.fn(async () => {}),
    };
    const adapter = createClaudeConversationAdapter({
      projectsRoot: root,
      sessions: { paneSession: () => ({ sessionId: SESSION, transcriptPath: file, agent: 'claude' }) },
      reader: fakeReader([]), control,
    });
    const service = new ConversationService({
      runs: runtime, adapters: { claude: adapter },
      activitySource: { read: async (current) => ({
        activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: current.ref.runId,
      }) },
    });

    const sending = service.send(lease, {
      clientRequestId: 'request-native-replaced', text: 'obsolete plan', delivery: 'prompt',
    });
    await entered;
    await controller.replace(lease, {
      paneId: lease.ref.paneId, attachmentId: 'claude-hooks-new', sessionId: SESSION,
      process: { pid: 114 },
    }, 'session_replaced');
    releasePane();

    await sending;
    await settled;
    await blocker;
    expect(commands.exitCopyModeIfActive).not.toHaveBeenCalled();
    expect(commands.sendText).not.toHaveBeenCalled();
    expect(commands.sendEnter).not.toHaveBeenCalled();
  });

  it('claims the first new same-text Claude occurrence after the dispatch baseline', async () => {
    const root = directory();
    const file = sessionFile(root);
    const messages: TranscriptMessage[] = [
      { i: 0, type: 'text', role: 'user', text: 'repeat', ts: '2026-08-12T00:00:00Z' },
      { i: 1, type: 'text', role: 'assistant', text: 'old answer', ts: '2026-08-12T00:00:01Z' },
    ];
    const runtime = new AgentRunRuntime({ newRunId: () => 'run-occurrence' });
    const lease = await runtime.controller('claude', async () => true).attach({
      paneId: '%10', attachmentId: 'claude-hooks', sessionId: SESSION, process: { pid: 110 },
    });
    const adapter = createClaudeConversationAdapter({
      projectsRoot: root,
      sessions: { paneSession: () => ({ sessionId: SESSION, transcriptPath: file, agent: 'claude' }) },
      reader: fakeReader(messages),
      control: { sendPrompt: vi.fn(async () => {}), interrupt: vi.fn(async () => {}) },
    });
    const service = new ConversationService({
      runs: runtime, adapters: { claude: adapter },
      activitySource: { read: async () => ({
        activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: 'run-occurrence',
      }) },
    });
    const baseline = await service.readPage({ agentId: 'claude', sessionId: SESSION }, { limit: 20 });
    if (baseline.status !== 'ok') throw new Error('expected Claude baseline');
    const oldUserId = baseline.page.items.find((item) => item.kind === 'message'
      && item.role === 'user')?.id;
    await service.send(lease, {
      clientRequestId: 'request-repeat', text: 'repeat', delivery: 'prompt',
    });
    messages.push({
      i: 2, type: 'text', role: 'user', text: 'repeat', ts: '2026-08-12T00:00:02Z',
    });
    const current = await service.readPage({ agentId: 'claude', sessionId: SESSION }, { limit: 20 });
    if (current.status !== 'ok') throw new Error('expected Claude page');
    const userIds = current.page.items.filter((item) => item.kind === 'message'
      && item.role === 'user').map((item) => item.id);
    expect(userIds).toHaveLength(2);
    expect(service.querySubmission(lease, 'request-repeat')).toEqual({
      status: 'accepted', nativeId: userIds[1],
    });
    expect(userIds[1]).not.toBe(oldUserId);
  });

  it('does not lose a transcript change between observation baseline and the first poll', async () => {
    const root = directory();
    const file = sessionFile(root);
    const messages: TranscriptMessage[] = [];
    const runtime = new AgentRunRuntime({ newRunId: () => 'run-race' });
    const lease = await runtime.controller('claude', async () => true).attach({
      paneId: '%8', attachmentId: 'claude-hooks', sessionId: SESSION, process: { pid: 108 },
    });
    const adapter = createClaudeConversationAdapter({
      projectsRoot: root,
      sessions: { paneSession: () => ({ sessionId: SESSION, transcriptPath: file, agent: 'claude' }) },
      reader: fakeReader(messages),
      control: { sendPrompt: vi.fn(async () => {}), interrupt: vi.fn(async () => {}) },
      livePollMs: 5,
    });
    const events: unknown[] = [];
    const handle = await adapter.observeNative?.(lease, (event) => { events.push(event); });
    expect(handle?.checkpoint.sourceSequence).toBe(0);

    messages.push({
      i: 0, type: 'text', role: 'user', text: 'arrived during open',
      ts: '2026-08-29T10:00:00Z',
    });
    const openingPage = await adapter.readNativePage(
      { agentId: 'claude', sessionId: SESSION }, { limit: 20 },
    );
    expect(openingPage.items).toHaveLength(1);
    await vi.waitFor(() => expect(events).toEqual([expect.objectContaining({
      type: 'history.committed', sourceSequence: 1,
    })]));
    await handle?.close();
  });

  it('projects bounded useful tool input without raw thinking, secrets, or transcript paths', async () => {
    const root = directory();
    const file = sessionFile(root);
    const reader = fakeReader([
      { i: 0, type: 'text', role: 'user', text: 'question', ts: '2026-08-12T00:00:00Z' },
      { i: 1, type: 'thinking', role: 'assistant', text: 'hidden chain of thought', ts: undefined },
      {
        i: 2, type: 'tool', role: 'assistant', ts: undefined,
        tool: {
          name: 'Edit', input: {
            file_path: 'src/app.ts', instruction: 'Replace the old value', token_budget: 4_096,
            secret: 'snake-secret', apiKey: 'api-secret', accessToken: 'access-secret',
            authToken: 'auth-secret', privateKey: 'private-secret', clientSecret: 'client-secret',
            filePath: '/Users/private/project/app.ts', workingDirectory: '/Users/private/project',
            projectRoot: '/Users/private',
          },
          result: 'updated', isError: false,
          diff: { added: 1, removed: 1, hunks: [{ oldStart: 1, newStart: 1, lines: ['-old', '+new'] }] },
        },
      },
      { i: 3, type: 'compact', summary: 'retained Claude summary', ts: undefined },
      { i: 4, type: 'interrupt', ts: undefined },
      { i: 5, type: 'slash', name: '/model', args: 'sonnet', result: '/Users/private', ts: undefined },
    ]);
    const adapter = createClaudeConversationAdapter({ projectsRoot: root, reader });
    const runtime = new AgentRunRuntime();
    const service = new ConversationService({ runs: runtime, adapters: { claude: adapter } });

    const descriptor = await service.discover({ agentId: 'claude', sessionId: SESSION });
    expect(descriptor?.capabilities).toEqual({ history: true, live: 'poll' });
    const result = await service.readPage({ agentId: 'claude', sessionId: SESSION }, { limit: 20 });
    if (result.status !== 'ok') throw new Error('expected history');
    expect(result.page.items.map((item) => item.kind)).toEqual([
      'message', 'tool_call', 'tool_result', 'diff', 'compaction', 'interrupt', 'notice',
    ]);
    expect(result.page.items.find((item) => item.kind === 'diff')).toMatchObject({
      path: 'src/app.ts', summary: '+1 -1', patch: '-old\n+new',
    });
    expect(result.page.items.find((item) => item.kind === 'tool_call')).toMatchObject({
      status: 'complete',
      input: {
        file_path: 'src/app.ts', instruction: 'Replace the old value', token_budget: 4_096,
      },
    });
    expect(result.page.items.find((item) => item.kind === 'tool_call'))
      .not.toHaveProperty('truncation');
    expect(result.page.items.find((item) => item.kind === 'compaction')).toMatchObject({
      summary: 'retained Claude summary',
    });
    const serialized = JSON.stringify({ descriptor, page: result.page });
    expect(serialized).not.toContain('hidden chain of thought');
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('snake-secret');
    expect(serialized).not.toContain('api-secret');
    expect(serialized).not.toContain('access-secret');
    expect(serialized).not.toContain('auth-secret');
    expect(serialized).not.toContain('private-secret');
    expect(serialized).not.toContain('client-secret');
    expect(serialized).not.toContain(file);
  });

  it('binds a live run only to the exact Hook session and controlled transcript path', async () => {
    const root = directory();
    const file = sessionFile(root);
    const runtime = new AgentRunRuntime({ newRunId: () => 'run-1' });
    const lease = await runtime.controller('claude', async () => true).attach({
      paneId: '%1', attachmentId: 'claude-hooks', sessionId: SESSION, process: { pid: 101 },
    });
    const paneSession = vi.fn(() => ({ sessionId: SESSION, transcriptPath: file, agent: 'claude' }));
    const adapter = createClaudeConversationAdapter({
      projectsRoot: root, sessions: { paneSession }, reader: fakeReader([]),
    });
    const service = new ConversationService({ runs: runtime, adapters: { claude: adapter } });

    expect(await service.discover(lease.ref)).toMatchObject({
      run: lease.ref, capabilities: { history: true, live: 'poll' },
    });
    expect(paneSession).toHaveBeenCalledWith('%1');

    paneSession.mockReturnValueOnce({
      sessionId: '11111111-1111-4111-8111-111111111111', transcriptPath: file, agent: 'claude',
    });
    expect(await service.discover(lease.ref)).toBeNull();

    paneSession.mockReturnValueOnce({
      sessionId: SESSION, transcriptPath: path.join(directory(), `${SESSION}.jsonl`), agent: 'claude',
    });
    expect(await service.discover(lease.ref)).toBeNull();
  });

  it('omits empty tool results and marks oversized diffs as truncated', async () => {
    const root = directory();
    sessionFile(root);
    const hugeLine = `+${'x'.repeat(300 * 1024)}`;
    const reader = fakeReader([{
      i: 0, type: 'tool', role: 'assistant', ts: undefined,
      tool: {
        name: 'Edit', input: { file_path: 'src/app.ts' }, result: '', isError: false,
        diff: { added: 1, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: [hugeLine] }] },
      },
    }]);
    const service = new ConversationService({
      runs: new AgentRunRuntime(),
      adapters: { claude: createClaudeConversationAdapter({ projectsRoot: root, reader }) },
    });
    const result = await service.readPage({ agentId: 'claude', sessionId: SESSION }, { limit: 10 });
    if (result.status !== 'ok') throw new Error('expected history');
    expect(result.page.items.map((item) => item.kind)).toEqual(['tool_call', 'diff']);
    expect(result.page.items[1]).toMatchObject({
      kind: 'diff', path: 'src/app.ts', status: 'truncated',
      truncation: { reason: 'size_limit', originalBytes: Buffer.byteLength(hugeLine) },
    });
  });

  it('fails closed for missing, invalid, or ambiguous session identity', async () => {
    const root = directory();
    expect(await findClaudeSessionFile(root, '../escape')).toBeNull();
    expect(await findClaudeSessionFile(root, SESSION)).toBeNull();
    sessionFile(root, 'project-a');
    expect(await findClaudeSessionFile(root, SESSION)).toContain('project-a');
    sessionFile(root, 'project-b');
    expect(await findClaudeSessionFile(root, SESSION)).toBeNull();
  });

  it('paginates flattened durable items with stable opaque Core cursors', async () => {
    const root = directory();
    sessionFile(root);
    const reader = fakeReader([
      { i: 0, type: 'text', role: 'user', text: 'one', ts: undefined },
      { i: 1, type: 'text', role: 'assistant', text: 'two', ts: undefined },
      { i: 2, type: 'text', role: 'user', text: 'three', ts: undefined },
    ]);
    const service = new ConversationService({
      runs: new AgentRunRuntime(),
      adapters: { claude: createClaudeConversationAdapter({ projectsRoot: root, reader }) },
    });
    const latest = await service.readPage({ agentId: 'claude', sessionId: SESSION }, { limit: 2 });
    if (latest.status !== 'ok') throw new Error('expected history');
    expect(latest.page.items.map((item) => item.kind === 'message'
      ? item.content[0] : null)).toEqual([
      { type: 'text', text: 'two' }, { type: 'text', text: 'three' },
    ]);
    expect(latest.page.hasMore).toBe(true);
    expect(latest.page.previousCursor).toBeDefined();
    const older = await service.readPage(
      { agentId: 'claude', sessionId: SESSION },
      { limit: 2, before: latest.page.previousCursor! },
    );
    if (older.status !== 'ok') throw new Error('expected older history');
    expect(older.page.items).toHaveLength(1);
  });
});
