import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

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
});
