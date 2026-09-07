import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';

vi.mock('../src/push.js', () => ({
  notifyEnabled: () => false,
  enableNotifications: vi.fn(),
  disableNotifications: vi.fn(),
  pushSupported: () => false,
  getScriptPushKey: vi.fn(),
}));

import Settings from '../src/components/Settings.jsx';

let container;
let root;
let terminalSize;
let termRef;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('tw_lang', 'zh');
  terminalSize = 14;
  termRef = {
    current: {
      getFontSize: vi.fn(() => ({ size: terminalSize, auto: false })),
      setFontSize: vi.fn((size) => {
        terminalSize = Math.max(8, Math.min(40, size));
        return terminalSize;
      }),
      autoFont: vi.fn(),
      setDocHighlight: vi.fn(),
    },
  };
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
const groupLabels = (title) => {
  const heading = [...container.querySelectorAll('.settings-page-group > h2')]
    .find((candidate) => candidate.textContent === title);
  return [...heading.closest('.settings-page-group').querySelectorAll('.settings-page-row-label')]
    .map((label) => label.textContent);
};

function ConversationFontHarness({ initial = 15, onChange = () => {} }) {
  const [size, setSize] = useState(initial);
  return <Settings open onClose={() => {}} termRef={termRef} conversationFontSize={size}
    onConversationFontSize={(next) => { onChange(next); setSize(next); }} />;
}

describe('Settings font organization', () => {
  it('keeps general language-only and groups all terminal controls together', () => {
    act(() => root.render(<Settings open onClose={() => {}} termRef={termRef} />));

    expect(groupLabels('通用')).toEqual(['语言 Language']);
    expect(groupLabels('终端')).toEqual([
      '终端字体大小', '终端传输模式', '键盘模式', '高亮文件路径',
    ]);
    expect(groupLabels('对话')).toEqual(['对话字体大小', '对话配色']);
  });

  it('retains the terminal size stepper and height auto-fit behavior', () => {
    act(() => root.render(<Settings open onClose={() => {}} termRef={termRef} />));
    act(() => row('终端字体大小').click());

    expect(container.querySelector('.settings-page-head h1').textContent).toBe('终端字体大小');
    act(() => container.querySelector('[aria-label="减小终端字体"]').click());
    expect(termRef.current.setFontSize).toHaveBeenCalledWith(13);
    expect(container.querySelector('.settings-font-value').textContent).toBe('13px');
    act(() => [...container.querySelectorAll('.settings-font-controls button')]
      .find((button) => button.textContent === '自适应').click());
    expect(termRef.current.autoFont).toHaveBeenCalledOnce();
    expect(container.querySelector('.settings-font-value').textContent).toBe('自适应');
  });

  it('steps over discrete conversation sizes and restores the 15px default', () => {
    const onChange = vi.fn();
    act(() => root.render(<ConversationFontHarness onChange={onChange} />));
    act(() => row('对话字体大小').click());

    const decrease = () => container.querySelector('[aria-label="减小对话字体"]');
    act(() => decrease().click());
    expect(onChange).toHaveBeenLastCalledWith(14);
    expect(container.querySelector('.settings-font-value').textContent).toBe('14px');
    act(() => decrease().click());
    expect(onChange).toHaveBeenLastCalledWith(13);
    expect(decrease().disabled).toBe(false);
    act(() => decrease().click());
    expect(onChange).toHaveBeenLastCalledWith(12);
    act(() => decrease().click());
    expect(onChange).toHaveBeenLastCalledWith(11);
    act(() => decrease().click());
    expect(onChange).toHaveBeenLastCalledWith(10);
    expect(decrease().disabled).toBe(true);

    const restore = [...container.querySelectorAll('.settings-font-controls button')]
      .find((button) => button.textContent === '恢复默认');
    act(() => restore.click());
    expect(onChange).toHaveBeenLastCalledWith(15);
    expect(container.querySelector('.settings-font-value').textContent).toBe('15px');
    expect(restore.getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).not.toContain('自适应');
    expect(container.textContent).toContain('10–20px');
  });

  it('stops at the largest conversation size', () => {
    const onChange = vi.fn();
    act(() => root.render(<ConversationFontHarness initial={18} onChange={onChange} />));
    act(() => row('对话字体大小').click());
    const increase = () => container.querySelector('[aria-label="增大对话字体"]');
    act(() => increase().click());
    expect(onChange).toHaveBeenLastCalledWith(19);
    act(() => increase().click());
    expect(onChange).toHaveBeenLastCalledWith(20);
    expect(container.querySelector('.settings-font-value').textContent).toBe('20px');
    expect(increase().disabled).toBe(true);
    const callCount = onChange.mock.calls.length;
    act(() => increase().click());
    expect(onChange).toHaveBeenCalledTimes(callCount);
  });
});
