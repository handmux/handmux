import type { AgentRunLease, AgentRunRef } from './run.js';

export interface BridgeLimits {
  maxFrameBytes: number;
  maxSnapshotBytes: number;
  maxQueuedEventsPerChannel: number;
  maxQueuedBytesPerChannel: number;
  maxDurableSpoolBytesPerAdapter: number;
  maxRequestsPerRun: number;
  maxRequestsPerAdapter: number;
  defaultRequestTimeoutMs: number;
  maxRequestTimeoutMs: number;
  sustainedEventsPerSecond: number;
  burstEvents: number;
}

export const DEFAULT_BRIDGE_LIMITS: Readonly<BridgeLimits> = Object.freeze({
  maxFrameBytes: 256 * 1024,
  maxSnapshotBytes: 1024 * 1024,
  maxQueuedEventsPerChannel: 256,
  maxQueuedBytesPerChannel: 4 * 1024 * 1024,
  maxDurableSpoolBytesPerAdapter: 16 * 1024 * 1024,
  maxRequestsPerRun: 32,
  maxRequestsPerAdapter: 128,
  defaultRequestTimeoutMs: 30_000,
  maxRequestTimeoutMs: 5 * 60_000,
  sustainedEventsPerSecond: 200,
  burstEvents: 500,
});

export interface BridgePublishRequest {
  eventId?: string;
  payload: unknown;
}

export interface BridgeEventEnvelope {
  eventId?: string;
  sequence: number;
  payload: unknown;
}

export interface BridgeWriteReceipt {
  accepted: boolean;
  sequence?: number;
  reason?: 'stale_lease' | 'duplicate' | 'rate_limited' | 'spool_full' | 'invalid';
}

export interface LocalAgentBridgeChannel {
  setSnapshot(value: unknown): Promise<BridgeWriteReceipt>;
  publish(
    event: BridgePublishRequest,
    options?: { delivery?: 'ephemeral' | 'durable' },
  ): Promise<BridgeWriteReceipt>;
  handle(method: string, handler: BridgeRequestHandler): () => void;
}

export interface LocalAgentBridgeConnection {
  readonly connectionId: string;
  readonly signal: AbortSignal;
  readonly limits: Readonly<BridgeLimits>;
  channel(name: string): LocalAgentBridgeChannel;
  close(): void;
}

export type BridgeHostEvent =
  | { type: 'event'; event: BridgeEventEnvelope }
  | { type: 'snapshot'; sequence: number; value: unknown }
  | { type: 'gap'; afterSequence: number };

export type BridgeHostEventSink = (event: BridgeHostEvent) => void | Promise<void>;

export interface BridgeHostChannelHandle {
  snapshot?: unknown;
  snapshotAvailability: 'ready' | 'unavailable';
  streamSequence: number;
  close(): void;
}

export interface BridgeDurableReplay {
  run: AgentRunRef;
  runStatus: 'current' | 'revoked';
  event: BridgeEventEnvelope;
}

export type BridgeDurableReplayResult = 'accepted' | 'invalid' | 'retry';
export type BridgeDurableReplaySink = (
  replay: BridgeDurableReplay,
) => Promise<BridgeDurableReplayResult>;

export interface BridgeRequestContext {
  requestId: string;
  deadlineAt: number;
  signal: AbortSignal;
}

export type BridgeRequestHandler = (
  payload: unknown,
  context: BridgeRequestContext,
) => Promise<unknown>;

export interface LocalAgentBridgeHost {
  readonly limits: Readonly<BridgeLimits>;
  openChannel(
    run: AgentRunLease,
    name: string,
    sink: BridgeHostEventSink,
  ): Promise<BridgeHostChannelHandle>;
  consumeDurableReplays(name: string, sink: BridgeDurableReplaySink): () => void;
  drainDurable(
    run: AgentRunRef,
    name: string,
    throughSequence: number,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  request(
    run: AgentRunLease,
    channel: string,
    method: string,
    payload: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
}
