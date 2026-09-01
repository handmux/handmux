import type { AgentRunLease } from './run.js';

export type ConversationActivationEffect = 'replace-process-preserve-session';

export interface ConversationActivationDescriptor {
  effect: ConversationActivationEffect;
}

export interface AgentConversationActivationControllerV1 {
  apiVersion: 1;
  describe(run: AgentRunLease): Promise<ConversationActivationDescriptor | null>;
  activate(run: AgentRunLease, signal: AbortSignal): Promise<void>;
}

export class ConversationActivationError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported' | 'unavailable' | 'in_progress' | 'contract_violation',
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

  async activate(run: AgentRunLease, signal?: AbortSignal): Promise<void> {
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
      await Promise.race([controller.activate(run, operation.signal), aborted]);
    } catch (error) {
      if (error instanceof ConversationActivationError) throw error;
      throw new ConversationActivationError(
        'Conversation activation could not finish; continue in the terminal or try again',
        'unavailable',
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      this.#active.delete(key);
    }
  }
}
