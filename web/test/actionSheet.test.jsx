import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ActionSheet from '../src/components/ActionSheet.jsx';

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (props) => act(() => root.render(<ActionSheet {...props} />));
const fire = (node, type) => act(() => node.dispatchEvent(new MouseEvent(type, { bubbles: true })));
const sheetBtns = () => [...container.querySelectorAll('.sheet-action')];

describe('ActionSheet', () => {
  it('renders one button per action plus 取消', () => {
    render({ open: true, title: 'w', onClose: vi.fn(), actions: [
      { key: 'rename', label: '重命名', onClick: vi.fn() },
    ] });
    expect(sheetBtns().length).toBe(1);
    expect(container.querySelector('.sheet-cancel')).not.toBeNull();
  });

  it('renders a quiet subtitle under the fixed management title', () => {
    render({ open: true, title: '窗口管理', subtitle: 'work · 160×48', onClose: vi.fn(), actions: [] });
    expect(container.querySelector('.settings-title').textContent).toBe('窗口管理');
    expect(container.querySelector('.settings-subtitle').textContent).toBe('work · 160×48');
    expect(container.querySelector('[role="dialog"]').getAttribute('aria-label')).toBe('窗口管理，work · 160×48');
  });

  it('a plain action fires its onClick immediately', () => {
    const onClick = vi.fn();
    render({ open: true, title: 'w', onClose: vi.fn(), actions: [{ key: 'rename', label: '重命名', onClick }] });
    fire(sheetBtns()[0], 'click');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a confirm action needs two taps; the first arms it and swaps the label', () => {
    const onClick = vi.fn();
    render({ open: true, title: 'w', onClose: vi.fn(), actions: [
      { key: 'del', label: '删除窗口', danger: true, confirm: true, confirmLabel: '确认删除?再点一次', onClick },
    ] });
    fire(sheetBtns()[0], 'click');
    expect(onClick).not.toHaveBeenCalled();
    expect(sheetBtns()[0].textContent).toContain('确认删除');
    fire(sheetBtns()[0], 'click');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a disabled action renders disabled and never fires onClick', () => {
    const onClick = vi.fn();
    render({ open: true, title: 'w', onClose: vi.fn(), actions: [
      { key: 'left', label: '◀ 左移', disabled: true, onClick },
    ] });
    const btn = sheetBtns()[0];
    expect(btn.disabled).toBe(true);
    fire(btn, 'click');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders an array action entry as one row of side-by-side buttons', () => {
    const onRight = vi.fn();
    render({ open: true, title: 'w', onClose: vi.fn(), actions: [
      [{ key: 'left', label: '◀ 左移', onClick: vi.fn() }, { key: 'right', label: '右移 ▶', onClick: onRight }],
      { key: 'rename', label: '重命名', onClick: vi.fn() },
    ] });
    const row = container.querySelector('.sheet-row');
    expect(row).not.toBeNull();
    expect(row.querySelectorAll('.sheet-action').length).toBe(2);
    fire(row.querySelectorAll('.sheet-action')[1], 'click');
    expect(onRight).toHaveBeenCalledTimes(1);
  });

  it('clicking 取消 calls onClose', () => {
    const onClose = vi.fn();
    render({ open: true, title: 'w', onClose, actions: [] });
    fire(container.querySelector('.sheet-cancel'), 'click');
    expect(onClose).toHaveBeenCalled();
  });

  it('returns null when open=false', () => {
    render({ open: false, title: 'w', onClose: vi.fn(), actions: [{ key: 'x', label: 'x', onClick: vi.fn() }] });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('tapping a plain action after arming a confirm action fires the plain one (and disarms)', () => {
    const onDelete = vi.fn();
    const onRename = vi.fn();
    render({ open: true, title: 'w', onClose: vi.fn(), actions: [
      { key: 'rename', label: '重命名', onClick: onRename },
      { key: 'del', label: '删除窗口', danger: true, confirm: true, confirmLabel: '确认删除?再点一次', onClick: onDelete },
    ] });
    fire(sheetBtns()[1], 'click'); // arm delete
    expect(onDelete).not.toHaveBeenCalled();
    fire(sheetBtns()[0], 'click'); // tap rename (plain) — fires immediately, delete stays unfired
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });
});
