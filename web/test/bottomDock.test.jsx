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
  it('no dedicated ⌫/Enter rail — those come from the system keyboard now', () => {
    render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    expect(container.querySelector('.keyrow-del')).toBeNull();
    expect(container.querySelector('.keyrow-enter')).toBeNull();
  });

  it('a tap on the 发送 ↑ submits the typed text with enter=true', async () => {
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
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
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), onSent });
    typeInto(container.querySelector('.input-text'), 'cd /tmp');
    fire(container.querySelector('.input-send'), 'pointerdown');
    await act(async () => { await vi.advanceTimersByTimeAsync(450); }); // hold past the threshold → 填入(fill 在计时器里触发)
    expect(sendText).toHaveBeenCalledWith('%1', 'cd /tmp', false); // typed, NOT entered
    expect(onSent).toHaveBeenCalledWith('cd /tmp');
    expect(container.querySelector('.input-text').value).toBe(''); // box cleared after fill
    vi.useRealTimers();
  });

  it('发送 ↑ 常驻但空框禁用,有字时启用', () => {
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    expect(container.querySelector('.input-send')).not.toBe(null);     // 常驻:空框也在
    expect(container.querySelector('.input-send').disabled).toBe(true); // …但禁用
    typeInto(container.querySelector('.input-text'), 'ls');
    expect(container.querySelector('.input-send').disabled).toBe(false); // 有字 → 启用
  });

  it('快捷栏:固定的上传(带图标)+ 一排自定义命令 chip;历史在药丸里', () => {
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    const fixed = [...container.querySelectorAll('.quick-fix')];
    expect(fixed).toHaveLength(1);                                   // 只剩 上传(历史移回药丸)
    expect(fixed[0].querySelector('svg')).not.toBeNull();           // 上传带图标
    expect(container.querySelector('.input-history')).not.toBeNull(); // 历史在药丸里(麦克风左侧)
    expect(container.querySelectorAll('.quick-cmd').length).toBeGreaterThan(0); // 命令 chip 存在
    expect([...container.querySelectorAll('.quick-cmd')].some((b) => b.textContent === '/compact')).toBe(true);
  });

  it('历史按钮:空框只显示图标,打字后整个按钮隐藏', () => {
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    expect(container.querySelector('.input-history')).not.toBeNull();      // 空框:图标在
    expect(container.querySelector('.input-history svg')).not.toBeNull();  // 只有一个图标
    typeInto(container.querySelector('.input-text'), 'ls');
    expect(container.querySelector('.input-history')).toBeNull();          // 打字后:整个隐藏
  });

  it('快捷栏命令 chip 点即发送(打字+回车);ESC 发 Escape 键而非文字', async () => {
    const onKey = vi.fn();
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey, onText: vi.fn() });
    const chip = (txt) => [...container.querySelectorAll('.quick-cmd')].find((n) => n.textContent === txt);
    fire(chip('/compact'), 'click');
    await act(async () => {});
    expect(sendText).toHaveBeenCalledWith('%1', '/compact', true);   // 命令:打字+回车
    fire(chip('ESC'), 'click');
    expect(onKey).toHaveBeenCalledWith('Escape');                    // ESC:发按键
    expect(sendText).not.toHaveBeenCalledWith('%1', 'ESC', true);    // 不是当文字发
    fire(chip('Tab'), 'click');
    expect(onKey).toHaveBeenCalledWith('Tab');                       // Tab:也发按键(和 ESC 同色类)
    expect(sendText).not.toHaveBeenCalledWith('%1', 'Tab', true);
  });

  it('录音中点发送:先停语音、发当前文字,后续定稿不再回写', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = '帮我看日志';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
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
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('');
  });

  it('历史 opens a HISTORY-only drawer (real send log, no 常用 favs)', () => {
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), recent: ['git status'] });
    const history = container.querySelector('.input-history');
    expect(container.querySelector('.cmd-panel')).toBe(null);
    fire(history, 'click');
    expect(container.querySelector('.cmd-panel')).not.toBe(null);
    expect(container.querySelector('.fav-chip')).toBe(null);   // no reply-chip 常用
    expect(container.querySelector('.fav-add')).toBe(null);    // can't ADD in history
    expect([...container.querySelectorAll('.cmd-text')].some((n) => n.textContent === 'git status')).toBe(true);
    fire(history, 'click');
    expect(container.querySelector('.cmd-panel')).toBe(null);
  });

  it('tapping a history row re-sends it (tap = send)', async () => {
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), recent: ['ls -la'] });
    fire(container.querySelector('.input-history'), 'click'); // 历史 opens the drawer
    const row = [...container.querySelectorAll('.cmd-text')].find((n) => n.textContent === 'ls -la');
    fire(row, 'click');
    await act(async () => {});
    expect(sendText).toHaveBeenCalledWith('%1', 'ls -la', true);
  });

  it('double-tapping a history row fills the box WITHOUT sending (long-press = fill)', () => {
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), recent: ['/compact'] });
    fire(container.querySelector('.input-history'), 'click');
    const row = [...container.querySelectorAll('.cmd-text')].find((n) => n.textContent === '/compact');
    act(() => row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(container.querySelector('.input-text').value).toBe('/compact');
    expect(sendText).not.toHaveBeenCalled();
  });

  it('deleting a history row calls onRemoveRecent', () => {
    const onRemoveRecent = vi.fn();
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), recent: ['npm test'], onRemoveRecent });
    fire(container.querySelector('.input-history'), 'click');
    fire(container.querySelector('.cmd-row .cmd-del'), 'click');
    expect(onRemoveRecent).toHaveBeenCalledWith('npm test');
  });

  it('history row has a copy button to the LEFT of delete that copies the command', () => {
    const writeText = vi.fn();
    const orig = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), recent: ['npm run build'], onRemoveRecent: vi.fn() });
      fire(container.querySelector('.input-history'), 'click');
      const kids = [...container.querySelector('.cmd-row').children];
      const copyI = kids.findIndex((n) => n.classList.contains('cmd-copy'));
      const delI = kids.findIndex((n) => n.classList.contains('cmd-del'));
      expect(copyI).toBeGreaterThan(-1);
      expect(delI).toBeGreaterThan(copyI); // 复制在删除左侧
      fire(container.querySelector('.cmd-row .cmd-copy'), 'click');
      expect(writeText).toHaveBeenCalledWith('npm run build');
    } finally {
      if (orig) Object.defineProperty(navigator, 'clipboard', orig);
      else delete navigator.clipboard;
    }
  });

  it('history drawer shows the "current window only" scope hint + has a min-height floor', () => {
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), recent: [] });
    fire(container.querySelector('.input-history'), 'click');
    expect(container.querySelector('.cmd-hint')).not.toBeNull();          // 提示:仅当前窗口
    expect(container.querySelector('.cmd-panel').classList.contains('history')).toBe(true); // min-height 类
  });

  it('点麦克风开始/再点停止(点按切换)', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(voice.start).toHaveBeenCalledTimes(1);
    voice.state = 'recording';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(voice.stop).toHaveBeenCalledTimes(1);
  });

  it('录音中 partial 实时写进文本框,光标在末尾', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = '帮我';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('帮我');
    voice.partial = '帮我看下日志';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('帮我看下日志');
  });

  it('在已有文字的光标处插入(中间)', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    const ta = container.querySelector('.input-text');
    typeInto(ta, 'AB');
    act(() => { ta.selectionStart = ta.selectionEnd = 1; });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = 'X';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('AXB');
  });

  it('录音中文本框不设 readOnly(否则 iOS 点击不弹键盘、卡死)', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = '你好';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    // 必须可编辑:iOS 对 readOnly 的 textarea 点击不给焦点/不弹键盘,而停语音是异步的 → 那一下点击作废。
    expect(container.querySelector('.input-text').readOnly).toBe(false);
  });

  it('录音中点输入框:停语音 + 接管编辑,尾随定稿被抑制不覆盖', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = '在听';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('在听');
    voice.stop.mockClear();
    fire(container.querySelector('.input-text'), 'pointerdown');
    expect(voice.stop).toHaveBeenCalledTimes(1);            // 停了语音
    // 这一下点击就要进入编辑:同步夺焦(iOS 上即等于立刻弹键盘),无需再点第二次。
    expect(document.activeElement).toBe(container.querySelector('.input-text'));
    // 接管后:尾随定稿应被抑制,不把框里内容改写成定稿文本(否则会覆盖你接着打的字)。
    act(() => { voice.onText('在听最终版'); });
    voice.state = 'idle'; voice.partial = '';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('在听');
  });

  it('语音激活时申请屏幕常亮(wake lock),停录后释放', async () => {
    const release = vi.fn();
    const request = vi.fn(async () => ({ release }));
    navigator.wakeLock = { request };
    try {
      await render({ pane: '%1', agent: 'claude', onSent: () => {} });
      expect(request).not.toHaveBeenCalled();           // idle:不常亮
      voice.state = 'recording';
      await render({ pane: '%1', agent: 'claude', onSent: () => {} });
      await act(async () => { await Promise.resolve(); }); // 等 acquire 微任务
      expect(request).toHaveBeenCalledWith('screen');    // 录音中:申请常亮
      voice.state = 'idle';
      await render({ pane: '%1', agent: 'claude', onSent: () => {} });
      expect(release).toHaveBeenCalledTimes(1);            // 停录:释放
    } finally {
      delete navigator.wakeLock;
    }
  });

  it('未录音时点输入框不触发停止', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    fire(container.querySelector('.input-text'), 'pointerdown');
    expect(voice.stop).not.toHaveBeenCalled();
  });

  it('录音时 input-wrap 带 recording 类(整框变绿),停录后撤掉', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    expect(container.querySelector('.input-wrap').classList.contains('recording')).toBe(false);
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = '在听';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    expect(container.querySelector('.input-wrap').classList.contains('recording')).toBe(true);
    voice.state = 'idle'; voice.partial = '';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    expect(container.querySelector('.input-wrap').classList.contains('recording')).toBe(false);
  });

  it('定稿后 onText 把整段留在框里', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    act(() => container.querySelector('.input-mic').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    voice.state = 'recording'; voice.partial = '你好世界';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    act(() => { voice.onText('你好世界'); });
    voice.state = 'idle'; voice.partial = '';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('你好世界');
    expect(container.querySelector('.input-text').readOnly).toBe(false);
  });

  it('a successful send reports the command via onSent', async () => {
    const onSent = vi.fn();
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), onSent });
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

    const dot = (m) => container.querySelector(`.dock-dot[data-page="${m}"]`);
    const cap = () => container.querySelector('.cmd-capture');
    const activePage = (m) => container.querySelector(`.dock-page.${m}`)?.classList.contains('on');
    // jsdom has no TouchEvent — set touches on plain Events so the native pager listeners still fire.
    const swipe = (dx) => act(() => {
      const pager = container.querySelector('.dock-pager');
      const ev = (type, x, prop) => { const e = new Event(type, { bubbles: true }); e[prop] = [{ clientX: x, clientY: 100 }]; return e; };
      pager.dispatchEvent(ev('touchstart', 200, 'touches'));
      pager.dispatchEvent(ev('touchmove', 200 + dx, 'touches'));
      pager.dispatchEvent(ev('touchend', 200 + dx, 'changedTouches'));
    });

    it('defaults to the command page for a plain shell pane (no agent)', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
      expect(dot('command').classList.contains('on')).toBe(true);
      expect(activePage('command')).toBe(true);
      expect(cap()).not.toBeNull();                                 // hidden capture present
      expect(container.querySelector('.keybar-grid')).not.toBeNull(); // command keyboard present
    });

    it('defaults to the chat page when a coding agent is live in the pane', () => {
      render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
      expect(dot('agent').classList.contains('on')).toBe(true);
      expect(activePage('chat')).toBe(true);
      expect(activePage('command')).toBe(false); // both pages mounted (carousel), only chat is active
    });

    it('swiping the pager past the threshold snaps to the other page', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // command by default
      swipe(-100); // drag left past the threshold → chat
      expect(dot('agent').classList.contains('on')).toBe(true);
      expect(activePage('chat')).toBe(true);
      swipe(100); // drag right → command
      expect(dot('command').classList.contains('on')).toBe(true);
      expect(activePage('command')).toBe(true);
    });

    it('a drag shorter than the commit threshold snaps back (harder to trigger)', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // command by default
      swipe(-80); // 80px < 90px threshold → does NOT switch, stays on command
      expect(activePage('command')).toBe(true);
    });

    // A right-drag that STARTS on the quick-command strip: it carries over into a page swipe to command
    // only when the strip is at its left edge (can't scroll further right); otherwise the strip scrolls.
    const stripDrag = (dx, scrollLeft) => act(() => {
      const strip = container.querySelector('.quick-scroll');
      Object.defineProperty(strip, 'scrollLeft', { value: scrollLeft, configurable: true, writable: true });
      const ev = (type, x, prop) => { const e = new Event(type, { bubbles: true }); e[prop] = [{ clientX: x, clientY: 100 }]; return e; };
      strip.dispatchEvent(ev('touchstart', 200, 'touches'));
      strip.dispatchEvent(ev('touchmove', 200 + dx, 'touches'));
      strip.dispatchEvent(ev('touchend', 200 + dx, 'changedTouches'));
    });

    it('at the strip left edge, a right-drag on it carries over to the command page', () => {
      render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // chat
      expect(activePage('chat')).toBe(true);
      stripDrag(100, 0); // right-drag past the threshold, strip at left edge → page swipe to command
      expect(activePage('command')).toBe(true);
    });

    it('when the strip can still scroll (not at left edge), a drag on it does NOT switch pages', () => {
      render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // chat
      stripDrag(80, 40); // scrollLeft>0 → native strip scroll, not a page swipe
      expect(activePage('chat')).toBe(true); // stayed on chat
    });

    it('self-heals a transform left stuck between pages (a missed touchend) on the next render', () => {
      render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
      const track = container.querySelector('.dock-track');
      track.style.transform = 'translate3d(-137px, 0, 0)'; // pretend a swipe was interrupted mid-way
      render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), recent: ['x'] });
      // any at-rest render re-asserts a page-aligned transform (clientWidth is 0 in jsdom → 0px)
      expect(track.style.transform).toBe('translate3d(0px, 0, 0)');
    });

    it('the ⌨ key toggles focus on the hidden capture (pops / dismisses the keyboard)', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
      const kbd = container.querySelector('[data-key="kbd"]');
      expect(kbd.classList.contains('on')).toBe(false);
      fire(kbd, 'click');
      expect(document.activeElement).toBe(cap());        // focused → keyboard up
      expect(kbd.classList.contains('on')).toBe(true);
      fire(kbd, 'click');
      expect(document.activeElement).not.toBe(cap());    // blurred → keyboard down
    });

    // Uncontrolled command capture: set value then fire a native input event so React's onInput runs.
    const streamKey = (node, text, opts = {}) => act(() => {
      node.value = text;
      node.dispatchEvent(new InputEvent('input', { bubbles: true, ...opts }));
    });

    it('command mode streams each keystroke straight to the pane and wipes the field', () => {
      const onText = vi.fn();
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText }); // command by default
      const el = cap();
      streamKey(el, 'l');
      streamKey(el, 's');
      expect(onText).toHaveBeenNthCalledWith(1, 'l');
      expect(onText).toHaveBeenNthCalledWith(2, 's');
      expect(el.value).toBe(''); // nothing staged — the text is in the terminal
    });

    it('command mode: Return runs the line, Backspace deletes in the shell (terminal keys)', () => {
      const onKey = vi.fn();
      render({ pane: '%1', onAuthFail: vi.fn(), onKey, onText: vi.fn() });
      const el = cap();
      keydown(el, 'Enter');
      keydown(el, 'Backspace');
      expect(onKey).toHaveBeenCalledWith('Enter');
      expect(onKey).toHaveBeenCalledWith('BSpace');
    });

    it('command mode: an IME holds until commit, then streams the whole word', () => {
      const onText = vi.fn();
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText });
      const el = cap();
      act(() => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
      streamKey(el, 'ni', { isComposing: true }); // mid-composition input is held
      expect(onText).not.toHaveBeenCalled();
      act(() => { el.value = '你'; el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' })); });
      expect(onText).toHaveBeenCalledWith('你'); // the committed word streams now
      expect(el.value).toBe('');
    });

    it('agent mode: Return does NOT submit (native newline; send button submits instead)', () => {
      const onKey = vi.fn();
      render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey, onText: vi.fn() });
      typeInto(container.querySelector('.input-text'), 'write me a poem');
      keydown(container.querySelector('.input-text'), 'Enter');
      expect(sendText).not.toHaveBeenCalled();
      expect(onKey).not.toHaveBeenCalledWith('Enter');
    });

    it('command mode: armed Ctrl turns the next typed letter into C-<x> instead of streaming it', () => {
      const onKey = vi.fn(), onText = vi.fn();
      render({ pane: '%1', onAuthFail: vi.fn(), onKey, onText }); // command mode (no agent)
      fire(container.querySelector('[data-key="ctrl"]'), 'click'); // arm Ctrl on the keybar (single click)
      const el = cap();
      act(() => { el.value = 'r'; el.dispatchEvent(new InputEvent('input', { bubbles: true })); }); // type 'r'
      expect(onKey).toHaveBeenCalledWith('C-r');
      expect(onText).not.toHaveBeenCalledWith('r');
    });
  });
});
