import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseClaudeProcs, parsePaneMembership, findOrphans, encodeProjectDir,
  isSessionUuid, lastUserSnippet, resolveSession, scanOrphans,
  etimeToMs, takeoverSessionName, takeoverOrphan,
} from '../src/orphans.js';

const UUID = 'eeeeeeee-0000-0000-0000-000000000005';

const PS = [
  '  4717 72161 S+  02:03:04    ttys010  claude',
  ' 10368 10357 S+  01:00       ttys018  claude --continue',
  '  5572  5561 S+  05:00       ttys036  claude --continue',
  '  9999     1 S   10:00       ??       claude -p "one shot"',  // no tty → not a takeover candidate
  '  8888  1234 S+  10:00       ttys099  node build/claude.js',  // not the claude CLI → ignored
  '  7777  1234 S+  10:00       ttys098  vim claude.md',         // ignored
  '  6666 72161 T   3-04:05:06  ttys010  claude',                // Ctrl-Z suspended → dropped
  '  6667 72161 Z   00:01       ttys010  claude',                // zombie → dropped
].join('\n');

const PANES = [
  '/dev/ttys018\t10357',   // pid 10368's parent shell → in tmux
  '/dev/ttys036\t5561',    // pid 5572's parent shell → in tmux
  '/dev/ttys000\t35089',
].join('\n');

describe('process parsing', () => {
  it('parses live claude CLI processes, dropping stopped/zombie', () => {
    const procs = parseClaudeProcs(PS);
    expect(procs.map((p) => p.pid)).toEqual([4717, 10368, 5572, 9999]); // 6666(T)/6667(Z) dropped
    expect(procs.find((p) => p.pid === 4717)).toMatchObject({ ppid: 72161, tty: 'ttys010' });
    expect(procs.find((p) => p.pid === 9999).tty).toBe(''); // '??' folded to ''
  });

  it('normalizes tmux pane ttys (/dev/ stripped) and collects pane pids', () => {
    const m = parsePaneMembership(PANES);
    expect(m.ttys.has('ttys018')).toBe(true);
    expect(m.pids.has(10357)).toBe(true);
  });

  it('finds only the tty-having claude not in any tmux pane', () => {
    const orphans = findOrphans(parseClaudeProcs(PS), parsePaneMembership(PANES));
    // 10368/5572 are in tmux (tty & ppid match); 9999 has no tty; only 4717 (cwd zxy) is an orphan.
    expect(orphans.map((o) => o.pid)).toEqual([4717]);
  });

  it('treats ppid match as in-tmux even if tty differs', () => {
    const procs = parseClaudeProcs('  111 10357 S+ 01:00 ttysXX  claude');
    const orphans = findOrphans(procs, parsePaneMembership(PANES));
    expect(orphans).toHaveLength(0); // ppid 10357 is a pane shell
  });
});

describe('encoding + validation', () => {
  it('encodes cwd to project dir folding / and _ to -', () => {
    expect(encodeProjectDir('/home/user/handmux'))
      .toBe('-home-user-handmux');
  });
  it('validates session uuids (guards shell injection on takeover)', () => {
    expect(isSessionUuid('4442e3d0-8d46-4cce-9822-b86558f69922')).toBe(true);
    expect(isSessionUuid('foo; rm -rf ~')).toBe(false);
    expect(isSessionUuid('')).toBe(false);
  });
});

describe('lastUserSnippet', () => {
  it('picks the newest user turn, ignoring meta rows, and truncates', () => {
    const tail = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'first thing' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'the last ask' }] } }),
      JSON.stringify({ type: 'last-prompt', foo: 1 }),
      JSON.stringify({ type: 'ai-title', title: 'x' }),
    ].join('\n');
    expect(lastUserSnippet(tail)).toBe('the last ask');
  });
  it('skips a truncated leading line', () => {
    const tail = 'e":"user"}}\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'clean' } });
    expect(lastUserSnippet(tail)).toBe('clean');
  });
});

function seed(projectsDir, cwd, sessionId, { cwdField = cwd, lastUser = 'hi', mtime } = {}) {
  const dir = path.join(projectsDir, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'attachment', cwd: cwdField }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: lastUser } }),
  ].join('\n') + '\n');
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

describe('resolveSession', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orph-'));
  const projectsDir = path.join(home, 'projects');

  it('resolves newest matching-cwd jsonl → sessionId/snippet/state', async () => {
    const cwd = '/Users/x/proj';
    seed(projectsDir, cwd, 'aaaaaaaa-0000-0000-0000-000000000001', { lastUser: 'old', mtime: 1_000_000 });
    seed(projectsDir, cwd, 'bbbbbbbb-0000-0000-0000-000000000002', { lastUser: 'newest ask', mtime: 5_000_000 });
    const out = await resolveSession(projectsDir, cwd, { now: () => 5_000_000 + 100_000 });
    expect(out.sessionId).toBe('bbbbbbbb-0000-0000-0000-000000000002');
    expect(out.snippet).toBe('newest ask');
    expect(out.state).toBe('idle'); // 100s > busyMs
  });

  it('marks busy when mtime is fresh', async () => {
    const cwd = '/Users/x/fresh';
    seed(projectsDir, cwd, 'cccccccc-0000-0000-0000-000000000003', { mtime: 9_000_000 });
    const out = await resolveSession(projectsDir, cwd, { now: () => 9_000_000 + 2_000 });
    expect(out.state).toBe('busy');
  });

  it('skips a jsonl whose recorded cwd collided onto the same dir', async () => {
    // '/a/b' and '/a-b' both encode to '-a-b'; only the one whose cwd field matches wins.
    seed(projectsDir, '/a-b', 'dddddddd-0000-0000-0000-000000000004', { cwdField: '/a-b', lastUser: 'wrong' });
    const out = await resolveSession(projectsDir, '/a/b', {});
    expect(out.sessionId).toBeUndefined(); // no jsonl records cwd '/a/b'
  });

  it('returns {} when the project dir does not exist', async () => {
    expect(await resolveSession(projectsDir, '/nope/nope', {})).toEqual({});
  });
});

describe('scanOrphans (injected run)', () => {
  it('wires ps+tmux+lsof+jsonl into one orphan row', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orph2-'));
    const projectsDir = path.join(home, 'projects');
    const cwd = '/home/user/zxy';
    seed(projectsDir, cwd, 'eeeeeeee-0000-0000-0000-000000000005', { lastUser: 'refactor parser', mtime: 2_000_000 });
    const run = async (cmd, args) => {
      if (cmd === 'ps') return PS;
      if (cmd === 'tmux') return PANES;
      if (cmd === 'lsof' && args.includes('4717')) return `p4717\nfcwd\nn${cwd}\n`;
      return '';
    };
    const NOW = 2_500_000;
    const rows = await scanOrphans({ run, projectsDir, now: () => NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pid: 4717, cwd, cwdLabel: 'zxy', state: 'idle',
      sessionId: UUID, snippet: 'refactor parser', suggestedName: 'cc-zxy-1',
    });
    // startedAt = now - etime (4717's etime '02:03:04' = 7384s)
    expect(rows[0].startedAt).toBe(NOW - 7384 * 1000);
  });
});

describe('etimeToMs', () => {
  it('parses MM:SS, HH:MM:SS, DD-HH:MM:SS', () => {
    expect(etimeToMs('01:00')).toBe(60_000);
    expect(etimeToMs('02:03:04')).toBe(7384_000);
    expect(etimeToMs('3-04:05:06')).toBe((3 * 86400 + 4 * 3600 + 5 * 60 + 6) * 1000);
    expect(etimeToMs('')).toBe(0);
  });
});

describe('takeoverSessionName', () => {
  it('produces a valid tmux session name within 16 chars', () => {
    expect(takeoverSessionName('zxy', 1)).toBe('cc-zxy-1');
    expect(takeoverSessionName('a-very-long-basename', 2)).toMatch(/^cc-[A-Za-z0-9]{1,8}-2$/);
    expect(takeoverSessionName('', 1)).toBe('cc-cc-1');
    expect(takeoverSessionName('!!!', 1)).toBe('cc-cc-1'); // non-alnum stripped
  });
});

describe('takeoverOrphan', () => {
  const orphan = { pid: 4717, sessionId: UUID, cwd: '/home/user/zxy', cwdLabel: 'zxy' };
  const nap = () => Promise.resolve();

  function fakeCommands({ paneCmds, existing = [{ id: '$1', name: 'jly' }], created }) {
    let poll = 0;
    return {
      listSessions: async () => existing,
      newSession: async (name) => { if (created) created.push(name); return '$9'; },
      listWindows: async () => [{ id: '@9' }],
      newWindow: async () => '@9',
      listPanes: async () => [{ id: '%9', command: paneCmds[Math.min(poll++, paneCmds.length - 1)] }],
    };
  }

  it('spawns a new session, confirms claude up, then SIGTERMs the original', async () => {
    const killed = [];
    const out = await takeoverOrphan({
      commands: fakeCommands({ paneCmds: ['zsh', 'zsh', 'node'] }), // shell → shell → claude up
      scanFn: async () => [orphan],
      killProc: (pid, sig) => killed.push([pid, sig]),
      delay: nap,
    }, { pid: 4717, sessionId: UUID, kill: true });
    expect(out).toMatchObject({ session: '$9', name: 'cc-zxy-1', window: '@9', pane: '%9', claudeUp: true, killed: true });
    expect(killed).toEqual([[4717, 'SIGTERM']]);
  });

  it('does NOT kill when the resumed claude never comes up', async () => {
    const killed = [];
    const out = await takeoverOrphan({
      commands: fakeCommands({ paneCmds: ['zsh'] }), // stays a shell forever
      scanFn: async () => [orphan],
      killProc: (pid, sig) => killed.push([pid, sig]),
      delay: nap, pollTries: 3,
    }, { pid: 4717, sessionId: UUID, kill: true });
    expect(out.claudeUp).toBe(false);
    expect(out.killed).toBe(false);
    expect(killed).toEqual([]);
  });

  it('respects kill:false (takeover without killing)', async () => {
    const killed = [];
    const out = await takeoverOrphan({
      commands: fakeCommands({ paneCmds: ['node'] }),
      scanFn: async () => [orphan],
      killProc: (pid, sig) => killed.push([pid, sig]),
      delay: nap,
    }, { pid: 4717, sessionId: UUID, kill: false });
    expect(out.claudeUp).toBe(true);
    expect(out.killed).toBe(false);
    expect(killed).toEqual([]);
  });

  it('honours a user-typed session name (sanitized to tmux rules)', async () => {
    const created = [];
    const out = await takeoverOrphan({
      commands: fakeCommands({ paneCmds: ['node'], created }),
      scanFn: async () => [orphan], delay: nap,
    }, { pid: 4717, sessionId: UUID, kill: false, name: 'My Work!!' });
    expect(created).toEqual(['My-Work']); // spaces/punct → single hyphen, trimmed
    expect(out).toMatchObject({ name: 'My-Work' });
  });

  it('dedupes a user-typed name that collides with an existing session', async () => {
    const created = [];
    const out = await takeoverOrphan({
      commands: fakeCommands({ paneCmds: ['node'], existing: [{ id: '$1', name: 'jly' }], created }),
      scanFn: async () => [orphan], delay: nap,
    }, { pid: 4717, sessionId: UUID, kill: false, name: 'jly' });
    expect(created).toEqual(['jly-2']); // 'jly' taken → numeric suffix
    expect(out).toMatchObject({ name: 'jly-2' });
  });

  it('falls back to the generated name when no name is sent', async () => {
    const created = [];
    await takeoverOrphan({
      commands: fakeCommands({ paneCmds: ['node'], created }),
      scanFn: async () => [orphan], delay: nap,
    }, { pid: 4717, sessionId: UUID, kill: false });
    expect(created).toEqual(['cc-zxy-1']);
  });

  it('rejects a non-UUID sessionId (shell-injection guard)', async () => {
    const out = await takeoverOrphan({ commands: {}, scanFn: async () => [] },
      { pid: 4717, sessionId: 'x; rm -rf ~', kill: true });
    expect(out).toMatchObject({ status: 400 });
  });

  it('409s when the pid is no longer an orphan', async () => {
    const out = await takeoverOrphan({ commands: {}, scanFn: async () => [] },
      { pid: 4717, sessionId: UUID, kill: true });
    expect(out).toMatchObject({ status: 409 });
  });

  it('409s when the pid now maps to a different session', async () => {
    const out = await takeoverOrphan({ commands: {}, scanFn: async () => [{ ...orphan, sessionId: 'ffffffff-0000-0000-0000-000000000000' }] },
      { pid: 4717, sessionId: UUID, kill: true });
    expect(out).toMatchObject({ status: 409 });
  });
});
