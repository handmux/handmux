import crypto from 'node:crypto';
import path from 'node:path';
import { fsyncDirectorySync, PrivateStateStore } from '../privateStateStore.js';
import { isSessionUuid } from './scanUtils.js';

export type CodexActivationPhase = 'prepared' | 'interrupted' | 'resuming';
const CODEX_AGENT_ID = 'codex' as const;

export interface CodexActivationReceipt {
  operationId: string;
  agentId: typeof CODEX_AGENT_ID;
  pane: {
    paneId: string;
    sessionName: string;
    windowId: string;
    tmuxEpoch: string;
  };
  process: {
    pid: number;
    startedAt: number;
    tty: string;
    executable: string;
  };
  sessionId: string;
  command: string;
  phase: CodexActivationPhase;
  createdAt: number;
  updatedAt: number;
}

export type CodexActivationReceiptInput = Omit<
  CodexActivationReceipt,
  'operationId' | 'agentId' | 'phase' | 'createdAt' | 'updatedAt'
>;

interface PersistedReceipts {
  version: 1;
  receipts: CodexActivationReceipt[];
}

const MAX_RECEIPTS = 128;
const OPERATION_ID_RE = /^[0-9a-f]{64}$/;
const PANE_ID_RE = /^%\d+$/;
const WINDOW_ID_RE = /^@\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validReceipt(value: unknown): value is CodexActivationReceipt {
  if (!isRecord(value) || !isRecord(value.pane) || !isRecord(value.process)) return false;
  const pane = value.pane;
  const process = value.process;
  return typeof value.operationId === 'string' && OPERATION_ID_RE.test(value.operationId)
    && value.agentId === CODEX_AGENT_ID
    && typeof pane.paneId === 'string' && PANE_ID_RE.test(pane.paneId)
    && typeof pane.sessionName === 'string' && pane.sessionName.length > 0 && pane.sessionName.length <= 1_024
    && typeof pane.windowId === 'string' && WINDOW_ID_RE.test(pane.windowId)
    && typeof pane.tmuxEpoch === 'string' && pane.tmuxEpoch.length > 0 && pane.tmuxEpoch.length <= 1_024
    && typeof process.pid === 'number' && Number.isSafeInteger(process.pid) && process.pid > 0
    && typeof process.startedAt === 'number' && Number.isSafeInteger(process.startedAt) && process.startedAt > 0
    && typeof process.tty === 'string' && process.tty.length > 0 && process.tty.length <= 1_024
    && typeof process.executable === 'string' && process.executable.length > 0 && process.executable.length <= 8_192
    && typeof value.sessionId === 'string' && isSessionUuid(value.sessionId)
    && value.command === `handmux codex resume ${value.sessionId}`
    && (value.phase === 'prepared' || value.phase === 'interrupted' || value.phase === 'resuming')
    && typeof value.createdAt === 'number' && Number.isSafeInteger(value.createdAt) && value.createdAt > 0
    && typeof value.updatedAt === 'number' && Number.isSafeInteger(value.updatedAt)
    && value.updatedAt >= value.createdAt;
}

function parseState(value: unknown): PersistedReceipts {
  if (value === null) return { version: 1, receipts: [] };
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.receipts)
    || value.receipts.length > MAX_RECEIPTS || !value.receipts.every(validReceipt)) {
    throw new Error('Invalid Codex activation recovery state');
  }
  return { version: 1, receipts: structuredClone(value.receipts) };
}

function operationId(input: CodexActivationReceiptInput): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    agentId: CODEX_AGENT_ID,
    ...input,
  })).digest('hex');
}

function sameProcess(
  first: CodexActivationReceipt['process'],
  second: CodexActivationReceipt['process'],
): boolean {
  return first.pid === second.pid && first.startedAt === second.startedAt
    && first.tty === second.tty && first.executable === second.executable;
}

export class CodexActivationReceiptStore {
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
    try { this.#state = parseState(this.#store.readStrict()); }
    catch {
      this.#state = { version: 1, receipts: [] };
      this.#available = false;
    }
    this.#now = now;
    this.#write = write ?? ((state) => this.#store.write(state));
    this.#fsyncDirectory = fsyncDirectory;
  }

  list(): CodexActivationReceipt[] {
    this.#assertAvailable();
    return structuredClone(this.#state.receipts);
  }

  latestForPane(paneId: string): CodexActivationReceipt | null {
    this.#assertAvailable();
    return structuredClone([...this.#state.receipts].reverse().find((receipt) => (
      receipt.pane.paneId === paneId
    )) ?? null);
  }

  get(operationId: string): CodexActivationReceipt | null {
    this.#assertAvailable();
    return structuredClone(this.#state.receipts.find((receipt) => (
      receipt.operationId === operationId
    )) ?? null);
  }

  prepare(input: CodexActivationReceiptInput): CodexActivationReceipt {
    this.#assertAvailable();
    const id = operationId(input);
    const existing = this.#state.receipts.find((receipt) => receipt.operationId === id);
    if (existing) return structuredClone(existing);
    const now = Math.trunc(this.#now());
    const receipt: CodexActivationReceipt = {
      operationId: id,
      agentId: CODEX_AGENT_ID,
      ...structuredClone(input),
      phase: 'prepared',
      createdAt: now,
      updatedAt: now,
    };
    if (!validReceipt(receipt)) throw new Error('Invalid Codex activation recovery receipt');
    const next: PersistedReceipts = {
      version: 1,
      receipts: [...this.#state.receipts, receipt].slice(-MAX_RECEIPTS),
    };
    this.#flush(next);
    this.#state = next;
    return structuredClone(receipt);
  }

  transition(
    id: string,
    expected: CodexActivationPhase | readonly CodexActivationPhase[],
    phase: CodexActivationPhase,
  ): CodexActivationReceipt {
    this.#assertAvailable();
    const index = this.#state.receipts.findIndex((candidate) => candidate.operationId === id);
    const receipt = this.#state.receipts[index];
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!receipt || !allowed.includes(receipt.phase)) {
      throw new Error('Codex activation recovery receipt changed');
    }
    if (receipt.phase === phase) return structuredClone(receipt);
    const updated = { ...receipt, phase, updatedAt: Math.trunc(this.#now()) };
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

  clearManaged(
    paneId: string,
    sessionId: string,
    process?: CodexActivationReceipt['process'],
  ): boolean {
    this.#assertAvailable();
    const receipts = this.#state.receipts.filter((receipt) => !(
      receipt.pane.paneId === paneId && receipt.sessionId === sessionId
      && (process === undefined || sameProcess(receipt.process, process))
    ));
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
    if (!this.#available) throw new Error('Codex activation recovery state is unavailable');
  }
}
