import crypto from 'node:crypto';

const ACTIVE = new Set(['pending', 'running']);
const TERMINAL = new Set(['succeeded', 'partial', 'failed']);

function iso(now) {
  return new Date(typeof now === 'function' ? now() : now).toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeRestoreRequest(request = {}) {
  const checkpointId = typeof request.checkpointId === 'string' && request.checkpointId ? request.checkpointId : 'latest';
  const rawSessions = Array.isArray(request.sessions) ? request.sessions : request.sessions ? [request.sessions] : [];
  const sessions = [...new Set(rawSessions.filter((name) => typeof name === 'string' && name))].sort();
  return { checkpointId, sessions, historical: request.historical === true };
}

export function restoreRequestHash(request) {
  return crypto.createHash('sha256').update(JSON.stringify(normalizeRestoreRequest(request))).digest('hex');
}

export function createOperationManager({
  store,
  now = Date.now,
  randomUUID = crypto.randomUUID,
  pid = process.pid,
} = {}) {
  const values = new Map();
  const activeByHash = new Map();

  async function persist(operation) {
    values.set(operation.id, operation);
    await store.writeOperation(operation);
    return operation;
  }

  async function execute(operation, runner) {
    let current = operation;
    try {
      current = await persist({
        ...operation,
        status: 'running',
        startedAt: iso(now),
        updatedAt: iso(now),
      });
      const result = await runner({
        operationId: current.id,
        request: current.request,
        onProgress: async ({ completed, total, result: row }) => {
          const results = row ? [...(current.results || []), row] : (current.results || []);
          current = await persist({
            ...current,
            progress: { completed, total },
            results,
            updatedAt: iso(now),
          });
        },
      });
      const status = TERMINAL.has(result?.status) ? result.status : 'failed';
      current = await persist({
        ...current,
        ...result,
        status,
        progress: { completed: result?.results?.length ?? current.progress.completed, total: current.progress.total },
        completedAt: iso(now),
        updatedAt: iso(now),
      });
    } catch (error) {
      current = {
        ...current,
        status: 'failed',
        error: errorMessage(error),
        completedAt: iso(now),
        updatedAt: iso(now),
      };
      try { await persist(current); } catch { /* pending/running file is interrupted on restart */ }
    } finally {
      if (activeByHash.get(operation.requestHash) === operation.id) activeByHash.delete(operation.requestHash);
    }
    return current;
  }

  async function createPending(request) {
    const normalized = normalizeRestoreRequest(request);
    const requestHash = restoreRequestHash(normalized);
    const existingId = activeByHash.get(requestHash);
    if (existingId) return { reused: true, operation: values.get(existingId) };
    const id = randomUUID();
    const operation = {
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
    activeByHash.set(requestHash, id);
    try {
      await persist(operation);
    } catch (error) {
      activeByHash.delete(requestHash);
      throw error;
    }
    return { reused: false, operation };
  }

  async function start(request, runner) {
    const pending = await createPending(request);
    if (pending.reused) {
      return { operationId: pending.operation.id, status: pending.operation.status, reused: true };
    }
    Promise.resolve().then(() => execute(pending.operation, runner)).catch(() => {});
    return { operationId: pending.operation.id, status: 'pending', reused: false };
  }

  async function run(request, runner) {
    const pending = await createPending(request);
    if (pending.reused) return values.get(pending.operation.id);
    return execute(pending.operation, runner);
  }

  async function get(id) {
    if (values.has(id)) return values.get(id);
    const result = await store.readOperation(id);
    if (result.status !== 'ok') return null;
    values.set(id, result.value);
    return result.value;
  }

  async function interruptOrphans() {
    const rows = typeof store.listOperations === 'function' ? await store.listOperations() : [];
    let interrupted = 0;
    for (const row of rows) {
      if (row.status !== 'ok' || !ACTIVE.has(row.value?.status)) continue;
      const operation = {
        ...row.value,
        status: 'interrupted',
        error: 'restore interrupted by process restart; retry the restore',
        completedAt: iso(now),
        updatedAt: iso(now),
      };
      await persist(operation);
      interrupted += 1;
    }
    return interrupted;
  }

  return { start, run, get, interruptOrphans };
}
