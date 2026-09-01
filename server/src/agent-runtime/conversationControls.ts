import type { AgentRunLease } from './run.js';

export interface ConversationGoal {
  objective: string;
  status: string;
  createdAt?: number;
  updatedAt?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  tokenBudget?: number | null;
}

export interface AgentConversationGoalControllerV1 {
  apiVersion: 1;
  read(run: AgentRunLease): Promise<ConversationGoal | null>;
  start?(run: AgentRunLease, objective: string): Promise<ConversationGoal>;
  update?(
    run: AgentRunLease,
    patch: { objective?: string; status?: 'active' | 'paused' },
  ): Promise<ConversationGoal>;
  clear?(run: AgentRunLease): Promise<void>;
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

export interface AgentConversationPlanControllerV1 {
  apiVersion: 1;
  read(run: AgentRunLease): Promise<ConversationPlanSnapshot | null>;
}

export type ConversationPermissionMode = 'default' | 'auto-review' | 'full-access' | 'custom';

export interface ConversationContextSnapshot {
  activity: 'idle' | 'working' | 'waiting' | 'compacting' | 'unknown';
  usedTokens?: number;
  totalTokens?: number;
  cwd?: string;
  branch?: string;
  access?: 'read-only' | 'workspace-write' | 'full-access';
}

export interface AgentConversationContextControllerV1 {
  apiVersion: 1;
  read(run: AgentRunLease): Promise<ConversationContextSnapshot | null>;
}

export interface ConversationPermissionSnapshot {
  mode: ConversationPermissionMode;
  options: Array<Exclude<ConversationPermissionMode, 'custom'>>;
}

export interface AgentConversationPermissionControllerV1 {
  apiVersion: 1;
  read(run: AgentRunLease): Promise<ConversationPermissionSnapshot | null>;
  update?(
    run: AgentRunLease,
    mode: Exclude<ConversationPermissionMode, 'custom'>,
  ): Promise<ConversationPermissionSnapshot>;
}

export type ConversationCommand = 'compact' | 'clear';

export interface AgentConversationCommandControllerV1 {
  apiVersion: 1;
  commands: readonly ConversationCommand[];
  execute(run: AgentRunLease, command: ConversationCommand): Promise<void>;
}

export interface AgentConversationControlBindings {
  goal?: AgentConversationGoalControllerV1;
  plan?: AgentConversationPlanControllerV1;
  context?: AgentConversationContextControllerV1;
  permission?: AgentConversationPermissionControllerV1;
  commands?: AgentConversationCommandControllerV1;
}

export interface ConversationControlsSnapshot {
  goal?: ConversationGoal | null;
  goalActions?: Array<'start' | 'update' | 'clear'>;
  plan?: ConversationPlanSnapshot | null;
  context?: ConversationContextSnapshot | null;
  permission?: ConversationPermissionSnapshot | null;
  permissionCanUpdate?: boolean;
  commands?: ConversationCommand[];
  slotErrors?: Partial<Record<ConversationControlSlot, string>>;
}

export type ConversationControlSlot = keyof AgentConversationControlBindings;

export class ConversationControlError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported' | 'invalid_request' | 'contract_violation',
  ) {
    super(message);
    this.name = 'ConversationControlError';
  }
}

const MAX_OBJECTIVE = 4_000;

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function goal(value: ConversationGoal | null): ConversationGoal | null | undefined {
  if (value === null) return null;
  if (!value || !text(value.objective, MAX_OBJECTIVE) || !text(value.status, 64)) return undefined;
  const numeric = ['createdAt', 'updatedAt', 'tokensUsed', 'timeUsedSeconds'] as const;
  if (numeric.some((key) => value[key] !== undefined && !finite(value[key]))) return undefined;
  if (value.tokenBudget !== undefined && value.tokenBudget !== null && !finite(value.tokenBudget)) {
    return undefined;
  }
  return structuredClone(value);
}

function plan(value: ConversationPlanSnapshot | null): ConversationPlanSnapshot | null | undefined {
  if (value === null) return null;
  if (!value || !Array.isArray(value.steps) || value.steps.length > 100
    || (value.explanation !== undefined && !text(value.explanation, 16_384))
    || (value.turnId !== undefined && !text(value.turnId, 256))
    || (value.waiting !== undefined && typeof value.waiting !== 'boolean')) return undefined;
  const statuses = new Set(['pending', 'inProgress', 'completed']);
  if (value.steps.some((step) => !step || !text(step.step, 4_096) || !statuses.has(step.status))) {
    return undefined;
  }
  return structuredClone(value);
}

function context(value: ConversationContextSnapshot | null): ConversationContextSnapshot | null | undefined {
  if (value === null) return null;
  if (!value || !['idle', 'working', 'waiting', 'compacting', 'unknown'].includes(value.activity)
    || (value.usedTokens !== undefined && !finite(value.usedTokens))
    || (value.totalTokens !== undefined && (!finite(value.totalTokens) || value.totalTokens <= 0))
    || (value.cwd !== undefined && !text(value.cwd, 4_096))
    || (value.branch !== undefined && !text(value.branch, 1_024))
    || (value.access !== undefined && !['read-only', 'workspace-write', 'full-access'].includes(value.access))) {
    return undefined;
  }
  return structuredClone(value);
}

function permission(
  value: ConversationPermissionSnapshot | null,
): ConversationPermissionSnapshot | null | undefined {
  if (value === null) return null;
  const validModes = ['default', 'auto-review', 'full-access', 'custom'];
  if (!value || !validModes.includes(value.mode) || !Array.isArray(value.options)
    || value.options.length === 0 || value.options.length > 3
    || value.options.some((mode) => !['default', 'auto-review', 'full-access'].includes(mode))
    || new Set(value.options).size !== value.options.length) return undefined;
  return structuredClone(value);
}

export class AgentConversationControlService {
  readonly #bindings: ReadonlyMap<string, AgentConversationControlBindings>;

  constructor(bindings: Readonly<Record<string, AgentConversationControlBindings>>) {
    if (!bindings || typeof bindings !== 'object' || !Object.keys(bindings).length) {
      throw new TypeError('AgentConversationControlService requires controller bindings');
    }
    this.#bindings = new Map(Object.entries(bindings));
  }

  slots(agentId: string): Record<ConversationControlSlot, boolean> {
    const binding = this.#bindings.get(agentId);
    return {
      goal: binding?.goal?.apiVersion === 1,
      plan: binding?.plan?.apiVersion === 1,
      context: binding?.context?.apiVersion === 1,
      permission: binding?.permission?.apiVersion === 1,
      commands: binding?.commands?.apiVersion === 1,
    };
  }

  async read(run: AgentRunLease): Promise<ConversationControlsSnapshot> {
    const binding = this.#bindings.get(run.ref.agentId);
    if (!binding) throw new ConversationControlError('Conversation controls unsupported', 'unsupported');
    const [goalResult, planResult, contextResult, permissionResult] = await Promise.allSettled([
      binding.goal?.read(run), binding.plan?.read(run), binding.context?.read(run),
      binding.permission?.read(run),
    ]);
    const slotErrors: Partial<Record<ConversationControlSlot, string>> = {};
    const resultValue = <T,>(
      slot: ConversationControlSlot,
      result: PromiseSettledResult<T | undefined>,
    ): T | undefined => {
      if (result.status === 'fulfilled') return result.value;
      // Provider failures may contain RPC payloads, credentials, or local paths. The facade exposes only a
      // stable slot-level recovery signal; adapter diagnostics belong in Runtime health/logging.
      slotErrors[slot] = 'temporarily unavailable';
      return undefined;
    };
    const goalValue = resultValue('goal', goalResult);
    const planValue = resultValue('plan', planResult);
    const contextValue = resultValue('context', contextResult);
    const permissionValue = resultValue('permission', permissionResult);
    const normalizedGoal = goalValue === undefined ? undefined : goal(goalValue);
    const normalizedPlan = planValue === undefined ? undefined : plan(planValue);
    const normalizedContext = contextValue === undefined ? undefined : context(contextValue);
    const normalizedPermission = permissionValue === undefined ? undefined : permission(permissionValue);
    if (goalValue !== undefined && normalizedGoal === undefined) slotErrors.goal = 'temporarily unavailable';
    if (planValue !== undefined && normalizedPlan === undefined) slotErrors.plan = 'temporarily unavailable';
    if (contextValue !== undefined && normalizedContext === undefined) {
      slotErrors.context = 'temporarily unavailable';
    }
    if (permissionValue !== undefined && normalizedPermission === undefined) {
      slotErrors.permission = 'temporarily unavailable';
    }
    return {
      ...(normalizedGoal === undefined ? {} : { goal: normalizedGoal }),
      ...(binding.goal?.apiVersion === 1 ? { goalActions: [
        ...(binding.goal.start ? ['start' as const] : []),
        ...(binding.goal.update ? ['update' as const] : []),
        ...(binding.goal.clear ? ['clear' as const] : []),
      ] } : {}),
      ...(normalizedPlan === undefined ? {} : { plan: normalizedPlan }),
      ...(normalizedContext === undefined ? {} : { context: normalizedContext }),
      ...(normalizedPermission === undefined ? {} : { permission: normalizedPermission }),
      ...(binding.permission?.apiVersion === 1 ? {
        permissionCanUpdate: typeof binding.permission.update === 'function',
      } : {}),
      ...(binding.commands?.apiVersion === 1 ? { commands: [...binding.commands.commands] } : {}),
      ...(Object.keys(slotErrors).length ? { slotErrors } : {}),
    };
  }

  async goalAction(run: AgentRunLease, request: Record<string, unknown>): Promise<ConversationGoal | null> {
    const control = this.#bindings.get(run.ref.agentId)?.goal;
    if (!control) throw new ConversationControlError('Conversation goal unsupported', 'unsupported');
    let raw: ConversationGoal | null;
    if (request.action === 'clear') {
      if (!control.clear) throw new ConversationControlError('Goal clear unsupported', 'unsupported');
      await control.clear(run);
      return null;
    }
    if (request.action === 'start' && text(request.objective, MAX_OBJECTIVE)) {
      if (!control.start) throw new ConversationControlError('Goal start unsupported', 'unsupported');
      raw = await control.start(run, request.objective.trim());
    } else if (request.action === 'update') {
      const patch: { objective?: string; status?: 'active' | 'paused' } = {};
      if (request.objective !== undefined) {
        if (!text(request.objective, MAX_OBJECTIVE)) {
          throw new ConversationControlError('Invalid goal objective', 'invalid_request');
        }
        patch.objective = request.objective.trim();
      }
      if (request.status !== undefined) {
        if (request.status !== 'active' && request.status !== 'paused') {
          throw new ConversationControlError('Invalid goal status', 'invalid_request');
        }
        patch.status = request.status;
      }
      if (!Object.keys(patch).length) {
        throw new ConversationControlError('Empty goal update', 'invalid_request');
      }
      if (!control.update) throw new ConversationControlError('Goal update unsupported', 'unsupported');
      raw = await control.update(run, patch);
    } else {
      throw new ConversationControlError('Invalid goal action', 'invalid_request');
    }
    const normalized = goal(raw);
    if (!normalized) throw new ConversationControlError('Invalid goal response', 'contract_violation');
    return normalized;
  }

  async permissionAction(
    run: AgentRunLease,
    request: Record<string, unknown>,
  ): Promise<ConversationPermissionSnapshot> {
    const control = this.#bindings.get(run.ref.agentId)?.permission;
    if (!control) throw new ConversationControlError('Conversation permission unsupported', 'unsupported');
    if (!control.update) {
      throw new ConversationControlError('Permission update unsupported', 'unsupported');
    }
    const mode = request.permissionMode;
    if (request.action !== 'set_permission'
      || !['default', 'auto-review', 'full-access'].includes(String(mode))) {
      throw new ConversationControlError('Invalid permission action', 'invalid_request');
    }
    const normalized = permission(await control.update(
      run,
      mode as Exclude<ConversationPermissionMode, 'custom'>,
    ));
    if (!normalized) throw new ConversationControlError('Invalid permission response', 'contract_violation');
    return normalized;
  }

  async command(run: AgentRunLease, value: unknown): Promise<void> {
    const control = this.#bindings.get(run.ref.agentId)?.commands;
    if (!control || (value !== 'compact' && value !== 'clear') || !control.commands.includes(value)) {
      throw new ConversationControlError('Conversation command unsupported', 'unsupported');
    }
    await control.execute(run, value);
  }
}
