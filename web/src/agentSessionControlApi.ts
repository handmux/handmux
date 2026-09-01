import { requestJson } from './apiRequest.js';
import type { AgentRunRef } from './agentCatalog.js';

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

export interface AgentModelControlSnapshot {
  models: AgentModelOption[];
  canUpdate: boolean;
  selected: {
    model: string | null;
    effort: string | null;
    serviceTier?: string | null;
  };
}

export interface AgentModelControlPatch {
  model?: string;
  effort?: string;
  serviceTier?: string | null;
}

const record = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);
const text = (value: unknown, max = 256): string | undefined => (
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined
);

const unique = <T extends { id: string }>(items: readonly T[]): boolean => (
  new Set(items.map((item) => item.id)).size === items.length
);

function option(value: unknown): AgentModelEffortOption | null {
  const item = record(value);
  const id = text(item?.id);
  if (!id) return null;
  const label = text(item?.label);
  const description = text(item?.description, 2_048);
  return {
    id,
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
  };
}

function model(value: unknown): AgentModelOption | null {
  const item = record(value);
  const id = text(item?.id);
  const label = text(item?.label);
  if (!id || !label || !Array.isArray(item?.efforts) || item.efforts.length > 32) return null;
  const efforts = item.efforts.map(option);
  if (efforts.some((entry) => entry === null)
    || !unique(efforts as AgentModelEffortOption[])) return null;
  const serviceTiers = item.serviceTiers === undefined ? undefined
    : Array.isArray(item.serviceTiers) && item.serviceTiers.length <= 16
      ? item.serviceTiers.map(option) : [null];
  if (serviceTiers?.some((entry) => entry === null)
    || (serviceTiers && !unique(serviceTiers as AgentServiceTierOption[]))) return null;
  const description = text(item.description, 2_048);
  const defaultEffort = text(item.defaultEffort);
  if (defaultEffort && !(efforts as AgentModelEffortOption[])
    .some((effort) => effort.id === defaultEffort)) return null;
  return {
    id,
    label,
    ...(description === undefined ? {} : { description }),
    efforts: efforts as AgentModelEffortOption[],
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(serviceTiers === undefined ? {} : {
      serviceTiers: serviceTiers as AgentServiceTierOption[],
    }),
  };
}

export function parseAgentModelControl(value: unknown): AgentModelControlSnapshot | null {
  const root = record(value);
  if (!root || !Array.isArray(root.models) || root.models.length > 256
    || typeof root.canUpdate !== 'boolean') return null;
  const models = root.models.map(model);
  const selected = record(root.selected);
  if (models.some((entry) => entry === null) || !selected
    || !unique(models as AgentModelOption[])) return null;
  const selectedModel = selected.model === null ? null : text(selected.model);
  const selectedEffort = selected.effort === null ? null : text(selected.effort);
  const selectedTier = selected.serviceTier === undefined ? undefined
    : selected.serviceTier === null ? null : text(selected.serviceTier);
  if (selectedModel === undefined || selectedEffort === undefined
    || (selected.serviceTier !== undefined && selectedTier === undefined)) return null;
  const active = selectedModel === null ? undefined
    : models.find((candidate) => candidate?.id === selectedModel);
  if (selectedModel !== null && !active) return null;
  if (selectedEffort !== null && !active?.efforts.some((effort) => effort.id === selectedEffort)) return null;
  if (selectedTier !== undefined && selectedTier !== null
    && !active?.serviceTiers?.some((tier) => tier.id === selectedTier)) return null;
  return {
    models: models as AgentModelOption[],
    canUpdate: root.canUpdate,
    selected: {
      model: selectedModel,
      effort: selectedEffort,
      ...(selectedTier === undefined ? {} : { serviceTier: selectedTier }),
    },
  };
}

function query(run: AgentRunRef, refresh: boolean): string {
  const params = new URLSearchParams({
    agentId: run.agentId,
    paneId: run.paneId,
    runId: run.runId,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
    ...(refresh ? { refresh: 'true' } : {}),
  });
  return params.toString();
}

export async function readAgentModelControl(
  run: AgentRunRef,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<AgentModelControlSnapshot | null> {
  const response = record(await requestJson(
    `/api/agents/session-control/model?${query(run, options.refresh === true)}`,
    {
      timeoutMs: options.refresh ? 30_000 : 8_000,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  ));
  if (!response || !Object.hasOwn(response, 'control')) {
    throw new Error('Session Control returned an invalid response');
  }
  if (response.control === null) return null;
  const control = parseAgentModelControl(response.control);
  if (!control) throw new Error('Session Control returned an invalid model snapshot');
  return control;
}

export async function updateAgentModelControl(
  run: AgentRunRef,
  patch: AgentModelControlPatch,
  signal?: AbortSignal,
): Promise<AgentModelControlSnapshot> {
  const response = record(await requestJson('/api/agents/session-control/model', {
    method: 'PATCH',
    body: JSON.stringify({ run, patch }),
    timeoutMs: 8_000,
    ...(signal ? { signal } : {}),
  }));
  const control = parseAgentModelControl(response?.control);
  if (!control) throw new Error('Session Control returned an invalid model snapshot');
  return control;
}
