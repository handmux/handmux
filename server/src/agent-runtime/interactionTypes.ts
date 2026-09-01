import type { AgentRunLease } from './run.js';

export type InteractionType =
  | 'approval'
  | 'select'
  | 'multi_select'
  | 'text'
  | 'editor'
  | 'form'
  | 'local_only';

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface InteractionDetail {
  kind?: 'reason' | 'command' | 'working_directory' | 'context';
  type: 'text' | 'code' | 'path';
  text: string;
}

export type InteractionIntent =
  | 'command_approval' | 'file_approval' | 'permission_approval' | 'input_request';

export interface InteractionFormField {
  id: string;
  type: 'text' | 'secret' | 'select';
  prompt: string;
  label?: string;
  options?: InteractionOption[];
  allowOther?: boolean;
}

export interface InteractionAdapterPending {
  id: string;
  correlationId?: string;
  intent?: InteractionIntent;
  type: InteractionType;
  prompt: string;
  options?: InteractionOption[];
  details?: InteractionDetail[];
  fields?: InteractionFormField[];
}

export type InteractionAdapterEvent =
  | { type: 'opened'; sourceCursor: string; interaction: InteractionAdapterPending }
  | { type: 'resolved'; sourceCursor: string; interactionId: string }
  | { type: 'cancelled'; sourceCursor: string; interactionId: string; reason?: InteractionReason };

export type InteractionAdapterEventSink =
  (event: InteractionAdapterEvent) => void | Promise<void>;

export interface InteractionAdapterLiveHandle {
  checkpoint: { sourceCursor: string; pending: InteractionAdapterPending[] };
  close(): void | Promise<void>;
}

export type InteractionValue =
  | { type: 'approval'; optionId: string }
  | { type: 'selection'; optionIds: string[] }
  | { type: 'text'; text: string }
  | { type: 'form'; answers: Record<string, string> };

export interface InteractionAdapterResponse {
  interactionId: string;
  value: InteractionValue;
}

export type InteractionReason =
  | 'invalid_request'
  | 'invalid_value'
  | 'local_only'
  | 'stale_run'
  | 'already_resolved'
  | 'provider_rejected'
  | 'temporarily_unavailable'
  | 'stream_reset';

export interface InteractionReceipt {
  status: 'accepted' | 'already_resolved' | 'stale_run' | 'rejected' | 'unknown';
  reason?: InteractionReason;
}

export interface AgentInteractionAdapterV1 {
  apiVersion: 1;
  observeNative(run: AgentRunLease, sink: InteractionAdapterEventSink):
    Promise<InteractionAdapterLiveHandle>;
  dispatchResponse(run: AgentRunLease, request: InteractionAdapterResponse):
    Promise<InteractionReceipt>;
}

export interface PendingInteraction {
  id: string;
  runId: string;
  correlationId?: string;
  intent?: InteractionIntent;
  type: InteractionType;
  prompt: string;
  options?: InteractionOption[];
  details?: InteractionDetail[];
  fields?: InteractionFormField[];
  resolutionToken: string;
}

export type InteractionEvent =
  | { type: 'opened'; revision: number; interaction: PendingInteraction }
  | { type: 'resolved'; revision: number; interactionId: string }
  | { type: 'cancelled'; revision: number; interactionId: string; reason?: InteractionReason };

export type InteractionEventSink = (event: InteractionEvent) => void | Promise<void>;

export interface InteractionLiveHandle {
  revision: number;
  pending: PendingInteraction[];
  closed: Promise<void>;
  close(): void | Promise<void>;
}

export interface InteractionResponse {
  interactionId: string;
  resolutionToken: string;
  value: InteractionValue;
}
