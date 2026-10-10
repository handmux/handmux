import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../src/api.js', () => ({
  getSessions: vi.fn(async () => [
    { id: '$1', name: 'main' },
    { id: '$2', name: 'server' },
  ]),
  getSessionTopology: vi.fn(async () => [
    { session: { id: '$1', name: 'main' }, windows: [] },
    { session: { id: '$2', name: 'server' }, windows: [] },
  ]),
  getPanes: vi.fn(async () => []),
}));

import Drawer from '../src/components/Drawer.jsx';
import { getPanes, getSessions, getSessionTopology } from '../src/api.js';

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.removeItem('handmux.drawer.expanded-sessions');
  getSessions.mockReset();
  getSessions.mockResolvedValue([
    { id: '$1', name: 'main' },
    { id: '$2', name: 'server' },
  ]);
  getSessionTopology.mockReset();
  getSessionTopology.mockResolvedValue([
    { session: { id: '$1', name: 'main' }, windows: [] },
    { session: { id: '$2', name: 'server' }, windows: [] },
  ]);
  getPanes.mockReset();
  getPanes.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const base = {
  open: true,
  bound: ['main', 'server'],
  onSelectSession: vi.fn(),
  onUnbind: vi.fn(),
  onBind: vi.fn(),
  onClose: vi.fn(),
  onLogout: vi.fn(),
};

const render = async (props) => {
  await act(async () => { root.render(<Drawer {...base} {...props} />); });
};

const waitForSessions = async () => {
  await vi.waitFor(() => expect(container.querySelectorAll('.session-section')).toHaveLength(2));
};

const dispatchTouch = (target, type, x, y) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  if (type !== 'touchend' && type !== 'touchcancel') {
    Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] });
  }
  target.dispatchEvent(event);
};

describe('Drawer (bound sessions)', () => {
  it('lists the locally bound session names', async () => {
    await render({ currentSessionName: 'main' });
    await waitForSessions();
    const names = [...container.querySelectorAll('.session-section-title')].map((n) => n.textContent);
    expect(names).toEqual(['main', 'server']);
  });

  it('requests topology only for expanded bound sessions', async () => {
    getSessionTopology.mockClear();
    localStorage.setItem('handmux.drawer.expanded-sessions', JSON.stringify({ main: true, server: false }));
    await render();
    await waitForSessions();
    expect(getSessionTopology).toHaveBeenCalledWith(['$1']);
  });

  it('keeps another expanded Session visible while a newly expanded one loads', async () => {
    getSessionTopology.mockClear();
    getSessionTopology.mockImplementation(async (ids) => ids.map((id) => ({
      session: { id, name: id === '$1' ? 'main' : 'server' },
      windows: [{ id: id === '$1' ? '@1' : '@2', name: id === '$1' ? 'main-window' : 'server-window', panes: 1 }],
    })));
    localStorage.setItem('handmux.drawer.expanded-sessions', JSON.stringify({ main: false, server: true }));
    await render();
    await waitForSessions();
    expect(container.querySelector('[data-window-id="@2"]')).not.toBeNull();

    const main = [...container.querySelectorAll('.session-section-title')].find((node) => node.textContent === 'main');
    await act(async () => { main.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await vi.waitFor(() => expect(container.querySelector('[data-window-id="@1"]')).not.toBeNull());
    expect(container.querySelector('[data-window-id="@2"]')).not.toBeNull();
    expect(getSessionTopology).toHaveBeenLastCalledWith(['$1']);
  });

  it('does not refresh an older expanded Session when another Session opens after the cache interval', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let finishMain;
    getSessionTopology.mockImplementationOnce(async () => [{
      session: { id: '$2', name: 'server' },
      windows: [{ id: '@2', name: 'server-window', panes: 1 }],
    }]);
    getSessionTopology.mockImplementationOnce(() => new Promise((resolve) => { finishMain = resolve; }));
    localStorage.setItem('handmux.drawer.expanded-sessions', JSON.stringify({ main: false, server: true }));
    await render();
    await waitForSessions();
    expect(container.querySelector('[data-window-id="@2"]')).not.toBeNull();

    now = 7_000;
    const main = [...container.querySelectorAll('.session-section-title')].find((node) => node.textContent === 'main');
    await act(async () => { main.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(getSessionTopology).toHaveBeenCalledTimes(2);
    expect(getSessionTopology).toHaveBeenLastCalledWith(['$1']);
    expect(container.querySelector('[data-window-id="@2"]')).not.toBeNull();

    await act(async () => finishMain([{
      session: { id: '$1', name: 'main' },
      windows: [{ id: '@1', name: 'main-window', panes: 1 }],
    }]));
    expect(container.querySelector('[data-window-id="@1"]')).not.toBeNull();
    expect(container.querySelector('[data-window-id="@2"]')).not.toBeNull();
  });

  it('shows the empty state when nothing is bound', async () => {
    await render({ bound: [], currentSessionName: null });
    expect(container.querySelector('.session-section-title')).toBeNull();
    expect(container.querySelector('.drawer-empty')).not.toBeNull();
  });

  it('highlights the current session', async () => {
    await render({ currentSessionName: 'server' });
    await waitForSessions();
    const rows = [...container.querySelectorAll('.session-section')];
    const server = rows.find((r) => r.textContent.includes('server'));
    const main = rows.find((r) => r.textContent.includes('main'));
    expect(server.className).toContain('is-current');
    expect(main.className).not.toContain('is-current');
  });

  it('shows the tmux session id in its management sheet, not in the session list', async () => {
    await render();
    await waitForSessions();
    expect(container.querySelector('.session-section-title').textContent).toBe('main');
    await act(async () => {
      container.querySelector('.session-section-menu').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('.settings-subtitle')?.textContent).toBe('main · $1');
  });

  it('shows a compact status dot on sessions with inbox activity', async () => {
    await render({ sessionInboxViews: { server: 'working' } });
    await waitForSessions();
    const server = [...container.querySelectorAll('.session-section')].find((r) => r.textContent.includes('server'));
    const main = [...container.querySelectorAll('.session-section')].find((r) => r.textContent.includes('main'));
    expect(server.querySelector('.session-inbox-dot.working')?.getAttribute('aria-label')).toBe('进行中');
    expect(main.querySelector('.session-inbox-dot')).toBeNull();
  });

  it('shows the Agent mark and puts non-default pane Inbox activity on the switcher', async () => {
    getSessionTopology.mockResolvedValueOnce([
      { session: { id: '$1', name: 'main' }, windows: [{ id: '@1', name: 'main', panes: 2, activePaneId: '%10', paneList: [
        { id: '%10', index: 0, active: true, command: 'zsh' },
        { id: '%11', index: 1, command: 'node' },
      ] }, { id: '@2', name: 'shell', panes: 1 }] },
      { session: { id: '$2', name: 'server' }, windows: [] },
    ]);
    await render({
      windowAgents: { '@1': 'codex' },
      paneInboxViews: { '%11': 'needs', '%12': 'working' },
    });
    await waitForSessions();
    const row = container.querySelector('[data-window-id="@1"]');
    expect(row.querySelector('.agent-mark')?.getAttribute('aria-label')).toBe('codex');
    expect(row.querySelector('.session-window-pane-value')?.textContent).toBe('①');
    const dot = row.querySelector('.session-window-pane-inbox-dot.needs');
    expect(dot?.getAttribute('aria-label')).toBe('需要你');
    expect(row.querySelector('.session-window-inbox-dot')).toBeNull();
    expect(row.querySelector('.inbox-chip')).toBeNull();
    expect(dot?.parentElement).toBe(row.querySelector('.session-window-pane-trigger'));
    expect(row.querySelector('.agent-mark')?.nextElementSibling).toBe(row.querySelector('.session-window-label'));
    const singlePane = container.querySelector('[data-window-id="@2"]');
    expect(singlePane.querySelector('.session-window-pane-value')).toBeNull();
    expect(singlePane.querySelector('.session-window-pane-inbox-dot')).toBeNull();
  });

  it('keeps the selected pane Inbox activity on the Window row', async () => {
    getSessions.mockResolvedValueOnce([{ id: '$1', name: 'handmux' }]);
    getSessionTopology.mockResolvedValueOnce([
      { session: { id: '$1', name: 'handmux' }, windows: [{ id: '@1', name: 'main', panes: 2, activePaneId: '%1', paneList: [
        { id: '%1', command: 'zsh' },
        { id: '%2', command: 'node' },
      ] }] },
    ]);
    await render({
      bound: ['handmux'],
      paneInboxViews: { '%1': 'working', '%2': 'needs' },
    });
    await vi.waitFor(() => expect(container.querySelectorAll('.session-section')).toHaveLength(1));
    const row = container.querySelector('[data-window-id="@1"]');
    expect(row.querySelector('.session-window-inbox-dot.working')?.getAttribute('aria-label')).toBe('进行中');
    expect(row.querySelector('.session-window-pane-inbox-dot.needs')?.getAttribute('aria-label')).toBe('需要你');
  });

  it('hides the single-pane count and opens a switcher for multi-pane Windows', async () => {
    const onSelectSession = vi.fn();
    getSessionTopology.mockResolvedValueOnce([
      { session: { id: '$1', name: 'main' }, windows: [{ id: '@1', name: 'main', panes: 2, paneList: [
        { id: '%1', command: 'zsh', agent: null },
        { id: '%2', command: 'node', agent: 'codex' },
      ] }, { id: '@2', name: 'shell', panes: 1 }] },
      { session: { id: '$2', name: 'server' }, windows: [] },
    ]);
    await render({ onSelectSession, currentSessionName: 'main', currentWindowId: '@1', currentPaneId: '%2', currentPanes: [
      { id: '%1', command: 'zsh', agent: null },
      { id: '%2', command: 'node', agent: 'codex' },
    ] });
    await waitForSessions();
    const multi = container.querySelector('[data-window-id="@1"]');
    const single = container.querySelector('[data-window-id="@2"]');
    expect(multi.querySelector('.session-window-pane-value')?.textContent).toBe('②');
    expect(single.querySelector('.session-window-pane-value')).toBeNull();
    await act(async () => {
      multi.querySelector('.session-window-pane-trigger').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const options = document.querySelectorAll('.drawer-pane-menu .dd-option');
    expect(options).toHaveLength(2);
    expect(options[1].className).toContain('is-selected');
    expect(options[1].textContent).toContain('node');
    expect(options[1].querySelector('.agent-mark')?.getAttribute('aria-label')).toBe('codex');
    expect(multi.querySelector('.session-window-pane-value')?.textContent).toBe('②');
    await act(async () => {
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectSession).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%1' }));
  });

  it('selects the active pane on a Window row instead of an Inbox pane', async () => {
    const onSelectSession = vi.fn();
    getSessionTopology.mockResolvedValueOnce([
      { session: { id: '$1', name: 'main' }, windows: [{ id: '@1', name: 'main', panes: 2, activePaneId: '%1' }] },
      { session: { id: '$2', name: 'server' }, windows: [] },
    ]);
    await render({ onSelectSession });
    await waitForSessions();
    await act(async () => {
      container.querySelector('[data-window-id="@1"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectSession).toHaveBeenCalledWith(expect.objectContaining({
      window: expect.objectContaining({ id: '@1' }), paneId: '%1',
    }));
  });

  it('clicking a name toggles its Window list', async () => {
    await render();
    await waitForSessions();
    const server = [...container.querySelectorAll('.session-section-title')].find((n) => n.textContent === 'server');
    const before = container.querySelectorAll('.session-section-body.is-open').length;
    await act(async () => { server.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelectorAll('.session-section-body.is-open')).toHaveLength(before - 1);
  });

  it('opens from an edge right swipe and closes from an in-drawer left swipe', async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    await render({ open: false, onOpen, onClose });
    await act(async () => {
      dispatchTouch(window, 'touchstart', 12, 180);
      dispatchTouch(window, 'touchmove', 150, 182);
      dispatchTouch(window, 'touchend');
    });
    expect(onOpen).toHaveBeenCalledTimes(1);

    await render({ open: true, onOpen, onClose });
    const drawer = container.querySelector('.drawer-backdrop');
    await act(async () => {
      dispatchTouch(drawer, 'touchstart', 300, 180);
      dispatchTouch(window, 'touchmove', 120, 182);
      dispatchTouch(window, 'touchend');
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens from the center of the page when no horizontal scroller can consume the swipe', async () => {
    const onOpen = vi.fn();
    await render({ open: false, onOpen });
    await act(async () => {
      dispatchTouch(window, 'touchstart', 180, 180);
      dispatchTouch(window, 'touchmove', 300, 182);
      dispatchTouch(window, 'touchend');
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does not claim horizontal swipes from the BottomDock chat page', async () => {
    const onOpen = vi.fn();
    await render({ open: false, onOpen });
    const dock = document.createElement('div');
    dock.className = 'bottom-dock';
    dock.dataset.dockMode = 'agent';
    document.body.appendChild(dock);
    await act(async () => {
      dispatchTouch(dock, 'touchstart', 180, 180);
      dispatchTouch(window, 'touchmove', 300, 182);
      dispatchTouch(window, 'touchend');
    });
    expect(onOpen).not.toHaveBeenCalled();
    dock.remove();
  });

  it('does not open while dragging an active chat copy selection', async () => {
    const onOpen = vi.fn();
    await render({ open: false, onOpen });
    const copySurface = document.createElement('div');
    copySurface.className = 'chat-view chat-copy-active';
    document.body.appendChild(copySurface);
    await act(async () => {
      dispatchTouch(copySurface, 'touchstart', 40, 180);
      dispatchTouch(window, 'touchmove', 220, 182);
      dispatchTouch(window, 'touchend');
    });
    expect(onOpen).not.toHaveBeenCalled();
    copySurface.remove();
  });

  it('does not open while dragging an active terminal copy selection', async () => {
    const onOpen = vi.fn();
    await render({ open: false, onOpen });
    const terminalSurface = document.createElement('div');
    terminalSurface.className = 'terminal-wrap terminal-copy-active';
    document.body.appendChild(terminalSurface);
    await act(async () => {
      dispatchTouch(terminalSurface, 'touchstart', 40, 180);
      dispatchTouch(window, 'touchmove', 220, 182);
      dispatchTouch(window, 'touchend');
    });
    expect(onOpen).not.toHaveBeenCalled();
    terminalSurface.remove();
  });

  it('cancels a pending drawer swipe when text selection starts', async () => {
    const onOpen = vi.fn();
    await render({ open: false, onOpen });
    const text = document.createTextNode('select me');
    document.body.appendChild(text);
    await act(async () => {
      dispatchTouch(text.parentElement || document.body, 'touchstart', 40, 180);
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(text);
      selection?.removeAllRanges();
      selection?.addRange(range);
      dispatchTouch(window, 'touchmove', 220, 182);
      dispatchTouch(window, 'touchend');
    });
    expect(onOpen).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
    text.remove();
  });

  it('cancels a pending drawer swipe when chat copy mode activates after touchstart', async () => {
    const onOpen = vi.fn();
    await render({ open: false, onOpen });
    const copySurface = document.createElement('div');
    copySurface.className = 'chat-view';
    document.body.appendChild(copySurface);
    await act(async () => {
      dispatchTouch(copySurface, 'touchstart', 40, 180);
      copySurface.classList.add('chat-copy-active');
      dispatchTouch(window, 'touchmove', 220, 182);
      dispatchTouch(window, 'touchend');
    });
    expect(onOpen).not.toHaveBeenCalled();
    copySurface.remove();
  });

  it('does not open while swiping a horizontal window tab strip', async () => {
    const onOpen = vi.fn();
    await render({ open: false, onOpen });
    const tabs = document.createElement('div');
    tabs.className = 'windowbar-scroll';
    document.body.appendChild(tabs);
    await act(async () => {
      dispatchTouch(tabs, 'touchstart', 40, 180);
      dispatchTouch(window, 'touchmove', 220, 182);
      dispatchTouch(window, 'touchend');
    });
    expect(onOpen).not.toHaveBeenCalled();
    tabs.remove();
  });

  it('leaves a horizontally scrolled control in charge until it reaches its left edge', async () => {
    const onOpen = vi.fn();
    await render({ open: false, onOpen });
    const scroller = document.createElement('div');
    scroller.style.overflowX = 'auto';
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 300 },
      scrollLeft: { configurable: true, writable: true, value: 40 },
    });
    document.body.appendChild(scroller);
    await act(async () => {
      dispatchTouch(scroller, 'touchstart', 180, 180);
      dispatchTouch(scroller, 'touchmove', 300, 182);
      dispatchTouch(scroller, 'touchend');
    });
    expect(onOpen).not.toHaveBeenCalled();
    scroller.scrollLeft = 0;
    await act(async () => {
      dispatchTouch(scroller, 'touchstart', 180, 180);
      dispatchTouch(scroller, 'touchmove', 300, 182);
      dispatchTouch(scroller, 'touchend');
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    scroller.remove();
  });

  it('does not turn a vertical drawer scroll into a close gesture', async () => {
    const onClose = vi.fn();
    await render({ open: true, onClose });
    const drawer = container.querySelector('.drawer');
    await act(async () => {
      dispatchTouch(drawer, 'touchstart', 180, 180);
      dispatchTouch(window, 'touchmove', 184, 260);
      dispatchTouch(window, 'touchend');
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens Session actions from the overflow menu and unbinds without selecting', async () => {
    const onUnbind = vi.fn();
    const onSelectSession = vi.fn();
    await render({ onUnbind, onSelectSession });
    await waitForSessions();
    const row = [...container.querySelectorAll('.session-section')].find((r) => r.textContent.includes('main'));
    await act(async () => {
      row.querySelector('.session-section-menu').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const unbind = [...container.querySelectorAll('.sheet-action')].find((button) => button.textContent.includes('解绑'));
    await act(async () => { unbind.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onUnbind).toHaveBeenCalledWith('main');
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('the bind button opens the bind flow', async () => {
    const onBind = vi.fn();
    await render({ onBind });
    await act(async () => {
      container.querySelector('.drawer-bind').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onBind).toHaveBeenCalled();
  });

  it('opens Settings from the top-right drawer button', async () => {
    const onOpenSettings = vi.fn();
    await render({ onOpenSettings });
    await act(async () => {
      container.querySelector('.drawer-settings').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  describe('未接管会话 (orphans)', () => {
    const orphans = [
      { pid: 100, cwd: '/u/idle', cwdLabel: 'idle', sessionId: 's-idle', state: 'idle', snippet: 'resume me' },
      { pid: 200, cwd: '/u/busy', cwdLabel: 'busy', sessionId: 's-busy', state: 'busy', snippet: 'running' },
      { pid: 300, cwd: '/u/nohist', cwdLabel: 'nohist', sessionId: null, state: 'idle', snippet: '' },
    ];

    it('no section when there are no orphans', async () => {
      await render({ orphans: [] });
      expect(container.querySelector('.drawer-orphans')).toBeNull();
    });

    it('shows a collapsed count; expands to takeover rows', async () => {
      await render({ orphans });
      const head = container.querySelector('.drawer-orphans-head');
      expect(head.textContent).toContain('3');
      expect(container.querySelector('.drawer-orphan-btn')).toBeNull(); // collapsed
      await act(async () => { head.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect([...container.querySelectorAll('.drawer-orphan-btn')]).toHaveLength(3);
    });

    it('接管 fires onTakeoverRequest for idle; disabled for busy / no history', async () => {
      const onTakeoverRequest = vi.fn();
      await render({ orphans, onTakeoverRequest });
      await act(async () => { container.querySelector('.drawer-orphans-head').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const btns = [...container.querySelectorAll('.drawer-orphan-btn')];
      expect(btns[0].disabled).toBe(false); // idle + session
      expect(btns[1].disabled).toBe(true);  // busy
      expect(btns[2].disabled).toBe(true);  // no resumable history
      expect(btns[2].getAttribute('title')).toBe('无可续接的历史');
      await act(async () => { btns[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(onTakeoverRequest).toHaveBeenCalledWith(orphans[0]);
    });
  });
});
