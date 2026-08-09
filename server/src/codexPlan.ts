export type CodexPlanStatus = 'pending' | 'inProgress' | 'completed';

export interface CodexPlanStep {
  step: string;
  status: CodexPlanStatus;
}

export interface CodexPlanSnapshot {
  turnId: string;
  steps: CodexPlanStep[];
  explanation?: string;
}

const PLAN_STATUSES = new Map<string, CodexPlanStatus>([
  ['pending', 'pending'],
  ['inProgress', 'inProgress'],
  ['in_progress', 'inProgress'],
  ['completed', 'completed'],
]);

// Keep plan projection deliberately small and text-only. App Server uses camelCase statuses while the
// persisted Code Mode call uses snake_case; the phone receives one stable shape from either source.
export function normalizeCodexPlan(value: unknown): CodexPlanStep[] | null {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 100).flatMap((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    const step = typeof record?.step === 'string' ? record.step.trim().slice(0, 2_000) : '';
    const status = typeof record?.status === 'string' ? PLAN_STATUSES.get(record.status) : undefined;
    return step && status ? [{ step, status }] : [];
  });
}

export function codexPlanSnapshot(
  turnId: string | null | undefined,
  value: unknown,
  explanation: unknown = null,
): CodexPlanSnapshot | null {
  const steps = normalizeCodexPlan(value);
  if (!turnId || !steps?.length) return null;
  return {
    turnId,
    steps,
    ...(typeof explanation === 'string' && explanation.trim()
      ? { explanation: explanation.trim().slice(0, 4_000) }
      : {}),
  };
}
