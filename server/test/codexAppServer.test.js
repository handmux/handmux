import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createCodexAppServer, projectCodexThread } from '../src/codexAppServer.js';

function fixtureThread(status = { type: 'idle' }) {
  return {
    id: 'thread-1', status,
    turns: [{
      id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2,
      items: [
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
        { id: 'agent-1', type: 'agentMessage', text: 'world' },
        { id: 'cmd-1', type: 'commandExecution', command: 'pwd', cwd: '/work', commandActions: [], status: 'completed', aggregatedOutput: '/work\n' },
        { id: 'files-1', type: 'fileChange', status: 'completed', changes: [
          { path: '/work/a.js', kind: { type: 'update' }, diff: '@@\n-old\n+new' },
          { path: '/work/b.js', kind: { type: 'add' }, diff: '@@\n+created' },
        ] },
        { id: 'web-1', type: 'webSearch', query: 'Codex docs', action: { type: 'search', query: 'Codex docs', queries: null }, results: [{ url: 'https://example.com' }] },
        { id: 'mcp-1', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'completed', arguments: { query: 'Codex' }, result: { content: [] }, error: null },
        { id: 'dynamic-1', type: 'dynamicToolCall', namespace: null, tool: 'custom', arguments: { value: 1 }, status: 'completed', contentItems: [{ type: 'inputText', text: 'done' }], success: true },
        { id: 'image-1', type: 'imageView', path: '/work/screenshot.png' },
        { id: 'sleep-1', type: 'sleep', durationMs: 1000 },
        { id: 'collab-1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: 'thread-1', receiverThreadIds: ['thread-2'], prompt: 'review', model: null, reasoningEffort: null, agentsStates: { 'thread-2': { status: 'completed' } } },
        { id: 'generated-1', type: 'imageGeneration', status: 'completed', revisedPrompt: 'a diagram', result: 'done', savedPath: '/work/generated.png' },
        { id: 'compact-1', type: 'contextCompaction' },
      ],
    }],
  };
}

function fakeProxy({ empty = false, loaded = ['thread-1'], updatedAt = {}, status = { type: 'idle' } } = {}) {
  const ws = new EventEmitter();
  ws.readyState = 0;
  const sent = [];
  let persisted = !empty;
  const reply = (message) => queueMicrotask(() => ws.emit('message', Buffer.from(JSON.stringify(message))));
  ws.send = (data) => {
    const message = JSON.parse(data);
    sent.push(message);
    if (message.id == null) return;
    if (message.method === 'initialize') reply({ jsonrpc: '2.0', id: message.id, result: {} });
    else if (message.method === 'thread/loaded/list') {
      reply({ jsonrpc: '2.0', id: message.id, result: { data: loaded, nextCursor: null } });
    } else if (message.method === 'thread/resume') {
      if (!persisted) reply({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'no rollout found for thread id thread-1' } });
      else reply({ jsonrpc: '2.0', id: message.id, result: {
        thread: { ...fixtureThread(status), id: message.params.threadId, updatedAt: updatedAt[message.params.threadId] },
        model: 'gpt-test', modelProvider: 'openai', serviceTier: null, cwd: '/work', approvalPolicy: 'on-request',
        approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' }, activePermissionProfile: null,
        reasoningEffort: 'high', multiAgentMode: 'explicitRequestOnly',
      } });
    } else if (message.method === 'thread/read') {
      reply({ jsonrpc: '2.0', id: message.id, result: { thread: { ...fixtureThread(), id: message.params.threadId, updatedAt: updatedAt[message.params.threadId] } } });
    } else if (message.method === 'turn/start') {
      persisted = true;
      reply({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-2', status: 'inProgress', items: [] } } });
    } else if (message.method === 'thread/compact/start') {
      reply({ jsonrpc: '2.0', id: message.id, result: {} });
    } else if (message.method === 'model/list') {
      reply({ jsonrpc: '2.0', id: message.id, result: { data: [{ id: 'model-1', model: 'gpt-test', displayName: 'GPT Test', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }], defaultReasoningEffort: 'medium' }], nextCursor: null } });
    } else if (message.method === 'thread/settings/update') {
      reply({ jsonrpc: '2.0', id: message.id, result: {} });
    } else if (message.method === 'turn/interrupt') {
      reply({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  };
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  queueMicrotask(() => { ws.readyState = 1; ws.emit('open'); });
  return { ws, sent, push: (message) => reply(message) };
}

describe('Codex App Server projection', () => {
  it('projects authoritative items into the existing chat contract', () => {
    const messages = projectCodexThread(fixtureThread());
    expect(messages.map((message) => message.type)).toEqual([
      'text', 'text', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'compact',
    ]);
    expect(messages[0]).toMatchObject({ k: 0, role: 'user', text: 'hello' });
    expect(messages[2].tool).toMatchObject({ name: 'exec_command', result: '/work\n', isError: false });
    expect(messages.slice(3, 5).map((message) => message.tool.input.file_path)).toEqual(['/work/a.js', '/work/b.js']);
    expect(messages.slice(5, 12).map((message) => message.tool.name)).toEqual([
      'web__run', 'docs:search', 'custom', 'view_image', 'wait', 'spawn_agent', 'image_gen__imagegen',
    ]);
    expect(messages[5].tool.result).toContain('https://example.com');
    expect(messages[10].tool.input).toMatchObject({ target: 'thread-2', prompt: 'review' });
  });

  it('keeps interrupted turns as a visible structural marker', () => {
    const thread = fixtureThread();
    thread.turns[0].status = 'interrupted';
    expect(projectCodexThread(thread).at(-1).type).toBe('interrupt');
  });
});

describe('Codex App Server client', () => {
  it('discovers and sends the first message to a loaded thread before its rollout exists', async () => {
    const proxy = fakeProxy({ empty: true });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.discover('%1')).toEqual({ managed: true, threadId: 'thread-1' });
    expect(await app.status('%1', 'thread-1')).toMatchObject({ managed: true, status: { type: 'idle' } });
    await app.send('%1', 'thread-1', 'first message');
    expect(proxy.sent.filter((message) => message.method === 'thread/resume').length).toBeGreaterThanOrEqual(2);
    expect(proxy.sent).toContainEqual(expect.objectContaining({ method: 'turn/start' }));
    app.close();
  });

  it('resumes the exact thread, sends turns, and resolves a structured approval once', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws,
    });
    expect(await app.status('%1', 'thread-1')).toMatchObject({ managed: true, threadId: 'thread-1' });
    expect(await app.status('%1', 'thread-1')).toMatchObject({ settings: { model: 'gpt-test', effort: 'high' } });
    await app.send('%1', 'thread-1', 'continue');
    expect(proxy.sent).toContainEqual(expect.objectContaining({ method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'text', text: 'continue' }] } }));

    proxy.push({
      jsonrpc: '2.0', id: 91, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'cmd-2', command: 'npm test', cwd: '/work', startedAtMs: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = await app.status('%1', 'thread-1');
    expect(pending.approvals[0]).toMatchObject({ id: '91', type: 'command', command: 'npm test' });
    await app.decide('%1', 'thread-1', '91', 'accept');
    expect(proxy.sent).toContainEqual({ jsonrpc: '2.0', id: 91, result: { decision: 'accept' } });
    expect((await app.status('%1', 'thread-1')).approvals).toEqual([]);
    app.close();
  });

  it('lists official models and updates model and effort on the current thread', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.models('%1', 'thread-1')).toEqual([
      expect.objectContaining({ model: 'gpt-test', defaultReasoningEffort: 'medium' }),
    ]);
    expect(await app.updateSettings('%1', 'thread-1', { model: 'gpt-new', effort: 'high' }))
      .toMatchObject({ model: 'gpt-new', effort: 'high' });
    expect(proxy.sent).toContainEqual(expect.objectContaining({
      method: 'thread/settings/update', params: { threadId: 'thread-1', model: 'gpt-new', effort: 'high' },
    }));
    app.close();
  });

  it('chooses the newest loaded thread after a server restart', async () => {
    const proxy = fakeProxy({ loaded: ['thread-old', 'thread-new'], updatedAt: { 'thread-old': 10, 'thread-new': 20 } });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect(await app.discover('%1')).toEqual({ managed: true, threadId: 'thread-new' });
    expect(proxy.sent).toContainEqual(expect.objectContaining({ method: 'thread/read', params: { threadId: 'thread-new', includeTurns: false } }));
    app.close();
  });

  it('projects turn and approval events into one authoritative inbox state', async () => {
    let ts = 100;
    const changed = [];
    const proxy = fakeProxy();
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws,
      now: () => ++ts, onStateChange: (pane) => changed.push(pane),
    });
    await app.discover('%1');
    changed.length = 0;
    proxy.push({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-2' } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'working' });

    proxy.push({ jsonrpc: '2.0', id: 91, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'npm test' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'permission', msg: 'npm test' });

    proxy.push({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', items: [{ type: 'agentMessage', text: 'all green' }] } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'done', msg: 'all green' });
    expect(changed).toEqual(['%1', '%1', '%1']);
    app.close();
  });

  it('switches discovery to the new thread announced by /clear', async () => {
    const proxy = fakeProxy({ loaded: ['thread-1', 'thread-2'], updatedAt: { 'thread-1': 20, 'thread-2': 10 } });
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    expect((await app.discover('%1')).threadId).toBe('thread-1');
    proxy.push({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'thread-2' } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.discover('%1')).threadId).toBe('thread-2');
    app.close();
  });

  it('marks an active startup snapshot as a no-replay push baseline', async () => {
    const proxy = fakeProxy({ status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, readdir: () => ['1.sock'], connect: () => proxy.ws,
      setTimer: () => ({ unref() {} }), clearTimer: () => {},
    });
    app.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = (await app.inboxStates([{ id: '%1' }]))['%1'];
    expect(state).toMatchObject({ kind: 'permission', suppressPush: true });
    app.close();
  });

  it('restores the last completion with its stable timestamp without replaying its push', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, readdir: () => ['1.sock'], connect: () => proxy.ws,
      setTimer: () => ({ unref() {} }), clearTimer: () => {},
    });
    app.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.inboxStates([{ id: '%1' }]))['%1']).toMatchObject({ kind: 'done', ts: 2000, suppressPush: true });
    app.close();
  });

  it('keeps compaction distinct from a normal working turn until it settles', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({ home: '/home/test', exists: () => true, connect: () => proxy.ws });
    await app.compact('%1', 'thread-1');
    expect(await app.status('%1', 'thread-1')).toMatchObject({ activityKind: 'compacting' });
    proxy.push({ jsonrpc: '2.0', method: 'thread/status/changed', params: { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.status('%1', 'thread-1')).toMatchObject({ activityKind: 'compacting' });
    proxy.push({ jsonrpc: '2.0', method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 'turn-2' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await app.status('%1', 'thread-1')).toMatchObject({ activityKind: null });
    app.close();
  });
});
