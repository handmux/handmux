import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import WindowBar from '../src/components/WindowBar.jsx';

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
  vi.useRealTimers();
});

const render = (props) => act(() => root.render(<WindowBar {...props} />));
const fire = (node, type, EventCtor = MouseEvent) =>
  act(() => node.dispatchEvent(new EventCtor(type, { bubbles: true })));

const windows = [
  { id: '@1', name: 'main', active: true, panes: 2 },
  { id: '@2', name: 'server', active: false, panes: 1 },
];
const panes = [
  { id: '%1', active: true, command: 'zsh' },
  { id: '%2', active: false, command: 'node' },
];
const base = {
  windows, currentWindowId: '@1', panes, currentPaneId: '%1',
  onSelectWindow: vi.fn(), onSelectPane: vi.fn(), onNewWindow: vi.fn(), onManageWindow: vi.fn(),
};

describe('WindowBar', () => {
  it('renders a tab per window and highlights the current one', () => {
    render({ ...base, onSelectWindow: vi.fn(), onSelectPane: vi.fn() });
    const tabs = container.querySelectorAll('[data-win]');
    expect(tabs.length).toBe(2);
    expect(container.querySelector('[data-win="@1"]').className).toContain('active');
    expect(container.querySelector('[data-win="@2"]').className).not.toContain('active');
  });

  it('clicking a window tab calls onSelectWindow with that window', () => {
    const onSelectWindow = vi.fn();
    render({ ...base, onSelectWindow, onSelectPane: vi.fn() });
    fire(container.querySelector('[data-win="@2"]'), 'click');
    expect(onSelectWindow).toHaveBeenCalledWith(windows[1]);
  });

  it('the active multi-pane window expands inline, showing its name and the current pane (no native select)', () => {
    render({ ...base });
    const tab = container.querySelector('[data-win="@1"]');
    expect(container.querySelector('select')).toBeNull(); // the old native <select> is gone
    expect(tab.querySelector('.wt-name').textContent).toContain('main');
    expect(tab.querySelector('.wt-pane').textContent).toContain('zsh'); // current pane shown inline
    expect(container.querySelector('.wt-menu')).toBeNull(); // menu closed until tapped
  });

  it('tapping the expanded tab opens a pane menu with the current pane pre-selected', () => {
    render({ ...base });
    fire(container.querySelector('.wt-trigger'), 'click');
    const opts = container.querySelectorAll('.wt-menu [role="option"]');
    expect(opts.length).toBe(2);
    expect(opts[0].textContent).toContain('zsh');
    expect(opts[1].textContent).toContain('node');
    expect(opts[0].getAttribute('aria-selected')).toBe('true'); // %1 is current
    expect(opts[0].className).toContain('is-selected');
  });

  it('picking a pane from the menu calls onSelectPane and closes the menu', () => {
    const onSelectPane = vi.fn();
    render({ ...base, onSelectPane });
    fire(container.querySelector('.wt-trigger'), 'click');
    fire(container.querySelectorAll('.wt-menu [role="option"]')[1], 'click');
    expect(onSelectPane).toHaveBeenCalledWith('%2');
    expect(container.querySelector('.wt-menu')).toBeNull(); // closed after a pick
  });

  it('a single-pane active window shows no pane control — just the plain window tab', () => {
    render({
      ...base,
      windows: [{ id: '@1', name: 'main', active: true, panes: 1 }],
      panes: [{ id: '%1', active: true, command: 'zsh' }],
      currentPaneId: '%1',
    });
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector('.wt-trigger')).toBeNull(); // not expanded into a pane control
    const tab = container.querySelector('[data-win="@1"]');
    expect(tab.querySelector('.wt-caret')).toBeNull();
    expect(tab.textContent).toContain('main');
  });

  it('renders a "+" new-window button that is not counted as a window tab', () => {
    render({ ...base });
    expect(container.querySelector('.win-new')).not.toBeNull();
    expect(container.querySelectorAll('[data-win]').length).toBe(2); // the "+" has no data-win
  });

  it('clicking "+" calls onNewWindow', () => {
    const onNewWindow = vi.fn();
    render({ ...base, onNewWindow });
    fire(container.querySelector('.win-new'), 'click');
    expect(onNewWindow).toHaveBeenCalled();
  });

  it('shows a multi-pane count badge on an INACTIVE tab, but not for single-pane windows', () => {
    render({
      ...base,
      currentWindowId: '@2',
      windows: [
        { id: '@1', name: 'main', active: false, panes: 2 }, // inactive multi-pane → count badge
        { id: '@2', name: 'server', active: true, panes: 1 }, // active single-pane → no control
      ],
      panes: [{ id: '%9', active: true, command: 'zsh' }],
      currentPaneId: '%9',
    });
    const t1 = container.querySelector('[data-win="@1"]'); // inactive, panes: 2
    const t2 = container.querySelector('[data-win="@2"]'); // active, panes: 1
    expect(t1.textContent).toContain('main');
    expect(t1.querySelector('.win-panes').textContent).toBe('2');
    expect(t2.querySelector('.win-panes')).toBeNull();
  });

  it('long-pressing a window tab calls onManageWindow with that window (not onSelectWindow)', () => {
    vi.useFakeTimers();
    const onManageWindow = vi.fn();
    const onSelectWindow = vi.fn();
    render({ ...base, onManageWindow, onSelectWindow });
    const tab = container.querySelector('[data-win="@2"]');
    fire(tab, 'pointerdown');
    act(() => vi.advanceTimersByTime(500));
    fire(tab, 'pointerup');
    fire(tab, 'click'); // post-longpress click is suppressed → no select
    expect(onManageWindow).toHaveBeenCalledWith(windows[1]);
    expect(onSelectWindow).not.toHaveBeenCalled();
  });

  it('scrolls the tracked window tab into view on mount and when the order changes', () => {
    const orig = Element.prototype.scrollIntoView;
    let scrolledEl = null;
    Element.prototype.scrollIntoView = vi.fn(function () { scrolledEl = this; });
    try {
      render({ ...base, trackWindowId: '@2' });
      expect(scrolledEl).toBe(container.querySelector('[data-win="@2"]')); // managed tab pulled into view

      scrolledEl = null;
      render({ ...base, windows: [windows[1], windows[0]], trackWindowId: '@2' }); // reordered
      expect(scrolledEl).toBe(container.querySelector('[data-win="@2"]')); // still tracked after the move
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it('does not auto-scroll when no window is being tracked', () => {
    const orig = Element.prototype.scrollIntoView;
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    try {
      render({ ...base }); // trackWindowId undefined
      expect(spy).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it('a short tap on a tab still selects (no long-press)', () => {
    vi.useFakeTimers();
    const onManageWindow = vi.fn();
    const onSelectWindow = vi.fn();
    render({ ...base, onManageWindow, onSelectWindow });
    const tab = container.querySelector('[data-win="@2"]');
    fire(tab, 'pointerdown');
    fire(tab, 'pointerup');
    fire(tab, 'click');
    expect(onSelectWindow).toHaveBeenCalledWith(windows[1]);
    expect(onManageWindow).not.toHaveBeenCalled();
  });
});
