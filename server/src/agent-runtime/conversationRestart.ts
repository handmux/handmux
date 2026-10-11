import type { AgentRunLease } from './run.js';

export type ConversationRestartPhase = 'prepared' | 'stopped' | 'resuming' | 'ready';
export type ConversationRestartState = 'current' | 'stale';

export interface ConversationRestartRecovery {
  kind: 'codex_resume';
  sessionId: string;
  command: string;
}

export interface ConversationRestartReceipt {
  operationId: string;
  recovery: ConversationRestartRecovery;
  phase: ConversationRestartPhase;
  state: ConversationRestartState;
  canResume: boolean;
}

export type ConversationRestartErrorCode = 'unsupported' | 'unavailable' | 'in_progress' | 'stale_run';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATION_ID_RE = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validConversationRestartRecovery(value: unknown): value is ConversationRestartRecovery {
  if (!isRecord(value)) return false;
  return value.kind === 'codex_resume'
    && typeof value.sessionId === 'string' && SESSION_ID_RE.test(value.sessionId)
    && value.command === `handmux codex resume ${value.sessionId}`;
}

export function validConversationRestartReceipt(value: unknown): value is ConversationRestartReceipt {
  if (!isRecord(value) || !validConversationRestartRecovery(value.recovery)) return false;
  return typeof value.operationId === 'string' && OPERATION_ID_RE.test(value.operationId)
    && (value.phase === 'prepared' || value.phase === 'stopped'
      || value.phase === 'resuming' || value.phase === 'ready')
    && (value.state === 'current' || value.state === 'stale')
    && typeof value.canResume === 'boolean'
    && (!value.canResume || (value.state === 'current'
      && value.phase !== 'resuming' && value.phase !== 'ready'));
}

function sameRecovery(first: ConversationRestartRecovery, second: ConversationRestartRecovery): boolean {
  return first.kind === second.kind && first.sessionId === second.sessionId && first.command === second.command;
}

export class ConversationRestartError extends Error {
  constructor(
    message: string,
    readonly code: ConversationRestartErrorCode,
    readonly recovery?: ConversationRestartReceipt,
  ) {
    super(message);
    this.name = 'ConversationRestartError';
  }
}

export interface AgentConversationRestartControllerV1 {
  apiVersion: 1;
  restart(run: AgentRunLease, signal: AbortSignal): Promise<ConversationRestartReceipt>;
  recovery(paneId: string): Promise<ConversationRestartReceipt | null>;
  recover(paneId: string, operationId: string, signal: AbortSignal): Promise<ConversationRestartReceipt>;
}

function validateController(value: unknown): value is AgentConversationRestartControllerV1 {
  if (!isRecord(value)) return false;
  return value.apiVersion === 1 && typeof value.restart === 'function'
    && typeof value.recovery === 'function' && typeof value.recover === 'function';
}

export class AgentConversationRestartService {
  readonly #controllers: ReadonlyMap<string, AgentConversationRestartControllerV1>;
  readonly #active = new Map<string, Promise<ConversationRestartReceipt>>();
  readonly #timeoutMs: number;

  constructor(
    controllers: Readonly<Record<string, AgentConversationRestartControllerV1>>,
    { timeoutMs = 90_000 }: { timeoutMs?: number } = {},
  ) {
    if (!controllers || typeof controllers !== 'object' || !Object.keys(controllers).length) {
      throw new TypeError('AgentConversationRestartService requires controllers');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError('AgentConversationRestartService requires a positive timeout');
    }
    const available = new Map<string, AgentConversationRestartControllerV1>();
    for (const [id, value] of Object.entries(controllers)) {
      if (validateController(value)) available.set(id, value);
    }
    this.#controllers = available;
    this.#timeoutMs = timeoutMs;
  }

  restart(run: AgentRunLease): Promise<ConversationRestartReceipt> {
    const controller = this.#controllers.get(run.ref.agentId);
    if (!controller) return Promise.reject(new ConversationRestartError(
      'Conversation restart is not supported for this Agent', 'unsupported',
    ));
    if (!run.ref.sessionId || run.signal.aborted) return Promise.reject(new ConversationRestartError(
      'The Agent run is no longer active or has no session id', 'stale_run',
    ));
    const paneId = run.ref.paneId;
    const existing = this.#active.get(paneId);
    if (existing) return existing.then((receipt) => structuredClone(receipt));

    const operation = new AbortController();
    const timer = setTimeout(() => operation.abort(new Error('Conversation restart timed out')), this.#timeoutMs);
    const task = Promise.resolve().then(() => controller.restart(run, operation.signal)).then((receipt) => {
      if (!validConversationRestartReceipt(receipt)) {
        throw new ConversationRestartError('Invalid Conversation restart receipt', 'unavailable');
      }
      return structuredClone(receipt);
    }, (error: unknown) => {
      if (error instanceof ConversationRestartError) throw error;
      throw new ConversationRestartError('Conversation restart could not be completed', 'unavailable');
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      operation.signal.addEventListener('abort', () => {
        reject(new ConversationRestartError('Conversation restart timed out; recovery is still available', 'unavailable'));
      }, { once: true });
    });
    const result = Promise.race([task, timeout]).finally(() => clearTimeout(timer));
    this.#active.set(paneId, result);
    void task.then(() => {
      if (this.#active.get(paneId) === result) this.#active.delete(paneId);
    }, () => {
      if (this.#active.get(paneId) === result) this.#active.delete(paneId);
    });
    return result;
  }

  async recovery(paneId: string): Promise<ConversationRestartReceipt | null> {
    const controller = this.#controllers.get('codex');
    if (!controller) return null;
    try {
      const receipt = await controller.recovery(paneId);
      if (receipt === null) return null;
      if (!validConversationRestartReceipt(receipt)) {
        throw new ConversationRestartError('Invalid Conversation restart recovery receipt', 'unavailable');
      }
      return structuredClone(receipt);
    } catch (error) {
      if (error instanceof ConversationRestartError) throw error;
      throw new ConversationRestartError('Conversation restart recovery is unavailable', 'unavailable');
    }
  }

  async recover(paneId: string, operationId: string): Promise<ConversationRestartReceipt> {
    const controller = this.#controllers.get('codex');
    if (!controller) throw new ConversationRestartError(
      'Conversation restart recovery is not supported', 'unsupported',
    );
    const key = paneId;
    const existing = this.#active.get(key);
    if (existing) throw new ConversationRestartError('Conversation restart is already in progress', 'in_progress');
    const operation = new AbortController();
    const timer = setTimeout(() => operation.abort(new Error('Conversation recovery timed out')), this.#timeoutMs);
    const timeout = new Promise<never>((_resolve, reject) => {
      operation.signal.addEventListener('abort', () => reject(new ConversationRestartError(
        'Conversation recovery timed out; copy the recovery command and continue in the terminal', 'unavailable',
      )), { once: true });
    });
    const task = Promise.resolve().then(() => controller.recover(paneId, operationId, operation.signal)).then((receipt) => {
      if (!validConversationRestartReceipt(receipt)) {
        throw new ConversationRestartError('Invalid Conversation restart recovery receipt', 'unavailable');
      }
      return structuredClone(receipt);
    }).catch((error: unknown) => {
      if (error instanceof ConversationRestartError) throw error;
      throw new ConversationRestartError('Conversation restart recovery could not be completed', 'unavailable');
    });
    const result = Promise.race([task, timeout]).finally(() => clearTimeout(timer));
    this.#active.set(key, result);
    void task.then(() => {
      if (this.#active.get(key) === result) this.#active.delete(key);
    }, () => {
      if (this.#active.get(key) === result) this.#active.delete(key);
    });
    return result;
  }
}
