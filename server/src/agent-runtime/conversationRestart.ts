import type { AgentRunLease } from './run.js';

export type ConversationRestartPhase = 'prepared' | 'stopped' | 'resuming' | 'ready';
export type ConversationRestartState = 'current' | 'stale';

export interface ConversationRestartRecovery {
  kind: string;
  sessionId: string;
  command: string;
}

export interface ConversationRestartReceipt {
  agentId: string;
  paneId: string;
  operationId: string;
  recovery: ConversationRestartRecovery;
  phase: ConversationRestartPhase;
  state: ConversationRestartState;
  canResume: boolean;
}

export type ConversationRestartErrorCode = 'unsupported' | 'unavailable' | 'in_progress' | 'stale_run' | 'not_started';

const OPERATION_ID_RE = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validConversationRestartRecovery(value: unknown): value is ConversationRestartRecovery {
  if (!isRecord(value)) return false;
  return typeof value.kind === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value.kind)
    && typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= 1_024
    && typeof value.command === 'string' && value.command.length > 0 && value.command.length <= 4_096
    && !/[\x00-\x1f\x7f]/.test(value.command);
}

export function validConversationRestartReceipt(
  value: unknown,
  agentId: string,
  paneId: string,
  controller: AgentConversationRestartControllerV1,
): value is ConversationRestartReceipt {
  if (!isRecord(value) || !validConversationRestartRecovery(value.recovery)) return false;
  let nativeRecoveryValid = false;
  try { nativeRecoveryValid = controller.validRecovery(value.recovery); } catch { return false; }
  return nativeRecoveryValid && value.agentId === agentId && value.paneId === paneId
    && typeof value.operationId === 'string' && OPERATION_ID_RE.test(value.operationId)
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
  validRecovery(value: ConversationRestartRecovery): boolean;
  restart(run: AgentRunLease, signal: AbortSignal): Promise<ConversationRestartReceipt>;
  recovery(paneId: string): Promise<ConversationRestartReceipt | null>;
  recover(paneId: string, operationId: string, signal: AbortSignal): Promise<ConversationRestartReceipt>;
}

function validateController(value: unknown): value is AgentConversationRestartControllerV1 {
  if (!isRecord(value)) return false;
  return value.apiVersion === 1 && typeof value.restart === 'function'
    && typeof value.recovery === 'function' && typeof value.recover === 'function'
    && typeof value.validRecovery === 'function';
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
    if (existing) return existing.then((receipt) => {
      if (receipt.agentId !== run.ref.agentId || receipt.paneId !== paneId
        || receipt.recovery.sessionId !== run.ref.sessionId) {
        throw new ConversationRestartError('Another Conversation restart is already in progress', 'in_progress');
      }
      return structuredClone(receipt);
    });

    const operation = new AbortController();
    const timer = setTimeout(() => operation.abort(new Error('Conversation restart timed out')), this.#timeoutMs);
    const task = Promise.resolve().then(() => controller.restart(run, operation.signal)).then((receipt) => {
      if (!validConversationRestartReceipt(receipt, run.ref.agentId, paneId, controller)
        || receipt.recovery.sessionId !== run.ref.sessionId) {
        throw new ConversationRestartError('Invalid Conversation restart receipt', 'unavailable');
      }
      return structuredClone(receipt);
    }, (error: unknown) => {
      if (error instanceof ConversationRestartError) {
        if (error.recovery && (!validConversationRestartReceipt(
          error.recovery, run.ref.agentId, paneId, controller,
        ) || error.recovery.recovery.sessionId !== run.ref.sessionId)) {
          throw new ConversationRestartError('Invalid Conversation restart recovery receipt', 'unavailable');
        }
        throw error;
      }
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

  async #resolveRecovery(paneId: string): Promise<{
    controller: AgentConversationRestartControllerV1;
    receipt: ConversationRestartReceipt;
  } | null> {
    try {
      type RecoveryMatch = { controller: AgentConversationRestartControllerV1; receipt: ConversationRestartReceipt };
      let match: RecoveryMatch | null = null;
      let completed: RecoveryMatch | null = null;
      let completedAmbiguous = false;
      for (const [agentId, controller] of this.#controllers) {
        const receipt = await controller.recovery(paneId);
        if (receipt === null) continue;
        if (!validConversationRestartReceipt(receipt, agentId, paneId, controller)) {
          throw new ConversationRestartError('Ambiguous or invalid Conversation restart recovery receipt', 'unavailable');
        }
        if (receipt.phase === 'ready') {
          if (completed) completedAmbiguous = true;
          else completed = { controller, receipt };
          continue;
        }
        if (match) throw new ConversationRestartError('Ambiguous Conversation restart recovery', 'unavailable');
        match = { controller, receipt };
      }
      if (match) return match;
      if (completedAmbiguous) throw new ConversationRestartError('Ambiguous completed Conversation restart', 'unavailable');
      return completed;
    } catch (error) {
      if (error instanceof ConversationRestartError) throw error;
      throw new ConversationRestartError('Conversation restart recovery is unavailable', 'unavailable');
    }
  }

  async recovery(paneId: string): Promise<ConversationRestartReceipt | null> {
    const match = await this.#resolveRecovery(paneId);
    return match ? structuredClone(match.receipt) : null;
  }

  async recover(paneId: string, operationId: string): Promise<ConversationRestartReceipt> {
    const match = await this.#resolveRecovery(paneId);
    if (!match || match.receipt.phase === 'ready' || match.receipt.operationId !== operationId) throw new ConversationRestartError(
      'Conversation restart recovery is no longer available', 'unavailable',
    );
    const { controller } = match;
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
      if (!validConversationRestartReceipt(receipt, match.receipt.agentId, paneId, controller)
        || receipt.operationId !== operationId
        || !sameRecovery(receipt.recovery, match.receipt.recovery)) {
        throw new ConversationRestartError('Invalid Conversation restart recovery receipt', 'unavailable');
      }
      return structuredClone(receipt);
    }).catch((error: unknown) => {
      if (error instanceof ConversationRestartError) {
        if (error.recovery && (!validConversationRestartReceipt(
          error.recovery, match.receipt.agentId, paneId, controller,
        ) || error.recovery.operationId !== operationId
          || !sameRecovery(error.recovery.recovery, match.receipt.recovery))) {
          throw new ConversationRestartError('Invalid Conversation restart recovery receipt', 'unavailable');
        }
        throw error;
      }
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
