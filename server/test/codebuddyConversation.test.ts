import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodebuddyConversationActivityReader } from '../src/agent-runtime/builtinRuntime.js';
import { createCodebuddyEvents } from '../src/codebuddyEvents.js';
import {
  createCodeBuddyConversationAdapter,
  findCodeBuddySessionFile,
} from '../src/agents/codebuddyConversation.js';
import { codebuddyProjectsDir } from '../src/agents/codebuddy.js';

const SESSION = '4442e3d0-8d46-4cce-9822-b86558f69922';
const PANE = '%7';
const directories: string[] = [];

function directory(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-codebuddy-conversation-'));
  directories.push(value);
  return value;
}

afterEach(() => {
  for (const value of directories.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

const line = (record: Record<string, unknown>) => JSON.stringify(record);
const at = (ms: number) => new Date(ms).toISOString();

// The measured CodeBuddy record shapes: a message per turn, a separately-called tool whose result lands
// later, a public reasoning projection, and a compaction.
function conversationLines(): string[] {
  return [
    line({
      id: 'm1', timestamp: 1_000, type: 'message', role: 'user', sessionId: SESSION,
      content: [{ type: 'input_text', text: '把 CodeBuddy 接进对话页' }], providerData: {},
    }),
    line({
      id: 'm2', timestamp: 1_100, type: 'message', role: 'assistant', sessionId: SESSION,
      content: [{ type: 'output_text', text: '先读规范。' }], providerData: {},
    }),
    line({
      id: 'r1', timestamp: 1_150, type: 'reasoning', sessionId: SESSION,
      content: [], rawContent: [{ type: 'reasoning_text', text: 'RAW 私密推理' }], providerData: {},
    }),
    line({
      id: 'c1', timestamp: 1_200, type: 'function_call', callId: 'call_1', name: 'Edit', sessionId: SESSION,
      arguments: JSON.stringify({
        file_path: '/home/user/jly_gh/handmux_private/server/src/agents/codebuddy.ts',
        old_string: 'const a = 1;',
        new_string: 'const a = 2;\nconst b = 3;',
      }),
      providerData: { reasoning: 'RAW 私密推理' },
    }),
    line({
      id: 'c2', timestamp: 1_300, type: 'function_call_result', callId: 'call_1', name: 'Edit',
      status: 'completed', sessionId: SESSION,
      output: { type: 'text', text: 'Successfully edited file: …/codebuddy.ts' },
      providerData: { toolResult: { content: 'Successfully edited file: …/codebuddy.ts', renderer: { type: 'diff' } } },
    }),
    line({
      id: 'm3', timestamp: 1_400, type: 'message', role: 'user', sessionId: SESSION,
      content: [{ type: 'input_text', text: '<cb_summary>\nSummary of the conversation so far:\n早先的对话…\n</cb_summary>' }],
      providerData: { isCompacted: true, compactType: 'pre-message-auto', isCompactInternal: true },
    }),
  ];
}

function projectFile(contents: string[] = conversationLines()): { root: string; file: string } {
  const root = codebuddyProjectsDir(directory());
  const file = path.join(root, 'Users-admin-jly_gh-handmux_private', `${SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents.join('\n') + '\n');
  return { root, file };
}

const sessionRef = { agentId: 'codebuddy', sessionId: SESSION } as const;
const runRef = { agentId: 'codebuddy', paneId: PANE, runId: 'run-1', sessionId: SESSION } as const;
// The dispatch/interrupt and activity entries take a run LEASE (ref + process + abort signal), not the bare
// ref that discovery takes.
const lease = {
  ref: runRef,
  process: { pid: 400, startedAt: 1_000 },
  signal: new AbortController().signal,
} as unknown as Parameters<NonNullable<ReturnType<typeof createCodeBuddyConversationAdapter>['dispatchPrompt']>>[0];

describe('CodeBuddy Conversation adapter', () => {
  it('finds a session log by its UUID file name, and refuses ambiguity or a bad id', async () => {
    const { root, file } = projectFile();
    expect(await findCodeBuddySessionFile(root, SESSION)).toBe(fs.realpathSync(file));
    expect(await findCodeBuddySessionFile(root, 'not-a-uuid')).toBeNull();
    expect(await findCodeBuddySessionFile(root, '4442e3d0-8d46-4cce-9822-b86558f69999')).toBeNull();
  });

  it('binds a run only to the session its own pane recorded', async () => {
    const { root } = projectFile();
    const adapter = createCodeBuddyConversationAdapter({ projectsRoot: root });
    // Another provider, or an unknown session, never opens a CodeBuddy lens.
    expect(await adapter.discoverNative({ agentId: 'claude', sessionId: SESSION })).toBeNull();
    expect(await adapter.discoverNative(sessionRef)).toMatchObject({
      session: { agentId: 'codebuddy', sessionId: SESSION },
      sourceViewId: `codebuddy-session:${SESSION}`,
      capabilities: { history: true, live: 'poll' },
    });
    // A run needs the pane's own binding to agree, and without a bind there is no lens at all.
    expect(await adapter.discoverNative(runRef)).toBeNull();
    const bound = createCodeBuddyConversationAdapter({
      projectsRoot: root,
      sessions: { paneSession: () => ({ sessionId: SESSION, transcriptPath: null, cwd: '/x', agent: 'codebuddy' }) },
      control: { sendPrompt: vi.fn(), interrupt: vi.fn() },
    });
    expect(await bound.discoverNative(runRef)).toMatchObject({
      run: runRef,
      capabilities: {
        history: true, live: 'settled', sendable: true, send: ['prompt'], interrupt: true,
        // 「立刻引导」 is declared, the automatic in-turn send is not: a busy send queues.
        steer: true,
      },
    });
    expect((await bound.discoverNative(runRef))?.capabilities).not.toHaveProperty('promptWhileActive');
    const foreign = createCodeBuddyConversationAdapter({
      projectsRoot: root,
      sessions: { paneSession: () => ({ sessionId: 'other-session', transcriptPath: null, cwd: '/x', agent: 'codebuddy' }) },
    });
    expect(await foreign.discoverNative(runRef)).toBeNull();
  });

  it('projects turns, folded tools, a derived diff and a compaction — never raw reasoning', async () => {
    const { root } = projectFile();
    const adapter = createCodeBuddyConversationAdapter({ projectsRoot: root });
    const page = await adapter.readNativePage(sessionRef, { limit: 20 });
    expect(page.items.map((item) => item.kind)).toEqual([
      'message', 'message', 'tool_call', 'tool_result', 'diff', 'compaction',
    ]);
    expect(page.items[0]).toMatchObject({
      kind: 'message', role: 'user', content: [{ type: 'text', text: '把 CodeBuddy 接进对话页' }],
      sourceCreatedAt: 1_000,
    });
    // The call and its later result are one tool, so the result carries the same callId.
    expect(page.items[2]).toMatchObject({ kind: 'tool_call', name: 'Edit', input: { file_path: expect.any(String) } });
    expect(page.items[3]).toMatchObject({ kind: 'tool_result' });
    // One tool call and its result share the call id, so the phone pairs them.
    expect((page.items[2] as { callId: string }).callId).toBe((page.items[3] as { callId: string }).callId);
    // The diff is derived from the call's own old/new strings, in the shared +/- line shape.
    expect(page.items[4]).toMatchObject({
      kind: 'diff', summary: '+2 -1', patch: '-const a = 1;\n+const a = 2;\n+const b = 3;',
    });
    // The shared safety layer collapses the home directory out of a path before it leaves the server.
    expect((page.items[4] as { path?: string }).path).toBe('~/jly_gh/handmux_private/server/src/agents/codebuddy.ts');
    expect(JSON.stringify(page.items[4])).not.toMatch(/\/Users\/admin/);
    expect(page.items[5]).toMatchObject({ kind: 'compaction', summary: '早先的对话…' });
    // The reasoning record carries a raw chain of thought; nothing of it may reach the phone.
    expect(JSON.stringify(page.items)).not.toMatch(/RAW 私密推理/);
  });

  it('pages backwards by item cursor', async () => {
    const { root } = projectFile();
    const adapter = createCodeBuddyConversationAdapter({ projectsRoot: root });
    const newest = await adapter.readNativePage(sessionRef, { limit: 2 });
    expect(newest.items.map((item) => item.kind)).toEqual(['diff', 'compaction']);
    expect(newest).toMatchObject({ hasMore: true, previousSourceCursor: '4' });
    const older = await adapter.readNativePage(sessionRef, {
      limit: 2, beforeSourceCursor: newest.previousSourceCursor ?? '4',
    });
    expect(older.items.map((item) => item.kind)).toEqual(['tool_call', 'tool_result']);
    await expect(adapter.readNativePage(sessionRef, { limit: 2, beforeSourceCursor: 'x' }))
      .rejects.toThrow('Invalid CodeBuddy source cursor');
  });

  it('reports a send honestly: accepted, a refused draft, or unconfirmed delivery', async () => {
    const { root } = projectFile();
    const sendPrompt = vi.fn(async () => ({ nativeMutation: true }));
    const adapter = createCodeBuddyConversationAdapter({
      projectsRoot: root,
      sessions: { paneSession: () => ({ sessionId: SESSION, transcriptPath: null, cwd: '/x', agent: 'codebuddy' }) },
      control: { sendPrompt, interrupt: vi.fn(async () => {}) },
    });
    expect(await adapter.dispatchPrompt!(lease, { text: 'hi', clientRequestId: 'req-1' })).toEqual({ outcome: 'accepted' });
    sendPrompt.mockImplementationOnce(async () => ({ nativeMutation: false, reason: 'terminal_draft_conflict' }));
    expect(await adapter.dispatchPrompt!(lease, { text: 'hi', clientRequestId: 'req-1' }))
      .toEqual({ outcome: 'rejected', nativeMutation: false, reason: 'terminal_draft_conflict' });
    sendPrompt.mockImplementationOnce(async () => ({ nativeMutation: false }));
    expect(await adapter.dispatchPrompt!(lease, { text: 'hi', clientRequestId: 'req-1' })).toEqual({ outcome: 'busy', nativeMutation: false });
    sendPrompt.mockImplementationOnce(async () => { throw new Error('bridge down'); });
    expect(await adapter.dispatchPrompt!(lease, { text: 'hi', clientRequestId: 'req-1' }))
      .toEqual({ outcome: 'unknown', nativeMutation: 'unknown', reason: 'delivery_unconfirmed' });
    expect(await adapter.dispatchInterrupt!(lease)).toEqual({ status: 'accepted' });
  });

  // The whole point of the split: a busy send queues, and only 「立刻引导」 writes into the running turn.
  it('reaches the running turn through 「立刻引导」, and only that way', async () => {
    const { root } = projectFile();
    const sendPrompt = vi.fn(async () => ({ nativeMutation: true }));
    const adapter = createCodeBuddyConversationAdapter({
      projectsRoot: root,
      sessions: { paneSession: () => ({ sessionId: SESSION, transcriptPath: null, cwd: '/x', agent: 'codebuddy' }) },
      control: { sendPrompt, interrupt: vi.fn(async () => {}) },
    });
    const capabilities = (await adapter.discoverNative(runRef))?.capabilities;
    // The Core enforces the pairing itself, so a declared steer without a dispatchSteer would be rejected.
    expect(capabilities).toMatchObject({ steer: true });
    expect(capabilities).not.toHaveProperty('promptWhileActive');
    await expect(adapter.dispatchSteer!(lease, {
      clientRequestId: 'steer-1', text: 'join the running turn',
      plan: {
        kind: 'steer-active-turn', activityEpoch: 'run-1', activityRevision: 3,
        nativeTurnId: `codebuddy-run:${runRef.runId}`,
      },
      anchor: { viewId: 'view' },
    })).resolves.toEqual({ outcome: 'accepted' });
    expect(sendPrompt).toHaveBeenCalledWith(PANE, 'join the running turn');
  });

  it('reads activity from the same classification the roster uses', async () => {
    const stateFile = path.join(directory(), 'codebuddy-state.json');
    const row = (src: string, payload: Record<string, unknown>) => ({
      [PANE]: {
        ts: 10, src, host: 'h', agent: 'codebuddy', sequence: 1,
        process: { pid: 400, startedAt: 1_000, tty: '/dev/ttys001' }, payload,
      },
    });
    const write = (src: string, payload: Record<string, unknown>) =>
      fs.writeFileSync(stateFile, JSON.stringify(row(src, payload)));
    const events = createCodebuddyEvents({ stateFile });
    const reader = createCodebuddyConversationActivityReader(events);
    const run = {
      ref: { agentId: 'codebuddy', paneId: PANE, runId: 'run-1', sessionId: SESSION },
      process: { pid: 400, startedAt: 1_000 },
    } as unknown as Parameters<typeof reader.read>[0];

    write('prompt', { session_id: SESSION, prompt: '开始' });
    expect(await reader.read(run)).toMatchObject({ activity: 'working', activeTurn: { state: 'active' } });
    expect(events.paneSession(PANE)).toMatchObject({ sessionId: SESSION });
    // The composer may only ever replace the prompt this pane itself submitted.
    expect(events.paneSubmittedPrompt(PANE)).toBe('开始');
    write('permreq', { session_id: SESSION, tool_name: 'Bash' });
    expect(await reader.read(run)).toMatchObject({ activity: 'waiting' });
    write('stop', { session_id: SESSION, last_assistant_message: '完了' });
    expect(await reader.read(run)).toMatchObject({ activity: 'idle', activeTurn: { state: 'none' } });
    // A row from another process generation, or another pane, says nothing about this run.
    expect(await reader.read({ ...run, process: { pid: 999, startedAt: 5 } } as typeof run))
      .toMatchObject({ activity: 'unknown' });
    expect(events.paneSession('%404')).toBeNull();
    expect(events.paneSubmittedPrompt(PANE)).toBeNull();
  });
});
