import crypto from 'node:crypto';

const ACTIVE = new Set(['pending', 'running']);
const TERMINAL = new Set(['succeeded', 'partial', 'failed']);

export interface RestoreRequest {
  checkpointId: string;
  sessions: string[];
  historical: boolean;
}
export interface OperationProgress { completed: number; total: number }
export interface RestoreOperation {
  id: string;
  kind: 'workspace-restore';
  status: string;
  request: RestoreRequest;
  requestHash: string;
  ownerPid: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progress: OperationProgress;
  results: unknown[];
  mapping: unknown;
  error: string | null;
  [key: string]: unknown;
}
type OperationRead = { status: string; value?: RestoreOperation };
interface OperationStore {
  writeOperation(operation: RestoreOperation): Promise<unknown>;
  readOperation(id: string): Promise<OperationRead>;
  listOperations?(): Promise<Array<OperationRead>>;
}
interface OperationLockHandle { release(): Promise<void> }
interface RunnerContext {
  operationId: string;
  request: RestoreRequest;
  onRunning(): Promise<RestoreOperation>;
  onTerminal(value: unknown): Promise<RestoreOperation>;
  onProgress(progress: { completed: number; total: number; result?: unknown }): Promise<void>;
}
type OperationRunner = (context: RunnerContext) => unknown | Promise<unknown>;
interface ExecuteOptions { deferRunning?: boolean }
interface InactiveOperationError extends Error {
  code: typeof INACTIVE_OPERATION;
  operation: RestoreOperation | null;
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

function iso(now: number | (() => number)): string {
  return new Date(typeof now === 'function' ? now() : now).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const unavailableLock = async () => { throw new Error('workspace operation lock is unavailable'); };
const INACTIVE_OPERATION = 'WORKSPACE_OPERATION_INACTIVE';

export function normalizeRestoreRequest(request: unknown = {}): RestoreRequest {
  const record = recordOf(request) ?? {};
  const checkpointId = typeof record.checkpointId === 'string' && record.checkpointId ? record.checkpointId : 'latest';
  const rawSessions = Array.isArray(record.sessions) ? record.sessions : record.sessions ? [record.sessions] : [];
  const sessions = [...new Set(rawSessions.filter((name): name is string => typeof name === 'string' && Boolean(name)))].sort();
  return { checkpointId, sessions, historical: record.historical === true };
}

export function restoreRequestHash(request: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(normalizeRestoreRequest(request))).digest('hex');
}

export function createOperationManager({
  store,
  now = Date.now,
  randomUUID = crypto.randomUUID,
  pid = process.pid,
  tryAcquireOperationLock = unavailableLock,
  pendingGraceMs = 250,
  wait = delay,
}: {
  store: OperationStore;
  now?: () => number;
  randomUUID?: () => string;
  pid?: number;
  tryAcquireOperationLock?: (owner: { operationId: string }) => Promise<OperationLockHandle | null>;
  pendingGraceMs?: number;
  wait?: (ms: number) => Promise<unknown>;
}) {
  const values = new Map<string, RestoreOperation>();
  const activeByHash = new Map<string, string>();
  const localIds = new Set<string>();

  async function persist(operation: RestoreOperation): Promise<RestoreOperation> {
    if (localIds.has(operation.id)) values.set(operation.id, operation);
    await store.writeOperation(operation);
    return operation;
  }

  async function readFresh(id: string): Promise<RestoreOperation | null> {
    const result = await store.readOperation(id);
    return result.status === 'ok' && result.value ? result.value : null;
  }

  async function assessExternal(
    operation: RestoreOperation,
    { allowPendingGrace = true }: { allowPendingGrace?: boolean } = {},
  ): Promise<{ active: boolean; operation: RestoreOperation | null; interrupted?: boolean }> {
    let current = await readFresh(operation.id);
    if (!current) return { active: false, operation: null };
    if (!ACTIVE.has(current?.status)) return { active: false, operation: current };
    if (current.status === 'pending' && allowPendingGrace) {
      const createdAt = Date.parse(current.createdAt);
      const age = Number.isFinite(createdAt) ? Math.max(0, now() - createdAt) : Number.POSITIVE_INFINITY;
      const remaining = pendingGraceMs - age;
      if (remaining > 0) {
        await wait(remaining);
        current = await readFresh(current.id);
        if (!current || !ACTIVE.has(current.status)) return { active: false, operation: current };
      }
    }
    let handle;
    try {
      handle = await tryAcquireOperationLock({ operationId: `assess-${current.id}` });
    } catch {
      return { active: true, operation: current };
    }
    if (!handle) return { active: true, operation: current };
    try {
      current = await readFresh(current.id);
      if (!current || !ACTIVE.has(current.status)) return { active: false, operation: current };
      const interrupted = {
        ...current,
        status: 'interrupted',
        error: 'restore interrupted by process restart; retry the restore',
        completedAt: iso(now),
        updatedAt: iso(now),
      };
      await store.writeOperation(interrupted);
      return { active: false, operation: interrupted, interrupted: true };
    } finally {
      await handle.release();
    }
  }

  async function findExternalActive(requestHash: string): Promise<RestoreOperation | null> {
    const rows = typeof store.listOperations === 'function' ? await store.listOperations() : [];
    for (const row of rows) {
      const value = row.value;
      if (row.status !== 'ok' || !value || localIds.has(value.id) || !ACTIVE.has(value.status)) continue;
      if (value.requestHash !== requestHash || value.requestHash !== restoreRequestHash(value.request)) continue;
      const assessed = await assessExternal(value);
      if (assessed.active) return assessed.operation;
    }
    return null;
  }

  async function execute(
    operation: RestoreOperation,
    runner: OperationRunner,
    { deferRunning = false }: ExecuteOptions = {},
  ): Promise<RestoreOperation> {
    let current = operation;
    let running = false;
    let terminalStatus: string | null = null;
    const onRunning = async (): Promise<RestoreOperation> => {
      if (running) return current;
      const persisted = await readFresh(current.id);
      if (!persisted || !ACTIVE.has(persisted.status)) {
        if (persisted) {
          current = persisted;
          if (localIds.has(current.id)) values.set(current.id, current);
        } else {
          localIds.delete(current.id);
          values.delete(current.id);
        }
        const error = new Error(`restore operation ${current.id} is no longer active`) as InactiveOperationError;
        error.code = INACTIVE_OPERATION;
        error.operation = persisted;
        throw error;
      }
      current = persisted;
      current = await persist({
        ...current,
        status: 'running',
        startedAt: iso(now),
        updatedAt: iso(now),
      });
      running = true;
      return current;
    };
    const onTerminal = async (value: unknown): Promise<RestoreOperation> => {
      await onRunning();
      const result: Record<string, unknown> = value instanceof Error
        ? { status: 'failed', error: errorMessage(value) }
        : recordOf(value) ?? { status: 'failed', error: errorMessage(value) };
      const requestedStatus = typeof result.status === 'string' && TERMINAL.has(result.status) ? result.status : 'failed';
      if (terminalStatus && requestedStatus !== terminalStatus) return current;
      const status = terminalStatus || requestedStatus;
      const candidate = {
        ...current,
        ...result,
        status,
        progress: {
          completed: Array.isArray(result.results) ? result.results.length : current.progress.completed,
          total: current.progress.total,
        },
        completedAt: current.completedAt || iso(now),
      };
      if (terminalStatus && JSON.stringify(candidate) === JSON.stringify(current)) return current;
      current = await persist({ ...candidate, updatedAt: iso(now) });
      terminalStatus = status;
      return current;
    };
    try {
      if (!deferRunning) await onRunning();
      const result = await runner({
        operationId: current.id,
        request: current.request,
        onRunning,
        onTerminal,
        onProgress: async ({ completed, total, result: row }) => {
          await onRunning();
          const results = row ? [...(current.results || []), row] : (current.results || []);
          current = await persist({
            ...current,
            progress: { completed, total },
            results,
            updatedAt: iso(now),
          });
        },
      });
      await onTerminal(result);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === INACTIVE_OPERATION) {
        const inactive = error as InactiveOperationError;
        if (inactive.operation) current = inactive.operation;
      } else {
        try { await onTerminal(error); } catch { /* pending/running file is interrupted on restart */ }
      }
    } finally {
      if (activeByHash.get(operation.requestHash) === operation.id) activeByHash.delete(operation.requestHash);
    }
    return current;
  }

  async function createPending(request: unknown): Promise<{ reused: boolean; operation: RestoreOperation }> {
    const normalized = normalizeRestoreRequest(request);
    const requestHash = restoreRequestHash(normalized);
    const existingId = activeByHash.get(requestHash);
    if (existingId) {
      const existing = values.get(existingId);
      if (existing) return { reused: true, operation: existing };
      activeByHash.delete(requestHash);
    }
    const external = await findExternalActive(requestHash);
    if (external) return { reused: true, operation: external };
    const id = randomUUID();
    const operation: RestoreOperation = {
      id,
      kind: 'workspace-restore',
      status: 'pending',
      request: normalized,
      requestHash,
      ownerPid: pid,
      createdAt: iso(now),
      updatedAt: iso(now),
      startedAt: null,
      completedAt: null,
      progress: { completed: 0, total: 0 },
      results: [],
      mapping: null,
      error: null,
    };
    localIds.add(id);
    activeByHash.set(requestHash, id);
    try {
      await persist(operation);
    } catch (error) {
      activeByHash.delete(requestHash);
      localIds.delete(id);
      values.delete(id);
      throw error;
    }
    return { reused: false, operation };
  }

  async function start(request: unknown, runner: OperationRunner, options?: ExecuteOptions) {
    const pending = await createPending(request);
    if (pending.reused) {
      return { operationId: pending.operation.id, status: pending.operation.status, reused: true };
    }
    Promise.resolve().then(() => execute(pending.operation, runner, options)).catch(() => {});
    return { operationId: pending.operation.id, status: 'pending', reused: false };
  }

  async function run(request: unknown, runner: OperationRunner, options?: ExecuteOptions): Promise<RestoreOperation> {
    const pending = await createPending(request);
    if (pending.reused) return pending.operation;
    return execute(pending.operation, runner, options);
  }

  async function get(id: string): Promise<RestoreOperation | null> {
    if (localIds.has(id) && values.has(id)) return values.get(id) ?? null;
    return readFresh(id);
  }

  async function interruptOrphans(): Promise<number> {
    const rows = typeof store.listOperations === 'function' ? await store.listOperations() : [];
    let interrupted = 0;
    for (const row of rows) {
      const value = row.value;
      if (row.status !== 'ok' || !value || localIds.has(value.id) || !ACTIVE.has(value.status)) continue;
      const assessed = await assessExternal(value);
      if (assessed.interrupted) interrupted += 1;
    }
    return interrupted;
  }

  return { start, run, get, interruptOrphans };
}
