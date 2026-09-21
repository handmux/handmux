import { describe, it, expect } from 'vitest';
import { tmpHome } from './tmphome.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../hooks/handmux-codebuddy-notify.sh');

// Every case runs with an injected fake `ps`/`tmux` on PATH. Honest process discovery would otherwise walk
// into the REAL ambient process tree — this suite is often run from inside a CodeBuddy session, whose node
// parent legitimately matches — which would make the "no identity" cases pass or fail by environment.
//
//   none     → no CodeBuddy ancestor, no pane TTY: identity must be omitted.
//   ancestor → the walk finds `node …/bin/codebuddy` at the fake pid 4242.
//   tty      → the walk finds nothing; the pane TTY scan finds one CodeBuddy row (4243).
//   ambiguous→ the pane TTY scan finds TWO: an ambiguous pane must stay unresolved.
function fakeBin(mode) {
  const bin = path.join(tmpHome('cb-bin-'), 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const ps = [
    '#!/bin/sh',
    '# args: -p <pid> -o <format>   |   -t <tty> -o pid=,command=',
    'PID="$2"',
    'FORMAT="$4"',
    'case "$FORMAT" in',
    '  pid=,command=)',
    "    printf '4242 /bin/sh /home/x/.codebuddy/hooks/handmux-codebuddy-notify.sh start\\n'",
    "    printf '4244 /bin/zsh\\n'",
    "    printf '4243 node /usr/local/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy\\n'",
    ...(mode === 'ambiguous'
      ? ["    printf '4245 /home/x/.local/bin/codebuddy\\n'"]
      : []),
    '    ;;',
    '  command=)',
    ...(mode === 'ancestor'
      ? ["    if [ \"$PID\" = '4242' ]; then printf 'node /usr/local/bin/codebuddy\\n'; else printf '/bin/zsh -c handmux-wrapper\\n'; fi"]
      : ["    printf '/bin/zsh -c handmux-wrapper\\n'"]),
    '    ;;',
    '  ppid=)',
    ...(mode === 'ancestor'
      ? ["    if [ \"$PID\" = '4242' ]; then printf '1\\n'; else printf '4242\\n'; fi"]
      : ["    printf '1\\n'"]),
    '    ;;',
    "  lstart=) [ \"$LC_ALL\" = 'C' ] || exit 9; printf 'Tue Aug 12 04:00:00 2026\\n' ;;",
    "  tty=) printf 'ttys007\\n' ;;",
    'esac',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'ps'), ps, { mode: 0o755 });
  // A pane TTY is only reachable through tmux; `none`/`ancestor` keep the fallback inert on purpose.
  const tty = mode === 'tty' || mode === 'ambiguous' ? '/dev/ttys007\\n' : '';
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nprintf '${tty}'\n`, { mode: 0o755 });
  return bin;
}

// /proc/<pid>/stat fixture, matching the field layout the script parses (starttime = field 20 after comm).
function procFixture(pids) {
  const root = path.join(tmpHome('cb-proc-'), 'proc');
  for (const pid of pids) {
    fs.mkdirSync(path.join(root, pid), { recursive: true });
    fs.writeFileSync(path.join(root, pid, 'stat'),
      `${pid} (node) S 1 ${pid} ${pid} 0 -1 4194304 1 0 0 0 1 2 3 4 20 0 1 0 473349 123 456\n`);
  }
  return root;
}

// Run the hook against a fresh temp state file. execFileSync throws on a non-zero exit, so every call here
// also asserts the script's "always exit 0" contract.
function run(arg, { mode = 'none', procRoot, pane = '%263', env = {}, stdin = '{}', file } = {}) {
  execFileSync('sh', [SCRIPT, arg], {
    input: stdin,
    env: {
      ...process.env,
      TMUX_PANE: pane,
      HANDMUX_STATE: file,
      HANDMUX_CODEBUDDY_EVENTS: `${file}.events`,
      PATH: `${fakeBin(mode)}:${process.env.PATH}`,
      ...(procRoot ? { HANDMUX_PROC_ROOT: procRoot } : {}),
      ...env,
    },
  });
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
function freshFile() {
  return path.join(tmpHome('cbstate-'), '.handmux', 'codebuddy-state.json');
}
function events(file) {
  try {
    return fs.readdirSync(`${file}.events`)
      .filter((name) => /^event-.*\.json$/.test(name))
      .sort()
      .map((name) => JSON.parse(fs.readFileSync(path.join(`${file}.events`, name), 'utf8')));
  } catch { return []; }
}

// The payloads verified against CodeBuddy 2.155.0. Only the fields the Connector reads are kept.
const PAYLOADS = [
  ['start', 'SessionStart', {
    session_id: 'cb-s1',
    transcript_path: '/Users/x/.codebuddy/projects/-Users-x/abc.jsonl',
    source: 'startup',
    permission_mode: 'default',
    client: 'cli',
    version: '2.155.0',
    model: 'claude-sonnet-4',
  }],
  ['prompt', 'UserPromptSubmit', {
    session_id: 'cb-s1',
    transcript_path: '/Users/x/.codebuddy/projects/-Users-x/abc.jsonl',
    cwd: '/Users/x',
    prompt: '继续',
    generation_id: 'gen-1',
    model: 'claude-sonnet-4',
  }],
  ['stop', 'Stop', {
    session_id: 'cb-s1',
    transcript_path: '/Users/x/.codebuddy/projects/-Users-x/abc.jsonl',
    cwd: '/Users/x',
    last_assistant_message: 'done',
    stop_hook_active: false,
    agent_type: 'cli',
    generation_id: 'gen-1',
    model: 'claude-sonnet-4',
  }],
  ['end', 'SessionEnd', {
    session_id: 'cb-s1',
    transcript_path: '/Users/x/.codebuddy/projects/-Users-x/abc.jsonl',
    cwd: '/Users/x',
    reason: 'prompt_input_exit',
  }],
  // The state-bearing Notification, and the only kind besides idle_prompt that any reader maps: this is what
  // 需要你 is made of. It carries NO session_id and the row must still land.
  ['notify', 'Notification', {
    cwd: '/Users/x',
    message: 'needs permission',
    notification_type: 'permission_prompt',
    title: 'CodeBuddy',
  }],
  // Answering a question (or approving a plan) completes the interaction tool: this is what clears 需要你.
  ['resume', 'PostToolUse', {
    session_id: 'cb-s1',
    transcript_path: '/Users/x/.codebuddy/projects/-Users-x/abc.jsonl',
    cwd: '/Users/x',
    tool_name: 'AskUserQuestion',
    tool_response: '· 接下来怎么做？ → 继续',
    generation_id: 'gen-1',
    model: 'claude-sonnet-4',
  }],
];

describe('handmux-codebuddy-notify.sh → shared handmux-write.cjs', () => {
  it.each(PAYLOADS)('maps %s (%s) onto the pane with the payload verbatim', (src, _event, payload) => {
    const file = freshFile();
    const obj = run(src, { file, stdin: JSON.stringify(payload) });
    // The durable spool carries every edge verbatim — including SessionEnd, which clears the latest-state row.
    expect(events(file)).toEqual([
      expect.objectContaining({
        version: 1, type: 'event', sequence: 1, paneId: '%263', src, payload,
      }),
    ]);
    if (src === 'end') {
      expect(obj['%263']).toBeUndefined(); // SessionEnd removes the binding
      return;
    }
    expect(obj['%263']).toMatchObject({ src, payload });
    expect(typeof obj['%263'].ts).toBe('number');
    expect(obj['%263'].ts).toBeGreaterThan(1_600_000_000_000); // a real ms epoch
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(obj['%263'].sequence).toBe(1);
  });

  it.each(PAYLOADS)('accepts the raw %s event name as the argument (same src vocabulary)', (src, event, payload) => {
    const file = freshFile();
    run(event, { file, stdin: JSON.stringify(payload) });
    expect(events(file)[0].src).toBe(src);
  });

  it('drops the SessionEnd src mapping onto the pane-removing path', () => {
    const file = freshFile();
    run('prompt', { file, stdin: '{"session_id":"cb-s1","prompt":"hi"}' });
    const obj = run('end', { file, stdin: '{"session_id":"cb-s1","reason":"prompt_input_exit"}' });
    expect(obj['%263']).toBeUndefined();
  });

  // A Notification that reports nothing about the turn must not become the pane's row. Reported live:
  // CodeBuddy fires `auth_success` for every running instance on a token refresh, and the row it wrote
  // ("notify", no state) left the pane with no resolvable state at all — the roster card cleared, and a
  // message queued for that pane waited for `idle` for seventeen hours, because the Core dispatches a queue
  // only when the session reads idle. The pane must keep the last event that said something.
  it('keeps the pane state when a Notification reports no turn state', () => {
    const file = freshFile();
    run('prompt', { file, stdin: '{"session_id":"cb-s1","prompt":"do it"}' });
    const done = run('stop', { file, stdin: '{"session_id":"cb-s1","last_assistant_message":"done"}' });
    expect(done['%263'].src).toBe('stop');

    const after = run('notify', { file, stdin: '{"notification_type":"auth_success","message":"Signed in"}' });
    // The pane still says what it was doing …
    expect(after['%263'].src).toBe('stop');
    expect(after['%263'].payload.last_assistant_message).toBe('done');
    // … and the noise produced no event for the Connector to act on either.
    expect(events(file)).toHaveLength(2);
  });

  // A pane's session is a property of the PANE, and this row is the only place everything downstream reads
  // it from — the Connector derives the run's session from it and the phone's 对话 entry depends on it.
  // Reported live: CodeBuddy fires `auth_success` (a Notification, and one that carries no session_id) for
  // every running instance when its token refreshes, and two panes lost their binding in the same second,
  // because the writer replaced the row wholesale. The identity is carried forward instead — but only on
  // proven sameness, never on a guess.
  it('carries the pane session through an event that has none, when the process is the same', () => {
    const file = freshFile();
    run('start', {
      file, mode: 'ancestor', procRoot: procFixture(['4242']),
      stdin: '{"session_id":"cb-s1","transcript_path":"/p/abc.jsonl"}',
    });
    const obj = run('notify', {
      file, mode: 'ancestor', procRoot: procFixture(['4242']),
      stdin: '{"notification_type":"permission_prompt","message":"needs permission"}',
    });
    expect(obj['%263'].src).toBe('notify'); // the event is recorded as it happened…
    expect(obj['%263'].payload.notification_type).toBe('permission_prompt');
    expect(obj['%263'].payload.session_id).toBe('cb-s1'); // …and the pane's identity survives it
    expect(obj['%263'].payload.transcript_path).toBe('/p/abc.jsonl');
  });

  it('does not carry it onto a different process', () => {
    const file = freshFile();
    run('start', {
      file, mode: 'ancestor', procRoot: procFixture(['4242']),
      stdin: '{"session_id":"dead-session","transcript_path":"/p/abc.jsonl"}',
    });
    // `tty` mode resolves a DIFFERENT pid (4243) for the same pane: a replacement owner must never inherit
    // the dead session, or the phone would open a conversation the pane is not running.
    const obj = run('notify', {
      file, mode: 'tty', procRoot: procFixture(['4243']),
      stdin: '{"notification_type":"permission_prompt"}',
    });
    expect(obj['%263'].payload.session_id).toBeUndefined();
    expect(obj['%263'].payload.transcript_path).toBeUndefined();
  });

  it('does not carry it when the process could not be identified at all', () => {
    const file = freshFile();
    run('start', { file, stdin: '{"session_id":"cb-s1","transcript_path":"/p/abc.jsonl"}' });
    const obj = run('notify', { file, stdin: '{"notification_type":"permission_prompt","message":"gate"}' });
    expect(obj['%263'].src).toBe('notify');
    // Nothing ties the two rows together, so no claim is made either way.
    expect(obj['%263'].payload.session_id).toBeUndefined();
  });

  it('exits 0 without touching anything for an unknown event name', () => {
    const file = freshFile();
    expect(run('PreToolUse', { file, stdin: '{"cwd":"/x"}' })).toBeNull();
    expect(run('', { file, stdin: '{}' })).toBeNull();
    expect(events(file)).toEqual([]);
  });

  it('does nothing outside tmux (no pane to key on)', () => {
    const file = freshFile();
    expect(run('stop', { file, pane: '', stdin: '{"last_assistant_message":"done"}' })).toBeNull();
    expect(events(file)).toEqual([]);
  });

  it('tolerates unreadable stdin (still exit 0, still records the edge)', () => {
    const file = freshFile();
    const obj = run('prompt', { file, stdin: 'not json' });
    expect(obj['%263']).toMatchObject({ src: 'prompt' });
  });

  it('produces no fingerprint when neither the ancestor walk nor the pane TTY names CodeBuddy', () => {
    const file = freshFile();
    const obj = run('stop', { file, mode: 'none', stdin: '{"last_assistant_message":"done"}' });
    expect(obj['%263'].process).toBeUndefined();
    expect(events(file)[0].process).toBeUndefined();
  });

  it('takes the owner from the matching ancestor command line, not from comm', () => {
    const file = freshFile();
    const obj = run('prompt', {
      file,
      mode: 'ancestor',
      procRoot: procFixture(['4242']),
      stdin: '{"session_id":"cb-s1","prompt":"hi"}',
    });

    expect(obj['%263'].process).toEqual({ pid: 4242, startedAt: 473349, tty: '/dev/ttys007' });
    expect(events(file)[0].process).toEqual(obj['%263'].process);
  });

  it('falls back to the pane TTY scan when the hook was reparented, ignoring the wrapper row', () => {
    const file = freshFile();
    const obj = run('start', {
      file,
      mode: 'tty',
      procRoot: procFixture(['4243']),
      stdin: '{"session_id":"cb-s1","transcript_path":"/p/abc.jsonl"}',
    });

    // 4242 is this very hook's `sh …handmux-codebuddy-notify.sh` wrapper: never the owner.
    expect(obj['%263'].process).toEqual({ pid: 4243, startedAt: 473349, tty: '/dev/ttys007' });
  });

  it('falls back to lstart when procfs is unavailable (macOS), forcing the C locale', () => {
    const file = freshFile();
    const obj = run('start', {
      file,
      mode: 'tty',
      procRoot: path.join(tmpHome('cb-empty-proc-'), 'proc'),
      stdin: '{"session_id":"cb-s1","transcript_path":"/p/abc.jsonl"}',
    });

    expect(obj['%263'].process).toEqual({
      pid: 4243,
      startedAt: Date.parse('Tue Aug 12 04:00:00 2026'),
      tty: '/dev/ttys007',
    });
  });

  it('leaves the fingerprint empty when the pane TTY has more than one CodeBuddy row', () => {
    const file = freshFile();
    const obj = run('stop', {
      file,
      mode: 'ambiguous',
      procRoot: procFixture(['4243', '4245']),
      stdin: '{"last_assistant_message":"done"}',
    });

    expect(obj['%263'].process).toBeUndefined();
    expect(events(file)[0].process).toBeUndefined();
  });

  it('writes the spool under HANDMUX_CODEBUDDY_EVENTS, not a Claude path', () => {
    const file = freshFile();
    const dir = `${file}.events`;
    expect(fs.existsSync(dir)).toBe(false);
    run('prompt', { file, stdin: '{"session_id":"cb-s1","prompt":"hi"}' });
    expect(fs.existsSync(dir)).toBe(true);
    expect(events(file)[0]).toMatchObject({ paneId: '%263', src: 'prompt', sessionId: 'cb-s1' });
  });

  it('keeps the latest-state file working when the spool is unavailable', () => {
    const file = freshFile();
    const blocked = `${file}.blocked`;
    fs.mkdirSync(path.dirname(blocked), { recursive: true });
    fs.writeFileSync(blocked, 'not a directory');
    const obj = run('prompt', {
      file, env: { HANDMUX_CODEBUDDY_EVENTS: blocked }, stdin: '{"session_id":"cb-s1","prompt":"still works"}',
    });
    expect(obj['%263']).toMatchObject({ src: 'prompt', payload: { prompt: 'still works' } });
    expect(obj['%263'].sequence).toBeUndefined();
  });

  it('keeps each pane separate', () => {
    const file = freshFile();
    run('prompt', { file, pane: '%1', stdin: '{"prompt":"a"}' });
    const obj = run('prompt', { file, pane: '%2', stdin: '{"prompt":"b"}' });
    expect(obj['%1'].payload.prompt).toBe('a');
    expect(obj['%2'].payload.prompt).toBe('b');
  });
});
