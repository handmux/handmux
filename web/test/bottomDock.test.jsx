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
import { t } from '../src/i18n';

let container;
let root;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); // hermetic favs — chat list falls back to the seeded defaults
  voice.state = 'idle'; voice.partial = '';
  voice.start.mockClear(); voice.stop.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if ('visualViewport' in window) delete window.visualViewport; // drop any per-test mock
});

const render = (props) => act(() => root.render(<BottomDock {...props} />));
const fire = (node, type) => act(() => node.dispatchEvent(new MouseEvent(type, { bubbles: true })));
// Quick-command chips are HoldButtons (pointer events, no onClick): a clean tap = pointerdown + pointerup.
const tap = (node) => { fire(node, 'pointerdown'); fire(node, 'pointerup'); };

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

  // 键盘状态对账:用 visualViewport 高度(与页面滚动/offsetTop 无关)判定键盘真在不在。装一个可驱动的
  // visualViewport mock,resize 时改高度并派发事件。
  const installVV = (height) => {
    const listeners = new Set();
    const vv = {
      height, width: 320, offsetTop: 0,
      addEventListener: (type, fn) => { if (type === 'resize') listeners.add(fn); },
      removeEventListener: (type, fn) => listeners.delete(fn),
    };
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    return {
      resize: (h) => act(() => { vv.height = h; listeners.forEach((fn) => fn()); }),
      scroll: (top) => act(() => { vv.offsetTop = top; listeners.forEach((fn) => fn()); }), // 应被忽略
    };
  };
  const kbdUp = 400, kbdDown = 768; // innerHeight 768:up 时遮挡 368>120,down 时遮挡 0

  // 系统在未 blur 输入框的情况下偷偷收起键盘(未完成的切应用手势)→ 只靠 focus 推导的 keyboardUp 会卡在
  // 「收起键盘」且无法再展开。visualViewport 高度回涨=键盘真没了,据此复位状态并放掉残留焦点。
  it('reconciles the ⌨ toggle when the OS drops the keyboard without blurring', () => {
    const vv = installVV(kbdUp);
    render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    const cap = container.querySelector('.cmd-capture');
    const kbd = container.querySelector('.quick-fix-kbd');
    act(() => cap.focus()); // onFocus → keyboardUp true → 显示「收起键盘」
    expect(kbd.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(cap);
    vv.resize(kbdDown); // 系统悄悄收起键盘:高度回涨,但输入框仍持有焦点(没有 blur 事件)
    expect(kbd.getAttribute('aria-pressed')).toBe('false'); // 状态复位为「展开键盘」
    expect(document.activeElement).not.toBe(cap);            // 残留焦点被放掉,下次点击能干净弹起
  });

  // iOS 回归护栏:聚焦弹键盘时 iOS 会滚页,把 vv.offsetTop 顶到抵消 inset≈0——绝不能据此误判键盘没了而
  // 立刻收起(旧 Fix 用了含 offsetTop 的 inset,导致 iOS 一点就弹一下又收上、永远打不开)。只看高度就不受影响。
  it('does NOT collapse the keyboard when iOS scrolls the page on focus (offsetTop churn)', () => {
    const vv = installVV(kbdUp);
    render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    const cap = container.querySelector('.cmd-capture');
    const kbd = container.querySelector('.quick-fix-kbd');
    act(() => cap.focus());
    vv.scroll(368); // iOS 聚焦滚页:offsetTop 顶上去,但键盘还在(高度不变)
    expect(kbd.getAttribute('aria-pressed')).toBe('true'); // 键盘保持展开
    expect(document.activeElement).toBe(cap);              // 焦点保住,键盘不被收
  });

  // 草稿本地暂存:无论 App 因何退出,输入框里的未发送文字下次打开自动写回。
  it('restores an unsent chat draft on mount, and clears the stored draft after send', async () => {
    localStorage.setItem('tw_chat_draft', '写到一半的想法');
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    expect(container.querySelector('.input-text').value).toBe('写到一半的想法'); // draft came back
    fire(container.querySelector('.input-send'), 'pointerdown');
    await act(async () => {
      container.querySelector('.input-send').dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    expect(sendText).toHaveBeenCalledWith('%1', '写到一半的想法', true);
    expect(localStorage.getItem('tw_chat_draft')).toBeNull(); // sent → stored draft gone
  });

  it('mirrors every keystroke into the stored draft', () => {
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    typeInto(container.querySelector('.input-text'), '还没发的话');
    expect(localStorage.getItem('tw_chat_draft')).toBe('还没发的话');
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
    const fixed = [...container.querySelectorAll('.dock-page.chat .quick-fix')];
    expect(fixed).toHaveLength(1);                                   // 只剩 上传(历史移回药丸)
    expect(fixed[0].querySelector('svg')).not.toBeNull();           // 上传带图标
    expect(container.querySelector('.input-history')).not.toBeNull(); // 历史在药丸里(麦克风左侧)
    const chatChips = [...container.querySelectorAll('.dock-page.chat .quick-cmd')];
    expect(chatChips.length).toBeGreaterThan(0); // 命令 chip 存在
    expect(chatChips.some((b) => b.textContent === '/compact')).toBe(true);
  });

  it('历史按钮:空框只显示图标,打字后整个按钮隐藏', () => {
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    expect(container.querySelector('.input-history')).not.toBeNull();      // 空框:图标在
    expect(container.querySelector('.input-history svg')).not.toBeNull();  // 只有一个图标
    typeInto(container.querySelector('.input-text'), 'ls');
    expect(container.querySelector('.input-history')).toBeNull();          // 打字后:整个隐藏
  });

  // Tapping anywhere in the dock that isn't a text field must keep the phone keyboard up: the dock's
  // pointer-down preventDefaults so the focused field never blurs. The text field itself is exempt.
  const downOn = (node) => { const e = new MouseEvent('pointerdown', { bubbles: true, cancelable: true }); act(() => node.dispatchEvent(e)); return e; };
  it('tapping non-input dock areas keeps focus (preventDefault); the composer itself does not', () => {
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    expect(downOn(container.querySelector('.dock-page.chat .quick-cmd')).defaultPrevented).toBe(true);  // a chip
    expect(downOn(container.querySelector('.dock-page.chat .quick-bar')).defaultPrevented).toBe(true);  // empty bar area
    expect(downOn(container.querySelector('.input-text')).defaultPrevented).toBe(false);                // the field: exempt
  });

  it('command mode: tapping a key / the keyboard area keeps the capture focused (preventDefault)', () => {
    render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // command
    expect(downOn(container.querySelector('.keybar-grid')).defaultPrevented).toBe(true);   // a gap in the grid
    expect(downOn(container.querySelector('[data-key="esc"]')).defaultPrevented).toBe(true); // a key
  });

  it('快捷栏命令 chip 点即发送(打字+回车);ESC 发 Escape 键而非文字', async () => {
    const onKey = vi.fn();
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey, onText: vi.fn() });
    const chip = (txt) => [...container.querySelectorAll('.quick-cmd')].find((n) => n.textContent === txt);
    tap(chip('/compact'));
    await act(async () => {});
    expect(sendText).toHaveBeenCalledWith('%1', '/compact', true);   // 命令:打字+回车
    tap(chip('Esc'));                                                // key fav, label 'Esc'
    expect(onKey).toHaveBeenCalledWith('Escape');                    // ESC:发按键
    expect(sendText).not.toHaveBeenCalledWith('%1', 'Escape', true); // 不是当文字发
    tap(chip('Tab'));
    expect(onKey).toHaveBeenCalledWith('Tab');                       // Tab:也发按键(和 ESC 同色类)
    expect(sendText).not.toHaveBeenCalledWith('%1', 'Tab', true);
  });

  it('server text presets use the configured Enter behavior in both modes', async () => {
    const onText = vi.fn();
    const shortcuts = {
      command: [{ type: 'text', text: 'pwd', enter: false }],
      chat: [
        { type: 'text', text: 'draft only', enter: false },
        { type: 'text', text: 'send now', enter: true },
      ],
    };
    render({ pane: '%1', agent: 'claude', shortcuts, onAuthFail: vi.fn(), onKey: vi.fn(), onText });
    const chip = (txt) => [...container.querySelectorAll('.quick-cmd')].find((node) => node.textContent === txt);
    tap(chip('draft only'));
    expect(onText).toHaveBeenCalledWith('draft only');
    expect(sendText).not.toHaveBeenCalledWith('%1', 'draft only', true);
    tap(chip('send now'));
    await act(async () => {});
    expect(sendText).toHaveBeenCalledWith('%1', 'send now', true);
  });

  it('config presets render before local additions and hide exact local duplicates', () => {
    localStorage.setItem('hm_favs7_agent', JSON.stringify([
      { kind: 'reply', text: 'required', enter: true },
      { kind: 'reply', text: 'mine', enter: true },
    ]));
    const shortcuts = { command: [], chat: [{ type: 'text', text: 'required', enter: true }] };
    render({ pane: '%1', agent: 'claude', shortcuts, onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
    const labels = [...container.querySelectorAll('.dock-page.chat .quick-cmd')].map((node) => node.textContent);
    expect(labels.filter((label) => label === 'required')).toHaveLength(1);
    expect(labels.indexOf('required')).toBeLessThan(labels.indexOf('mine'));
  });

  it('长按聊天 chip → 打进终端输入行(不回车、不填聊天框);按键 chip 无长按', async () => {
    vi.useFakeTimers();
    const onText = vi.fn();
    render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText });
    const chip = (txt) => [...container.querySelectorAll('.dock-page.chat .quick-cmd')].find((n) => n.textContent === txt);
    fire(chip('ok'), 'pointerdown');
    await act(async () => { await vi.advanceTimersByTimeAsync(450); }); // 按住过阈值 → 打进终端
    fire(chip('ok'), 'pointerup');
    expect(onText).toHaveBeenCalledWith('ok');                          // 打进终端(不回车),和命令模式一致
    expect(container.querySelector('.input-text').value).toBe('');      // 不落进聊天框
    expect(sendText).not.toHaveBeenCalled();                            // 不是 type+Enter 的发送
    vi.useRealTimers();
  });

  it('长按命令模式的「带回车」命令 → 只输入不回车(可编辑再自己跑)', async () => {
    localStorage.setItem('hm_favs6_command', JSON.stringify([{ kind: 'cmd', text: 'git status', enter: true }]));
    vi.useFakeTimers();
    const onText = vi.fn();
    render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText }); // command mode (no agent)
    const chip = [...container.querySelectorAll('.dock-page.command .quick-cmd')].find((n) => n.textContent.startsWith('git status'));
    fire(chip, 'pointerdown');
    await act(async () => { await vi.advanceTimersByTimeAsync(450); }); // 长按
    fire(chip, 'pointerup');
    expect(onText).toHaveBeenCalledWith('git status'); // 只输入,不回车
    expect(sendText).not.toHaveBeenCalled();           // 不是 type+Enter
    vi.useRealTimers();
  });

  it('录音中点发送:先停语音、发当前文字,后续定稿不再回写', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    tap(container.querySelector('.input-mic'));
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
    tap(container.querySelector('.input-mic'));
    expect(voice.start).toHaveBeenCalledTimes(1);
    voice.state = 'recording';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    tap(container.querySelector('.input-mic'));
    expect(voice.stop).toHaveBeenCalledTimes(1);
  });

  it('录音中 partial 实时写进文本框,光标在末尾', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    tap(container.querySelector('.input-mic'));
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
    tap(container.querySelector('.input-mic'));
    voice.state = 'recording'; voice.partial = 'X';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    expect(container.querySelector('.input-text').value).toBe('AXB');
  });

  it('录音中文本框不设 readOnly(否则 iOS 点击不弹键盘、卡死)', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    tap(container.querySelector('.input-mic'));
    voice.state = 'recording'; voice.partial = '你好';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    // 必须可编辑:iOS 对 readOnly 的 textarea 点击不给焦点/不弹键盘,而停语音是异步的 → 那一下点击作废。
    expect(container.querySelector('.input-text').readOnly).toBe(false);
  });

  it('录音中点输入框:停语音 + 接管编辑,尾随定稿被抑制不覆盖', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    tap(container.querySelector('.input-mic'));
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
    tap(container.querySelector('.input-mic'));
    voice.state = 'recording'; voice.partial = '在听';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    expect(container.querySelector('.input-wrap').classList.contains('recording')).toBe(true);
    voice.state = 'idle'; voice.partial = '';
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    expect(container.querySelector('.input-wrap').classList.contains('recording')).toBe(false);
  });

  it('定稿后 onText 把整段留在框里', async () => {
    await render({ pane: '%1', agent: 'claude', onSent: () => {} });
    tap(container.querySelector('.input-mic'));
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

    it('shows a top-left mode label that tracks the active page', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // command
      expect(container.querySelector('.dock-mode-label').textContent).toBe(t('dock.mode.command'));
      swipe(-100); // → chat
      expect(container.querySelector('.dock-mode-label').textContent).toBe(t('dock.mode.chat'));
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
      swipe(-80); // 80px == commit threshold, strict < → does NOT switch, stays on command
      expect(activePage('command')).toBe(true);
    });

    it('a tiny horizontal jitter (like a key press) never locks into a page swipe', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // command by default
      swipe(-12); // under the 16px decide gate → never becomes a swipe; the track never moves
      expect(activePage('command')).toBe(true);
      expect(container.querySelector('.dock-track').style.transform).toBe(''); // no inline drag transform
    });

    it('a held repeat key (keyHeldRef engaged) blocks the pager from paging out from under it', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // command
      const up = container.querySelector('[data-key="up"]');
      // Press-and-hold ▲ (pointerdown) → KeyBar sets keyHeldRef → the pager must ignore a drag on this touch.
      act(() => up.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 100 })));
      act(() => {
        const ev = (type, x, prop) => { const e = new Event(type, { bubbles: true }); e[prop] = [{ clientX: x, clientY: 100 }]; return e; };
        up.dispatchEvent(ev('touchstart', 200, 'touches'));
        up.dispatchEvent(ev('touchmove', 100, 'touches'));      // 100px left — would page, but a key owns it
        up.dispatchEvent(ev('touchend', 100, 'changedTouches'));
      });
      act(() => up.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))); // release the held key
      expect(activePage('command')).toBe(true);                            // stayed put, no switch
      expect(container.querySelector('.dock-track').style.transform).toBe(''); // never parked mid-swipe
    });

    it('tapping the page-dots switches mode (reliable, swipe-free)', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // command
      expect(activePage('command')).toBe(true);
      fire(container.querySelector('.dock-dots'), 'click');
      expect(activePage('chat')).toBe(true);                               // → chat
      fire(container.querySelector('.dock-dots'), 'click');
      expect(activePage('command')).toBe(true);                            // → back
    });

    // A right-drag that STARTS on the quick-command strip: it carries over into a page swipe to command
    // only when the strip is at its left edge (can't scroll further right); otherwise the strip scrolls.
    const stripDrag = (dx, scrollLeft, metrics = {}) => act(() => {
      // The active page's strip is the one under the finger. jsdom reports 0 for every scroll metric, so we
      // mock the ones the carry-over reads. metrics lets a test set scrollWidth/clientWidth (right-edge cases).
      const pageSel = container.querySelector('.dock-page.chat.on') ? '.dock-page.chat' : '.dock-page.command';
      const strip = container.querySelector(`${pageSel} .quick-scroll`);
      Object.defineProperty(strip, 'scrollLeft', { value: scrollLeft, configurable: true, writable: true });
      Object.defineProperty(strip, 'scrollWidth', { value: metrics.scrollWidth ?? 0, configurable: true });
      Object.defineProperty(strip, 'clientWidth', { value: metrics.clientWidth ?? 0, configurable: true });
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

    // Mirror case on the command page: at the strip's RIGHT edge, a further LEFT-drag carries over to chat.
    it('at the command strip right edge, a left-drag on it carries over to the chat page', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // command by default
      expect(activePage('command')).toBe(true);
      stripDrag(-100, 60, { scrollWidth: 100, clientWidth: 40 }); // scrollLeft(60) >= 100-40-1 → at right edge
      expect(activePage('chat')).toBe(true);
    });

    it('when the command strip can still scroll (not at right edge), a left-drag does NOT switch pages', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // command by default
      stripDrag(-80, 10, { scrollWidth: 100, clientWidth: 40 }); // scrollLeft(10) < 59 → native strip scroll
      expect(activePage('command')).toBe(true); // stayed on command
    });

    it('self-heals a transform left stuck between pages (a missed touchend) on the next render', () => {
      render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
      const track = container.querySelector('.dock-track');
      track.style.transform = 'translate3d(-137px, 0, 0)'; // pretend a swipe was interrupted mid-way
      render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn(), recent: ['x'] });
      // an at-rest render drops the inline transform → the CSS class (at-chat for chat) owns rest again
      expect(track.style.transform).toBe('');
      expect(track.classList.contains('at-chat')).toBe(true); // page-aligned to chat via the class
    });

    // Root fix for "typed in chat, switched to command, pressed a key → chat content peeks + dock stuck at
    // half": the browser scrolls the overflow:hidden pager sideways to reveal the still-focused off-screen
    // composer. The pager must never scroll — a scroll snaps straight back to 0.
    it('pins the pager scroll to 0 (the browser must not scroll a page into view)', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // command
      const pager = container.querySelector('.dock-pager');
      pager.scrollLeft = 137; // pretend the browser scroll-revealed a focused off-screen field
      act(() => pager.dispatchEvent(new Event('scroll', { bubbles: false })));
      expect(pager.scrollLeft).toBe(0);
    });

    // Switching chat → command blurs the composer so its off-screen textarea can't keep focus (and pull the
    // pager sideways). Focus the composer, flip to command, and it must no longer be the active element.
    it('blurs the chat composer when leaving chat for command', () => {
      render({ pane: '%1', agent: 'claude', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() }); // chat
      const composer = container.querySelector('.input-text');
      act(() => composer.focus());
      expect(document.activeElement).toBe(composer);
      fire(container.querySelector('.dock-dots'), 'click'); // → command
      expect(document.activeElement).not.toBe(composer);
    });

    it('the 展开/收起键盘 toggle (command quick-bar) pops / dismisses the keyboard', () => {
      render({ pane: '%1', onAuthFail: vi.fn(), onKey: vi.fn(), onText: vi.fn() });
      const kbd = container.querySelector('.dock-page.command .quick-fix'); // the keyboard toggle
      fire(kbd, 'click');
      expect(document.activeElement).toBe(cap());        // focused → keyboard up
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
