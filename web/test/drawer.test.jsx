import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../src/api.js', () => ({
  getSessions: vi.fn(async () => [{ id: '$1', name: 'main' }, { id: '$2', name: 'server' }]),
  getWindowsForSessions: vi.fn(async (ids) => Object.fromEntries(ids.map((id) => [id, []])),
  ),
}));

import Drawer from '../src/components/Drawer.jsx';

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.removeItem('handmux.drawer.expanded-sessions');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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
