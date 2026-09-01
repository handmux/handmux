import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import Inbox from '../src/components/Inbox.jsx';

let container;
let root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const rows = [
  { pane: '%1', session: 'a', window: '@1', windowName: 'edit', view: 'needs', msg: '', ts: 100 },
  { pane: '%2', session: 'a', window: '@2', windowName: 'run', view: 'working', msg: 'build it', ts: 200 },
  { pane: '%3', session: 'b', window: '@9', windowName: 'log', view: 'done', msg: 'fin', ts: 80 },
];
const base = {
  rows, top: 'needs', open: false,
  onToggle: vi.fn(), onClose: vi.fn(), onSelectRow: vi.fn(), onMarkAllRead: vi.fn(),
};
const render = async (props) => { await act(async () => { root.render(<Inbox {...base} {...props} />); }); };

describe('Inbox v2', () => {
  it('shows a colour-coded priority dot; hidden when nothing active', async () => {
    await render({ top: 'needs' });
    expect(container.querySelector('.inbox-dot').className).toBe('inbox-dot needs');
    await render({ top: 'working' });
    expect(container.querySelector('.inbox-dot').className).toBe('inbox-dot working');
    await render({ top: null });
    expect(container.querySelector('.inbox-dot')).toBeNull();
  });
  it('panel closed until open', async () => {
    await render({ open: false });
    expect(container.querySelector('.inbox-panel')).toBeNull();
  });
  it('open groups by session and renders view chips', async () => {
    await render({ open: true });
    expect([...container.querySelectorAll('.inbox-group-title')].map((n) => n.textContent)).toEqual(['a', 'b']);
    const chips = [...container.querySelectorAll('.inbox-chip')].map((c) => [c.className, c.textContent]);
    expect(chips).toContainEqual(['inbox-chip needs', '需要你']);
    expect(chips).toContainEqual(['inbox-chip working', '进行中']);
    expect(chips).toContainEqual(['inbox-chip done', '已完成']);
  });
  it('clicking a row calls onSelectRow with that row', async () => {
    const onSelectRow = vi.fn();
    await render({ open: true, onSelectRow });
    await act(async () => { container.querySelector('.inbox-row').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onSelectRow).toHaveBeenCalledWith(rows[0]);
  });
  it('清除结果 button (shown when a terminal row exists) calls onMarkAllRead', async () => {
    const onMarkAllRead = vi.fn();
    await render({ open: true, onMarkAllRead }); // default rows include a done row (%3)
    const btn = container.querySelector('.inbox-readall');
    expect(btn.textContent).toBe('清除结果');
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onMarkAllRead).toHaveBeenCalled();
  });
  it('shows error as a terminal state and hides clear when no terminal row remains', async () => {
    const noDone = rows.filter((r) => r.view !== 'done'); // only needs + working remain
    await render({ open: true, rows: noDone });
    expect(container.querySelector('.inbox-readall')).toBeNull();
    await render({
      open: true,
      rows: [...noDone, { pane: '%4', session: 'b', window: '@4', view: 'error', msg: 'failed', ts: 90 }],
    });
    expect(container.querySelector('.inbox-row .inbox-chip.error')?.textContent).toBe('出错');
    expect(container.querySelector('.inbox-summary .inbox-chip.error')?.textContent).toBe('出错 1');
    expect(container.querySelector('.inbox-readall')?.textContent).toBe('清除结果');
  });
  it('empty state when no rows', async () => {
    await render({ open: true, rows: [] });
    expect(container.querySelector('.inbox-empty')).not.toBeNull();
  });
  it('renders the per-view tally in the panel header (进行中/已完成/需要你)', async () => {
    await render({ open: true }); // default rows: 1 needs, 1 working, 1 done
    const summary = container.querySelector('.inbox-head .inbox-summary');
    expect(summary).not.toBeNull(); // lives in the header, in line with the 收件箱 title
    expect(summary.textContent).toContain('进行中 1');
    expect(summary.textContent).toContain('已完成 1');
    expect(summary.textContent).toContain('需要你 1');
  });
  it('toggle fires onToggle', async () => {
    const onToggle = vi.fn();
    await render({ onToggle });
    await act(async () => { container.querySelector('.inbox-btn').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onToggle).toHaveBeenCalled();
  });
  it('falls back to the window id when windowName is empty (tmux can return none)', async () => {
    const nameless = [{ pane: '%9', session: 'a', window: '@7', windowName: '', view: 'done', msg: '', ts: 1 }];
    await render({ open: true, rows: nameless });
    expect(container.querySelector('.inbox-loc').textContent).toBe('@7');
  });
});
