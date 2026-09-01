export interface CompletedEntryRow {
  key: string;
  durableAssistantText: boolean;
}

export type CompletedEntryAnchor =
  | { kind: 'target'; key: string; edge: 'start' | 'after' }
  | { kind: 'fallback' };

// The forced latest read makes this window authoritative. Its final durable assistant text is therefore
// the completed entry target without reconstructing provider-specific user/turn relationships.
export function completedEntryAnchor(
  rows: readonly CompletedEntryRow[],
): CompletedEntryAnchor {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.durableAssistantText) {
      return { kind: 'target', key: row.key, edge: 'start' };
    }
  }
  return { kind: 'fallback' };
}

export function positionCompletedEntry(
  viewport: HTMLElement,
  anchor: Extract<CompletedEntryAnchor, { kind: 'target' }>,
  topInset = 12,
): number | null {
  const target = Array.from(viewport.querySelectorAll<HTMLElement>('[data-completed-entry-key]'))
    .find((element) => element.dataset.completedEntryKey === anchor.key);
  if (!target) return null;
  const viewportRect = viewport.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetY = anchor.edge === 'after' ? targetRect.bottom : targetRect.top;
  const nextTop = Math.max(0, viewport.scrollTop + targetY - viewportRect.top - topInset);
  viewport.scrollTop = nextTop;
  return viewport.scrollTop;
}
