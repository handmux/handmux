import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiConversationHistory } from '../src/agents/piConversationHistory.js';

const temporaryDirectories: string[] = [];

async function sessionFile(lines: unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'handmux-pi-history-'));
  temporaryDirectories.push(directory);
  const file = join(directory, '2026-08-12_session-1.jsonl');
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

function header() {
  return { type: 'session', version: 3, id: 'session-1', timestamp: '2026-08-12T00:00:00Z', cwd: '/work' };
}

function history(file: string): PiConversationHistory {
  return new PiConversationHistory({
    sessionsRoot: '/unused', resolveFile: async () => file,
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('PiConversationHistory', () => {
  it('projects only the active tree branch and changes view identity on /tree navigation', async () => {
    const file = await sessionFile([
      header(),
      { type: 'message', id: 'entry001', parentId: null, timestamp: '2026-08-12T00:00:01Z', message: { role: 'user', content: 'root' } },
      { type: 'message', id: 'entry002', parentId: 'entry001', timestamp: '2026-08-12T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'branch A' }], stopReason: 'stop' } },
      { type: 'message', id: 'entry003', parentId: 'entry001', timestamp: '2026-08-12T00:00:03Z', message: { role: 'user', content: 'branch B' } },
    ]);
    const source = history(file);
    source.setActiveLeaf('session-1', 'entry002');
    const first = await source.readPage({ agentId: 'pi', sessionId: 'session-1' }, { limit: 20 });
    expect(first.sourceViewId).toBe('pi-leaf:entry002');
    expect(first.items.filter((item) => item.kind === 'message').map((item) => (
      item.kind === 'message' && item.content[0]?.type === 'text' ? item.content[0].text : ''
    ))).toEqual(['root', 'branch A']);

    source.setActiveLeaf('session-1', 'entry003');
    const second = await source.readPage({ agentId: 'pi', sessionId: 'session-1' }, { limit: 20 });
    expect(second.sourceViewId).toBe('pi-leaf:entry003');
    expect(JSON.stringify(second.items)).toContain('branch B');
    expect(JSON.stringify(second.items)).not.toContain('branch A');
  });

  it('maps Pi v3 messages, tools, results, and compaction without exposing raw thinking', async () => {
    const file = await sessionFile([
      header(),
      { type: 'message', id: 'entry001', parentId: null, message: { role: 'user', content: 'question', timestamp: 10 } },
      { type: 'message', id: 'entry002', parentId: 'entry001', message: {
        role: 'assistant', stopReason: 'toolUse', timestamp: 20,
        content: [
          { type: 'thinking', thinking: 'public reasoning' },
          { type: 'text', text: 'working' },
          { type: 'toolCall', id: 'call_001', name: 'bash', arguments: {
            command: 'pwd', apiKey: 'pi-input-secret', cwd: '/Users/alice/work',
          } },
        ],
      } },
      { type: 'message', id: 'entry003', parentId: 'entry002', message: {
        role: 'toolResult', toolCallId: 'call_001', toolName: 'bash',
        content: [{ type: 'text', text: '/work' }], isError: false, timestamp: 30,
      } },
      { type: 'compaction', id: 'entry004', parentId: 'entry003', summary: 'Earlier context', tokensBefore: 1000 },
    ]);
    const page = await history(file).readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    expect(page.items.map((item) => item.kind)).toEqual([
      'message', 'message', 'tool_call', 'tool_result', 'compaction',
    ]);
    expect(JSON.stringify(page)).not.toContain('public reasoning');
    expect(page.items.find((item) => item.kind === 'tool_call')).toMatchObject({
      callId: 'pi:call_001', name: 'exec_command', input: { cmd: 'pwd' },
      status: 'complete',
    });
    expect(page.items.find((item) => item.kind === 'tool_call')).not.toHaveProperty('truncation');
    expect(JSON.stringify(page)).not.toContain('pi-input-secret');
    expect(JSON.stringify(page)).not.toContain('/Users/alice');
    expect(page.items.find((item) => item.kind === 'tool_result')).toMatchObject({
      callId: 'pi:call_001', content: [{ type: 'text', text: '/work' }],
    });
  });

  it('aliases only confirmed Pi command tools and leaves ordinary tools unchanged', async () => {
    const file = await sessionFile([
      header(),
      { type: 'message', id: 'entry001', parentId: null, message: {
        role: 'assistant', stopReason: 'toolUse', content: [
          { type: 'toolCall', id: 'call_bash', name: 'bash', arguments: {
            command: 'pwd', timeout: 10,
          } },
          { type: 'toolCall', id: 'call_shell', name: 'shell', arguments: { cmd: 'git status' } },
          { type: 'toolCall', id: 'call_read', name: 'read', arguments: { path: 'README.md' } },
        ],
      } },
    ]);
    const page = await history(file).readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );

    expect(page.items.filter((item) => item.kind === 'tool_call')).toMatchObject([
      { callId: 'pi:call_bash', name: 'exec_command', input: { cmd: 'pwd', timeout: 10 } },
      { callId: 'pi:call_shell', name: 'exec_command', input: { cmd: 'git status' } },
      { callId: 'pi:call_read', name: 'read', input: { path: 'README.md' } },
    ]);
  });

  it('preserves assistant Markdown table structure for the generic renderer', async () => {
    const markdown = '| Name | State |\n| --- | --- |\n| Pi | Ready |';
    const file = await sessionFile([
      header(),
      { type: 'message', id: 'entry001', parentId: null, message: {
        role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: markdown }],
      } },
    ]);

    const page = await history(file).readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    expect(page.items[0]).toMatchObject({
      kind: 'message', role: 'assistant', content: [{ type: 'text', text: markdown }],
    });
  });

  it('projects stable generation failures without exposing native messages or paths', async () => {
    const file = await sessionFile([
      header(),
      { type: 'message', id: 'entry001', parentId: null, message: {
        role: 'assistant', stopReason: 'error', errorMessage: '/Users/private/provider.sock RPC failed',
        content: [{ type: 'text', text: 'partial answer' }],
      } },
      { type: 'message', id: 'entry002', parentId: 'entry001', message: {
        role: 'assistant', stopReason: 'error', errorMessage: 'native status=E_INTERNAL', content: [],
      } },
    ]);
    const page = await history(file).readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    expect(page.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'message', status: 'error',
        error: { code: 'provider_error', message: 'Pi generation failed' },
      }),
      expect.objectContaining({
        kind: 'notice', status: 'error', message: 'Pi generation failed',
        error: { code: 'provider_error', message: 'Pi generation failed' },
      }),
    ]));
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('E_INTERNAL');
  });

  it('does not expose base64 images or file paths through durable items', async () => {
    const file = await sessionFile([
      header(),
      { type: 'message', id: 'entry001', parentId: null, message: {
        role: 'user', content: [
          { type: 'text', text: 'look' },
          { type: 'image', data: 'super-secret-base64', mimeType: 'image/png' },
        ],
      } },
      { type: 'message', id: 'entry002', parentId: 'entry001', message: {
        role: 'bashExecution', command: 'test', output: 'done', exitCode: 0,
        fullOutputPath: '/private/tmp/pi-output',
      } },
    ]);
    const page = await history(file).readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    expect(page.items.some((item) => item.kind === 'notice' && item.code === 'image_unavailable')).toBe(true);
    expect(JSON.stringify(page)).not.toContain('super-secret-base64');
    expect(JSON.stringify(page)).not.toContain('/private/tmp/pi-output');
  });

  it('applies one bounded text budget across all content blocks in an item', async () => {
    const file = await sessionFile([
      header(),
      { type: 'message', id: 'entry001', parentId: null, message: {
        role: 'assistant', stopReason: 'stop',
        content: [
          { type: 'text', text: 'a'.repeat(200 * 1024) },
          { type: 'text', text: 'b'.repeat(200 * 1024) },
        ],
      } },
    ]);
    const page = await history(file).readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    const item = page.items[0];
    expect(item).toMatchObject({
      kind: 'message', status: 'truncated',
      truncation: { reason: 'size_limit', originalBytes: 400 * 1024 },
    });
    if (!item || item.kind !== 'message') throw new Error('expected message');
    const bytes = item.content.reduce((total, block) => (
      total + (block.type === 'text' ? Buffer.byteLength(block.text) : 0)
    ), 0);
    expect(bytes).toBe(240 * 1024);
  });

  it('paginates normalized items with an opaque provider cursor', async () => {
    const file = await sessionFile([
      header(),
      { type: 'message', id: 'entry001', parentId: null, message: { role: 'user', content: 'one' } },
      { type: 'message', id: 'entry002', parentId: 'entry001', message: { role: 'user', content: 'two' } },
      { type: 'message', id: 'entry003', parentId: 'entry002', message: { role: 'user', content: 'three' } },
    ]);
    const source = history(file);
    const recent = await source.readPage({ agentId: 'pi', sessionId: 'session-1' }, { limit: 2 });
    expect(recent.items.map((item) => item.id)).toEqual(['pi:entry002', 'pi:entry003']);
    expect(recent).toMatchObject({ previousSourceCursor: '1', hasMore: true });
    const older = await source.readPage(
      { agentId: 'pi', sessionId: 'session-1' },
      { limit: 2, beforeSourceCursor: recent.previousSourceCursor! },
    );
    expect(older.items.map((item) => item.id)).toEqual(['pi:entry001']);
  });

  it('fails closed for a missing parent or an Extension leaf not yet readable from JSONL', async () => {
    const file = await sessionFile([
      header(),
      { type: 'message', id: 'entry001', parentId: 'missing1', message: { role: 'user', content: 'bad' } },
    ]);
    const source = history(file);
    await expect(source.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    )).rejects.toThrow(/missing parent/i);

    const validFile = await sessionFile([
      header(),
      { type: 'message', id: 'entry001', parentId: null, message: { role: 'user', content: 'ok' } },
    ]);
    const awaiting = history(validFile);
    awaiting.setActiveLeaf('session-1', 'notready');
    await expect(awaiting.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    )).rejects.toThrow(/not readable/i);
  });

  it('keeps a live non-root session readable before Pi creates its deferred JSONL', async () => {
    const source = new PiConversationHistory({
      sessionsRoot: '/unused', resolveFile: async () => null,
    });
    expect(await source.discover('session-1')).toBeNull();

    source.beginLive('session-1', 'run-1');
    source.setLiveSnapshot('session-1', 'run-1', 'entry001', { items: [] });
    expect(await source.discover('session-1')).toEqual({ sourceViewId: 'pi-live:run-1' });
    await expect(source.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    )).resolves.toMatchObject({
      sessionId: 'session-1', sourceViewId: 'pi-live:run-1', items: [], hasMore: false,
    });

    source.setLiveSnapshot('session-1', 'run-1', 'entry001', { items: [{
      id: 'pi:entry001', sessionId: 'session-1', status: 'complete', kind: 'message',
      role: 'user', content: [{ type: 'text', text: 'pending' }],
    }] });
    await expect(source.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    )).resolves.toMatchObject({ items: [{ kind: 'message', role: 'user' }] });
  });

  it('restores a pending user from the live snapshot and removes it once JSONL commits it', async () => {
    const file = await sessionFile([
      header(),
      { type: 'message', id: 'entry001', parentId: null, message: {
        role: 'user', content: 'durable first', timestamp: 100,
      } },
    ]);
    const source = history(file);
    const pending = {
      id: 'pi-user:pending', sessionId: 'session-1', status: 'complete' as const,
      kind: 'message' as const, role: 'user' as const,
      content: [{ type: 'text' as const, text: 'original pending display' }],
      sourceCreatedAt: 200,
      extensions: {
        'pi.pendingClientRequestId': 'request-pending',
        'pi.pendingNativeText': 'transformed durable prompt',
      },
    };
    source.beginLive('session-1', 'run-1');
    source.setLiveSnapshot('session-1', 'run-1', 'entry001', {
      sessionFile: file, items: [pending],
    }, 'branch-main');

    let page = await source.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    expect(page.items.map((item) => item.id)).toEqual(['pi:entry001', 'pi-user:pending']);

    await writeFile(file, `${[
      header(),
      { type: 'message', id: 'entry001', parentId: null, message: {
        role: 'user', content: 'durable first', timestamp: 100,
      } },
      { type: 'message', id: 'entry002', parentId: 'entry001', message: {
        role: 'user', content: 'transformed durable prompt', timestamp: 200,
      } },
    ].map((line) => JSON.stringify(line)).join('\n')}\n`);
    source.setLiveSnapshot('session-1', 'run-1', 'entry002', {
      sessionFile: file, items: [pending],
    }, 'branch-main');

    page = await source.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    expect(page.items.filter((item) => (
      item.kind === 'message' && item.role === 'user'
      && item.content.some((block) => block.type === 'text'
        && block.text === 'transformed durable prompt')
    ))).toHaveLength(1);
    expect(page.items.map((item) => item.id)).toEqual(['pi:entry001', 'pi:entry002']);
  });

  it('consumes durable matches one-to-one for identical pending users', async () => {
    const file = await sessionFile([
      header(),
      { type: 'message', id: 'entry001', parentId: null, message: {
        role: 'user', content: 'same prompt', timestamp: 200,
      } },
    ]);
    const source = history(file);
    source.beginLive('session-1', 'run-1');
    const pending = (id: string, requestId: string) => ({
      id, sessionId: 'session-1', status: 'complete' as const,
      kind: 'message' as const, role: 'user' as const,
      content: [{ type: 'text' as const, text: 'same prompt' }],
      sourceCreatedAt: 200,
      extensions: { 'pi.pendingClientRequestId': requestId },
    });
    source.setLiveSnapshot('session-1', 'run-1', 'entry001', {
      sessionFile: file,
      items: [pending('pi-user:first', 'request-first'), pending('pi-user:second', 'request-second')],
    });

    const page = await source.readPage(
      { agentId: 'pi', sessionId: 'session-1' }, { limit: 20 },
    );
    expect(page.items.map((item) => item.id)).toEqual(['pi:entry001', 'pi-user:second']);
  });
});
