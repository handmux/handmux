import type { AgentRunLease, AgentRunRef, AgentSessionRef } from './run.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ConversationCapabilities {
  history: true;
  live: 'delta' | 'settled' | 'poll';
  /** Core-owned sending. Adapter queue ownership is never implied by this flag. */
  sendable?: true;
  /** Optional guide-now support; ordinary sends never select this path. */
  steer?: true;
  send?: Array<'prompt' | 'steer' | 'follow_up'>;
  interrupt?: true;
  branching?: true;
}

export interface ConversationAdapterDescriptor {
  session: AgentSessionRef;
  run?: AgentRunRef;
  sourceViewId: string;
  capabilities: ConversationCapabilities;
  implementation?: { version: number; reloadRequired?: true };
}

export interface ConversationAdapterPageRequest {
  beforeSourceCursor?: string;
  limit: number;
}

export interface ConversationAdapterPage {
  sessionId: string;
  sourceViewId: string;
  sourceHistoryToken: string;
  items: ConversationItem[];
  previousSourceCursor?: string;
  hasMore: boolean;
}

export interface ConversationAdapterLiveHandle {
  checkpoint: { sourceViewId: string; sourceSequence: number };
  close(): void | Promise<void>;
}

export interface AgentConversationAdapterV1 {
  apiVersion: 1;
  discoverNative(target: AgentSessionRef | AgentRunRef):
    Promise<ConversationAdapterDescriptor | null>;
  readNativePage(session: AgentSessionRef, request: ConversationAdapterPageRequest):
    Promise<ConversationAdapterPage>;
  observeNative?(run: AgentRunLease, sink: ConversationAdapterEventSink):
    Promise<ConversationAdapterLiveHandle>;
  dispatchPrompt?(
    run: AgentRunLease,
    request: ConversationPromptRequest,
    guard?: ConversationDispatchGuard,
  ):
    Promise<ConversationDispatchReceipt>;
  dispatchSteer?(run: AgentRunLease, request: ConversationSteerRequest):
    Promise<ConversationDispatchReceipt>;
  dispatchSend?(run: AgentRunLease, request: ConversationSendRequest):
    Promise<ConversationSendReceipt>;
  dispatchInterrupt?(run: AgentRunLease): Promise<InterruptReceipt>;
}

export interface ConversationActivitySnapshot {
  activity: ConversationActivity;
  activeTurn:
    | { state: 'active'; nativeTurnId: string }
    | { state: 'none' }
    | { state: 'unknown' };
  revision: number;
  epoch: string;
  completionToken?: string;
}

export interface ConversationActivitySource {
  read(run: AgentRunLease): Promise<ConversationActivitySnapshot>;
}

/** Core-owned final validation. Providers may carry it to their native mutation boundary. */
export interface ConversationDispatchGuard {
  validate(): Promise<boolean>;
}

export interface ConversationDescriptor {
  session: AgentSessionRef;
  run?: AgentRunRef;
  viewId: string;
  historyVersion: string;
  capabilities: ConversationCapabilities;
  implementation?: { version: number; reloadRequired?: true };
}

export interface ConversationPageRequest {
  before?: string;
  limit: number;
  expectedViewId?: string;
  expectedHistoryVersion?: string;
}

export interface ConversationPage {
  sessionId: string;
  viewId: string;
  historyVersion: string;
  items: ConversationItem[];
  previousCursor?: string;
  hasMore: boolean;
}

export type ConversationPageResult =
  | { status: 'ok'; page: ConversationPage }
  | { status: 'stale'; currentViewId: string; currentHistoryVersion: string };

export interface ConversationOpenRequest { expectedViewId?: string }

export interface ConversationLiveHandle {
  checkpoint: { viewId: string; historyVersion: string; streamSequence: number };
  close(): void | Promise<void>;
}

export interface ConversationError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface ConversationTruncation {
  reason: 'size_limit' | 'provider_truncated' | 'redacted' | 'unavailable';
  originalBytes?: number;
}

export interface ConversationItemBase<K extends string> {
  id: string;
  sessionId: string;
  kind: K;
  status: 'complete' | 'error' | 'truncated';
  sourceCreatedAt?: number;
  /** Provider-neutral native turn/group identity used only for presentation grouping. */
  groupingId?: string;
  /** Core submission identity used only to reconcile an optimistic/local send. */
  correlationId?: string;
  error?: ConversationError;
  truncation?: ConversationTruncation;
  extensions?: Record<string, JsonValue>;
}

export type ConversationContentBlock =
  | { type: 'text'; text: string }
  | { type: 'json'; value: JsonValue }
  | { type: 'resource'; resourceId: string; name?: string; mediaType?: string }
  | { type: 'external_link'; url: string; name?: string };

export interface ConversationMessageItem extends ConversationItemBase<'message'> {
  role: 'user' | 'assistant' | 'system';
  content: ConversationContentBlock[];
}

export interface ConversationReasoningSummaryItem
  extends ConversationItemBase<'reasoning_summary'> { text: string }

export interface ConversationToolCallItem extends ConversationItemBase<'tool_call'> {
  callId: string;
  name: string;
  input?: JsonValue;
  summary?: string;
}

export interface ConversationToolResultItem extends ConversationItemBase<'tool_result'> {
  callId: string;
  content: ConversationContentBlock[];
  isError?: boolean;
}

export interface ConversationDiffItem extends ConversationItemBase<'diff'> {
  path?: string;
  patch?: string;
  summary?: string;
}

export interface ConversationCompactionItem extends ConversationItemBase<'compaction'> {
  summary?: string;
}

export interface ConversationInterruptItem extends ConversationItemBase<'interrupt'> {
  actor: 'user' | 'agent' | 'system';
  reason?: string;
}

export interface ConversationNoticeItem extends ConversationItemBase<'notice'> {
  level: 'info' | 'warning' | 'error';
  code?: string;
  message: string;
}

export type ConversationItem =
  | ConversationMessageItem
  | ConversationReasoningSummaryItem
  | ConversationToolCallItem
  | ConversationToolResultItem
  | ConversationDiffItem
  | ConversationCompactionItem
  | ConversationInterruptItem
  | ConversationNoticeItem;

export interface ConversationItemDraftBase<K extends ConversationItem['kind']> {
  kind: K;
  groupingId?: string;
  correlationId?: string;
  extensions?: Record<string, JsonValue>;
}

export type ConversationItemDraft =
  | (ConversationItemDraftBase<'message'> & {
    role: 'user' | 'assistant' | 'system'; content: ConversationContentBlock[];
  })
  | (ConversationItemDraftBase<'reasoning_summary'> & { text: string })
  | (ConversationItemDraftBase<'tool_call'> & {
    callId: string; name: string; input?: JsonValue; summary?: string;
  })
  | (ConversationItemDraftBase<'tool_result'> & {
    callId: string; content: ConversationContentBlock[]; isError?: boolean;
  })
  | (ConversationItemDraftBase<'diff'> & { path?: string; patch?: string; summary?: string })
  | (ConversationItemDraftBase<'compaction'> & { summary?: string })
  | (ConversationItemDraftBase<'interrupt'> & {
    actor: 'user' | 'agent' | 'system'; reason?: string;
  })
  | (ConversationItemDraftBase<'notice'> & {
    level: 'info' | 'warning' | 'error'; code?: string; message: string;
  });

export type ConversationDelta =
  | {
    op: 'text.append';
    target: 'message.content' | 'reasoning_summary.text' | 'tool_result.content';
    blockIndex?: number;
    text: string;
  }
  | { op: 'item.replace'; draft: ConversationItemDraft };

export type ConversationAdapterEvent =
  | { type: 'item.opened'; sourceSequence: number; provisionalId: string; draft: ConversationItemDraft }
  | { type: 'item.delta'; sourceSequence: number; provisionalId: string; delta: ConversationDelta }
  | {
    type: 'item.settled'; sourceSequence: number; provisionalId: string;
    durableItemId?: string; item?: ConversationItem;
  }
  | {
    type: 'item.cancelled'; sourceSequence: number; provisionalId: string;
    reason?: 'interrupted' | 'superseded' | 'provider_error' | 'stream_reset';
  }
  | {
    type: 'history.committed'; sourceSequence: number;
    sourceViewId: string; sourceHistoryToken: string;
  }
  | { type: 'stream.gap'; sourceSequence: number; afterSourceSequence: number };

export type ConversationAdapterEventSink =
  (event: ConversationAdapterEvent) => void | Promise<void>;

export type ConversationEvent =
  | { type: 'item.opened'; sequence: number; provisionalId: string; draft: ConversationItemDraft }
  | { type: 'item.delta'; sequence: number; provisionalId: string; delta: ConversationDelta }
  | {
    type: 'item.settled'; sequence: number; provisionalId: string;
    durableItemId?: string; item?: ConversationItem;
  }
  | {
    type: 'item.cancelled'; sequence: number; provisionalId: string;
    reason?: 'interrupted' | 'superseded' | 'provider_error' | 'stream_reset';
  }
  | { type: 'history.changed'; sequence: number; historyVersion: string; viewId: string }
  | { type: 'stream.gap'; sequence: number; afterSequence: number };

export type ConversationEventSink = (event: ConversationEvent) => void | Promise<void>;

export interface ConversationSendRequest {
  clientRequestId: string;
  text: string;
  delivery: 'prompt' | 'steer' | 'follow_up';
}

export interface ConversationPromptRequest {
  clientRequestId: string;
  text: string;
}

export interface ConversationSteerPlan {
  kind: 'steer-active-turn' | 'start-turn-fallback';
  activityEpoch: string;
  activityRevision: number;
  nativeTurnId?: string;
}

export interface ConversationSteerRequest extends ConversationPromptRequest {
  plan: ConversationSteerPlan;
  anchor: { viewId: string; afterItemId?: string };
}

export type ConversationReason =
  | 'invalid_request'
  | 'unsupported'
  | 'stale_run'
  | 'conflict'
  | 'provider_rejected'
  | 'temporarily_unavailable'
  | 'delivery_unconfirmed';

export interface ConversationSendReceipt {
  status: 'accepted' | 'queued' | 'rejected' | 'unknown';
  nativeId?: string;
  reason?: ConversationReason;
}

export type ConversationDispatchReceipt =
  | { outcome: 'accepted'; nativeId?: string }
  | { outcome: 'busy'; nativeMutation: false }
  | { outcome: 'rejected'; nativeMutation: false; reason: ConversationReason }
  | { outcome: 'unknown'; nativeMutation: 'unknown'; reason?: ConversationReason };

export type ConversationSubmissionState =
  | 'queued' | 'dispatching' | 'steering' | 'unknown';

export type ConversationActivity = 'idle' | 'working' | 'waiting' | 'compacting' | 'unknown';

export interface ConversationSubmissionSnapshot {
  id: string;
  text: string;
  state: ConversationSubmissionState;
  revision: number;
  dispatchOrigin?: 'direct' | 'queue' | 'steer';
  nativeId?: string;
  baseline?: { viewId: string; historyVersion: string; tailItemId?: string };
  queueOrderKey?: string;
  autoDispatchBlockedReason?: 'provider_rejected';
  steerActionId?: string;
  steerBaseRevision?: number;
  steerAnchor?: { viewId: string; afterItemId?: string };
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSubmitReceipt {
  status: 'accepted' | 'queued' | 'rejected' | 'unknown';
  submission?: ConversationSubmissionSnapshot;
  nativeId?: string;
  reason?: ConversationReason;
  nativeMutation?: false | 'unknown';
  conflict?: 'action_id_mismatch';
}

export interface InterruptReceipt {
  status: 'accepted' | 'rejected' | 'unknown';
  reason?: ConversationReason;
  nativeMutation?: false | 'unknown';
}
