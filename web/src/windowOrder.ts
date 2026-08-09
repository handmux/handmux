// The window to swap with when nudging window `id` one slot in `dir` ('left' | 'right'), or null at
// the edge (no neighbour) or when the id is no longer in the list. Order mirrors list-windows (tmux
// window index), so the neighbour is just the adjacent array element.
export interface WindowOrderItem { id: string }

export function moveTarget<T extends WindowOrderItem>(
  windows: readonly T[],
  id: string,
  dir: 'left' | 'right',
): T | null {
  const i = windows.findIndex((w) => w.id === id);
  if (i < 0) return null;
  return windows[dir === 'left' ? i - 1 : i + 1] ?? null;
}
