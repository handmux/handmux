import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
vi.mock('../src/bundledFonts.js', () => ({ ensureBundledFonts: vi.fn(() => new Promise(() => {})) }));

const keyCodes: Record<string, number> = {
  ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
  Insert: 45, Delete: 46, Backspace: 8, Tab: 9, Escape: 27,
};

const terminals: Terminal[] = [];
let TerminalCtor: typeof Terminal;
beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  ({ Terminal: TerminalCtor } = await import('@xterm/xterm'));
  window.matchMedia = vi.fn(() => ({
    matches: false, media: '', onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }));
});
afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  document.body.replaceChildren();
});

function press(helper: HTMLTextAreaElement, key: string, modifiers: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', {
    key, code: key, bubbles: true, cancelable: true, ...modifiers,
  });
  Object.defineProperty(event, 'keyCode', { value: keyCodes[key] });
  return helper.dispatchEvent(event);
}

describe('real xterm desktop navigation keys', () => {
  it('emits terminal sequences for ordinary navigation keys', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const term = new TerminalCtor({ allowProposedApi: true });
    terminals.push(term);
    term.open(host);
    const helper = host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
    const data: string[] = [];
    term.onData((value) => data.push(value));
    const matrix: [string, string][] = [
      ['Home', '\x1b[H'], ['End', '\x1b[F'],
      ['PageUp', '\x1b[5~'], ['PageDown', '\x1b[6~'],
      ['Insert', '\x1b[2~'], ['Delete', '\x1b[3~'],
      ['Backspace', '\x7f'], ['Tab', '\t'], ['Escape', '\x1b'],
      ['ArrowLeft', '\x1b[D'], ['ArrowRight', '\x1b[C'],
      ['ArrowUp', '\x1b[A'], ['ArrowDown', '\x1b[B'],
    ];
    for (const [key, sequence] of matrix) {
      data.length = 0;
      press(helper, key);
      expect(data.join(''), key).toBe(sequence);
    }
  });

  it('distinguishes terminal modifiers from browser or viewport shortcuts', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const term = new TerminalCtor({ allowProposedApi: true });
    terminals.push(term);
    term.open(host);
    const helper = host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
    const data: string[] = [];
    term.onData((value) => data.push(value));
    const matrix: [string, KeyboardEventInit, string][] = [
      ['Home', { ctrlKey: true }, '\x1b[1;5H'],
      ['End', { ctrlKey: true }, '\x1b[1;5F'],
      ['Home', { shiftKey: true }, '\x1b[1;2H'],
      ['PageUp', { ctrlKey: true }, '\x1b[5;5~'],
      ['PageDown', { ctrlKey: true }, '\x1b[6;5~'],
      ['PageUp', { shiftKey: true }, ''], // xterm scrollback, not application input
      ['PageDown', { shiftKey: true }, ''],
      ['ArrowLeft', { metaKey: true }, ''], // upstream xterm reserves macOS Command+arrow
      ['ArrowRight', { metaKey: true }, ''],
    ];
    for (const [key, modifiers, sequence] of matrix) {
      data.length = 0;
      press(helper, key, modifiers);
      expect(data.join(''), `${JSON.stringify(modifiers)}+${key}`).toBe(sequence);
    }
  });

  it('uses application-mode Home and End sequences when a full-screen app enables them', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const term = new TerminalCtor({ allowProposedApi: true });
    terminals.push(term);
    term.open(host);
    await new Promise<void>((resolve) => term.write('\x1b[?1h', resolve));
    const helper = host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
    const data: string[] = [];
    term.onData((value) => data.push(value));
    press(helper, 'Home');
    press(helper, 'End');
    expect(data).toEqual(['\x1bOH', '\x1bOF']);
  });

  it('forwards page-level Home and End through the production xterm adapter', async () => {
    const { openXterm } = await import('../src/terminalXterm.js');
    const host = document.createElement('div');
    document.body.append(host);
    const received: string[] = [];
    const namedKeys: string[][] = [];
    const opened = openXterm({
      host, desktop: true, autoFocusInput: false, fontSize: 14, scrollback: 100, pane: '%test',
      onInputData: (_pane, data) => received.push(String(data)),
      onInputKeys: (_pane, keys) => namedKeys.push([...keys]),
    });
    terminals.push(opened.term);
    for (const [key, keyCode] of [['Home', 36], ['End', 35]] as const) {
      const event = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
      Object.defineProperty(event, 'keyCode', { value: keyCode });
      expect(opened.forwardPageKey(event), key).toBe(true);
      expect(namedKeys.at(-1), key).toEqual([key]);
    }
    const helper = host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
    for (const [key, keyCode] of [['Home', 36], ['End', 35]] as const) {
      received.length = 0;
      const event = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
      Object.defineProperty(event, 'keyCode', { value: keyCode });
      helper.dispatchEvent(event);
      expect(namedKeys.at(-1), key).toEqual([key]);
    }
    opened.dispose();
  });

  it('recovers a direct IME commit rejected after a preceding keydown', async () => {
    const { openXterm } = await import('../src/terminalXterm.js');
    const host = document.createElement('div');
    document.body.append(host);
    const received: string[] = [];
    const opened = openXterm({
      host, desktop: true, autoFocusInput: false, fontSize: 14, scrollback: 100, pane: '%ime',
      onInputData: (_pane, data) => received.push(String(data)),
    });
    terminals.push(opened.term);
    const helper = host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;

    const priorKey = new KeyboardEvent('keydown', {
      key: 'Shift', code: 'ShiftLeft', bubbles: true, cancelable: true,
    });
    Object.defineProperty(priorKey, 'keyCode', { value: 16 });
    helper.dispatchEvent(priorKey);

    helper.value = '你好，';
    helper.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      composed: true,
      inputType: 'insertText',
      data: '你好，',
    }));

    const imeKey = new KeyboardEvent('keydown', {
      key: 'Process', code: 'Unidentified', bubbles: true, cancelable: true,
    });
    Object.defineProperty(imeKey, 'keyCode', { value: 229 });
    helper.dispatchEvent(imeKey);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received.join('')).toBe('你好，');
    opened.dispose();
  });

  it('leaves the keyCode-229-first sequence to xterm textarea diffing', async () => {
    const { openXterm } = await import('../src/terminalXterm.js');
    const host = document.createElement('div');
    document.body.append(host);
    const received: string[] = [];
    const opened = openXterm({
      host, desktop: true, autoFocusInput: false, fontSize: 14, scrollback: 100, pane: '%ime',
      onInputData: (_pane, data) => received.push(String(data)),
    });
    terminals.push(opened.term);
    const helper = host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
    const imeKey = new KeyboardEvent('keydown', {
      key: 'Process', code: 'Unidentified', bubbles: true, cancelable: true,
    });
    Object.defineProperty(imeKey, 'keyCode', { value: 229 });
    helper.dispatchEvent(imeKey);

    helper.value = '你好，';
    helper.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      composed: true,
      inputType: 'insertText',
      data: '你好，',
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received.join('')).toBe('你好，');
    opened.dispose();
  });
});
