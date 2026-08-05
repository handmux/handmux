import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createCodexAppServer, projectCodexThread } from '../src/codexAppServer.js';

function fixtureThread(status = { type: 'idle' }) {
  return {
    id: 'thread-1', status,
    turns: [{
      id: 'turn-1', status: 'completed', startedAt: 1,
      items: [
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
        { id: 'agent-1', type: 'agentMessage', text: 'world' },
        { id: 'cmd-1', type: 'commandExecution', command: 'pwd', cwd: '/work', commandActions: [], status: 'completed', aggregatedOutput: '/work\n' },
        { id: 'files-1', type: 'fileChange', status: 'completed', changes: [
          { path: '/work/a.js', kind: { type: 'update' }, diff: '@@\n-old\n+new' },
          { path: '/work/b.js', kind: { type: 'add' }, diff: '@@\n+created' },
        ] },
        { id: 'compact-1', type: 'contextCompaction' },
      ],
    }],
  };
}

function fakeProxy({ empty = false } = {}) {
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
      reply({ jsonrpc: '2.0', id: message.id, result: { data: ['thread-1'], nextCursor: null } });
    } else if (message.method === 'thread/resume') {
      if (!persisted) reply({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'no rollout found for thread id thread-1' } });
      else reply({ jsonrpc: '2.0', id: message.id, result: { thread: fixtureThread() } });
    } else if (message.method === 'thread/read') {
      reply({ jsonrpc: '2.0', id: message.id, result: { thread: fixtureThread() } });
    } else if (message.method === 'turn/start') {
      persisted = true;
      reply({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-2', status: 'inProgress', items: [] } } });
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
    expect(messages.map((message) => message.type)).toEqual(['text', 'text', 'tool', 'tool', 'tool', 'compact']);
    expect(messages[0]).toMatchObject({ k: 0, role: 'user', text: 'hello' });
    expect(messages[2].tool).toMatchObject({ name: 'exec_command', result: '/work\n', isError: false });
    expect(messages.slice(3, 5).map((message) => message.tool.input.file_path)).toEqual(['/work/a.js', '/work/b.js']);
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
    expect(proxy.sent.filter((message) => message.method === 'thread/resume')).toHaveLength(3);
    expect(proxy.sent).toContainEqual(expect.objectContaining({ method: 'turn/start' }));
    app.close();
  });

  it('resumes the exact thread, sends turns, and resolves a structured approval once', async () => {
    const proxy = fakeProxy();
    const app = createCodexAppServer({
      home: '/home/test', exists: () => true, connect: () => proxy.ws,
    });
    expect(await app.status('%1', 'thread-1')).toMatchObject({ managed: true, threadId: 'thread-1' });
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
});
