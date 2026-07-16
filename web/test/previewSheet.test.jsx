// web/test/previewSheet.test.jsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../src/api.js', () => ({
  previewUrl: (entry, domain, path = '/') => {
    if (entry?.kind === 'dynamic') {
      const sep = path.includes('?') ? '&' : '?';
      return `https://${entry.name}.${domain}${path}${sep}token=t`;
    }
    return `/preview/${entry?.name}/?token=t`;
  },
}));

import PreviewSheet from '../src/components/PreviewSheet.jsx';

let container, root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });
const render = (props) => act(() => root.render(<PreviewSheet onMinimize={() => {}} onRenew={() => {}} onStop={() => {}} {...props} />));
const click = (n) => act(() => n.dispatchEvent(new MouseEvent('click', { bubbles: true })));
// PreviewSheet portals to document.body, so query there.
const inSheet = (sel) => document.querySelector(`.file-sheet ${sel}`);

describe('PreviewSheet', () => {
  it('is hidden (no .open) and renders no iframe before a preview exists', async () => {
    await render({ open: false, name: undefined });
    expect(document.querySelector('.file-sheet')).toBeTruthy();
    expect(document.querySelector('.file-sheet.open')).toBeNull();
    expect(document.querySelector('.preview-frame')).toBeNull();
  });

  it('shows status, a minutes countdown, the iframe, and a popover for renew/stop + minimize', async () => {
    const onRenew = vi.fn(); const onStop = vi.fn(); const onMin = vi.fn();
    await render({ open: true, name: 'main-3', kind: 'static', domain: null, expiresAt: Date.now() + 125_000, onRenew, onStop, onMinimize: onMin });
    expect(document.querySelector('.file-sheet.open')).toBeTruthy();
    expect(document.querySelector('.preview-state').textContent).toBe('静态预览');
    expect(document.querySelector('.preview-name').textContent).toBe('main-3');
    const remain = document.querySelector('.preview-remain');
    expect(remain.textContent).toMatch(/^\d+ 分钟$/); // minutes only, concise, no seconds
    expect(remain.textContent).not.toMatch(/:/);
    expect(inSheet('iframe.preview-frame').getAttribute('src')).toBe('/preview/main-3/?token=t');

    const byLabel = (l) => document.querySelector(`.file-sheet button[aria-label="${l}"]`);
    expect(byLabel('刷新')).toBeTruthy();        // refresh is icon-only
    click(byLabel('刷新'));                       // reloads the iframe — must not throw
    // 续期/停止 live in the time chip's popover now (not header icons).
    expect(byLabel('续期')).toBeNull();
    expect(byLabel('停止')).toBeNull();
    click(remain); // open the popover
    const popItem = (t) => [...document.querySelectorAll('.preview-pop-item')].find((b) => b.textContent.includes(t));
    click(popItem('续期'));
    expect(onRenew).toHaveBeenCalled();
    click(remain); // reopen
    click(popItem('停止预览'));
    expect(onStop).toHaveBeenCalled();
    click(byLabel('收起'));
    expect(onMin).toHaveBeenCalled();
  });

  it('toggles between 手机/电脑 view', async () => {
    await render({ open: true, name: 'foo', kind: 'static', domain: null, expiresAt: Date.now() + 300_000 });
    const byLabel = (l) => document.querySelector(`.file-sheet button[aria-label="${l}"]`);
    const toPc = byLabel('切换到电脑视图'); // defaults to mobile → button offers PC
    expect(toPc).toBeTruthy();
    click(toPc);
    expect(byLabel('切换到手机视图')).toBeTruthy(); // now PC → button offers switching back
  });

  it('static preview shows 静态预览 + the source dir, iframe at the /preview path', async () => {
    localStorage.setItem('tw_token', 'tok');
    await render({ open: true, name: 'foo', kind: 'static', dir: '/home/u/site', domain: null, expiresAt: Date.now() + 3_600_000 });
    expect(document.querySelector('.preview-state').textContent).toBe('静态预览');
    expect(document.querySelector('.preview-detail').textContent).toBe('/home/u/site');
    expect(document.querySelector('iframe.preview-frame').getAttribute('src')).toBe('/preview/foo/?token=t');
  });

  it('dynamic preview shows 动态预览 + :port, iframe at the wildcard subdomain', async () => {
    localStorage.setItem('tw_token', 'tok');
    await render({ open: true, name: 'app', kind: 'dynamic', port: 4705, domain: 'preview.example.com', expiresAt: Date.now() + 3_600_000 });
    expect(document.querySelector('.preview-state').textContent).toBe('动态预览');
    expect(document.querySelector('.preview-detail').textContent).toBe(':4705');
    expect(document.querySelector('iframe.preview-frame').getAttribute('src')).toBe('https://app.preview.example.com/?token=t');
  });

  it('renders a tab strip with an iframe per tab (parallel), only the active one visible', async () => {
    const exp = Date.now() + 3_600_000;
    const tabs = [
      { name: 'w', kind: 'dynamic', port: 3000, expiresAt: exp, path: '/' },
      { name: 'w-5173', kind: 'dynamic', port: 5173, expiresAt: exp, path: '/admin' },
    ];
    await render({ open: true, tabs, activeName: 'w-5173', domain: 'preview.example.com' });
    // one chip per tab, active one marked
    const chips = [...document.querySelectorAll('.preview-tab-btn')];
    expect(chips.map((c) => c.textContent)).toEqual([':3000', ':5173']);
    expect(document.querySelector('.preview-tab.active .preview-tab-btn').textContent).toBe(':5173');
    // all tabs' iframes are mounted; the active tab's deep-link path is carried into its src
    const frames = [...document.querySelectorAll('iframe.preview-frame')];
    expect(frames).toHaveLength(2);
    expect(frames.some((f) => f.getAttribute('src') === 'https://w-5173.preview.example.com/admin?token=t')).toBe(true);
    // only the active pane is visible
    const panes = [...document.querySelectorAll('.preview-pane')];
    const active = panes.find((p) => p.querySelector('iframe').getAttribute('src').includes('w-5173'));
    const inactive = panes.find((p) => p !== active);
    expect(inactive.style.display).toBe('none');
    expect(active.style.display).not.toBe('none');
  });

  it('tab strip switches and closes via callbacks; a single preview shows no strip', async () => {
    const onSwitchTab = vi.fn(); const onCloseTab = vi.fn();
    const exp = Date.now() + 3_600_000;
    const tabs = [
      { name: 'w', kind: 'dynamic', port: 3000, expiresAt: exp, path: '/' },
      { name: 'w-5173', kind: 'dynamic', port: 5173, expiresAt: exp, path: '/' },
    ];
    await render({ open: true, tabs, activeName: 'w', domain: 'preview.example.com', onSwitchTab, onCloseTab });
    const chips = [...document.querySelectorAll('.preview-tab-btn')];
    click(chips[1]);
    expect(onSwitchTab).toHaveBeenCalledWith('w-5173');
    click(document.querySelectorAll('.preview-tab-close')[0]);
    expect(onCloseTab).toHaveBeenCalledWith('w');

    // single preview → no strip
    await render({ open: true, tabs: [tabs[0]], activeName: 'w', domain: 'preview.example.com' });
    expect(document.querySelector('.preview-tabs')).toBeNull();
  });
});
