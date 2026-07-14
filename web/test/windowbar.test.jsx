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

  it('each pane in the menu carries its OWN agent logo — two different agents render distinctly, a shell shows none', () => {
    render({ ...base, paneAgents: { '%1': 'claude', '%2': 'codex' } });
    fire(container.querySelector('.wt-trigger'), 'click');
    const opts = container.querySelectorAll('.wt-menu [role="option"]');
    expect(opts[0].querySelector('.agent-mark')?.getAttribute('aria-label')).toBe('claude');
    expect(opts[1].querySelector('.agent-mark')?.getAttribute('aria-label')).toBe('codex');
  });

  it('a menu pane with no agent (a shell) shows no logo', () => {
    render({ ...base, paneAgents: { '%1': 'claude' } }); // %2 has no agent
    fire(container.querySelector('.wt-trigger'), 'click');
    const opts = container.querySelectorAll('.wt-menu [role="option"]');
    expect(opts[0].querySelector('.agent-mark')).not.toBeNull(); // %1 = claude
    expect(opts[1].querySelector('.agent-mark')).toBeNull();     // %2 = shell → no logo
  });

  it("the active multi-pane tab's logo follows the CURRENT pane, not the window aggregate", () => {
    // Current pane (%1) has no agent, but the window aggregate says claude (from the other pane). The tab
    // must stay logo-less — so exiting the agent in the pane you're on clears it, instead of a sibling
    // pane's agent keeping it lit.
    render({ ...base, currentAgent: undefined, windowAgents: { '@1': 'claude' } });
    expect(container.querySelector('.wt-trigger .agent-mark')).toBeNull();
  });

  it("the active multi-pane tab shows the current pane's own agent logo when it has one", () => {
    render({ ...base, currentAgent: 'claude' });
    expect(container.querySelector('.wt-trigger .agent-mark')?.getAttribute('aria-label')).toBe('claude');
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

  const geomPanes = [
    { id: '%1', active: true,  command: 'zsh',  left: 0,  top: 0, width: 40, height: 24 },
    { id: '%2', active: false, command: 'node', left: 40, top: 0, width: 40, height: 24 },
  ];

  const openPaneMenu = () => {
    fire(container.querySelector('.wt-trigger'), 'click');
  };

  it('opens a proportional pane map: one cell per pane with seq + command', () => {
    render({ ...base, panes: geomPanes });
    openPaneMenu();
    const cells = container.querySelectorAll('.pane-map-cell');
    expect(cells.length).toBe(2);
    // right-hand pane sits at 50% left, half width (from paneRects)
    expect(cells[1].style.left).toBe('50%');
    expect(cells[1].style.width).toBe('50%');
    expect(cells[0].textContent).toContain('zsh');
    expect(cells[1].textContent).toContain('node');
  });

  it('map cell tap selects that pane and closes the map', () => {
    const onSelectPane = vi.fn();
    render({ ...base, panes: geomPanes, onSelectPane });
    openPaneMenu();
    const cells = container.querySelectorAll('.pane-map-cell');
    fire(cells[1], 'click');
    expect(onSelectPane).toHaveBeenCalledWith('%2');
    expect(container.querySelector('.pane-map')).toBe(null); // closed
  });

  it('falls back to the flat list when panes lack geometry', () => {
    render({ ...base, panes }); // fixture panes have no left/top
    openPaneMenu();
    expect(container.querySelector('.pane-map')).toBe(null);
    expect(container.querySelectorAll('.dd-option').length).toBe(2);
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
