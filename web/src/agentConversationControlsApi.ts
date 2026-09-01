import { requestJson } from './apiRequest.js';
import type { AgentRunRef } from './agentCatalog.js';
import type { ConversationSubmissionSnapshot } from './agentConversationTypes.js';

export interface ConversationQueueItem {
  id: string;
  text: string;
  createdAt: number;
  requestId?: string;
  editing?: true;
  state?: 'queued' | 'dispatching' | 'steering' | 'unknown';
  revision?: number;
  dispatchOrigin?: 'direct' | 'queue' | 'steer';
  autoDispatchBlockedReason?: 'provider_rejected';
}

export interface ConversationSettledReceipt {
  id: string;
  nativeId?: string;
}

export interface ConversationQueueSnapshot {
  items: ConversationQueueItem[];
  settled?: ConversationSettledReceipt[];
  canSteer: boolean;
  canEdit: boolean;
  canRemove: boolean;
}

export type ConversationActivity = 'idle' | 'working' | 'waiting' | 'compacting' | 'unknown';

export interface ConversationSubmissionActionResult {
  status: 'accepted' | 'rejected' | 'unknown';
  actionId?: string;
  submissionId?: string;
  revision?: number;
  nativeMutation?: true | false | 'unknown';
  submission?: ConversationSubmissionSnapshot;
}

export interface ConversationQueueEditLease {
  token: string;
  text: string;
  expiresAt?: number;
}

export interface ConversationGoal {
  objective: string;
  status: string;
  createdAt?: number;
  updatedAt?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  tokenBudget?: number | null;
}

export interface ConversationPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export interface ConversationPlanSnapshot {
  steps: ConversationPlanStep[];
  explanation?: string;
  turnId?: string;
  waiting?: boolean;
}

export type ConversationPermissionMode = 'default' | 'auto-review' | 'full-access' | 'custom';

export interface ConversationContextSnapshot {
  activity: ConversationActivity;
  usedTokens?: number;
  totalTokens?: number;
  cwd?: string;
  branch?: string;
  access?: 'read-only' | 'workspace-write' | 'full-access';
}

export interface ConversationPermissionSnapshot {
  mode: ConversationPermissionMode;
  options: Array<Exclude<ConversationPermissionMode, 'custom'>>;
}

export type ConversationCommand = 'compact' | 'clear';

export interface ConversationControlsSnapshot {
  activity?: ConversationActivity;
  submissions?: ConversationSubmissionSnapshot[];
  queue?: ConversationQueueSnapshot;
  goal?: ConversationGoal | null;
  goalActions?: Array<'start' | 'update' | 'clear'>;
  plan?: ConversationPlanSnapshot | null;
  context?: ConversationContextSnapshot | null;
  permission?: ConversationPermissionSnapshot | null;
  permissionCanUpdate?: boolean;
  commands?: ConversationCommand[];
  slotErrors?: Partial<Record<'queue' | 'goal' | 'plan' | 'context' | 'permission' | 'commands', string>>;
}

const record = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);
const text = (value: unknown, max = 4_096): string | undefined => (
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined
);
const finite = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
);

const revisionNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
);

function parseSubmission(value: unknown): ConversationSubmissionSnapshot | null {
  const item = record(value);
  const id = text(item?.id, 256);
  const content = text(item?.text, 262_144);
  const state = ['queued', 'dispatching', 'steering', 'unknown']
    .find((candidate) => candidate === item?.state);
  const revision = revisionNumber(item?.revision);
  const createdAt = finite(item?.createdAt);
  const updatedAt = finite(item?.updatedAt);
  const dispatchOrigin = item?.dispatchOrigin === undefined ? undefined
    : ['direct', 'queue', 'steer'].find((candidate) => candidate === item.dispatchOrigin);
  const nativeId = item?.nativeId === undefined ? undefined : text(item.nativeId, 1_024);
  const rawBaseline = item?.baseline === undefined ? undefined : record(item.baseline);
  const baselineViewId = rawBaseline === undefined ? undefined : text(rawBaseline?.viewId, 1_024);
  const baselineHistoryVersion = rawBaseline === undefined
    ? undefined : text(rawBaseline?.historyVersion, 1_024);
  const baselineTailItemId = rawBaseline?.tailItemId === undefined
    ? undefined : text(rawBaseline.tailItemId, 256);
  const autoDispatchBlockedReason = item?.autoDispatchBlockedReason === undefined ? undefined
    : item.autoDispatchBlockedReason === 'provider_rejected' ? 'provider_rejected' as const : null;
  const steerActionId = item?.steerActionId === undefined ? undefined : text(item.steerActionId, 256);
  const rawSteerAnchor = item?.steerAnchor === undefined ? undefined : record(item.steerAnchor);
  const steerAnchorViewId = rawSteerAnchor === undefined ? undefined : text(rawSteerAnchor?.viewId, 1_024);
  const steerAnchorAfterItemId = rawSteerAnchor?.afterItemId === undefined ? undefined
    : text(rawSteerAnchor.afterItemId, 1_024);
  const queueOrderKey = item?.queueOrderKey === undefined ? undefined : text(item.queueOrderKey, 256);
  if (!item || !id || !content || !state || revision === undefined || createdAt === undefined
    || updatedAt === undefined || (item.dispatchOrigin !== undefined && !dispatchOrigin)
    || (item.nativeId !== undefined && !nativeId)
    || (item.baseline !== undefined && (!rawBaseline || !baselineViewId || !baselineHistoryVersion
      || (rawBaseline.tailItemId !== undefined && !baselineTailItemId)))
    || autoDispatchBlockedReason === null
    || (item.steerActionId !== undefined && !steerActionId)
    || (item.steerAnchor !== undefined && (!rawSteerAnchor || !steerAnchorViewId
      || (rawSteerAnchor.afterItemId !== undefined && !steerAnchorAfterItemId)))
    || (item.queueOrderKey !== undefined && !queueOrderKey)) return null;
  return {
    id, text: content, state: state as ConversationSubmissionSnapshot['state'], revision,
    createdAt, updatedAt,
    ...(dispatchOrigin === undefined ? {} : {
      dispatchOrigin: dispatchOrigin as NonNullable<ConversationSubmissionSnapshot['dispatchOrigin']>,
    }),
    ...(nativeId === undefined ? {} : { nativeId }),
    ...(baselineViewId === undefined || baselineHistoryVersion === undefined ? {} : { baseline: {
      viewId: baselineViewId,
      historyVersion: baselineHistoryVersion,
      ...(baselineTailItemId === undefined ? {} : { tailItemId: baselineTailItemId }),
    } }),
    ...(autoDispatchBlockedReason === undefined ? {} : { autoDispatchBlockedReason }),
    ...(steerActionId === undefined ? {} : { steerActionId }),
    ...(steerAnchorViewId === undefined ? {} : { steerAnchor: {
      viewId: steerAnchorViewId,
      ...(steerAnchorAfterItemId === undefined ? {} : { afterItemId: steerAnchorAfterItemId }),
    } }),
    ...(queueOrderKey === undefined ? {} : { queueOrderKey }),
  };
}

function query(run: AgentRunRef): string {
  return new URLSearchParams({
    agentId: run.agentId, paneId: run.paneId, runId: run.runId,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
  }).toString();
}

function parseQueue(value: unknown): ConversationQueueSnapshot | null {
  const root = record(value);
  if (!root || !Array.isArray(root.items) || root.items.length > 1_000
    || (root.settled !== undefined
      && (!Array.isArray(root.settled) || root.settled.length > 1_000))
    || typeof root.canSteer !== 'boolean' || typeof root.canEdit !== 'boolean'
    || typeof root.canRemove !== 'boolean') return null;
  const ids = new Set<string>();
  const items = root.items.flatMap((candidate) => {
    const item = record(candidate);
    const id = text(item?.id, 256);
    const content = text(item?.text, 262_144);
    const createdAt = finite(item?.createdAt);
    const requestId = item?.requestId === undefined ? undefined : text(item.requestId, 256);
    const state = item?.state === undefined ? undefined
      : ['queued', 'dispatching', 'steering', 'unknown']
        .find((candidate) => candidate === item.state);
    const revision = item?.revision === undefined ? undefined : revisionNumber(item.revision);
    const dispatchOrigin = item?.dispatchOrigin === undefined ? undefined
      : ['direct', 'queue', 'steer'].find((candidate) => candidate === item.dispatchOrigin);
    const autoDispatchBlockedReason = item?.autoDispatchBlockedReason === undefined ? undefined
      : item.autoDispatchBlockedReason === 'provider_rejected' ? 'provider_rejected' as const : null;
    if (!id || !content || createdAt === undefined || ids.has(id)
      || (item?.requestId !== undefined && requestId === undefined)
      || (item?.editing !== undefined && item.editing !== true)
      || (item?.state !== undefined && state === undefined)
      || (item?.revision !== undefined && revision === undefined)
      || (item?.dispatchOrigin !== undefined && dispatchOrigin === undefined)
      || autoDispatchBlockedReason === null) return [];
    ids.add(id);
    return [{
      id, text: content, createdAt,
      ...(requestId === undefined ? {} : { requestId }),
      ...(item?.editing === true ? { editing: true as const } : {}),
      ...(state === undefined ? {} : { state: state as NonNullable<ConversationQueueItem['state']> }),
      ...(revision === undefined ? {} : { revision }),
      ...(dispatchOrigin === undefined ? {} : {
        dispatchOrigin: dispatchOrigin as NonNullable<ConversationQueueItem['dispatchOrigin']>,
      }),
      ...(autoDispatchBlockedReason === undefined ? {} : { autoDispatchBlockedReason }),
    }];
  });
  if (items.length !== root.items.length) return null;
  const settledIds = new Set<string>();
  const settled = root.settled === undefined ? undefined : root.settled.flatMap((candidate) => {
    const receipt = record(candidate);
    const id = text(receipt?.id, 256);
    const nativeId = receipt?.nativeId === undefined ? undefined : text(receipt.nativeId, 1_024);
    if (!id || settledIds.has(id) || (receipt?.nativeId !== undefined && !nativeId)) return [];
    settledIds.add(id);
    return [{ id, ...(nativeId === undefined ? {} : { nativeId }) }];
  });
  if (settled !== undefined && settled.length !== root.settled!.length) return null;
  return {
    items,
    ...(settled === undefined ? {} : { settled }),
    canSteer: root.canSteer,
    canEdit: root.canEdit,
    canRemove: root.canRemove,
  };
}

function parseGoal(value: unknown): ConversationGoal | null | undefined {
  if (value === null) return null;
  const root = record(value);
  const objective = text(root?.objective, 4_000);
  const status = text(root?.status, 64);
  if (!root || !objective || !status) return undefined;
  const createdAt = root.createdAt === undefined ? undefined : finite(root.createdAt);
  const updatedAt = root.updatedAt === undefined ? undefined : finite(root.updatedAt);
  const tokensUsed = root.tokensUsed === undefined ? undefined : finite(root.tokensUsed);
  const timeUsedSeconds = root.timeUsedSeconds === undefined ? undefined : finite(root.timeUsedSeconds);
  const tokenBudget = root.tokenBudget === null ? null
    : root.tokenBudget === undefined ? undefined : finite(root.tokenBudget);
  if ((root.createdAt !== undefined && createdAt === undefined)
    || (root.updatedAt !== undefined && updatedAt === undefined)
    || (root.tokensUsed !== undefined && tokensUsed === undefined)
    || (root.timeUsedSeconds !== undefined && timeUsedSeconds === undefined)
    || (root.tokenBudget !== undefined && tokenBudget === undefined)) return undefined;
  return {
    objective, status,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(tokensUsed === undefined ? {} : { tokensUsed }),
    ...(timeUsedSeconds === undefined ? {} : { timeUsedSeconds }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
  };
}

function parsePlan(value: unknown): ConversationPlanSnapshot | null | undefined {
  if (value === null) return null;
  const root = record(value);
  if (!root || !Array.isArray(root.steps) || root.steps.length > 100) return undefined;
  const steps = root.steps.flatMap((candidate) => {
    const step = record(candidate);
    const label = text(step?.step);
    const status = ['pending', 'inProgress', 'completed'].find((item) => item === step?.status);
    return label && status ? [{ step: label, status: status as ConversationPlanStep['status'] }] : [];
  });
  const explanation = root.explanation === undefined ? undefined : text(root.explanation, 16_384);
  const turnId = root.turnId === undefined ? undefined : text(root.turnId, 256);
  if (steps.length !== root.steps.length
    || (root.explanation !== undefined && explanation === undefined)
    || (root.turnId !== undefined && turnId === undefined)
    || (root.waiting !== undefined && typeof root.waiting !== 'boolean')) return undefined;
  return {
    steps,
    ...(explanation === undefined ? {} : { explanation }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(root.waiting === true ? { waiting: true } : {}),
  };
}

function parseContext(value: unknown): ConversationContextSnapshot | null | undefined {
  if (value === null) return null;
  const root = record(value);
  const activities = ['idle', 'working', 'waiting', 'compacting', 'unknown'] as const;
  const activity = activities.find((candidate) => candidate === root?.activity);
  if (!root || !activity) return undefined;
  const usedTokens = root.usedTokens === undefined ? undefined : finite(root.usedTokens);
  const totalTokens = root.totalTokens === undefined ? undefined : finite(root.totalTokens);
  const cwd = root.cwd === undefined ? undefined : text(root.cwd);
  const branch = root.branch === undefined ? undefined : text(root.branch, 1_024);
  const access = ['read-only', 'workspace-write', 'full-access'].find((item) => item === root.access);
  if ((root.usedTokens !== undefined && usedTokens === undefined)
    || (root.totalTokens !== undefined && (totalTokens === undefined || totalTokens <= 0))
    || (root.cwd !== undefined && cwd === undefined)
    || (root.branch !== undefined && branch === undefined)
    || (root.access !== undefined && access === undefined)) return undefined;
  return {
    activity,
    ...(usedTokens === undefined ? {} : { usedTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(branch === undefined ? {} : { branch }),
    ...(access === undefined ? {} : { access: access as NonNullable<ConversationContextSnapshot['access']> }),
  };
}

function parsePermission(value: unknown): ConversationPermissionSnapshot | null | undefined {
  if (value === null) return null;
  const root = record(value);
  const modes = ['default', 'auto-review', 'full-access', 'custom'] as const;
  const mode = modes.find((candidate) => candidate === root?.mode);
  const options = Array.isArray(root?.options) ? root.options : null;
  if (!root || !mode || !options || options.length === 0 || options.length > 3
    || options.some((candidate) => !['default', 'auto-review', 'full-access'].includes(String(candidate)))
    || new Set(options).size !== options.length) return undefined;
  return { mode, options: options as ConversationPermissionSnapshot['options'] };
}

export function parseConversationControls(value: unknown): ConversationControlsSnapshot | null {
  const root = record(value);
  if (!root) return null;
  const activity = root.activity === undefined ? undefined
    : ['idle', 'working', 'waiting', 'compacting', 'unknown']
      .find((candidate) => candidate === root.activity);
  const submissions = root.submissions === undefined ? undefined
    : Array.isArray(root.submissions) && root.submissions.length <= 1_000
      ? root.submissions.map(parseSubmission) : null;
  const queue = root.queue === undefined ? undefined : parseQueue(root.queue);
  const goal = root.goal === undefined ? undefined : parseGoal(root.goal);
  const plan = root.plan === undefined ? undefined : parsePlan(root.plan);
  const context = root.context === undefined ? undefined : parseContext(root.context);
  const permission = root.permission === undefined ? undefined : parsePermission(root.permission);
  const goalActions = root.goalActions === undefined ? undefined
    : Array.isArray(root.goalActions) && root.goalActions.length <= 3
      && root.goalActions.every((item) => item === 'start' || item === 'update' || item === 'clear')
      && new Set(root.goalActions).size === root.goalActions.length
      ? root.goalActions as Array<'start' | 'update' | 'clear'> : null;
  const permissionCanUpdate = root.permissionCanUpdate === undefined ? undefined
    : typeof root.permissionCanUpdate === 'boolean' ? root.permissionCanUpdate : null;
  const commands = root.commands === undefined ? undefined
    : Array.isArray(root.commands) && root.commands.length <= 2
      && root.commands.every((item) => item === 'compact' || item === 'clear')
      && new Set(root.commands).size === root.commands.length
      ? root.commands as ConversationCommand[] : null;
  const rawErrors = root.slotErrors === undefined ? undefined : record(root.slotErrors);
  const slotErrors: ConversationControlsSnapshot['slotErrors'] = rawErrors === undefined
    ? undefined : rawErrors === null ? null as never : {};
  if (rawErrors) {
    const allowed = new Set(['queue', 'goal', 'plan', 'context', 'permission', 'commands']);
    for (const [slot, message] of Object.entries(rawErrors)) {
      if (!allowed.has(slot) || !text(message, 4_096)) return null;
      Object.assign(slotErrors!, { [slot]: message });
    }
  }
  if ((root.activity !== undefined && activity === undefined)
    || submissions === null || submissions?.some((item) => item === null)
    || (root.queue !== undefined && queue === null)
    || (root.goal !== undefined && goal === undefined)
    || (root.plan !== undefined && plan === undefined)
    || (root.context !== undefined && context === undefined)
    || (root.permission !== undefined && permission === undefined)
    || goalActions === null || permissionCanUpdate === null
    || commands === null || (root.slotErrors !== undefined && rawErrors === null)) return null;
  return {
    ...(activity === undefined ? {} : { activity: activity as ConversationActivity }),
    ...(submissions === undefined ? {} : {
      submissions: submissions as ConversationSubmissionSnapshot[],
    }),
    ...(queue == null ? {} : { queue }),
    ...(goal === undefined ? {} : { goal }),
    ...(goalActions === undefined ? {} : { goalActions }),
    ...(plan === undefined ? {} : { plan }),
    ...(context === undefined ? {} : { context }),
    ...(permission === undefined ? {} : { permission }),
    ...(permissionCanUpdate === undefined ? {} : { permissionCanUpdate }),
    ...(commands === undefined ? {} : { commands }),
    ...(slotErrors === undefined ? {} : { slotErrors }),
  };
}

async function action(path: string, run: AgentRunRef, request: Record<string, unknown>): Promise<unknown> {
  return requestJson(path, {
    method: 'POST', body: JSON.stringify({ run, request }), timeoutMs: 20_000,
  });
}

export async function readConversationControls(
  run: AgentRunRef,
  signal?: AbortSignal,
): Promise<ConversationControlsSnapshot> {
  const response = record(await requestJson(`/api/agents/conversation-controls?${query(run)}`, {
    timeoutMs: 8_000, ...(signal ? { signal } : {}),
  }));
  const controls = parseConversationControls(response?.controls);
  if (!controls) throw new Error('Conversation controls returned an invalid snapshot');
  return controls;
}

export async function conversationQueueAction(
  run: AgentRunRef,
  request: Record<string, unknown>,
): Promise<ConversationQueueEditLease | ConversationSubmissionActionResult | null> {
  const response = record(await action('/api/agents/conversation-queue/action', run, request));
  if (request.action === 'steer') {
    const candidate = record(response?.receipt) ?? response;
    const rawStatus = candidate?.result ?? candidate?.status;
    const status = ['accepted', 'rejected', 'unknown'].find((value) => value === rawStatus);
    // Older servers return an empty success body. Treat that as accepted while the authoritative queue
    // poll and canonical transcript complete the same stable-id handoff.
    if (!status && (!response || Object.keys(response).length === 0 || response.ok === true)) {
      return { status: 'accepted' };
    }
    const parsedSubmission = candidate?.submission === undefined ? undefined
      : parseSubmission(candidate.submission);
    const submissionIdValue = candidate?.submissionId ?? parsedSubmission?.id;
    const submissionId = submissionIdValue === undefined ? undefined : text(submissionIdValue, 256);
    const revision = candidate?.revision === undefined ? undefined : revisionNumber(candidate.revision);
    const actionId = candidate?.actionId === undefined ? undefined : text(candidate.actionId, 256);
    const nativeMutation = candidate?.nativeMutation;
    if (!status || (submissionIdValue !== undefined && submissionId === undefined)
      || (candidate?.revision !== undefined && revision === undefined)
      || (candidate?.actionId !== undefined && actionId === undefined)
      || (candidate?.submission !== undefined && !parsedSubmission)
      || (nativeMutation !== undefined && nativeMutation !== true
        && nativeMutation !== false && nativeMutation !== 'unknown')) {
      throw new Error('Conversation queue returned an invalid steer result');
    }
    return {
      status: status as ConversationSubmissionActionResult['status'],
      ...(actionId === undefined ? {} : { actionId }),
      ...(submissionId === undefined ? {} : { submissionId }),
      ...(revision === undefined ? {} : { revision }),
      ...(nativeMutation === undefined ? {} : { nativeMutation }),
      ...(parsedSubmission == null ? {} : { submission: parsedSubmission }),
    };
  }
  if (request.action !== 'begin_edit' && request.action !== 'renew_edit') return null;
  const lease = record(response?.lease);
  const token = text(lease?.token, 1_024);
  const content = text(lease?.text, 262_144);
  const expiresAt = lease?.expiresAt === undefined ? undefined : finite(lease.expiresAt);
  if (!token || !content || (lease?.expiresAt !== undefined && expiresAt === undefined)) {
    throw new Error('Conversation queue returned an invalid edit lease');
  }
  return { token, text: content, ...(expiresAt === undefined ? {} : { expiresAt }) };
}

export async function conversationGoalAction(
  run: AgentRunRef,
  request: Record<string, unknown>,
): Promise<ConversationGoal | null> {
  const response = record(await action('/api/agents/conversation-goal/action', run, request));
  const goal = parseGoal(response?.goal);
  if (goal === undefined) throw new Error('Conversation goal returned an invalid response');
  return goal;
}

export async function conversationPermissionAction(
  run: AgentRunRef,
  request: Record<string, unknown>,
): Promise<ConversationPermissionSnapshot> {
  const response = record(await action('/api/agents/conversation-permission/action', run, request));
  const permission = parsePermission(response?.permission);
  if (!permission) throw new Error('Conversation permission returned an invalid response');
  return permission;
}

export async function executeConversationCommand(
  run: AgentRunRef,
  command: ConversationCommand,
): Promise<void> {
  await requestJson('/api/agents/conversation-command', {
    method: 'POST', body: JSON.stringify({ run, command }), timeoutMs: 30_000,
  });
}
