import { describe, expect, it } from 'vitest';
import {
  getKeyboardMode,
  isDesktopInputEnvironment,
  keyboardModeUsesDesktop,
  setKeyboardMode,
  type DesktopInputEnvironmentOptions,
} from '../src/desktopInput.js';
import {
  isBrowserFunctionKey,
  isDraftShortcut,
  shouldRouteTerminalPageKey,
} from '../src/terminalPageKeyboard.js';

const base: DesktopInputEnvironmentOptions = {
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  platform: 'MacIntel',
  maxTouchPoints: 0,
  mobileHint: false,
  finePointer: true,
  hover: true,
};

describe('isDesktopInputEnvironment', () => {
  it('accepts desktop Mac/Windows/Linux even when the viewport is narrow', () => {
    expect(isDesktopInputEnvironment(base)).toBe(true);
    expect(isDesktopInputEnvironment({ ...base, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' })).toBe(true);
    expect(isDesktopInputEnvironment({ ...base, ua: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64' })).toBe(true);
  });

  it('keeps iPhone, Android, and iPadOS-on-Mac-UA on the mobile path', () => {
    expect(isDesktopInputEnvironment({ ...base, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', platform: 'iPhone' })).toBe(false);
    expect(isDesktopInputEnvironment({ ...base, ua: 'Mozilla/5.0 (Linux; Android 15)', platform: 'Linux armv8l' })).toBe(false);
    expect(isDesktopInputEnvironment({ ...base, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(false);
  });

  it('fails closed without a fine pointer and hover', () => {
    expect(isDesktopInputEnvironment({ ...base, finePointer: false })).toBe(false);
    expect(isDesktopInputEnvironment({ ...base, hover: false })).toBe(false);
  });
});

describe('keyboard mode preference', () => {
  const storage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
  };

  it('defaults invalid or missing preferences to auto and persists valid choices', () => {
    const store = storage();
    expect(getKeyboardMode(store)).toBe('auto');
    store.setItem('tw_keyboard_mode', 'other');
    expect(getKeyboardMode(store)).toBe('auto');
    setKeyboardMode('mobile', store);
    expect(getKeyboardMode(store)).toBe('mobile');
  });

  it('lets mobile and desktop override detection while auto keeps detection', () => {
    expect(keyboardModeUsesDesktop('mobile', true)).toBe(false);
    expect(keyboardModeUsesDesktop('desktop', false)).toBe(true);
    expect(keyboardModeUsesDesktop('auto', true)).toBe(true);
    expect(keyboardModeUsesDesktop('auto', false)).toBe(false);
  });
});

describe('desktop terminal page keyboard routing', () => {
  it('routes toolbar and blank-page keys but leaves real editors and xterm input alone', () => {
    const toolbar = document.createElement('button');
    const editor = document.createElement('textarea');
    const helper = document.createElement('textarea');
    helper.className = 'xterm-helper-textarea';

    expect(shouldRouteTerminalPageKey({ target: toolbar })).toBe(true);
    expect(shouldRouteTerminalPageKey({ target: document.body })).toBe(true);
    expect(shouldRouteTerminalPageKey({ target: editor })).toBe(false);
    expect(shouldRouteTerminalPageKey({ target: helper })).toBe(false);
  });

  it('recognizes the draft shortcut and reserves browser function keys', () => {
    expect(isDraftShortcut({ key: 'Enter', shiftKey: true })).toBe(true);
    expect(isDraftShortcut({ key: 'Enter', shiftKey: true, ctrlKey: true })).toBe(false);
    expect(isBrowserFunctionKey({ key: 'F5' })).toBe(true);
    expect(isBrowserFunctionKey({ key: 'F12' })).toBe(true);
    expect(shouldRouteTerminalPageKey({ key: 'F5', target: document.body })).toBe(false);
    expect(shouldRouteTerminalPageKey({ key: 'F12', target: document.body })).toBe(false);
  });
});
