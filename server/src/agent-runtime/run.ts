import { randomUUID } from 'node:crypto';

export interface AgentSessionRef {
  readonly agentId: string;
  readonly sessionId: string;
}

export interface AgentRunRef {
  readonly agentId: string;
  readonly paneId: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly implementationVersion?: number;
}

export interface AgentRunLease {
  readonly ref: AgentRunRef;
  readonly signal: AbortSignal;
}

export interface AgentRunRegistry {
  resolve(ref: AgentRunRef): AgentRunLease | null;
  status(ref: AgentRunRef): 'current' | 'revoked' | 'unknown';
}

export type RunRevokeReason =
  | 'process_exit'
  | 'pane_detached'
  | 'session_replaced'
  | 'provider_clear'
  | 'adapter_stopped'
  | 'runtime_shutdown';

export interface AgentAttachmentCandidate {
  paneId: string;
  attachmentId: string;
  sessionId?: string;
  implementationVersion?: number;
  process: {
    pid: number;
    startedAt?: number;
    tty?: string;
  };
}

export interface ScopedAgentRunController {
  attach(candidate: AgentAttachmentCandidate): Promise<AgentRunLease>;
  associateSession(lease: AgentRunLease, sessionId: string): Promise<AgentRunRef>;
  replace(
    current: AgentRunLease,
    candidate: AgentAttachmentCandidate,
    reason: RunRevokeReason,
  ): Promise<AgentRunLease>;
  revoke(lease: AgentRunLease, reason: RunRevokeReason): Promise<void>;
}

export type AgentAttachmentVerifier = (candidate: AgentAttachmentCandidate) => Promise<boolean>;

export type AgentRunErrorCode =
  | 'invalid-candidate'
  | 'attachment-unverified'
  | 'runtime-unavailable'
  | 'pane-owned-by-another-adapter'
  | 'attachment-already-attached'
  | 'foreign-lease'
  | 'stale-lease'
  | 'session-replacement-required'
  | 'pane-change-requires-attach';

export class AgentRunError extends Error {
  constructor(readonly code: AgentRunErrorCode, message: string) {
    super(message);
    this.name = 'AgentRunError';
  }
}

interface RunRecord {
  agentId: string;
  paneId: string;
  attachmentId: string;
  process: AgentAttachmentCandidate['process'];
  ref: AgentRunRef;
  abort: AbortController;
  lease: AgentRunLease;
}

function attachmentKey(agentId: string, attachmentId: string): string {
  return `${agentId}\0${attachmentId}`;
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validateCandidate(candidate: AgentAttachmentCandidate): void {
  if (!candidate || !validText(candidate.paneId, 256) || !validText(candidate.attachmentId, 512)) {
    throw new AgentRunError('invalid-candidate', 'Attachment requires a valid paneId and attachmentId');
  }
  if (candidate.sessionId !== undefined && !validText(candidate.sessionId, 1024)) {
    throw new AgentRunError('invalid-candidate', 'Attachment sessionId must be a non-empty bounded string');
  }
  if (candidate.implementationVersion !== undefined
    && (!Number.isSafeInteger(candidate.implementationVersion)
      || candidate.implementationVersion <= 0)) {
    throw new AgentRunError('invalid-candidate', 'Attachment implementationVersion must be a positive integer');
  }
  if (!candidate.process || !Number.isSafeInteger(candidate.process.pid) || candidate.process.pid <= 0) {
    throw new AgentRunError('invalid-candidate', 'Attachment process requires a positive integer pid');
  }
  if (candidate.process.startedAt !== undefined
    && (!Number.isFinite(candidate.process.startedAt) || candidate.process.startedAt < 0)) {
    throw new AgentRunError('invalid-candidate', 'Attachment process startedAt must be a finite timestamp');
  }
  if (candidate.process.tty !== undefined && !validText(candidate.process.tty, 1024)) {
    throw new AgentRunError('invalid-candidate', 'Attachment process tty must be a non-empty bounded string');
  }
}

function sameProcess(
  first: AgentAttachmentCandidate['process'],
  second: AgentAttachmentCandidate['process'],
): boolean {
  return first.pid === second.pid
    && first.startedAt === second.startedAt
    && first.tty === second.tty;
}

function refFor(
  agentId: string,
  paneId: string,
  runId: string,
  sessionId?: string,
  implementationVersion?: number,
): AgentRunRef {
  return Object.freeze({
    agentId,
    paneId,
    runId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(implementationVersion === undefined ? {} : { implementationVersion }),
  });
}

// Owns logical run generations only. Bridge connection nonces and transport reconnects never enter here.
export class AgentRunRuntime implements AgentRunRegistry {
  readonly #byRunId = new Map<string, RunRecord>();
  readonly #knownRunRefs = new Map<string, AgentRunRef>();
  readonly #byPane = new Map<string, RunRecord>();
  readonly #byAttachment = new Map<string, RunRecord>();
  readonly #records = new WeakMap<AgentRunLease, RunRecord>();
  readonly #paneQueues = new Map<string, Promise<void>>();
  readonly #disabledAdapters = new Set<string>();
  readonly #newRunId: () => string;
  readonly #verifyTimeoutMs: number;
  #shuttingDown = false;

  constructor({
    newRunId = randomUUID,
    verifyTimeoutMs = 1000,
  }: { newRunId?: () => string; verifyTimeoutMs?: number } = {}) {
    this.#newRunId = newRunId;
    this.#verifyTimeoutMs = Math.max(1, verifyTimeoutMs);
  }

  resolve(ref: AgentRunRef): AgentRunLease | null {
    if (!ref || typeof ref.runId !== 'string') return null;
    const record = this.#byRunId.get(ref.runId);
    if (!record || record.abort.signal.aborted) return null;
    if (record.ref.agentId !== ref.agentId || record.ref.paneId !== ref.paneId) return null;
    if (ref.sessionId !== undefined && record.ref.sessionId !== ref.sessionId) return null;
    return record.lease;
  }

  status(ref: AgentRunRef): 'current' | 'revoked' | 'unknown' {
    if (this.resolve(ref)) return 'current';
    const known = ref && typeof ref.runId === 'string' ? this.#knownRunRefs.get(ref.runId) : undefined;
    if (!known || known.agentId !== ref.agentId || known.paneId !== ref.paneId) return 'unknown';
    if (ref.sessionId !== undefined && known.sessionId !== ref.sessionId) return 'unknown';
    return 'revoked';
  }

  isLive(lease: AgentRunLease): boolean {
    const record = this.#records.get(lease);
    return record !== undefined && this.#byRunId.get(record.ref.runId) === record
      && !record.abort.signal.aborted;
  }

  requireLive(lease: AgentRunLease): AgentRunRef {
    if (!this.isLive(lease)) throw new AgentRunError('stale-lease', 'Agent run lease is no longer live');
    return lease.ref;
  }

  currentForPane(paneId: string): AgentRunLease | null {
    const record = this.#byPane.get(paneId);
    return record && !record.abort.signal.aborted ? record.lease : null;
  }

  controller(agentId: string, verify: AgentAttachmentVerifier): ScopedAgentRunController {
    if (!validText(agentId, 64) || typeof verify !== 'function') {
      throw new TypeError('Scoped Agent run controller requires an agentId and attachment verifier');
    }
    return Object.freeze({
      attach: (candidate: AgentAttachmentCandidate) => this.#attach(agentId, verify, candidate),
      associateSession: (lease: AgentRunLease, sessionId: string) => (
        this.#associateSession(agentId, lease, sessionId)
      ),
      replace: (
        current: AgentRunLease,
        candidate: AgentAttachmentCandidate,
        reason: RunRevokeReason,
      ) => this.#replace(agentId, verify, current, candidate, reason),
      revoke: (lease: AgentRunLease, reason: RunRevokeReason) => this.#revoke(agentId, lease, reason),
    });
  }

  async revokeAdapter(agentId: string, reason: RunRevokeReason = 'adapter_stopped'): Promise<void> {
    this.#disabledAdapters.add(agentId);
    const records = [...this.#byRunId.values()].filter((record) => record.agentId === agentId);
    await Promise.all(records.map((record) => this.#withPane(record.paneId, async () => {
      if (this.#byRunId.get(record.ref.runId) === record) this.#remove(record, reason);
    })));
  }

  // Root Runtime uses this after process identity changes. Scoped adapter controllers deliberately do not
  // receive it, so one adapter cannot evict another adapter's run by naming its pane.
  async revokePane(paneId: string, reason: RunRevokeReason): Promise<void> {
    await this.#withPane(paneId, async () => {
      const record = this.#byPane.get(paneId);
      if (record) this.#remove(record, reason);
    });
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    const records = [...this.#byRunId.values()];
    await Promise.all(records.map((record) => this.#withPane(record.paneId, async () => {
      if (this.#byRunId.get(record.ref.runId) === record) this.#remove(record, 'runtime_shutdown');
    })));
  }

  async #withPane<T>(paneId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#paneQueues.get(paneId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => current);
    this.#paneQueues.set(paneId, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#paneQueues.get(paneId) === queued) this.#paneQueues.delete(paneId);
    }
  }

  async #verify(
    verify: AgentAttachmentVerifier,
    candidate: AgentAttachmentCandidate,
  ): Promise<void> {
    let accepted = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      accepted = await Promise.race([
        Promise.resolve(verify(candidate)).then(Boolean, () => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.#verifyTimeoutMs);
        }),
      ]);
    } catch { /* adapter probe failure is a rejection */ } finally {
      if (timer) clearTimeout(timer);
    }
    if (!accepted) {
      throw new AgentRunError('attachment-unverified', 'Agent attachment no longer matches the live process');
    }
  }

  #recordFor(agentId: string, lease: AgentRunLease): RunRecord {
    const record = this.#records.get(lease);
    if (!record || record.agentId !== agentId) {
      throw new AgentRunError('foreign-lease', 'Agent run lease does not belong to this scoped controller');
    }
    return record;
  }

  #create(agentId: string, candidate: AgentAttachmentCandidate): RunRecord {
    const abort = new AbortController();
    const record = {} as RunRecord;
    record.agentId = agentId;
    record.paneId = candidate.paneId;
    record.attachmentId = candidate.attachmentId;
    record.process = Object.freeze({ ...candidate.process });
    let runId = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const proposed = this.#newRunId();
      if (validText(proposed, 256) && !this.#byRunId.has(proposed)) {
        runId = proposed;
        break;
      }
    }
    if (!runId) throw new Error('Unable to allocate a unique Agent runId');
    record.ref = refFor(
      agentId, candidate.paneId, runId, candidate.sessionId, candidate.implementationVersion,
    );
    this.#knownRunRefs.set(runId, record.ref);
    record.abort = abort;
    record.lease = Object.freeze({
      get ref() { return record.ref; },
      signal: abort.signal,
    });
    this.#records.set(record.lease, record);
    return record;
  }

  #install(record: RunRecord): void {
    this.#byRunId.set(record.ref.runId, record);
    this.#byPane.set(record.paneId, record);
    this.#byAttachment.set(attachmentKey(record.agentId, record.attachmentId), record);
  }

  #remove(record: RunRecord, reason: RunRevokeReason): void {
    if (this.#byRunId.get(record.ref.runId) !== record) return;
    this.#byRunId.delete(record.ref.runId);
    if (this.#byPane.get(record.paneId) === record) this.#byPane.delete(record.paneId);
    const key = attachmentKey(record.agentId, record.attachmentId);
    if (this.#byAttachment.get(key) === record) this.#byAttachment.delete(key);
    record.abort.abort(reason);
  }

  #replaceInstalled(
    current: RunRecord,
    next: RunRecord,
    reason: RunRevokeReason,
  ): AgentRunLease {
    this.#byRunId.delete(current.ref.runId);
    if (this.#byPane.get(current.paneId) === current) this.#byPane.delete(current.paneId);
    const currentKey = attachmentKey(current.agentId, current.attachmentId);
    if (this.#byAttachment.get(currentKey) === current) this.#byAttachment.delete(currentKey);
    this.#install(next);
    current.abort.abort(reason);
    return next.lease;
  }

  async #attach(
    agentId: string,
    verify: AgentAttachmentVerifier,
    candidate: AgentAttachmentCandidate,
  ): Promise<AgentRunLease> {
    validateCandidate(candidate);
    return this.#withPane(candidate.paneId, async () => {
      if (this.#shuttingDown || this.#disabledAdapters.has(agentId)) {
        throw new AgentRunError('runtime-unavailable', 'Agent runtime or adapter is stopped');
      }
      await this.#verify(verify, candidate);

      const paneOwner = this.#byPane.get(candidate.paneId);
      if (paneOwner && paneOwner.agentId !== agentId) {
        throw new AgentRunError(
          'pane-owned-by-another-adapter',
          `Pane ${candidate.paneId} is owned by another Agent adapter`,
        );
      }
      const attached = this.#byAttachment.get(attachmentKey(agentId, candidate.attachmentId));
      if (attached && attached.paneId !== candidate.paneId) {
        throw new AgentRunError(
          'attachment-already-attached',
          'Agent attachment is already live on another pane',
        );
      }

      if (!paneOwner) {
        const created = this.#create(agentId, candidate);
        this.#install(created);
        return created.lease;
      }

      if (paneOwner.attachmentId === candidate.attachmentId
        && sameProcess(paneOwner.process, candidate.process)) {
        const currentSession = paneOwner.ref.sessionId;
        if (currentSession !== undefined && candidate.sessionId !== undefined
          && currentSession !== candidate.sessionId) {
          throw new AgentRunError(
            'session-replacement-required',
            'A different session requires replace(), even when process and pane are unchanged',
          );
        }
        if (currentSession === undefined && candidate.sessionId !== undefined) {
          paneOwner.ref = refFor(
            agentId,
            candidate.paneId,
            paneOwner.ref.runId,
            candidate.sessionId,
          );
          this.#knownRunRefs.set(paneOwner.ref.runId, paneOwner.ref);
        }
        return paneOwner.lease;
      }

      const created = this.#create(agentId, candidate);
      return this.#replaceInstalled(paneOwner, created, 'process_exit');
    });
  }

  async #associateSession(
    agentId: string,
    lease: AgentRunLease,
    sessionId: string,
  ): Promise<AgentRunRef> {
    if (!validText(sessionId, 1024)) {
      throw new AgentRunError('invalid-candidate', 'sessionId must be a non-empty bounded string');
    }
    const known = this.#recordFor(agentId, lease);
    return this.#withPane(known.paneId, async () => {
      const record = this.#recordFor(agentId, lease);
      if (this.#byRunId.get(record.ref.runId) !== record || record.abort.signal.aborted) {
        throw new AgentRunError('stale-lease', 'Cannot associate a session with a stale Agent run');
      }
      if (record.ref.sessionId === sessionId) return record.ref;
      if (record.ref.sessionId !== undefined) {
        throw new AgentRunError(
          'session-replacement-required',
          'An associated session is immutable; use replace() for a new session',
        );
      }
      record.ref = refFor(agentId, record.paneId, record.ref.runId, sessionId);
      this.#knownRunRefs.set(record.ref.runId, record.ref);
      return record.ref;
    });
  }

  async #replace(
    agentId: string,
    verify: AgentAttachmentVerifier,
    current: AgentRunLease,
    candidate: AgentAttachmentCandidate,
    reason: RunRevokeReason,
  ): Promise<AgentRunLease> {
    validateCandidate(candidate);
    const known = this.#recordFor(agentId, current);
    if (candidate.paneId !== known.paneId) {
      throw new AgentRunError(
        'pane-change-requires-attach',
        'replace() cannot move an Agent attachment to another pane',
      );
    }
    return this.#withPane(known.paneId, async () => {
      const record = this.#recordFor(agentId, current);
      if (this.#byRunId.get(record.ref.runId) !== record || record.abort.signal.aborted) {
        throw new AgentRunError('stale-lease', 'Cannot replace a stale Agent run');
      }
      if (this.#shuttingDown || this.#disabledAdapters.has(agentId)) {
        throw new AgentRunError('runtime-unavailable', 'Agent runtime or adapter is stopped');
      }
      await this.#verify(verify, candidate);
      const attached = this.#byAttachment.get(attachmentKey(agentId, candidate.attachmentId));
      if (attached && attached !== record) {
        throw new AgentRunError('attachment-already-attached', 'Replacement attachment is already live');
      }
      const created = this.#create(agentId, candidate);
      return this.#replaceInstalled(record, created, reason);
    });
  }

  async #revoke(
    agentId: string,
    lease: AgentRunLease,
    reason: RunRevokeReason,
  ): Promise<void> {
    const known = this.#recordFor(agentId, lease);
    await this.#withPane(known.paneId, async () => {
      const record = this.#recordFor(agentId, lease);
      if (this.#byRunId.get(record.ref.runId) === record) this.#remove(record, reason);
    });
  }
}
