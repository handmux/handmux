import { PrivateStateStore } from '../privateStateStore.js';
import type {
  InteractionAdapterPending,
  InteractionReceipt,
} from './interactionTypes.js';
import type { AgentRunRef } from './run.js';

export interface PersistedInteraction {
  agentId: string;
  run: AgentRunRef;
  sourceInteractionId: string;
  publicInteractionId: string;
  resolutionToken: string;
  pending: InteractionAdapterPending;
  state: 'pending' | 'dispatching' | 'resolved';
  receipt?: InteractionReceipt;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedInteractionState {
  version: 1;
  interactions: PersistedInteraction[];
}

export interface InteractionStateStore {
  load(): unknown;
  save(state: PersistedInteractionState): void;
}

export class MemoryInteractionStateStore implements InteractionStateStore {
  #state: PersistedInteractionState | null = null;

  load(): unknown {
    return this.#state === null ? null : structuredClone(this.#state);
  }

  save(state: PersistedInteractionState): void {
    this.#state = structuredClone(state);
  }
}

export class FileInteractionStateStore implements InteractionStateStore {
  readonly #store: PrivateStateStore<PersistedInteractionState>;

  constructor(file: string) {
    this.#store = new PrivateStateStore(file);
  }

  load(): unknown { return this.#store.readStrict(); }

  save(state: PersistedInteractionState): void { this.#store.write(state); }
}
