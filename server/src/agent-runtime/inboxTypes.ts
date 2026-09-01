import type { AgentRunLease, AgentRunRef } from './run.js';

export type InboxState = 'working' | 'waiting' | 'done' | 'error';
export type InboxAvailability = 'ready' | 'degraded' | 'unavailable';

export interface InboxSourceRef {
  sourceId: string;
  cursor?: string;
}

export interface InboxBaseline {
  run: AgentRunRef;
  source: InboxSourceRef;
  state: InboxState;
  message?: string;
  reason?: string;
  correlationId?: string;
  eventId?: string;
  sourceOccurredAt?: number;
}

export interface InboxRestoreResult {
  availability: InboxAvailability;
  snapshot?: InboxBaseline[];
  message?: string;
}

export interface InboxOperationBase {
  source: InboxSourceRef;
  message?: string | null;
  reason?: string | null;
  correlationId?: string;
  eventId?: string;
  sourceOccurredAt?: number;
}

export type InboxOperation =
  | ({ kind: 'set'; state: InboxState } & InboxOperationBase)
  | ({ kind: 'clear' } & InboxOperationBase);

export interface InboxTerminalReplay {
  run: AgentRunRef;
  source: InboxSourceRef;
  state: 'done' | 'error';
  message?: string;
  reason?: string;
  correlationId?: string;
  eventId: string;
  sourceOccurredAt?: number;
}

export interface InboxCommitResult {
  accepted: boolean;
  reason?:
    | 'stale_lease'
    | 'duplicate_source'
    | 'duplicate_event'
    | 'invalid_operation'
    | 'persistence_failed';
  serviceEpoch: string;
  revision: number;
  inboxSequence?: number;
  acceptedAt?: number;
  receivedAt: number;
}

export interface InboxRestoreReceipt {
  availability: InboxAvailability;
  serviceEpoch: string;
  revision: number;
}

export interface InboxRecord {
  run: AgentRunRef;
  source: InboxSourceRef;
  state: InboxState;
  message?: string;
  reason?: string;
  correlationId?: string;
  eventId?: string;
  inboxSequence?: number;
  sourceOccurredAt?: number;
  acceptedAt?: number;
  receivedAt: number;
}

export interface AgentTerminalNotificationRecord {
  id: string;
  agentId: string;
  runId: string;
  sessionId?: string;
  paneId: string;
  eventId: string;
  state: 'done' | 'error';
  message?: string;
  reason?: string;
  correlationId?: string;
  acceptedAt: number;
  readAt?: number;
  expiresAt: number;
}

export interface InboxTerminalReadReceipt {
  serviceEpoch: string;
  revision: number;
  markedIds: readonly string[];
  readAt?: number;
}

export interface InboxUserNotificationEvent {
  run: AgentRunRef;
  state: 'waiting' | 'done' | 'error';
  eventId: string;
  message?: string;
  reason?: string;
  correlationId?: string;
  acceptedAt: number;
  terminalNotificationId?: string;
}

export type InboxUserNotificationListener = (
  event: InboxUserNotificationEvent,
) => void | Promise<void>;

export interface InboxRunProjector {
  submit(operation: InboxOperation): Promise<InboxCommitResult>;
}

export interface InboxOrderedProjector {
  forRun(run: AgentRunLease): InboxRunProjector;
  restore(result: InboxRestoreResult): Promise<InboxRestoreReceipt>;
  submitTerminalReplay(replay: InboxTerminalReplay): Promise<InboxCommitResult>;
}

export interface InboxServiceSnapshot {
  serviceEpoch: string;
  revision: number;
  availability: Readonly<Record<string, { availability: InboxAvailability; message?: string }>>;
  records: readonly InboxRecord[];
  terminalNotifications: readonly AgentTerminalNotificationRecord[];
}
