import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS, getAgent, agentForProc } from '../src/agents/index.js';
import { resolveVersionedComms } from '../src/agents/claude.js';
import { resolveCodexComms } from '../src/agents/codex.js';
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
      expect(typeof a.sessions.resumeArgs).toBe('function');
    }
  });

  it('builds resume commands as fixed argument arrays', () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    expect(getAgent('claude').sessions.resumeArgs(id)).toEqual(['claude', '--resume', id]);
    expect(getAgent('codex').sessions.resumeArgs(id)).toEqual(['codex', 'resume', id]);
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
  // run stub: ps lists tty/pid/comm (comm is the self-set title 'claude' — it does NOT match tmux's
  // version report, verified live); lsof txt gives the real exe path, which is what we tie on.
  const RUN = (psLines, exeByPid) => async (cmd, args) => {
    if (cmd === 'ps') return psLines.join('\n');
    if (cmd === 'lsof') {
      const pid = args[args.indexOf('-p') + 1];
      const exe = exeByPid[pid];
      return exe ? `p${pid}\nftxt\nn${exe}\n` : '';
    }
    return '';
  };
  it('normalizes cmd → claude only when the real exe path carries "claude" (any install layout)', async () => {
    const panes = [
      { id: '%1', cmd: '2_1_196', tty: '/dev/ttys010' },  // native install
      { id: '%2', cmd: '2_1_196', tty: '/dev/ttys011' },  // some OTHER binary that happens to be version-named
      { id: '%3', cmd: 'zsh', tty: '/dev/ttys012' },
      { id: '%4', cmd: '2_1_196', tty: '/dev/ttys013' },  // hypothetical other official layout
      { id: '%5', cmd: '2_1_196', tty: '/dev/ttys014' },  // claude in path but wrong basename → no tie
    ];
    const run = RUN(
      ['ttys010 4242 S+', 'ttys011 4343 S+', 'ttys013 4545 S+', 'ttys014 4646 S+'],
      {
        4242: '/Users/x/.local/share/claude/versions/2.1.196',
        4343: '/opt/sometool/2.1.196',
        4545: '/usr/local/Caskroom/claude-code@latest/2.1.196/2.1.196',
        4646: '/Users/x/claude-tools/helper',
      },
    );
    await resolveVersionedComms(panes, run);
    expect(panes[0].cmd).toBe('claude');
    expect(panes[1].cmd).toBe('2_1_196'); // no "claude" anywhere in its path → untouched
    expect(panes[2].cmd).toBe('zsh');
    expect(panes[3].cmd).toBe('claude');
    expect(panes[4].cmd).toBe('2_1_196'); // basename ≠ version comm → untouched
  });
  it('does not call ps at all when no semver-shaped comm is present', async () => {
    const panes = [{ id: '%1', cmd: 'claude', tty: 'ttys010' }, { id: '%2', cmd: 'zsh', tty: 'ttys011' }];
    let called = false;
    await resolveVersionedComms(panes, async () => { called = true; return ''; });
    expect(called).toBe(false);
    expect(panes[0].cmd).toBe('claude');
  });
  it('a semver comm without a tty is ignored (and ps never runs)', async () => {
    const panes = [{ id: '%1', cmd: '2_1_196' }];
    let called = false;
    await resolveVersionedComms(panes, async () => { called = true; return ''; });
    expect(called).toBe(false);
    expect(panes[0].cmd).toBe('2_1_196');
  });
  it('refreshes ps identity every call but caches lsof only while the foreground pid is unchanged', async () => {
    let psCalls = 0, lsofCalls = 0;
    const run = async (cmd) => {
      if (cmd === 'ps') { psCalls++; return 'ttys020 4242 S+'; }
      if (cmd === 'lsof') { lsofCalls++; return 'p4242\nftxt\nn/Users/x/.local/share/claude/versions/2.1.196\n'; }
      return '';
    };
    const verdicts = new Map();
    const mk = () => [{ id: '%1', cmd: '2_1_196', tty: '/dev/ttys020' }];
    expect((await resolveVersionedComms(mk(), run, verdicts))[0].cmd).toBe('claude');
    expect((await resolveVersionedComms(mk(), run, verdicts))[0].cmd).toBe('claude');
    expect(psCalls).toBe(2);
    expect(lsofCalls).toBe(1);
  });
  it('retries a failed executable probe after the short negative TTL', async () => {
    let now = 1000;
    let lsofCalls = 0;
    const run = async (cmd) => {
      if (cmd === 'ps') return 'ttys020 4242 S+';
      if (cmd === 'lsof') {
        lsofCalls++;
        return lsofCalls === 1 ? 'p4242\nftxt\nn/opt/other/2.1.196\n'
          : 'p4242\nftxt\nn/Users/x/.local/share/claude/versions/2.1.196\n';
      }
      return '';
    };
    const verdicts = new Map();
    const mk = () => [{ id: '%1', cmd: '2_1_196', tty: '/dev/ttys020' }];
    expect((await resolveVersionedComms(mk(), run, verdicts, { now: () => now }))[0].cmd).toBe('2_1_196');
    now += 1000;
    expect((await resolveVersionedComms(mk(), run, verdicts, { now: () => now }))[0].cmd).toBe('2_1_196');
    expect(lsofCalls).toBe(1);
    now += 3000;
    expect((await resolveVersionedComms(mk(), run, verdicts, { now: () => now }))[0].cmd).toBe('claude');
    expect(lsofCalls).toBe(2);
  });
  it('Linux fallback: lsof empty → /proc readlink (best effort, never throws)', async () => {
    const panes = [{ id: '%1', cmd: '2.1.196', tty: 'pts/3' }];
    const run = RUN(['pts/3 4242 S+'], {});
    await resolveVersionedComms(panes, run);
    expect(['2.1.196', 'claude']).toContain(panes[0].cmd); // platform-dependent; never throws
  });
});

describe('resolveCodexComms (ambiguous node launcher)', () => {
  it('normalizes node only when a foreground real executable proves Codex', async () => {
    const panes = [
      { id: '%1', cmd: 'node', tty: '/dev/ttys030' },
      { id: '%2', cmd: 'node', tty: '/dev/ttys031' },
    ];
    const run = async (cmd, args) => {
      if (cmd === 'ps') return 'ttys030 501 S+\nttys030 502 R+\nttys031 601 S+';
      if (cmd === 'lsof') {
        const pid = args[args.indexOf('-p') + 1];
        const exe = { 501: '/usr/local/bin/node', 502: '/opt/@openai/codex/bin/codex', 601: '/usr/local/bin/node' }[pid];
        return exe ? `p${pid}\nftxt\nn${exe}\n` : '';
      }
      return '';
    };
    await resolveCodexComms(panes, run);
    expect(panes[0].cmd).toBe('codex');
    expect(panes[1].cmd).toBe('node');
  });

  it('invalidates a cached success immediately when the foreground pid set changes', async () => {
    let phase = 1;
    const run = async (cmd, args) => {
      if (cmd === 'ps') return phase === 1 ? 'ttys030 501 S+\nttys030 502 R+' : 'ttys030 701 S+';
      if (cmd === 'lsof') {
        const pid = args[args.indexOf('-p') + 1];
        const exe = pid === '502' ? '/opt/@openai/codex/bin/codex' : '/usr/local/bin/node';
        return `p${pid}\nftxt\nn${exe}\n`;
      }
      return '';
    };
    const verdicts = new Map();
    const mk = () => [{ id: '%1', cmd: 'node', tty: '/dev/ttys030' }];
    expect((await resolveCodexComms(mk(), run, verdicts))[0].cmd).toBe('codex');
    phase = 2;
    expect((await resolveCodexComms(mk(), run, verdicts))[0].cmd).toBe('node');
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
