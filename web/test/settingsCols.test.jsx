import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const { getPanes } = vi.hoisted(() => ({ getPanes: vi.fn() }));

vi.mock('../src/push.js', () => ({
  notifyEnabled: () => false, enableNotifications: vi.fn(), disableNotifications: vi.fn(), pushSupported: () => false,
}));
vi.mock('../src/api.js', () => ({
  fetchPaneCwd: vi.fn(async () => ({ cwd: '/home/u/proj' })),
  getPanes,
}));

import Settings from '../src/components/Settings.jsx';

let container; let root;
const termRef = { current: { getFontSize: () => ({ size: 14, auto: false }) } };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  getPanes.mockReset();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const render = async (props = {}) => {
  await act(async () => {
    root.render(
      <Settings
        open
        onClose={() => {}}
        termRef={termRef}
        getColCount={() => 91}
        onColAdjust={() => {}}
        onColRestore={() => {}}
        onOpenChangelog={() => {}}
        changelogUnread={false}
        windowId="@1"
        pane="%2"
        {...props}
      />,
    );
  });
};

describe('Settings pane columns', () => {
  it('shows the current pane width read from tmux instead of the previous resize target', async () => {
    getPanes.mockResolvedValue([
      { id: '%1', width: 63 },
      { id: '%2', width: 37 },
    ]);

    await render();

    expect(getPanes).toHaveBeenCalledWith('@1');
    expect(container.querySelector('.cols-btns').textContent).toContain('37 列');
    expect(container.querySelector('.cols-btns').textContent).not.toContain('91 列');
  });

  it('uses the displayed pane width as the next resize baseline', async () => {
    const onColAdjust = vi.fn();
    getPanes.mockResolvedValue([
      { id: '%1', width: 63 },
      { id: '%2', width: 37 },
    ]);
    await render({ onColAdjust });

    const plusOne = [...container.querySelectorAll('.col-step')]
      .find((button) => button.textContent === '+1');
    act(() => plusOne.click());

    expect(onColAdjust).toHaveBeenCalledWith(1, 37);
  });

  it('does not resize from a stale fallback while the live pane width is loading', async () => {
    getPanes.mockReturnValue(new Promise(() => {}));

    await render();

    const steps = [...container.querySelectorAll('.col-step')];
    expect(steps).toHaveLength(4);
    expect(steps.every((button) => button.disabled)).toBe(true);
  });
});
