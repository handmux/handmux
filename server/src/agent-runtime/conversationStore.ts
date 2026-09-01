import { PrivateStateStore } from '../privateStateStore.js';
import type { ConversationSendReceipt } from './conversationTypes.js';
import type {
  ConversationSteerPlan,
  ConversationSubmissionState,
} from './conversationTypes.js';

export interface PersistedConversationSend {
  agentId: string;
  runId: string;
  sessionId?: string;
  clientRequestId: string;
  payloadHash: string;
  state: 'dispatching' | 'terminal';
  receipt?: ConversationSendReceipt;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface PersistedConversationState {
  version: 1;
  sends: PersistedConversationSend[];
}

export interface PersistedConversationSubmission {
  agentId: string;
  sessionId: string;
  clientRequestId: string;
  text: string;
  payloadHash: string;
  state: ConversationSubmissionState;
  revision: number;
  dispatchOrigin?: 'direct' | 'queue' | 'steer';
  lastRunId?: string;
  nativeId?: string;
  queueOrderKey?: string;
  autoDispatchBlockedReason?: 'provider_rejected';
  steerActionId?: string;
  steerBaseRevision?: number;
  steerAnchor?: { viewId: string; afterItemId?: string };
  steerDispatchPlan?: ConversationSteerPlan;
  steerAttempts?: Array<{
    actionId: string;
    baseRevision: number;
    anchor: { viewId: string; afterItemId?: string };
    result: 'rejected';
  }>;
  baseline?: { viewId: string; historyVersion: string; tailItemId?: string };
  createdAt: number;
  updatedAt: number;
  receiptExpiresAt?: number;
}

/**
 * Durable idempotency evidence after native acceptance. It deliberately carries no prompt text:
 * accepted delivery is no longer a renderable submission and must never restore an outgoing bubble.
 */
export interface PersistedConversationDeliveryReceipt {
  agentId: string;
  sessionId: string;
  clientRequestId: string;
  payloadHash: string;
  baseline?: { viewId: string; historyVersion: string; tailItemId?: string };
  nativeId?: string;
  /** Canonical history has taken display ownership; keep the receipt hidden for retry idempotency. */
  canonicalObservedAt?: number;
  steerActionId?: string;
  steerBaseRevision?: number;
  steerAnchor?: { viewId: string; afterItemId?: string };
  steerDispatchPlan?: ConversationSteerPlan;
  steerAttempts?: Array<{
    actionId: string;
    baseRevision: number;
    anchor: { viewId: string; afterItemId?: string };
    result: 'rejected';
  }>;
  acceptedAt: number;
  expiresAt: number;
  /** Missing on older records means accepted. In-flight records recover as unknown after restart. */
  status?: 'dispatching' | 'unknown' | 'accepted';
}

export interface PersistedConversationCycle {
  agentId: string;
  sessionId: string;
  state: 'closed' | 'dispatching' | 'awaiting_non_idle' | 'awaiting_idle' | 'unknown';
  revision: number;
  ownerSubmissionId?: string;
  activityEpoch: string;
  baselineRevision: number;
  baselineCompletionToken?: string;
  nonIdleRevision?: number;
  closedIdleRevision?: number;
}

export interface PersistedConversationStateV2 {
  version: 2;
  ledgerRevision: number;
  submissions: PersistedConversationSubmission[];
  deliveryReceipts?: PersistedConversationDeliveryReceipt[];
  cycles: PersistedConversationCycle[];
  legacySends?: PersistedConversationSend[];
  migrations?: {
    legacyCodexOutboxImported?: {
      fingerprint: string;
      submissionIds: string[];
      submissionKeys?: string[];
      importedAt: number;
    };
  };
}

export type AnyPersistedConversationState = PersistedConversationState | PersistedConversationStateV2;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function validAnchor(value: unknown): boolean {
  const anchor = record(value);
  return Boolean(anchor && text(anchor.viewId, 1024)
    && (anchor.afterItemId === undefined || text(anchor.afterItemId, 1024)));
}

function validSteerPlan(value: unknown): boolean {
  const plan = record(value);
  if (!plan || !text(plan.activityEpoch, 256) || !integer(plan.activityRevision, 1)) return false;
  if (plan.kind === 'steer-active-turn') return text(plan.nativeTurnId, 1024);
  return plan.kind === 'start-turn-fallback' && plan.nativeTurnId === undefined;
}

function validBaseline(value: unknown): boolean {
  const baseline = record(value);
  return Boolean(baseline && text(baseline.viewId, 1024) && text(baseline.historyVersion, 1024)
    && (baseline.tailItemId === undefined || text(baseline.tailItemId, 1024)));
}

const SEND_STATUSES = new Set(['accepted', 'queued', 'rejected', 'unknown']);
const SEND_REASONS = new Set([
  'invalid_request', 'unsupported', 'stale_run', 'conflict', 'provider_rejected',
  'temporarily_unavailable', 'delivery_unconfirmed',
]);

function validLegacyReceipt(value: unknown): boolean {
  const receipt = record(value);
  if (!receipt || !SEND_STATUSES.has(String(receipt.status))
    || (receipt.nativeId !== undefined && !text(receipt.nativeId, 1024))
    || (receipt.reason !== undefined && (!text(receipt.reason, 4096)
      || !SEND_REASONS.has(receipt.reason)))) return false;
  return receipt.status === 'accepted' || receipt.status === 'queued'
    ? receipt.reason === undefined : true;
}

function parseLegacySends(value: unknown): PersistedConversationSend[] {
  if (!Array.isArray(value)) throw new Error('Corrupt Conversation legacy send ledger');
  const keys = new Set<string>();
  return value.map((candidate): PersistedConversationSend => {
    const row = record(candidate);
    if (!row || !text(row.agentId, 64) || !text(row.runId, 256)
      || (row.sessionId !== undefined && !text(row.sessionId, 1024))
      || !text(row.clientRequestId, 256)
      || typeof row.payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.payloadHash)
      || (row.state !== 'dispatching' && row.state !== 'terminal')
      || !time(row.createdAt) || !time(row.updatedAt)
      || (row.expiresAt !== undefined && !time(row.expiresAt))
      || (row.state === 'dispatching' ? row.receipt !== undefined : !validLegacyReceipt(row.receipt))) {
      throw new Error('Corrupt Conversation legacy send ledger');
    }
    const key = `${row.agentId}\0${row.sessionId ?? ''}\0${row.runId}\0${row.clientRequestId}`;
    if (keys.has(key)) throw new Error('Duplicate Conversation legacy send');
    keys.add(key);
    return structuredClone(row) as unknown as PersistedConversationSend;
  });
}

export function emptyConversationState(): PersistedConversationStateV2 {
  return {
    version: 2, ledgerRevision: 0, submissions: [], deliveryReceipts: [], cycles: [], legacySends: [],
  };
}

export function parseConversationState(value: unknown): PersistedConversationStateV2 {
  if (value === null || value === undefined) return emptyConversationState();
  const root = record(value);
  if (!root) throw new Error('Unsupported or corrupt Conversation state');
  if (root.version === 1) {
    return { ...emptyConversationState(), legacySends: parseLegacySends(root.sends) };
  }
  if (root.version !== 2 || !integer(root.ledgerRevision)
    || !Array.isArray(root.submissions) || !Array.isArray(root.cycles)) {
    throw new Error('Unsupported or corrupt Conversation state');
  }
  const submissionKeys = new Set<string>();
  const activeSubmissionKeys = new Set<string>();
  const deliveryReceipts: PersistedConversationDeliveryReceipt[] = [];
  const retiredTerminalKeys = new Set<string>();
  const submissions = root.submissions.map((candidate): PersistedConversationSubmission | null => {
    const row = record(candidate);
    const states = ['queued', 'dispatching', 'steering', 'accepted', 'unknown', 'observed'] as const;
    if (!row || !text(row.agentId, 64) || !text(row.sessionId, 1024)
      || !text(row.clientRequestId, 256) || !text(row.text, 262_144)
      || typeof row.payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.payloadHash)
      || !states.includes(row.state as typeof states[number])
      || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
      || !time(row.createdAt) || !time(row.updatedAt)) {
      throw new Error('Corrupt Conversation submission ledger');
    }
    const key = `${row.agentId}\0${row.sessionId}\0${row.clientRequestId}`;
    if (submissionKeys.has(key)) throw new Error('Duplicate Conversation submission');
    submissionKeys.add(key);
    const state = row.state as typeof states[number];
    const origin = row.dispatchOrigin;
    if (origin !== undefined && origin !== 'direct' && origin !== 'queue' && origin !== 'steer') {
      throw new Error('Corrupt Conversation submission origin');
    }
    if ((state === 'queued' && origin !== undefined)
      || (state === 'dispatching' && origin !== 'direct' && origin !== 'queue')
      || (state === 'steering' && origin !== 'steer')
      || ((state === 'accepted' || state === 'unknown') && !origin)) {
      throw new Error('Conversation submission origin is missing');
    }
    if (row.queueOrderKey !== undefined && !text(row.queueOrderKey, 256)) {
      throw new Error('Corrupt Conversation queue order');
    }
    if (row.autoDispatchBlockedReason !== undefined
      && row.autoDispatchBlockedReason !== 'provider_rejected') {
      throw new Error('Corrupt Conversation dispatch barrier');
    }
    if (row.autoDispatchBlockedReason !== undefined && state !== 'queued') {
      throw new Error('Conversation dispatch barrier has an invalid state');
    }
    if ((row.nativeId !== undefined && !text(row.nativeId, 1024))
      || (row.lastRunId !== undefined && !text(row.lastRunId, 256))
      || (row.steerActionId !== undefined && !text(row.steerActionId, 256))
      || (row.steerAnchor !== undefined && !validAnchor(row.steerAnchor))
      || (row.steerDispatchPlan !== undefined && !validSteerPlan(row.steerDispatchPlan))
      || (row.baseline !== undefined && !validBaseline(row.baseline))
      || (row.receiptExpiresAt !== undefined && !time(row.receiptExpiresAt))) {
      throw new Error('Corrupt Conversation submission metadata');
    }
    if (row.steerBaseRevision !== undefined
      && (!Number.isSafeInteger(row.steerBaseRevision) || Number(row.steerBaseRevision) < 1)) {
      throw new Error('Corrupt Conversation steer base revision');
    }
    if (row.steerAttempts !== undefined && (!Array.isArray(row.steerAttempts)
      || row.steerAttempts.length > 8 || row.steerAttempts.some((attempt) => {
        const value = record(attempt);
        const anchor = record(value?.anchor);
        return !value || !text(value.actionId, 256)
          || !Number.isSafeInteger(value.baseRevision) || Number(value.baseRevision) < 1
          || value.result !== 'rejected' || !anchor || !text(anchor.viewId, 1024)
          || (anchor.afterItemId !== undefined && !text(anchor.afterItemId, 1024));
      }))) throw new Error('Corrupt Conversation steer attempt history');
    const steerTuple = [row.steerActionId, row.steerBaseRevision, row.steerAnchor, row.steerDispatchPlan]
      .filter((part) => part !== undefined).length;
    if (steerTuple !== 0 && steerTuple !== 4) throw new Error('Conversation steer plan is incomplete');
    if ((state === 'steering' || origin === 'steer') && steerTuple !== 4) {
      throw new Error('Conversation steer plan is missing');
    }
    const queueOwned = state === 'queued' || state === 'steering' || origin === 'queue' || origin === 'steer';
    if (queueOwned !== text(row.queueOrderKey, 256)) {
      throw new Error(queueOwned ? 'Conversation queue order is missing' : 'Conversation queue order is invalid');
    }
    if ((state === 'steering' || state === 'unknown') && origin === 'steer') {
      deliveryReceipts.push({
        agentId: row.agentId as string,
        sessionId: row.sessionId as string,
        clientRequestId: row.clientRequestId as string,
        payloadHash: row.payloadHash as string,
        ...(row.baseline === undefined ? {}
          : { baseline: structuredClone(row.baseline) as NonNullable<PersistedConversationDeliveryReceipt['baseline']> }),
        steerActionId: row.steerActionId as string,
        steerBaseRevision: row.steerBaseRevision as number,
        steerAnchor: structuredClone(row.steerAnchor) as { viewId: string; afterItemId?: string },
        steerDispatchPlan: structuredClone(row.steerDispatchPlan) as ConversationSteerPlan,
        ...(row.steerAttempts === undefined ? {}
          : { steerAttempts: structuredClone(row.steerAttempts) as NonNullable<PersistedConversationDeliveryReceipt['steerAttempts']> }),
        acceptedAt: row.updatedAt as number,
        expiresAt: (row.receiptExpiresAt as number | undefined) ?? (row.updatedAt as number) + 86_400_000,
        status: 'unknown',
      });
      retiredTerminalKeys.add(key);
      return null;
    }
    if (state === 'accepted' || state === 'observed') {
      retiredTerminalKeys.add(key);
      deliveryReceipts.push({
        agentId: row.agentId as string,
        sessionId: row.sessionId as string,
        clientRequestId: row.clientRequestId as string,
        payloadHash: row.payloadHash as string,
        ...(row.baseline === undefined ? {}
          : { baseline: structuredClone(row.baseline) as NonNullable<PersistedConversationDeliveryReceipt['baseline']> }),
        ...(row.nativeId === undefined ? {} : { nativeId: row.nativeId as string }),
        ...(state === 'observed' ? { canonicalObservedAt: row.updatedAt as number } : {}),
        ...(row.steerActionId === undefined ? {} : { steerActionId: row.steerActionId as string }),
        ...(row.steerBaseRevision === undefined ? {}
          : { steerBaseRevision: row.steerBaseRevision as number }),
        ...(row.steerAnchor === undefined ? {}
          : { steerAnchor: structuredClone(row.steerAnchor) as { viewId: string; afterItemId?: string } }),
        ...(row.steerDispatchPlan === undefined ? {}
          : { steerDispatchPlan: structuredClone(row.steerDispatchPlan) as ConversationSteerPlan }),
        ...(row.steerAttempts === undefined ? {}
          : { steerAttempts: structuredClone(row.steerAttempts) as NonNullable<PersistedConversationDeliveryReceipt['steerAttempts']> }),
        acceptedAt: row.updatedAt as number,
        expiresAt: (row.receiptExpiresAt as number | undefined) ?? (row.updatedAt as number) + 86_400_000,
        status: 'accepted',
      });
      return null;
    }
    activeSubmissionKeys.add(key);
    return structuredClone(row) as unknown as PersistedConversationSubmission;
  }).filter((row): row is PersistedConversationSubmission => row !== null);
  if (root.deliveryReceipts !== undefined) {
    if (!Array.isArray(root.deliveryReceipts)) throw new Error('Corrupt Conversation delivery receipts');
    for (const candidate of root.deliveryReceipts) {
      const row = record(candidate);
      if (!row || !text(row.agentId, 64) || !text(row.sessionId, 1024)
        || !text(row.clientRequestId, 256)
        || typeof row.payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.payloadHash)
        || (row.baseline !== undefined && !validBaseline(row.baseline))
        || (row.nativeId !== undefined && !text(row.nativeId, 1024))
        || (row.canonicalObservedAt !== undefined && !time(row.canonicalObservedAt))
        || (row.steerActionId !== undefined && !text(row.steerActionId, 256))
        || (row.steerBaseRevision !== undefined && !integer(row.steerBaseRevision, 1))
        || (row.steerAnchor !== undefined && !validAnchor(row.steerAnchor))
        || (row.steerDispatchPlan !== undefined && !validSteerPlan(row.steerDispatchPlan))
        || (row.steerAttempts !== undefined && (!Array.isArray(row.steerAttempts)
          || row.steerAttempts.length > 8 || row.steerAttempts.some((attempt) => {
            const value = record(attempt);
            return !value || !text(value.actionId, 256) || !integer(value.baseRevision, 1)
              || !validAnchor(value.anchor) || value.result !== 'rejected';
          })))
        || (row.status !== undefined
          && !['dispatching', 'unknown', 'accepted'].includes(String(row.status)))
        || !time(row.acceptedAt) || !time(row.expiresAt)) {
        throw new Error('Corrupt Conversation delivery receipt');
      }
      deliveryReceipts.push(structuredClone(row) as unknown as PersistedConversationDeliveryReceipt);
    }
  }
  const receiptKeys = new Set<string>();
  for (const receipt of deliveryReceipts) {
    const key = `${receipt.agentId}\0${receipt.sessionId}\0${receipt.clientRequestId}`;
    if (receiptKeys.has(key)) throw new Error('Duplicate Conversation delivery receipt');
    if (activeSubmissionKeys.has(key)) {
      throw new Error('Conversation submission conflicts with delivery receipt');
    }
    receiptKeys.add(key);
  }
  const cycleKeys = new Set<string>();
  const cycles = root.cycles.map((candidate): PersistedConversationCycle => {
    const row = record(candidate);
    if (!row || !text(row.agentId, 64) || !text(row.sessionId, 1024)
      || !['closed', 'dispatching', 'awaiting_non_idle', 'awaiting_idle', 'unknown'].includes(String(row.state))
      || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
      || !text(row.activityEpoch, 256) || !Number.isSafeInteger(row.baselineRevision)
      || Number(row.baselineRevision) < 0
      || (row.baselineCompletionToken !== undefined
        && !text(row.baselineCompletionToken, 1024))
      || (row.ownerSubmissionId !== undefined && !text(row.ownerSubmissionId, 256))
      || (row.nonIdleRevision !== undefined && !integer(row.nonIdleRevision))
      || (row.closedIdleRevision !== undefined && !integer(row.closedIdleRevision))) {
      throw new Error('Corrupt Conversation dispatch cycle');
    }
    if ((row.state === 'closed' && row.ownerSubmissionId !== undefined)
      || (row.state === 'dispatching' && row.ownerSubmissionId === undefined)
      || (row.state === 'awaiting_idle' && row.nonIdleRevision === undefined)
      || ((row.state === 'dispatching' || row.state === 'awaiting_non_idle')
        && row.nonIdleRevision !== undefined)
      || ((row.state === 'dispatching' || row.state === 'awaiting_non_idle')
        && row.closedIdleRevision !== undefined)
      || (row.nonIdleRevision !== undefined && Number(row.nonIdleRevision) < Number(row.baselineRevision))) {
      throw new Error('Conversation dispatch cycle fields do not match its state');
    }
    const key = `${row.agentId}\0${row.sessionId}`;
    if (cycleKeys.has(key)) throw new Error('Duplicate Conversation dispatch cycle');
    cycleKeys.add(key);
    return structuredClone(row) as unknown as PersistedConversationCycle;
  });
  for (const cycle of cycles) {
    if (!cycle.ownerSubmissionId) continue;
    if (!submissions.some((submission) => submission.agentId === cycle.agentId
      && submission.sessionId === cycle.sessionId
      && submission.clientRequestId === cycle.ownerSubmissionId)) {
      const ownerKey = `${cycle.agentId}\0${cycle.sessionId}\0${cycle.ownerSubmissionId}`;
      const settled = retiredTerminalKeys.has(ownerKey) || deliveryReceipts.some((receipt) => (
        receipt.agentId === cycle.agentId && receipt.sessionId === cycle.sessionId
        && receipt.clientRequestId === cycle.ownerSubmissionId
      ));
      if (!settled) throw new Error('Conversation dispatch cycle owner is missing');
      delete cycle.ownerSubmissionId;
      if (cycle.state === 'dispatching') cycle.state = 'unknown';
    }
  }
  const maximumRevision = Math.max(0, ...submissions.map((row) => row.revision),
    ...cycles.map((row) => row.revision));
  if (Number(root.ledgerRevision) < maximumRevision) {
    throw new Error('Conversation ledger revision is behind its records');
  }
  const state: PersistedConversationStateV2 = {
    version: 2,
    ledgerRevision: root.ledgerRevision as number,
    submissions,
    deliveryReceipts,
    cycles,
  };
  if (root.legacySends !== undefined) state.legacySends = parseLegacySends(root.legacySends);
  if (root.migrations !== undefined) {
    const migrations = record(root.migrations);
    if (!migrations) throw new Error('Corrupt Conversation migrations');
    const marker = record(migrations.legacyCodexOutboxImported);
    if (migrations.legacyCodexOutboxImported !== undefined && !marker) {
      throw new Error('Corrupt Conversation migration marker');
    }
    if (marker && (typeof marker.fingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(marker.fingerprint)
      || !Array.isArray(marker.submissionIds)
      || marker.submissionIds.some((id) => !text(id, 256))
      || (marker.submissionKeys !== undefined && (!Array.isArray(marker.submissionKeys)
        || marker.submissionKeys.some((key) => !text(key, 1400))))
      || !time(marker.importedAt))) throw new Error('Corrupt Conversation migration marker');
    state.migrations = structuredClone(migrations) as NonNullable<PersistedConversationStateV2['migrations']>;
  }
  return state;
}

export interface ConversationStateStore {
  load(): unknown;
  save(state: AnyPersistedConversationState): void;
}

export class MemoryConversationStateStore implements ConversationStateStore {
  #state: AnyPersistedConversationState | null = null;

  load(): unknown {
    return this.#state ? structuredClone(this.#state) : null;
  }

  save(state: AnyPersistedConversationState): void {
    this.#state = structuredClone(state);
  }
}

export class FileConversationStateStore implements ConversationStateStore {
  readonly #store: PrivateStateStore<AnyPersistedConversationState>;

  constructor(file: string) {
    this.#store = new PrivateStateStore(file);
  }

  load(): unknown {
    return this.#store.readStrict();
  }

  save(state: AnyPersistedConversationState): void {
    this.#store.write(state);
  }
}
