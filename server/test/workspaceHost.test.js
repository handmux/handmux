import { execFile as execFileCallback } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceBackground } from '../src/workspace/checkpointer.js';
import { createBootIdentityProvider, createEnvironmentProvider } from '../src/workspace/environment.js';
import { createWorkspaceLock } from '../src/workspace/lock.js';
import { buildRestorePlan } from '../src/workspace/planner.js';
import { executeRestore } from '../src/workspace/restore.js';
import { createWorkspaceStore } from '../src/workspace/store.js';
import { createWorkspaceTmux } from '../src/workspace/tmuxAdapter.js';

const execFile = promisify(execFileCallback);
const hostIt = process.env.HANDMUX_WORKSPACE_HOST === '1' ? it : it.skip;

describe('workspace recovery on the current host', () => {
  let home;
  let socket;
  let backgrounds = [];

  async function runTmux(args) {
    return execFile('tmux', ['-L', socket, ...args], { env: process.env });
  }

  async function endGeneration() {
    await runTmux(['kill-server']).catch(() => {});
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await runTmux(['list-sessions']);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('isolated tmux generation did not stop');
  }

  function createCore() {
    const store = createWorkspaceStore({ home });
    const tmux = createWorkspaceTmux({ run: runTmux });
    const lock = createWorkspaceLock({ dir: store.paths.lockDir, retryMs: 1 });
    const bootIdentityProvider = createBootIdentityProvider();
    const observeEnvironment = createEnvironmentProvider({
      bootIdentityProvider,
      tmuxServerIdProvider: async () => {
        const observed = await tmux.observeEnvironment();
        if (observed.status === 'present') return observed.tmuxServerId;
        if (observed.status === 'absent') return null;
        throw new Error('tmux server identity is unknown');
      },
    });
    const checkpointer = createWorkspaceBackground({
      store,
      tmux,
      lock,
      observeEnvironment,
      stateFile: path.join(home, 'agent-state.json'),
    });
    backgrounds.push(checkpointer);
    return { store, tmux, checkpointer, bootIdentityProvider };
  }

  afterEach(async () => {
    await Promise.all(backgrounds.map((background) => background.stop().catch(() => {})));
    if (socket) await runTmux(['kill-server']).catch(() => {});
    if (home) await fsp.rm(home, { recursive: true, force: true });
    home = undefined;
    socket = undefined;
    backgrounds = [];
  });

  hostIt('preserves current work while restoring an ended tmux generation', async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'handmux-workspace-host-'));
    socket = `handmux-host-${process.pid}-${path.basename(home)}`;
    const sourceCwd = path.join(home, 'source');
    const currentCwd = path.join(home, 'current');
    await Promise.all([
      fsp.mkdir(sourceCwd, { recursive: true }),
      fsp.mkdir(currentCwd, { recursive: true }),
    ]);

    await runTmux(['new-session', '-d', '-s', 'project', '-n', 'code', '-c', sourceCwd]);
    await runTmux(['split-window', '-h', '-d', '-t', 'project:code.0', '-c', sourceCwd]);

    const first = createCore();
    const bootIdentity = await first.bootIdentityProvider();
    expect(bootIdentity).toMatch(/\S/);
    expect(await first.checkpointer.start()).toMatchObject({ status: 'written' });
    const original = await first.store.readLive();
    expect(original).toMatchObject({ status: 'ok' });
    expect(original.value.environment.bootIdentity).toBe(bootIdentity);
    expect(original.value.sessions).toHaveLength(1);
    expect(original.value.windows.flatMap((window) => window.panes)).toHaveLength(2);
    const originalCwds = original.value.windows.flatMap((window) => window.panes.map((pane) => pane.cwd));
    const geometry = async (target) => (await runTmux([
      'list-panes', '-t', target, '-F', '#{pane_index}|#{pane_width}|#{pane_height}|#{pane_left}|#{pane_top}',
    ])).stdout.trim().split('\n').sort();
    const originalGeometry = await geometry('project:code');

    await endGeneration();
    expect(await first.checkpointer.reconcile('host-generation-ended')).toMatchObject({ status: 'written' });
    const archived = await first.store.readLatestCheckpoint();
    expect(archived).toMatchObject({ status: 'ok' });
    expect(archived.value.environment.endedReason).toBe('tmux-changed');
    await first.checkpointer.stop();

    await runTmux(['new-session', '-d', '-s', 'project', '-n', 'current', '-c', currentCwd]);
    const second = createCore();
    const liveBeforeRestore = await second.tmux.captureTopology();
    expect(liveBeforeRestore).toMatchObject({ status: 'ok' });
    const currentSession = liveBeforeRestore.sessions.find((session) => session.name === 'project');
    expect(currentSession).toBeTruthy();

    const plan = buildRestorePlan(archived.value, liveBeforeRestore, { historical: true });
    expect(plan.sessions).toEqual([
      expect.objectContaining({ sourceName: 'project', targetName: 'project-restored', action: 'create-renamed' }),
    ]);
    const restored = await executeRestore({
      plan,
      checkpoint: archived.value,
      tmux: second.tmux,
      agents: [],
      home,
    });
    expect(restored).toMatchObject({
      status: 'succeeded',
      restored: 1,
      failed: 0,
      summary: { sessions: 1, windows: 1, panes: 2 },
      results: [expect.objectContaining({ status: 'restored', warnings: [] })],
    });

    const finalTopology = await second.tmux.captureTopology();
    expect(finalTopology).toMatchObject({ status: 'ok' });
    expect(finalTopology.sessions.map((session) => session.name).sort()).toEqual(['project', 'project-restored']);
    expect(finalTopology.sessions.find((session) => session.name === 'project')).toMatchObject({
      id: currentSession.id,
      runtimeId: currentSession.runtimeId,
    });
    const restoredSession = finalTopology.sessions.find((session) => session.name === 'project-restored');
    const restoredWindowIds = new Set(restoredSession.windowLinks.map((link) => link.windowId));
    const restoredPanes = finalTopology.windows
      .filter((window) => restoredWindowIds.has(window.id))
      .flatMap((window) => window.panes);
    expect(restoredPanes).toHaveLength(2);
    expect(restoredPanes.map((pane) => pane.cwd).sort()).toEqual(originalCwds.sort());
    expect(await geometry(restoredPanes[0].runtimeId)).toEqual(originalGeometry);
  }, 30_000);
});
