const KEYBOARD_MODE_KEY = 'tw_keyboard_mode';

export type KeyboardMode = 'auto' | 'mobile' | 'desktop';

const KEYBOARD_MODES = new Set<KeyboardMode>(['auto', 'mobile', 'desktop']);

export interface DesktopInputEnvironmentOptions {
  ua?: string;
  platform?: string;
  maxTouchPoints?: number;
  mobileHint?: boolean | null;
  finePointer?: boolean;
  hover?: boolean;
}

interface DesktopInputWindow {
  navigator: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> & {
    userAgentData?: { mobile?: boolean };
  };
  matchMedia?: (query: string) => { matches: boolean };
}

interface KeyboardModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isKeyboardMode(value: unknown): value is KeyboardMode {
  return typeof value === 'string' && KEYBOARD_MODES.has(value as KeyboardMode);
}

export function isDesktopInputEnvironment({
  ua = '', platform = '', maxTouchPoints = 0, mobileHint = null,
  finePointer = false, hover = false,
}: DesktopInputEnvironmentOptions = {}): boolean {
  const mobileOS = /Android|iPhone|iPad|iPod/i.test(ua)
    || (platform === 'MacIntel' && maxTouchPoints > 1)
    || mobileHint === true;
  const desktopOS = /Mac|Win|Linux/i.test(platform) || /Macintosh|Windows NT|X11; Linux/i.test(ua);
  return !mobileOS && desktopOS && finePointer && hover;
}

export function desktopInputEnvironment(win: DesktopInputWindow = window): boolean {
  const nav = win.navigator;
  return isDesktopInputEnvironment({
    ua: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    mobileHint: nav.userAgentData?.mobile ?? null,
    finePointer: win.matchMedia?.('(pointer: fine)').matches === true,
    hover: win.matchMedia?.('(hover: hover)').matches === true,
  });
}

export function getKeyboardMode(storage: KeyboardModeStorage = window.localStorage): KeyboardMode {
  try {
    const mode = storage.getItem(KEYBOARD_MODE_KEY);
    return isKeyboardMode(mode) ? mode : 'auto';
  } catch {
    return 'auto';
  }
}

export function setKeyboardMode(
  mode: unknown,
  storage: KeyboardModeStorage = window.localStorage,
): void {
  if (!isKeyboardMode(mode)) return;
  try { storage.setItem(KEYBOARD_MODE_KEY, mode); } catch { /* storage unavailable */ }
}

export function keyboardModeUsesDesktop(mode: unknown, detectedDesktop: boolean): boolean {
  if (mode === 'desktop') return true;
  if (mode === 'mobile') return false;
  return !!detectedDesktop;
}
