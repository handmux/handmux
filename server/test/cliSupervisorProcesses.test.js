import { describe, it, expect, vi } from 'vitest';
import { parseSupervisorPids, scanSupervisorPids, terminateSupervisorPids } from '../src/cli/supervisorProcesses.js';

describe('supervisor process detection', () => {
  it('finds packaged/manual/service supervisors across install paths and ignores lookalikes/zombies', () => {
    const ps = [
      '  101 Ss   /usr/bin/node /usr/lib/node_modules/handmux/bin/handmux.js __supervise --payload abc',
      '  202 S    /opt/homebrew/Cellar/node/24/bin/node /opt/homebrew/Cellar/handmux/1/libexec/bin/handmux.js __supervise --payload def',
      '  250 S    /usr/bin/node /usr/local/bin/handmux __supervise --payload symlink-entry',
      '  275 S    /usr/bin/node /usr/local/bin/handmux __supervise --payload-file /home/u/.handmux/supervisor-config.json',
      '  303 Z    /usr/bin/node /x/handmux.js __supervise --payload zombie',
      '  404 S    node /x/handmux.js status',
      '  505 S    sh -c node /x/handmux.js __supervise --payload shell-text-only',
      '  606 S    node -e setInterval /x/handmux.js __supervise --payload test-argv',
    ].join('\n');
    expect(parseSupervisorPids(ps)).toEqual([101, 202, 250, 275]);
  });

  it('deduplicates/sorts pids and scans only the current user process table', () => {
    const run = vi.fn(() => ({ status: 0, stdout: [
      '9 S node /x/handmux.js __supervise --payload a',
      '2 S node /x/handmux.js __supervise --payload b',
      '9 S node /x/handmux.js __supervise --payload a',
    ].join('\n') }));
    expect(scanSupervisorPids({ run })).toEqual({ ok: true, pids: [2, 9] });
    expect(run).toHaveBeenCalledWith('ps', ['-x', '-o', 'pid=,stat=,args='], { encoding: 'utf8' });
  });

  it('fails closed when ps cannot be read', () => {
    expect(scanSupervisorPids({ run: () => ({ status: 1, stdout: '' }) })).toEqual({ ok: false, pids: [] });
    expect(scanSupervisorPids({ run: () => { throw new Error('ENOENT'); } })).toEqual({ ok: false, pids: [] });
  });

  it('terminates every initial and newly-observed duplicate before succeeding', async () => {
    const scans = [
      { ok: true, pids: [20, 30] },
      { ok: true, pids: [30] },
      { ok: true, pids: [] },
    ];
    const kill = vi.fn();
    const result = await terminateSupervisorPids([10, 20], {
      scan: () => scans.shift(), kill, waitFn: async () => {}, now: () => 0,
    });
    expect(result).toEqual({ ok: true, pids: [10, 20, 30], remaining: [] });
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual([10, 20, 20, 30, 30]);
  });

  it('fails closed on a rescan error or a supervisor that will not exit', async () => {
    const scanFail = await terminateSupervisorPids([1], {
      scan: () => ({ ok: false, pids: [] }), kill: () => {}, waitFn: async () => {}, now: () => 0,
    });
    expect(scanFail).toMatchObject({ ok: false, reason: 'scan', pids: [1] });

    let tick = 0;
    const timeout = await terminateSupervisorPids([2], {
      scan: () => ({ ok: true, pids: [2] }), kill: () => {}, waitFn: async () => {},
      now: () => ++tick, timeoutMs: 1,
    });
    expect(timeout).toEqual({ ok: false, reason: 'timeout', pids: [2], remaining: [2] });
  });
});
