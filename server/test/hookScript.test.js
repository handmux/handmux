import { describe, it, expect } from 'vitest';
import { tmpHome } from './tmphome.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../hooks/handmux-notify.sh');
const WRITER = path.resolve(__dirname, '../hooks/handmux-write.cjs');

// Run the hook with a given src + env + stdin payload, against a fresh temp state file. Returns the
// parsed JSON state object (or null if the file was never created).
function run(arg, env, stdin, file) {
  execFileSync('sh', [SCRIPT, arg], {
    input: stdin,
    env: {
      ...process.env,
      HANDMUX_STATE: file,
      HANDMUX_CLAUDE_EVENTS: `${file}.events`,
      ...env,
    },
  });
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
function freshFile() {
  return path.join(tmpHome('hookstate-'), '.handmux', 'claude-state.json');
}
function events(file) {
  try {
    return fs.readdirSync(`${file}.events`)
      .filter((name) => /^event-.*\.json$/.test(name))
      .sort()
      .map((name) => JSON.parse(fs.readFileSync(path.join(`${file}.events`, name), 'utf8')));
  } catch { return []; }
}

describe('handmux-notify.sh → handmux-write.js', () => {
  it('records the pane keyed by its id, with src + full payload (no network, just a file)', () => {
    const file = freshFile();
    const obj = run('notify', { TMUX_PANE: '%263' }, '{"notification_type":"permission_prompt","session_id":"abc","cwd":"/x"}', file);
    expect(obj['%263'].src).toBe('notify');
    expect(obj['%263'].payload).toMatchObject({ notification_type: 'permission_prompt', session_id: 'abc', cwd: '/x' });
    expect(typeof obj['%263'].ts).toBe('number');
    expect(obj['%263'].ts).toBeGreaterThan(1_600_000_000_000); // a real ms epoch
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(obj['%263'].sequence).toBe(1);
    expect(obj['%263'].agent).toBe('claude');
    expect(obj['%263'].process).toBeUndefined(); // no exact Claude ancestor in the test process
    expect(events(file)).toEqual([
      expect.objectContaining({
        version: 1, type: 'event', eventId: 'claude-hook-1', sequence: 1,
        agent: 'claude', paneId: '%263', src: 'notify', sessionId: 'abc',
      }),
    ]);
  });

  it('persists a complete owning Claude process fingerprint in state and durable events', () => {
    const file = freshFile();
    execFileSync(process.execPath, [
      WRITER, file, '%1', 'prompt', '1000', 'test-host', `${file}.events`,
      '4242', 'Tue Aug 12 04:00:00 2026', 'ttys007',
    ], { input: '{"session_id":"s1","prompt":"continue"}' });

    const expected = {
      pid: 4242,
      startedAt: Date.parse('Tue Aug 12 04:00:00 2026'),
      tty: '/dev/ttys007',
    };
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))['%1'].process).toEqual(expected);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))['%1'].agent).toBe('claude');
    expect(events(file)[0].agent).toBe('claude');
    expect(events(file)[0].process).toEqual(expected);
  });

  it('finds an async Hook owner from the tmux pane TTY after the Hook was reparented', () => {
    const file = freshFile();
    const fakeBin = path.join(tmpHome('hook-process-bin-'), 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'tmux'), [
      '#!/bin/sh',
      "printf '/dev/ttys007\\n'",
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'ps'), [
      '#!/bin/sh',
      'if [ "$*" = "-p 4242 -o lstart=" ] && [ "$LC_ALL" != "C" ]; then exit 9; fi',
      'case "$*" in',
      // SessionStart waits for the async Hook; the owning Claude can temporarily lose '+' until it returns.
      "  '-t ttys007 -o pid=,stat=,comm=') printf '4242 S claude\\n' ;;",
      "  '-p 4242 -o lstart=') printf 'Tue Aug 12 04:00:00 2026\\n' ;;",
      "  '-p 4242 -o tty=') printf 'ttys007\\n' ;;",
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });

    const obj = run('start', {
      TMUX_PANE: '%1',
      PATH: `${fakeBin}:${process.env.PATH}`,
    }, '{"session_id":"real-session"}', file);

    expect(obj['%1'].process).toEqual({
      pid: 4242,
      startedAt: Date.parse('Tue Aug 12 04:00:00 2026'),
      tty: '/dev/ttys007',
    });
    expect(events(file)[0].process).toEqual(obj['%1'].process);
  });

  it('repairs a legacy hook directory and state file before updating it', () => {
    const file = freshFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.dirname(file), 0o755);
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    run('prompt', { TMUX_PANE: '%1' }, '{"prompt":"continue"}', file);

    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('drops an idle_prompt — it must NOT overwrite a prior done (no inbox re-surface, no ts bump)', () => {
    const file = freshFile();
    run('stop', { TMUX_PANE: '%1' }, '{"last_assistant_message":"done"}', file);
    const before = events(file);
    const obj = run('notify', { TMUX_PANE: '%1' }, '{"notification_type":"idle_prompt"}', file);
    expect(obj['%1']).toMatchObject({ src: 'stop' });                  // still the done, untouched
    expect(obj['%1'].payload.last_assistant_message).toBe('done');
    expect(events(file)).toEqual(before);                              // dropped event is not replayed
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
    expect(events(file).map((event) => event.sequence)).toEqual([1, 2]);
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

  it('records a permreq event (PermissionRequest) verbatim with tool_name', () => {
    const file = freshFile();
    const obj = run('permreq', { TMUX_PANE: '%9' }, '{"tool_name":"Bash","tool_input":{"command":"ls"}}', file);
    expect(obj['%9']).toMatchObject({ src: 'permreq' });
    expect(obj['%9'].payload.tool_name).toBe('Bash');
  });

  it('deduplicates the generic permission notification that follows PermissionRequest', () => {
    const file = freshFile();
    run('permreq', { TMUX_PANE: '%9' }, '{"session_id":"s1","tool_name":"Bash"}', file);
    const obj = run('notify', { TMUX_PANE: '%9' }, '{"session_id":"s1","notification_type":"permission_prompt"}', file);
    expect(obj['%9']).toMatchObject({ src: 'permreq', sequence: 1 });
    expect(events(file)).toHaveLength(1);
  });

  it('does not deduplicate a permission notification from a replacement Claude process', () => {
    const file = freshFile();
    execFileSync(process.execPath, [
      WRITER, file, '%9', 'permreq', '1000', 'test-host', `${file}.events`,
      '101', 'Tue Aug 12 04:00:00 2026', 'ttys007',
    ], { input: '{"tool_name":"Bash"}' });
    execFileSync(process.execPath, [
      WRITER, file, '%9', 'notify', '2000', 'test-host', `${file}.events`,
      '202', 'Tue Aug 12 05:00:00 2026', 'ttys007',
    ], { input: '{"notification_type":"permission_prompt"}' });

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))['%9']).toMatchObject({
      src: 'notify', process: { pid: 202 },
    });
    expect(events(file)).toHaveLength(2);
  });

  it('keeps the legacy latest-state path working when the Bridge spool is unavailable', () => {
    const file = freshFile();
    const blocked = `${file}.blocked`;
    fs.mkdirSync(path.dirname(blocked), { recursive: true });
    fs.writeFileSync(blocked, 'not a directory');
    const obj = run('prompt', {
      TMUX_PANE: '%10', HANDMUX_CLAUDE_EVENTS: blocked,
    }, '{"session_id":"s1","prompt":"still works"}', file);
    expect(obj['%10']).toMatchObject({ src: 'prompt', payload: { prompt: 'still works' } });
    expect(obj['%10'].sequence).toBeUndefined();
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
    expect(events(file)).toHaveLength(1);                              // old end cannot revoke the new run
  });

  it('SessionEnd for the SAME recorded session still drops the pane (clean exit / normal /clear order)', () => {
    const file = freshFile();
    run('prompt', { TMUX_PANE: '%42' }, '{"prompt":"x","session_id":"s1"}', file);
    const obj = run('end', { TMUX_PANE: '%42' }, '{"session_id":"s1","reason":"prompt_input_exit"}', file);
    expect(obj['%42']).toBeUndefined();
    expect(events(file).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('serializes one durable source sequence across panes', () => {
    const file = freshFile();
    run('prompt', { TMUX_PANE: '%1' }, '{"session_id":"a","prompt":"one"}', file);
    run('prompt', { TMUX_PANE: '%2' }, '{"session_id":"b","prompt":"two"}', file);
    run('stop', { TMUX_PANE: '%1' }, '{"session_id":"a","last_assistant_message":"done"}', file);
    expect(events(file).map((event) => [event.sequence, event.paneId, event.src])).toEqual([
      [1, '%1', 'prompt'],
      [2, '%2', 'prompt'],
      [3, '%1', 'stop'],
    ]);
  });

  it('does not reuse an event id when the sequence sidecar is lost', () => {
    const file = freshFile();
    run('prompt', { TMUX_PANE: '%1' }, '{"session_id":"a","prompt":"one"}', file);
    fs.unlinkSync(path.join(`${file}.events`, '.sequence'));
    run('stop', { TMUX_PANE: '%1' }, '{"session_id":"a","last_assistant_message":"done"}', file);
    expect(events(file).map((event) => event.eventId)).toEqual([
      'claude-hook-1',
      'claude-hook-2',
    ]);
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
