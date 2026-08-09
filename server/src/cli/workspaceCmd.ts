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
import type { ObservedEnvironment } from '../workspace/environment.js';
import type { RestoreRequest } from '../workspace/operations.js';

const RESTORE_FLAGS = new Set(['list', 'dryRun', 'checkpoint', 'session', 'lang', 'config']);
const SAFE_CHECKPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INVALID_TOPOLOGY_REASONS = new Set([
  'invalid-session', 'invalid-session-id', 'invalid-session-name', 'invalid-active-window-id',
  'invalid-window-links', 'missing-window-links', 'invalid-window-link', 'invalid-window-link-index',
  'duplicate-window-link', 'duplicate-window-link-index', 'dangling-window-link', 'dangling-active-window',
  'missing-window-panes', 'invalid-pane', 'duplicate-pane', 'dangling-active-pane',
]);

type RunTmux = (args: string[]) => unknown | Promise<unknown>;
type LineStream = ((value: string) => unknown) | { write(value: string): unknown };
type ObserveEnvironment = () => Promise<ObservedEnvironment>;
interface CheckpointOkRow { status: 'ok'; id: string; value: Record<string, unknown> }
interface CheckpointUnavailableRow { status: string; id: string; error: string }
type CheckpointRow = CheckpointOkRow | CheckpointUnavailableRow;
interface WorkspaceCommandRuntime {
  listCheckpoints(): Promise<unknown>;
  getRestorePlan(request: RestoreRequest): Promise<unknown>;
  restoreNow(request: RestoreRequest): Promise<unknown>;
}
interface ParsedRestoreFlags {
  list: boolean;
  dryRun: boolean;
  checkpoint?: string;
  sessions: string[];
}
type FlagParseResult = ParsedRestoreFlags | { error: string };
interface StoreBase { paths: { lockDir: string } }
interface StandaloneWorkspaceOptions<Store extends StoreBase, Tmux, Lock, Checkpointer, Runtime> {
  home?: string;
  runTmux?: RunTmux;
  stateFile?: string;
  createStore?: (options: { home: string }) => Store;
  createTmux?: (options: { run: RunTmux; readOnly: boolean }) => Tmux;
  createLock?: (options: { dir: string }) => Lock;
  createCheckpointer?: (options: {
    store: Store;
    tmux: Tmux;
    observeEnvironment: ObserveEnvironment;
    lock: Lock;
    stateFile: string;
  }) => Checkpointer;
  createRuntime?: (options: {
    store: Store;
    tmux: Tmux;
    lock: Lock;
    checkpointer: Checkpointer;
    home: string;
  }) => Runtime;
  observeEnvironment?: ObserveEnvironment;
  readOnly?: boolean;
}
interface RunWorkspaceOptions {
  flags?: Record<string, unknown>;
  positionals?: string[];
  unknownShortFlags?: string[];
  home?: string;
  runtime?: WorkspaceCommandRuntime;
  inputIsTTY?: boolean;
  outputIsTTY?: boolean;
  selectCheckpoint?: (rows: CheckpointOkRow[]) => Promise<unknown>;
  stdout?: LineStream;
  stderr?: LineStream;
  createRuntime?: (options: { home: string; readOnly: boolean }) => WorkspaceCommandRuntime;
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const arrayOfRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.flatMap((item) => {
    const record = recordOf(item);
    return record ? [record] : [];
  }) : [];
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function line(stream: LineStream, value = ''): void {
  if (typeof stream === 'function') stream(value);
  else stream.write(`${value}\n`);
}

function countAgents(checkpoint: Record<string, unknown>): number {
  return arrayOfRecords(checkpoint.windows)
    .flatMap((window) => arrayOfRecords(window.panes))
    .filter((pane) => Boolean(pane.agent)).length;
}

function checkpointCounts(checkpoint: Record<string, unknown>): {
  sessions: number;
  windows: number;
  panes: number;
  agents: number;
} {
  const windows = arrayOfRecords(checkpoint.windows);
  return {
    sessions: Array.isArray(checkpoint.sessions) ? checkpoint.sessions.length : 0,
    windows: windows.length,
    panes: windows.reduce((sum, window) => sum + (Array.isArray(window.panes) ? window.panes.length : 0), 0),
    agents: countAgents(checkpoint),
  };
}

function unsupportedReason(reason: unknown): string {
  if (reason === 'linked-windows-unsupported') return t('restore.reason.linkedWindows');
  if (typeof reason === 'string' && INVALID_TOPOLOGY_REASONS.has(reason)) return t('restore.reason.invalidTopology');
  return t('restore.reason.unknown', { reason: reason || 'unknown' });
}

function posixQuote(value: unknown): string {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function restoreCommand(checkpoint: string, sessions: readonly unknown[] | unknown = []): string {
  const selectedSessions = Array.isArray(sessions) ? sessions : [sessions];
  return selectedSessions.reduce<string>(
    (command, session) => `${command} --session ${posixQuote(session)}`,
    `handmux restore --checkpoint ${posixQuote(checkpoint)}`,
  );
}

function manualSessionCommand(session: unknown): string {
  return `tmux new-session -s ${posixQuote(session)}`;
}

function writeManualRecovery(stream: LineStream, session: unknown): void {
  line(stream, t('restore.manualRecovery', { command: manualSessionCommand(session) }));
}

function normalizeFlags(flags: Record<string, unknown>): FlagParseResult {
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
    sessions: (rawSessions as string[]).map((name) => name.trim()),
  };
}

function checkpointRows(value: unknown): CheckpointRow[] {
  if (!Array.isArray(value)) throw new Error('invalid checkpoint list');
  return value.map((candidate): CheckpointRow => {
    const row = recordOf(candidate);
    if (row?.status === 'ok' && typeof row.id === 'string' && row.id && recordOf(row.value)) {
      return candidate as CheckpointOkRow;
    }
    if (typeof row?.status === 'string' && typeof row.id === 'string' && row.id
      && typeof row.error === 'string') {
      return candidate as CheckpointUnavailableRow;
    }
    return {
      status: typeof row?.status === 'string' ? row.status : 'invalid',
      id: typeof row?.id === 'string' && row.id ? row.id : '?',
      error: typeof row?.error === 'string' ? row.error : 'invalid checkpoint record',
    };
  });
}

function validRows(rows: CheckpointRow[]): CheckpointOkRow[] {
  return rows.filter((row): row is CheckpointOkRow => 'value' in row);
}

function writeCheckpointRow(stdout: LineStream, row: CheckpointRow): void {
  if (!('value' in row)) {
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

async function defaultSelectCheckpoint(rows: CheckpointOkRow[]): Promise<string> {
  const selected = await ask(select({
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
  if (typeof selected !== 'string') throw new Error('invalid checkpoint selection');
  return selected;
}

function writePlan(stdout: LineStream, planInput: unknown, dryRun: boolean, continuationCommand: string): number {
  const plan = recordOf(planInput);
  if (!plan || typeof plan.checkpointId !== 'string') throw new Error('invalid restore plan');
  const summary = recordOf(plan.summary);
  const preExisting = recordOf(plan.preExistingRuntimeIds);
  const planSessions = arrayOfRecords(plan.sessions);
  line(stdout, t('restore.planCheckpoint', {
    id: plan.checkpointId,
    time: plan.capturedAt || plan.archivedAt || '?',
    sessions: summary?.sessions ?? 0,
    windows: summary?.windows ?? 0,
    panes: summary?.panes ?? 0,
  }));
  line(stdout, t('restore.planCurrent', {
    sessions: Array.isArray(preExisting?.sessions) ? preExisting.sessions.length : 0,
  }));
  line(stdout);
  for (const item of planSessions) {
    if (item.action === 'create') line(stdout, t('restore.planCreate', { session: item.sourceName }));
    else if (item.action === 'create-renamed') line(stdout, t('restore.planRenamed', { session: item.sourceName, target: item.targetName }));
    else if (item.action === 'already-present') line(stdout, t('restore.planAlready', { session: item.sourceName }));
    else {
      const session = item.sourceName || item.logicalId || '?';
      line(stdout, t('restore.planUnavailable', { session, reason: unsupportedReason(item.reason) }));
      writeManualRecovery(stdout, session);
    }
  }
  for (const warning of strings(plan.warnings)) line(stdout, t('restore.warning', { warning }));
  line(stdout);
  line(stdout, t('restore.nonDestructive'));
  if (dryRun && !planSessions.some((item) => item.action === 'unsupported')) {
    line(stdout, t('restore.dryRunHint', { command: continuationCommand }));
  }
  const unsupported = recordOf(plan.planSummary)?.unsupported;
  return typeof unsupported === 'number' && Number.isFinite(unsupported) ? unsupported : 0;
}

function writeResult(stdout: LineStream, stderr: LineStream, checkpointId: string, resultInput: unknown): string {
  const result = recordOf(resultInput);
  if (!result || typeof result.status !== 'string' || !Array.isArray(result.results)) {
    throw new Error('invalid restore result');
  }
  const resultRows = arrayOfRecords(result.results);
  for (const item of resultRows) {
    const session = item.sourceName || item.logicalId || '?';
    if (item.status === 'restored') {
      line(stdout, item.targetName && item.targetName !== session
        ? t('restore.resultRenamed', { session, target: item.targetName })
        : t('restore.resultRestored', { session }));
      for (const warning of strings(item.warnings)) line(stdout, t('restore.sessionWarning', { session, warning }));
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
  if (result.status !== 'succeeded' && result.error && !resultRows.some((item) => item.status === 'failed')) {
    line(stderr, t('restore.operationFailed', { checkpoint: checkpointId, stage: 'restore', error: result.error }));
    line(stderr, t('restore.retry', { command: restoreCommand(checkpointId) }));
  }
  for (const warning of strings(result.warnings)) line(stdout, t('restore.warning', { warning }));
  line(stdout);
  line(stdout, t('restore.resultSummary', {
    restored: result.restored ?? 0,
    already: result.alreadyPresent ?? 0,
    failed: result.failed ?? 0,
  }));
  line(stdout, t('restore.nonDestructivePast'));
  return result.status;
}

export function createStandaloneWorkspaceRuntime<
  Store extends StoreBase = ReturnType<typeof createWorkspaceStore>,
  Tmux = ReturnType<typeof createWorkspaceTmux>,
  Lock = ReturnType<typeof createWorkspaceLock>,
  Checkpointer = ReturnType<typeof createWorkspaceBackground>,
  Runtime = ReturnType<typeof createWorkspaceRuntime>,
>(options: StandaloneWorkspaceOptions<Store, Tmux, Lock, Checkpointer, Runtime> = {}): Runtime {
  const home = options.home ?? homedir();
  const runTmux = options.runTmux ?? defaultRunTmux;
  const stateFile = options.stateFile ?? claudeStatePath(home);
  const readOnly = options.readOnly ?? false;
  const createStore = (options.createStore ?? createWorkspaceStore) as (input: { home: string }) => Store;
  const createTmux = (options.createTmux ?? createWorkspaceTmux) as (input: { run: RunTmux; readOnly: boolean }) => Tmux;
  const createLock = (options.createLock ?? createWorkspaceLock) as (input: { dir: string }) => Lock;
  const createCheckpointer = (options.createCheckpointer ?? createWorkspaceBackground) as NonNullable<typeof options.createCheckpointer>;
  const createRuntime = (options.createRuntime ?? createWorkspaceRuntime) as NonNullable<typeof options.createRuntime>;
  const store = createStore({ home });
  const tmux = createTmux({ run: runTmux, readOnly });
  const lock = createLock({ dir: store.paths.lockDir });
  const observe = options.observeEnvironment || createEnvironmentProvider({
    tmuxServerIdProvider: async () => {
      const observeTmux = recordOf(tmux)?.observeEnvironment;
      if (typeof observeTmux !== 'function') throw new Error('tmux environment observer unavailable');
      const observedInput: unknown = await observeTmux.call(tmux);
      const observed = recordOf(observedInput);
      if (!observed) throw new Error('tmux environment unavailable');
      if (observed.status === 'unknown') throw new Error('tmux environment unavailable');
      return observed.tmuxServerId ?? null;
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
}: RunWorkspaceOptions = {}): Promise<number> {
  if (positionals.length > 0 || unknownShortFlags.length > 0) {
    const error = positionals.length > 0
      ? t('restore.unexpectedArgument', { value: positionals[0] })
      : t('restore.unknownShortFlag', { flag: unknownShortFlags[0] });
    line(stderr, error);
    line(stderr, t('restore.usage'));
    return 2;
  }
  const parsed = normalizeFlags(flags);
  if ('error' in parsed) {
    line(stderr, parsed.error);
    line(stderr, t('restore.usage'));
    return 2;
  }
  const workspace = runtime || createRuntime({ home, readOnly: parsed.dryRun });
  let resolvedCheckpoint = parsed.checkpoint || 'latest';

  try {
    if (parsed.list) {
      const rows = checkpointRows(await workspace.listCheckpoints());
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
      const rows = validRows(checkpointRows(await workspace.listCheckpoints()));
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
      const unsupported = writePlan(stdout, restorePlan, true, restoreCommand(checkpointId, parsed.sessions));
      return unsupported > 0 ? 1 : 0;
    }

    const result = await workspace.restoreNow(request);
    return writeResult(stdout, stderr, checkpointId, result) === 'succeeded' ? 0 : 1;
  } catch (error) {
    if (error === CANCELLED) {
      line(stderr, t('restore.selectionCancelled', { command: 'handmux restore' }));
      return 1;
    }
    line(stderr, t('restore.error', {
      checkpoint: resolvedCheckpoint,
      error: error instanceof Error ? error.message : String(error),
    }));
    line(stderr, t('restore.retry', { command: restoreCommand(resolvedCheckpoint) }));
    return 1;
  }
}
