const PLAN_STATUSES = new Map([
  ['pending', 'pending'],
  ['inProgress', 'inProgress'],
  ['in_progress', 'inProgress'],
  ['completed', 'completed'],
]);

// Keep plan projection deliberately small and text-only. App Server uses camelCase statuses while the
// persisted Code Mode call uses snake_case; the phone receives one stable shape from either source.
export function normalizeCodexPlan(value) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 100).flatMap((item) => {
    const step = typeof item?.step === 'string' ? item.step.trim().slice(0, 2_000) : '';
    const status = PLAN_STATUSES.get(item?.status);
    return step && status ? [{ step, status }] : [];
  });
}

export function codexPlanSnapshot(turnId, value, explanation = null) {
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
