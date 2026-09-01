import type {
  AgentModelControlPatch,
  AgentModelControlSnapshot,
  AgentModelEffortOption,
  AgentModelOption,
  AgentServiceTierOption,
  AgentSessionControlAdapterV1,
} from '../agent-runtime/sessionControl.js';

type JsonRecord = Record<string, unknown>;

export interface CodexSessionControlApp {
  models(pane: string, threadId: string): Promise<unknown>;
  status(pane: string, threadId: string): Promise<unknown>;
  updateSettings(pane: string, threadId: string, updates: JsonRecord): Promise<unknown>;
}

const record = (value: unknown): JsonRecord | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
);
const text = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

function effortOptions(value: unknown): AgentModelEffortOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const item = record(candidate);
    const id = text(item?.reasoningEffort);
    if (!id) return [];
    const description = text(item?.description);
    return [{ id, label: id, ...(description === undefined ? {} : { description }) }];
  });
}

function tierOptions(model: JsonRecord): AgentServiceTierOption[] | undefined {
  const explicit = Array.isArray(model.serviceTiers)
    ? model.serviceTiers.flatMap((candidate) => {
      const item = record(candidate);
      const id = text(item?.id);
      if (!id) return [];
      const label = text(item?.name);
      const description = text(item?.description);
      return [{
        id,
        ...(label === undefined ? {} : { label }),
        ...(description === undefined ? {} : { description }),
      }];
    }) : [];
  const fallback = explicit.length ? explicit : Array.isArray(model.additionalSpeedTiers)
    ? model.additionalSpeedTiers.flatMap((candidate) => {
      const id = text(candidate);
      return id ? [{ id, label: id }] : [];
    }) : [];
  return fallback.length ? fallback : undefined;
}

function modelOptions(value: unknown): AgentModelOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const item = record(candidate);
    if (!item) return [];
    const id = text(item.model) ?? text(item.id);
    if (!id) return [];
    const label = text(item.displayName) ?? id;
    const description = text(item.description);
    const efforts = effortOptions(item.supportedReasoningEfforts);
    const defaultEffort = text(item.defaultReasoningEffort);
    const serviceTiers = tierOptions(item);
    return [{
      id,
      label,
      ...(description === undefined ? {} : { description }),
      efforts,
      ...(defaultEffort === undefined || !efforts.some((effort) => effort.id === defaultEffort)
        ? {} : { defaultEffort }),
      ...(serviceTiers === undefined ? {} : { serviceTiers }),
    }];
  });
}

function settingsFrom(value: unknown): JsonRecord {
  const root = record(value);
  return record(root?.settings) ?? root ?? {};
}

function snapshot(modelsValue: unknown, settingsValue: unknown): AgentModelControlSnapshot {
  const models = modelOptions(modelsValue);
  const settings = settingsFrom(settingsValue);
  const selectedModelId = text(settings.model) ?? null;
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const effort = text(settings.effort);
  const serviceTier = settings.serviceTier === null ? null : text(settings.serviceTier) ?? null;
  return {
    models,
    selected: {
      model: selectedModel?.id ?? null,
      effort: effort && selectedModel?.efforts.some((candidate) => candidate.id === effort)
        ? effort : null,
      serviceTier: serviceTier && selectedModel?.serviceTiers?.some((tier) => tier.id === serviceTier)
        ? serviceTier : null,
    },
  };
}

export function createCodexSessionControlAdapter(
  app: CodexSessionControlApp,
): AgentSessionControlAdapterV1 {
  if (!app || typeof app.models !== 'function' || typeof app.status !== 'function'
    || typeof app.updateSettings !== 'function') {
    throw new TypeError('Codex Session Control adapter requires App Server model/settings APIs');
  }
  const read = async (
    pane: string,
    threadId: string,
  ): Promise<AgentModelControlSnapshot> => {
    const [models, status] = await Promise.all([
      app.models(pane, threadId),
      app.status(pane, threadId),
    ]);
    return snapshot(models, status);
  };
  return {
    apiVersion: 1,
    async readModelControl(run, options) {
      const threadId = run.ref.sessionId;
      if (!threadId || run.signal.aborted) return null;
      // Codex App Server's model/list is already a live native read and exposes no stronger refresh
      // operation. `refresh` therefore has the same semantics instead of being backed by a Web cache.
      void options?.refresh;
      return read(run.ref.paneId, threadId);
    },
    async updateModelControl(run, patch: AgentModelControlPatch) {
      const threadId = run.ref.sessionId;
      if (!threadId || run.signal.aborted) throw new Error('Codex run is unavailable');
      await app.updateSettings(run.ref.paneId, threadId, { ...patch });
      if (run.signal.aborted) throw new Error('Codex run is unavailable');
      return read(run.ref.paneId, threadId);
    },
  };
}
