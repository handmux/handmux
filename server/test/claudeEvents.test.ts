import { describe, it, expect, vi } from 'vitest';
import { tmpHome } from './tmphome.js';
import { classifyEvent, createClaudeEvents, permissionResolved, resolvedPermissionKind, isLocalCommandStdout } from '../src/claudeEvents.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface TestLivePane {
  id: string;
  cmd: string;
  tty?: string;
  session: string;
  window: string;
  windowName: string;
}

interface TestPushCall {
  session: string;
  payload: Record<string, unknown>;
  opts: Record<string, unknown>;
}

describe('classifyEvent', () => {
  it('stop → done with the last assistant message', () => {
    expect(classifyEvent('stop', { last_assistant_message: 'hi' })).toEqual({ kind: 'done', msg: 'hi' });
  });
  it('prompt → working with the submitted prompt', () => {
    expect(classifyEvent('prompt', { prompt: 'do the thing' })).toEqual({ kind: 'working', msg: 'do the thing' });
  });
  it('end → end', () => {
    expect(classifyEvent('end', { reason: 'prompt_input_exit' })).toEqual({ kind: 'end' });
  });
  it('notify idle_prompt → idle, carrying the notification message', () => {
    expect(classifyEvent('notify', { notification_type: 'idle_prompt', message: 'waiting' })).toEqual({ kind: 'idle', msg: 'waiting' });
  });
  it('notify permission_prompt → permission, carrying the message', () => {
    expect(classifyEvent('notify', { notification_type: 'permission_prompt', message: 'needs perm' })).toEqual({ kind: 'permission', msg: 'needs perm' });
  });
  it('resume → working, surfacing the chosen answer (AskUserQuestion stores it in tool_input.answers)', () => {
    expect(classifyEvent('resume', { tool_name: 'AskUserQuestion', tool_input: { answers: { 'Which?': 'Red' } } }))
      .toEqual({ kind: 'working', msg: '已答：Red' });
  });
  it('resume joins multiple/array answers; ExitPlanMode resume reads 已批准计划; bare resume is blank', () => {
    expect(classifyEvent('resume', { tool_input: { answers: { a: 'Red', b: ['X', 'Y'] } } })?.msg).toBe('已答：Red、X、Y');
    expect(classifyEvent('resume', { tool_name: 'ExitPlanMode' })).toEqual({ kind: 'working', msg: '已批准计划' });
    expect(classifyEvent('resume', {})).toEqual({ kind: 'working', msg: '' });
  });
  it('permreq → permission, named by the gating tool (faster, tool-aware 需要你)', () => {
    expect(classifyEvent('permreq', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Red or blue?' }] } }))
      .toEqual({ kind: 'permission', msg: '需要你回答：Red or blue?' });
    expect(classifyEvent('permreq', { tool_name: 'ExitPlanMode' })).toEqual({ kind: 'permission', msg: '需要你批准计划' });
    expect(classifyEvent('permreq', { tool_name: 'Bash' })).toEqual({ kind: 'permission', msg: '需要你授权：Bash' });
  });
  it('notify auth_success → null (ignored)', () => {
    expect(classifyEvent('notify', { notification_type: 'auth_success' })).toBeNull();
  });
  it('compacting → compacting (PreCompact: 压缩上下文进行中)', () => {
    expect(classifyEvent('compacting', {})).toEqual({ kind: 'compacting', msg: '' });
  });
  it('compact → null (PostCompact: compaction done, clear the state)', () => {
    expect(classifyEvent('compact', {})).toBeNull();
  });
  it('stopfail → error, with a friendly reason read defensively from several fields', () => {
    expect(classifyEvent('stopfail', { error_type: 'rate_limit' })).toEqual({ kind: 'error', msg: '触发限流' });
    expect(classifyEvent('stopfail', { reason: 'overloaded' })).toEqual({ kind: 'error', msg: '服务过载' });
    expect(classifyEvent('stopfail', { error: { type: 'billing_error' } })).toEqual({ kind: 'error', msg: '额度/账单问题' });
    expect(classifyEvent('stopfail', { error: 'boom raw' })).toEqual({ kind: 'error', msg: 'boom raw' });
    expect(classifyEvent('stopfail', {})).toEqual({ kind: 'error', msg: '' }); // unknown shape → bare error
  });
  it('start → null (SessionStart just (re)binds pane→session; a fresh/cleared session is neutral, not 进行中)', () => {
    expect(classifyEvent('start', { source: 'clear' })).toBeNull();
    expect(classifyEvent('start', { source: 'startup' })).toBeNull();
  });
  it('unknown src → null', () => {
    expect(classifyEvent('whatever', {})).toBeNull();
  });
});

describe('permissionResolved (transcript grew past the permission event ⇒ user answered/ESC-ed)', () => {
  const r = { ts: 10_000 };
  it('pending: transcript frozen at/near the event ts → not resolved', () => {
    expect(permissionResolved(r, 10_000)).toBe(false); // no growth
    expect(permissionResolved(r, 9_000)).toBe(false);  // notification fired after the tool_use write
    expect(permissionResolved(r, 11_000)).toBe(false); // within the guard (near-simultaneous permreq)
  });
  it('resolved: transcript grew well past the event ts → true', () => {
    expect(permissionResolved(r, 12_000)).toBe(true);
  });
  it('unreadable transcript (null mtime) → not resolved (keep 需要你)', () => {
    expect(permissionResolved(r, null)).toBe(false);
    expect(permissionResolved(r, undefined)).toBe(false);
  });
});

describe('resolvedPermissionKind (transcript last line: interrupt vs resume)', () => {
  it('an ESC interrupt marker → null (neutral, turn ended)', () => {
    expect(resolvedPermissionKind(JSON.stringify({ type: 'user', message: { content: '[Request interrupted by user]' } }))).toBeNull();
    expect(resolvedPermissionKind(JSON.stringify({ message: { content: '[Request interrupted by user for tool use]' } }))).toBeNull();
  });
  it('a tool_result / continuation → working (approve or deny → 进行中)', () => {
    expect(resolvedPermissionKind(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }))).toEqual({ kind: 'working', msg: '' });
  });
  it('an unparseable/absent tail → working (clear the stale 需要你, show active)', () => {
    expect(resolvedPermissionKind(null)).toEqual({ kind: 'working', msg: '' });
    expect(resolvedPermissionKind('{ truncated…')).toEqual({ kind: 'working', msg: '' });
  });
});

// Write a { pane: {ts,src,host,payload} } state file like the hook does, into a fresh temp path.
function stateFile(panes: unknown) {
  const file = path.join(tmpHome('cstate-'), 'claude-state.json');
  fs.writeFileSync(file, JSON.stringify(panes));
  return file;
}
// listLivePanes mock: every id is a live `claude` in session `proj`, unless overridden.
function liveAll(ids: string[], over: Record<string, Partial<TestLivePane>> = {}): TestLivePane[] {
  return ids.map((id) => ({ id, cmd: 'claude', session: 'proj', window: '@5', windowName: 'dev', ...(over[id] || {}) }));
}
const rec = (src: string, payload: Record<string, unknown> = {}, ts = 1000) => ({ ts, src, host: 'h', payload });

describe('createClaudeEvents paneSession', () => {
  it('returns Claude binding metadata and rejects legacy Codex Hook rows', () => {
    const file = stateFile({
      '%1': { ...rec('stop', { session_id: 'cx', transcript_path: '/tmp/codex.jsonl', cwd: '/x' }), agent: 'codex', bindingVersion: 2 },
      '%2': rec('stop', { session_id: 'cc', transcript_path: '/tmp/claude.jsonl', cwd: '/y' }),
    });
    const events = createClaudeEvents({ commands: {}, push: null, file });
    expect(events.paneSession('%1')).toBeNull();
    expect(events.paneAgent('%1')).toBeNull();
    expect(events.paneSession('%2')).toEqual({ sessionId: 'cc', transcriptPath: '/tmp/claude.jsonl', cwd: '/y', agent: undefined });
  });
});

describe('createClaudeEvents getStates (reads the hook state file)', () => {
  const push = { sendToSession: async () => ({ sent: 0 }) };

  it('notifies state changes only after the debounced watcher refresh completes', async () => {
    let watchCallback!: (event: string, filename: string | Buffer | null) => void;
    let timerCallback!: () => void;
    let finishList!: (value: unknown[] | PromiseLike<unknown[]>) => void;
    const listed = new Promise<unknown[]>((resolve) => { finishList = resolve; });
    const onStateChange = vi.fn();
    const ev = createClaudeEvents({
      commands: { listLivePanes: () => listed },
      push,
      file: '/virtual/claude-state.json',
      onStateChange,
      watch: (_dir, callback) => { watchCallback = callback; return { close() {} }; },
      mkdir: () => {},
      setTimer: (callback) => { timerCallback = callback; return 1; },
      clearTimer: () => {},
    });
    ev.start();
    watchCallback('rename', 'claude-state.json');
    timerCallback();
    expect(onStateChange).not.toHaveBeenCalled();
    finishList([]);
    await vi.waitFor(() => expect(onStateChange).toHaveBeenCalledOnce());
    ev.stop();
  });

  it('classifies a recorded pane and resolves its tmux location', async () => {
    const file = stateFile({ '%1': rec('stop', { last_assistant_message: 'done' }) });
    const commands = { listLivePanes: async () => liveAll(['%1']) };
    const ev = createClaudeEvents({ commands, push, file });
    expect((await ev.getStates())['%1']).toMatchObject({ session: 'proj', window: '@5', windowName: 'dev', kind: 'done', msg: 'done' });
  });

  it('working carries the prompt; multi-digit pane ids work (no URL encoding involved)', async () => {
    const file = stateFile({ '%110': rec('prompt', { prompt: 'go build it' }, Date.now()) });
    const commands = { listLivePanes: async () => liveAll(['%110']) };
    const ev = createClaudeEvents({ commands, push, file });
    expect((await ev.getStates())['%110']).toMatchObject({ kind: 'working', msg: 'go build it' });
  });

  it('resume un-sticks a pane to working (PostToolUse fired after the user answered an interaction tool)', async () => {
    // The hook recorded permission_prompt first, then resume on top (latest-fired wins) — the inbox should
    // now read 进行中, not 需要你.
    const file = stateFile({ '%7': rec('resume', { tool_name: 'AskUserQuestion', tool_input: { answers: { q: 'Red' } } }, Date.now()) });
    const commands = { listLivePanes: async () => liveAll(['%7']) };
    const ev = createClaudeEvents({ commands, push, file });
    expect((await ev.getStates())['%7']).toMatchObject({ session: 'proj', kind: 'working', msg: '已答：Red' });
  });

  const permPane = () => stateFile({ '%1': rec('notify', { notification_type: 'permission_prompt', message: 'allow Bash?', transcript_path: '/t.jsonl' }, 10_000) });

  it('a still-pending permission shows 需要你 (transcript frozen at the event ts)', async () => {
    const commands = { listLivePanes: async () => liveAll(['%1']) };
    const ev = createClaudeEvents({ commands, push, file: permPane(), statMtime: () => 10_000, readTail: () => null }); // no growth
    expect((await ev.getStates())['%1']).toMatchObject({ kind: 'permission', msg: 'allow Bash?' });
  });

  it('after you answer (yes / deny-with-feedback) the pane returns to 进行中', async () => {
    const commands = { listLivePanes: async () => liveAll(['%1']) };
    const tail = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
    // now() close to the event ts so the resumed 进行中 isn't swept by WORKING_TTL (rec.ts is the permission
    // event time; in production that's recent).
    const ev = createClaudeEvents({ commands, push, file: permPane(), statMtime: () => 20_000, readTail: () => tail, now: () => 40_000 });
    expect((await ev.getStates())['%1']).toMatchObject({ session: 'proj', kind: 'working' });
  });

  it('after you ESC-interrupt the prompt the pane clears → neutral present (no chip)', async () => {
    const commands = { listLivePanes: async () => liveAll(['%1']) };
    const tail = JSON.stringify({ type: 'user', message: { content: '[Request interrupted by user for tool use]' } });
    const ev = createClaudeEvents({ commands, push, file: permPane(), statMtime: () => 20_000, readTail: () => tail });
    expect((await ev.getStates())['%1']).toMatchObject({ session: 'proj', agent: 'claude', kind: null });
  });

  it('a working turn the user ESC-interrupts un-sticks immediately (interrupt tail → neutral), not after WORKING_TTL', async () => {
    const file = stateFile({ '%1': rec('prompt', { prompt: 'go', transcript_path: '/t.jsonl' }, 10_000) });
    const commands = { listLivePanes: async () => liveAll(['%1']) };
    const tail = JSON.stringify({ type: 'user', interruptedMessageId: 'msg_x', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    const ev = createClaudeEvents({ commands, push, file, statMtime: () => 20_000, readTail: () => tail, now: () => 30_000 });
    expect((await ev.getStates())['%1']).toMatchObject({ session: 'proj', agent: 'claude', kind: null });
  });

  it('a working turn still producing stays 进行中 (non-interrupt tail, transcript grew)', async () => {
    const file = stateFile({ '%1': rec('prompt', { prompt: 'go', transcript_path: '/t.jsonl' }, 10_000) });
    const commands = { listLivePanes: async () => liveAll(['%1']) };
    const tail = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '仍在写…' }] } });
    const ev = createClaudeEvents({ commands, push, file, statMtime: () => 20_000, readTail: () => tail, now: () => 30_000 });
    expect((await ev.getStates())['%1']).toMatchObject({ kind: 'working', msg: 'go' });
  });

  it('PreCompact shows 压缩中 (compacting); PostCompact clears it → neutral present', async () => {
    const commands = { listLivePanes: async () => liveAll(['%1']) };
    const compacting = createClaudeEvents({ commands, push, file: stateFile({ '%1': rec('compacting', {}, Date.now()) }) });
    expect((await compacting.getStates())['%1']).toMatchObject({ kind: 'compacting' });
    // PostCompact overwrites the pane's record (latest-wins) with src 'compact' → classify null → no chip.
    const done = createClaudeEvents({ commands, push, file: stateFile({ '%1': rec('compact', {}, Date.now()) }) });
    expect((await done.getStates())['%1']).toMatchObject({ agent: 'claude', kind: null });
  });

  it('a no-op /compact (stdout tail, no PostCompact) drops 压缩中 within a poll; a real one (silent tail) keeps it', async () => {
    const commands = { listLivePanes: async () => liveAll(['%1']) };
    const paneFile = () => stateFile({ '%1': rec('compacting', { transcript_path: '/t.jsonl' }, 10_000) });
    // NO-OP: transcript grew past the event and its tail is the command's <local-command-stdout> → resolved → clear.
    const noop = JSON.stringify({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Not enough messages to compact.</local-command-stdout>' });
    const evNoop = createClaudeEvents({ commands, push, file: paneFile(), statMtime: () => 20_000, readTail: () => noop, now: () => 25_000 });
    expect((await evNoop.getStates())['%1']).toMatchObject({ kind: null });
    // REAL in-progress: only the /compact command echo so far, no stdout yet → still 压缩中 (for its whole run).
    const echo = JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>' } });
    const evReal = createClaudeEvents({ commands, push, file: paneFile(), statMtime: () => 20_000, readTail: () => echo, now: () => 25_000 });
    expect((await evReal.getStates())['%1']).toMatchObject({ kind: 'compacting' });
  });

  it('a 压缩中 with no closing signal at all (crash/abort) is swept only after the generous COMPACTING_TTL (5 min)', async () => {
    const commands = { listLivePanes: async () => liveAll(['%1']) };
    const mk = (now: number) => createClaudeEvents({ commands, push, file: stateFile({ '%1': rec('compacting', {}, 0) }), now: () => now });
    expect((await mk(2 * 60 * 1000).getStates())['%1']).toMatchObject({ kind: 'compacting' }); // 2 min in — a real compaction, kept
    expect((await mk(6 * 60 * 1000).getStates())['%1']).toMatchObject({ kind: null });          // 6 min — backstop fires
  });

  it('isLocalCommandStdout recognises the resolve marker by subtype or tag, tolerates junk', () => {
    expect(isLocalCommandStdout(JSON.stringify({ subtype: 'local_command', content: '<local-command-stdout>x</local-command-stdout>' }))).toBe(true);
    expect(isLocalCommandStdout(JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } }))).toBe(true);
    expect(isLocalCommandStdout(JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>' } }))).toBe(false);
    expect(isLocalCommandStdout(null)).toBe(false);
    expect(isLocalCommandStdout('{ truncated…')).toBe(false);
  });

  it('StopFailure → error state carrying the reason (chat-lens only; no push)', async () => {
    const file = stateFile({ '%1': rec('stopfail', { error_type: 'overloaded' }, Date.now()) });
    let sent = 0;
    const commands = { listLivePanes: async () => liveAll(['%1']) };
    const ev = createClaudeEvents({ commands, push: { sendToSession: async () => { sent += 1; } }, file });
    ev.start();
    expect((await ev.getStates())['%1']).toMatchObject({ kind: 'error', msg: '服务过载' });
    expect(sent).toBe(0); // error is not a push view — surfaced only in the chat lens
    ev.stop();
  });

  it('an ended pane leaves the ACTIVITY roster (kind:null so the inbox skips it) but stays present while its agent process runs — the /clear case: SessionEnd drops the entry though claude is still alive', async () => {
    const file = stateFile({ '%1': rec('end', { reason: 'clear' }) });
    const commands = { listLivePanes: async () => liveAll(['%1']) }; // claude still the pane's program
    const ev = createClaudeEvents({ commands, push, file });
    // present for the phone's agent icon + the dock's default mode…
    expect((await ev.getStates())['%1']).toMatchObject({ session: 'proj', agent: 'claude', kind: null });
    // …but kind:null → not a done/needs/working view → the inbox (web inboxRows) skips it.
  });

  it('an ended pane that also exited to the shell is fully gone (real quit, not /clear)', async () => {
    const file = stateFile({ '%1': rec('end', { reason: 'other' }) });
    const commands = { listLivePanes: async () => liveAll(['%1'], { '%1': { cmd: 'zsh' } }) };
    const ev = createClaudeEvents({ commands, push, file });
    expect(await ev.getStates()).toEqual({});
  });

  it('prunes a pane that tmux no longer lists (hard-killed ghost)', async () => {
    const file = stateFile({ '%1': rec('stop'), '%2': rec('stop') });
    const commands = { listLivePanes: async () => liveAll(['%1']) }; // %2 gone
    const ev = createClaudeEvents({ commands, push, file });
    const states = await ev.getStates();
    expect(states['%1']).toBeTruthy();
    expect(states['%2']).toBeUndefined();
  });

  it('prunes a pane that is alive but no longer running claude (cmd flipped to the shell)', async () => {
    const file = stateFile({ '%4': rec('prompt', { prompt: 'x' }) });
    const commands = { listLivePanes: async () => liveAll(['%4'], { '%4': { cmd: 'zsh' } }) };
    const ev = createClaudeEvents({ commands, push, file });
    expect(await ev.getStates()).toEqual({});
  });

  it('scopes the output to the given session set (per-device isolation), reconciling either way', async () => {
    const file = stateFile({ '%1': rec('prompt', { prompt: 'a' }, Date.now()), '%2': rec('prompt', { prompt: 'b' }, Date.now()) });
    const commands = {
      listLivePanes: async () => [
        { id: '%1', cmd: 'claude', session: 'alpha', window: '@1', windowName: 'w' },
        { id: '%2', cmd: 'claude', session: 'beta', window: '@1', windowName: 'w' },
      ],
    };
    const ev = createClaudeEvents({ commands, push, file });
    expect(Object.keys(await ev.getStates(['alpha']))).toEqual(['%1']);
    expect(await ev.getStates(['beta'])).toHaveProperty('%2');
    expect(Object.keys(await ev.getStates([]))).toEqual([]);           // empty subscription → nothing
    expect(Object.keys(await ev.getStates())).toEqual(['%1', '%2']);   // no filter → all
  });

  it('reads the file fresh each call — a brand-new instance sees the same state (file is the persistence)', async () => {
    const file = stateFile({ '%4': rec('prompt', { prompt: 'build' }, Date.now()) });
    const commands = { listLivePanes: async () => liveAll(['%4']) };
    expect((await createClaudeEvents({ commands, push, file }).getStates())['%4']).toMatchObject({ kind: 'working', msg: 'build' });
    // simulate the hook updating the file, then a fresh server read
    fs.writeFileSync(file, JSON.stringify({ '%4': rec('stop', { last_assistant_message: 'ok' }, 2000) }));
    expect((await createClaudeEvents({ commands, push, file }).getStates())['%4']).toMatchObject({ kind: 'done', msg: 'ok' });
  });

  it('a missing state file yields an empty roster (no crash)', async () => {
    const commands = { listLivePanes: async () => liveAll(['%1'], { '%1': { cmd: 'zsh' } }) };
    const ev = createClaudeEvents({ commands, push, file: '/no/such/file.json' });
    expect(await ev.getStates()).toEqual({});
  });

  it('surfaces a live agent pane with NO recorded state (a fresh session that has not prompted yet) as process-present', async () => {
    const commands = { listLivePanes: async () => liveAll(['%1']) }; // claude running, hooks have written nothing
    const ev = createClaudeEvents({ commands, push, file: '/no/such/file.json' });
    expect((await ev.getStates())['%1']).toMatchObject({ session: 'proj', window: '@5', agent: 'claude', kind: null });
  });

  it('identifies pane agents independently of inbox state for initial navigation', async () => {
    const panes = [
      { id: '%1', command: 'claude', tty: '/dev/ttys001' },
      { id: '%2', command: 'codex', tty: '/dev/ttys002' },
      { id: '%3', command: 'zsh', tty: '/dev/ttys003' },
    ];
    const ev = createClaudeEvents({ commands: {}, push, file: '/no/such/file.json' });
    expect(await ev.identifyPaneAgents(panes)).toEqual({ '%1': 'claude', '%2': 'codex' });
    expect(panes.map((pane) => pane.command)).toEqual(['claude', 'codex', 'zsh']);
  });

  it('treats a native-install version-named binary (pane_current_command = bare semver) as Claude — but ONLY with exe-path corroboration', async () => {
    const panes = liveAll(['%1'], { '%1': { cmd: '2_1_196', tty: '/dev/ttys077' } });
    const mkRun = (exe: string) => async (cmd: string) => cmd === 'lsof'
      ? `p4242\nftxt\nn${exe}\n`
      : 'ttys077 4242 S+'; // only foreground pids are candidates; identity comes from the real exe
    // process presence (no hooks yet): corroborated version-named comm → icon / lens switch work
    const commands = { listLivePanes: async () => panes.map((p) => ({ ...p })) };
    const claudeRun = mkRun('/Users/x/.local/share/claude/versions/2.1.196');
    const ev = createClaudeEvents({ commands, push, file: '/no/such/file.json', run: claudeRun });
    expect((await ev.getStates())['%1']).toMatchObject({ agent: 'claude', kind: null });
    // liveness: a recorded 进行中 on that pane must NOT be pruned as gone
    const file = stateFile({ '%1': rec('prompt', { prompt: 'build' }, Date.now()) });
    const ev2 = createClaudeEvents({ commands, push, file, run: claudeRun });
    expect((await ev2.getStates())['%1']).toMatchObject({ kind: 'working', msg: 'build' });
    // the 随便一个软件 case: a version-named binary OUTSIDE claude's versions dir is NOT Claude
    const ev3 = createClaudeEvents({ commands, push, file: '/no/such/file.json', run: mkRun('/opt/sometool/2.1.196') });
    expect(await ev3.getStates()).toEqual({});
  });

  it('does NOT surface a non-agent process — a plain shell or bare node is not an agent (procName match, never the ambiguous "node")', async () => {
    const commands = { listLivePanes: async () => liveAll(['%1', '%2'], { '%1': { cmd: 'zsh' }, '%2': { cmd: 'node', tty: '/dev/ttys078' } }) };
    const run = async (cmd: string) => cmd === 'ps' ? 'ttys078 777 S+' : 'p777\nftxt\nn/usr/local/bin/node\n';
    const ev = createClaudeEvents({ commands, push, file: '/no/such/file.json', run });
    expect(await ev.getStates()).toEqual({});
  });

  it('tmux down → degraded best-effort: still classifies, no location (and no session filtering possible)', async () => {
    const file = stateFile({ '%1': rec('stop', { last_assistant_message: 'a' }) });
    const commands = { listLivePanes: async () => { throw new Error('tmux down'); } };
    const ev = createClaudeEvents({ commands, push, file });
    expect((await ev.getStates())['%1']).toMatchObject({ kind: 'done', msg: 'a' });
  });

  it('expires a 进行中 latched past the TTL (ESC-interrupt has no closing hook) → drops from the ACTIVITY roster, but stays process-present while claude runs', async () => {
    const file = stateFile({ '%9': rec('prompt', { prompt: 'interrupted, walked away' }, 1000) });
    const commands = { listLivePanes: async () => liveAll(['%9']) };
    const ev = createClaudeEvents({ commands, push, file, now: () => 1000 + 3 * 60 * 60 * 1000 }); // 3h later
    // No longer an active working row (the stuck 进行中 is gone from the inbox), but claude is still the
    // pane's program → present as process-only so the icon/mode hold.
    expect((await ev.getStates())['%9']).toMatchObject({ agent: 'claude', kind: null });
  });

  it('keeps a 进行中 still within the TTL (a long-running task stays in the roster)', async () => {
    const file = stateFile({ '%9': rec('prompt', { prompt: 'long task' }, 1000) });
    const commands = { listLivePanes: async () => liveAll(['%9']) }; // note: no runTmux → must not be called
    const ev = createClaudeEvents({ commands, push, file, now: () => 1000 + 60 * 60 * 1000 }); // 1h later < 2h
    expect((await ev.getStates())['%9']).toMatchObject({ kind: 'working', msg: 'long task' });
  });
});

describe('createClaudeEvents push (需要你 / 已完成 transitions, mirroring the inbox views, via the getStates pass)', () => {
  function setup(panes: Record<string, unknown>) {
    const pushed: TestPushCall[] = [];
    const push = { sendToSession: async (session: string, payload: Record<string, unknown>, opts: Record<string, unknown>) => { pushed.push({ session, payload, opts }); return { sent: 1 }; } };
    const file = stateFile(panes);
    const commands = { listLivePanes: async () => liveAll(Object.keys(panes)) };
    const ev = createClaudeEvents({ commands, push, file });
    return { ev, pushed, file };
  }

  it('permission pushes 需要你 (high urgency); title carries the state label + session', async () => {
    const { ev, pushed } = setup({ '%1': rec('notify', { notification_type: 'permission_prompt', message: 'perm' }) });
    await ev.getStates();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].opts.urgency).toBe('high');
    expect(pushed[0].opts.ttl).toBe(14400); // 可靠优先: hold 需要你 for hours so a Doze'd phone still补到
    expect(pushed[0].session).toBe('proj');
    expect(pushed[0].payload.title).toBe('需要你 · proj');
  });

  it('a finished turn (stop) pushes 已完成 (normal urgency) — the formerly-missing half, now matching the inbox', async () => {
    const { ev, pushed } = setup({ '%1': rec('stop', { last_assistant_message: 'all done' }) });
    await ev.getStates();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].opts.urgency).toBe('normal');
    expect(pushed[0].opts.ttl).toBe(1800); // 已完成 staler-than-30min is dropped rather than popped late
    expect(pushed[0].payload.title).toBe('已完成 · proj');
    expect(pushed[0].payload.body).toBe('all done');
  });

  it('the trailing idle reminder is a push no-op — it does NOT add a second 已完成 after a done', async () => {
    const { ev, pushed, file } = setup({ '%1': rec('stop', { last_assistant_message: 'm' }) });
    await ev.getStates();                                                              // done → 已完成 push #1
    fs.writeFileSync(file, JSON.stringify({ '%1': rec('notify', { notification_type: 'idle_prompt' }, 2000) }));
    await ev.getStates();                                                              // 60s idle → suppressed, no push
    expect(pushed).toHaveLength(1);
  });

  it('idle alone never pushes (the 60s reminder is suppressed) yet does not block a later done', async () => {
    const { ev, pushed, file } = setup({ '%1': rec('notify', { notification_type: 'idle_prompt' }) });
    await ev.getStates();                                                              // idle with no prior done → no push
    expect(pushed).toHaveLength(0);
    fs.writeFileSync(file, JSON.stringify({ '%1': rec('stop', { last_assistant_message: 'ok' }, 2000) }));
    await ev.getStates();                                                              // done → 已完成 pings (idle didn't arm-block it)
    expect(pushed).toHaveLength(1);
    expect(pushed[0].payload.title).toBe('已完成 · proj');
  });

  it('a 需要你 → 已完成 change pushes both (the view genuinely changed)', async () => {
    const { ev, pushed, file } = setup({ '%1': rec('notify', { notification_type: 'permission_prompt' }) });
    await ev.getStates();                                                              // 需要你 push #1
    fs.writeFileSync(file, JSON.stringify({ '%1': rec('stop', { last_assistant_message: 'ok' }, 2000) }));
    await ev.getStates();                                                              // 已完成 push #2 (different view)
    expect(pushed.map((p) => p.payload.title)).toEqual(['需要你 · proj', '已完成 · proj']);
  });

  it('permreq pushes 需要你 high urgency too (the faster trigger), deduped against the later permission_prompt', async () => {
    const { ev, pushed, file } = setup({ '%1': rec('permreq', { tool_name: 'Bash' }) });
    await ev.getStates();                                                              // PermissionRequest → push #1
    fs.writeFileSync(file, JSON.stringify({ '%1': rec('notify', { notification_type: 'permission_prompt' }, 2000) }));
    await ev.getStates();                                                              // same 需要你 view → deduped, no push
    expect(pushed).toHaveLength(1);
    expect(pushed[0].opts.urgency).toBe('high');
  });

  it('de-dupes the same view across polls (no repeat push)', async () => {
    const { ev, pushed } = setup({ '%1': rec('stop', { last_assistant_message: 'm' }) });
    await ev.getStates();
    await ev.getStates();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].opts.urgency).toBe('normal');
  });

  it('进行中 (a new prompt) re-arms the dedup so the next 已完成 pushes again', async () => {
    const { ev, pushed, file } = setup({ '%1': rec('stop', { last_assistant_message: 'a' }) });
    await ev.getStates();                                                              // done → 已完成 push #1
    fs.writeFileSync(file, JSON.stringify({ '%1': rec('prompt', { prompt: 'next' }, 2000) }));
    await ev.getStates();                                                              // 进行中 → re-arm, no push
    fs.writeFileSync(file, JSON.stringify({ '%1': rec('stop', { last_assistant_message: 'b' }, 3000) }));
    await ev.getStates();                                                              // done again → 已完成 push #2
    expect(pushed).toHaveLength(2);
  });

  it('resume (user answered) re-arms the push dedup like any 进行中 boundary', async () => {
    const { ev, pushed, file } = setup({ '%1': rec('notify', { notification_type: 'permission_prompt' }) });
    await ev.getStates();                                                              // permission → push #1
    fs.writeFileSync(file, JSON.stringify({ '%1': rec('resume', {}, 2000) }));         // user answered → working
    await ev.getStates();                                                              // re-arms, no push
    fs.writeFileSync(file, JSON.stringify({ '%1': rec('notify', { notification_type: 'permission_prompt' }, 3000) }));
    await ev.getStates();                                                              // permission again → push #2
    expect(pushed).toHaveLength(2);
  });

  it('start() primes a boot baseline: a restart does NOT replay resting 已完成/需要你, only new transitions push', async () => {
    // The bug: lastPushed is in-memory, so ./deploy.sh wipes it while the state file keeps every pane's
    // resting 已完成/需要你 — the next read would re-push them all. start() adopts those as already-seen.
    const { ev, pushed, file } = setup({
      '%1': rec('stop', { last_assistant_message: 'old done' }),
      '%2': rec('notify', { notification_type: 'permission_prompt', message: 'old perm' }),
    });
    ev.start(); // boot: prime the baseline from the file…
    ev.stop();  // …then drop the dir watcher so the manual writes below don't race its debounced poll
    await ev.getStates();                         // first poll after boot → NO replay
    expect(pushed).toHaveLength(0);

    // a genuinely new turn on %1: 进行中 re-arms, then a fresh done pushes (boot baseline didn't wedge it)
    fs.writeFileSync(file, JSON.stringify({
      '%1': rec('prompt', { prompt: 'next' }, 2000),
      '%2': rec('notify', { notification_type: 'permission_prompt', message: 'old perm' }),
    }));
    await ev.getStates();
    fs.writeFileSync(file, JSON.stringify({
      '%1': rec('stop', { last_assistant_message: 'new done' }, 3000),
      '%2': rec('notify', { notification_type: 'permission_prompt', message: 'old perm' }),
    }));
    await ev.getStates();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].payload.body).toBe('new done'); // only the post-boot done, never the primed pair
  });

  it('does not push for 进行中, and never for a pruned (dead) pane', async () => {
    const pushed: Array<{ s: string }> = [];
    const push = { sendToSession: async (s: string) => { pushed.push({ s }); return { sent: 1 }; } };
    const file = stateFile({ '%1': rec('prompt', { prompt: 'x' }), '%2': rec('notify', { notification_type: 'permission_prompt' }) });
    const commands = { listLivePanes: async () => liveAll(['%1']) }; // %2 is a ghost (would-be 需要你, but gone)
    const ev = createClaudeEvents({ commands, push, file });
    await ev.getStates();
    expect(pushed).toHaveLength(0);
  });
});

describe('createClaudeEvents with Codex App Server state', () => {
  const cdone = (msg: string, ts: number) => ({ ts, src: 'stop', host: 'h', payload: { last_assistant_message: msg }, agent: 'codex' });
  // Some Codex launchers leave pane_current_command as node; process inspection identifies presence only.
  const liveCodex = (ids: string[], cmd = 'node') => ids.map((id) => ({ id, cmd, tty: '/dev/ttys030', session: 'proj', window: '@5', windowName: 'dev' }));
  const codexRun = async (cmd: string, args: string[]) => {
    if (cmd === 'ps') return 'ttys030 501 S+\nttys030 502 R+';
    if (cmd === 'lsof') {
      const pid = args[args.indexOf('-p') + 1];
      const exe = pid === '502' ? '/opt/@openai/codex/bin/codex' : '/usr/local/bin/node';
      return `p${pid}\nftxt\nn${exe}\n`;
    }
    return '';
  };

  it('ignores legacy Codex Hook activity and exposes only neutral process presence', async () => {
    const pushed: unknown[] = [];
    const file = stateFile({ '%1': cdone('ok', 1000) });
    const states = await createClaudeEvents({
      commands: { listLivePanes: async () => liveCodex(['%1'], 'node') },
      push: { sendToSession: async (_session, payload) => { pushed.push(payload); } }, file, run: codexRun,
    }).getStates();
    expect(states['%1']).toMatchObject({ kind: null, msg: '', agent: 'codex' });
    expect(pushed).toEqual([]);
  });

  it('uses managed App Server state instead of a stale Codex Hook row', async () => {
    const file = stateFile({ '%1': cdone('stale', 1000) });
    const codexApp = { inboxStates: async () => ({ '%1': { kind: 'working', msg: 'fix the inbox', ts: 2000, suppressPush: false } }) };
    const states = await createClaudeEvents({
      commands: { listLivePanes: async () => liveCodex(['%1'], 'codex') }, push: { sendToSession: async () => ({}) }, file, codexApp,
    }).getStates();
    expect(states['%1']).toMatchObject({ kind: 'working', msg: 'fix the inbox', agent: 'codex', ts: 2000 });
  });

  it('does not revive stale Hook state while a managed App Server socket reconnects', async () => {
    const file = stateFile({ '%1': cdone('stale', 1000) });
    const codexApp = { inboxStates: async () => ({ '%1': { kind: null, msg: '', ts: 0, unavailable: true } }) };
    const states = await createClaudeEvents({
      commands: { listLivePanes: async () => liveCodex(['%1'], 'node') }, push: { sendToSession: async () => ({}) }, file, codexApp,
      run: async () => { throw new Error('process inspection unavailable'); },
    }).getStates();
    expect(states['%1']).toMatchObject({ kind: null, agent: 'codex' });
  });

  it('suppresses a restart baseline, then pushes only fresh managed Codex transitions', async () => {
    const pushed: unknown[] = [];
    const snapshots = [
      { kind: 'done', msg: 'old', ts: 1000, suppressPush: true },
      { kind: 'done', msg: 'old', ts: 1000, suppressPush: false },
      { kind: 'working', msg: '', ts: 2000, suppressPush: false },
      { kind: 'done', msg: 'fresh', ts: 3000, suppressPush: false },
    ];
    const codexApp = { inboxStates: async () => ({ '%1': snapshots.shift() }) };
    const ev = createClaudeEvents({
      commands: { listLivePanes: async () => liveCodex(['%1'], 'codex') }, file: stateFile({}), codexApp,
      push: { sendToSession: async (_session, payload) => { pushed.push(payload.body); } },
    });
    await ev.getStates();
    await ev.getStates();
    await ev.getStates();
    await ev.getStates();
    expect(pushed).toEqual(['fresh']);
  });
});
