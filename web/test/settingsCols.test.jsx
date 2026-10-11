import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ColumnStepper from '../src/components/ColumnStepper.jsx';
import Settings from '../src/components/Settings.jsx';

vi.mock('../src/push.js', () => ({
  notifyEnabled: () => false, enableNotifications: vi.fn(), disableNotifications: vi.fn(), pushSupported: () => false,
}));

let container;
let root;

beforeEach(() => {
  localStorage.setItem('tw_lang', 'zh');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('ColumnStepper', () => {
  it('shows the target width and passes that exact baseline to each step', () => {
    const onAdjust = vi.fn();
    act(() => root.render(
      <ColumnStepper label="分屏宽度" cols={37} onAdjust={onAdjust} onRestore={() => {}} restoreLabel="恢复分屏比例" />,
    ));

    expect(container.querySelector('.sheet-size-value').textContent).toMatch(/^37 (列|columns)$/);
    const plusOne = [...container.querySelectorAll('.col-step')].find((button) => button.textContent === '+1');
    act(() => plusOne.click());
    expect(onAdjust).toHaveBeenCalledWith(1, 37);
  });

  it('keeps restore disabled until a pane layout snapshot exists', () => {
    act(() => root.render(
      <ColumnStepper label="分屏宽度" cols={37} onAdjust={() => {}} onRestore={() => {}}
        restoreLabel="恢复分屏比例" restoreDisabled />,
    ));
    expect(container.querySelector('.sheet-size-restore').disabled).toBe(true);
  });
});

describe('Settings sizing scope', () => {
  it('contains no current-session or column-width controls', () => {
    const termRef = { current: { getFontSize: () => ({ size: 14, auto: false }) } };
    act(() => root.render(
      <Settings open onClose={() => {}} termRef={termRef} onOpenChangelog={() => {}} changelogUnread={false} />,
    ));
    expect(container.querySelector('.sheet-size-control')).toBeNull();
  });
});
