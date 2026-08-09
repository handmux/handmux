import type { CodexGoal } from './codexStreamProtocol.js';

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function codexItemMessageId(
  turnId: unknown,
  itemId: unknown,
  child: number | string | null = null,
): string | null {
  const turn = nonEmpty(turnId);
  const item = nonEmpty(itemId);
  if (!turn || !item) return null;
  const base = `codex:${turn}:${item}`;
  return child == null ? base : `${base}:child-${encodeURIComponent(String(child))}`;
}

export function codexGoalMessageId(
  goal: Partial<CodexGoal> | null | undefined,
  event: unknown,
): string | null {
  const lifecycle = nonEmpty(event) || nonEmpty(goal?.status);
  const marker = goal?.createdAt ?? goal?.updatedAt ?? nonEmpty(goal?.objective);
  if (!lifecycle || marker == null) return null;
  return `codex-goal:${encodeURIComponent(String(marker))}:${encodeURIComponent(lifecycle)}`;
}
