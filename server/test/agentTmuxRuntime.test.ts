import { describe, expect, it, vi } from 'vitest';
import {
  createLocalAgentProcessContext,
  TmuxAgentPaneSource,
} from '../src/agent-runtime/tmuxRuntime.js';

function live(command = 'pi') {
  return {
    id: '%1', cmd: command, tty: '/dev/ttys001',
    session: 'main', window: '@1', windowName: 'agent',
  };
}

describe('Tmux Agent Runtime context', () => {
  it('publishes complete changed snapshots and retains the last truth across a failed poll', async () => {
    const listLivePanes = vi.fn()
      .mockResolvedValueOnce([live()])
      .mockRejectedValueOnce(new Error('tmux unavailable'))
      .mockResolvedValueOnce([live('zsh')]);
    const source = new TmuxAgentPaneSource({ commands: { listLivePanes }, pollMs: 100 });
    const snapshots: unknown[] = [];
    const unsubscribe = source.subscribe((snapshot) => snapshots.push(snapshot));
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    await vi.waitFor(() => expect(listLivePanes).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(snapshots).toHaveLength(2));
    expect(snapshots).toEqual([
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
});
