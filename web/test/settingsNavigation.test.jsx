import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../src/push.js', () => ({
  notifyEnabled: () => false, enableNotifications: vi.fn(), disableNotifications: vi.fn(),
  pushSupported: () => false, getScriptPushKey: vi.fn(),
}));

import Settings from '../src/components/Settings.jsx';

let container;
let root;
const termRef = { current: { getFontSize: () => ({ size: 14, auto: false }) } };

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

const row = (label) => [...container.querySelectorAll('.settings-page-row')]
  .find((item) => item.querySelector('.settings-page-row-label')?.textContent === label);

describe('Settings full-screen navigation', () => {
  it('uses a full-screen grouped page instead of the centered settings modal', () => {
    act(() => root.render(<Settings open onClose={() => {}} termRef={termRef} />));
    expect(container.querySelector('.settings-page')).toBeTruthy();
    expect(container.querySelector('.settings-card')).toBeNull();
    expect(container.querySelector('.settings-backdrop')).toBeNull();
    expect(row('项目任务 Beta')).toBeUndefined();
    expect([...container.querySelectorAll('.settings-page-group > h2')].map((heading) => heading.textContent))
      .toEqual(['通用', '语音转文字', '终端', '对话', 'Agent 集成', '通知', '关于']);
  });

  it('returns from a detail page before closing Settings and restores the root scroll position', () => {
    const onClose = vi.fn();
    act(() => root.render(<Settings open onClose={onClose} termRef={termRef} />));
    const body = container.querySelector('.settings-page-body');
    body.scrollTop = 180;

    act(() => row('键盘模式').click());
    expect(container.querySelector('.settings-page-head h1').textContent).toBe('键盘模式');
    expect(onClose).not.toHaveBeenCalled();

    act(() => container.querySelector('.settings-page-back').click());
    expect(container.querySelector('.settings-page-head h1').textContent).toBe('设置');
    expect(body.scrollTop).toBe(180);
    expect(onClose).not.toHaveBeenCalled();

    act(() => container.querySelector('.settings-page-back').click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('starts from the top whenever Settings is reopened from the main screen', () => {
    const render = (open) => act(() => root.render(
      <Settings open={open} onClose={() => {}} termRef={termRef} />,
    ));
    render(true);
    container.querySelector('.settings-page-body').scrollTop = 240;

    render(false);
    render(true);
    expect(container.querySelector('.settings-page-body').scrollTop).toBe(0);
  });
});
