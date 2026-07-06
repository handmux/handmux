import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import AddToHome from '../src/components/AddToHome.jsx';

let container;
let root;

const UA = {
  desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
};

function setNav({ ua = '', standalone = false, maxTouchPoints = 0 }) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
  Object.defineProperty(window.navigator, 'standalone', { value: standalone, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  setNav({ ua: UA.desktop });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () => act(() => root.render(<AddToHome />));
const fireInstallPrompt = () => {
  const e = new Event('beforeinstallprompt');
  e.prompt = vi.fn();
  e.userChoice = Promise.resolve({ outcome: 'accepted' });
  act(() => window.dispatchEvent(e));
  return e;
};
const banner = () => container.querySelector('.a2hs-banner');
const click = (node) => act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('AddToHome', () => {
  it('renders nothing on desktop', () => {
    render();
    expect(banner()).toBeNull();
  });

  it('renders nothing when already installed (standalone)', () => {
    setNav({ ua: UA.iosSafari, standalone: true });
    render();
    expect(banner()).toBeNull();
  });

  it('renders nothing once dismissed', () => {
    localStorage.setItem('tw_a2hs_dismissed', '1');
    setNav({ ua: UA.iosSafari });
    render();
    expect(banner()).toBeNull();
  });

  it('is a non-modal status strip, not a dialog', () => {
    setNav({ ua: UA.iosSafari });
    render();
    expect(banner().getAttribute('role')).toBe('status');
    expect(container.querySelector('[aria-modal="true"]')).toBeNull();
    expect(container.querySelector('.settings-backdrop')).toBeNull();
  });

  it('iOS Safari shows the compact share hint, no install button', () => {
    setNav({ ua: UA.iosSafari });
    render();
    expect(banner()).not.toBeNull();
    expect(banner().dataset.mode).toBe('ios');
    expect(container.querySelector('.a2hs-banner-cta')).toBeNull();
  });

  it('iOS non-Safari points the user at Safari', () => {
    setNav({ ua: UA.iosChrome });
    render();
    expect(banner().dataset.mode).toBe('ios-other');
    expect(container.querySelector('.a2hs-banner-cta')).toBeNull();
  });

  it('Android with a captured prompt offers one-tap install and calls prompt()', async () => {
    setNav({ ua: UA.android });
    render();
    const e = fireInstallPrompt();
    expect(banner().dataset.mode).toBe('install');
    const btn = container.querySelector('.a2hs-banner-cta');
    expect(btn).not.toBeNull();
    click(btn);
    expect(e.prompt).toHaveBeenCalledTimes(1);
  });

  it('Android without a prompt falls back to the manual hint', () => {
    setNav({ ua: UA.android });
    render();
    expect(banner().dataset.mode).toBe('android');
    expect(container.querySelector('.a2hs-banner-cta')).toBeNull();
  });

  it('dismissing via ✕ remembers it and removes the strip', () => {
    setNav({ ua: UA.iosSafari });
    render();
    click(container.querySelector('.a2hs-banner-x'));
    expect(banner()).toBeNull();
    expect(localStorage.getItem('tw_a2hs_dismissed')).toBe('1');
  });
});
