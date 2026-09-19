import { promises as fsp } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalAgentProcessContext,
  processStartedAt,
  TmuxAgentPaneSource,
} from '../src/agent-runtime/tmuxRuntime.js';
import { defaultRun } from '../src/agents/scanUtils.js';

// Fixture PIDs must never resolve against the host's live /proc.
beforeEach(() => { vi.spyOn(fsp, 'readlink').mockRejectedValue(new Error('fixture proc unavailable')); });
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
    await expect(context.inspectForegroundGroup!(pane)).resolves.toEqual([
      {
        pid: 400, ppid: 90, tty: '/dev/ttys001',
        commandLine: 'node /usr/local/bin/codebuddy --no-session-persistence',
      },
      { pid: 401, ppid: 400, tty: '/dev/ttys001', commandLine: 'npm list' },
    ]);
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
