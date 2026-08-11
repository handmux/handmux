import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');

const mocks = vi.hoisted(() => ({
  instances: [],
  getHistory: vi.fn(() => new Promise(() => {})),
  sendInput: vi.fn(),
  openTerminalStream: vi.fn(),
  createStreamMirror: vi.fn(() => {
    let revision = 0;
    let seed = null;
    let cursor = null;
    return {
      async seed(frame) {
        seed = frame;
        revision += 1;
      },
      async data() {
        revision += 1;
      },
      async ready(cur) {
        cursor = cur;
        revision += 1;
      },
      snapshot() {
        const historyRows = Number(seed?.historyLines) || 0;
        return seed && cursor ? {
          revision,
          ansi: seed.ansi,
          cur: cursor,
          cursorVisible: !!cursor.vis,
          alt: !!seed.alt,
          mouseAware: !!seed.mouseAware,
          boundaryLine: seed.alt ? null : historyRows,
          bufferRows: historyRows + seed.height,
          paneRows: seed.height,
          paneCols: seed.width,
        } : null;
      },
      get revision() { return revision; },
      dispose: vi.fn(),
    };
  }),
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const touchEvent = (type, x, y) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: [{ clientX: x, clientY: y }],
  });
  return event;
};

vi.mock('../src/api.js', () => ({
  UnauthorizedError: mocks.UnauthorizedError,
  getHistory: mocks.getHistory,
  scrollPane: vi.fn(),
  sendInput: mocks.sendInput,
  sendKeys: vi.fn(),
}));

vi.mock('../src/bundledFonts.js', () => ({
  ensureBundledFonts: vi.fn(() => new Promise(() => {})),
}));

vi.mock('../src/terminalStreamClient.js', () => ({
  openTerminalStream: mocks.openTerminalStream,
}));

vi.mock('../src/terminalStreamMirror.js', () => ({
  createTerminalStreamMirror: mocks.createStreamMirror,
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    serialize() { return ''; }
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = options;
      this.cols = 80;
      this.rows = 24;
      this.buffer = {
        active: {
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          length: 24,
          viewportY: 0,
          getLine: () => undefined,
        },
      };
      this.focus = vi.fn(() => this.helper?.dispatchEvent(new FocusEvent('focus')));
      this.blur = vi.fn(() => this.helper?.dispatchEvent(new FocusEvent('blur')));
      this.refresh = vi.fn();
      this.dispose = vi.fn();
      this.write = vi.fn((_data, callback) => callback?.());
      this.input = vi.fn();
      this.resize = vi.fn((cols, rows) => { this.cols = cols; this.rows = rows; });
      this.scrollLines = vi.fn((delta) => {
        this.buffer.active.viewportY = Math.max(
          0,
          Math.min(this.buffer.active.baseY, this.buffer.active.viewportY + delta),
        );
        this.onScrollCallback?.(this.buffer.active.viewportY);
      });
      this.scrollToBottom = vi.fn();
      this.scrollToTop = vi.fn();
      this.scrollToLine = vi.fn();
      this.registerMarker = vi.fn(() => ({ dispose: vi.fn() }));
      this.registerDecoration = vi.fn(() => ({
        dispose: vi.fn(),
        onRender: vi.fn(),
      }));
      this._subscriptions = [];
      this._selection = '';
      mocks.instances.push(this);
    }

    open(host) {
      const root = document.createElement('div');
      root.className = 'xterm';
      const screen = document.createElement('div');
      screen.className = 'xterm-screen';
      const viewport = document.createElement('div');
      viewport.className = 'xterm-viewport';
      const helper = document.createElement('textarea');
      helper.className = 'xterm-helper-textarea';
      root.append(screen, viewport, helper);
      host.append(root);
      this.helper = helper;
    }

    loadAddon() {}
    registerLinkProvider() { return { dispose: vi.fn() }; }
    onScroll(callback) {
      this.onScrollCallback = callback;
      const sub = { dispose: vi.fn() };
      this._subscriptions.push(sub);
      return sub;
    }
    onData(callback) {
      this.onDataCallback = callback;
      const sub = { dispose: vi.fn() };
      this._subscriptions.push(sub);
      return sub;
    }
    onSelectionChange(callback) {
      this.onSelectionChangeCallback = callback;
      const sub = { dispose: vi.fn() };
      this._subscriptions.push(sub);
      return sub;
    }
    hasSelection() { return this._selection.length > 0; }
    getSelection() { return this._selection; }
    clearSelection() {
      this._selection = '';
      this.onSelectionChangeCallback?.();
    }
    setSelection(text) {
      this._selection = text;
      this.onSelectionChangeCallback?.();
    }
    attachCustomKeyEventHandler(callback) {
      this.customKeyHandler = callback;
    }
  },
}));

import RawTerminal from '../src/components/Terminal.jsx';
import { useDesktopTerminalInput } from '../src/hooks/useDesktopTerminalInput.js';

const Terminal = React.forwardRef(function QueuedTerminal(props, forwardedRef) {
  const terminalRef = React.useRef(null);
  const enqueue = useDesktopTerminalInput({
    enabled: props.desktop,
    currentPane: props.pane,
    terminalRef,
    onAuthFail: props.onAuthFail,
    send: mocks.sendInput,
  });
  const setRef = React.useCallback((value) => {
    terminalRef.current = value;
    if (typeof forwardedRef === 'function') forwardedRef(value);
    else if (forwardedRef) forwardedRef.current = value;
  }, [forwardedRef]);
  return <RawTerminal {...props} ref={setRef} onInputData={enqueue} />;
});

const revealStreamFrame = async (callbacks, ansi = 'ready') => {
  await act(async () => callbacks.onSeed({
    ansi: `${ansi}\n`,
    width: 80,
    height: 24,
    historyLines: 0,
    alt: false,
    mouseAware: false,
  }));
  await act(async () => callbacks.onReady({ cur: { row: 0, col: 0, vis: true } }));
  await act(async () => {
    vi.advanceTimersByTime(450);
    await Promise.resolve();
  });
};

describe('desktop terminal input', () => {
  beforeEach(() => {
    mocks.instances.length = 0;
    mocks.getHistory.mockReset().mockImplementation(() => new Promise(() => {}));
    mocks.sendInput.mockReset();
    mocks.createStreamMirror.mockClear();
    mocks.openTerminalStream.mockReset().mockReturnValue({
      pause: vi.fn(),
      suspend: vi.fn(),
      resync: vi.fn(),
      close: vi.fn(() => Promise.resolve()),
    });
    delete navigator.clipboard;
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
  });

  afterEach(() => {
    cleanup();
    if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
    vi.useRealTimers();
    delete document.hidden;
    delete navigator.platform;
    delete window.visualViewport;
  });

  it('keeps mobile xterm read-only and never exposes its helper textarea', () => {
    render(<Terminal pane="%1" desktop={false} />);

    const term = mocks.instances[0];
    expect(term.options.disableStdin).toBe(true);
    expect(term.helper.readOnly).toBe(true);
    expect(term.helper.getAttribute('inputmode')).toBe('none');
  });

  it('enables desktop stdin, focuses on mount, and queues onData for the captured pane', async () => {
    mocks.sendInput.mockResolvedValue({ ok: true });
    render(<Terminal pane="%1" desktop />);

    const term = mocks.instances[0];
    expect(term.options.disableStdin).toBe(false);
    expect(term.helper.readOnly).toBe(false);
    expect(term.helper.tabIndex).toBe(0);
    expect(term.helper.hasAttribute('inputmode')).toBe(false);
    expect(term.helper.hasAttribute('aria-hidden')).toBe(false);
    expect(term.helper.closest('.terminal').classList.contains('desktop-input')).toBe(true);
    expect(term.focus).toHaveBeenCalled();
    term.onDataCallback('a\u001b[A');
    await vi.waitFor(() => expect(mocks.sendInput).toHaveBeenCalledWith('%1', '611b5b41'));
  });

  it('allows pointer focus only for the desktop helper textarea', () => {
    expect(styles).toMatch(/\.terminal \.xterm-helper-textarea\s*\{[^}]*pointer-events:\s*none/);
    expect(styles).toMatch(/\.terminal\.desktop-input \.xterm-helper-textarea\s*\{[^}]*pointer-events:\s*auto/);
  });

  it('keeps both terminal touch axes in the JavaScript gesture path', () => {
    expect(styles).toMatch(/\.terminal\s*\{[^}]*touch-action:\s*none/);
    expect(styles).toMatch(/\.terminal \.xterm-viewport\s*\{[^}]*touch-action:\s*none/);
  });

  it('anchors the top banner and connection labels to one stable visible-top line', () => {
    expect(styles).toMatch(
      /\.term-banner\s*\{[^}]*top:\s*var\(--terminal-overlay-top,\s*1px\)[^}]*height:\s*25px/,
    );
    expect(styles).toMatch(
      /\.terminal-connection\s*\{[^}]*top:\s*calc\(var\(--terminal-overlay-top,\s*1px\)\s*\+\s*1px\)/,
    );
    expect(styles).toMatch(
      /\.terminal-connection__tag\s*\{[^}]*height:\s*23px/,
    );
  });

  it('keeps the desktop input class after the first terminal frame is revealed', async () => {
    mocks.getHistory.mockResolvedValue({
      ansi: 'ready',
      hash: 'frame-1',
      width: 80,
      height: 24,
      alt: false,
      mouseAware: false,
      cur: { row: 23, col: 0, vis: true },
    });
    const view = render(<Terminal pane="%1" desktop />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(view.container.querySelector('.terminal').classList.contains('terminal--loading')).toBe(false);
    expect(view.container.querySelector('.terminal').classList.contains('desktop-input')).toBe(true);
  });

  it('reveals the first live frame only after its final fitted grid is painted', async () => {
    vi.useFakeTimers();
    let callbacks;
    mocks.openTerminalStream.mockImplementation((options) => {
      callbacks = options;
      return {
        pause: vi.fn(),
        suspend: vi.fn(),
        resync: vi.fn(),
        close: vi.fn(() => Promise.resolve()),
      };
    });
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function getRect() {
        const height = this.classList?.contains('xterm-screen')
          ? (mocks.instances[0]?.rows || 24) * 10
          : 400;
        return {
          x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height,
          width: 800, height, toJSON() {},
        };
      });
    const view = render(<Terminal pane="%1" stream />);
    await vi.waitFor(() => expect(callbacks).toBeDefined());

    await act(async () => callbacks.onSeed({
      ansi: 'first-live-frame\n',
      width: 80,
      height: 24,
      historyLines: 0,
      alt: false,
      mouseAware: false,
    }));
    await act(async () => callbacks.onReady({ cur: { row: 0, col: 0, vis: true } }));

    const term = mocks.instances[0];
    expect(view.container.querySelector('.terminal').classList.contains('terminal--loading')).toBe(true);
    expect(term.write.mock.calls.some(([data]) => data.includes('first-live-frame'))).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    expect(term.rows).toBe(40);
    expect(term.write.mock.calls.some(([data]) => data.includes('first-live-frame'))).toBe(true);
    expect(view.container.querySelector('.terminal').classList.contains('terminal--loading')).toBe(false);
    rect.mockRestore();
  });

  it('falls back to snapshot polling when the real-time stream cannot recover', async () => {
    vi.useFakeTimers();
    let callbacks;
    const suspend = vi.fn(() => Promise.resolve());
    mocks.openTerminalStream.mockImplementation((options) => {
      callbacks = options;
      return { pause: vi.fn(), suspend, resync: vi.fn(), close: vi.fn(() => Promise.resolve()) };
    });
    mocks.getHistory.mockResolvedValue({
      ansi: 'fallback',
      hash: 'frame-1',
      width: 80,
      height: 24,
      alt: false,
      mouseAware: false,
      cur: { row: 23, col: 0, vis: true },
    });
    const view = render(<Terminal pane="%1" desktop stream />);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    expect(view.container.querySelector('.terminal-connection')).toBeNull();

    act(() => callbacks.onStatus('reconnecting'));
    await act(async () => {
      vi.advanceTimersByTime(1200);
      await Promise.resolve();
    });

    expect(suspend).toHaveBeenCalledOnce();
    expect(mocks.getHistory).toHaveBeenCalled();
    expect(view.container.querySelector('.terminal').classList.contains('terminal--stream')).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });
    act(() => view.container.querySelector('.terminal-connection__summary').click());
    expect(view.container.querySelector('.terminal-transport-popover').textContent)
      .toContain('请检查反向代理是否支持 WebSocket');
  });

  it('falls back after application RTT remains poor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T00:00:00Z'));
    let callbacks;
    const suspend = vi.fn(() => Promise.resolve());
    mocks.openTerminalStream.mockImplementation((options) => {
      callbacks = options;
      return { pause: vi.fn(), suspend, resync: vi.fn(), close: vi.fn(() => Promise.resolve()) };
    });
    mocks.getHistory.mockResolvedValue({ unchanged: true });
    const view = render(<Terminal pane="%1" desktop stream />);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    expect(view.container.querySelector('.terminal-connection')).toBeNull();
    await revealStreamFrame(callbacks);

    act(() => callbacks.onProbe({ ok: true, rttMs: 1800 }));
    const status = view.container.querySelector('.terminal-connection');
    expect(status.querySelectorAll('.terminal-connection__tag')).toHaveLength(1);
    expect(status.querySelector('.terminal-connection__summary').classList.contains('is-live')).toBe(true);
    expect(status.querySelector('.terminal-connection__summary').tagName).toBe('BUTTON');
    expect(status.querySelector('.terminal-connection__mode').classList.contains('is-live')).toBe(true);
    expect(status.querySelector('.terminal-connection__latency').textContent).toBe('1800 ms');
    expect(status.textContent).toBe('实时·1800 ms');
    act(() => {
      vi.advanceTimersByTime(15000);
      callbacks.onProbe({ ok: true, rttMs: 1800 });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(suspend).toHaveBeenCalledOnce();
    expect(status.querySelector('.terminal-connection__summary').classList.contains('is-snapshot')).toBe(true);
    expect(status.textContent).toContain('快照');
  });

  it('returns to live pushing only after thirty seconds of healthy snapshot traffic', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T00:00:00Z'));
    let callbacks;
    const suspend = vi.fn(() => Promise.resolve());
    const resync = vi.fn();
    mocks.openTerminalStream.mockImplementation((options) => {
      callbacks = options;
      return { pause: vi.fn(), suspend, resync, close: vi.fn(() => Promise.resolve()) };
    });
    const view = render(<Terminal pane="%1" desktop stream />);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    expect(view.container.querySelector('.terminal-connection')).toBeNull();
    await revealStreamFrame(callbacks);

    act(() => callbacks.onStatus('reconnecting'));
    await act(async () => {
      vi.advanceTimersByTime(1200);
      await Promise.resolve();
    });
    expect(view.container.querySelector('.terminal-connection').textContent).toContain('快照');
    act(() => mocks.instances[0].onScrollCallback?.());
    expect(resync).not.toHaveBeenCalled();

    act(() => callbacks.onProbe({ ok: true, rttMs: 100 }));
    act(() => view.container.querySelector('.terminal-connection__summary').click());
    const detail = view.container.querySelector('.terminal-transport-popover');
    expect(detail.textContent).toContain('设置模式实时推送');
    expect(detail.textContent).toContain('当前模式快照拉取');
    expect(detail.textContent).toContain('预计 30 秒后尝试恢复实时推送');
    expect(detail.querySelector('.terminal-transport-popover__value.is-live').textContent)
      .toBe('实时推送');
    expect(detail.querySelector('.terminal-transport-popover__value.is-snapshot').textContent)
      .toBe('快照拉取');
    expect(detail.querySelector('.terminal-transport-popover__connection').textContent)
      .toBe('良好 · 100 ms');
    expect(view.container.querySelector('.terminal-transport-scrim')).toBeNull();
    act(() => view.container.querySelector('.terminal').click());
    expect(view.container.querySelector('.terminal-transport-popover')).toBeNull();
    act(() => view.container.querySelector('.terminal-connection__summary').click());
    expect(view.container.querySelector('.terminal-transport-popover')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(29999);
      callbacks.onProbe({ ok: true, rttMs: 100 });
    });
    expect(resync).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
      callbacks.onProbe({ ok: true, rttMs: 100 });
    });
    expect(resync).toHaveBeenCalledOnce();
    expect(view.container.querySelector('.terminal-connection').textContent).toContain('快照');

    await act(async () => callbacks.onSeed({
      ansi: 'recovered\n',
      width: 80,
      height: 24,
      historyLines: 0,
      alt: false,
      mouseAware: false,
    }));
    await act(async () => callbacks.onReady({ cur: { row: 0, col: 0, vis: true } }));
    act(() => callbacks.onStatus('live'));

    expect(view.container.querySelector('.terminal-connection').textContent).toContain('实时');
  });

  it('coalesces iOS keyboard animation sizes and commits only the final stable fit', async () => {
    vi.useFakeTimers();
    let callbacks;
    mocks.openTerminalStream.mockImplementation((options) => {
      callbacks = options;
      return {
        pause: vi.fn(),
        suspend: vi.fn(),
        resync: vi.fn(),
        close: vi.fn(() => Promise.resolve()),
      };
    });
    let visibleHeight = 160;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function getRect() {
        const height = this.classList?.contains('xterm-screen')
          ? (mocks.instances[0]?.rows || 24) * 10
          : visibleHeight;
        return {
          x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height,
          width: 800, height, toJSON() {},
        };
      });
    const view = render(<Terminal pane="%1" stream inset={300} />);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    await act(async () => callbacks.onSeed({
      ansi: 'prompt\n',
      width: 80,
      height: 24,
      historyLines: 0,
      alt: false,
      mouseAware: false,
    }));
    await act(async () => callbacks.onReady({ cur: { row: 0, col: 0, vis: true } }));
    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });
    expect(mocks.instances[0].rows).toBe(16);

    visibleHeight = 220;
    view.rerender(<Terminal pane="%1" stream inset={240} />);
    await act(async () => {
      // The viewport looks stable long enough to queue a fit, but changes again before that fit runs.
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });
    expect(mocks.instances[0].rows).toBe(16);

    visibleHeight = 300;
    view.rerender(<Terminal pane="%1" stream inset={120} />);
    await act(async () => {
      vi.advanceTimersByTime(20);
      await Promise.resolve();
    });
    expect(mocks.instances[0].rows).toBe(16);

    visibleHeight = 400;
    view.rerender(<Terminal pane="%1" stream inset={0} />);
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    expect(mocks.instances[0].rows).toBe(40);
    rect.mockRestore();
  });

  it('refits when iOS restores visualViewport height while inset remains zero', async () => {
    vi.useFakeTimers();
    let callbacks;
    mocks.openTerminalStream.mockImplementation((options) => {
      callbacks = options;
      return {
        pause: vi.fn(),
        suspend: vi.fn(),
        resync: vi.fn(),
        close: vi.fn(() => Promise.resolve()),
      };
    });
    const viewport = new EventTarget();
    const onViewport = vi.spyOn(viewport, 'addEventListener');
    Object.assign(viewport, { width: 390, height: 400, offsetTop: 368 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    let visibleHeight = 160;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function getRect() {
        const height = this.classList?.contains('xterm-screen')
          ? (mocks.instances[0]?.rows || 24) * 10
          : visibleHeight;
        return {
          x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height,
          width: 800, height, toJSON() {},
        };
    });
    render(<Terminal pane="%1" stream inset={0} />);
    expect(onViewport).toHaveBeenCalledWith('resize', expect.any(Function));
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    await act(async () => callbacks.onSeed({
      ansi: 'prompt\n',
      width: 80,
      height: 24,
      historyLines: 0,
      alt: false,
      mouseAware: false,
    }));
    await act(async () => callbacks.onReady({ cur: { row: 0, col: 0, vis: true } }));
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    const term = mocks.instances[0];
    expect(term.rows).toBe(16);
    term.resize.mockClear();

    visibleHeight = 400;
    viewport.height = 768;
    viewport.offsetTop = 0;
    await act(async () => {
      viewport.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    expect(term.resize).toHaveBeenCalled();
    expect(term.rows).toBe(40);
    rect.mockRestore();
  });

  it('pauses while hidden and replaces a live stream after ten seconds away', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T00:00:00Z'));
    const pause = vi.fn();
    const suspend = vi.fn();
    const resync = vi.fn();
    mocks.openTerminalStream.mockReturnValue({
      pause,
      suspend,
      resync,
      close: vi.fn(() => Promise.resolve()),
    });
    render(<Terminal pane="%1" desktop stream />);
    await vi.waitFor(() => expect(mocks.openTerminalStream).toHaveBeenCalled());

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(pause).toHaveBeenCalledOnce();
    expect(suspend).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(10000));
    expect(suspend).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(suspend).toHaveBeenCalledOnce();
    expect(resync).toHaveBeenCalledOnce();

  });

  it.each(['focus', 'pageshow'])(
    'replaces a possibly frozen live stream when the app returns through %s without visibilitychange',
    async (eventName) => {
      const suspend = vi.fn();
      const resync = vi.fn();
      mocks.openTerminalStream.mockReturnValue({
        pause: vi.fn(),
        suspend,
        resync,
        close: vi.fn(() => Promise.resolve()),
      });
      render(<Terminal pane="%1" desktop stream />);
      await vi.waitFor(() => expect(mocks.openTerminalStream).toHaveBeenCalled());

      act(() => window.dispatchEvent(new Event(eventName)));

      expect(suspend).toHaveBeenCalledOnce();
      expect(resync).toHaveBeenCalledOnce();
    },
  );

  it('parses stream cursor moves off-screen instead of writing raw bytes into the visible grid', async () => {
    let callbacks;
    mocks.openTerminalStream.mockImplementation((options) => {
      callbacks = options;
      return {
        pause: vi.fn(),
        suspend: vi.fn(),
        resync: vi.fn(),
        close: vi.fn(() => Promise.resolve()),
      };
    });
    render(<Terminal pane="%1" desktop stream />);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    const term = mocks.instances[0];

    await act(async () => callbacks.onSeed({
      ansi: 'prompt\n',
      width: 80,
      height: 24,
      historyLines: 0,
      alt: false,
      mouseAware: false,
    }));
    await act(async () => callbacks.onReady({
      cur: { row: 0, col: 6, vis: true },
    }));
    const move = new Uint8Array([0x1b, 0x5b, 0x31, 0x30, 0x3b, 0x31, 0x30, 0x48]);
    await act(async () => callbacks.onData(move));

    expect(term.write).not.toHaveBeenCalledWith(move, expect.any(Function));
  });

  it('repaints a completed resync after the terminal is already visible', async () => {
    let callbacks;
    mocks.openTerminalStream.mockImplementation((options) => {
      callbacks = options;
      return {
        pause: vi.fn(),
        suspend: vi.fn(),
        resync: vi.fn(),
        close: vi.fn(() => Promise.resolve()),
      };
    });
    render(<Terminal pane="%1" desktop stream />);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    await act(async () => callbacks.onSeed({
      ansi: 'initial\n',
      width: 80,
      height: 24,
      historyLines: 0,
      alt: false,
      mouseAware: false,
    }));
    await act(async () => callbacks.onReady({ cur: { row: 0, col: 0, vis: true } }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    const term = mocks.instances[0];
    expect(term.write).toHaveBeenCalledWith(
      expect.stringContaining('initial\n'),
      expect.any(Function),
    );
    term.write.mockClear();

    await act(async () => callbacks.onSeed({
      ansi: 'resynced\n',
      width: 80,
      height: 24,
      historyLines: 0,
      alt: false,
      mouseAware: false,
    }));
    await act(async () => callbacks.onReady({ cur: { row: 0, col: 0, vis: true } }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(term.write).toHaveBeenCalledWith(
      expect.stringContaining('resynced\n'),
      expect.any(Function),
    );
  });

  it('pauses only past the 15-line live zone and resyncs when returning to it', async () => {
    vi.useFakeTimers();
    let callbacks;
    const pause = vi.fn();
    const suspend = vi.fn();
    const resync = vi.fn();
    mocks.openTerminalStream.mockImplementation((options) => {
      callbacks = options;
      return {
        pause,
        suspend,
        resync,
        close: vi.fn(() => Promise.resolve()),
      };
    });
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function getRect() {
        const height = this.classList?.contains('terminal') || this.classList?.contains('xterm')
          ? 400
          : this.classList?.contains('xterm-screen')
            ? (mocks.instances[0]?.rows || 16) * 10
            : 0;
        return {
          x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height,
          width: 800, height, toJSON() {},
        };
      });
    const view = render(<Terminal pane="%1" desktop stream />);
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    const term = mocks.instances[0];

    await act(async () => callbacks.onSeed({
      ansi: Array.from({ length: 116 }, (_, i) => `line-${i}`).join('\n') + '\n',
      width: 80,
      height: 16,
      historyLines: 100,
      alt: false,
      mouseAware: false,
    }));
    await act(async () => callbacks.onReady({
      cur: { row: 0, col: 0, vis: true },
    }));
    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
    });
    const viewport = view.container.querySelector('.terminal__live .xterm-viewport');
    term.buffer.active.baseY = 10;
    term.buffer.active.viewportY = 0;
    act(() => viewport.dispatchEvent(new Event('scroll')));
    expect(pause).not.toHaveBeenCalled();

    term.buffer.active.baseY = 100;
    term.buffer.active.viewportY = 99;
    act(() => viewport.dispatchEvent(new Event('scroll')));
    expect(pause).not.toHaveBeenCalled();

    term.buffer.active.viewportY = 85;
    act(() => viewport.dispatchEvent(new Event('scroll')));
    expect(pause).not.toHaveBeenCalled();

    term.buffer.active.viewportY = 84;
    act(() => viewport.dispatchEvent(new Event('scroll')));
    expect(pause).toHaveBeenCalledOnce();
    expect(resync).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(9999));
    expect(suspend).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(suspend).toHaveBeenCalledOnce();

    term.buffer.active.viewportY = 85;
    act(() => viewport.dispatchEvent(new Event('scroll')));
    expect(resync).toHaveBeenCalledOnce();
    rect.mockRestore();
  });

  it('hands a desktop pointer tap back to terminal input instead of preserving composer focus', () => {
    const onTap = vi.fn();
    const view = render(<Terminal pane="%1" desktop autoFocusInput={false} onTap={onTap} />);
    const composer = document.createElement('textarea');
    view.container.append(composer);
    composer.focus();

    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    mocks.instances[0].helper.closest('.terminal').dispatchEvent(event);

    expect(onTap).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
  });

  it('uses the dock keyboard keeper for every mobile terminal gesture before its axis is known', () => {
    const onKeepKeyboard = vi.fn(() => true);
    const view = render(
      <Terminal pane="%1" desktop={false} onKeepKeyboard={onKeepKeyboard} />,
    );
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });

    view.container.querySelector('.terminal').dispatchEvent(event);

    expect(onKeepKeyboard).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('locks horizontal mobile drags to the outer terminal scroller', () => {
    const view = render(<Terminal pane="%1" desktop={false} />);
    const host = view.container.querySelector('.terminal');
    const screen = view.container.querySelector('.xterm-screen');
    const reachedXterm = vi.fn();
    screen.addEventListener('touchmove', reachedXterm);
    host.scrollLeft = 80;

    const move = touchEvent('touchmove', 160, 102);
    act(() => {
      screen.dispatchEvent(touchEvent('touchstart', 200, 100));
      screen.dispatchEvent(move);
    });

    expect(host.scrollLeft).toBe(120);
    expect(move.defaultPrevented).toBe(true);
    expect(reachedXterm).not.toHaveBeenCalled();
  });

  it('routes a horizontal trackpad gesture past xterm to the outer terminal scroller', () => {
    const view = render(<Terminal pane="%1" desktop />);
    const host = view.container.querySelector('.terminal');
    Object.defineProperties(host, {
      clientWidth: { configurable: true, value: 320 },
      scrollWidth: { configurable: true, value: 640 },
    });
    host.scrollLeft = 12;

    // Real trackpad swipes commonly carry a little deltaY noise. xterm treats any non-zero deltaY as
    // vertical scroll and cancels the whole wheel event, so Handmux must claim horizontal-dominant input
    // before it reaches xterm's inner viewport.
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 30,
      deltaY: 2,
    });
    view.container.querySelector('.xterm-screen').dispatchEvent(event);

    expect(host.scrollLeft).toBe(42);
    expect(event.defaultPrevented).toBe(true);
  });

  it('reserves the mobile scrollbar row only while the terminal really overflows', async () => {
    const view = render(<Terminal pane="%1" desktop={false} />);
    const host = view.container.querySelector('.terminal');
    const screen = view.container.querySelector('.xterm-screen');
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 320 });
    screen.getBoundingClientRect = vi.fn(() => ({
      width: 640,
      height: 384,
      top: 0,
      right: 640,
      bottom: 384,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    }));

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(host.classList.contains('terminal--x-overflow')).toBe(true);

    screen.getBoundingClientRect.mockReturnValue({
      width: 320,
      height: 384,
      top: 0,
      right: 320,
      bottom: 384,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(host.classList.contains('terminal--x-overflow')).toBe(false);
  });

  it('shows and reserves the mobile vertical scrollbar only with real scrollback', async () => {
    const view = render(<Terminal pane="%1" desktop={false} />);
    const term = mocks.instances[0];
    const host = view.container.querySelector('.terminal');
    const viewport = view.container.querySelector('.xterm-viewport');
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 384 });
    Object.assign(term.buffer.active, { baseY: 100, viewportY: 50, length: 124 });

    await act(async () => {
      term.onScrollCallback();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(host.classList.contains('terminal--y-overflow')).toBe(true);
    const thumb = view.container.querySelector('.terminal-y-scrollbar > span');
    expect(thumb.style.top).toBe('155px');
    expect(thumb.style.height).toBe('74px');

    Object.assign(term.buffer.active, { baseY: 0, viewportY: 0, length: 24 });
    await act(async () => {
      term.onScrollCallback();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(host.classList.contains('terminal--y-overflow')).toBe(false);
    expect(view.container.querySelector('.terminal-y-scrollbar')).toBeNull();
  });

  it('exposes focus controls and reports desktop xterm focus changes', () => {
    const ref = React.createRef();
    const onInputFocusChange = vi.fn();
    render(<Terminal ref={ref} pane="%1" desktop onInputFocusChange={onInputFocusChange} />);

    const term = mocks.instances[0];
    expect(onInputFocusChange).toHaveBeenCalledWith(true);
    const mountFocusCalls = term.focus.mock.calls.length;
    ref.current.focusInput();
    ref.current.blurInput();
    expect(term.focus).toHaveBeenCalledTimes(mountFocusCalls + 1);
    expect(term.blur).toHaveBeenCalledOnce();
    expect(onInputFocusChange.mock.calls).toEqual([[true], [true], [false]]);
  });

  it('can mount desktop input without focusing while an App overlay owns focus', () => {
    const onInputFocusChange = vi.fn();
    render(
      <Terminal
        pane="%1"
        desktop
        autoFocusInput={false}
        onInputFocusChange={onInputFocusChange}
      />,
    );

    expect(mocks.instances[0].focus).not.toHaveBeenCalled();
    expect(onInputFocusChange).not.toHaveBeenCalled();
  });

  it('uses the latest callback props without rebuilding xterm', async () => {
    const input = deferred();
    const firstAuthFail = vi.fn();
    const latestAuthFail = vi.fn();
    const firstFocusChange = vi.fn();
    const latestFocusChange = vi.fn();
    mocks.sendInput.mockReturnValue(input.promise);
    const view = render(
      <Terminal
        pane="%1"
        desktop
        onAuthFail={firstAuthFail}
        onInputFocusChange={firstFocusChange}
      />,
    );
    const term = mocks.instances[0];
    term.onDataCallback('x');
    await vi.waitFor(() => expect(mocks.sendInput).toHaveBeenCalledOnce());

    view.rerender(
      <Terminal
        pane="%1"
        desktop
        onAuthFail={latestAuthFail}
        onInputFocusChange={latestFocusChange}
      />,
    );
    term.helper.dispatchEvent(new FocusEvent('blur'));
    await act(async () => {
      input.reject(new mocks.UnauthorizedError());
      await input.promise.catch(() => {});
    });

    expect(mocks.instances).toHaveLength(1);
    expect(firstFocusChange.mock.calls).toEqual([[true]]);
    expect(latestFocusChange).toHaveBeenCalledWith(false);
    expect(firstAuthFail).not.toHaveBeenCalled();
    expect(latestAuthFail).toHaveBeenCalledOnce();
  });

  it('leaves browser Command shortcuts alone and forwards terminal control keys', async () => {
    mocks.sendInput.mockResolvedValue({ ok: true });
    render(<Terminal pane="%1" desktop />);

    const term = mocks.instances[0];
    for (const key of ['w', 'T', 'l', 'R']) {
      expect(term.customKeyHandler({ key, metaKey: true })).toBe(false);
    }
    expect(term.customKeyHandler({ key: 'F5' })).toBe(false);
    expect(term.customKeyHandler({ key: 'F12' })).toBe(false);

    const terminalKeys = [
      [{ key: 'c', ctrlKey: true }, '\u0003'],
      [{ key: 'r', ctrlKey: true }, '\u0012'],
      [{ key: 'Tab' }, '\t'],
      [{ key: 'Escape' }, '\u001b'],
      [{ key: 'ArrowUp' }, '\u001b[A'],
    ];
    for (const [event, data] of terminalKeys) {
      expect(term.customKeyHandler(event)).toBe(true);
      term.onDataCallback(data);
    }

    await vi.waitFor(() => expect(mocks.sendInput).toHaveBeenCalledWith('%1', '0312091b1b5b41'));
  });

  it('forwards a page-level key through xterm after toolbar focus', () => {
    const ref = React.createRef();
    render(<Terminal ref={ref} pane="%1" desktop />);
    const term = mocks.instances[0];
    const listener = vi.fn((event) => event.preventDefault());
    term.helper.addEventListener('keydown', listener);
    const source = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      code: 'ArrowUp',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(source, 'keyCode', { value: 38 });

    expect(ref.current.forwardPageKey(source)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].keyCode).toBe(38);
    expect(term.focus).toHaveBeenCalled();
  });

  it('uses native desktop copy shortcuts without turning Ctrl+C into copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(<Terminal pane="%1" desktop />);
    const term = mocks.instances[0];
    act(() => term.setSelection('selected text'));

    expect(term.customKeyHandler({ key: 'c', metaKey: true })).toBe(false);
    const preventDefault = vi.fn();
    expect(term.customKeyHandler({
      key: 'c',
      ctrlKey: true,
      shiftKey: true,
      preventDefault,
    })).toBe(false);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('selected text'));
    expect(preventDefault).toHaveBeenCalledOnce();

    expect(term.customKeyHandler({ key: 'c', ctrlKey: true })).toBe(true);
  });

  it('lets Windows and Linux paste shortcuts reach the browser paste event', () => {
    render(<Terminal pane="%1" desktop />);
    const term = mocks.instances[0];

    expect(term.customKeyHandler({ key: 'v', ctrlKey: true })).toBe(false);
    expect(term.customKeyHandler({ key: 'V', ctrlKey: true, shiftKey: true })).toBe(false);
  });

  it('lets Cmd+V paste on Apple platforms while preserving terminal Ctrl+V', () => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    });
    render(<Terminal pane="%1" desktop />);
    const term = mocks.instances[0];

    expect(term.customKeyHandler({ key: 'v', metaKey: true })).toBe(false);
    expect(term.customKeyHandler({ key: 'v', ctrlKey: true })).toBe(true);
  });

  it('pauses snapshot polling for a desktop mouse selection and resumes when it clears', async () => {
    mocks.getHistory.mockResolvedValue({ unchanged: true });
    const ref = React.createRef();
    render(<Terminal ref={ref} pane="%1" desktop />);
    await act(async () => {
      await vi.waitFor(() => expect(mocks.getHistory).toHaveBeenCalledOnce());
    });
    const term = mocks.instances[0];

    act(() => term.setSelection('keep me'));
    act(() => ref.current.wake());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mocks.getHistory).toHaveBeenCalledOnce();

    act(() => term.setSelection(''));
    await act(async () => {
      await vi.waitFor(() => expect(mocks.getHistory.mock.calls.length).toBeGreaterThan(1));
    });
  });

  it('does not apply an in-flight snapshot after desktop selection begins', async () => {
    const frame = deferred();
    mocks.getHistory.mockReturnValue(frame.promise);
    render(<Terminal pane="%1" desktop />);
    await act(async () => {
      await vi.waitFor(() => expect(mocks.getHistory).toHaveBeenCalledOnce());
    });
    const term = mocks.instances[0];

    act(() => term.setSelection('keep me'));
    await act(async () => {
      frame.resolve({ unchanged: false, ansi: 'new output' });
      await frame.promise;
    });

    expect(term.write).not.toHaveBeenCalled();
  });

  it('uses plain Shift+Enter to enter draft mode without sending it to the terminal', () => {
    const onRequestDraft = vi.fn();
    render(<Terminal pane="%1" desktop onRequestDraft={onRequestDraft} />);
    const term = mocks.instances[0];
    const preventDefault = vi.fn();

    expect(term.customKeyHandler({
      key: 'Enter',
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault,
    })).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onRequestDraft).toHaveBeenCalledOnce();

    expect(term.customKeyHandler({
      key: 'Enter',
      shiftKey: true,
      ctrlKey: true,
      altKey: false,
      metaKey: false,
    })).toBe(true);
  });

  it('wakes polling after a delivered desktop input batch', async () => {
    mocks.getHistory.mockResolvedValue({ unchanged: true });
    mocks.sendInput.mockResolvedValue({ ok: true });
    render(<Terminal pane="%1" desktop />);
    await act(async () => {
      await vi.waitFor(() => expect(mocks.getHistory).toHaveBeenCalledOnce());
    });
    const term = mocks.instances[0];

    await act(async () => {
      term.onDataCallback('x');
      await Promise.resolve();
    });

    await act(async () => {
      await vi.waitFor(() => expect(mocks.getHistory.mock.calls.length).toBeGreaterThan(1));
    });
  });

  it('routes unauthorized input failures to authentication handling', async () => {
    const onAuthFail = vi.fn();
    mocks.sendInput.mockRejectedValue(new mocks.UnauthorizedError());
    render(<Terminal pane="%1" desktop onAuthFail={onAuthFail} />);

    await act(async () => {
      mocks.instances[0].onDataCallback('x');
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(onAuthFail).toHaveBeenCalledOnce());
  });

  it('marks the terminal disconnected after other input failures', async () => {
    mocks.sendInput.mockRejectedValue(new Error('offline'));
    const view = render(<Terminal pane="%1" desktop />);

    await act(async () => {
      mocks.instances[0].onDataCallback('x');
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(view.container.textContent).toContain('连接断开'));
  });

  it('shows an actionable message when desktop input targets a pane that has closed', () => {
    const ref = React.createRef();
    const view = render(<Terminal ref={ref} pane="%1" desktop />);
    const term = mocks.instances[0];

    act(() => ref.current.inputFailed({ status: 404, serverError: 'pane not found' }));

    expect(view.container.textContent).toContain('窗格已关闭');
    expect(view.container.textContent).toContain('切换');
    expect(view.container.textContent).not.toContain('连接断开');
    expect(term.helper.closest('.terminal').classList.contains('desktop-input')).toBe(true);
  });

  it('disposes desktop input subscriptions and the queue on unmount', async () => {
    mocks.sendInput.mockResolvedValue({ ok: true });
    const view = render(<Terminal pane="%1" desktop />);
    const term = mocks.instances[0];

    view.unmount();
    term.onDataCallback('late');
    await Promise.resolve();

    expect(term._subscriptions).toHaveLength(3);
    for (const sub of term._subscriptions) expect(sub.dispose).toHaveBeenCalledOnce();
    expect(mocks.sendInput).not.toHaveBeenCalled();
  });

  it('removes helper textarea focus listeners on unmount', () => {
    const onInputFocusChange = vi.fn();
    const view = render(
      <Terminal pane="%1" desktop autoFocusInput={false} onInputFocusChange={onInputFocusChange} />,
    );
    const helper = mocks.instances[0].helper;

    helper.dispatchEvent(new FocusEvent('focus'));
    expect(onInputFocusChange).toHaveBeenCalledWith(true);
    onInputFocusChange.mockClear();

    view.unmount();
    helper.dispatchEvent(new FocusEvent('blur'));
    expect(onInputFocusChange).not.toHaveBeenCalled();
  });

  it('ignores an in-flight input error that settles after unmount', async () => {
    const input = deferred();
    const onAuthFail = vi.fn();
    mocks.sendInput.mockReturnValue(input.promise);
    const view = render(<Terminal pane="%1" desktop onAuthFail={onAuthFail} />);
    await act(async () => {
      mocks.instances[0].onDataCallback('x');
      await vi.waitFor(() => expect(mocks.sendInput).toHaveBeenCalledOnce());
    });

    view.unmount();
    await act(async () => {
      input.reject(new mocks.UnauthorizedError());
      await input.promise.catch(() => {});
    });

    expect(onAuthFail).not.toHaveBeenCalled();
  });

  it('does not let an old pane delivery wake the replacement pane', async () => {
    const input = deferred();
    mocks.getHistory.mockResolvedValue({ unchanged: true });
    mocks.sendInput.mockReturnValue(input.promise);
    const view = render(<Terminal pane="%1" desktop />);
    await act(async () => {
      mocks.instances[0].onDataCallback('x');
      await vi.waitFor(() => expect(mocks.sendInput).toHaveBeenCalledOnce());
    });

    view.rerender(<Terminal pane="%2" desktop />);
    await act(async () => {
      await vi.waitFor(() => expect(mocks.instances).toHaveLength(2));
      await vi.waitFor(() => expect(mocks.getHistory.mock.calls.length).toBeGreaterThanOrEqual(2));
    });
    const callsAfterSwitch = mocks.getHistory.mock.calls.length;
    await act(async () => {
      input.resolve({ ok: true });
      await input.promise;
    });
    await act(async () => { await Promise.resolve(); });

    expect(mocks.getHistory).toHaveBeenCalledTimes(callsAfterSwitch);
  });

  it('does not let an old pane error affect the replacement pane', async () => {
    const input = deferred();
    const onAuthFail = vi.fn();
    mocks.sendInput.mockReturnValue(input.promise);
    const view = render(<Terminal pane="%1" desktop onAuthFail={onAuthFail} />);
    mocks.instances[0].onDataCallback('x');
    await vi.waitFor(() => expect(mocks.sendInput).toHaveBeenCalledOnce());

    view.rerender(<Terminal pane="%2" desktop onAuthFail={onAuthFail} />);
    await act(async () => {
      input.reject(new Error('offline'));
      await input.promise.catch(() => {});
    });

    expect(onAuthFail).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain('连接断开');
  });
});
