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
  it('shows Tencent status and persists the low/medium/high slider on this browser', async () => {
    await render({ voiceEnabled: true, voiceProvider: 'tencent', voiceFillerFilterSupported: true });
    expect(container.textContent).toContain('语音转文字');
    expect(container.textContent).toContain('已开启');
    expect(container.textContent).toContain('腾讯云');

    const slider = container.querySelector<HTMLInputElement>('input[aria-label="语气词过滤"]');
    expect(slider?.value).toBe('1');
    expect(slider?.getAttribute('aria-valuetext')).toBe('中');
    expect(container.querySelector('.settings-level-labels')?.textContent).toBe('低中高');

    fireEvent.change(slider!, { target: { value: '2' } });
    expect(slider?.value).toBe('2');
    expect(localStorage.getItem('tw_voice_filler_filter')).toBe('high');
  });

  it('states that iFlytek does not support filler-word filtering', async () => {
    await render({ voiceEnabled: true, voiceProvider: 'xfyun', voiceFillerFilterSupported: false });
    expect(container.textContent).toContain('科大讯飞');
    expect(container.textContent).toContain('语气词过滤不支持');
    expect(container.querySelector('input[aria-label="语气词过滤"]')).toBeNull();
  });
});
