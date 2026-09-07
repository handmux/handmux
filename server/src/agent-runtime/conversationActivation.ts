import type { AgentRunLease } from './run.js';

export type ConversationActivationEffect = 'replace-process-preserve-session';

export interface ConversationActivationDescriptor {
  effect: ConversationActivationEffect;
}

export interface ConversationActivationRecovery {
  kind: 'codex_resume';
  sessionId: string;
  command: string;
}

export interface ConversationActivationRecoveryReceipt {
  operationId: string;
  recovery: ConversationActivationRecovery;
  phase: 'prepared' | 'interrupted' | 'resuming';
  state: 'current' | 'stale';
  canResume: boolean;
}

const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validRecovery(value: unknown): value is ConversationActivationRecovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const recovery = value as Partial<ConversationActivationRecovery>;
  return recovery.kind === 'codex_resume'
    && typeof recovery.sessionId === 'string'
    && CODEX_SESSION_ID_RE.test(recovery.sessionId)
    && recovery.command === `handmux codex resume ${recovery.sessionId}`;
}

function sameRecovery(
  first: ConversationActivationRecovery,
  second: ConversationActivationRecovery,
): boolean {
  return first.kind === second.kind
    && first.sessionId === second.sessionId
    && first.command === second.command;
}

function validRecoveryReceipt(value: unknown): value is ConversationActivationRecoveryReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Partial<ConversationActivationRecoveryReceipt>;
  return typeof receipt.operationId === 'string'
    && /^[0-9a-f]{64}$/.test(receipt.operationId)
    && validRecovery(receipt.recovery)
    && (receipt.phase === 'prepared' || receipt.phase === 'interrupted' || receipt.phase === 'resuming')
    && (receipt.state === 'current' || receipt.state === 'stale')
    && typeof receipt.canResume === 'boolean'
    && (!receipt.canResume || (receipt.state === 'current' && receipt.phase !== 'resuming'));
}

export interface AgentConversationActivationControllerV1 {
  apiVersion: 1;
  describe(run: AgentRunLease): Promise<ConversationActivationDescriptor | null>;
  activate(
    run: AgentRunLease,
    signal: AbortSignal,
    progress: { recovery(value: ConversationActivationRecovery): void },
  ): Promise<{ recovery?: ConversationActivationRecovery } | void>;
  recovery?(paneId: string): Promise<ConversationActivationRecoveryReceipt | null>;
  recover?(
    paneId: string,
    operationId: string,
    signal: AbortSignal,
    progress: { recovery(value: ConversationActivationRecovery): void },
  ): Promise<{ recovery?: ConversationActivationRecovery } | void>;
}

export class ConversationActivationError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported' | 'unavailable' | 'in_progress' | 'contract_violation',
    readonly recovery?: ConversationActivationRecovery,
  ) {
    super(message);
    this.name = 'ConversationActivationError';
  }
}

export class AgentConversationActivationService {
  readonly #controllers: ReadonlyMap<string, AgentConversationActivationControllerV1>;
  readonly #active = new Set<string>();
  readonly #timeoutMs: number;

  constructor(
    controllers: Readonly<Record<string, AgentConversationActivationControllerV1>>,
    { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
  ) {
    if (!controllers || typeof controllers !== 'object' || !Object.keys(controllers).length) {
      throw new TypeError('AgentConversationActivationService requires controllers');
    }
    this.#controllers = new Map(Object.entries(controllers));
    this.#timeoutMs = Math.max(1, timeoutMs);
  }

  async describe(run: AgentRunLease): Promise<ConversationActivationDescriptor | null> {
    const controller = this.#controllers.get(run.ref.agentId);
    if (!controller) throw new ConversationActivationError('Conversation activation unsupported', 'unsupported');
    let value: ConversationActivationDescriptor | null;
    try {
      value = await controller.describe(run);
    } catch {
      throw new ConversationActivationError('Conversation activation is temporarily unavailable', 'unavailable');
    }
    if (value === null) return null;
    if (!value || value.effect !== 'replace-process-preserve-session') {
      throw new ConversationActivationError('Invalid Conversation activation descriptor', 'contract_violation');
    }
    return structuredClone(value);
  }

  async activate(
    run: AgentRunLease,
    signal?: AbortSignal,
  ): Promise<{ recovery?: ConversationActivationRecovery } | undefined> {
    const controller = this.#controllers.get(run.ref.agentId);
    if (!controller) throw new ConversationActivationError('Conversation activation unsupported', 'unsupported');
    if (run.signal.aborted) {
      throw new ConversationActivationError('The Agent run is no longer active', 'unavailable');
    }
    const key = `${run.ref.paneId}\0${run.ref.runId}`;
    if (this.#active.has(key)) {
      throw new ConversationActivationError('Conversation activation is already in progress', 'in_progress');
    }
    this.#active.add(key);
    let reportedRecovery: ConversationActivationRecovery | undefined;
    const progress = {
      recovery: (value: ConversationActivationRecovery): void => {
        if (!validRecovery(value)) {
          throw new ConversationActivationError(
            'Invalid Conversation activation recovery',
            'contract_violation',
          );
        }
        const next = structuredClone(value);
        if (reportedRecovery && !sameRecovery(reportedRecovery, next)) {
          throw new ConversationActivationError(
            'Conversation activation recovery changed',
            'contract_violation',
          );
        }
        reportedRecovery = next;
      },
    };
    const operation = new AbortController();
    const cancel = (): void => operation.abort(signal?.reason ?? new Error('Activation request cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => operation.abort(new Error('Conversation activation timed out')), this.#timeoutMs);
    try {
      if (operation.signal.aborted) throw operation.signal.reason;
      const aborted = new Promise<never>((_resolve, reject) => {
        operation.signal.addEventListener('abort', () => reject(operation.signal.reason), { once: true });
      });
      const result = await Promise.race([controller.activate(run, operation.signal, progress), aborted]);
      if (!result) return reportedRecovery ? { recovery: reportedRecovery } : undefined;
      if (!validRecovery(result.recovery)
        || (reportedRecovery && !sameRecovery(reportedRecovery, result.recovery))) {
        throw new ConversationActivationError(
          'Invalid Conversation activation recovery',
          'contract_violation',
        );
      }
      return { recovery: structuredClone(result.recovery) };
    } catch (error) {
      if (error instanceof ConversationActivationError) {
        if (error.recovery !== undefined && (!validRecovery(error.recovery)
          || (reportedRecovery !== undefined && !sameRecovery(reportedRecovery, error.recovery)))) {
          throw new ConversationActivationError(
            'Invalid Conversation activation recovery',
            'contract_violation',
          );
        }
        if (error.recovery !== undefined || reportedRecovery === undefined) throw error;
        throw new ConversationActivationError(error.message, error.code, reportedRecovery);
      }
      throw new ConversationActivationError(
        'Conversation activation could not finish; continue in the terminal or try again',
        'unavailable',
        reportedRecovery,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      this.#active.delete(key);
    }
  }

  async recovery(paneId: string): Promise<ConversationActivationRecoveryReceipt | null> {
    if (!/^%\d+$/.test(paneId)) {
      throw new ConversationActivationError('Invalid Conversation activation pane', 'contract_violation');
    }
    for (const controller of this.#controllers.values()) {
      if (!controller.recovery) continue;
      try {
        const receipt = await controller.recovery(paneId);
        if (receipt === null) continue;
        if (!validRecoveryReceipt(receipt)) {
          throw new ConversationActivationError(
            'Invalid Conversation recovery receipt',
            'contract_violation',
          );
        }
        return structuredClone(receipt);
      } catch (error) {
        if (error instanceof ConversationActivationError) throw error;
        throw new ConversationActivationError('Conversation recovery is temporarily unavailable', 'unavailable');
      }
    }
    return null;
  }

  async recover(
    paneId: string,
    operationId: string,
  ): Promise<{ recovery?: ConversationActivationRecovery } | undefined> {
    if (!/^%\d+$/.test(paneId) || !/^[0-9a-f]{64}$/.test(operationId)) {
      throw new ConversationActivationError('Invalid Conversation recovery request', 'contract_violation');
    }
    const controller = [...this.#controllers.values()].find((candidate) => candidate.recover);
    if (!controller?.recover) {
      throw new ConversationActivationError('Conversation recovery unsupported', 'unsupported');
    }
    const key = `recovery\0${operationId}`;
    if (this.#active.has(key)) {
      throw new ConversationActivationError('Conversation recovery is already in progress', 'in_progress');
    }
    this.#active.add(key);
    let reportedRecovery: ConversationActivationRecovery | undefined;
    const progress = { recovery: (value: ConversationActivationRecovery): void => {
      if (!validRecovery(value)) {
        throw new ConversationActivationError('Invalid Conversation recovery', 'contract_violation');
      }
      const next = structuredClone(value);
      if (reportedRecovery && !sameRecovery(reportedRecovery, next)) {
        throw new ConversationActivationError('Conversation recovery changed', 'contract_violation');
      }
      reportedRecovery = next;
    } };
    const operation = new AbortController();
    const timer = setTimeout(() => operation.abort(new Error('Conversation recovery timed out')), this.#timeoutMs);
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        operation.signal.addEventListener('abort', () => reject(operation.signal.reason), { once: true });
      });
      const result = await Promise.race([
        controller.recover(paneId, operationId, operation.signal, progress),
        aborted,
      ]);
      if (!result) return reportedRecovery ? { recovery: reportedRecovery } : undefined;
      if (!validRecovery(result.recovery)
        || (reportedRecovery && !sameRecovery(reportedRecovery, result.recovery))) {
        throw new ConversationActivationError(
          'Invalid Conversation recovery',
          'contract_violation',
        );
      }
      return { recovery: structuredClone(result.recovery) };
    } catch (error) {
      if (error instanceof ConversationActivationError) throw error;
      throw new ConversationActivationError(
        'Conversation recovery could not finish; copy the command or continue in the terminal',
        'unavailable',
        reportedRecovery,
      );
    } finally {
      clearTimeout(timer);
      this.#active.delete(key);
    }
  }
}
