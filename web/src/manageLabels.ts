const CIRCLED = '①②③④⑤⑥⑦⑧⑨';

interface SizedItem {
  id?: string;
  name?: string;
  command?: string | null;
}

export function windowManageSubtitle(win: SizedItem | null | undefined): string {
  if (!win) return '';
  return win.name || win.id || '';
}

export function paneManageSubtitle(
  panes: readonly SizedItem[] | null | undefined,
  paneId: string | null | undefined,
): string {
  const items = panes || [];
  const idx = items.findIndex((pane) => pane.id === paneId);
  if (idx < 0) return '';
  const pane = items[idx];
  if (!pane) return '';
  const seq = CIRCLED[idx] ?? String(idx + 1);
  return `${seq} ${pane.command || pane.id}`;
}
