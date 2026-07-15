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
    // two equal side-by-side panes → each 118px wide ((248-12)/2); cells are offset by the 6px gutter,
    // so the left one sits at 6px and the right one at 6+118=124px (no blank at the edges).
    expect(cells[0].style.left).toBe('6px');
    expect(cells[0].style.top).toBe('6px');
    expect(cells[1].style.left).toBe('124px');
    expect(cells[1].style.width).toBe('118px');
    expect(cells[0].textContent).toContain('zsh');
    expect(cells[1].textContent).toContain('node');
  });

  it('map cell tap flashes the chosen tile, then commits the switch and keeps the map open', () => {
    vi.useFakeTimers();
    const onSelectPane = vi.fn();
    render({ ...base, panes: geomPanes, onSelectPane });
    openPaneMenu();
    const cells = container.querySelectorAll('.pane-map-cell');
    fire(cells[1], 'click');
    // brief selection feedback first: the tile flashes and the switch is NOT yet committed
    const flashing = container.querySelectorAll('.pane-map-cell');
    expect(flashing[1].className).toContain('is-picking');      // B lights up
    expect(flashing[0].className).toContain('is-releasing');    // A (the outgoing current) hands off its blue
    expect(onSelectPane).not.toHaveBeenCalled();
    expect(container.querySelector('.pane-map')).not.toBeNull(); // still open during the flash
    // after the flash the switch lands, but the map dwells open (only an outside tap closes it)
    act(() => vi.advanceTimersByTime(250));
    expect(onSelectPane).toHaveBeenCalledWith('%2');
    expect(container.querySelector('.pane-map')).not.toBeNull();
  });

  it('long-pressing a map tile calls onManagePane and does NOT switch', () => {
    vi.useFakeTimers();
    const onSelectPane = vi.fn();
    const onManagePane = vi.fn();
    render({ ...base, panes: geomPanes, onSelectPane, onManagePane });
    openPaneMenu();
    const cells = container.querySelectorAll('.pane-map-cell');
    fire(cells[1], 'pointerdown');
    act(() => vi.advanceTimersByTime(600));
    fire(cells[1], 'pointerup');
    fire(cells[1], 'click'); // the browser click that follows — must be swallowed
    expect(onManagePane).toHaveBeenCalledWith(geomPanes[1].id);
    expect(onSelectPane).not.toHaveBeenCalled();
  });

  it('tapping a map tile switches AND leaves the map open', () => {
    vi.useFakeTimers();
    const onSelectPane = vi.fn();
    render({ ...base, panes: geomPanes, onSelectPane });
    openPaneMenu();
    const cells = container.querySelectorAll('.pane-map-cell');
    fire(cells[1], 'pointerdown');
    fire(cells[1], 'pointerup');
    fire(cells[1], 'click');
    act(() => vi.advanceTimersByTime(250));
    expect(onSelectPane).toHaveBeenCalledWith('%2');
    expect(container.querySelector('.pane-map')).not.toBeNull(); // map still open after the switch
  });

  it('with the pane-manage sheet open, tapping another tile re-points the sheet at it (and still switches)', () => {
    vi.useFakeTimers();
    const onSelectPane = vi.fn();
    const onManagePane = vi.fn();
    // sheet is open (paneSheetOpen) targeting the current pane; tap the OTHER tile
    render({ ...base, panes: geomPanes, paneSheetOpen: true, onSelectPane, onManagePane });
    openPaneMenu();
    const cells = container.querySelectorAll('.pane-map-cell');
    fire(cells[1], 'click');
    // the sheet re-targets to the tapped pane IMMEDIATELY (no flash delay)
    expect(onManagePane).toHaveBeenCalledWith('%2');
    // and the view still switches after the flash, as a normal tap does
    act(() => vi.advanceTimersByTime(250));
    expect(onSelectPane).toHaveBeenCalledWith('%2');
  });

  it('with no sheet open, tapping a tile does NOT re-target any sheet (only switches)', () => {
    vi.useFakeTimers();
    const onManagePane = vi.fn();
    render({ ...base, panes: geomPanes, onManagePane });
    openPaneMenu();
    const cells = container.querySelectorAll('.pane-map-cell');
    fire(cells[1], 'click');
    act(() => vi.advanceTimersByTime(250));
    expect(onManagePane).not.toHaveBeenCalled();
  });

  it('opens the map (no tap) when the window sheet requests it via openMapFor, then clears the request', () => {
    const onMapOpened = vi.fn();
    render({ ...base, panes: geomPanes, openMapFor: '@1', onMapOpened }); // @1 is the active window
    expect(container.querySelector('.pane-map')).not.toBeNull();
    expect(onMapOpened).toHaveBeenCalled();
  });

  it('an outside tap closes the pane map', () => {
    render({ ...base, panes: geomPanes });
    openPaneMenu();
    expect(container.querySelector('.pane-map')).not.toBeNull();
    fire(document.body, 'pointerdown');
    expect(container.querySelector('.pane-map')).toBeNull();
  });

  it('keeps the map open on an outside tap while a pane-manage sheet is open (so split/close can live-refresh it)', () => {
    // The split/close sheet renders on <body>; tapping its actions is "outside" the tab. With the sheet
    // flagged open the map must NOT self-close, so after the operation it re-renders to the new layout.
    render({ ...base, panes: geomPanes, paneSheetOpen: true });
    openPaneMenu();
    expect(container.querySelector('.pane-map')).not.toBeNull();
    fire(document.body, 'pointerdown'); // e.g. tapping 左右分屏 / 关闭此格 on the body-rendered sheet
    expect(container.querySelector('.pane-map')).not.toBeNull();
  });

  it('falls back to the flat list when panes lack geometry', () => {
    render({ ...base, panes }); // fixture panes have no left/top
    openPaneMenu();
    expect(container.querySelector('.pane-map')).toBe(null);
    expect(container.querySelectorAll('.dd-option').length).toBe(2);
  });

  it('degrades a very narrow tile to seq-only so its command is not squished in unreadably', () => {
    // Equal division never makes a tile thin from real ratios — only MANY columns do. Five side-by-side
    // panes → each ~46px wide → narrow, so the command is dropped and only the seq badge remains.
    const fiveCols = [
      { id: '%1', active: true,  command: 'vim',  left: 0,  top: 0, width: 15, height: 24 },
      { id: '%2', active: false, command: 'htop', left: 16, top: 0, width: 15, height: 24 },
      { id: '%3', active: false, command: 'node', left: 32, top: 0, width: 15, height: 24 },
      { id: '%4', active: false, command: 'less', left: 48, top: 0, width: 15, height: 24 },
      { id: '%5', active: false, command: 'tail', left: 64, top: 0, width: 16, height: 24 },
    ];
    render({ ...base, panes: fiveCols, currentPaneId: '%1' });
    openPaneMenu();
    const cells = container.querySelectorAll('.pane-map-cell');
    expect(cells.length).toBe(5);
    expect(cells[1].className).toContain('is-narrow');
    expect(cells[1].textContent).not.toContain('htop'); // command dropped in the cramped cell
    expect(cells[1].textContent).toContain('②');        // but the seq badge keeps it identifiable
  });

  it('clamps the map inside the viewport when the tab sits near the right edge', () => {
    render({ ...base, panes: geomPanes });
    // pin the trigger's anchor rect to the right edge; jsdom innerWidth is 1024, MAP_W 248, MARGIN 8.
    const rootEl = container.querySelector('.wt-dd');
    rootEl.getBoundingClientRect = () => ({ left: 1000, right: 1080, top: 40, bottom: 64, width: 80, height: 24 });
    openPaneMenu();
    const map = container.querySelector('.pane-map');
    // left is pulled back so the whole 248px box stays on-screen (not left: 1000px → off the right).
    expect(parseFloat(map.style.left)).toBe(window.innerWidth - 248 - 8);
    expect(parseFloat(map.style.left) + 248).toBeLessThanOrEqual(window.innerWidth - 8);
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
