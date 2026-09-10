import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installHooks, syncHooks } from '../src/cli/claudeHooks.js';
import { ClaudeHookBridgeConnector } from '../connectors/claude/index.js';
import { createBuiltinAgentRuntime } from '../src/agent-runtime/builtinRuntime.js';
import { InboxPushProjection } from '../src/agent-runtime/inboxPushProjection.js';
import type { ForegroundProcessIdentity, LivePane } from '../src/agent-runtime/adapter.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function installedHooks(sync = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-hook-install-'));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Both the registered shell command and sourced env must preserve literal path characters.
  const home = path.join(directory, "user's home $HOME `false`");
  const hookStateFile = path.join(home, '.handmux', 'claude-state.json');
  const eventDirectory = `${hookStateFile}.events`;
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nprintf "/dev/ttys007\\n"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh
case "$*" in
 '-t ttys007 -o pid=,stat=,comm=') printf '4242 S claude\\n' ;;
 '-p 4242 -o lstart=') [ "$LC_ALL" = C ] && printf 'Wed Sep 09 10:00:00 2026\\n' ;;
 '-p 4242 -o tty=') printf 'ttys007\\n' ;;
esac
`, { mode: 0o755 });
  const options = { srcDir: path.resolve(import.meta.dirname, '../hooks'), stateFile: hookStateFile, claudeVersion: null };
  expect(installHooks(home, options).status).toBe('installed');
  // Simulate an old installation: server startup sync must restore the missing setting.
  if (sync) {
    fs.writeFileSync(path.join(home, '.claude/hooks/handmux-notify.env'), 'HANDMUX_STATE=/old/state\n');
    expect(syncHooks(home, options).status).toBe('installed');
  }
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_PANE: '%1', CLAUDE_PANE: '%1' };
  delete env.HANDMUX_CLAUDE_EVENTS;
  delete env.HANDMUX_STATE;
  const foreground: ForegroundProcessIdentity = {
    pid: 4242, startedAt: Date.parse('Wed Sep 09 10:00:00 2026'),
    tty: '/dev/ttys007', executable: '/opt/claude/bin/claude',
  };
  function fire(event: string, payload: Record<string, unknown>) {
    execFileSync('/bin/sh', ['-c', settings.hooks[event][0].hooks[0].command], {
      env, input: JSON.stringify({ session_id: 'installed-session', ...payload }), timeout: 5_000,
    });
    const state = JSON.parse(fs.readFileSync(hookStateFile, 'utf8'))['%1'];
    expect(state.process).toEqual({ pid: foreground.pid, startedAt: foreground.startedAt, tty: foreground.tty });
    expect(state.sequence).toBeGreaterThan(0);
  }
  const eventFiles = () => fs.readdirSync(eventDirectory).filter((name) => name.startsWith('event-'));
  function pair() {
    const runtimeDirectory = path.join(directory, 'runtime');
    const pane: LivePane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'claude',
      currentCommand: 'claude', tty: '/dev/ttys007', foregroundPid: 4242,
    };
    const panes = { list: async () => [pane], subscribe: () => () => {} };
    const processSource = { inspectForeground: async () => foreground };
    const runtime = createBuiltinAgentRuntime({
      panes, process: processSource, stateDirectory: runtimeDirectory,
      authToken: 'claude-install-test-token-at-least-32-bytes', claudeEvents: { paneSession: () => null },
    });
    cleanup.push(() => runtime.close());
    const push = { sendToSession: vi.fn(async () => {}) };
    const projection = new InboxPushProjection({ inbox: runtime.inbox, runs: runtime.runs, panes, push });
    projection.start();
    cleanup.push(() => projection.close());
    const connector = new ClaudeHookBridgeConnector({
      socketPath: runtime.socketPath, credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
      stateDirectory: path.join(runtimeDirectory, 'connectors/claude'), hookStateFile, eventDirectory,
      panes, process: processSource, pollMs: 50, retryDelayMs: 5, maxRetryDelayMs: 10,
    });
    cleanup.push(() => connector.close());
    return { runtime, connector, push };
  }
  return { fire, pair, eventFiles, eventDirectory };
}

describe('installed Claude hooks → writer → Bridge → Inbox → Push', () => {
  it.each(['Stop', 'PermissionRequest'])('notifies online %s after startup sync', async (event) => {
    const hooks = installedHooks(true);
    hooks.fire('UserPromptSubmit', { prompt: 'working' });
    const { runtime, connector, push } = hooks.pair();
    await runtime.start();
    connector.start();
    await vi.waitFor(() => expect(runtime.inbox.read().records[0]?.state).toBe('working'));
    await vi.waitFor(() => expect(hooks.eventFiles()).toEqual([]));
    expect(push.sendToSession).not.toHaveBeenCalled();
    hooks.fire(event, { last_assistant_message: 'finished', tool_name: 'Bash' });
    await vi.waitFor(() => expect(push.sendToSession).toHaveBeenCalledTimes(1));
    expect(runtime.inbox.read().records[0]?.state).toBe(event === 'Stop' ? 'done' : 'waiting');
    expect(runtime.inbox.read().terminalNotifications).toHaveLength(event === 'Stop' ? 1 : 0);
    await vi.waitFor(() => expect(hooks.eventFiles()).toEqual([]));
  });


  it.each(['Stop', 'PermissionRequest'])('replays offline %s followed by a new prompt without restoring stale waiting', async (event) => {
    const hooks = installedHooks();
    hooks.fire(event, { last_assistant_message: 'offline result', tool_name: 'Bash' });
    hooks.fire('UserPromptSubmit', { prompt: 'next task' });
    const { runtime, connector, push } = hooks.pair();
    await runtime.start();
    connector.start();
    await vi.waitFor(() => expect(hooks.eventFiles()).toEqual([]));
    expect(runtime.inbox.read().records[0]?.state).toBe('working');
    expect(runtime.inbox.read().terminalNotifications).toHaveLength(event === 'Stop' ? 1 : 0);
    expect(push.sendToSession).toHaveBeenCalledTimes(event === 'Stop' ? 1 : 0);
  });

  it('acknowledges an offline completion and deduplicates its file across a service restart', async () => {
    const hooks = installedHooks();
    hooks.fire('Stop', { last_assistant_message: 'offline result' });
    const eventFile = path.join(hooks.eventDirectory, hooks.eventFiles()[0]!);
    const savedEvent = fs.readFileSync(eventFile);
    const first = hooks.pair();
    await first.runtime.start();
    first.connector.start();
    await vi.waitFor(() => expect(hooks.eventFiles()).toEqual([]));
    expect(first.runtime.inbox.read().terminalNotifications).toHaveLength(1);
    expect(first.push.sendToSession).toHaveBeenCalledTimes(1);
    // Lost acknowledgement: replay the identical source file after both consumers restart.
    await first.connector.close();
    await first.runtime.close();
    fs.writeFileSync(eventFile, savedEvent);
    const second = hooks.pair();
    await second.runtime.start();
    second.connector.start();
    await vi.waitFor(() => expect(hooks.eventFiles()).toEqual([]));
    expect(second.runtime.inbox.read().terminalNotifications).toHaveLength(1);
    expect(second.push.sendToSession).not.toHaveBeenCalled();
  });
});
