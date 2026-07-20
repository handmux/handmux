const CIRCLED = '①②③④⑤⑥⑦⑧⑨';

const dimensions = (item) => (
  Number.isFinite(item?.width) && Number.isFinite(item?.height)
    ? `${item.width}×${item.height}`
    : ''
);

const withDimensions = (label, item) => {
  const dims = dimensions(item);
  return dims ? `${label} · ${dims}` : label;
};

export function windowManageSubtitle(win) {
  if (!win) return '';
  return withDimensions(win.name || win.id || '', win);
}

export function paneManageSubtitle(panes, paneId) {
  const idx = (panes || []).findIndex((pane) => pane.id === paneId);
  if (idx < 0) return '';
  const pane = panes[idx];
  const seq = idx < CIRCLED.length ? CIRCLED[idx] : String(idx + 1);
  return withDimensions(`${seq} ${pane.command || pane.id}`, pane);
}
