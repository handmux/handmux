import { homedir } from 'node:os';
import { runTmux as defaultRunTmux } from '../tmux/commands.js';
import { createWorkspaceStore } from '../workspace/store.js';
import { createWorkspaceTmux } from '../workspace/tmuxAdapter.js';
import { createWorkspaceLock } from '../workspace/lock.js';
import { createWorkspaceBackground } from '../workspace/checkpointer.js';
import { createEnvironmentProvider } from '../workspace/environment.js';
import { createWorkspaceRuntime } from '../workspace/runtime.js';
import { claudeStatePath } from './state.js';
import { ask, select, CANCELLED } from './prompt.js';
import { t } from './i18n/index.js';

const RESTORE_FLAGS = new Set(['list', 'dryRun', 'checkpoint', 'session', 'lang', 'config']);
const SAFE_CHECKPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INVALID_TOPOLOGY_REASONS = new Set([
  'invalid-session', 'invalid-session-id', 'invalid-session-name', 'invalid-active-window-id',
  'invalid-window-links', 'missing-window-links', 'invalid-window-link', 'invalid-window-link-index',
  'duplicate-window-link', 'duplicate-window-link-index', 'dangling-window-link', 'dangling-active-window',
  'missing-window-panes', 'invalid-pane', 'duplicate-pane', 'dangling-active-pane',
]);

function line(stream, value = '') {
  if (typeof stream === 'function') stream(value);
  else stream.write(`${value}\n`);
}

function countAgents(checkpoint) {
  return (checkpoint?.windows || []).flatMap((window) => window?.panes || []).filter((pane) => pane?.agent).length;
}

function checkpointCounts(checkpoint) {
  const windows = checkpoint?.windows || [];
  return {
    sessions: (checkpoint?.sessions || []).length,
    windows: windows.length,
    panes: windows.reduce((sum, window) => sum + (window?.panes || []).length, 0),
    agents: countAgents(checkpoint),
  };
}

function unsupportedReason(reason) {
  if (reason === 'linked-windows-unsupported') return t('restore.reason.linkedWindows');
  if (INVALID_TOPOLOGY_REASONS.has(reason)) return t('restore.reason.invalidTopology');
  return t('restore.reason.unknown', { reason: reason || 'unknown' });
}

function posixQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function restoreCommand(checkpoint, sessions = []) {
  const selectedSessions = Array.isArray(sessions) ? sessions : [sessions];
  return selectedSessions.reduce(
    (command, session) => `${command} --session ${posixQuote(session)}`,
    `handmux restore --checkpoint ${posixQuote(checkpoint)}`,
  );
}

function manualSessionCommand(session) {
  return `tmux new-session -s ${posixQuote(session)}`;
}

function writeManualRecovery(stream, session) {
  line(stream, t('restore.manualRecovery', { command: manualSessionCommand(session) }));
}

function normalizeFlags(flags) {
  const unknown = Object.keys(flags).find((key) => !RESTORE_FLAGS.has(key));
  if (unknown) return { error: t('restore.badFlag', { flag: `--${unknown}` }) };
  if (flags.list !== undefined && typeof flags.list !== 'boolean') return { error: t('restore.flagBoolean', { flag: '--list' }) };
  if (flags.dryRun !== undefined && typeof flags.dryRun !== 'boolean') return { error: t('restore.flagBoolean', { flag: '--dry-run' }) };
  if (flags.checkpoint !== undefined && (typeof flags.checkpoint !== 'string' || !flags.checkpoint.trim())) {
    return { error: t('restore.checkpointValue') };
  }
  if (typeof flags.checkpoint === 'string'
      && (!SAFE_CHECKPOINT_ID.test(flags.checkpoint.trim()) || flags.checkpoint.trim() === '.' || flags.checkpoint.trim() === '..')) {
    return { error: t('restore.checkpointId') };
  }
  const rawSessions = flags.session === undefined ? [] : (Array.isArray(flags.session) ? flags.session : [flags.session]);
  if (rawSessions.some((name) => typeof name !== 'string' || !name.trim())) return { error: t('restore.sessionValue') };
  if (flags.list && (flags.dryRun || flags.checkpoint !== undefined || flags.session !== undefined)) {
    return { error: t('restore.listExclusive') };
  }
  return {
    list: flags.list === true,
    dryRun: flags.dryRun === true,
    checkpoint: flags.checkpoint?.trim(),
    sessions: rawSessions.map((name) => name.trim()),
  };
}

function validRows(rows) {
  return rows.filter((row) => row?.status === 'ok' && row.value);
}

function writeCheckpointRow(stdout, row) {
  if (row.status !== 'ok') {
    line(stdout, t('restore.listUnavailable', { id: row.id || '?', error: row.error || row.status || 'unknown' }));
    return;
  }
  const counts = checkpointCounts(row.value);
  line(stdout, t('restore.listRow', {
    id: row.id,
    time: row.value.archivedAt || row.value.capturedAt || '?',
    ...counts,
  }));
}

async function defaultSelectCheckpoint(rows) {
  return ask(select({
    message: t('restore.selectCheckpoint'),
    options: rows.map((row) => {
      const counts = checkpointCounts(row.value);
      return {
        value: row.id,
        label: row.id,
        hint: t('restore.selectHint', { time: row.value.archivedAt || row.value.capturedAt || '?', ...counts }),
      };
    }),
    initialValue: rows[0]?.id,
  }));
}

function writePlan(stdout, plan, dryRun, continuationCommand) {
  line(stdout, t('restore.planCheckpoint', {
    id: plan.checkpointId,
    time: plan.capturedAt || plan.archivedAt || '?',
    sessions: plan.summary?.sessions ?? 0,
    windows: plan.summary?.windows ?? 0,
    panes: plan.summary?.panes ?? 0,
  }));
  line(stdout, t('restore.planCurrent', { sessions: plan.preExistingRuntimeIds?.sessions?.length ?? 0 }));
  line(stdout);
  for (const item of plan.sessions || []) {
    if (item.action === 'create') line(stdout, t('restore.planCreate', { session: item.sourceName }));
    else if (item.action === 'create-renamed') line(stdout, t('restore.planRenamed', { session: item.sourceName, target: item.targetName }));
    else if (item.action === 'already-present') line(stdout, t('restore.planAlready', { session: item.sourceName }));
    else {
      const session = item.sourceName || item.logicalId || '?';
      line(stdout, t('restore.planUnavailable', { session, reason: unsupportedReason(item.reason) }));
      writeManualRecovery(stdout, session);
    }
  }
  for (const warning of plan.warnings || []) line(stdout, t('restore.warning', { warning }));
  line(stdout);
  line(stdout, t('restore.nonDestructive'));
  if (dryRun && !(plan.sessions || []).some((item) => item.action === 'unsupported')) {
    line(stdout, t('restore.dryRunHint', { command: continuationCommand }));
  }
}

function writeResult(stdout, stderr, checkpointId, result) {
  for (const item of result.results || []) {
    const session = item.sourceName || item.logicalId || '?';
    if (item.status === 'restored') {
      line(stdout, item.targetName && item.targetName !== session
        ? t('restore.resultRenamed', { session, target: item.targetName })
        : t('restore.resultRestored', { session }));
      for (const warning of item.warnings || []) line(stdout, t('restore.sessionWarning', { session, warning }));
    } else if (item.status === 'already-present') {
      line(stdout, t('restore.resultAlready', { session }));
    } else {
      const stage = item.stage || 'restore';
      line(stderr, t('restore.sessionFailed', {
        checkpoint: checkpointId,
        session,
        stage,
        error: stage === 'plan' ? unsupportedReason(item.error) : (item.error || 'unknown error'),
      }));
      if (stage === 'plan') writeManualRecovery(stderr, session);
      else line(stderr, t('restore.retrySession', { command: restoreCommand(checkpointId, session) }));
    }
  }
  if (result.status !== 'succeeded' && result.error && !(result.results || []).some((item) => item.status === 'failed')) {
    line(stderr, t('restore.operationFailed', { checkpoint: checkpointId, stage: 'restore', error: result.error }));
    line(stderr, t('restore.retry', { command: restoreCommand(checkpointId) }));
  }
  for (const warning of result.warnings || []) line(stdout, t('restore.warning', { warning }));
  line(stdout);
  line(stdout, t('restore.resultSummary', {
    restored: result.restored ?? 0,
    already: result.alreadyPresent ?? 0,
    failed: result.failed ?? 0,
  }));
  line(stdout, t('restore.nonDestructivePast'));
}

export function createStandaloneWorkspaceRuntime({
  home = homedir(),
  runTmux = defaultRunTmux,
  stateFile = claudeStatePath(home),
  createStore = createWorkspaceStore,
  createTmux = createWorkspaceTmux,
  createLock = createWorkspaceLock,
  createCheckpointer = createWorkspaceBackground,
  createRuntime = createWorkspaceRuntime,
  observeEnvironment,
  readOnly = false,
} = {}) {
  const store = createStore({ home });
  const tmux = createTmux({ run: runTmux, readOnly });
  const lock = createLock({ dir: store.paths.lockDir });
  const observe = observeEnvironment || createEnvironmentProvider({
    tmuxServerIdProvider: async () => {
      const observed = await tmux.observeEnvironment();
      if (observed.status === 'unknown') throw new Error('tmux environment unavailable');
      return observed.tmuxServerId;
    },
  });
  const checkpointer = createCheckpointer({ store, tmux, observeEnvironment: observe, lock, stateFile });
  return createRuntime({ store, tmux, lock, checkpointer, home });
}

export async function runWorkspaceCommand({
  flags = {},
  positionals = [],
  unknownShortFlags = [],
  home = homedir(),
  runtime,
  inputIsTTY = Boolean(process.stdin.isTTY),
  outputIsTTY = Boolean(process.stdout.isTTY),
  selectCheckpoint = defaultSelectCheckpoint,
  stdout = process.stdout,
  stderr = process.stderr,
  createRuntime = createStandaloneWorkspaceRuntime,
} = {}) {
  if (positionals.length > 0 || unknownShortFlags.length > 0) {
    const error = positionals.length > 0
      ? t('restore.unexpectedArgument', { value: positionals[0] })
      : t('restore.unknownShortFlag', { flag: unknownShortFlags[0] });
    line(stderr, error);
    line(stderr, t('restore.usage'));
    return 2;
  }
  const parsed = normalizeFlags(flags);
  if (parsed.error) {
    line(stderr, parsed.error);
    line(stderr, t('restore.usage'));
    return 2;
  }
  const workspace = runtime || createRuntime({ home, readOnly: parsed.dryRun });
  let resolvedCheckpoint = parsed.checkpoint || 'latest';

  try {
    if (parsed.list) {
      const rows = await workspace.listCheckpoints();
      if (rows.length === 0) line(stdout, t('restore.listEmpty'));
      else rows.forEach((row) => writeCheckpointRow(stdout, row));
      return 0;
    }

    let checkpointId;
    let historical = false;
    if (parsed.checkpoint && parsed.checkpoint !== 'latest') {
      checkpointId = parsed.checkpoint;
      historical = true;
    } else {
      const rows = validRows(await workspace.listCheckpoints());
      if (rows.length === 0) {
        line(stderr, t('restore.noCheckpoint'));
        return 1;
      }
      if (parsed.checkpoint === 'latest') {
        checkpointId = rows[0].id;
        historical = true;
      } else if (rows.length === 1) {
        checkpointId = rows[0].id;
      } else if (inputIsTTY && outputIsTTY) {
        checkpointId = await selectCheckpoint(rows);
        historical = true;
      } else {
        checkpointId = rows[0].id;
      }
    }

    if (typeof checkpointId !== 'string' || !checkpointId) {
      line(stderr, t('restore.selectionCancelled', { command: 'handmux restore' }));
      return 1;
    }
    resolvedCheckpoint = checkpointId;
    const request = { checkpointId, sessions: parsed.sessions, historical: historical || parsed.dryRun };
    if (parsed.dryRun) {
      const restorePlan = await workspace.getRestorePlan(request);
      writePlan(stdout, restorePlan, true, restoreCommand(checkpointId, parsed.sessions));
      return restorePlan.planSummary?.unsupported > 0 ? 1 : 0;
    }

    const result = await workspace.restoreNow(request);
    writeResult(stdout, stderr, checkpointId, result);
    return result.status === 'succeeded' ? 0 : 1;
  } catch (error) {
    if (error === CANCELLED) {
      line(stderr, t('restore.selectionCancelled', { command: 'handmux restore' }));
      return 1;
    }
    line(stderr, t('restore.error', { checkpoint: resolvedCheckpoint, error: error?.message || String(error) }));
    line(stderr, t('restore.retry', { command: restoreCommand(resolvedCheckpoint) }));
    return 1;
  }
}
