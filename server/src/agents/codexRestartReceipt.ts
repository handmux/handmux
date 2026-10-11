import crypto from 'node:crypto';
import path from 'node:path';
import { fsyncDirectorySync, PrivateStateStore } from '../privateStateStore.js';
import { isSessionUuid } from './scanUtils.js';

const CODEX_AGENT_ID = 'codex' as const;
const MAX_RECEIPTS = 128;
const OPERATION_ID_RE = /^[0-9a-f]{64}$/;
const PANE_ID_RE = /^%\d+$/;
const WINDOW_ID_RE = /^@\d+$/;

export type CodexRestartPhase = 'prepared' | 'stopped' | 'resuming' | 'ready';

export interface CodexRestartProcessIdentity {
  pid: number;
  ppid: number;
  startedAt: number;
  tty: string;
  executable: string;
}

export interface CodexRestartReceipt {
  operationId: string;
  agentId: typeof CODEX_AGENT_ID;
  pane: {
    paneId: string;
    sessionName: string;
    windowId: string;
    tty: string;
    tmuxEpoch: string;
  };
  process: {
    tui: CodexRestartProcessIdentity;
    wrapper: CodexRestartProcessIdentity;
    // The npm CLI uses a Node launcher between Handmux and each native Codex process.
    tuiShim?: CodexRestartProcessIdentity;
    appServerShim?: CodexRestartProcessIdentity;
    // Optional only for receipts written by an earlier in-development build. Such receipts stay recoverable
    // manually but cannot authorize an automatic resume or queue release without this generation.
    appServer?: CodexRestartProcessIdentity;
  };
  sessionId: string;
  previousRunId: string;
  command: string;
  phase: CodexRestartPhase;
  createdAt: number;
  updatedAt: number;
}

export type CodexRestartReceiptInput = Omit<
  CodexRestartReceipt,
  'operationId' | 'agentId' | 'command' | 'phase' | 'createdAt' | 'updatedAt'
> & {
  process: {
    tui: CodexRestartProcessIdentity;
    wrapper: CodexRestartProcessIdentity;
    tuiShim?: CodexRestartProcessIdentity;
    appServerShim?: CodexRestartProcessIdentity;
    appServer: CodexRestartProcessIdentity;
  };
};

interface PersistedReceipts {
  version: 1;
  receipts: CodexRestartReceipt[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validProcess(value: unknown): value is CodexRestartProcessIdentity {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.pid) && Number(value.pid) > 0
    && Number.isSafeInteger(value.ppid) && Number(value.ppid) >= 0
    && Number.isSafeInteger(value.startedAt) && Number(value.startedAt) > 0
    && typeof value.tty === 'string' && value.tty.length > 0 && value.tty.length <= 1_024
    && typeof value.executable === 'string' && value.executable.length > 0 && value.executable.length <= 8_192;
}

function validReceipt(value: unknown): value is CodexRestartReceipt {
  if (!isRecord(value) || !isRecord(value.pane) || !isRecord(value.process)) return false;
  const pane = value.pane;
  const process = value.process;
  return typeof value.operationId === 'string' && OPERATION_ID_RE.test(value.operationId)
    && value.agentId === CODEX_AGENT_ID
    && typeof pane.paneId === 'string' && PANE_ID_RE.test(pane.paneId)
    && typeof pane.sessionName === 'string' && pane.sessionName.length > 0 && pane.sessionName.length <= 1_024
    && typeof pane.windowId === 'string' && WINDOW_ID_RE.test(pane.windowId)
    && typeof pane.tty === 'string' && pane.tty.length > 0 && pane.tty.length <= 1_024
    && typeof pane.tmuxEpoch === 'string' && pane.tmuxEpoch.length > 0 && pane.tmuxEpoch.length <= 1_024
    && validProcess(process.tui) && validProcess(process.wrapper)
    && (process.tuiShim === undefined
      ? process.tui.ppid === process.wrapper.pid
      : (validProcess(process.tuiShim) && process.tuiShim.ppid === process.wrapper.pid
        && process.tui.ppid === process.tuiShim.pid))
    && (process.appServer === undefined
      || (validProcess(process.appServer) && (process.appServerShim === undefined
        ? process.appServer.ppid === process.wrapper.pid
        : (validProcess(process.appServerShim) && process.appServerShim.ppid === process.wrapper.pid
          && process.appServer.ppid === process.appServerShim.pid))))
    && (process.appServerShim === undefined || process.appServer !== undefined)
    && typeof value.sessionId === 'string' && isSessionUuid(value.sessionId)
    && typeof value.previousRunId === 'string' && value.previousRunId.length > 0 && value.previousRunId.length <= 1_024
    && value.command === `handmux codex resume ${value.sessionId}`
    && (value.phase === 'prepared' || value.phase === 'stopped'
      || value.phase === 'resuming' || value.phase === 'ready')
    && Number.isSafeInteger(value.createdAt) && Number(value.createdAt) > 0
    && Number.isSafeInteger(value.updatedAt) && Number(value.updatedAt) >= Number(value.createdAt);
}

function persistedReceipt(receipt: CodexRestartReceipt): CodexRestartReceipt {
  return {
    operationId: receipt.operationId,
    agentId: CODEX_AGENT_ID,
    pane: {
      paneId: receipt.pane.paneId,
      sessionName: receipt.pane.sessionName,
      windowId: receipt.pane.windowId,
      tty: receipt.pane.tty,
      tmuxEpoch: receipt.pane.tmuxEpoch,
    },
    process: {
      tui: persistedProcessIdentity(receipt.process.tui),
      wrapper: persistedProcessIdentity(receipt.process.wrapper),
      ...(receipt.process.tuiShim
        ? { tuiShim: persistedProcessIdentity(receipt.process.tuiShim) } : {}),
      ...(receipt.process.appServerShim
        ? { appServerShim: persistedProcessIdentity(receipt.process.appServerShim) } : {}),
      ...(receipt.process.appServer
        ? { appServer: persistedProcessIdentity(receipt.process.appServer) }
        : {}),
    },
    sessionId: receipt.sessionId,
    previousRunId: receipt.previousRunId,
    command: receipt.command,
    phase: receipt.phase,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
  };
}

function parseState(value: unknown): PersistedReceipts {
  if (value === null) return { version: 1, receipts: [] };
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.receipts)
    || value.receipts.length > MAX_RECEIPTS || !value.receipts.every(validReceipt)) {
    throw new Error('Invalid Codex conversation restart state');
  }
  return { version: 1, receipts: value.receipts.map(persistedReceipt) };
}

function operationId(input: CodexRestartReceiptInput): string {
  const stableInput = {
    pane: input.pane,
    process: {
      tui: persistedProcessIdentity(input.process.tui),
      wrapper: persistedProcessIdentity(input.process.wrapper),
      ...(input.process.tuiShim ? { tuiShim: persistedProcessIdentity(input.process.tuiShim) } : {}),
      ...(input.process.appServerShim ? { appServerShim: persistedProcessIdentity(input.process.appServerShim) } : {}),
      appServer: persistedProcessIdentity(input.process.appServer),
    },
    sessionId: input.sessionId,
    previousRunId: input.previousRunId,
  };
  return crypto.createHash('sha256').update(JSON.stringify({ agentId: CODEX_AGENT_ID, ...stableInput })).digest('hex');
}

function persistedProcessIdentity(identity: CodexRestartProcessIdentity): CodexRestartProcessIdentity {
  return {
    pid: identity.pid,
    ppid: identity.ppid,
    startedAt: identity.startedAt,
    tty: identity.tty,
    executable: identity.executable,
  };
}

function persistedInput(input: CodexRestartReceiptInput): CodexRestartReceiptInput {
  return {
    pane: structuredClone(input.pane),
    process: {
      tui: persistedProcessIdentity(input.process.tui),
      wrapper: persistedProcessIdentity(input.process.wrapper),
      ...(input.process.tuiShim ? { tuiShim: persistedProcessIdentity(input.process.tuiShim) } : {}),
      ...(input.process.appServerShim ? { appServerShim: persistedProcessIdentity(input.process.appServerShim) } : {}),
      appServer: persistedProcessIdentity(input.process.appServer),
    },
    sessionId: input.sessionId,
    previousRunId: input.previousRunId,
  };
}

export class CodexRestartReceiptStore {
  readonly #store: PrivateStateStore<PersistedReceipts>;
  readonly #now: () => number;
  readonly #write: (state: PersistedReceipts) => void;
  readonly #fsyncDirectory: (directory: string) => void;
  #state: PersistedReceipts;
  #available = true;

  constructor(file: string, {
    now = Date.now,
    write,
    fsyncDirectory = fsyncDirectorySync,
  }: {
    now?: () => number;
    write?: (state: unknown) => void;
    fsyncDirectory?: (directory: string) => void;
  } = {}) {
    this.#store = new PrivateStateStore<PersistedReceipts>(file);
    this.#now = now;
    this.#write = write ?? ((state) => this.#store.write(state));
    this.#fsyncDirectory = fsyncDirectory;
    try {
      const raw = this.#store.readStrict();
      this.#state = parseState(raw);
      if (raw !== null && JSON.stringify(raw) !== JSON.stringify(this.#state)) this.#flush(this.#state);
    }
    catch {
      this.#state = { version: 1, receipts: [] };
      this.#available = false;
    }
  }

  list(): CodexRestartReceipt[] {
    this.#assertAvailable();
    return structuredClone(this.#state.receipts);
  }

  latestForPane(paneId: string): CodexRestartReceipt | null {
    this.#assertAvailable();
    return structuredClone([...this.#state.receipts].reverse().find((receipt) => (
      receipt.pane.paneId === paneId
    )) ?? null);
  }

  get(operationId: string): CodexRestartReceipt | null {
    this.#assertAvailable();
    return structuredClone(this.#state.receipts.find((receipt) => receipt.operationId === operationId) ?? null);
  }

  isPending(agentId: string, sessionId: string): boolean {
    this.#assertAvailable();
    if (agentId !== CODEX_AGENT_ID) return false;
    return this.#state.receipts.some((receipt) => (
      receipt.sessionId === sessionId && receipt.phase !== 'ready'
    ));
  }

  prepare(input: CodexRestartReceiptInput): CodexRestartReceipt {
    this.#assertAvailable();
    const id = operationId(input);
    const existing = this.#state.receipts.find((receipt) => receipt.operationId === id);
    if (existing) return structuredClone(existing);
    const now = Math.trunc(this.#now());
    const receipt: CodexRestartReceipt = {
      operationId: id,
      agentId: CODEX_AGENT_ID,
      ...persistedInput(input),
      command: `handmux codex resume ${input.sessionId}`,
      phase: 'prepared',
      createdAt: now,
      updatedAt: now,
    };
    if (!validReceipt(receipt)) throw new Error('Invalid Codex conversation restart receipt');
    const pending = this.#state.receipts.filter((candidate) => candidate.phase !== 'ready');
    if (pending.length >= MAX_RECEIPTS) throw new Error('Too many pending Codex conversation restarts');
    const history = [...this.#state.receipts, receipt];
    const readyCapacity = MAX_RECEIPTS - history.filter((candidate) => candidate.phase !== 'ready').length;
    const completed = history.filter((candidate) => candidate.phase === 'ready');
    const readyIds = new Set((readyCapacity > 0 ? completed.slice(-readyCapacity) : [])
      .map((candidate) => candidate.operationId));
    const next: PersistedReceipts = {
      version: 1,
      receipts: history.filter((candidate) => candidate.phase !== 'ready' || readyIds.has(candidate.operationId)),
    };
    this.#flush(next);
    this.#state = next;
    return structuredClone(receipt);
  }

  transition(
    id: string,
    expected: CodexRestartPhase | readonly CodexRestartPhase[],
    phase: CodexRestartPhase,
  ): CodexRestartReceipt {
    this.#assertAvailable();
    const index = this.#state.receipts.findIndex((candidate) => candidate.operationId === id);
    const receipt = this.#state.receipts[index];
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!receipt || !allowed.includes(receipt.phase)) throw new Error('Codex restart receipt changed');
    if (receipt.phase === phase) return structuredClone(receipt);
    const updated = { ...receipt, phase, updatedAt: Math.trunc(this.#now()) };
    if (!validReceipt(updated)) throw new Error('Invalid Codex conversation restart transition');
    const next: PersistedReceipts = {
      version: 1,
      receipts: this.#state.receipts.map((candidate, candidateIndex) => (
        candidateIndex === index ? updated : candidate
      )),
    };
    this.#flush(next);
    this.#state = next;
    return structuredClone(updated);
  }

  clear(id: string): boolean {
    this.#assertAvailable();
    const receipts = this.#state.receipts.filter((receipt) => receipt.operationId !== id);
    if (receipts.length === this.#state.receipts.length) return false;
    const next: PersistedReceipts = { version: 1, receipts };
    this.#flush(next);
    this.#state = next;
    return true;
  }

  #flush(next: PersistedReceipts): void {
    this.#write(next);
    this.#fsyncDirectory(path.dirname(this.#store.file));
  }

  #assertAvailable(): void {
    if (!this.#available) throw new Error('Codex conversation restart state is unavailable');
  }
}
