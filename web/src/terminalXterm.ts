import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { docLinksOnLine } from './docDecorations.js';
import { findLocalUrls } from './localUrl.js';
import { ensureBundledFonts } from './bundledFonts.js';
import { isBrowserFunctionKey } from './terminalPageKeyboard.js';

export const TERMINAL_FONT_FAMILY = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', 'Roboto Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Courier New', 'JetBrainsMono Nerd Font', 'TW Unifont', monospace";
export const TERMINAL_THEME: ITheme = {
  // Declare every base colour explicitly.  Browsers with forced dark mode can otherwise
  // reinterpret xterm's default canvas/palette and turn normal ANSI output into black-on-black.
  foreground: '#e6e6e6',
  background: '#1a1b1e',
  cursor: '#e6e6e6',
  cursorAccent: '#1a1b1e',
  black: '#4b5058',
  red: '#ff7b72',
  green: '#56d364',
  yellow: '#e3b341',
  blue: '#6cb6ff',
  magenta: '#d2a8ff',
  cyan: '#76e3ea',
  white: '#e6edf3',
  brightBlack: '#8b949e',
  brightRed: '#ffa198',
  brightGreen: '#7ee787',
  brightYellow: '#f2cc60',
  brightBlue: '#a5d6ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#b3f0ff',
  brightWhite: '#ffffff',
  selectionBackground: 'rgba(10,132,255,0.9)',
  selectionForeground: '#ffffff',
};

export interface TerminalOutputLink {
  kind: 'url' | 'doc';
  path: string;
  raw?: string;
  protocol?: string;
  port?: string | number;
  urlPath?: string;
  /** Doc links: the `#heading` in `file.md#heading`, jumped to after the file opens. */
  anchor?: string;
  range?: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  };
}

export type TerminalDocLinkHandler = (
  link: TerminalOutputLink,
  clientX: number,
  clientY: number,
) => void;

export interface OpenXtermOptions {
  host: HTMLElement;
  desktop: boolean;
  autoFocusInput: boolean;
  fontSize: number;
  scrollback: number;
  pane: string;
  onInputData?: (pane: string, data: string | Uint8Array) => void;
  onInputKeys?: (pane: string, keys: readonly string[]) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onRequestDraft?: () => void;
  onDesktopSelection?: (active: boolean) => void;
  getDocLinkHandler?: () => TerminalDocLinkHandler | null | undefined;
}

export interface OpenXtermResult {
  term: XTerm;
  forwardPageKey(event: KeyboardEvent): boolean;
  dispose(): void;
}

function primeCursorRenderer(term: XTerm, host: HTMLElement): void {
  const helper = host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
  if (helper) {
    helper.readOnly = true;
    helper.tabIndex = -1;
    helper.setAttribute('inputmode', 'none');
    helper.setAttribute('aria-hidden', 'true');
  }
  const previousFocus = document.activeElement;
  term.focus();
  term.blur();
  if (previousFocus instanceof HTMLElement && previousFocus !== document.body) {
    previousFocus.focus();
  }
}

function prepareInput(
  term: XTerm,
  host: HTMLElement,
  desktop: boolean,
  autoFocusInput: boolean,
): void {
  const helper = host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
  if (!desktop) {
    primeCursorRenderer(term, host);
    return;
  }
  if (helper) {
    helper.readOnly = false;
    helper.tabIndex = 0;
    helper.removeAttribute('inputmode');
    helper.removeAttribute('aria-hidden');
  }
  if (autoFocusInput) term.focus();
}

/**
 * Bookkeeping for {@link isDroppedImeCommit}, tracked per key sequence.
 *
 * Firefox with an active IME (e.g. fcitx5 on Linux) commits a bare full-width punctuation character
 * without ever opening a composition session: a `keydown` with `keyCode === 229`, then a single
 * `input` event carrying the character. xterm.js (5.5 and 6.0) drops that `input` event — its
 * `_inputEvent` guard is `(!ev.composed || !this._keyDownSeen)`, and the 229 keydown has already set
 * `_keyDownSeen` while Firefox reports `composed === true`. xterm instead leans on
 * `CompositionHelper._handleAnyTextareaChanges()`, a `setTimeout(0)` diff of the helper textarea,
 * which on Firefox usually never sees the inserted character, so the keystroke is lost silently.
 * Pressing the key repeatedly occasionally lands on the timeout, which is why the loss is flaky.
 */
export interface DroppedImeCommitState {
  /** A composition is in flight, or `compositionend` fired and its commit input is still on the way. */
  composing: boolean;
  /** The last `keydown` was the IME "Process" key (229) and no composition has started since. */
  imeKeyDown: boolean;
  /** The helper textarea value observed on that keydown, i.e. before the commit was inserted. */
  valueBeforeCommit: string;
  /** A keypress with a real char code followed it, so xterm's own keypress path already sent the character. */
  keyPressDelivered: boolean;
}

/**
 * Whether an `input` event is an IME commit that xterm.js dropped and this module must forward.
 *
 * `defaultPrevented` is the "xterm already consumed it" signal: xterm's capture-phase input listener
 * runs first (it is registered in `term.open()`, before this listener) and calls `cancel(ev)` whenever
 * its guard accepts the event. So a prevented event must never be forwarded again, which also keeps
 * Chromium — where the same commit arrives with `composed === false` and is handled upstream — intact.
 *
 * `composing` keeps us out of a real composition session. It stays set across `compositionend`, because
 * xterm delivers a committed composition from `_finalizeComposition`'s saved-position slice of the
 * textarea, and the commit `input` event that belongs to that slice can still be queued behind it.
 */
export function isDroppedImeCommit(
  event: Pick<InputEvent, 'inputType' | 'data' | 'isComposing' | 'defaultPrevented'>,
  state: DroppedImeCommitState,
): boolean {
  return state.imeKeyDown
    && !state.composing
    && !state.keyPressDelivered
    && event.inputType === 'insertText'
    && !!event.data
    && !event.isComposing
    && !event.defaultPrevented;
}

/**
 * Mirrors xterm's `Terminal._keyPress` character derivation: xterm only emits when it can produce a
 * character code, and its `which` branch is itself gated on a non-zero `charCode`. Being more eager than
 * xterm here would suppress the fallback for a commit that xterm never actually sent.
 */
function keyPressSendsText(event: KeyboardEvent): boolean {
  if (event.charCode) return true;
  const which = (event as KeyboardEvent & { which?: number | null }).which;
  return (which === null || which === undefined) && !!event.keyCode;
}

/**
 * Forward IME single-character commits that xterm.js drops on Firefox (see {@link DroppedImeCommitState}).
 *
 * Exactly-once delivery is the whole point here, and it is subtle: xterm's own 229 fallback diffs the
 * helper textarea on a 0ms timeout and would forward the same character a second time. We neutralise it
 * by restoring the textarea to the value the keydown saw, so that diff comes out empty. Ordering is
 * safe either way — the timeout can run before the `input` event (textarea not yet updated: the diff is
 * empty anyway) or after it (value already restored), but never between the insertion and the event,
 * because both happen in the same task.
 *
 * Returns a disposer for the listeners; nothing is installed unless the desktop helper textarea exists.
 */
function installDroppedImeCommitFallback(
  term: XTerm,
  helper: HTMLTextAreaElement,
): () => void {
  const state: DroppedImeCommitState = {
    composing: false,
    imeKeyDown: false,
    valueBeforeCommit: '',
    keyPressDelivered: false,
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    state.composing = false; // a fresh key sequence, even one that continues an active composition
    state.imeKeyDown = event.keyCode === 229 || event.key === 'Process';
    state.valueBeforeCommit = helper.value;
    state.keyPressDelivered = false;
  };
  const onKeyPress = (event: KeyboardEvent): void => {
    if (state.imeKeyDown && keyPressSendsText(event)) state.keyPressDelivered = true;
  };
  const onCompositionStart = (): void => {
    state.composing = true;
    state.imeKeyDown = false;
    state.keyPressDelivered = false;
  };
  const onCompositionEnd = (): void => {
    // `compositionend` carries no delivery here: xterm's `_finalizeComposition` sends the composed text
    // from a saved textarea position on its own 0ms timeout. Stay out of the way until the commit
    // `input` event (or the next keydown) proves that slice is done.
    state.composing = true;
    state.imeKeyDown = false;
  };
  const onInput = (event: Event): void => {
    const input = event as InputEvent;
    if (input.inputType !== 'insertText') return;
    // Decide before clearing: the non-composing input after compositionend is the commit xterm's
    // finalize slice owns, and must not be forwarded.
    const dropped = isDroppedImeCommit(input, state);
    if (state.composing && !input.isComposing) state.composing = false;
    if (input.defaultPrevented) state.imeKeyDown = false;
    if (!dropped) return;
    const data = input.data as string;
    state.imeKeyDown = false;
    term.input(data, true);
    const { valueBeforeCommit } = state;
    if (helper.value !== valueBeforeCommit) helper.value = valueBeforeCommit;
  };
  helper.addEventListener('keydown', onKeyDown, true);
  helper.addEventListener('keypress', onKeyPress, true);
  helper.addEventListener('compositionstart', onCompositionStart, true);
  helper.addEventListener('compositionend', onCompositionEnd, true);
  helper.addEventListener('input', onInput, true);
  return () => {
    helper.removeEventListener('keydown', onKeyDown, true);
    helper.removeEventListener('keypress', onKeyPress, true);
    helper.removeEventListener('compositionstart', onCompositionStart, true);
    helper.removeEventListener('compositionend', onCompositionEnd, true);
    helper.removeEventListener('input', onInput, true);
  };
}

function usesAppleCommandKey(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function cloneKeyboardEvent(event: KeyboardEvent, type = 'keydown'): KeyboardEvent {
  type KeyboardEventView = Window & { KeyboardEvent?: typeof KeyboardEvent };
  const targetWindow = event.target instanceof Node
    ? event.target.ownerDocument?.defaultView as KeyboardEventView | null
    : null;
  const eventWindow = event.view as KeyboardEventView | null;
  const KeyboardEventCtor = eventWindow?.KeyboardEvent
    || targetWindow?.KeyboardEvent
    || window.KeyboardEvent;
  const forwarded = new KeyboardEventCtor(type, {
    key: event.key,
    code: event.code,
    location: event.location,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    repeat: event.repeat,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  // xterm's terminal-key mapping intentionally still uses these legacy fields.
  for (const name of ['keyCode', 'which', 'charCode'] as const) {
    if (event[name] == null) continue;
    try { Object.defineProperty(forwarded, name, { value: event[name] }); } catch { /* read-only */ }
  }
  return forwarded;
}

function forwardPageKey(
  term: XTerm,
  helper: HTMLTextAreaElement | null,
  event: KeyboardEvent,
  pane: string,
  onInputKeys?: OpenXtermOptions['onInputKeys'],
): boolean {
  if (!helper || isBrowserFunctionKey(event)) return false;
  term.focus();
  if (sendLineBoundaryKey(term, event, pane, onInputKeys)) return true;
  const forwarded = cloneKeyboardEvent(event);
  const handled = !helper.dispatchEvent(forwarded);
  if (handled) return true;

  // xterm defers some printable keys (notably uppercase letters) to keypress for IME
  // compatibility. A synthetic keydown has no browser-generated keypress, so feed only
  // that plain printable remainder through xterm's public user-input path.
  if (!event.ctrlKey && !event.metaKey && event.key && Array.from(event.key).length === 1) {
    term.input(event.key, true);
    return true;
  }
  return false;
}

function sendLineBoundaryKey(
  term: XTerm,
  event: KeyboardEvent,
  pane: string,
  onInputKeys?: OpenXtermOptions['onInputKeys'],
): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false;
  if (event.key !== 'Home' && event.key !== 'End') return false;
  event.preventDefault();
  // Let tmux encode the key for the pane's configured TERM; raw xterm [H/[F sequences can be
  // unbound when the pane advertises tmux-256color (whose khome/kend are [1~/[4~).
  if (onInputKeys) onInputKeys(pane, [event.key]);
  else term.input(event.key === 'Home' ? '\x1b[1~' : '\x1b[4~', true);
  return true;
}

export function openXterm({
  host,
  desktop,
  autoFocusInput,
  fontSize,
  scrollback,
  pane,
  onInputData,
  onInputKeys,
  onInputFocusChange,
  onRequestDraft,
  onDesktopSelection,
  getDocLinkHandler,
}: OpenXtermOptions): OpenXtermResult {
  const term = new XTerm({
    disableStdin: !desktop,
    allowProposedApi: true,
    scrollback,
    convertEol: false,
    fontSize,
    fontFamily: TERMINAL_FONT_FAMILY,
    theme: TERMINAL_THEME,
    cursorInactiveStyle: 'block',
    linkHandler: {
      activate: (event, text) => {
        const local = findLocalUrls(text)[0];
        const handler = getDocLinkHandler?.();
        if (local && handler) {
          handler({
            kind: 'url',
            protocol: local.protocol,
            port: local.port,
            urlPath: local.path,
            raw: local.raw,
            path: local.raw,
          }, event?.clientX ?? 0, event?.clientY ?? 0);
          return;
        }
        try { window.open(text, '_blank', 'noopener,noreferrer'); } catch { /* ignore */ }
      },
    },
  });
  term.open(host);

  term.attachCustomKeyEventHandler((event) => {
    if (isBrowserFunctionKey(event)) return false;
    if (desktop && sendLineBoundaryKey(term, event, pane, onInputKeys)) return false;
    const pasteKey = desktop && event.key?.toLowerCase() === 'v' && !event.altKey;
    const nativePaste = pasteKey && (usesAppleCommandKey()
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey);
    if (nativePaste) return false;

    const copyKey = desktop && event.key?.toLowerCase() === 'c' && term.hasSelection?.();
    const nativeCopy = copyKey && event.metaKey && !event.ctrlKey && !event.altKey;
    const terminalCopy = copyKey && event.ctrlKey && event.shiftKey
      && !event.metaKey && !event.altKey;
    if (nativeCopy || terminalCopy) {
      if (terminalCopy) {
        event.preventDefault?.();
        const text = term.getSelection();
        const fallback = () => {
          try { document.execCommand('copy'); } catch { /* clipboard unavailable */ }
        };
        try {
          const pendingCopy = navigator.clipboard?.writeText?.(text);
          if (pendingCopy) Promise.resolve(pendingCopy).catch(fallback);
          else fallback();
        } catch { fallback(); }
      }
      return false;
    }
    if (desktop && event.key === 'Enter' && event.shiftKey
      && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
      event.preventDefault?.();
      onRequestDraft?.();
      return false;
    }
    if (event.metaKey && ['w', 't', 'l', 'r'].includes(event.key.toLowerCase())) return false;
    return true;
  });

  const dataSub = desktop ? term.onData((data) => onInputData?.(pane, data)) : null;
  // Legacy terminal mouse protocols can contain bytes that are not valid UTF-8. xterm exposes
  // those through onBinary rather than onData; preserve each code unit as one byte before the
  // existing hex input queue forwards it to tmux.
  const binarySub = desktop ? term.onBinary?.((data) => {
    const bytes = Uint8Array.from(data, (char) => char.charCodeAt(0) & 0xff);
    onInputData?.(pane, bytes);
  }) : null;
  const selectionSub = desktop ? term.onSelectionChange(() => onDesktopSelection?.(term.hasSelection())) : null;
  const helper = desktop ? host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea') : null;
  const focus = (): void => onInputFocusChange?.(true);
  const blur = (): void => onInputFocusChange?.(false);
  helper?.addEventListener('focus', focus);
  helper?.addEventListener('blur', blur);
  prepareInput(term, host, desktop, autoFocusInput);
  const disposeImeFallback = desktop && helper
    ? installDroppedImeCommitFallback(term, helper)
    : null;

  const linkProvider = term.registerLinkProvider({
    provideLinks(lineNo, callback) {
      const handler = getDocLinkHandler?.();
      if (!handler) {
        callback(undefined);
        return;
      }
      const links = docLinksOnLine(term, lineNo).map((link) => ({
        range: link.range,
        text: link.raw ?? link.path,
        decorations: { pointerCursor: true, underline: false },
        activate: (event: MouseEvent) => handler({
          ...link,
          kind: link.kind === 'url' ? 'url' : 'doc',
        }, event?.clientX ?? 0, event?.clientY ?? 0),
      }));
      callback(links.length ? links : undefined);
    },
  });

  let disposed = false;
  let webgl: WebglAddon | null = null;
  const mountWebgl = (): void => {
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => addon.dispose());
      term.loadAddon(addon);
      webgl = addon;
    } catch { webgl = null; }
  };
  mountWebgl();
  ensureBundledFonts(fontSize).then(() => {
    if (disposed || !webgl) return;
    try { webgl.dispose(); } catch { /* already disposed */ }
    mountWebgl();
    term.refresh(0, term.rows - 1);
  });

  return {
    term,
    forwardPageKey: (event) => forwardPageKey(term, helper, event, pane, onInputKeys),
    dispose() {
      disposed = true;
      dataSub?.dispose();
      binarySub?.dispose();
      selectionSub?.dispose();
      disposeImeFallback?.();
      helper?.removeEventListener('focus', focus);
      helper?.removeEventListener('blur', blur);
      linkProvider.dispose();
      try { webgl?.dispose(); } catch { /* already disposed */ }
      term.dispose();
    },
  };
}
