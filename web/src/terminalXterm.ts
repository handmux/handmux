import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { docLinksOnLine } from './docDecorations.js';
import { findLocalUrls } from './localUrl.js';
import { ensureBundledFonts } from './bundledFonts.js';
import { isBrowserFunctionKey } from './terminalPageKeyboard.js';

export const TERMINAL_FONT_FAMILY = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', 'Roboto Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Courier New', 'JetBrainsMono Nerd Font', 'TW Unifont', monospace";
export const TERMINAL_THEME: ITheme = {
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
): boolean {
  if (!helper || isBrowserFunctionKey(event)) return false;
  term.focus();
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

export function openXterm({
  host,
  desktop,
  autoFocusInput,
  fontSize,
  scrollback,
  pane,
  onInputData,
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
    forwardPageKey: (event) => forwardPageKey(term, helper, event),
    dispose() {
      disposed = true;
      dataSub?.dispose();
      binarySub?.dispose();
      selectionSub?.dispose();
      helper?.removeEventListener('focus', focus);
      helper?.removeEventListener('blur', blur);
      linkProvider.dispose();
      try { webgl?.dispose(); } catch { /* already disposed */ }
      term.dispose();
    },
  };
}
