import { promises as fsp } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalAgentProcessContext,
  processStartedAt,
  TmuxAgentPaneSource,
} from '../src/agent-runtime/tmuxRuntime.js';
import { defaultRun } from '../src/agents/scanUtils.js';

// Fixture PIDs must never resolve against the host's live /proc. That needs BOTH lookups stubbed:
// `readlink` is the executable path, and `processStartedAt` reads /proc/<pid>/stat *before* it consults
// the injected `run` — so on a Linux runner, where the fixture pid 999 really is a live process, the
// stat read answers for a pid the `run` mock was told does not exist.
beforeEach(() => {
  vi.spyOn(fsp, 'readFile').mockRejectedValue(new Error('fixture proc unavailable'));
  vi.spyOn(fsp, 'readlink').mockRejectedValue(new Error('fixture proc unavailable'));
});
afterEach(() => vi.restoreAllMocks());

function live(command = 'pi') {
  return {
    id: '%1', cmd: command, tty: '/dev/ttys001',
    session: 'main', window: '@1', windowName: 'agent',
  };
}

describe('Tmux Agent Runtime context', () => {
  it('runs parsed system commands with a stable machine locale', async () => {
    await expect(defaultRun(process.execPath, [
      '-e',
      'process.stdout.write(`${process.env.LC_ALL ?? ""}/${process.env.LANG ?? ""}`)',
    ])).resolves.toMatch(/^C\//);
  });

  it('publishes every successful snapshot and retains the last truth across a failed poll', async () => {
    const listLivePanes = vi.fn()
      .mockResolvedValueOnce([live()])
      .mockRejectedValueOnce(new Error('tmux unavailable'))
      .mockResolvedValueOnce([live()])
      .mockResolvedValueOnce([live('zsh')]);
    const source = new TmuxAgentPaneSource({ commands: { listLivePanes }, pollMs: 100 });
    const snapshots: unknown[] = [];
    const unsubscribe = source.subscribe((snapshot) => snapshots.push(snapshot));
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    await vi.waitFor(() => expect(listLivePanes).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(snapshots).toHaveLength(3));
    expect(snapshots).toEqual([
      [expect.objectContaining({ paneId: '%1', currentCommand: 'pi', tty: '/dev/ttys001' })],
      [expect.objectContaining({ paneId: '%1', currentCommand: 'pi', tty: '/dev/ttys001' })],
      [expect.objectContaining({ paneId: '%1', currentCommand: 'zsh', tty: '/dev/ttys001' })],
    ]);
    unsubscribe();
  });

  it('distinguishes a successful final-pane empty snapshot from command and connection failures', async () => {
    let failure: Error | undefined;
    const source = new TmuxAgentPaneSource({ commands: { listLivePanes: async () => { if (failure) throw failure; return []; } }, pollMs: 100 });
    await expect(source.list()).resolves.toEqual([]);
    for (const message of ['no sessions', 'no server running on /tmp/tmux/default', 'error connecting to /tmp/tmux/default (No such file or directory)', 'connection reset', 'permission denied', 'invalid live pane format']) {
      failure = new Error(message); await expect(source.list()).rejects.toThrow(message);
    }
    const snapshots: unknown[] = []; const unsubscribe = source.subscribe(value => snapshots.push(value));
    await new Promise(resolve => setTimeout(resolve, 120)); expect(snapshots).toEqual([]);
    failure = undefined; await vi.waitFor(() => expect(snapshots).toEqual([[]])); unsubscribe();
  });

  it('resolves the actual foreground pid, start time, tty, and executable', async () => {
    const startedAt = Date.parse('Tue Aug 12 04:00:00 2026');
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === 'ps') {
        if (args[0] === '-p') return 'Tue Aug 12 04:00:00 2026\n';
        expect(args).toEqual(['-t', 'ttys001', '-o', 'pid=,ppid=,stat=,etime=,tty=,command=']);
        return ' 101 90 S+ 00:05 ttys001 pi\n 202 101 S 00:01 ttys001 helper\n';
      }
      if (command === 'lsof') return 'p101\nfcwd\nftxt\nn/opt/pi/bin/pi\n';
      return '';
    });
    const context = createLocalAgentProcessContext({ run });
    await expect(context.inspectForeground({
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'agent',
      currentCommand: 'pi', tty: '/dev/ttys001',
    })).resolves.toEqual({
      pid: 101, startedAt, tty: '/dev/ttys001', executable: '/opt/pi/bin/pi', commandLine: 'pi',
    });
  });

  it('shares short-lived process evidence across foreground and group probes', async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === 'ps') {
        if (args[0] === '-p') return 'Tue Aug 12 04:00:00 2026\n';
        return ' 101 90 S+ 00:05 ttys001 node /opt/codex/bin/codex\n';
      }
      if (command === 'lsof') return 'p101\nftxt\nn/opt/codex/bin/codex\n';
      return '';
    });
    const context = createLocalAgentProcessContext({ run });
    const pane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'agent',
      currentCommand: 'node', tty: '/dev/ttys001',
    };

    await Promise.all([context.inspectForeground(pane), context.inspectForegroundGroup!(pane)]);
    expect(run.mock.calls.filter(([command, args]) => command === 'ps' && args[0] === '-t')).toHaveLength(1);

    const calls = run.mock.calls.length;
    await context.inspectForeground(pane);
    await context.inspectForegroundGroup!(pane);
    expect(run.mock.calls.filter(([command, args]) => command === 'ps' && args[0] === '-t')).toHaveLength(1);
    expect(run.mock.calls.filter(([command]) => command === 'lsof')).toHaveLength(1);
    expect(run.mock.calls.length).toBeGreaterThan(calls);
  });

  it('bypasses the foreground evidence cache for the final destructive-operation identity probe', async () => {
    let pid = 101;
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === 'ps') {
        if (args[0] === '-p') return `Tue Aug 12 04:00:${pid === 101 ? '01' : '02'} 2026\n`;
        if (args[0] === '-t') return ` ${pid} 90 S+ 00:05 ttys001 codex --remote\n`;
      }
      if (command === 'lsof') return `p${args[2]}\nftxt\nn/opt/codex-${args[2]}\n`;
      return '';
    });
    const context = createLocalAgentProcessContext({ run });
    const pane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'agent',
      currentCommand: 'codex', tty: '/dev/ttys001',
    };

    await expect(context.inspectForeground(pane)).resolves.toMatchObject({ pid: 101 });
    pid = 202;
    await expect(context.inspectForegroundFresh!(pane)).resolves.toMatchObject({
      pid: 202, executable: '/opt/codex-202',
    });
    expect(run.mock.calls.filter(([command, args]) => command === 'ps' && args[0] === '-t')).toHaveLength(2);
    expect(run).toHaveBeenCalledWith('lsof', ['-a', '-p', '202', '-d', 'txt', '-Fn']);
  });

  it('returns fresh process generations and executable evidence for the whole foreground group', async () => {
    let generation = 1;
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === 'ps') {
        if (args[0] === '-p') return `Tue Aug 12 04:00:0${generation} 2026\n`;
        if (args[0] === '-t') return generation === 1
          ? ' 100 90 S+ 00:05 ttys001 node /usr/local/bin/handmux codex\n 101 100 S+ 00:04 ttys001 codex --remote unix:///tmp/1.sock\n'
          : ' 200 90 S+ 00:05 ttys001 node /usr/local/bin/handmux codex\n 202 200 S+ 00:04 ttys001 codex --remote unix:///tmp/1.sock\n';
      }
      if (command === 'lsof') return `p${args[2]}\nftxt\nn${args[2] === '100' || args[2] === '200' ? '/usr/local/bin/node' : '/opt/codex/bin/codex'}\n`;
      return '';
    });
    const context = createLocalAgentProcessContext({ run });
    const pane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'agent',
      currentCommand: 'node', tty: '/dev/ttys001',
    };

    await expect(context.inspectForegroundGroupFresh!(pane)).resolves.toMatchObject([
      { pid: 100, ppid: 90, executable: '/usr/local/bin/node' },
      { pid: 101, ppid: 100, executable: '/opt/codex/bin/codex' },
    ]);
    generation = 2;
    await expect(context.inspectForegroundGroupFresh!(pane)).resolves.toMatchObject([
      { pid: 200, ppid: 90, executable: '/usr/local/bin/node' },
      { pid: 202, ppid: 200, executable: '/opt/codex/bin/codex' },
    ]);
    expect(run.mock.calls.filter(([command, args]) => command === 'ps' && args[0] === '-t')).toHaveLength(2);
  });

  it.each([
    ['same generation', 'Tue Aug 12 04:00:00 2026\n', 'present', 'same'],
    ['replaced generation', 'Tue Aug 12 04:00:01 2026\n', 'present', 'replaced'],
    ['confirmed exit', '', 'missing', 'exited'],
    ['inconclusive process lookup', '', 'unknown', 'unknown'],
  ] as const)('classifies a fresh pid probe as %s', async (_label, startedAt, presence, expected) => {
    const originalStart = Date.parse('Tue Aug 12 04:00:00 2026');
    const run = vi.fn(async (command: string, args: string[]) => (
      command === 'ps' && args[0] === '-p' ? startedAt : ''
    ));
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid !== 900_001) return true;
      if (presence === 'missing') throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      if (presence === 'unknown') throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return true;
    });
    const context = createLocalAgentProcessContext({ run });

    const actual = await context.inspectProcessGenerationFresh?.({ pid: 900_001, startedAt: originalStart });

    expect(actual).toBe(expected);
  });

  it('selects the deepest foreground leaf instead of a managed Node wrapper', async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === 'ps') {
        if (args[0] === '-p') return 'Tue Aug 12 04:00:00 2026\n';
        return [
          ' 100 90 S+ 04:00 ttys001 node handmux codex resume thread-1',
          ' 101 100 S+ 04:00 ttys001 node codex app-server',
          ' 102 101 S+ 04:00 ttys001 codex app-server',
          ' 103 100 S+ 04:00 ttys001 node codex --remote resume thread-1',
          ' 104 103 S+ 04:00 ttys001 codex --remote resume thread-1',
        ].join('\n');
      }
      if (command === 'lsof') return 'p104\nftxt\nn/opt/codex/bin/codex\n';
      return '';
    });
    const context = createLocalAgentProcessContext({ run });
    await expect(context.inspectForeground({
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'agent',
      currentCommand: 'node', tty: '/dev/ttys001',
    })).resolves.toMatchObject({
      pid: 104, executable: '/opt/codex/bin/codex',
      commandLine: 'codex --remote resume thread-1',
    });
    expect(run).toHaveBeenCalledWith('lsof', ['-a', '-p', '104', '-d', 'txt', '-Fn']);
  });

  it('keeps an ambiguous managed Agent stable while it runs a deeper tool child', async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === 'ps') {
        if (args[0] === '-p') return 'Tue Aug 12 04:00:00 2026\n';
        return [
          ' 100 90 S+ 04:00 ttys001 node handmux codex resume thread-1',
          ' 101 100 S+ 04:00 ttys001 node codex app-server',
          ' 102 101 S+ 03:59 ttys001 codex app-server',
          ' 103 100 S+ 04:00 ttys001 node codex --remote resume thread-1',
          ' 104 103 S+ 03:59 ttys001 codex --remote resume thread-1',
          ' 105 104 S+ 00:01 ttys001 /bin/zsh -lc npm test',
          ' 106 105 S+ 00:01 ttys001 node vitest',
        ].join('\n');
      }
      if (command === 'lsof') return 'p104\nftxt\nn/opt/codex/bin/codex\n';
      return '';
    });
    const context = createLocalAgentProcessContext({ run });
    await expect(context.inspectForeground({
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'agent',
      currentCommand: 'node', tty: '/dev/ttys001',
    })).resolves.toMatchObject({
      pid: 104, executable: '/opt/codex/bin/codex',
      commandLine: 'codex --remote resume thread-1',
    });
    expect(run).toHaveBeenCalledWith('lsof', ['-a', '-p', '104', '-d', 'txt', '-Fn']);
  });

  it('keeps an exact Agent process stable while it runs a deeper tool child', async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === 'ps') {
        if (args[0] === '-p') return 'Tue Aug 12 04:00:00 2026\n';
        return [
          ' 200 90 S+ 04:00 ttys001 claude',
          ' 201 200 S+ 00:01 ttys001 /bin/zsh -lc npm test',
          ' 202 201 S+ 00:01 ttys001 node vitest',
        ].join('\n');
      }
      if (command === 'lsof') return 'p200\nftxt\nn/opt/claude/bin/claude\n';
      return '';
    });
    const context = createLocalAgentProcessContext({ run });
    await expect(context.inspectForeground({
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'agent',
      currentCommand: 'claude', tty: '/dev/ttys001',
    })).resolves.toMatchObject({ pid: 200, executable: '/opt/claude/bin/claude' });
  });

  // An Agent that runs INSIDE an ambiguous launcher (a Node CLI with no native child binary) is exactly the
  // case the single-leaf view cannot serve: it deliberately prefers the non-launcher descendant, so the leaf
  // is a transient tool child, not the Agent. The group is that adapter's only way to see its own process.
  it('reports the whole foreground group for an Agent running inside an ambiguous launcher', async () => {
    const startedAt = Date.parse('Tue Aug 12 04:00:00 2026');
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === 'ps') {
        if (args[0] === '-p') return 'Tue Aug 12 04:00:00 2026\n';
        expect(args).toEqual(['-t', 'ttys001', '-o', 'pid=,ppid=,stat=,etime=,tty=,command=']);
        return [
          ' 400 90 Ss+ 00:20 ttys001 node /usr/local/bin/codebuddy --no-session-persistence',
          ' 401 400 R+  00:00 ttys001 npm list',
        ].join('\n');
      }
      if (command === 'lsof') return 'p401\nftxt\nn/usr/local/bin/node\n';
      return '';
    });
    const context = createLocalAgentProcessContext({ run });
    const pane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'agent',
      currentCommand: 'node', tty: '/dev/ttys001',
    };
    await expect(context.inspectForeground(pane)).resolves.toMatchObject({
      pid: 401, commandLine: 'npm list',
    });
    // Every row carries a process generation, because any of them can become a lease anchor.
    await expect(context.inspectForegroundGroup!(pane)).resolves.toEqual([
      {
        pid: 400, ppid: 90, tty: '/dev/ttys001', startedAt,
        commandLine: 'node /usr/local/bin/codebuddy --no-session-persistence',
      },
      { pid: 401, ppid: 400, tty: '/dev/ttys001', startedAt, commandLine: 'npm list' },
    ]);
  });

  it('probes one known process by pid for the lease anchor check', async () => {
    const startedAt = Date.parse('Tue Aug 12 04:00:00 2026');
    const run = vi.fn(async (command: string, args: string[]) => (
      command === 'ps' && args[0] === '-p' && args[1] === '400' ? 'Tue Aug 12 04:00:00 2026\n' : ''
    ));
    const context = createLocalAgentProcessContext({ run });
    await expect(context.inspectProcess!(400)).resolves.toEqual({ pid: 400, startedAt });
    await expect(context.inspectProcess!(999)).resolves.toBeNull();
    // Never an executable lookup: avoiding that lsof is the whole point of the anchor check.
    expect(run.mock.calls.filter(([, args]) => args[0] === 'lsof')).toEqual([]);
  });

  it('reports no foreground group for a pane without a tty', async () => {
    const run = vi.fn(async () => '');
    const context = createLocalAgentProcessContext({ run });
    await expect(context.inspectForegroundGroup!({
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'agent', currentCommand: 'node',
    })).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('process start value', () => {
  it('reads the raw start tick on Linux, so a stepped boot time cannot move it', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    // /proc/<pid>/stat: pid (comm) state ppid ... — comm contains spaces on purpose, and starttime is the
    // 22nd field overall (20th after comm).
    const stat = '101 (claude code) S 1 101 101 0 -1 4194304 1 0 0 0 1 2 3 4 20 0 1 0 473349 123 456\n';
    const readFile = vi.spyOn(fsp, 'readFile').mockResolvedValue(stat as never);
    const run = vi.fn(async () => { throw new Error('ps must not be consulted on Linux'); });

    await expect(processStartedAt(run, 101)).resolves.toBe(473349);
    expect(readFile).toHaveBeenCalledWith('/proc/101/stat', 'utf8');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps parsing lstart where procfs does not exist', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const run = vi.fn(async () => 'Thu Jan  1 00:00:01 1970\n');
    await expect(processStartedAt(run, 101)).resolves.toBe(Date.parse('Thu Jan  1 00:00:01 1970'));
    expect(run).toHaveBeenCalledWith('ps', ['-p', '101', '-o', 'lstart=']);
  });
});
