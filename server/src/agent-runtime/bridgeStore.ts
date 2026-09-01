import { PrivateStateStore } from '../privateStateStore.js';
import type { AgentRunRef } from './run.js';

export interface PersistedBridgeSnapshot {
  sequence: number;
  value: unknown;
  bytes: number;
}

export interface PersistedBridgeDurableEvent {
  eventId: string;
  sequence: number;
  payload: unknown;
  bytes: number;
}

export interface PersistedBridgeReceipt {
  eventId: string;
  sequence: number;
  payloadHash: string;
  delivery: 'ephemeral' | 'durable';
}

export interface PersistedBridgeChannel {
  agentId: string;
  run: AgentRunRef;
  name: string;
  highWatermark: number;
  lastEphemeralSequence: number;
  snapshot?: PersistedBridgeSnapshot;
  durable: PersistedBridgeDurableEvent[];
  receipts: PersistedBridgeReceipt[];
}

export interface PersistedBridgeState {
  version: 1;
  channels: PersistedBridgeChannel[];
}

export interface BridgeStateStore {
  load(): unknown;
  save(state: PersistedBridgeState): void;
}

function copyState(value: PersistedBridgeState): PersistedBridgeState {
  return structuredClone(value);
}

export class MemoryBridgeStateStore implements BridgeStateStore {
  #state: PersistedBridgeState | null = null;

  load(): unknown {
    return this.#state ? copyState(this.#state) : null;
  }

  save(state: PersistedBridgeState): void {
    this.#state = copyState(state);
  }
}

export class FileBridgeStateStore implements BridgeStateStore {
  readonly #store: PrivateStateStore<PersistedBridgeState>;

  constructor(file: string) {
    this.#store = new PrivateStateStore(file);
  }

  load(): unknown {
    return this.#store.readStrict();
  }

  save(state: PersistedBridgeState): void {
    this.#store.write(state);
  }
}
