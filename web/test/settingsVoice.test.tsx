import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';

vi.mock('../src/push.js', () => ({
  notifyEnabled: () => false,
  enableNotifications: vi.fn(),
  disableNotifications: vi.fn(),
  pushSupported: () => false,
}));

import Settings from '../src/components/Settings.jsx';

let container: HTMLDivElement;
let root: Root;
const termRef = { current: {
  getFontSize: () => ({ size: 14, auto: false }),
  setFontSize: vi.fn(),
  autoFont: vi.fn(),
  setDocHighlight: vi.fn(),
} };

beforeEach(() => {
  localStorage.removeItem('tw_voice_filler_filter');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const render = (props: Record<string, unknown>) => act(() => root.render(
  <Settings open onClose={() => {}} termRef={termRef} {...props} />,
));

describe('Settings speech-to-text section', () => {
  it('hides provider controls and points to handmux setup when voice is off', async () => {
    await render({
      voiceEnabled: false, voiceProvider: null, voiceMode: null,
      voiceFillerFilterSupported: false,
    });
    expect(container.textContent).toContain('是否已开启未开启');
    expect(container.textContent).not.toContain('当前服务商');
    expect(container.textContent).not.toContain('语气词过滤');
    expect(container.textContent).toContain(
      '请在终端执行 handmux setup，然后进入“语音输入”完成设置。',
    );
  });

  it('shows Tencent status and persists the low/medium/high slider on this browser', async () => {
    await render({
      voiceEnabled: true, voiceProvider: 'tencent', voiceMode: 'sentence',
      voiceFillerFilterSupported: true,
    });
    expect(container.textContent).toContain('语音转文字');
    expect(container.textContent).toContain('已开启');
    expect(container.textContent).toContain('腾讯云一句话识别');

    const slider = container.querySelector<HTMLInputElement>('input[aria-label="语气词过滤"]');
    expect(slider?.value).toBe('1');
    expect(slider?.getAttribute('aria-valuetext')).toBe('中');
    expect(container.querySelector('.settings-level-labels')?.textContent).toBe('低中高');

    fireEvent.change(slider!, { target: { value: '2' } });
    expect(slider?.value).toBe('2');
    expect(localStorage.getItem('tw_voice_filler_filter')).toBe('high');
  });

  it('states that iFlytek does not support filler-word filtering', async () => {
    await render({
      voiceEnabled: true, voiceProvider: 'xfyun', voiceMode: 'streaming',
      voiceFillerFilterSupported: false,
    });
    expect(container.textContent).toContain('讯飞语音听写');
    expect(container.textContent).toContain('语气词过滤不支持');
    expect(container.querySelector('input[aria-label="语气词过滤"]')).toBeNull();
  });

  it('uses the same Tencent streaming profile name as handmux setup', async () => {
    await render({
      voiceEnabled: true, voiceProvider: 'tencent', voiceMode: 'streaming',
      voiceFillerFilterSupported: true,
    });
    expect(container.textContent).toContain('腾讯云实时语音识别');
    expect(container.textContent).not.toContain('腾讯云一句话识别');
  });
});
