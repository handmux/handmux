import { useCallback, useEffect, useRef, useState } from 'react';
import {
  conversationPermissionAction,
  conversationGoalAction,
  conversationQueueAction,
  executeConversationCommand,
  readConversationControls,
} from '../agentConversationControlsApi.js';
import type {
  ConversationCommand,
  ConversationPermissionSnapshot,
  ConversationControlsSnapshot,
  ConversationGoal,
  ConversationPermissionMode,
  ConversationQueueEditLease,
  ConversationSubmissionActionResult,
} from '../agentConversationControlsApi.js';
import type { AgentRunRef } from '../agentCatalog.js';
import { UnauthorizedError } from '../apiErrors.js';

export interface AgentConversationControlsController {
  status: 'idle' | 'loading' | 'ready' | 'degraded' | 'error';
  error: string | null;
  snapshot: ConversationControlsSnapshot | null;
  busy: boolean;
  refresh(): Promise<void>;
  queueAction(
    action: 'steer' | 'remove' | 'begin_edit' | 'renew_edit' | 'commit_edit' | 'cancel_edit',
    itemId: string,
    options?: {
      token?: string;
      text?: string;
      actionId?: string;
      baseRevision?: number;
      anchor?: { viewId: string; afterItemId?: string };
    },
  ): Promise<ConversationQueueEditLease | ConversationSubmissionActionResult | null>;
  goalAction(
    action: 'start' | 'update' | 'clear',
    options?: { objective?: string; status?: 'active' | 'paused' },
  ): Promise<ConversationGoal | null>;
  setPermission(mode: Exclude<ConversationPermissionMode, 'custom'>): Promise<ConversationPermissionSnapshot>;
  command(command: ConversationCommand): Promise<void>;
}

const errorMessage = (error: unknown): string => (
  error instanceof Error && error.message ? error.message : 'Conversation controls unavailable'
);

const controlsIdentity = (run: AgentRunRef | null): string | null => (
  run?.sessionId ? `${run.agentId}\0${run.sessionId}` : null
);

export function useAgentConversationControls(
  run: AgentRunRef | null,
  enabled: boolean,
  onAuthFail?: () => void,
): AgentConversationControlsController {
  const [status, setStatus] = useState<AgentConversationControlsController['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ConversationControlsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const runRef = useRef(run);
  const authRef = useRef(onAuthFail);
  const generation = useRef(0);
  const snapshotRef = useRef<ConversationControlsSnapshot | null>(null);
  const snapshotIdentityRef = useRef<string | null>(null);
  const failures = useRef(0);
  const operation = useRef<symbol | null>(null);
  runRef.current = run;
  authRef.current = onAuthFail;
  snapshotRef.current = snapshot;

  const load = useCallback(async (signal?: AbortSignal, force = false): Promise<void> => {
    const active = runRef.current;
    if (!active || (operation.current !== null && !force)) return;
    const requestGeneration = generation.current;
    if (!snapshotRef.current) setStatus('loading');
    try {
      const next = await readConversationControls(active, signal);
      if (generation.current !== requestGeneration || runRef.current?.runId !== active.runId
        || (operation.current !== null && !force)) return;
      failures.current = 0;
      const previous = snapshotRef.current;
      const merged: ConversationControlsSnapshot = { ...next };
      if (previous && next.slotErrors) {
        if (next.slotErrors.queue) {
          if ('queue' in previous) merged.queue = previous.queue!;
          else delete merged.queue;
        }
        if (next.slotErrors.goal) {
          if ('goal' in previous) merged.goal = previous.goal!;
          else delete merged.goal;
          if ('goalActions' in previous) merged.goalActions = previous.goalActions!;
          else delete merged.goalActions;
        }
        if (next.slotErrors.plan) {
          if ('plan' in previous) merged.plan = previous.plan!;
          else delete merged.plan;
        }
        if (next.slotErrors.context) {
          if ('context' in previous) merged.context = previous.context!;
          else delete merged.context;
        }
        if (next.slotErrors.permission) {
          if ('permission' in previous) merged.permission = previous.permission!;
          else delete merged.permission;
          if ('permissionCanUpdate' in previous) {
            merged.permissionCanUpdate = previous.permissionCanUpdate!;
          } else delete merged.permissionCanUpdate;
        }
        if (next.slotErrors.commands) {
          if ('commands' in previous) merged.commands = previous.commands!;
          else delete merged.commands;
        }
      }
      snapshotRef.current = merged;
      snapshotIdentityRef.current = controlsIdentity(active);
      setSnapshot(merged);
      const slotMessages = Object.values(next.slotErrors ?? {});
      setStatus(slotMessages.length ? 'degraded' : 'ready');
      setError(slotMessages.length ? 'Conversation controls are partially unavailable' : null);
    } catch (cause) {
      if (signal?.aborted || generation.current !== requestGeneration
        || runRef.current?.runId !== active.runId) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
      failures.current += 1;
      setError(errorMessage(cause));
      setStatus(snapshotRef.current && failures.current < 3 ? 'degraded' : 'error');
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    failures.current = 0;
    operation.current = null;
    snapshotRef.current = null;
    snapshotIdentityRef.current = null;
    setSnapshot(null);
    setError(null);
    setBusy(false);
    if (!enabled || !run) {
      setStatus('idle');
      return undefined;
    }
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      await load(controller.signal);
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 750);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      generation.current += 1;
    };
  }, [enabled, load, run?.runId]);

  const mutate = useCallback(async <T,>(work: (active: AgentRunRef) => Promise<T>): Promise<T> => {
    const active = runRef.current;
    if (!active || operation.current !== null) throw new Error('Conversation controls unavailable');
    const requestGeneration = generation.current;
    const operationToken = Symbol('conversation-control-operation');
    operation.current = operationToken;
    setBusy(true);
    setError(null);
    try {
      const result = await work(active);
      if (generation.current === requestGeneration && runRef.current?.runId === active.runId) {
        await load(undefined, true);
      }
      return result;
    } catch (cause) {
      if (cause instanceof UnauthorizedError) authRef.current?.();
      if (generation.current === requestGeneration && runRef.current?.runId === active.runId) {
        setError(errorMessage(cause));
      }
      throw cause;
    } finally {
      if (operation.current === operationToken) operation.current = null;
      if (generation.current === requestGeneration && runRef.current?.runId === active.runId) setBusy(false);
    }
  }, [load]);

  const stateMatchesIdentity = snapshotIdentityRef.current === controlsIdentity(run);
  return {
    status: stateMatchesIdentity ? status : enabled && run ? 'loading' : 'idle',
    error: stateMatchesIdentity ? error : null,
    snapshot: stateMatchesIdentity ? snapshot : null,
    busy: stateMatchesIdentity && busy,
    refresh: () => load(),
    queueAction: (action, itemId, options = {}) => mutate((active) => conversationQueueAction(active, {
      action, itemId, ...options,
    })),
    goalAction: (action, options = {}) => mutate((active) => conversationGoalAction(active, {
      action, ...options,
    })),
    setPermission: (permissionMode) => mutate((active) => conversationPermissionAction(active, {
      action: 'set_permission', permissionMode,
    })),
    command: (command) => mutate((active) => executeConversationCommand(active, command)),
  };
}
