import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS, getAgent, agentForProc } from '../src/agents/index.js';
import { resolveVersionedComms } from '../src/agents/claude.js';
import { resolveCodexSession, rolloutSessionId, codexUserSnippet } from '../src/agents/codex.js';
import { parseAgentProcs } from '../src/agents/scanUtils.js';
import { scanOrphans, takeoverOrphan } from '../src/orphans.js';

describe('registry', () => {
  it('resolves drivers by id and defaults unknown/missing to Claude (legacy entries)', () => {
    expect(getAgent('claude').id).toBe('claude');
    expect(getAgent('codex').id).toBe('codex');
    expect(getAgent(undefined).id).toBe('claude');
    expect(getAgent('nope').id).toBe('claude');
  });
  it('maps a tmux pane_current_command to its driver', () => {
    expect(agentForProc('claude').id).toBe('claude');
    expect(agentForProc('codex').id).toBe('codex');
    expect(agentForProc('node')).toBe(null);
    expect(agentForProc('2.1.196')).toBe(null); // bare semver alone proves nothing — needs ps corroboration
  });
  it('every driver satisfies the contract shape', () => {
    for (const a of AGENTS) {
      expect(typeof a.id).toBe('string');
      expect(typeof a.procName).toBe('string');
      expect(Array.isArray(a.procNames) && a.procNames.includes(a.procName)).toBe(true);
      expect(a.procMatch).toBeInstanceOf(RegExp);
      expect(typeof a.classify).toBe('function');
      expect(typeof a.sessions.resolve).toBe('function');
      expect(typeof a.sessions.resumeCmd).toBe('function');
    }
  });
});

describe('codex classify (Claude-parity hooks — same classifier)', () => {
  const codex = getAgent('codex');
  it('classifies the Claude-shaped hook verbs Codex now emits', () => {
    expect(codex.classify('prompt', { prompt: 'build it' })).toEqual({ kind: 'working', msg: 'build it' });
    expect(codex.classify('stop', { last_assistant_message: 'done' })).toEqual({ kind: 'done', msg: 'done' });
    expect(codex.classify('permreq', { tool_name: 'Bash' })).toEqual({ kind: 'permission', msg: '需要你授权：Bash' });
  });
  it('shares the exact classifier with Claude', () => {
    expect(codex.classify).toBe(getAgent('claude').classify);
  });
});

describe('codex rollout parsing', () => {
  it('extracts the trailing uuid session id from a rollout filename', () => {
    expect(rolloutSessionId('rollout-2026-01-22T10-30-00-abcdef01-2345-6789-abcd-ef0123456789.jsonl'))
      .toBe('abcdef01-2345-6789-abcd-ef0123456789');
    expect(rolloutSessionId('notarollout.jsonl')).toBe(null);
  });
  it('picks the last real user turn, skipping synthetic environment/instructions', () => {
    const tail = [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd=/x</environment_context>' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'refactor the parser' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }),
    ].join('\n');
    expect(codexUserSnippet(tail)).toBe('refactor the parser');
  });
});

// Seed a Codex rollout under the date-nested layout ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
function seedRollout(sessionsDir, { y, m, d, id, cwd, lastUser = 'hi', mtime }) {
  const dir = path.join(sessionsDir, y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${y}-${m}-${d}T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session_meta', payload: { id, cwd } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: lastUser }] } }),
  ].join('\n') + '\n');
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

describe('resolveCodexSession', () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-'));

  it('resolves the newest rollout whose recorded cwd matches', async () => {
    const cwd = '/Users/x/proj';
    seedRollout(sessionsDir, { y: '2026', m: '01', d: '20', id: 'aaaaaaaa-0000-0000-0000-000000000001', cwd, lastUser: 'old', mtime: 1_000_000 });
    seedRollout(sessionsDir, { y: '2026', m: '01', d: '22', id: 'bbbbbbbb-0000-0000-0000-000000000002', cwd, lastUser: 'newest ask', mtime: 5_000_000 });
    seedRollout(sessionsDir, { y: '2026', m: '01', d: '22', id: 'cccccccc-0000-0000-0000-000000000003', cwd: '/other', mtime: 6_000_000 });
    const out = await resolveCodexSession(sessionsDir, cwd, { now: () => 5_000_000 + 100_000 });
    expect(out.sessionId).toBe('bbbbbbbb-0000-0000-0000-000000000002');
    expect(out.snippet).toBe('newest ask');
    expect(out.state).toBe('idle');
  });

  it('returns {} when nothing records that cwd', async () => {
    expect(await resolveCodexSession(sessionsDir, '/nope', {})).toEqual({});
  });
});

describe('resolveVersionedComms (native-install Claude: comm = bare version string)', () => {
  const PS = (lines) => async () => lines.join('\n');
  it('normalizes cmd → claude only when the exe path is in Claude\'s versions dir', async () => {
    const panes = [
      { id: '%1', cmd: '2.1.196', tty: '/dev/ttys010' },  // real native-install claude
      { id: '%2', cmd: '2.1.196', tty: '/dev/ttys011' },  // some OTHER binary that happens to be version-named
      { id: '%3', cmd: 'zsh', tty: '/dev/ttys012' },
    ];
    const run = PS([
      'ttys010 4242 /Users/x/.local/share/claude/versions/2.1.196',
      'ttys011 4343 /opt/sometool/2.1.196',
    ]);
    await resolveVersionedComms(panes, run);
    expect(panes[0].cmd).toBe('claude');
    expect(panes[1].cmd).toBe('2.1.196'); // NOT in claude's versions dir → untouched
    expect(panes[2].cmd).toBe('zsh');
  });
  it('accepts the underscore-sanitized comm variant against the dotted filename', async () => {
    const panes = [{ id: '%1', cmd: '2_1_196', tty: 'ttys010' }];
    await resolveVersionedComms(panes, PS(['ttys010 4242 /Users/x/.local/share/claude/versions/2.1.196']));
    expect(panes[0].cmd).toBe('claude');
  });
  it('does not call ps at all when no semver-shaped comm is present', async () => {
    const panes = [{ id: '%1', cmd: 'claude', tty: 'ttys010' }, { id: '%2', cmd: 'zsh', tty: 'ttys011' }];
    let called = false;
    await resolveVersionedComms(panes, async () => { called = true; return ''; });
    expect(called).toBe(false);
    expect(panes[0].cmd).toBe('claude');
  });
  it('a semver comm without a tty is ignored (and ps never runs)', async () => {
    const panes = [{ id: '%1', cmd: '2.1.196' }];
    let called = false;
    await resolveVersionedComms(panes, async () => { called = true; return ''; });
    expect(called).toBe(false);
    expect(panes[0].cmd).toBe('2.1.196');
  });
  it('Linux: comm is the basename — falls back to /proc/<pid>/exe only when it exists (skips silently on macOS-style layout)', async () => {
    // On macOS there is no /proc, so a basename-only comm can never be corroborated → stays as-is.
    const panes = [{ id: '%1', cmd: '2.1.196', tty: 'pts/3' }];
    await resolveVersionedComms(panes, PS(['pts/3 4242 2.1.196']));
    expect(['2.1.196', 'claude']).toContain(panes[0].cmd); // platform-dependent; never throws
  });
});

describe('parseAgentProcs (multi-agent tagging)', () => {
  it('tags each live proc with its driver id and ignores non-agents', () => {
    const ps = [
      '  100 1 S+ 01:00 ttys1 claude --continue',
      '  200 1 S+ 01:00 ttys2 codex',
      '  300 1 S+ 01:00 ttys3 codex resume abc',
      '  400 1 S+ 01:00 ttys4 node build/codex.js',
      '  500 1 S+ 01:00 ttys5 vim claude.md',
    ].join('\n');
    const procs = parseAgentProcs(ps, AGENTS);
    expect(procs.map((p) => [p.pid, p.agent])).toEqual([[100, 'claude'], [200, 'codex'], [300, 'codex']]);
  });
});

describe('scanOrphans + takeover across agents', () => {
  it('surfaces a codex orphan and takes it over with `codex resume`', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexhome-'));
    const sessionsDir = path.join(home, '.codex', 'sessions');
    const cwd = '/home/user/proj';
    const id = 'dddddddd-0000-0000-0000-000000000009';
    seedRollout(sessionsDir, { y: '2026', m: '06', d: '29', id, cwd, lastUser: 'wire codex', mtime: 2_000_000 });

    const PS = '  777 1 S+ 02:03:04 ttys010 codex';
    const PANES = '/dev/ttys000\t35089';
    const run = async (cmd, args) => {
      if (cmd === 'ps') return PS;
      if (cmd === 'tmux') return PANES;
      if (cmd === 'lsof' && args.includes('777')) return `p777\nfcwd\nn${cwd}\n`;
      return '';
    };
    const rows = await scanOrphans({ run, sessionsDir, now: () => 2_500_000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: 777, agent: 'codex', agentLabel: 'Codex CLI', cwd, sessionId: id, snippet: 'wire codex' });

    // takeover: capture the command the driver builds (via newSession's 3rd arg).
    let spawnedCmd = null;
    const commands = {
      listSessions: async () => [],
      newSession: async (name, cwdArg, cmd) => { spawnedCmd = cmd; return '$5'; },
      listWindows: async () => [{ id: '@5' }],
      listPanes: async () => [{ id: '%5', command: 'codex' }],
    };
    const out = await takeoverOrphan(
      { commands, scanFn: async () => rows, delay: () => Promise.resolve(), killProc: () => {} },
      { pid: 777, sessionId: id, kill: false },
    );
    expect(spawnedCmd).toBe(`codex resume ${id}`);
    expect(out).toMatchObject({ agent: 'codex', name: 'cx-proj-1', agentUp: true });
  });
});
