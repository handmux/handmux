import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Terminal as XTerm } from '@xterm/xterm';
import type { TerminalStreamOptions } from '../src/terminalStreamClient.js';
import { readFileSync } from 'node:fs';

const harness = vi.hoisted(() => ({
  callbacks: null as TerminalStreamOptions | null,
  term: null as XTerm | null,
  getHistory: vi.fn(() => new Promise(() => {})),
}));

vi.mock('../src/api.js', () => ({
  getHistory: harness.getHistory,
  scrollPane: vi.fn(),
  sendKeys: vi.fn(),
  UnauthorizedError: class extends Error {},
}));
vi.mock('../src/terminalStreamClient.js', () => ({
  openTerminalStream: (callbacks: TerminalStreamOptions) => {
    harness.callbacks = callbacks;
    return { pause() {}, suspend() {}, resync() {}, close() {} };
  },
}));
vi.mock('../src/bundledFonts.js', () => ({ ensureBundledFonts: () => new Promise(() => {}) }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock('../src/terminalXterm.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/terminalXterm.js')>();
  return {
    ...original,
    openXterm: (options: Parameters<typeof original.openXterm>[0]) => {
      const opened = original.openXterm(options);
      harness.term = opened.term;
      return opened;
    },
  };
});

let Terminal: typeof import('../src/components/Terminal.js').default;

beforeAll(async () => {
  const styles = document.createElement('style');
  styles.textContent = readFileSync('src/styles.css', 'utf8');
  document.head.appendChild(styles);
  // Only layout is synthetic. The parser, serializer, alternate buffer, and DOM decoration renderer
  // are the installed production dependencies; replacing those would hide this regression.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  window.matchMedia = vi.fn(() => ({
    matches: false, media: '', onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }));
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('xterm-char-measure-element') ? 320 : 800;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('xterm-char-measure-element') ? 20 : 480;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.classList.contains('xterm-screen') ? harness.term!.rows * 20 : 480;
    return { x: 0, y: 0, top: 0, bottom: height, left: 0, right: 800, width: 800, height, toJSON() {} };
  });
  ({ default: Terminal } = await import('../src/components/Terminal.js'));
});
afterEach(() => {
  cleanup();
  harness.callbacks = null;
  harness.term = null;
  harness.getHistory.mockReset().mockImplementation(() => new Promise(() => {}));
});

const feed = async (data: string) => {
  await act(async () => { await harness.callbacks!.onData!(new TextEncoder().encode(data)); });
};
const start = async () => {
  await act(async () => {
    await harness.callbacks!.onSeed!({
      type: 'seed', historyLines: 0, mouseSgr: false,
      ansi: 'top\nsecond\nthird\nfourth\n', width: 80, height: 24,
      alt: true, mouseAware: false,
    });
    await harness.callbacks!.onReady!({ type: 'ready', cur: { row: 22, col: 2, vis: true } });
  });
};

describe('live full-screen Locate with the real xterm renderer', () => {
  it('shows the selected cursor row in alternate buffer and follows live cursor movement', async () => {
    const view = render(<Terminal pane="%locate" stream />);
    await start();
    fireEvent.click(await view.findByRole('button', { name: '展开终端工具' }));
    let button = view.getByRole('button', { name: '定位光标行' });
    await waitFor(() => expect(harness.term!.buffer.active.type).toBe('alternate'));
    expect(view.container.querySelector('.locate-deco')).toBeNull();
    fireEvent.click(button);

    await waitFor(() => {
      const band = view.container.querySelector<HTMLElement>('.locate-deco');
      expect(band).not.toBeNull();
      expect(band!.style.display).not.toBe('none');
      expect(band!.style.top).toBe('20px');
      expect(band!.style.height).toBe('20px');
      expect(getComputedStyle(band!).pointerEvents).toBe('none');
      expect(band!.getAttribute('aria-hidden')).toBe('true');
    });

    await feed('\x1b[4;3H');
    await waitFor(() => expect(view.container.querySelector<HTMLElement>('.locate-deco')!.style.top).toBe('60px'));
    const band = view.container.querySelector('.locate-deco');
    fireEvent.click(view.getByRole('button', { name: '收起终端工具' }));
    expect(view.queryByRole('button', { name: '定位光标行' })).toBeNull();
    expect(view.container.querySelector('.locate-deco')).toBe(band);
    await feed('\x1b[2;3H');
    await waitFor(() => expect(view.container.querySelector<HTMLElement>('.locate-deco')!.style.top).toBe('20px'));
    fireEvent.click(view.getByRole('button', { name: '展开终端工具' }));
    button = view.getByRole('button', { name: '定位光标行' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await feed('\x1b[4;3H');
    await waitFor(() => expect(view.container.querySelector<HTMLElement>('.locate-deco')!.style.top).toBe('60px'));
    // The visual aid must not change terminal contents, cursor ownership, or native selection.
    expect(harness.term!.buffer.active.cursorY).toBe(3);
    act(() => harness.term!.select(0, 3, 6));
    expect(harness.term!.getSelection()).toBe('fourth');
    fireEvent.click(button);
    expect(view.container.querySelector('.locate-deco')).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(view.container.querySelector('.locate-deco')).not.toBeNull());
    act(() => harness.term!.clearSelection());
    await feed('\x1b[?1049l');
    await waitFor(() => expect(view.container.querySelector('.locate-deco')).toBeNull());
    expect(harness.term!.buffer.active.type).toBe('normal');
  }, 15_000);

  it('keeps snapshot highlighting on its absolute buffer row while scrolling and hides it off-screen', async () => {
    harness.getHistory.mockResolvedValueOnce({
      ansi: Array.from({ length: 48 }, (_, row) => `row-${row}`).join('\n') + '\n',
      width: 80, height: 48, alt: true, cur: { row: 37, col: 2, vis: true },
    });
    const view = render(<Terminal pane="%snapshot" />);
    fireEvent.click(await view.findByRole('button', { name: '展开终端工具' }));
    const button = view.getByRole('button', { name: '定位光标行' });
    await waitFor(() => expect(harness.term!.buffer.active.length).toBe(48));
    fireEvent.click(button);
    await waitFor(() => expect(view.container.querySelector<HTMLElement>('.locate-deco')?.style.top).toBe('200px'));
    expect(harness.term!.buffer.active.type).toBe('normal');

    act(() => harness.term!.scrollToLine(5));
    expect(view.container.querySelector<HTMLElement>('.locate-deco')?.style.top).toBe('100px');
    act(() => harness.term!.scrollToLine(12));
    expect(view.container.querySelector('.locate-deco')).toBeNull();
    act(() => harness.term!.scrollToLine(5));
    await waitFor(() => expect(view.container.querySelector<HTMLElement>('.locate-deco')?.style.top).toBe('100px'));
  });

  it('repaints at the current cell height after a resize and removes the layer on pane change and unmount', async () => {
    const view = render(<Terminal pane="%one" stream />);
    await start();
    fireEvent.click(await view.findByRole('button', { name: '展开终端工具' }));
    const button = view.getByRole('button', { name: '定位光标行' });
    await waitFor(() => expect(harness.term!.buffer.active.type).toBe('alternate'));
    fireEvent.click(button);
    await waitFor(() => expect(view.container.querySelector<HTMLElement>('.locate-deco')?.style.top).toBe('20px'));

    // xterm publishes its current CSS grid dimensions on the screen. A refresh must reread those,
    // not preserve the previous 20px height (as occurs when font/viewport geometry changes).
    const screen = view.container.querySelector<HTMLElement>('.xterm-screen')!;
    screen.style.height = '576px';
    act(() => harness.term!.refresh(0, harness.term!.rows - 1));
    await waitFor(() => {
      const band = view.container.querySelector<HTMLElement>('.locate-deco')!;
      expect(band.style.height).toBe('24px');
      expect(band.style.top).toBe('24px');
    });

    const previousBand = view.container.querySelector('.locate-deco')!;
    view.rerender(<Terminal pane="%two" stream />);
    expect(previousBand.isConnected).toBe(false);
    expect(view.container.querySelector('.locate-deco')).toBeNull();
    await start();
    await waitFor(() => expect(view.container.querySelector('.locate-deco')).not.toBeNull());
    const nextBand = view.container.querySelector('.locate-deco')!;
    view.unmount();
    expect(nextBand.isConnected).toBe(false);
  });
});
