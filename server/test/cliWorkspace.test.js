import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../src/cli/i18n/index.js';
import { CANCELLED } from '../src/cli/prompt.js';
import { createStandaloneWorkspaceRuntime, runWorkspaceCommand } from '../src/cli/workspaceCmd.js';

const checkpoint = (id, archivedAt = '2026-07-20T02:00:00.000Z') => ({
  status: 'ok',
  id,
  value: {
    id,
    capturedAt: archivedAt,
    archivedAt,
    sessions: [{ id: `s-${id}`, name: id }],
    windows: [{ id: `w-${id}`, panes: [{ id: `p-${id}`, agent: { id: 'claude' } }] }],
  },
});

const plan = (checkpointId = 'newest') => ({
  checkpointId,
  capturedAt: '2026-07-20T02:00:00.000Z',
  summary: { sessions: 2, windows: 2, panes: 2, agents: 1 },
  planSummary: { create: 1, renamed: 0, alreadyPresent: 1, unsupported: 0, windows: 1, panes: 1, agents: 1 },
  preExistingRuntimeIds: { sessions: ['$9'], windows: ['@9'], panes: ['%9'] },
  sessions: [
    { logicalId: 's-api', sourceName: 'api', targetName: 'api', action: 'create' },
    { logicalId: 's-docs', sourceName: 'docs', action: 'already-present' },
  ],
  warnings: [],
});

function output() {
  return {
    value: '',
    write(chunk) { this.value += String(chunk); },
  };
}

function fakeRuntime({ rows = [checkpoint('newest')], restore, restorePlan } = {}) {
  return {
    listCheckpoints: vi.fn(async () => rows),
    getRestorePlan: vi.fn(async ({ checkpointId }) => restorePlan || plan(checkpointId)),
    restoreNow: vi.fn(async () => restore || {
      status: 'succeeded', restored: 1, alreadyPresent: 1, failed: 0,
      results: [
        { logicalId: 's-api', sourceName: 'api', targetName: 'api', status: 'restored', warnings: [] },
        { logicalId: 's-docs', sourceName: 'docs', status: 'already-present' },
      ],
      warnings: [],
    }),
  };
}

async function run({
  flags = {}, positionals = [], unknownShortFlags = [], runtime = fakeRuntime(),
  inputIsTTY = false, outputIsTTY = false, selectCheckpoint = vi.fn(),
} = {}) {
  const stdout = output();
  const stderr = output();
  const code = await runWorkspaceCommand({
    flags, positionals, unknownShortFlags, runtime, inputIsTTY, outputIsTTY, selectCheckpoint, stdout, stderr,
  });
  return { code, runtime, selectCheckpoint, stdout: stdout.value, stderr: stderr.value };
}

beforeEach(() => setLocale('en'));

describe('workspace restore CLI selection', () => {
  it('restores the only available checkpoint directly', async () => {
    const result = await run();

    expect(result.code).toBe(0);
    expect(result.selectCheckpoint).not.toHaveBeenCalled();
    expect(result.runtime.restoreNow).toHaveBeenCalledWith(expect.objectContaining({ checkpointId: 'newest' }));
  });

  it('asks on a TTY when multiple checkpoints exist', async () => {
    const rows = [checkpoint('newest'), checkpoint('older', '2026-07-19T02:00:00.000Z')];
    const selectCheckpoint = vi.fn(async () => 'older');
    const result = await run({ runtime: fakeRuntime({ rows }), inputIsTTY: true, outputIsTTY: true, selectCheckpoint });

    expect(result.code).toBe(0);
    expect(selectCheckpoint).toHaveBeenCalledWith(rows);
    expect(result.runtime.restoreNow).toHaveBeenCalledWith(expect.objectContaining({ checkpointId: 'older', historical: true }));
  });

  it('reports a cancelled TTY selection without leaking the prompt sentinel', async () => {
    const rows = [checkpoint('newest'), checkpoint('older', '2026-07-19T02:00:00.000Z')];
    const result = await run({
      runtime: fakeRuntime({ rows }), inputIsTTY: true, outputIsTTY: true,
      selectCheckpoint: vi.fn(async () => { throw CANCELLED; }),
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no checkpoint was selected/i);
    expect(result.stderr).not.toMatch(/Symbol|setup-cancelled/i);
    expect(result.runtime.restoreNow).not.toHaveBeenCalled();
  });

  it('chooses the newest checkpoint without prompting when either stream is not a TTY', async () => {
    const rows = [checkpoint('newest'), checkpoint('older', '2026-07-19T02:00:00.000Z')];
    const result = await run({ runtime: fakeRuntime({ rows }), inputIsTTY: true, outputIsTTY: false });

    expect(result.code).toBe(0);
    expect(result.selectCheckpoint).not.toHaveBeenCalled();
    expect(result.runtime.restoreNow).toHaveBeenCalledWith(expect.objectContaining({ checkpointId: 'newest' }));
  });

  it('skips selection for an explicit checkpoint and resolves the explicit latest alias', async () => {
    const direct = await run({ flags: { checkpoint: 'older' } });
    expect(direct.runtime.listCheckpoints).not.toHaveBeenCalled();
    expect(direct.selectCheckpoint).not.toHaveBeenCalled();
    expect(direct.runtime.restoreNow).toHaveBeenCalledWith({ checkpointId: 'older', sessions: [], historical: true });

    const latest = await run({ flags: { checkpoint: 'latest' } });
    expect(latest.runtime.restoreNow).toHaveBeenCalledWith({ checkpointId: 'newest', sessions: [], historical: true });
  });
});

describe('workspace restore CLI modes and exit codes', () => {
  it('lists valid and corrupt checkpoints without trying to restore', async () => {
    const runtime = fakeRuntime({ rows: [checkpoint('newest'), { status: 'corrupt', id: 'broken', error: 'hash mismatch' }] });
    const result = await run({ flags: { list: true }, runtime });

    expect(result.code).toBe(0);
    expect(runtime.getRestorePlan).not.toHaveBeenCalled();
    expect(runtime.restoreNow).not.toHaveBeenCalled();
    expect(result.stdout).toMatch(/newest.*1 session.*1 window.*1 pane.*1 agent/i);
    expect(result.stdout).toMatch(/broken.*unavailable.*hash mismatch/i);
  });

  it('rejects --list combinations and malformed values with usage exit code 2', async () => {
    const combined = await run({ flags: { list: true, dryRun: true } });
    expect(combined.code).toBe(2);
    expect(combined.stderr).toMatch(/--list.*alone|cannot.*--dry-run/i);

    const missing = await run({ flags: { checkpoint: true } });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/--checkpoint.*value/i);

    const unsafe = await run({ flags: { checkpoint: '../outside' } });
    expect(unsafe.code).toBe(2);
    expect(unsafe.stderr).toMatch(/--checkpoint.*valid id/i);
  });

  it('rejects every unconsumed positional or unknown short argument with exit code 2', async () => {
    const positional = await run({ positionals: ['surprise'] });
    expect(positional.code).toBe(2);
    expect(positional.stderr).toMatch(/unexpected.*surprise/i);
    expect(positional.runtime.listCheckpoints).not.toHaveBeenCalled();

    const short = await run({ unknownShortFlags: ['-x'] });
    expect(short.code).toBe(2);
    expect(short.stderr).toMatch(/unknown.*-x/i);
    expect(short.runtime.listCheckpoints).not.toHaveBeenCalled();
  });

  it('passes every repeated --session selection to the runtime', async () => {
    const result = await run({ flags: { session: ['api', 'web'] } });

    expect(result.code).toBe(0);
    expect(result.runtime.restoreNow).toHaveBeenCalledWith(expect.objectContaining({ sessions: ['api', 'web'] }));
  });

  it('dry-run prints the immutable plan and performs zero restore mutation', async () => {
    const result = await run({ flags: { dryRun: true } });

    expect(result.code).toBe(0);
    expect(result.runtime.getRestorePlan).toHaveBeenCalledTimes(1);
    expect(result.runtime.restoreNow).not.toHaveBeenCalled();
    expect(result.stdout).toMatch(/\+ api/);
    expect(result.stdout).toMatch(/= docs.*already restored/i);
    expect(result.stdout).toMatch(/No existing session or process will be stopped or modified/i);
    expect(result.stdout).toMatch(/Run `handmux restore` to continue/i);
  });

  it('localizes unsupported dry-run topology and offers manual recovery instead of a doomed restore retry', async () => {
    const restorePlan = {
      ...plan(),
      sessions: [{ logicalId: 's-api', sourceName: 'api', action: 'unsupported', reason: 'linked-windows-unsupported' }],
      planSummary: { create: 0, renamed: 0, alreadyPresent: 0, unsupported: 1, windows: 0, panes: 0, agents: 0 },
    };
    const result = await run({ flags: { dryRun: true }, runtime: fakeRuntime({ restorePlan }) });

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/linked window/i);
    expect(result.stdout).not.toContain('linked-windows-unsupported');
    expect(result.stdout).toMatch(/tmux new-session -s/);
    expect(result.stdout).not.toMatch(/Run `handmux restore` to continue/i);
  });

  it('does not tell a normal restore to retry an unsupported plan unchanged', async () => {
    const runtime = fakeRuntime({ restore: {
      status: 'failed', restored: 0, alreadyPresent: 0, failed: 1,
      results: [{
        logicalId: 's-api', sourceName: 'api', status: 'failed', stage: 'plan', error: 'linked-windows-unsupported',
      }],
      warnings: [],
    } });
    const result = await run({ runtime });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/linked window/i);
    expect(result.stderr).toMatch(/tmux new-session -s/);
    expect(result.stderr).not.toContain('linked-windows-unsupported');
    expect(result.stderr).not.toMatch(/handmux restore --checkpoint/i);
  });

  it('POSIX-quotes checkpoint and session data in every copyable recovery command', async () => {
    const session = "odd name';$(touch /tmp/pwn)";
    const quotedSession = `'odd name'"'"';$(touch /tmp/pwn)'`;
    const retryRuntime = fakeRuntime({ restore: {
      status: 'failed', restored: 0, alreadyPresent: 0, failed: 1,
      results: [{ logicalId: 's-odd', sourceName: session, status: 'failed', stage: 'topology', error: 'tmux stopped' }],
      warnings: [],
    } });
    const retry = await run({ runtime: retryRuntime });
    expect(retry.stderr).toContain(`handmux restore --checkpoint 'newest' --session ${quotedSession}`);

    const manualRuntime = fakeRuntime({ restore: {
      status: 'failed', restored: 0, alreadyPresent: 0, failed: 1,
      results: [{
        logicalId: 's-odd', sourceName: session, status: 'failed', stage: 'plan', error: 'linked-windows-unsupported',
      }],
      warnings: [],
    } });
    const manual = await run({ runtime: manualRuntime });
    expect(manual.stderr).toContain(`tmux new-session -s ${quotedSession}`);
  });

  it('POSIX-quotes the checkpoint in operation-level and thrown-error retry commands', async () => {
    const failed = await run({ runtime: fakeRuntime({ restore: {
      status: 'failed', results: [], error: 'lock timeout', warnings: [],
    } }) });
    expect(failed.stderr).toContain("handmux restore --checkpoint 'newest'");

    const runtime = fakeRuntime();
    runtime.restoreNow.mockRejectedValue(new Error('lock timeout'));
    const thrown = await run({ runtime });
    expect(thrown.stderr).toContain("handmux restore --checkpoint 'newest'");
  });

  it('returns 1 when there is no usable checkpoint', async () => {
    const result = await run({ runtime: fakeRuntime({ rows: [{ status: 'corrupt', id: 'broken', error: 'bad hash' }] }) });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no usable checkpoint/i);
    expect(result.stderr).toMatch(/handmux.*protect|next.*restart/i);
  });

  it('returns 1 for a partial restore and names checkpoint, session, stage, and next action', async () => {
    const runtime = fakeRuntime({ restore: {
      status: 'partial', restored: 1, alreadyPresent: 0, failed: 1,
      results: [
        { logicalId: 's-api', sourceName: 'api', targetName: 'api', status: 'restored', warnings: [] },
        { logicalId: 's-web', sourceName: 'web', status: 'failed', stage: 'topology', error: 'tmux disappeared' },
      ],
      warnings: [],
    } });
    const result = await run({ runtime });

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/✓ api/);
    expect(result.stderr).toMatch(/checkpoint newest.*session web.*stage topology/i);
    expect(result.stderr).toMatch(/retry.*--checkpoint 'newest'.*--session 'web'/i);
  });

  it('returns 0 when every selected session is already present', async () => {
    const runtime = fakeRuntime({ restore: {
      status: 'succeeded', restored: 0, alreadyPresent: 1, failed: 0,
      results: [{ logicalId: 's-docs', sourceName: 'docs', status: 'already-present' }], warnings: [],
    } });
    const result = await run({ runtime });

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/= docs.*already restored/i);
  });

  it('turns runtime exceptions into actionable exit code 1 errors', async () => {
    const runtime = fakeRuntime();
    runtime.restoreNow.mockRejectedValue(new Error('writer lock timed out; held by restore-7 (pid 42)'));
    const result = await run({ runtime });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/checkpoint newest/i);
    expect(result.stderr).toMatch(/writer lock timed out.*pid 42/i);
    expect(result.stderr).toMatch(/retry/i);
  });

  it('prints the persisted operation error when restoreNow returns a failed operation without rows', async () => {
    const runtime = fakeRuntime({ restore: {
      status: 'failed', restored: 0, alreadyPresent: 0, failed: 0, results: [],
      error: 'checkpoint payload hash mismatch', warnings: [],
    } });
    const result = await run({ runtime });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/checkpoint newest.*stage restore/i);
    expect(result.stderr).toMatch(/payload hash mismatch/i);
    expect(result.stderr).toMatch(/retry.*--checkpoint 'newest'/i);
  });
});

describe('standalone runtime composition', () => {
  it('uses the supplied workspace dependencies and does not read daemon state or real home', () => {
    const store = { paths: { lockDir: '/fake/workspaces/restore.lock' } };
    const tmux = { captureTopology: vi.fn() };
    const lock = { withLock: vi.fn() };
    const checkpointer = { reconcile: vi.fn() };
    const createStore = vi.fn(() => store);
    const createTmux = vi.fn(() => tmux);
    const createLock = vi.fn(() => lock);
    const createCheckpointer = vi.fn(() => checkpointer);
    const createRuntime = vi.fn(() => ({ listCheckpoints: vi.fn(), getRestorePlan: vi.fn(), restoreNow: vi.fn() }));

    const runtime = createStandaloneWorkspaceRuntime({
      home: '/fake/home', createStore, createTmux, createLock, createCheckpointer, createRuntime,
      runTmux: vi.fn(), observeEnvironment: vi.fn(), stateFile: '/fake/agents.json', readOnly: true,
    });

    expect(runtime).toBe(createRuntime.mock.results[0].value);
    expect(createStore).toHaveBeenCalledWith({ home: '/fake/home' });
    expect(createTmux).toHaveBeenCalledWith({ run: expect.any(Function), readOnly: true });
    expect(createLock).toHaveBeenCalledWith({ dir: '/fake/workspaces/restore.lock' });
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ store, tmux, lock, checkpointer, home: '/fake/home' }));
  });

  it('constructs a read-only runtime for dry-run when no runtime is injected', async () => {
    const runtime = fakeRuntime();
    const createRuntime = vi.fn(() => runtime);
    const stdout = output();
    const stderr = output();

    const code = await runWorkspaceCommand({
      flags: { dryRun: true }, home: '/fake/home', createRuntime, stdout, stderr,
      inputIsTTY: false, outputIsTTY: false,
    });

    expect(code).toBe(0);
    expect(createRuntime).toHaveBeenCalledWith({ home: '/fake/home', readOnly: true });
    expect(runtime.restoreNow).not.toHaveBeenCalled();
  });

  it('uses the real read-only adapter for capture without emitting any tmux mutation', async () => {
    const serverId = '10000000-0000-4000-8000-000000000001';
    const calls = [];
    const runTmux = vi.fn(async (args) => {
      calls.push(args);
      if (args[0] === 'show-options') return `${serverId}\n`;
      if (args[0] === '-V') return 'tmux 3.6a\n';
      if (args[0] === 'list-sessions') return '$1\tapi\t1\t\n';
      if (args[0] === 'list-windows') return '$1\t@1\t0\tmain\t1\t80x24,0,0,1\t\n';
      if (args[0] === 'list-panes') return '@1\t%1\t0\t1\t/tmp\t\n';
      if (args[0] === 'display-message') return '$1\t@1\t%1\n';
      throw new Error(`unexpected tmux command: ${args.join(' ')}`);
    });
    const store = { paths: { lockDir: '/fake/workspaces/restore.lock' } };
    const runtime = createStandaloneWorkspaceRuntime({
      home: '/fake/home', stateFile: '/fake/agents.json', readOnly: true, runTmux,
      createStore: () => store,
      createLock: () => ({ withLock: vi.fn() }),
      createCheckpointer: () => ({ reconcile: vi.fn() }),
      createRuntime: ({ tmux }) => ({ tmux }),
      observeEnvironment: vi.fn(),
    });

    expect((await runtime.tmux.captureTopology()).status).toBe('ok');
    expect(new Set(calls.map((args) => args[0]))).toEqual(new Set([
      'show-options', '-V', 'list-sessions', 'list-windows', 'list-panes', 'display-message',
    ]));
  });
});
