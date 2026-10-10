const CIRCLED = '①②③④⑤⑥⑦⑧⑨';

interface SizedItem {
  id?: string;
  name?: string;
  command?: string | null;
  width?: number | null;
  height?: number | null;
}

const dimensions = (item: SizedItem | null | undefined): string => {
  if (!item || !Number.isFinite(item.width) || !Number.isFinite(item.height)) return '';
  return `${item.width}×${item.height}`;
};

const withDimensions = (label: string, item: SizedItem): string => {
  const dims = dimensions(item);
  return dims ? `${label} · ${dims}` : label;
};

export function windowManageSubtitle(win: SizedItem | null | undefined): string {
  if (!win) return '';
  return withDimensions(win.name || win.id || '', win);
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
