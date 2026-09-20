import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installHooks } from '../src/cli/codebuddyHooks.js';
import { CodeBuddyHookBridgeConnector } from '../connectors/codebuddy/index.js';
import { createBuiltinAgentRuntime } from '../src/agent-runtime/builtinRuntime.js';
import { InboxPushProjection } from '../src/agent-runtime/inboxPushProjection.js';
import type { ForegroundProcessIdentity, LivePane, ProcessContext } from '../src/agent-runtime/adapter.js';

// End-to-end from the INSTALLED integration: the real settings.json → the real notify script → the shared
// writer → the Connector → Inbox → Push. Nothing here pre-fabricates a spool file, because the shapes that
// matter (the writer's `agent`/`eventId` literals, the process fingerprint the shell resolves) are exactly
// what a hand-written fixture would get wrong.
const SESSION = 'cb-installed-session';
const CODEBUDDY_PID = 4242;
const CODEBUDDY_STARTED_AT = 473349;
const TTY = '/dev/ttys007';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// The hook resolves its owning process by walking PPIDs and running the pane TTY scan. Both must be faked:
// an honest lookup would walk into the REAL ambient process tree — this suite often runs inside a CodeBuddy
// session, whose own node parent legitimately matches the matcher.
function fakeBin(directory: string): string {
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ps'), [
    '#!/bin/sh',
    'PID="$2"',
    'FORMAT="$4"',
    'case "$FORMAT" in',
    "  command=) if [ \"$PID\" = '4242' ]; then printf 'node /usr/local/bin/codebuddy\\n'; else printf '/bin/zsh -c handmux-wrapper\\n'; fi ;;",
    "  ppid=) if [ \"$PID\" = '4242' ]; then printf '1\\n'; else printf '4242\\n'; fi ;;",
    "  lstart=) [ \"$LC_ALL\" = 'C' ] || exit 9; printf 'Tue Aug 12 04:00:00 2026\\n' ;;",
    "  tty=) printf 'ttys007\\n' ;;",
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  // A pane TTY is only reachable through tmux; without it the fallback scan stays inert.
  fs.writeFileSync(path.join(bin, 'tmux'), "#!/bin/sh\nprintf ''\n", { mode: 0o755 });
  return bin;
}

function installedHooks() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cb-install-'));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Both the registered shell command and the sourced env must preserve literal path characters.
  const home = path.join(directory, "user's home $HOME `false`");
  const hookStateFile = path.join(home, '.handmux', 'codebuddy-state.json');
  const eventDirectory = `${hookStateFile}.events`;
  fs.mkdirSync(path.join(home, '.codebuddy'), { recursive: true });
  // The hook reads the process start tick from procfs where it exists; supply a fixture so the value is
  // deterministic on every platform instead of depending on the host's live process table.
  const procRoot = path.join(directory, 'proc');
  fs.mkdirSync(path.join(procRoot, String(CODEBUDDY_PID)), { recursive: true });
  fs.writeFileSync(path.join(procRoot, String(CODEBUDDY_PID), 'stat'),
    `${CODEBUDDY_PID} (node) S 1 ${CODEBUDDY_PID} ${CODEBUDDY_PID} 0 -1 4194304 1 0 0 0 1 2 3 4 20 0 1 0 ${CODEBUDDY_STARTED_AT} 123 456\n`);
  const bin = fakeBin(directory);
  const options = { srcDir: path.resolve(import.meta.dirname, '../hooks'), stateFile: hookStateFile };
  expect(installHooks(home, options).status).toBe('installed');
  const settings = JSON.parse(
    fs.readFileSync(path.join(home, '.codebuddy/settings.json'), 'utf8'),
  ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_PANE: '%1',
    HANDMUX_PROC_ROOT: procRoot,
  };
  // The installed env file must be the only source of the state/spool paths.
  delete env.HANDMUX_STATE;
  delete env.HANDMUX_CODEBUDDY_EVENTS;
  function fire(event: string, payload: Record<string, unknown>) {
    execFileSync('/bin/sh', ['-c', settings.hooks[event]![0]!.hooks[0]!.command], {
      env, input: JSON.stringify({ session_id: SESSION, ...payload }), timeout: 5_000,
    });
    const state = (JSON.parse(fs.readFileSync(hookStateFile, 'utf8')) as Record<string, {
      process?: unknown; sequence?: number;
    }>)['%1'];
    if (event !== 'SessionEnd') {
      expect(state?.process).toEqual({ pid: CODEBUDDY_PID, startedAt: CODEBUDDY_STARTED_AT, tty: TTY });
      expect(state?.sequence).toBeGreaterThan(0);
    }
  }
  const eventFiles = () => fs.readdirSync(eventDirectory).filter((name) => name.startsWith('event-'));
  function pair() {
    const runtimeDirectory = path.join(directory, 'runtime');
    // The pane's foreground leaf is NOT CodeBuddy: on a real install it is a transient tool child, and the
    // launcher only appears in the foreground group — which is where the adapter anchors the lease.
    const leaf: ForegroundProcessIdentity = {
      pid: 4243, startedAt: 473_350, tty: TTY, commandLine: 'npm list', executable: '/usr/local/bin/node',
    };
    const anchor: ForegroundProcessIdentity = {
      pid: CODEBUDDY_PID, ppid: 90, startedAt: CODEBUDDY_STARTED_AT, tty: TTY,
      commandLine: 'node /usr/local/bin/codebuddy --no-session-persistence',
    };
    const pane: LivePane = {
      paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'codebuddy',
      currentCommand: 'node', tty: TTY,
    };
    const panes = { list: async () => [pane], subscribe: () => () => {} };
    const processSource: ProcessContext = {
      inspectForeground: async () => leaf,
      inspectForegroundGroup: async () => [anchor, leaf],
    };
    const runtime = createBuiltinAgentRuntime({
      panes, process: processSource, stateDirectory: runtimeDirectory,
      authToken: 'codebuddy-install-test-token-at-least-32-bytes',
    });
    cleanup.push(() => runtime.close());
    const push = { sendToSession: vi.fn(async () => {}) };
    const projection = new InboxPushProjection({ inbox: runtime.inbox, runs: runtime.runs, panes, push });
    projection.start();
    cleanup.push(() => projection.close());
    const connector = new CodeBuddyHookBridgeConnector({
      socketPath: runtime.socketPath, credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
      stateDirectory: path.join(runtimeDirectory, 'connectors/codebuddy'), hookStateFile, eventDirectory,
      panes, process: processSource, pollMs: 50, retryDelayMs: 5, maxRetryDelayMs: 10,
    });
    cleanup.push(() => connector.close());
    return { runtime, connector, push };
  }
  return { fire, pair, eventFiles, eventDirectory };
}

describe('installed CodeBuddy hooks → writer → Bridge → Inbox → Push', () => {
  it('binds the session from SessionStart and notifies an online Stop', async () => {
    const hooks = installedHooks();
    // SessionStart is the only payload that carries the session binding, and the conversation page refuses
    // to open for a run without a sessionId — so this is the edge that makes the lens reachable at all.
    hooks.fire('SessionStart', {
      transcript_path: '/Users/x/.codebuddy/projects/-Users-x/cb-installed-session.jsonl',
      source: 'startup',
    });
    hooks.fire('UserPromptSubmit', { prompt: '跑一下测试' });
    const { runtime, connector, push } = hooks.pair();
    await runtime.start();
    connector.start();

    await vi.waitFor(() => expect(runtime.activeRuns()).toEqual([
      expect.objectContaining({ agentId: 'codebuddy', paneId: '%1', sessionId: SESSION }),
    ]), { timeout: 3_000 });
    await vi.waitFor(() => expect(runtime.inbox.read().records[0]?.state).toBe('working'), { timeout: 3_000 });
    await vi.waitFor(() => expect(hooks.eventFiles()).toEqual([]), { timeout: 3_000 });
    expect(push.sendToSession).not.toHaveBeenCalled();

    hooks.fire('Stop', { last_assistant_message: '测试通过' });
    await vi.waitFor(() => expect(push.sendToSession).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(runtime.inbox.read().records[0]).toMatchObject({ state: 'done', message: '测试通过' });
    expect(runtime.inbox.read().terminalNotifications).toHaveLength(1);
    await vi.waitFor(() => expect(hooks.eventFiles()).toEqual([]), { timeout: 3_000 });
  });

  it('settles an offline completion once, without replaying it after a restart', async () => {
    const hooks = installedHooks();
    hooks.fire('SessionStart', { source: 'startup' });
    hooks.fire('Stop', { last_assistant_message: '离线完成' });
    const eventFile = path.join(hooks.eventDirectory, hooks.eventFiles()[0]!);
    const savedEvent = fs.readFileSync(eventFile);

    const first = hooks.pair();
    await first.runtime.start();
    first.connector.start();
    await vi.waitFor(() => expect(hooks.eventFiles()).toEqual([]), { timeout: 3_000 });
    expect(first.runtime.inbox.read().records[0]).toMatchObject({ state: 'done', message: '离线完成' });
    expect(first.push.sendToSession).toHaveBeenCalledTimes(1);

    // Lost acknowledgement: replay the identical source file after both consumers restart. The completion is
    // already persisted for this (agentId, sessionId, eventId), so it must not notify twice.
    await first.connector.close();
    await first.runtime.close();
    fs.writeFileSync(eventFile, savedEvent);
    const second = hooks.pair();
    await second.runtime.start();
    second.connector.start();
    await vi.waitFor(() => expect(hooks.eventFiles()).toEqual([]), { timeout: 3_000 });
    expect(second.runtime.inbox.read().terminalNotifications).toHaveLength(1);
    expect(second.push.sendToSession).not.toHaveBeenCalled();
  });
});
