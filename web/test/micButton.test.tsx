import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import MicButton from '../src/components/MicButton.jsx';
import type { Root } from 'react-dom/client';
import type { MicButtonProps } from '../src/components/MicButton.jsx';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = (props: Omit<MicButtonProps, 'onToggle'> & { onToggle?: () => void }) => act(() => (
  root.render(<MicButton onToggle={() => {}} {...props} />)
));

describe('MicButton', () => {
  it('渲染一个 svg 图标(不是 emoji)', async () => {
    await render({ active: false });
    expect(container.querySelector('.input-mic svg')).not.toBeNull();
  });
  it('active 时带 on 类(绿色态)', async () => {
    await render({ active: true });
    expect(container.querySelector('.input-mic')?.classList.contains('on')).toBe(true);
  });
  it('一句话录音时用四根音量条替换麦克风，条高跟随 level', async () => {
    await render({ active: true, waveform: true, level: 0.75 });
    const wave = container.querySelector('.input-mic-wave');
    expect(wave?.children).toHaveLength(4);
    expect(wave?.getAttribute('data-level')).toBe('0.75');
    expect(container.querySelector('.input-mic svg')).toBeNull();
  });
  it('停止后显示蓝色识别中状态并禁止重复点击', async () => {
    await render({ active: false, recognizing: true });
    const button = container.querySelector('.input-mic') as HTMLButtonElement;
    expect(button.classList.contains('recognizing')).toBe(true);
    expect(button.querySelector('.input-mic-spinner')).not.toBeNull();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
  // 点按 = pointerdown + 原地 pointerup(无 onClick:多行时按钮悬在文字上,拖光标经过不能触发)。
  it('点按调用 onToggle', async () => {
    const onToggle = vi.fn();
    await render({ active: false, onToggle });
    const fire = (type: string, x = 0) => act(() => container.querySelector('.input-mic')!
      .dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 0 })));
    fire('pointerdown'); fire('pointerup');
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
  it('按下后拖走再松手(拖光标经过)不触发 onToggle', async () => {
    const onToggle = vi.fn();
    await render({ active: false, onToggle });
    const fire = (type: string, x = 0) => act(() => container.querySelector('.input-mic')!
      .dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 0 })));
    fire('pointerdown'); fire('pointermove', 40); fire('pointerup');
    expect(onToggle).not.toHaveBeenCalled();
  });
  it('disabled 时按钮禁用', async () => {
    await render({ active: false, disabled: true });
    expect((container.querySelector('.input-mic') as HTMLButtonElement | null)?.disabled).toBe(true);
  });
});
