#!/bin/sh
set -eu

socket_name=handmux-workspace-test

if [ "${1:-}" = "--container-a" ] || [ "${1:-}" = "--container-b" ]; then
  phase=${1#--container-}
  if [ "$phase" = "a" ]; then
    printf 'isolated socket: %s\n' "$socket_name"
    /usr/bin/tmux -L "$socket_name" new-session -d -s format-probe
    /usr/bin/tmux -L "$socket_name" set-option -t format-probe @probe_pipe 'a|b'
    /usr/bin/tmux -L "$socket_name" set-option -t format-probe @probe_backslash 'a\b'
    /usr/bin/tmux -L "$socket_name" set-option -t format-probe @probe_empty ''
    /usr/bin/tmux -L "$socket_name" set-option -t format-probe @probe_space 'two words'
    probe=$(/usr/bin/tmux -L "$socket_name" display-message -p -t format-probe '#{q:@probe_pipe}|#{q:@probe_backslash}|#{q:@probe_empty}|#{q:@probe_space}')
    printf 'tmux q probe raw: [%s]\n' "$probe"
    [ "$probe" = 'a\|b|a\\b||two\ words' ]
    /usr/bin/tmux -L "$socket_name" kill-server
    npx vitest run test/commands.test.js
    /usr/bin/tmux -L "$socket_name" kill-server >/dev/null 2>&1 || true
  fi
  HANDMUX_DOCKER_PHASE=$phase node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
// Exercise the same compiled JavaScript modules shipped in the npm package. Importing source `.js`
// specifiers only worked before the TypeScript migration and bypassed the production build contract.
import { createEnvironmentProvider } from './dist/src/workspace/environment.js';
import { createWorkspaceBackground } from './dist/src/workspace/checkpointer.js';
import { createWorkspaceLock } from './dist/src/workspace/lock.js';
import { buildRestorePlan } from './dist/src/workspace/planner.js';
import { executeRestore } from './dist/src/workspace/restore.js';
import { createWorkspaceRuntime } from './dist/src/workspace/runtime.js';
import { createWorkspaceStore } from './dist/src/workspace/store.js';
import { createWorkspaceTmux } from './dist/src/workspace/tmuxAdapter.js';
import { parseTmuxRows, tmuxFormat } from './dist/src/tmux/format.js';

const execFile = promisify(execFileCallback);
const SOCKET = 'handmux-workspace-test';
const HOME = '/test-home';
const STATE_A = path.join(HOME, 'agent-state-a.json');
const STATE_B = path.join(HOME, 'agent-state-b.json');
const EXPECTED_GEOMETRY = path.join(HOME, 'expected-geometry.json');
const AGENT_LOG = path.join(HOME, 'agent-argv.log');
const ORDINARY_LOG = path.join(HOME, 'ordinary-invocations');
const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';
const CODEX_ID = '22222222-2222-4222-8222-222222222222';
const FIXTURES = {
  claude: '/app/test/fixtures/workspace/claude-session.jsonl',
  codex: '/app/test/fixtures/workspace/codex-rollout.jsonl',
};
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const CODEX_ROLLOUT_DIR = path.join(CODEX_SESSIONS, '2026', '08', '09');
const CODEX_ROLLOUT = path.join(CODEX_ROLLOUT_DIR, `rollout-2026-08-09T00-00-00-${CODEX_ID}.jsonl`);

async function runTmux(args) {
  return execFile('/usr/bin/tmux', ['-L', SOCKET, ...args], { env: process.env });
}

async function tmuxText(args) {
  return (await runTmux(args)).stdout.trim();
}

async function checkpointCount(store) {
  return (await store.listCheckpoints()).filter((row) => row.status === 'ok').length;
}

async function writeFakeAgent(name) {
  const dir = path.join(HOME, 'fake-bin');
  await fsp.mkdir(dir, { recursive: true });
  const script = `#!/bin/sh\nprintf '%s' '${name}' >> "$HOME/agent-argv.log"\nfor arg in "$@"; do printf '\\t%s' "$arg" >> "$HOME/agent-argv.log"; done\nprintf '\\n' >> "$HOME/agent-argv.log"\nsleep 2\n`;
  const file = path.join(dir, name);
  await fsp.writeFile(file, script, { mode: 0o755 });
  await fsp.chmod(file, 0o755);
}

async function writeFakeCodex() {
  const dir = path.join(HOME, 'fake-bin');
  await fsp.mkdir(dir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  const listenAt = args.indexOf('--listen');
  const socketPath = args[listenAt + 1]?.replace(/^unix:\\/\\//, '');
  if (listenAt < 0 || !socketPath) process.exit(2);
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = net.createServer((socket) => socket.destroy());
  server.listen(socketPath);
  const close = () => server.close(() => process.exit(0));
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
} else if (args[0] === '--remote') {
  fs.appendFileSync(path.join(process.env.HOME, 'agent-argv.log'), ['codex', ...args.slice(2)].join('\\t') + '\\n');
  setTimeout(() => process.exit(0), 2_000);
} else {
  process.exit(2);
}
`;
  const file = path.join(dir, 'codex');
  await fsp.writeFile(file, script, { mode: 0o755 });
  await fsp.chmod(file, 0o755);
}

function environmentProvider(tmux, bootIdentity) {
  return createEnvironmentProvider({
    bootIdentityProvider: async () => bootIdentity,
    tmuxServerIdProvider: async () => {
      const observed = await tmux.observeEnvironment();
      if (observed.status === 'present') return observed.tmuxServerId;
      if (observed.status === 'absent') return null;
      throw new Error('tmux server identity is unknown');
    },
  });
}

function createCore(bootIdentity, stateFile, { managedCodexPane = null } = {}) {
  const store = createWorkspaceStore({ home: HOME });
  const tmux = createWorkspaceTmux({ run: (args) => runTmux(args) });
  const lock = createWorkspaceLock({ dir: store.paths.lockDir });
  const codexApp = managedCodexPane ? {
    discover: async (paneId) => paneId === managedCodexPane
      ? { managed: true, threadId: CODEX_ID }
      : { managed: false, threadId: null },
  } : null;
  const checkpointer = createWorkspaceBackground({
    store,
    tmux,
    lock,
    stateFile,
    observeEnvironment: environmentProvider(tmux, bootIdentity),
    getCodexApp: () => codexApp,
    codexSessions: CODEX_SESSIONS,
  });
  return { store, tmux, lock, checkpointer };
}

async function captureGeometry() {
  const { stdout } = await runTmux(['list-panes', '-a', '-F', tmuxFormat(['@handmux_pane_id', 'pane_left', 'pane_top', 'pane_width', 'pane_height'])]);
  return Object.fromEntries(parseTmuxRows(stdout, 5, 'geometry').map(([id, left, top, width, height]) => [id, [left, top, width, height].map(Number)]));
}

function sessionIdentity(topology, name) {
  const session = topology.sessions.find((item) => item.name === name);
  assert.ok(session, `missing live session ${name}`);
  return { id: session.id, runtimeId: session.runtimeId, name: session.name };
}

function assertSessionIdentity(topology, expected) {
  assert.deepEqual(sessionIdentity(topology, expected.name), expected);
}

async function assertFixtureFormats() {
  const claudeRows = (await fsp.readFile(FIXTURES.claude, 'utf8')).trim().split('\n').map(JSON.parse);
  const codexRows = (await fsp.readFile(FIXTURES.codex, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(claudeRows[1].sessionId, CLAUDE_ID);
  assert.equal(claudeRows[1].cwd, '/workspace/api');
  assert.equal(codexRows[0].type, 'session_meta');
  assert.equal(codexRows[0].payload.id, CODEX_ID);
  assert.equal(codexRows[0].payload.cwd, '/workspace/docs');
}

async function phaseA() {
  await assertFixtureFormats();
  await Promise.all([writeFakeAgent('claude'), writeFakeCodex()]);
  process.env.PATH = `${HOME}/fake-bin:${process.env.PATH}`;
  await fsp.rm(AGENT_LOG, { force: true });
  await fsp.rm(ORDINARY_LOG, { force: true });

  await runTmux(['new-session', '-d', '-s', 'api', '-n', 'shared', '-c', '/workspace/api']);
  await runTmux(['set-option', '-g', 'allow-rename', 'off']);
  await runTmux(['set-window-option', '-g', 'automatic-rename', 'off']);
  const ordinaryPane = await tmuxText(['display-message', '-p', '-t', 'api:shared.0', '#{pane_id}']);
  const sharedPane = await tmuxText(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', ordinaryPane, '-c', '/workspace/shared']);
  const apiAgentPane = await tmuxText(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'api:1', '-n', 'agent', '-c', '/workspace/api']);
  await runTmux(['new-session', '-d', '-s', 'docs', '-n', 'agent', '-c', '/workspace/docs']);
  const codexPane = await tmuxText(['display-message', '-p', '-t', 'docs:agent.0', '#{pane_id}']);
  await fsp.mkdir(CODEX_ROLLOUT_DIR, { recursive: true });
  await fsp.copyFile(FIXTURES.codex, CODEX_ROLLOUT);
  await runTmux(['link-window', '-s', 'api:shared', '-t', 'docs:5']);

  const apiSharedRuntime = await tmuxText(['display-message', '-p', '-t', 'api:shared', '#{window_id}']);
  const docsSharedRuntime = await tmuxText(['display-message', '-p', '-t', 'docs:shared', '#{window_id}']);
  assert.equal(apiSharedRuntime, docsSharedRuntime, 'real tmux link-window must share one window_id');

  await runTmux(['send-keys', '-t', ordinaryPane, '-l', '--', `printf x >> ${ORDINARY_LOG}; exec sleep 9999`]);
  await runTmux(['send-keys', '-t', ordinaryPane, 'Enter']);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await runTmux(['select-pane', '-t', sharedPane]);
  await runTmux(['select-window', '-t', 'api:shared']);
  await runTmux(['select-window', '-t', 'docs:agent']);

  await fsp.writeFile(STATE_A, `${JSON.stringify({
    [apiAgentPane]: { agent: 'claude', payload: { session_id: CLAUDE_ID, transcript_path: FIXTURES.claude } },
    [codexPane]: { agent: 'codex', payload: { session_id: CODEX_ID, transcript_path: FIXTURES.codex } },
  })}\n`, { mode: 0o600 });

  const first = createCore('boot-a', STATE_A, { managedCodexPane: codexPane });
  const observed = await first.tmux.observeEnvironment();
  console.log('container A environment:', JSON.stringify(observed));
  assert.equal(observed.status, 'present', JSON.stringify(observed));
  const captured = await first.tmux.captureTopology();
  console.log('container A topology:', JSON.stringify(captured));
  assert.equal(captured.status, 'ok', JSON.stringify(captured));
  const fingerprint = await first.tmux.topologyFingerprint();
  console.log('container A fingerprint:', JSON.stringify(fingerprint));
  assert.equal(typeof fingerprint, 'string', JSON.stringify(fingerprint));
  const started = await first.checkpointer.start();
  assert.equal(started.status, 'written', JSON.stringify(started));
  const live = await first.store.readLive();
  assert.equal(live.status, 'ok');
  assert.equal(live.value.sessions.length, 2);
  assert.equal(live.value.windows.length, 3);
  assert.equal(live.value.windows.flatMap((window) => window.panes).length, 4);
  const capturedAgents = live.value.windows.flatMap((window) => window.panes).filter((pane) => pane.agent);
  assert.deepEqual(capturedAgents.map((pane) => pane.agent.id).sort(), ['claude', 'codex']);
  assert.equal(capturedAgents.find((pane) => pane.agent.id === 'codex').agent.transcriptPath, CODEX_ROLLOUT);
  const linked = live.value.sessions.map((session) => session.windowLinks.find((link) => {
    const window = live.value.windows.find((item) => item.id === link.windowId);
    return window?.runtimeId === apiSharedRuntime;
  })?.windowId);
  assert.equal(linked[0], linked[1]);

  const current = JSON.parse(await fsp.readFile(first.store.paths.liveCurrent, 'utf8'));
  const mirror = JSON.parse(await fsp.readFile(first.store.paths.liveMirror, 'utf8'));
  assert.deepEqual(current, mirror, 'live current/mirror must be the same revision and hash');
  assert.equal(await checkpointCount(first.store), 0);
  await fsp.writeFile(EXPECTED_GEOMETRY, `${JSON.stringify(await captureGeometry())}\n`, { mode: 0o600 });
  await first.checkpointer.stop();

  const restarted = createCore('boot-a', STATE_A, { managedCodexPane: codexPane });
  const restartResult = await restarted.checkpointer.start();
  assert.equal(restartResult.status, 'unchanged');
  assert.equal(await checkpointCount(restarted.store), 0, 'ordinary handmux restart must not archive');
  await restarted.checkpointer.stop();
  console.log('container A: captured two live copies with linked-window and agent fixtures');
}

function syntheticFailureCheckpoint() {
  const goodSession = '33333333-3333-4333-8333-333333333301';
  const failSession = '33333333-3333-4333-8333-333333333302';
  const goodWindow = '33333333-3333-4333-8333-333333333311';
  const failWindow = '33333333-3333-4333-8333-333333333312';
  const goodPane = '33333333-3333-4333-8333-333333333321';
  const failPane = '33333333-3333-4333-8333-333333333322';
  return {
    value: {
      id: 'synthetic-failure',
      capturedAt: '2026-07-20T00:00:00.000Z',
      archivedAt: '2026-07-20T00:01:00.000Z',
      environment: { id: 'synthetic-failure', bootIdentity: 'fixture', tmuxServerId: 'fixture', endedReason: 'tmux-changed' },
      tmuxVersion: 'fixture',
      active: { sessionId: goodSession, windowId: goodWindow, paneId: goodPane },
      sessions: [
        { id: goodSession, runtimeId: '$fixture1', name: 'degraded', windowLinks: [{ windowId: goodWindow, index: 0 }], activeWindowId: goodWindow },
        { id: failSession, runtimeId: '$fixture2', name: 'broken', windowLinks: [{ windowId: failWindow, index: 0 }], activeWindowId: failWindow },
      ],
      windows: [
        { id: goodWindow, runtimeId: '@fixture1', name: 'fallback', index: 0, layout: 'invalid-layout', activePaneId: goodPane, panes: [{ id: goodPane, runtimeId: '%fixture1', index: 0, cwd: '/workspace/does-not-exist', agent: null }] },
        { id: failWindow, runtimeId: '@fixture2', name: 'failure', index: 0, layout: 'invalid-layout', activePaneId: failPane, panes: [{ id: failPane, runtimeId: '%fixture2', index: 0, cwd: '/workspace/api', agent: null }] },
      ],
    },
    ids: { goodSession, failSession },
  };
}

function syntheticAgentCheckpoint({ sessionId, windowId, paneId, name, transcriptPath }) {
  return {
    id: `agent-${name}`,
    capturedAt: '2026-07-20T00:00:00.000Z',
    archivedAt: '2026-07-20T00:01:00.000Z',
    environment: { id: `agent-${name}`, bootIdentity: 'fixture', tmuxServerId: 'fixture', endedReason: 'tmux-changed' },
    tmuxVersion: 'fixture',
    active: { sessionId, windowId, paneId },
    sessions: [{ id: sessionId, runtimeId: '$fixture', name, windowLinks: [{ windowId, index: 0 }], activeWindowId: windowId }],
    windows: [{
      id: windowId, runtimeId: '@fixture', name: 'agent', index: 0, layout: 'invalid-layout', activePaneId: paneId,
      panes: [{
        id: paneId, runtimeId: '%fixture', index: 0, cwd: '/workspace/api',
        agent: { id: 'claude', sessionId: CLAUDE_ID, transcriptPath },
      }],
    }],
  };
}

async function phaseB() {
  await assertFixtureFormats();
  process.env.PATH = `${HOME}/fake-bin:${process.env.PATH}`;
  await fsp.writeFile(STATE_B, '{}\n', { mode: 0o600 });

  const core = createCore('boot-b', STATE_B);
  const bootedWithoutTmux = await core.checkpointer.start();
  assert.equal(bootedWithoutTmux.status, 'written');
  assert.equal(await checkpointCount(core.store), 1);
  const emptyLive = await core.store.readLive();
  assert.equal(emptyLive.status, 'ok');
  assert.equal(emptyLive.value.sessions.length, 0, 'boot change must retain recovery before tmux returns');

  await runTmux(['new-session', '-d', '-s', 'new-work', '-n', 'current', '-c', '/workspace/shared']);
  await runTmux(['set-option', '-g', 'allow-rename', 'off']);
  await runTmux(['set-window-option', '-g', 'automatic-rename', 'off']);
  await runTmux(['new-session', '-d', '-s', 'api', '-n', 'current', '-c', '/workspace/api']);
  await runTmux(['set-environment', '-g', 'PATH', process.env.PATH]);
  assert.equal(await tmuxText(['show-environment', '-g', 'PATH']), `PATH=${process.env.PATH}`);

  const preRestore = await core.tmux.captureTopology();
  assert.equal(preRestore.status, 'ok');
  const existingNewWork = sessionIdentity(preRestore, 'new-work');
  const existingApi = sessionIdentity(preRestore, 'api');

  const unknown = createWorkspaceBackground({
    store: core.store,
    tmux: core.tmux,
    lock: core.lock,
    stateFile: STATE_B,
    observeEnvironment: async () => ({ status: 'unknown' }),
  });
  const unknownResult = await unknown.reconcile('unknown-provider');
  assert.equal(unknownResult.status, 'unknown');
  assert.equal(await checkpointCount(core.store), 1, 'unknown provider must not archive');

  const attached = await core.checkpointer.reconcile('tmux-attached');
  assert.equal(attached.status, 'written');
  assert.equal(await checkpointCount(core.store), 1);
  const checkpointResult = await core.store.readLatestCheckpoint();
  assert.equal(checkpointResult.status, 'ok');
  const checkpoint = checkpointResult.value;
  assert.equal(checkpoint.environment.bootIdentity, 'boot-a');
  assert.equal(checkpoint.environment.endedReason, 'boot-changed');
  const checkpointId = checkpoint.id;
  const firstRecovery = await core.store.readRecovery(checkpointId);
  assert.equal(firstRecovery.status, 'ok');
  assert.equal(firstRecovery.value.pendingSessionIds.length, 2);
  assert.equal((await core.checkpointer.reconcile('same-generation')).status, 'unchanged');
  assert.equal(await checkpointCount(core.store), 1, 'boot change must archive exactly once');

  const runtime = createWorkspaceRuntime({
    store: core.store,
    tmux: core.tmux,
    lock: core.lock,
    checkpointer: core.checkpointer,
    home: HOME,
  });
  const dryRun = await runtime.getRestorePlan({ checkpointId: 'latest' });
  assert.equal(dryRun.planSummary.create, 1);
  assert.equal(dryRun.planSummary.renamed, 1);
  assert.equal(dryRun.sessions.find((item) => item.sourceName === 'api').targetName, 'api-restored');
  assert.equal(dryRun.sessions.find((item) => item.sourceName === 'docs').targetName, 'docs');
  const unsupported = buildRestorePlan(checkpoint, preRestore, { supportsLinkedWindows: false, historical: true });
  assert.ok(unsupported.sessions.every((item) => item.action === 'unsupported' && item.reason === 'linked-windows-unsupported'));

  const restoreApi = await runtime.restoreNow({ checkpointId: 'latest', sessions: ['api'] });
  assert.equal(restoreApi.status, 'succeeded');
  assert.deepEqual(restoreApi.results.map(({ sourceName, targetName, status }) => ({ sourceName, targetName, status })), [
    { sourceName: 'api', targetName: 'api-restored', status: 'restored' },
  ]);
  assert.deepEqual(restoreApi.results[0].warnings, []);
  assert.equal(await checkpointCount(core.store), 1, 'restore must not archive');
  const recoveryAfterApi = await core.store.readRecovery(checkpointId);
  assert.equal(recoveryAfterApi.value.pendingSessionIds.length, 1);
  assert.deepEqual(recoveryAfterApi.value.pendingSessionIds, [checkpoint.sessions.find((session) => session.name === 'docs').id]);

  const restoreDocs = await runtime.restoreNow({ checkpointId: 'latest', sessions: ['docs'] });
  assert.equal(restoreDocs.status, 'succeeded');
  assert.equal(restoreDocs.results[0].status, 'restored');
  assert.deepEqual(restoreDocs.results[0].warnings, []);
  assert.equal(await checkpointCount(core.store), 1, 'restore completion must only update live state');
  const resolved = await core.store.readRecovery(checkpointId);
  assert.deepEqual(resolved.value.pendingSessionIds, []);
  assert.ok(resolved.value.resolvedAt);

  const restored = await core.tmux.captureTopology();
  assertSessionIdentity(restored, existingNewWork);
  assertSessionIdentity(restored, existingApi);
  assert.ok(restored.sessions.some((session) => session.name === 'api-restored'));
  assert.ok(restored.sessions.some((session) => session.name === 'docs'));

  const sourceSessions = new Map(checkpoint.sessions.map((session) => [session.id, session]));
  const restoredSessions = new Map(restored.sessions.map((session) => [session.id, session]));
  for (const [id, source] of sourceSessions) {
    assert.equal(restoredSessions.get(id)?.activeWindowId, source.activeWindowId, `active window mismatch for ${source.name}`);
    assert.equal(restoredSessions.get(id)?.windowLinks.length, source.windowLinks.length, `window count mismatch for ${source.name}`);
  }
  const restoredWindows = new Map(restored.windows.map((window) => [window.id, window]));
  for (const source of checkpoint.windows) {
    const actual = restoredWindows.get(source.id);
    assert.ok(actual, `missing restored window ${source.name}`);
    assert.equal(actual.panes.length, source.panes.length, `pane count mismatch for ${source.name}`);
    assert.equal(actual.activePaneId, source.activePaneId, `active pane mismatch for ${source.name}`);
    const actualPanes = new Map(actual.panes.map((pane) => [pane.id, pane]));
    for (const pane of source.panes) assert.equal(actualPanes.get(pane.id)?.cwd, pane.cwd, `cwd mismatch for pane ${pane.id}`);
  }

  const expectedGeometry = JSON.parse(await fsp.readFile(EXPECTED_GEOMETRY, 'utf8'));
  const restoredGeometry = await captureGeometry();
  for (const [paneId, geometry] of Object.entries(expectedGeometry)) assert.deepEqual(restoredGeometry[paneId], geometry, `layout mismatch for pane ${paneId}`);
  const sharedWindowId = checkpoint.sessions[0].windowLinks.map((link) => link.windowId).find((windowId) => checkpoint.sessions[1].windowLinks.some((link) => link.windowId === windowId));
  const linkedOwners = checkpoint.sessions.map((session) => restoredSessions.get(session.id).windowLinks.find((link) => link.windowId === sharedWindowId));
  assert.ok(linkedOwners.every(Boolean));
  const apiSharedRuntime = await tmuxText(['display-message', '-p', '-t', 'api-restored:shared', '#{window_id}']);
  const docsSharedRuntime = await tmuxText(['display-message', '-p', '-t', 'docs:shared', '#{window_id}']);
  assert.equal(apiSharedRuntime, docsSharedRuntime, 'restored linked window must keep one real window_id');

  const agentLines = (await fsp.readFile(AGENT_LOG, 'utf8')).trim().split('\n').sort();
  assert.deepEqual(agentLines, [
    `claude\t--resume\t${CLAUDE_ID}`,
    `codex\tresume\t${CODEX_ID}`,
  ].sort());
  assert.equal(await fsp.readFile(ORDINARY_LOG, 'utf8'), 'x', 'ordinary pane command must not replay');

  const beforeSecond = restored.sessions.length;
  const secondRestore = await runtime.restoreNow({ checkpointId: 'latest' });
  assert.equal(secondRestore.status, 'succeeded');
  assert.equal(secondRestore.restored, 0);
  assert.equal(secondRestore.results.length, 0);
  assert.equal((await core.tmux.captureTopology()).sessions.length, beforeSecond);

  await runTmux(['kill-session', '-t', '=docs']);
  const noPrompt = await runtime.getRestorePlan({ checkpointId: 'latest' });
  assert.equal(noPrompt.promptEligible, false);
  assert.equal(noPrompt.sessions.length, 0, 'resolved recovery must not repopulate pending ids');
  const historical = await runtime.getRestorePlan({ checkpointId, historical: true, sessions: ['docs'] });
  assert.equal(historical.sessions.length, 1);
  assert.ok(['create', 'create-renamed'].includes(historical.sessions[0].action));

  async function verifyAgentFailure(checkpointValue, warningPattern) {
    const before = await core.tmux.captureTopology();
    const plan = buildRestorePlan(checkpointValue, before, { historical: true });
    const result = await executeRestore({ plan, checkpoint: checkpointValue, tmux: core.tmux, home: HOME });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(result.results[0].status, 'restored');
    assert.ok(result.results[0].warnings.some((warning) => warningPattern.test(warning)), JSON.stringify(result));
    const after = await core.tmux.captureTopology();
    assertSessionIdentity(after, existingNewWork);
    assertSessionIdentity(after, existingApi);
    const session = after.sessions.find((item) => item.id === checkpointValue.sessions[0].id);
    assert.ok(session, `missing agent failure shell ${checkpointValue.sessions[0].name}`);
    const window = after.windows.find((item) => item.id === checkpointValue.windows[0].id);
    assert.equal(window?.panes[0]?.cwd, '/workspace/api');
  }

  await verifyAgentFailure(syntheticAgentCheckpoint({
    sessionId: '44444444-4444-4444-8444-444444444401',
    windowId: '44444444-4444-4444-8444-444444444411',
    paneId: '44444444-4444-4444-8444-444444444421',
    name: 'agent-missing-context',
    transcriptPath: '/app/test/fixtures/workspace/missing-session.jsonl',
  }), /context is unavailable.*shell was restored/i);

  const claudeBinary = path.join(HOME, 'fake-bin', 'claude');
  const savedClaudeBinary = `${claudeBinary}.saved`;
  await fsp.rename(claudeBinary, savedClaudeBinary);
  try {
    await verifyAgentFailure(syntheticAgentCheckpoint({
      sessionId: '44444444-4444-4444-8444-444444444402',
      windowId: '44444444-4444-4444-8444-444444444412',
      paneId: '44444444-4444-4444-8444-444444444422',
      name: 'agent-missing-cli',
      transcriptPath: FIXTURES.claude,
    }), /executable is unavailable.*shell was restored|shell was restored.*executable unavailable/i);
  } finally {
    await fsp.rename(savedClaudeBinary, claudeBinary);
  }

  const successfulClaude = await fsp.readFile(claudeBinary, 'utf8');
  await fsp.writeFile(claudeBinary, '#!/bin/sh\nexit 23\n', { mode: 0o755 });
  try {
    await verifyAgentFailure(syntheticAgentCheckpoint({
      sessionId: '44444444-4444-4444-8444-444444444403',
      windowId: '44444444-4444-4444-8444-444444444413',
      paneId: '44444444-4444-4444-8444-444444444423',
      name: 'agent-resume-nonzero',
      transcriptPath: FIXTURES.claude,
    }), /exited 23.*shell was restored|shell was restored.*exited 23/i);
  } finally {
    await fsp.writeFile(claudeBinary, successfulClaude, { mode: 0o755 });
  }

  const failureFixture = syntheticFailureCheckpoint();
  const liveBeforeFailure = await core.tmux.captureTopology();
  const failurePlan = buildRestorePlan(failureFixture.value, liveBeforeFailure, { historical: true });
  const failingTmux = new Proxy(core.tmux, {
    get(target, property) {
      if (property === 'createTemporarySession') {
        return async (input) => {
          if (input.sessionLogicalId === failureFixture.ids.failSession) throw new Error('injected session creation failure');
          return target.createTemporarySession(input);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const isolatedFailure = await executeRestore({
    plan: failurePlan,
    checkpoint: failureFixture.value,
    tmux: failingTmux,
    home: HOME,
  });
  assert.equal(isolatedFailure.status, 'partial', JSON.stringify(isolatedFailure));
  assert.deepEqual(isolatedFailure.results.map(({ sourceName, status }) => ({ sourceName, status })), [
    { sourceName: 'degraded', status: 'restored' },
    { sourceName: 'broken', status: 'failed' },
  ]);
  assert.ok(isolatedFailure.results[0].warnings.some((warning) => warning.includes('/workspace/does-not-exist') && warning.includes(HOME)));
  assert.ok(isolatedFailure.results[0].warnings.some((warning) => warning.includes('layout') && warning.includes('default layout')));
  assert.match(isolatedFailure.results[1].error, /injected session creation failure/);
  assert.equal(isolatedFailure.results[1].stage, 'topology');
  const afterFailure = await core.tmux.captureTopology();
  assertSessionIdentity(afterFailure, existingNewWork);
  assertSessionIdentity(afterFailure, existingApi);
  assert.ok(afterFailure.sessions.some((session) => session.id === failureFixture.ids.goodSession));
  assert.ok(!afterFailure.sessions.some((session) => session.id === failureFixture.ids.failSession));

  await core.checkpointer.reconcile('before-generation-change');
  const beforeGeneration = await checkpointCount(core.store);
  await runTmux(['kill-server']);
  let generationEnded;
  // tmux 3.3a can return from kill-server just before the old socket teardown completes.
  for (let attempt = 0; attempt < 20; attempt++) {
    generationEnded = await core.checkpointer.reconcile('tmux-generation-ended');
    if (generationEnded.status === 'written') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(generationEnded.status, 'written', 'missing tmux must archive before a new server exists');
  assert.equal(await checkpointCount(core.store), beforeGeneration + 1);
  assert.equal((await core.store.readLatestCheckpoint()).value.environment.endedReason, 'tmux-changed');
  const generationEmpty = await core.store.readLive();
  assert.equal(generationEmpty.status, 'ok');
  assert.equal(generationEmpty.value.sessions.length, 0, 'ended generation must write explicit empty live state');

  // tmux 3.3a can return from kill-server just before the old socket teardown completes. Retry only
  // that narrow handoff error; validation/target/configuration failures must still fail immediately.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await runTmux(['new-session', '-d', '-s', 'generation-c', '-n', 'fresh', '-c', '/workspace/shared']);
      break;
    } catch (error) {
      if (!String(error?.stderr || error?.message || error).includes('server exited unexpectedly') || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const generationAttached = await core.checkpointer.reconcile('tmux-generation-attached');
  assert.equal(generationAttached.status, 'written');
  assert.equal(await checkpointCount(core.store), beforeGeneration + 1);
  assert.equal((await core.checkpointer.reconcile('same-new-generation')).status, 'unchanged');
  assert.equal(await checkpointCount(core.store), beforeGeneration + 1, 'tmux generation must archive once');
  await core.checkpointer.stop();
  console.log('container B: boot/generation, restore, linked-window, agents, idempotency and failures verified');
}

if (process.env.HANDMUX_DOCKER_PHASE === 'a') await phaseA();
else if (process.env.HANDMUX_DOCKER_PHASE === 'b') await phaseB();
else throw new Error('unknown Docker scenario phase');
NODE
  exit 0
fi

exec 2>&1

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
resource_prefix="handmux-workspace-test-$$"
image_name="${resource_prefix}:local"
container_a="${resource_prefix}-a"
container_b="${resource_prefix}-b"
volume_name="${resource_prefix}-home"

cleanup() {
  docker rm -f "$container_a" >/dev/null 2>&1 || true
  docker rm -f "$container_b" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
  docker image rm "$image_name" >/dev/null 2>&1 || true
  printf 'cleaned resources: %s\n' "$resource_prefix"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

docker volume create "$volume_name" >/dev/null
docker build --file "$project_dir/test/docker/workspace-recovery.Dockerfile" --tag "$image_name" "$project_dir"

docker run --name "$container_a" \
  --volume "$volume_name:/test-home" \
  --env HOME=/test-home \
  "$image_name" sh test/docker/workspace-recovery.sh --container-a
docker rm "$container_a" >/dev/null

docker run --name "$container_b" \
  --volume "$volume_name:/test-home" \
  --env HOME=/test-home \
  "$image_name" sh test/docker/workspace-recovery.sh --container-b
docker rm "$container_b" >/dev/null

printf 'workspace recovery Docker scenario: PASS\n'
