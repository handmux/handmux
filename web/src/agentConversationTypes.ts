import type { AgentRunRef } from './agentCatalog.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ConversationCapabilities {
  history: true;
  live: 'delta' | 'settled' | 'poll';
  sendable?: true;
  steer?: true;
  send?: Array<'prompt' | 'steer' | 'follow_up'>;
  interrupt?: true;
  branching?: true;
}

export interface ConversationDescriptor {
  session: { agentId: string; sessionId: string };
  run?: AgentRunRef;
  viewId: string;
  historyVersion: string;
  capabilities: ConversationCapabilities;
  implementation?: { version: number; reloadRequired?: true };
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

export type ConversationContentBlock =
  | { type: 'text'; text: string }
  | { type: 'json'; value: JsonValue }
  | { type: 'resource'; resourceId: string; name?: string; mediaType?: string }
  | { type: 'external_link'; url: string; name?: string };

interface ConversationItemBase<K extends string> {
  id: string;
  sessionId: string;
  kind: K;
  status: 'complete' | 'error' | 'truncated';
  sourceCreatedAt?: number;
  correlationId?: string;
  groupingId?: string;
  error?: ConversationError;
  truncation?: ConversationTruncation;
  extensions?: Record<string, JsonValue>;
}

export type ConversationItem =
  | (ConversationItemBase<'message'> & {
    role: 'user' | 'assistant' | 'system'; content: ConversationContentBlock[];
  })
  | (ConversationItemBase<'reasoning_summary'> & { text: string })
  | (ConversationItemBase<'tool_call'> & {
    callId: string; name: string; input?: JsonValue; summary?: string;
  })
  | (ConversationItemBase<'tool_result'> & {
    callId: string; content: ConversationContentBlock[]; isError?: boolean;
  })
  | (ConversationItemBase<'diff'> & { path?: string; patch?: string; summary?: string })
  | (ConversationItemBase<'compaction'> & { summary?: string })
  | (ConversationItemBase<'interrupt'> & {
    actor: 'user' | 'agent' | 'system'; reason?: string;
  })
  | (ConversationItemBase<'notice'> & {
    level: 'info' | 'warning' | 'error'; code?: string; message: string;
  });

interface ConversationItemDraftBase<K extends ConversationItem['kind']> {
  kind: K;
  correlationId?: string;
  groupingId?: string;
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

export type ConversationReason =
  | 'invalid_request'
  | 'unsupported'
  | 'stale_run'
  | 'conflict'
  | 'provider_rejected'
  | 'temporarily_unavailable'
  | 'delivery_unconfirmed';

export interface ConversationSubmissionSnapshot {
  id: string;
  text: string;
  state: 'queued' | 'dispatching' | 'steering' | 'unknown';
  revision: number;
  dispatchOrigin?: 'direct' | 'queue' | 'steer';
  nativeId?: string;
  baseline?: { viewId: string; historyVersion: string; tailItemId?: string };
  autoDispatchBlockedReason?: 'provider_rejected';
  steerActionId?: string;
  steerAnchor?: { viewId: string; afterItemId?: string };
  queueOrderKey?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSendReceipt {
  status: 'accepted' | 'queued' | 'rejected' | 'unknown';
  submission?: ConversationSubmissionSnapshot;
  nativeMutation?: false | 'unknown';
  nativeId?: string;
  reason?: ConversationReason;
}

export interface InterruptReceipt {
  status: 'accepted' | 'rejected' | 'unknown';
  reason?: ConversationReason;
}
