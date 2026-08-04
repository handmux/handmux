import { describe, it, expect } from 'vitest';
import { tmpHome } from './tmphome.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../hooks/handmux-notify.sh');

// Run the hook with a given src + env + stdin payload, against a fresh temp state file. Returns the
// parsed JSON state object (or null if the file was never created).
function run(arg, env, stdin, file, agent) {
  execFileSync('sh', agent ? [SCRIPT, arg, agent] : [SCRIPT, arg], {
    input: stdin,
    env: { ...process.env, ...env, HANDMUX_STATE: file },
  });
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
function freshFile() {
  return path.join(tmpHome('hookstate-'), 'claude-state.json');
}

describe('handmux-notify.sh → handmux-write.js', () => {
  it('records the pane keyed by its id, with src + full payload (no network, just a file)', () => {
    const file = freshFile();
    const obj = run('notify', { TMUX_PANE: '%263' }, '{"notification_type":"permission_prompt","session_id":"abc","cwd":"/x"}', file);
    expect(obj['%263'].src).toBe('notify');
    expect(obj['%263'].payload).toMatchObject({ notification_type: 'permission_prompt', session_id: 'abc', cwd: '/x' });
    expect(typeof obj['%263'].ts).toBe('number');
    expect(obj['%263'].ts).toBeGreaterThan(1_600_000_000_000); // a real ms epoch
  });

  it('drops an idle_prompt — it must NOT overwrite a prior done (no inbox re-surface, no ts bump)', () => {
    const file = freshFile();
    run('stop', { TMUX_PANE: '%1' }, '{"last_assistant_message":"done"}', file);
    const obj = run('notify', { TMUX_PANE: '%1' }, '{"notification_type":"idle_prompt"}', file);
    expect(obj['%1']).toMatchObject({ src: 'stop' });                  // still the done, untouched
    expect(obj['%1'].payload.last_assistant_message).toBe('done');
  });

  it('an idle_prompt for a brand-new pane writes nothing at all', () => {
    const file = freshFile();
    const obj = run('notify', { TMUX_PANE: '%7' }, '{"notification_type":"idle_prompt"}', file);
    expect(obj).toBeNull();                                            // no entry created
  });

  it('an idle_prompt after a WORKING turn (no Stop = ESC interrupt) clears the stuck 进行中', () => {
    const file = freshFile();
    run('prompt', { TMUX_PANE: '%2' }, '{"prompt":"do a thing"}', file); // 进行中, never gets a Stop
    const obj = run('notify', { TMUX_PANE: '%2' }, '{"notification_type":"idle_prompt"}', file);
    expect(obj['%2']).toBeUndefined();                                 // pane dropped → dot clears
  });

  it('an idle_prompt after a resume (answered, then interrupted) also clears the pane', () => {
    const file = freshFile();
    run('resume', { TMUX_PANE: '%3' }, '{"tool_name":"AskUserQuestion"}', file);
    const obj = run('notify', { TMUX_PANE: '%3' }, '{"notification_type":"idle_prompt"}', file);
    expect(obj['%3']).toBeUndefined();
  });

  it('stores multi-digit pane ids verbatim — the % goes into a JSON field, never a URL (regression)', () => {
    const file = freshFile();
    const obj = run('prompt', { TMUX_PANE: '%110' }, '{"prompt":"hi"}', file);
    expect(obj).toHaveProperty('%110');
    expect(obj['%110'].payload.prompt).toBe('hi');
  });

  it('keeps each pane separate and only the latest event per pane', () => {
    const file = freshFile();
    run('prompt', { TMUX_PANE: '%1' }, '{"prompt":"a"}', file);
    run('prompt', { TMUX_PANE: '%2' }, '{"prompt":"b"}', file);
    const obj = run('stop', { TMUX_PANE: '%1' }, '{"last_assistant_message":"done"}', file); // %1 overwritten
    expect(obj['%1']).toMatchObject({ src: 'stop' });
    expect(obj['%2']).toMatchObject({ src: 'prompt' });
    expect(obj['%1'].payload.last_assistant_message).toBe('done');
  });

  it('records a resume event (PostToolUse on an interaction tool) verbatim, full payload', () => {
    const file = freshFile();
    const obj = run('resume', { TMUX_PANE: '%8' }, '{"tool_name":"AskUserQuestion","tool_response":"ok"}', file);
    expect(obj['%8']).toMatchObject({ src: 'resume' });
    expect(obj['%8'].payload.tool_name).toBe('AskUserQuestion');
  });

  it('codex resume un-sticks a pane FROM 需要你 back to 进行中 (agent tagged)', () => {
    const file = freshFile();
    run('permreq', { TMUX_PANE: '%20' }, '{"tool_name":"Bash"}', file, 'codex'); // 需要你
    const obj = run('resume', { TMUX_PANE: '%20' }, '{"tool_name":"Bash","tool_response":"ok"}', file, 'codex');
    expect(obj['%20']).toMatchObject({ src: 'resume', agent: 'codex' });          // flipped to 进行中
  });

  it('codex resume is a NO-OP mid-turn — a tool call when not stuck on 需要你 does not churn the entry', () => {
    const file = freshFile();
    run('prompt', { TMUX_PANE: '%21' }, '{"prompt":"go"}', file, 'codex');        // 进行中
    const obj = run('resume', { TMUX_PANE: '%21' }, '{"tool_name":"Bash"}', file, 'codex');
    expect(obj['%21']).toMatchObject({ src: 'prompt' });                          // unchanged, still the prompt
    expect(obj['%21'].payload.prompt).toBe('go');
  });

  it('codex resume on a brand-new pane writes nothing (nothing to un-stick)', () => {
    const file = freshFile();
    const obj = run('resume', { TMUX_PANE: '%22' }, '{"tool_name":"Bash"}', file, 'codex');
    expect(obj).toBeNull();
  });

  it('records a permreq event (PermissionRequest) verbatim with tool_name', () => {
    const file = freshFile();
    const obj = run('permreq', { TMUX_PANE: '%9' }, '{"tool_name":"Bash","tool_input":{"command":"ls"}}', file);
    expect(obj['%9']).toMatchObject({ src: 'permreq' });
    expect(obj['%9'].payload.tool_name).toBe('Bash');
  });

  it('end removes the pane entry (clean exit)', () => {
    const file = freshFile();
    run('prompt', { TMUX_PANE: '%5' }, '{"prompt":"x"}', file);
    const obj = run('end', { TMUX_PANE: '%5' }, '{"reason":"prompt_input_exit"}', file);
    expect(obj['%5']).toBeUndefined();
  });

  it('start (SessionStart) binds the pane to the NEW session, recording its transcript_path verbatim', () => {
    const file = freshFile();
    const obj = run('start', { TMUX_PANE: '%40' }, '{"source":"clear","session_id":"new-sess","transcript_path":"/p/new-sess.jsonl","cwd":"/x"}', file);
    expect(obj['%40']).toMatchObject({ src: 'start' });
    expect(obj['%40'].payload).toMatchObject({ session_id: 'new-sess', transcript_path: '/p/new-sess.jsonl' });
  });

  it('/clear race: with SessionStart(new) already recorded, a late SessionEnd(old) does NOT wipe the new binding', () => {
    const file = freshFile();
    run('start', { TMUX_PANE: '%41' }, '{"source":"clear","session_id":"new","transcript_path":"/p/new.jsonl"}', file); // Start won the async race
    const obj = run('end', { TMUX_PANE: '%41' }, '{"session_id":"old","reason":"clear"}', file);                        // late end for the OLD session
    expect(obj['%41']).toMatchObject({ src: 'start' });                 // survived — new binding intact
    expect(obj['%41'].payload.transcript_path).toBe('/p/new.jsonl');
  });

  it('SessionEnd for the SAME recorded session still drops the pane (clean exit / normal /clear order)', () => {
    const file = freshFile();
    run('prompt', { TMUX_PANE: '%42' }, '{"prompt":"x","session_id":"s1"}', file);
    const obj = run('end', { TMUX_PANE: '%42' }, '{"session_id":"s1","reason":"prompt_input_exit"}', file);
    expect(obj['%42']).toBeUndefined();
  });

  it('a Codex hook snapshots its exact transcript and an empty new session cannot clear it', () => {
    const home = tmpHome('hookstate-');
    const file = path.join(home, 'claude-state.json');
    const transcript = path.join(home, 'rollout.jsonl');
    const usageFile = path.join(home, 'codex-usage.json');
    fs.writeFileSync(transcript, JSON.stringify({
      timestamp: '2026-07-23T06:00:00.000Z',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: 20 }, model_context_window: 258400 },
        rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: 1785600000 } },
      },
    }));

    const payload = JSON.stringify({ session_id: 'codex-1', transcript_path: transcript });
    const obj = run('stop', { TMUX_PANE: '%50' }, payload, file, 'codex');
    expect(obj['%50']).toMatchObject({ src: 'stop', agent: 'codex', bindingVersion: 2 });
    const before = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    expect(before.usage.rateLimits.primary.usedPercent).toBe(42);

    const empty = path.join(home, 'empty.jsonl');
    fs.writeFileSync(empty, JSON.stringify({ type: 'session_meta', payload: {} }));
    run('prompt', { TMUX_PANE: '%51' }, JSON.stringify({ session_id: 'codex-2', transcript_path: empty }), file, 'codex');
    expect(JSON.parse(fs.readFileSync(usageFile, 'utf8'))).toEqual(before);
  });

  it('no pane → does nothing (no file written)', () => {
    const file = freshFile();
    const obj = run('stop', { TMUX_PANE: '', CLAUDE_PANE: '' }, '{}', file);
    expect(obj).toBeNull();
  });

  it('CLAUDE_PANE overrides TMUX_PANE', () => {
    const file = freshFile();
    const obj = run('stop', { TMUX_PANE: '%1', CLAUDE_PANE: '%999' }, '{}', file);
    expect(obj).toHaveProperty('%999');
    expect(obj).not.toHaveProperty('%1');
  });
});
