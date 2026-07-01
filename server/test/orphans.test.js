import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseClaudeProcs, parsePaneMembership, findOrphans, encodeProjectDir,
  isSessionUuid, lastUserSnippet, resolveSession, scanOrphans,
} from '../src/orphans.js';

const PS = [
  '  4717 72161 S+  ttys010  claude',
  ' 10368 10357 S+  ttys018  claude --continue',
  '  5572  5561 S+  ttys036  claude --continue',
  '  9999     1 S   ??       claude -p "one shot"',       // no tty → not a takeover candidate
  '  8888  1234 S+  ttys099  node build/claude.js',       // not the claude CLI → ignored
  '  7777  1234 S+  ttys098  vim claude.md',              // ignored
  '  6666 72161 T   ttys010  claude',                     // Ctrl-Z suspended → dropped
  '  6667 72161 Z   ttys010  claude',                     // zombie → dropped
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
    const procs = parseClaudeProcs('  111 10357 S+ ttysXX  claude');
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
    const rows = await scanOrphans({ run, projectsDir, now: () => 2_500_000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pid: 4717, cwd, cwdLabel: 'zxy', state: 'idle',
      sessionId: 'eeeeeeee-0000-0000-0000-000000000005', snippet: 'refactor parser',
    });
  });
});
