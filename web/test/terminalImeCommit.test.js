import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ instances: [] }));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));

vi.mock('../src/bundledFonts.js', () => ({
  ensureBundledFonts: vi.fn(() => new Promise(() => {})),
}));

// A miniature of xterm 5.5's DOM input path, limited to the parts that decide whether a Firefox IME
// single-character commit survives. Copied from the upstream sources read at tag 5.5.0:
//   src/browser/Terminal.ts                       _keyDown / _keyPress / _inputEvent
//   src/browser/input/CompositionHelper.ts        _handleAnyTextareaChanges
vi.mock('@xterm/xterm', () => {
  class Terminal {
    constructor(options) {
      this.options = options;
      this.cols = 80;
      this.rows = 24;
      this._keyDownSeen = false;
      this._keyPressHandled = false;
      this._composing = false;
      this._sendingComposition = false;
      this._compositionStart = 0;
      this._subscriptions = [];
      mocks.instances.push(this);
    }

    open(host) {
      const root = document.createElement('div');
      root.className = 'xterm';
      const helper = document.createElement('textarea');
      helper.className = 'xterm-helper-textarea';
      root.append(helper);
      host.append(root);
      this.helper = helper;

      helper.addEventListener('keydown', (event) => {
        this._keyDownSeen = true;
        this._keyPressHandled = false;
        // CompositionHelper.keydown(): the 229 branch diffs the textarea on a 0ms timeout, but only
        // when no composition is in flight.
        if (event.keyCode === 229 && !this._composing && !this._sendingComposition) {
          this._handleAnyTextareaChanges();
        }
      }, true);
      helper.addEventListener('keypress', (event) => {
        // Terminal._keyPress character derivation.
        const key = event.charCode
          ? event.charCode
          : (event.which == null ? event.keyCode : (event.which !== 0 && event.charCode !== 0 ? event.which : 0));
        if (!key || this._keyDownHandled) return;
        this._keyPressHandled = true;
        this.input(String.fromCharCode(key), true);
      }, true);
      helper.addEventListener('keyup', () => { this._keyDownSeen = false; }, true);
      helper.addEventListener('compositionstart', () => {
        this._composing = true;
        this._compositionStart = helper.value.length;
      }, true);
      helper.addEventListener('compositionend', () => {
        // CompositionHelper._finalizeComposition(true): delivery comes from a saved-position slice of
        // the textarea on a 0ms timeout, not from the compositionend event itself.
        this._composing = false;
        this._sendingComposition = true;
        const start = this._compositionStart;
        setTimeout(() => {
          if (!this._sendingComposition) return;
          this._sendingComposition = false;
          const input = helper.value.substring(start);
          if (input.length) this.input(input, true);
        }, 0);
      }, true);
      // _inputEvent(): the guard this workaround exists for.
      helper.addEventListener('input', (event) => {
        if (event.data && event.inputType === 'insertText'
          && (!event.composed || !this._keyDownSeen)) {
          if (this._keyPressHandled) return;
          event.preventDefault();
          this.input(event.data, true);
        }
      }, true);
    }

    _handleAnyTextareaChanges() {
      const oldValue = this.helper.value;
      setTimeout(() => {
        if (this._composing) return;
        const newValue = this.helper.value;
        const diff = newValue.replace(oldValue, '');
        if (newValue.length > oldValue.length) this.input(diff, true);
        else if (newValue.length < oldValue.length) this.input('\x7f', true);
        else if (newValue !== oldValue) this.input(newValue, true);
      }, 0);
    }

    focus() {}
    blur() {}
    refresh() {}
    dispose() {}
    loadAddon() {}
    registerLinkProvider() { return { dispose: vi.fn() }; }
    attachCustomKeyEventHandler(callback) { this.customKeyHandler = callback; }
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
    hasSelection() { return false; }
    input(data) { this.onDataCallback?.(data); }
  }
  return { Terminal };
});

import { isDroppedImeCommit, openXterm } from '../src/terminalXterm.js';

function mount({ desktop = true, onInputData = () => {} } = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const result = openXterm({
    host,
    desktop,
    autoFocusInput: false,
    fontSize: 14,
    scrollback: 100,
    pane: '%1',
    onInputData,
  });
  return { host, helper: host.querySelector('.xterm-helper-textarea'), ...result };
}

const imeKeyDown = (helper) => {
  helper.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true }));
};

// The browser inserts the committed character into the helper textarea, then fires `input`.
const commitInput = (helper, data, init = {}) => {
  helper.value = data;
  helper.dispatchEvent(new InputEvent('input', {
    data,
    inputType: 'insertText',
    isComposing: false,
    composed: true,
    bubbles: true,
    cancelable: true,
    ...init,
  }));
};

const state = (patch = {}) => ({
  composing: false,
  imeKeyDown: true,
  valueBeforeCommit: '',
  keyPressDelivered: false,
  ...patch,
});

const inputEvent = (patch = {}) => ({
  inputType: 'insertText',
  data: '，',
  isComposing: false,
  defaultPrevented: false,
  ...patch,
});

beforeEach(() => {
  mocks.instances.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('isDroppedImeCommit', () => {
  it('accepts exactly the Firefox IME commit xterm drops', () => {
    expect(isDroppedImeCommit(inputEvent(), state())).toBe(true);
  });

  it('rejects everything that has another delivery path', () => {
    // xterm's capture listener already accepted and cancelled the event (Chromium, non-composed).
    expect(isDroppedImeCommit(inputEvent({ defaultPrevented: true }), state())).toBe(false);
    // A composition session is in flight: compositionend owns delivery.
    expect(isDroppedImeCommit(inputEvent({ isComposing: true }), state())).toBe(false);
    // compositionend fired and its commit input is still on the way.
    expect(isDroppedImeCommit(inputEvent(), state({ composing: true }))).toBe(false);
    // A real composition started since the 229 keydown.
    expect(isDroppedImeCommit(inputEvent(), state({ imeKeyDown: false }))).toBe(false);
    // xterm's keypress path already sent the character.
    expect(isDroppedImeCommit(inputEvent(), state({ keyPressDelivered: true }))).toBe(false);
  });

  it('rejects input events that carry no committed text', () => {
    expect(isDroppedImeCommit(inputEvent({ data: '' }), state())).toBe(false);
    expect(isDroppedImeCommit(inputEvent({ data: null }), state())).toBe(false);
    expect(isDroppedImeCommit(inputEvent({ inputType: 'deleteContentBackward' }), state())).toBe(false);
  });
});

describe('desktop IME commit fallback', () => {
  it('forwards a Firefox/fcitx5 full-width punctuation commit exactly once', () => {
    const sent = [];
    const { helper, dispose } = mount({ onInputData: (pane, data) => sent.push(data) });

    imeKeyDown(helper);
    commitInput(helper, '，');
    vi.runAllTimers();

    expect(sent).toEqual(['，']);
    // The textarea is restored so xterm's own 229 diff stays empty.
    expect(helper.value).toBe('');
    dispose();
  });

  it('still sends exactly once when xterm\'s 229 textarea diff runs before the input event', () => {
    const sent = [];
    const { helper, dispose } = mount({ onInputData: (pane, data) => sent.push(data) });

    imeKeyDown(helper);
    vi.runAllTimers(); // textarea not updated yet: the diff is empty, nothing is forwarded
    commitInput(helper, '。');
    vi.runAllTimers();

    expect(sent).toEqual(['。']);
    dispose();
  });

  it('restores a helper textarea that already held text', () => {
    const sent = [];
    const { helper, dispose } = mount({ onInputData: (pane, data) => sent.push(data) });

    helper.value = 'ab';
    imeKeyDown(helper);
    helper.value = 'ab，'; // browser appends the commit to the leftover value
    helper.dispatchEvent(new InputEvent('input', {
      data: '，',
      inputType: 'insertText',
      isComposing: false,
      composed: true,
      bubbles: true,
      cancelable: true,
    }));
    vi.runAllTimers();

    expect(sent).toEqual(['，']);
    expect(helper.value).toBe('ab');
    dispose();
  });

  it('adds nothing when xterm accepts the commit itself (Chromium: composed === false)', () => {
    const sent = [];
    const { helper, dispose } = mount({ onInputData: (pane, data) => sent.push(data) });

    helper.dispatchEvent(new KeyboardEvent('keydown', { key: '，', keyCode: 188, bubbles: true }));
    commitInput(helper, '，', { composed: false });
    vi.runAllTimers();

    expect(sent).toEqual(['，']);
    expect(helper.value).toBe('，');
    dispose();
  });

  it('leaves a real composition session to xterm\'s compositionend path', () => {
    const sent = [];
    const { helper, dispose } = mount({ onInputData: (pane, data) => sent.push(data) });

    helper.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    imeKeyDown(helper);
    commitInput(helper, '，', { isComposing: true });
    helper.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.runAllTimers();

    expect(sent).toEqual(['，']);
    dispose();
  });

  it('stays out of the commit input that xterm\'s finalize position slice owns', () => {
    const sent = [];
    const { helper, dispose } = mount({ onInputData: (pane, data) => sent.push(data) });

    helper.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    helper.value = 'ha'; // preedit already in the textarea when the next 229 keydown arrives
    imeKeyDown(helper);
    helper.value = '好';
    commitInput(helper, '好', { isComposing: true });
    helper.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    commitInput(helper, '好', { isComposing: false }); // the commit input after compositionend
    vi.runAllTimers();

    // xterm's finalize slice sends the composed text; forwarding it here as well would duplicate it,
    // and rewriting the textarea to the stale preedit would make that slice send `ha` too.
    expect(sent).toEqual(['好']);
    expect(helper.value).toBe('好');
    dispose();
  });

  it('still forwards when the keypress carried no character code', () => {
    const sent = [];
    const { helper, dispose } = mount({ onInputData: (pane, data) => sent.push(data) });

    imeKeyDown(helper);
    // xterm's _keyPress derives no character from this, so it delivers nothing.
    helper.dispatchEvent(new KeyboardEvent('keypress', {
      keyCode: 229, which: 229, charCode: 0, bubbles: true,
    }));
    commitInput(helper, '，');
    vi.runAllTimers();

    expect(sent).toEqual(['，']);
    dispose();
  });

  it('does not re-send a character the keypress path already delivered', () => {
    const sent = [];
    const { helper, dispose } = mount({ onInputData: (pane, data) => sent.push(data) });

    imeKeyDown(helper);
    helper.dispatchEvent(new KeyboardEvent('keypress', { keyCode: 65292, charCode: 65292, bubbles: true }));
    commitInput(helper, '，');
    // xterm's own 229 fallback is out of scope here; only assert this module added no second send.
    vi.clearAllTimers();

    expect(sent).toEqual(['，']);
    dispose();
  });

  it('never installs the fallback on mobile, where the terminal is read-only', () => {
    const sent = [];
    const { helper, dispose } = mount({ desktop: false, onInputData: (pane, data) => sent.push(data) });
    expect(helper.readOnly).toBe(true);

    imeKeyDown(helper);
    helper.value = '，';
    const event = new InputEvent('input', {
      data: '，', inputType: 'insertText', isComposing: false, composed: true, bubbles: true, cancelable: true,
    });
    helper.dispatchEvent(event);
    vi.runAllTimers();

    // Mobile never subscribes onData, so `sent` cannot observe the fallback; assert instead that the
    // mobile helper was left completely untouched (no forward, no restore).
    expect(event.defaultPrevented).toBe(false);
    expect(helper.value).toBe('，');
    expect(sent).toEqual([]);
    dispose();
  });

  it('stops listening after dispose', () => {
    const sent = [];
    const { helper, dispose } = mount({ onInputData: (pane, data) => sent.push(data) });
    dispose();

    imeKeyDown(helper);
    commitInput(helper, '，');
    // Drop xterm's own 229 fallback timer so this only measures this module's listeners.
    vi.clearAllTimers();

    expect(sent).toEqual([]);
    expect(helper.value).toBe('，'); // no restore either: the fallback is really detached
  });
});
