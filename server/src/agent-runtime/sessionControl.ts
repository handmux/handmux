import type { AgentRunLease } from './run.js';

export interface AgentModelEffortOption {
  id: string;
  label?: string;
  description?: string;
}

export interface AgentServiceTierOption {
  id: string;
  label?: string;
  description?: string;
}

export interface AgentModelOption {
  id: string;
  label: string;
  description?: string;
  efforts: AgentModelEffortOption[];
  defaultEffort?: string;
  serviceTiers?: AgentServiceTierOption[];
}

export interface AgentModelControlSelection {
  model: string | null;
  effort: string | null;
  serviceTier?: string | null;
}

export interface AgentModelControlSnapshot {
  models: AgentModelOption[];
  selected: AgentModelControlSelection;
}

export interface AgentModelControlPublicSnapshot extends AgentModelControlSnapshot {
  canUpdate: boolean;
}

export interface AgentModelControlPatch {
  model?: string;
  effort?: string;
  serviceTier?: string | null;
}

// Session Control is deliberately independent from Conversation. A provider can expose either one
// without changing history/live/send semantics, and a stale Connector can omit this optional control
// while its existing chat capability remains usable.
export interface AgentSessionControlAdapterV1 {
  apiVersion: 1;
  readModelControl(
    run: AgentRunLease,
    options?: { refresh?: boolean },
  ): Promise<AgentModelControlSnapshot | null>;
  updateModelControl?(
    run: AgentRunLease,
    patch: AgentModelControlPatch,
  ): Promise<AgentModelControlSnapshot>;
}

export type SessionControlContractErrorCode =
  | 'unsupported'
  | 'invalid_request'
  | 'contract_violation';

export class SessionControlContractError extends Error {
  constructor(message: string, readonly code: SessionControlContractErrorCode) {
    super(message);
    this.name = 'SessionControlContractError';
  }
}

const MAX_MODELS = 1_000;
const MAX_EFFORTS = 16;
const MAX_TIERS = 16;
const bounded = (value: unknown, max = 512): value is string => (
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
);

function normalizeEffort(value: AgentModelEffortOption): AgentModelEffortOption | null {
  if (!value || !bounded(value.id, 128)) return null;
  return {
    id: value.id.trim(),
    ...(bounded(value.label, 128) ? { label: value.label.trim() } : {}),
    ...(bounded(value.description, 1_024) ? { description: value.description.trim() } : {}),
  };
}

function normalizeTier(value: AgentServiceTierOption): AgentServiceTierOption | null {
  if (!value || !bounded(value.id, 128)) return null;
  return {
    id: value.id.trim(),
    ...(bounded(value.label, 128) ? { label: value.label.trim() } : {}),
    ...(bounded(value.description, 1_024) ? { description: value.description.trim() } : {}),
  };
}

function normalizeModel(value: AgentModelOption): AgentModelOption | null {
  if (!value || !bounded(value.id) || !bounded(value.label)
    || !Array.isArray(value.efforts) || value.efforts.length > MAX_EFFORTS) return null;
  const efforts = value.efforts.map(normalizeEffort);
  if (efforts.some((entry) => entry === null)) return null;
  const effortIds = efforts.map((entry) => entry!.id);
  if (new Set(effortIds).size !== effortIds.length) return null;
  const tiers = value.serviceTiers?.map(normalizeTier);
  if (tiers && (tiers.length > MAX_TIERS || tiers.some((entry) => entry === null))) return null;
  const tierIds = tiers?.map((entry) => entry!.id) ?? [];
  if (new Set(tierIds).size !== tierIds.length) return null;
  const defaultEffort = bounded(value.defaultEffort, 128) ? value.defaultEffort.trim() : undefined;
  if (defaultEffort !== undefined && !effortIds.includes(defaultEffort)) return null;
  return {
    id: value.id.trim(),
    label: value.label.trim(),
    ...(bounded(value.description, 1_024) ? { description: value.description.trim() } : {}),
    efforts: efforts as AgentModelEffortOption[],
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(tiers === undefined ? {} : { serviceTiers: tiers as AgentServiceTierOption[] }),
  };
}

function normalizeSnapshot(value: AgentModelControlSnapshot): AgentModelControlSnapshot | null {
  if (!value || !Array.isArray(value.models) || value.models.length > MAX_MODELS
    || !value.selected || typeof value.selected !== 'object') return null;
  const models = value.models.map(normalizeModel);
  if (models.some((entry) => entry === null)) return null;
  const modelIds = models.map((entry) => entry!.id);
  if (new Set(modelIds).size !== modelIds.length) return null;
  const selected = value.selected;
  if (selected.model !== null && !bounded(selected.model)) return null;
  if (selected.effort !== null && !bounded(selected.effort, 128)) return null;
  if (selected.serviceTier !== undefined && selected.serviceTier !== null
    && !bounded(selected.serviceTier, 128)) return null;
  const selectedModel = selected.model === null
    ? undefined : models.find((model) => model!.id === selected.model);
  if (selected.model !== null && !selectedModel) return null;
  if (selected.effort !== null
    && (!selectedModel || !selectedModel.efforts.some((effort) => effort.id === selected.effort))) {
    return null;
  }
  if (selected.serviceTier !== undefined && selected.serviceTier !== null
    && (!selectedModel
      || !selectedModel.serviceTiers?.some((tier) => tier.id === selected.serviceTier))) return null;
  return {
    models: models as AgentModelOption[],
    selected: {
      model: selected.model === null ? null : selected.model.trim(),
      effort: selected.effort === null ? null : selected.effort.trim(),
      ...(selected.serviceTier === undefined ? {} : {
        serviceTier: selected.serviceTier === null ? null : selected.serviceTier.trim(),
      }),
    },
  };
}

function normalizePatch(value: AgentModelControlPatch): AgentModelControlPatch | null {
  if (!value || typeof value !== 'object') return null;
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !['model', 'effort', 'serviceTier'].includes(key))) return null;
  if (value.model !== undefined && !bounded(value.model)) return null;
  if (value.effort !== undefined && !bounded(value.effort, 128)) return null;
  if (value.serviceTier !== undefined && value.serviceTier !== null
    && !bounded(value.serviceTier, 128)) return null;
  return {
    ...(value.model === undefined ? {} : { model: value.model.trim() }),
    ...(value.effort === undefined ? {} : { effort: value.effort.trim() }),
    ...(value.serviceTier === undefined ? {} : {
      serviceTier: value.serviceTier === null ? null : value.serviceTier.trim(),
    }),
  };
}

export class AgentSessionControlService {
  readonly #adapters: ReadonlyMap<string, AgentSessionControlAdapterV1>;

  constructor(adapters: Readonly<Record<string, AgentSessionControlAdapterV1>>) {
    const entries = Object.entries(adapters);
    if (!entries.length || entries.some(([, adapter]) => !adapter || adapter.apiVersion !== 1
      || typeof adapter.readModelControl !== 'function'
      || (adapter.updateModelControl !== undefined && typeof adapter.updateModelControl !== 'function'))) {
      throw new TypeError('AgentSessionControlService requires valid Session Control adapters');
    }
    this.#adapters = new Map(entries);
  }

  async readModelControl(
    run: AgentRunLease,
    options: { refresh?: boolean } = {},
  ): Promise<AgentModelControlPublicSnapshot | null> {
    const adapter = this.#adapters.get(run.ref.agentId);
    if (!adapter) throw new SessionControlContractError('Session Control unsupported', 'unsupported');
    const raw = await adapter.readModelControl(run, { refresh: options.refresh === true });
    if (raw === null) return null;
    const snapshot = normalizeSnapshot(raw);
    if (!snapshot) {
      throw new SessionControlContractError(
        'Session Control adapter returned an invalid snapshot',
        'contract_violation',
      );
    }
    return structuredClone({
      ...snapshot,
      canUpdate: typeof adapter.updateModelControl === 'function',
    });
  }

  async updateModelControl(
    run: AgentRunLease,
    value: AgentModelControlPatch,
  ): Promise<AgentModelControlPublicSnapshot> {
    const adapter = this.#adapters.get(run.ref.agentId);
    if (!adapter) throw new SessionControlContractError('Session Control unsupported', 'unsupported');
    if (!adapter.updateModelControl) {
      throw new SessionControlContractError('Session Control update unsupported', 'unsupported');
    }
    const patch = normalizePatch(value);
    if (!patch) throw new SessionControlContractError('Invalid Session Control update', 'invalid_request');
    const snapshot = normalizeSnapshot(await adapter.updateModelControl(run, patch));
    if (!snapshot) {
      throw new SessionControlContractError(
        'Session Control adapter returned an invalid snapshot',
        'contract_violation',
      );
    }
    return structuredClone({ ...snapshot, canUpdate: true });
  }
}
