import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  codexAppSocketPath,
  runManagedCodex,
  type ManagedChild,
  type ManagedSpawnOptions,
} from '../src/cli/codexManaged.js';

function child({ exits = false }: { exits?: boolean } = {}): ManagedChild {
  const process = new EventEmitter() as EventEmitter & ManagedChild;
  process.exitCode = null;
  process.signalCode = null;
  process.kill = () => { process.exitCode = 0; process.emit('exit', 0, null); return true; };
  if (exits) queueMicrotask(() => { process.exitCode = 0; process.emit('exit', 0, null); });
  return process;
}

describe('managed Codex launcher', () => {
  it('uses a private deterministic socket per tmux pane', () => {
    expect(codexAppSocketPath('%42', '/home/me')).toBe('/home/me/.handmux/codex-app/42.sock');
    expect(() => codexAppSocketPath('42', '/home/me')).toThrow(/tmux pane/);
  });

  it('starts App Server first, then attaches the TUI to the same socket', async () => {
    const calls: Array<{ command: string; args: readonly string[]; options: ManagedSpawnOptions }> = [];
    const server = child();
    const code = await runManagedCodex(['resume', 'thread-1'], {
      home: '/home/me', env: { TMUX_PANE: '%7' },
      mkdir: () => {}, unlink: () => {},
      waitOptions: { exists: () => true },
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return calls.length === 1 ? server : child({ exits: true });
      },
    });
    expect(code).toBe(0);
    expect(calls[0]?.args).toEqual(['app-server', '--listen', 'unix:///home/me/.handmux/codex-app/7.sock']);
    expect(calls[1]?.args).toEqual(['--remote', 'unix:///home/me/.handmux/codex-app/7.sock', 'resume', 'thread-1']);
    expect(calls[0]?.options.env.HANDMUX_CODEX_MANAGED).toBe('1');
  });
});
