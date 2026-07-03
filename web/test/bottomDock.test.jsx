import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../src/api.js', () => ({
  sendText: vi.fn(async () => ({ ok: true })),
  getConfig: vi.fn(async () => ({ asr: true })), // useAsrAvailable refresh → keep the mic visible
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

// 可驱动的语音 mock:测试改 voice.state/voice.partial 再重渲染来模拟"录音中/实时增量";
// 捕获组件传入的 onText 以便模拟"定稿"。start/stop 是 spy。
const voice = vi.hoisted(() => ({ state: 'idle', partial: '', start: vi.fn(), stop: vi.fn(), onText: null }));
vi.mock('../src/voice/usePushToTalk.js', () => ({
  usePushToTalk: ({ onText }) => { voice.onText = onText; return voice; },
}));

import BottomDock from '../src/components/BottomDock.jsx';
import { sendText } from '../src/api.js';

let container;
let root;

beforeEach(() => {
  vi.clearAllMocks();
  voice.state = 'idle'; voice.partial = '';
  voice.start.mockClear(); voice.stop.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (props) => act(() => root.render(<BottomDock {...props} />));
const fire = (node, type) => act(() => node.dispatchEvent(new MouseEvent(type, { bubbles: true })));

// React tracks the controlled value via the native setter; set it then fire `input` so onChange runs.
const typeInto = (node, text) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(node, text);
  node.dispatchEvent(new Event('input', { bubbles: true }));
});

describe('BottomDock', () => {
  it('puts ⌫ and an Enter key at the right end of the key area', () => {
    render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    expect(container.querySelector('.keyrow-del').textContent).toBe('⌫');
    expect(container.querySelector('.keyrow-enter').textContent).toBe('Enter'); // 文字,不是 ⏎ 符号
  });

  it('the key-area Enter sends a raw Enter via onKey (NOT the composed text)', () => {
    const onKey = vi.fn();
    render({ pane: '%1', onAuthFail: vi.fn(), onKey, onText: vi.fn() });
    fire(container.querySelector('.keyrow-enter'), 'click');
    expect(onKey).toHaveBeenCalledWith('Enter');
    expect(sendText).not.toHaveBeenCalled();
  });

  it('a tap on the 发送 ↑ submits the typed text with enter=true', async () => {
    render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    typeInto(container.querySelector('.input-text'), 'ls -la');
    fire(container.querySelector('.input-send'), 'pointerdown');
    await act(async () => {
      container.querySelector('.input-send').dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    expect(sendText).toHaveBeenCalledWith('%1', 'ls -la', true);
  });

  it('long-pressing the 发送 ↑ types the box text into the pane WITHOUT Enter', async () => {
    vi.useFakeTimers();
    const onSent = vi.fn();
    render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), onSent });
    typeInto(container.querySelector('.input-text'), 'cd /tmp');
    fire(container.querySelector('.input-send'), 'pointerdown');
    await act(async () => { await vi.advanceTimersByTimeAsync(450); }); // hold past the threshold → 填入(fill 在计时器里触发)
    expect(sendText).toHaveBeenCalledWith('%1', 'cd /tmp', false); // typed, NOT entered
    expect(onSent).toHaveBeenCalledWith('cd /tmp');
    expect(container.querySelector('.input-text').value).toBe(''); // box cleared after fill
    vi.useRealTimers();
  });

  it('发送 ↑ 常驻但空框禁用,有字时启用;▤ 仅空框显示', () => {
    render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    expect(container.querySelector('.input-send')).not.toBe(null);     // 常驻:空框也在
    expect(container.querySelector('.input-send').disabled).toBe(true); // …但禁用
    expect(container.querySelector('.input-cmd')).not.toBe(null);      // 空框显示 ▤
    typeInto(container.querySelector('.input-text'), 'ls');
    expect(container.querySelector('.input-send').disabled).toBe(false); // 有字 → 启用
    expect(container.querySelector('.input-cmd')).toBe(null);          // 有字 → ▤ 隐藏
  });

  it('录音中点发送:先停语音、发当前文字,后续定稿不再回写', async () => {
    await render({ pane: '%1', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = '帮我看日志';
    await render({ pane: '%1', onSent: () => {} });
    voice.stop.mockClear();
    fire(container.querySelector('.input-send'), 'pointerdown');
    await act(async () => {
      container.querySelector('.input-send').dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    expect(voice.stop).toHaveBeenCalledTimes(1);                        // 停了语音
    expect(sendText).toHaveBeenCalledWith('%1', '帮我看日志', true);     // 发了当前文字
    // 模拟尾随定稿 → 应被抑制,不再把文字写回空框
    act(() => { voice.onText('帮我看日志最终'); });
    voice.state = 'idle'; voice.partial = '';
    await render({ pane: '%1', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('');
  });

  it('⌫ sends a Backspace via onKey', () => {
    const onKey = vi.fn();
    render({ pane: '%1', onAuthFail: vi.fn(), onKey, onText: vi.fn() });
    fire(container.querySelector('.keyrow-del'), 'pointerdown');
    fire(container.querySelector('.keyrow-del'), 'pointerup');
    expect(onKey).toHaveBeenCalledWith('BSpace');
  });

  it('holding ⌫ repeats Backspace, releasing stops', () => {
    vi.useFakeTimers();
    const onKey = vi.fn();
    render({ pane: '%1', onAuthFail: vi.fn(), onKey, onText: vi.fn() });
    fire(container.querySelector('.keyrow-del'), 'pointerdown');     // 1 (immediate)
    act(() => vi.advanceTimersByTime(400 + 120 + 120));             // +2
    fire(container.querySelector('.keyrow-del'), 'pointerup');
    act(() => vi.advanceTimersByTime(1000));
    expect(onKey).toHaveBeenCalledTimes(3);
    expect(onKey).toHaveBeenCalledWith('BSpace');
    vi.useRealTimers();
  });

  it('▤ toggles the command panel', () => {
    render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), recent: ['ls'], favorites: [] });
    expect(container.querySelector('.cmd-panel')).toBe(null);
    fire(container.querySelector('.input-cmd'), 'click');
    expect(container.querySelector('.cmd-panel')).not.toBe(null);
    fire(container.querySelector('.input-cmd'), 'click');
    expect(container.querySelector('.cmd-panel')).toBe(null);
  });

  it('picking a command fills the box and closes the panel WITHOUT sending', () => {
    render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), recent: ['ls -la'], favorites: [] });
    fire(container.querySelector('.input-cmd'), 'click');
    fire(container.querySelector('.cmd-text'), 'click');
    expect(container.querySelector('.input-text').value).toBe('ls -la');
    expect(sendText).not.toHaveBeenCalled();
    expect(container.querySelector('.cmd-panel')).toBe(null);
  });

  it('点麦克风开始/再点停止(点按切换)', async () => {
    await render({ pane: '%1', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(voice.start).toHaveBeenCalledTimes(1);
    voice.state = 'recording';
    await render({ pane: '%1', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(voice.stop).toHaveBeenCalledTimes(1);
  });

  it('录音中 partial 实时写进文本框,光标在末尾', async () => {
    await render({ pane: '%1', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = '帮我';
    await render({ pane: '%1', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('帮我');
    voice.partial = '帮我看下日志';
    await render({ pane: '%1', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('帮我看下日志');
  });

  it('在已有文字的光标处插入(中间)', async () => {
    await render({ pane: '%1', onSent: () => {} });
    const ta = container.querySelector('.input-text');
    typeInto(ta, 'AB');
    act(() => { ta.selectionStart = ta.selectionEnd = 1; });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = 'X';
    await render({ pane: '%1', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('AXB');
  });

  it('录音中文本框不设 readOnly(否则 iOS 点击不弹键盘、卡死)', async () => {
    await render({ pane: '%1', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = '你好';
    await render({ pane: '%1', onSent: () => {} });
    // 必须可编辑:iOS 对 readOnly 的 textarea 点击不给焦点/不弹键盘,而停语音是异步的 → 那一下点击作废。
    expect(container.querySelector('.input-text').readOnly).toBe(false);
  });

  it('录音中点输入框:停语音 + 接管编辑,尾随定稿被抑制不覆盖', async () => {
    await render({ pane: '%1', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = '在听';
    await render({ pane: '%1', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('在听');
    voice.stop.mockClear();
    fire(container.querySelector('.input-text'), 'pointerdown');
    expect(voice.stop).toHaveBeenCalledTimes(1);            // 停了语音
    // 这一下点击就要进入编辑:同步夺焦(iOS 上即等于立刻弹键盘),无需再点第二次。
    expect(document.activeElement).toBe(container.querySelector('.input-text'));
    // 接管后:尾随定稿应被抑制,不把框里内容改写成定稿文本(否则会覆盖你接着打的字)。
    act(() => { voice.onText('在听最终版'); });
    voice.state = 'idle'; voice.partial = '';
    await render({ pane: '%1', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('在听');
  });

  it('语音激活时申请屏幕常亮(wake lock),停录后释放', async () => {
    const release = vi.fn();
    const request = vi.fn(async () => ({ release }));
    navigator.wakeLock = { request };
    try {
      await render({ pane: '%1', onSent: () => {} });
      expect(request).not.toHaveBeenCalled();           // idle:不常亮
      voice.state = 'recording';
      await render({ pane: '%1', onSent: () => {} });
      await act(async () => { await Promise.resolve(); }); // 等 acquire 微任务
      expect(request).toHaveBeenCalledWith('screen');    // 录音中:申请常亮
      voice.state = 'idle';
      await render({ pane: '%1', onSent: () => {} });
      expect(release).toHaveBeenCalledTimes(1);            // 停录:释放
    } finally {
      delete navigator.wakeLock;
    }
  });

  it('未录音时点输入框不触发停止', async () => {
    await render({ pane: '%1', onSent: () => {} });
    fire(container.querySelector('.input-text'), 'pointerdown');
    expect(voice.stop).not.toHaveBeenCalled();
  });

  it('录音时 input-wrap 带 recording 类(整框变绿),停录后撤掉', async () => {
    await render({ pane: '%1', onSent: () => {} });
    expect(container.querySelector('.input-wrap').classList.contains('recording')).toBe(false);
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = '在听';
    await render({ pane: '%1', onSent: () => {} });
    expect(container.querySelector('.input-wrap').classList.contains('recording')).toBe(true);
    voice.state = 'idle'; voice.partial = '';
    await render({ pane: '%1', onSent: () => {} });
    expect(container.querySelector('.input-wrap').classList.contains('recording')).toBe(false);
  });

  it('定稿后 onText 把整段留在框里', async () => {
    await render({ pane: '%1', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = '你好世界';
    await render({ pane: '%1', onSent: () => {} });
    act(() => { voice.onText('你好世界'); });
    voice.state = 'idle'; voice.partial = '';
    await render({ pane: '%1', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('你好世界');
    expect(container.querySelector('.input-text').readOnly).toBe(false);
  });

  it('a successful send reports the command via onSent', async () => {
    const onSent = vi.fn();
    render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), onSent });
    typeInto(container.querySelector('.input-text'), 'git status');
    fire(container.querySelector('.input-send'), 'pointerdown');
    await act(async () => {
      container.querySelector('.input-send').dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    expect(sendText).toHaveBeenCalledWith('%1', 'git status', true);
    expect(onSent).toHaveBeenCalledWith('git status');
  });

  describe('input mode (command ⇄ agent)', () => {
    const keydown = (node, key, opts = {}) =>
      act(() => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts })));

    it('defaults to command mode for a plain shell pane (no agent)', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
      expect(container.querySelector('.input-mode').dataset.mode).toBe('command');
      expect(container.querySelector('.input-wrap').classList.contains('command')).toBe(true);
    });

    it('defaults to agent (compose) mode when a coding agent is live in the pane', () => {
      render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
      expect(container.querySelector('.input-mode').dataset.mode).toBe('agent');
    });

    it('the pill toggles the mode, and the keyboard context tracks it', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // command by default
      // Command mode surfaces the shell symbols; agent menu keys are absent.
      expect(container.querySelector('[data-key="pipe"]')).not.toBeNull();
      expect(container.querySelector('[data-key="n1"]')).toBeNull();
      fire(container.querySelector('.input-mode'), 'click'); // → agent
      expect(container.querySelector('.input-mode').dataset.mode).toBe('agent');
      expect(container.querySelector('[data-key="n1"]')).not.toBeNull();
      expect(container.querySelector('[data-key="pipe"]')).toBeNull();
    });

    it('command mode: Return in the field runs the whole line (type + Enter)', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // command by default
      typeInto(container.querySelector('.input-text'), 'ls -la');
      keydown(container.querySelector('.input-text'), 'Enter');
      expect(sendText).toHaveBeenCalledWith('%1', 'ls -la', true);
    });

    it('command mode: Shift+Enter and IME-composing Return do NOT submit', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
      const ta = container.querySelector('.input-text');
      typeInto(ta, 'echo hi');
      keydown(ta, 'Enter', { shiftKey: true });      // newline escape hatch
      keydown(ta, 'Enter', { isComposing: true });   // committing an IME word
      expect(sendText).not.toHaveBeenCalled();
    });

    it('agent mode: Return does NOT submit (native newline; send button submits instead)', () => {
      render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
      typeInto(container.querySelector('.input-text'), 'write me a poem');
      keydown(container.querySelector('.input-text'), 'Enter');
      expect(sendText).not.toHaveBeenCalled();
    });
  });
});
