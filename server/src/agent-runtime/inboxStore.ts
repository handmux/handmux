import { PrivateStateStore } from '../privateStateStore.js';
import type {
  AgentTerminalNotificationRecord,
  InboxAvailability,
  InboxRecord,
} from './inboxTypes.js';
import type { AgentRunRef } from './run.js';

export interface PersistedInboxSourceReceipt {
  sourceId: string;
  cursor: string;
  operationHash: string;
  inboxSequence?: number;
  acceptedAt?: number;
  eventId?: string;
  lastReceivedAt: number;
}

export interface PersistedInboxEventReceipt {
  eventId: string;
  operationHash: string;
  inboxSequence: number;
  acceptedAt: number;
  lastReceivedAt: number;
}

export interface PersistedInboxRun {
  run: AgentRunRef;
  highWatermark: number;
  latest: InboxRecord | undefined;
  sources: PersistedInboxSourceReceipt[];
  events: PersistedInboxEventReceipt[];
}

export interface PersistedInboxAvailability {
  agentId: string;
  availability: InboxAvailability;
  message?: string;
}

export interface PersistedInboxState {
  version: 1;
  runs: PersistedInboxRun[];
  availability: PersistedInboxAvailability[];
  terminalNotifications: AgentTerminalNotificationRecord[];
}

export interface InboxStateStore {
  load(): unknown;
  save(state: PersistedInboxState): void;
}

function copyState(value: PersistedInboxState): PersistedInboxState {
  return structuredClone(value);
}

export class MemoryInboxStateStore implements InboxStateStore {
  #state: PersistedInboxState | null = null;

  load(): unknown {
    return this.#state ? copyState(this.#state) : null;
  }

  save(state: PersistedInboxState): void {
    this.#state = copyState(state);
  }
}

export class FileInboxStateStore implements InboxStateStore {
  readonly #store: PrivateStateStore<PersistedInboxState>;

  constructor(file: string) {
    this.#store = new PrivateStateStore(file);
  }

  load(): unknown {
    return this.#store.readStrict();
  }

  save(state: PersistedInboxState): void {
    this.#store.write(state);
  }
}
