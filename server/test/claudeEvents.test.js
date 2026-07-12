import { describe, it, expect } from 'vitest';
import { tmpHome } from './tmphome.js';
import { classifyEvent, createClaudeEvents } from '../src/claudeEvents.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    expect(classifyEvent('resume', { tool_input: { answers: { a: 'Red', b: ['X', 'Y'] } } }).msg).toBe('已答：Red、X、Y');
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
  it('unknown src → null', () => {
    expect(classifyEvent('whatever', {})).toBeNull();
  });
});

// Write a { pane: {ts,src,host,payload} } state file like the hook does, into a fresh temp path.
function stateFile(panes) {
  const file = path.join(tmpHome('cstate-'), 'claude-state.json');
  fs.writeFileSync(file, JSON.stringify(panes));
  return file;
}
// listLivePanes mock: every id is a live `claude` in session `proj`, unless overridden.
function liveAll(ids, over = {}) {
  return ids.map((id) => ({ id, cmd: 'claude', session: 'proj', window: '@5', windowName: 'dev', ...(over[id] || {}) }));
}
const rec = (src, payload = {}, ts = 1000) => ({ ts, src, host: 'h', payload });

describe('createClaudeEvents getStates (reads the hook state file)', () => {
  const push = { sendToSession: async () => ({ sent: 0 }) };

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

  it('drops a pane whose latest event is end', async () => {
    const file = stateFile({ '%1': rec('end', { reason: 'x' }) });
    const commands = { listLivePanes: async () => liveAll(['%1']) };
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
    const commands = { listLivePanes: async () => liveAll(['%1']) };
    const ev = createClaudeEvents({ commands, push, file: '/no/such/file.json' });
    expect(await ev.getStates()).toEqual({});
  });

  it('tmux down → degraded best-effort: still classifies, no location (and no session filtering possible)', async () => {
    const file = stateFile({ '%1': rec('stop', { last_assistant_message: 'a' }) });
    const commands = { listLivePanes: async () => { throw new Error('tmux down'); } };
    const ev = createClaudeEvents({ commands, push, file });
    expect((await ev.getStates())['%1']).toMatchObject({ kind: 'done', msg: 'a' });
  });

  it('expires a 进行中 latched past the TTL (ESC-interrupt has no closing hook) → drops from roster', async () => {
    const file = stateFile({ '%9': rec('prompt', { prompt: 'interrupted, walked away' }, 1000) });
    const commands = { listLivePanes: async () => liveAll(['%9']) };
    const ev = createClaudeEvents({ commands, push, file, now: () => 1000 + 3 * 60 * 60 * 1000 }); // 3h later
    expect(await ev.getStates()).toEqual({});                                              // dropped from roster
  });

  it('keeps a 进行中 still within the TTL (a long-running task stays in the roster)', async () => {
    const file = stateFile({ '%9': rec('prompt', { prompt: 'long task' }, 1000) });
    const commands = { listLivePanes: async () => liveAll(['%9']) }; // note: no runTmux → must not be called
    const ev = createClaudeEvents({ commands, push, file, now: () => 1000 + 60 * 60 * 1000 }); // 1h later < 2h
    expect((await ev.getStates())['%9']).toMatchObject({ kind: 'working', msg: 'long task' });
  });
});

describe('createClaudeEvents push (需要你 / 已完成 transitions, mirroring the inbox views, via the getStates pass)', () => {
  function setup(panes) {
    const pushed = [];
    const push = { sendToSession: async (session, payload, opts) => { pushed.push({ session, payload, opts }); return { sent: 1 }; } };
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
    const pushed = [];
    const push = { sendToSession: async (s, p, o) => { pushed.push({ s }); return { sent: 1 }; } };
    const file = stateFile({ '%1': rec('prompt', { prompt: 'x' }), '%2': rec('notify', { notification_type: 'permission_prompt' }) });
    const commands = { listLivePanes: async () => liveAll(['%1']) }; // %2 is a ghost (would-be 需要你, but gone)
    const ev = createClaudeEvents({ commands, push, file });
    await ev.getStates();
    expect(pushed).toHaveLength(0);
  });
});

describe('createClaudeEvents with a Codex-tagged pane (agent dispatch, Claude-parity hooks)', () => {
  const cdone = (msg, ts) => ({ ts, src: 'stop', host: 'h', payload: { last_assistant_message: msg }, agent: 'codex' });
  const cwork = (prompt, ts) => ({ ts, src: 'prompt', host: 'h', payload: { prompt }, agent: 'codex' });
  // Real codex pane_current_command is "node" (the launcher stays foreground) — must NOT be pruned.
  const liveCodex = (ids, cmd = 'node') => ids.map((id) => ({ id, cmd, session: 'proj', window: '@5', windowName: 'dev' }));

  it("keeps a codex pane whose command is the node launcher (not pruned as non-codex)", async () => {
    const file = stateFile({ '%1': cdone('ok', 1000) });
    const states = await createClaudeEvents({ commands: { listLivePanes: async () => liveCodex(['%1'], 'node') }, push: { sendToSession: async () => ({}) }, file }).getStates();
    expect(states['%1']).toMatchObject({ kind: 'done', msg: 'ok' });
  });

  it("classifies codex hook verbs (prompt→working, stop→done) and prunes when the pane isn't running codex", async () => {
    expect((await createClaudeEvents({ commands: { listLivePanes: async () => liveCodex(['%1']) }, push: { sendToSession: async () => ({}) }, file: stateFile({ '%1': cwork('do it', Date.now()) }) }).getStates())['%1'])
      .toMatchObject({ kind: 'working', msg: 'do it', session: 'proj' });
    const file = stateFile({ '%1': cdone('built it', 1000) });
    expect((await createClaudeEvents({ commands: { listLivePanes: async () => liveCodex(['%1']) }, push: { sendToSession: async () => ({}) }, file }).getStates())['%1'])
      .toMatchObject({ kind: 'done', msg: 'built it', session: 'proj', agent: 'codex' }); // agent surfaced for the UI logo
    // pane flipped back to the shell → codex no longer foreground → pruned (procName mismatch, not 'claude')
    const shellPane = { listLivePanes: async () => [{ id: '%1', cmd: 'zsh', session: 'proj', window: '@5', windowName: 'dev' }] };
    expect(await createClaudeEvents({ commands: shellPane, push: { sendToSession: async () => ({}) }, file }).getStates()).toEqual({});
  });

  it('re-pushes 已完成 on each new codex turn (new ts re-arms the done dedup)', async () => {
    const pushed = [];
    const push = { sendToSession: async (session, payload) => { pushed.push(payload.body); return { sent: 1 }; } };
    const file = stateFile({ '%1': cdone('turn one', 1000) });
    const commands = { listLivePanes: async () => liveCodex(['%1']) };
    const ev = createClaudeEvents({ commands, push, file });
    await ev.getStates();                                                       // done#1 → push
    await ev.getStates();                                                       // same ts → deduped
    fs.writeFileSync(file, JSON.stringify({ '%1': cdone('turn two', 2000) }));  // new Stop, new ts
    await ev.getStates();                                                       // done#2 → push again
    expect(pushed).toEqual(['turn one', 'turn two']);
  });
});
