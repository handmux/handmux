import os from 'node:os';
import path from 'node:path';
import type {
  BridgeHostChannelHandle,
  BridgeHostEvent,
  LocalAgentBridgeHost,
} from '../agent-runtime/bridgeTypes.js';
import type {
  AgentConversationAdapterV1,
  ConversationAdapterEvent,
  ConversationAdapterEventSink,
  ConversationItem,
  ConversationItemDraft,
  ConversationDispatchReceipt,
  ConversationPromptRequest,
  ConversationReason,
  ConversationSteerRequest,
  InterruptReceipt,
} from '../agent-runtime/conversationTypes.js';
import type { AgentRunLease, AgentRunRef, AgentSessionRef } from '../agent-runtime/run.js';
import type { AgentConversationActivityReader } from '../agent-runtime/conversationActivity.js';
import { PiConversationHistory } from './piConversationHistory.js';
import {
  sanitizeConversationToolDraft,
  sanitizeConversationToolItem,
} from './conversationProjectionSafety.js';

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const LEAF_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const CURRENT_PI_IMPLEMENTATION_VERSION = 6;
const MIN_MUTATION_COMPATIBLE_PI_IMPLEMENTATION_VERSION = 4;
const MIN_STEER_COMPATIBLE_PI_IMPLEMENTATION_VERSION = 6;
const MAX_SNAPSHOT_ACTIVE_TOOLS = 256;

type PiConversationBridgePayload =
  | { type: 'stream.gap' }
  | { type: 'item.opened'; provisionalId: string; draft: ConversationItemDraft }
  | { type: 'item.delta'; provisionalId: string; delta: unknown }
  | { type: 'tool_result.delta_ignored'; provisionalId: string }
  | { type: 'item.settled'; provisionalId: string; durableItemId?: string; item?: ConversationItem }
  | {
    type: 'item.cancelled'; provisionalId: string;
    reason?: 'interrupted' | 'superseded' | 'provider_error' | 'stream_reset';
  }
  | { type: 'history.changed'; leafId: string; viewId: string };

type WithoutSourceSequence<T> = T extends unknown ? Omit<T, 'sourceSequence'> : never;
type ConversationAdapterEventBody = WithoutSourceSequence<ConversationAdapterEvent>;

interface PiConversationSnapshot {
  implementationVersion: number;
  sessionId: string;
  leafId: string;
  viewId: string;
  sessionFile?: string;
  pendingItems?: ConversationItem[];
  activeTools?: PiSnapshotActiveTool[];
}

interface PiSnapshotActiveTool {
  provisionalId: string;
  draft: ConversationItemDraft;
  committedLeafId?: string;
  settlement?: {
    durableItemId: string;
    item: ConversationItem;
  };
}

export interface PiConversationAdapterOptions {
  host: LocalAgentBridgeHost;
  history?: PiConversationHistory;
  sessionsRoot?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRun(target: AgentSessionRef | AgentRunRef): target is AgentRunRef {
  return 'runId' in target;
}

function snapshotActiveTool(value: unknown): PiSnapshotActiveTool | null {
  if (!isRecord(value) || typeof value.provisionalId !== 'string'
    || !ID_RE.test(value.provisionalId) || !isRecord(value.draft)
    || value.draft.kind !== 'tool_call' || typeof value.draft.callId !== 'string'
    || !ID_RE.test(value.draft.callId) || typeof value.draft.name !== 'string'
    || value.draft.name.length === 0 || value.draft.name.length > 256) return null;
  let settlement: PiSnapshotActiveTool['settlement'];
  if (value.settlement !== undefined) {
    if (!isRecord(value.settlement) || typeof value.settlement.durableItemId !== 'string'
      || !ID_RE.test(value.settlement.durableItemId) || !isRecord(value.settlement.item)) return null;
    settlement = {
      durableItemId: value.settlement.durableItemId,
      item: sanitizeConversationToolItem(value.settlement.item as unknown as ConversationItem),
    };
  }
  if (value.committedLeafId !== undefined && (typeof value.committedLeafId !== 'string'
    || !LEAF_RE.test(value.committedLeafId) || settlement === undefined)) return null;
  return {
    provisionalId: value.provisionalId,
    draft: sanitizeConversationToolDraft(value.draft as unknown as ConversationItemDraft),
    ...(settlement === undefined ? {} : { settlement }),
    ...(value.committedLeafId === undefined ? {} : { committedLeafId: value.committedLeafId }),
  };
}

function snapshot(value: unknown, sessionId: string): PiConversationSnapshot | null {
  if (!isRecord(value) || value.sessionId !== sessionId
    || typeof value.leafId !== 'string' || !LEAF_RE.test(value.leafId)
    || typeof value.viewId !== 'string' || !ID_RE.test(value.viewId)
    || (value.implementationVersion !== undefined
      && (!Number.isSafeInteger(value.implementationVersion)
        || (value.implementationVersion as number) <= 0))
    || (value.sessionFile !== undefined && (typeof value.sessionFile !== 'string'
      || !path.isAbsolute(value.sessionFile) || value.sessionFile.length > 4096))
    || (value.pendingItems !== undefined && !Array.isArray(value.pendingItems))
    || (value.activeTools !== undefined && (!Array.isArray(value.activeTools)
      || value.activeTools.length > MAX_SNAPSHOT_ACTIVE_TOOLS))) return null;
  const activeTools = value.activeTools === undefined ? undefined
    : value.activeTools.map(snapshotActiveTool);
  if (activeTools?.some((tool) => tool === null)) return null;
  const parsedActiveTools = activeTools as PiSnapshotActiveTool[] | undefined;
  if (parsedActiveTools
    && new Set(parsedActiveTools.map((tool) => tool.provisionalId)).size !== parsedActiveTools.length) {
    return null;
  }
  return {
    // Missing means a pre-handshake Connector. It remains readable, but discovery marks it as stale
    // and disables broken send controls until the user runs Pi's documented `/reload` command.
    implementationVersion: value.implementationVersion === undefined
      ? 1 : value.implementationVersion as number,
    sessionId, leafId: value.leafId, viewId: value.viewId,
    ...(value.sessionFile === undefined ? {} : { sessionFile: value.sessionFile }),
    ...(value.pendingItems === undefined ? {} : {
      pendingItems: (value.pendingItems as ConversationItem[]).map(sanitizeConversationToolItem),
    }),
    ...(parsedActiveTools === undefined ? {} : { activeTools: parsedActiveTools }),
  };
}

function payload(value: unknown): PiConversationBridgePayload | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'stream.gap') return { type: value.type };
  if (value.type === 'history.changed') {
    return typeof value.leafId === 'string' && LEAF_RE.test(value.leafId)
      && typeof value.viewId === 'string' && ID_RE.test(value.viewId)
      ? { type: value.type, leafId: value.leafId, viewId: value.viewId } : null;
  }
  if (!ID_RE.test(String(value.provisionalId))) return null;
  const provisionalId = value.provisionalId as string;
  if (value.type === 'item.opened' && isRecord(value.draft)) {
    return {
      type: value.type, provisionalId,
      draft: sanitizeConversationToolDraft(value.draft as unknown as ConversationItemDraft),
    };
  }
  if (value.type === 'item.delta' && isRecord(value.delta)) {
    if (value.delta.op === 'text.append' && value.delta.target === 'tool_result.content') {
      // Sanitizing chunks independently is unsafe: a credential or absolute path can span chunks.
      // Keep the running provisional and wait for a complete sanitized replace/settlement.
      return { type: 'tool_result.delta_ignored', provisionalId };
    }
    const delta = value.delta.op === 'item.replace' && isRecord(value.delta.draft)
      ? {
        ...value.delta,
        draft: sanitizeConversationToolDraft(value.delta.draft as unknown as ConversationItemDraft),
      }
      : value.delta;
    return { type: value.type, provisionalId, delta };
  }
  if (value.type === 'item.settled') {
    if (value.durableItemId !== undefined && !ID_RE.test(String(value.durableItemId))) return null;
    if (value.item !== undefined && !isRecord(value.item)) return null;
    return {
      type: value.type,
      provisionalId,
      ...(value.durableItemId === undefined ? {} : { durableItemId: value.durableItemId as string }),
      ...(value.item === undefined ? {} : {
        item: sanitizeConversationToolItem(value.item as unknown as ConversationItem),
      }),
    };
  }
  if (value.type === 'item.cancelled') {
    const reasons = ['interrupted', 'superseded', 'provider_error', 'stream_reset'];
    if (value.reason !== undefined && !reasons.includes(String(value.reason))) return null;
    return {
      type: value.type,
      provisionalId,
      ...(value.reason === undefined ? {} : {
        reason: value.reason as 'interrupted' | 'superseded' | 'provider_error' | 'stream_reset',
      }),
    };
  }
  return null;
}

const PI_SEND_REASONS: Readonly<Record<string, ConversationReason>> = Object.freeze({
  invalid_request: 'invalid_request',
  unsupported: 'unsupported',
  unsupported_delivery: 'unsupported',
  stale_run: 'stale_run',
  conflict: 'conflict',
  agent_busy: 'temporarily_unavailable',
  provider_rejected: 'provider_rejected',
  temporarily_unavailable: 'temporarily_unavailable',
  delivery_unconfirmed: 'delivery_unconfirmed',
  native_delivery_unconfirmed: 'delivery_unconfirmed',
});

function dispatchReceipt(value: unknown): ConversationDispatchReceipt {
  if (!isRecord(value) || !['accepted', 'queued', 'rejected', 'unknown'].includes(String(value.status))) {
    return { outcome: 'unknown', nativeMutation: 'unknown', reason: 'delivery_unconfirmed' };
  }
  const status = value.status as 'accepted' | 'queued' | 'rejected' | 'unknown';
  if (status === 'accepted' || status === 'queued') return {
    outcome: 'accepted',
    ...(typeof value.nativeId === 'string' && value.nativeId ? { nativeId: value.nativeId } : {}),
  };
  if (status === 'rejected' && value.reason === 'agent_busy') {
    return { outcome: 'busy', nativeMutation: false };
  }
  const reason = value.reason === undefined
    ? undefined : typeof value.reason === 'string' && value.reason
      ? PI_SEND_REASONS[value.reason] ?? (status === 'rejected'
        ? 'provider_rejected' : 'delivery_unconfirmed')
      : status === 'rejected' ? 'provider_rejected' : 'delivery_unconfirmed';
  if (status === 'rejected') return {
    outcome: 'rejected', nativeMutation: false, reason: reason ?? 'provider_rejected',
  };
  return { outcome: 'unknown', nativeMutation: 'unknown', reason: reason ?? 'delivery_unconfirmed' };
}

function interruptReceipt(value: unknown): InterruptReceipt {
  if (!isRecord(value) || !['accepted', 'rejected', 'unknown'].includes(String(value.status))) {
    return { status: 'unknown', reason: 'temporarily_unavailable' };
  }
  const status = value.status as InterruptReceipt['status'];
  const reason = status === 'accepted' || value.reason === undefined
    ? undefined : typeof value.reason === 'string' && value.reason
      && PI_SEND_REASONS[value.reason]
      ? PI_SEND_REASONS[value.reason] : 'temporarily_unavailable';
  return {
    status,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function createPiConversationActivityReader(
  host: LocalAgentBridgeHost,
): AgentConversationActivityReader {
  return {
    async read(run) {
      const value = await host.request(run, 'conversation', 'activity', {});
      if (!isRecord(value) || !['idle', 'working', 'waiting', 'compacting', 'unknown']
        .includes(String(value.activity))) return { activity: 'unknown', activeTurn: { state: 'unknown' } };
      const active = isRecord(value.activeTurn) ? value.activeTurn : {};
      return {
        activity: value.activity as 'idle' | 'working' | 'waiting' | 'compacting' | 'unknown',
        activeTurn: active.state === 'active' && typeof active.nativeTurnId === 'string'
          ? { state: 'active', nativeTurnId: active.nativeTurnId }
          : active.state === 'none' ? { state: 'none' } : { state: 'unknown' },
        ...(typeof value.completionToken === 'string' && value.completionToken
          ? { completionToken: value.completionToken } : {}),
      };
    },
  };
}

export function createPiConversationAdapter({
  host,
  sessionsRoot,
  history = new PiConversationHistory({
    sessionsRoot: sessionsRoot ?? path.join(os.homedir(), '.pi', 'agent', 'sessions'),
  }),
}: PiConversationAdapterOptions): AgentConversationAdapterV1 {
  if (!host || typeof host.openChannel !== 'function' || typeof host.request !== 'function') {
    throw new TypeError('Pi Conversation adapter requires LocalAgentBridgeHost');
  }

  return {
    apiVersion: 1,
    async discoverNative(target) {
      if (target.agentId !== 'pi' || !target.sessionId) return null;
      if (isRun(target)) history.beginLive(target.sessionId, target.runId);
      const discovered = await history.discover(target.sessionId);
      if (!discovered) return null;
      const implementationVersion = isRun(target)
        ? target.implementationVersion : discovered.implementationVersion;
      const reloadRequired = isRun(target)
        && (implementationVersion ?? 1) < CURRENT_PI_IMPLEMENTATION_VERSION;
      const mutationCompatible = isRun(target)
        && (implementationVersion ?? 1) >= MIN_MUTATION_COMPATIBLE_PI_IMPLEMENTATION_VERSION;
      const steerCompatible = isRun(target)
        && (implementationVersion ?? 1) >= MIN_STEER_COMPATIBLE_PI_IMPLEMENTATION_VERSION;
      return {
        session: { agentId: 'pi', sessionId: target.sessionId },
        ...(isRun(target) ? { run: target } : {}),
        sourceViewId: discovered.sourceViewId,
        capabilities: mutationCompatible ? {
          history: true, live: 'delta',
          sendable: true, send: ['prompt'], interrupt: true, branching: true,
          ...(steerCompatible ? { steer: true } : {}),
        } : isRun(target)
          ? { history: true, live: 'delta', branching: true }
          : { history: true, live: 'poll', branching: true },
        ...(isRun(target) ? {
          implementation: {
            version: implementationVersion ?? 1,
            ...(reloadRequired ? { reloadRequired: true as const } : {}),
          },
        } : {}),
      };
    },
    readNativePage: (session, request) => history.readPage(session, request),
    async observeNative(run: AgentRunLease, sink: ConversationAdapterEventSink) {
      const sessionId = run.ref.sessionId;
      if (!sessionId) throw new Error('Pi run has no session');
      history.beginLive(sessionId, run.ref.runId);
      let phase: 'opening' | 'live' | 'closed' = 'opening';
      let handle: BridgeHostChannelHandle | undefined;
      let bridgeSequence = 0;
      let sourceSequence = 0;
      let activeLeaf = '';
      let activeView = '';
      let snapshotToolIds = new Set<string>();
      const recoverableToolIds = new Set<string>();
      const provisionalLifecycle = new Map<string, 'open' | 'settled' | 'cancelled'>();
      const buffered: BridgeHostEvent[] = [];
      let tail = Promise.resolve();

      const emit = async (
        operation: ConversationAdapterEventBody,
      ): Promise<void> => {
        await sink({ ...operation, sourceSequence: ++sourceSequence } as ConversationAdapterEvent);
      };

      const acceptOperation = async (operation: PiConversationBridgePayload): Promise<void> => {
        if (operation.type === 'tool_result.delta_ignored') return;
        if (operation.type === 'item.opened') {
          const lifecycle = provisionalLifecycle.get(operation.provisionalId);
          if (lifecycle !== undefined && recoverableToolIds.has(operation.provisionalId)) return;
          provisionalLifecycle.set(operation.provisionalId, 'open');
        } else if (operation.type === 'item.settled') {
          const lifecycle = provisionalLifecycle.get(operation.provisionalId);
          if ((lifecycle === 'settled' || lifecycle === 'cancelled')
            && recoverableToolIds.has(operation.provisionalId)) return;
          provisionalLifecycle.set(operation.provisionalId, 'settled');
        } else if (operation.type === 'item.cancelled') {
          const lifecycle = provisionalLifecycle.get(operation.provisionalId);
          if ((lifecycle === 'settled' || lifecycle === 'cancelled')
            && recoverableToolIds.has(operation.provisionalId)) return;
          provisionalLifecycle.set(operation.provisionalId, 'cancelled');
        }
        await emit(operation as ConversationAdapterEventBody);
      };

      const restoreSnapshotTools = async (
        tools: readonly PiSnapshotActiveTool[], historyLeaf: string,
        historicalToolCallIds: ReadonlySet<string> = new Set(),
      ): Promise<void> => {
        snapshotToolIds = new Set(tools.map((tool) => tool.provisionalId));
        for (const tool of tools) {
          recoverableToolIds.add(tool.provisionalId);
          const lifecycle = provisionalLifecycle.get(tool.provisionalId);
          if (lifecycle === undefined) {
            // The Connector keeps a committed tombstone until the next native turn so a live
            // observer can finish its provisional before history advances. A fresh observer already
            // reads that leaf from history and must not recreate the completed tool beside it.
            if (tool.settlement && (tool.committedLeafId === historyLeaf
              || (tool.draft.kind === 'tool_call'
                && historicalToolCallIds.has(tool.draft.callId)))) {
              provisionalLifecycle.set(tool.provisionalId, 'settled');
              continue;
            }
            provisionalLifecycle.set(tool.provisionalId, 'open');
            await emit({
              type: 'item.opened', provisionalId: tool.provisionalId, draft: tool.draft,
            });
          }
          if (tool.settlement && provisionalLifecycle.get(tool.provisionalId) === 'open') {
            provisionalLifecycle.set(tool.provisionalId, 'settled');
            await emit({
              type: 'item.settled', provisionalId: tool.provisionalId,
              durableItemId: tool.settlement.durableItemId,
              item: tool.settlement.item,
            });
          }
        }
      };

      const reconcileToolsBeforeHistory = async (): Promise<void> => {
        for (const provisionalId of recoverableToolIds) {
          if (snapshotToolIds.has(provisionalId)
            || provisionalLifecycle.get(provisionalId) !== 'open') continue;
          provisionalLifecycle.set(provisionalId, 'cancelled');
          await emit({ type: 'item.cancelled', provisionalId, reason: 'superseded' });
        }
      };

      const emitGap = async (): Promise<void> => {
        const afterSourceSequence = sourceSequence;
        await emit({ type: 'stream.gap', afterSourceSequence });
      };

      const process = async (event: BridgeHostEvent): Promise<void> => {
        if (phase === 'closed') return;
        if (event.type === 'gap') {
          bridgeSequence = Math.max(bridgeSequence, event.afterSequence);
          await emitGap();
          return;
        }
        if (event.type === 'snapshot') {
          const next = snapshot(event.value, sessionId);
          if (!next || event.sequence <= bridgeSequence) throw new Error('Invalid Pi Conversation snapshot');
          bridgeSequence = event.sequence;
          const sameView = next.viewId === activeView;
          const sameLeaf = next.leafId === activeLeaf;
          const previousHistoryToken = sameView && sameLeaf
            ? (await history.readPage({ agentId: 'pi', sessionId }, { limit: 1 })).sourceHistoryToken
            : undefined;
          history.setLiveSnapshot(sessionId, run.ref.runId, next.leafId, {
            ...(next.sessionFile === undefined ? {} : { sessionFile: next.sessionFile }),
            implementationVersion: next.implementationVersion,
            ...(next.pendingItems === undefined ? {} : { items: next.pendingItems }),
          }, next.viewId !== activeView ? next.viewId : undefined);
          if (next.viewId !== activeView) {
            activeLeaf = next.leafId;
            activeView = next.viewId;
            await emitGap();
          } else if (next.leafId !== activeLeaf) {
            if (next.activeTools) await restoreSnapshotTools(next.activeTools, next.leafId);
            activeLeaf = next.leafId;
            const page = await history.readPage({ agentId: 'pi', sessionId }, { limit: 1 });
            if (next.activeTools) await reconcileToolsBeforeHistory();
            await emit({
              type: 'history.committed',
              sourceViewId: page.sourceViewId, sourceHistoryToken: page.sourceHistoryToken,
            });
          } else {
            if (next.activeTools) await restoreSnapshotTools(next.activeTools, next.leafId);
            const page = await history.readPage({ agentId: 'pi', sessionId }, { limit: 1 });
            if (page.sourceHistoryToken !== previousHistoryToken) {
              if (next.activeTools) await reconcileToolsBeforeHistory();
              await emit({
                type: 'history.committed',
                sourceViewId: page.sourceViewId, sourceHistoryToken: page.sourceHistoryToken,
              });
            }
          }
          return;
        }
        if (event.event.sequence <= bridgeSequence) throw new Error('Pi Conversation event is out of order');
        bridgeSequence = event.event.sequence;
        const operation = payload(event.event.payload);
        if (!operation) throw new Error('Invalid Pi Conversation event');
        if (operation.type === 'stream.gap') {
          await emitGap();
          return;
        }
        if (operation.type === 'history.changed') {
          history.setLiveSnapshot(
            sessionId, run.ref.runId, operation.leafId, {},
            operation.viewId !== activeView ? operation.viewId : undefined,
          );
          activeLeaf = operation.leafId;
          if (operation.viewId !== activeView) {
            activeView = operation.viewId;
            await emitGap();
            return;
          }
          const page = await history.readPage({ agentId: 'pi', sessionId }, { limit: 1 });
          await reconcileToolsBeforeHistory();
          await emit({
            type: 'history.committed',
            sourceViewId: page.sourceViewId, sourceHistoryToken: page.sourceHistoryToken,
          });
          return;
        }
        await acceptOperation(operation);
      };

      const failClosed = async (): Promise<void> => {
        if (phase === 'closed') return;
        try {
          await emitGap();
        } catch { /* Core may already have closed the stream */ }
        handle?.close();
        phase = 'closed';
      };

      handle = await host.openChannel(run, 'conversation', (event) => {
        if (phase === 'opening') { buffered.push(structuredClone(event)); return; }
        tail = tail.then(() => process(event)).catch(failClosed);
        return tail;
      });
      if (handle.snapshotAvailability !== 'ready') {
        handle.close();
        throw new Error('Pi Conversation snapshot is unavailable');
      }
      const baseline = snapshot(handle.snapshot, sessionId);
      if (!baseline) {
        handle.close();
        throw new Error('Pi Conversation snapshot is invalid');
      }
      history.setLiveSnapshot(sessionId, run.ref.runId, baseline.leafId, {
        ...(baseline.sessionFile === undefined ? {} : { sessionFile: baseline.sessionFile }),
        implementationVersion: baseline.implementationVersion,
        ...(baseline.pendingItems === undefined ? {} : { items: baseline.pendingItems }),
      });
      activeLeaf = baseline.leafId;
      activeView = baseline.viewId;
      bridgeSequence = handle.streamSequence;
      const discovered = await history.discover(sessionId);
      if (!discovered) {
        handle.close();
        throw new Error('Pi Conversation snapshot is not readable yet');
      }
      // A durability wait may time out just before Pi flushes JSONL. On a later observation the
      // Connector snapshot can still contain an uncommitted settlement even though native history
      // already owns that call. Read the authoritative branch once and suppress only those settled
      // synthetic tools whose callId is now present there; running tools always remain provisional.
      const openingHistory = await history.readPage(
        { agentId: 'pi', sessionId }, { limit: Number.MAX_SAFE_INTEGER },
      );
      const historicalToolCallIds = new Set(openingHistory.items.flatMap((item) => (
        item.kind === 'tool_call' ? [item.callId] : []
      )));
      if (baseline.activeTools) {
        await restoreSnapshotTools(baseline.activeTools, baseline.leafId, historicalToolCallIds);
      }
      phase = 'live';
      for (const event of buffered.splice(0)) {
        if (event.type === 'event' && event.event.sequence <= bridgeSequence) continue;
        if (event.type === 'snapshot' && event.sequence <= bridgeSequence) continue;
        tail = tail.then(() => process(event));
      }
      tail = tail.catch(failClosed);
      return {
        checkpoint: {
          sourceViewId: discovered.sourceViewId,
          // Snapshot-restored provisional items are opening suffix events, not part of history.
          // Returning zero lets Conversation Core apply any number of them without inventing source
          // sequence values that could collide with the next Bridge operation.
          sourceSequence: 0,
        },
        close() {
          if (phase === 'closed') return;
          phase = 'closed';
          buffered.splice(0);
          handle?.close();
        },
      };
    },
    async dispatchPrompt(run: AgentRunLease, request: ConversationPromptRequest) {
      const response = await host.request(run, 'conversation', 'send', {
        clientRequestId: request.clientRequestId,
        text: request.text,
        delivery: 'prompt',
      });
      return dispatchReceipt(response);
    },
    async dispatchSteer(run: AgentRunLease, request: ConversationSteerRequest) {
      if ((run.ref.implementationVersion ?? 1) < MIN_STEER_COMPATIBLE_PI_IMPLEMENTATION_VERSION) {
        return { outcome: 'rejected', nativeMutation: false, reason: 'unsupported' };
      }
      const response = await host.request(run, 'conversation', 'send', {
        clientRequestId: request.clientRequestId,
        text: request.text,
        origin: 'steer',
        delivery: request.plan.kind === 'steer-active-turn' ? 'steer' : 'prompt',
        plan: request.plan,
      });
      return dispatchReceipt(response);
    },
    async dispatchInterrupt(run: AgentRunLease) {
      return interruptReceipt(await host.request(run, 'conversation', 'interrupt', {}));
    },
  };
}
