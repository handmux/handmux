import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import BrowserSheet from '../src/components/BrowserSheet.jsx';
import * as browserApi from '../src/api.js';

const styles = readFileSync(path.resolve(process.cwd(), 'src/styles.css'), 'utf8');

let container;
let root;

const tabs = [
  { id: 'a', mode: 'proxy', siteVersion: 'mobile', url: '/_browser-a/https://a.example/', originalUrl: 'https://a.example/', title: 'Alpha', channel: 'ca' },
  { id: 'b', mode: 'proxy', siteVersion: 'mobile', url: '/_browser-b/https://b.example/', originalUrl: 'https://b.example/', title: 'Beta', channel: 'cb' },
];

const browser = (overrides = {}) => ({
  open: true,
  accessEnabled: true,
  tabs,
  activeId: 'a',
  historyActive: false,
  closeAfter: 10,
  history: [{ url: 'https://old.example/', title: 'Old', visitedAt: 1000, lastMode: 'direct' }],
  proxyAvailable: true,
  error: null,
  consentOpen: false,
  enableAccess: vi.fn(),
  cancelAccess: vi.fn(),
  openUrl: vi.fn(),
  switchTab: vi.fn(),
  closeTab: vi.fn(),
  setOpen: vi.fn(),
  setCloseAfter: vi.fn(),
  setEnabled: vi.fn(),
  setPersistProxyLogin: vi.fn(),
  setProxyLoginRetentionDays: vi.fn(),
  setProxyLoginPolicy: vi.fn(),
  setHistoryMode: vi.fn(),
  recordStaticHistory: vi.fn(),
  clearProxyLogin: vi.fn(),
  deleteHistory: vi.fn(),
  navigateTab: vi.fn(),
  ensureBinding: vi.fn(),
  recoverBinding: vi.fn(),
  markBindingReady: vi.fn(),
  prepareFormNavigation: vi.fn(),
  updateTabMeta: vi.fn(),
  clearHistory: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const staticPreview = (overrides = {}) => ({
  selected: false,
  shownPreview: null,
  tabs: [],
  error: null,
  pane: null,
  lastPreviewDir: null,
  deactivate: vi.fn(),
  switchTab: vi.fn(),
  closeTab: vi.fn(),
  startPreview: vi.fn(),
  retryPreview: vi.fn(),
  ...overrides,
});

const render = (model, preview) => act(() => root.render(
  <BrowserSheet browser={model} staticPreview={preview} />,
));
const click = (node) => act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const mockBrowserSize = (initialWidth) => {
  let width = initialWidth;
  let resize = () => {};
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
    return this.classList.contains('browser-content') ? width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  return (next) => act(() => { width = next; resize(); });
};
const selectMode = (index) => {
  const trigger = document.querySelector('.browser-mode-switch');
  if (trigger.getAttribute('aria-expanded') !== 'true') click(trigger);
  const menu = document.querySelector('.browser-mode-menu');
  expect(menu.hidden).toBe(false);
  const choice = menu.querySelectorAll('button')[index];
  expect(choice.disabled).toBe(false);
  click(choice);
  expect(menu.hidden).toBe(true);
};
const clickAndFlush = (node) => act(async () => {
  node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await Promise.resolve();
});
const submit = (form) => act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
const setInput = (input, value) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

describe('BrowserSheet', () => {
  it('shows the full address in a native scroll area and only focuses its editor on a tap', async () => {
    const longUrl = `https://a.example/${'long-segment/'.repeat(20)}?last=value`;
    await render(browser({ tabs: [{ ...tabs[0], originalUrl: longUrl }] }));
    const display = document.querySelector('.browser-address-display');
    const input = document.querySelector('.browser-address');
    expect(display.textContent).toBe(longUrl);
    expect(input.hidden).toBe(true);
    expect(display.getAttribute('role')).toBe('button');
    const pointer = (type, x) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { clientX: { value: x }, clientY: { value: 10 } });
      act(() => display.dispatchEvent(event));
    };
    pointer('pointerdown', 100);
    pointer('pointermove', 50);
    pointer('pointerup', 50);
    click(display);
    expect(input.hidden).toBe(true);
    expect(document.activeElement).not.toBe(input);
    pointer('pointerdown', 50);
    pointer('pointerup', 50);
    click(display);
    expect(input.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    setInput(input, 'https://edited.example/path');
    act(() => input.blur());
    expect(input.hidden).toBe(true);
    expect(document.querySelector('.browser-address-display').textContent).toBe('https://edited.example/path');
    expect(styles).toMatch(/\.browser-address-display\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;[^}]*white-space:\s*pre;/);
  });

  it('ignores cancelled or scrolling gestures and resets scrolling on navigation', async () => {
    await render(browser());
    const display = document.querySelector('.browser-address-display');
    act(() => display.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    act(() => display.dispatchEvent(new Event('pointercancel', { bubbles: true })));
    click(display);
    expect(document.querySelector('.browser-address').hidden).toBe(true);
    act(() => display.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    display.scrollLeft = 120;
    act(() => display.dispatchEvent(new Event('scroll')));
    click(display);
    expect(document.querySelector('.browser-address').hidden).toBe(true);
    await render(browser({ tabs: [{ ...tabs[0], originalUrl: 'https://changed.example/' }, tabs[1]] }));
    expect(display.scrollLeft).toBe(0);
    display.scrollLeft = 30;
    await render(browser({ activeId: 'b' }));
    expect(display.scrollLeft).toBe(0);
  });

  it('keeps static paths read-only and focuses the existing editor for a new tab', async () => {
    await render(browser(), staticPreview({ selected: true,
      shownPreview: { name: 'static-a', dir: '/home/u/site', status: 'ready' },
    }));
    click(document.querySelector('.browser-address-display'));
    expect(document.querySelector('.browser-address').hidden).toBe(true);
    expect(document.activeElement).not.toBe(document.querySelector('.browser-address'));
    const model = browser({ historyActive: true, activeId: null });
    await render(model);
    const frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return 1; });
    click(document.querySelector('button[aria-label="新建标签页"]'));
    act(() => frames.forEach((callback) => callback(0)));
    expect(document.activeElement).toBe(document.querySelector('.browser-address'));
    expect(document.querySelector('.browser-address').hidden).toBe(false);
  });

  it('supports keyboard editing and resets the address view when switching tabs', async () => {
    await render(browser());
    const display = document.querySelector('.browser-address-display');
    act(() => display.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(document.activeElement).toBe(document.querySelector('.browser-address'));
    await render(browser({ activeId: 'b' }));
    expect(document.querySelector('.browser-address').hidden).toBe(true);
    expect(document.querySelector('.browser-address-display').textContent).toBe(tabs[1].originalUrl);
    await render(browser({ historyActive: true, activeId: null }));
    expect(document.querySelector('.browser-address').hidden).toBe(false);
  });

  it('keeps three modes above the unified address and enters a static draft without closing the page', async () => {
    const model = browser();
    const preview = staticPreview();
    await render(model, preview);
    const modes = [...document.querySelectorAll('.browser-mode-menu button')];
    expect(modes.map((node) => node.textContent)).toEqual(['直连', '代理', '静态']);
    expect(document.querySelector('.browser-address-mode')).toBeNull();
    expect(document.querySelector('.browser-address-folder')).toBeNull();
    selectMode(2);
    expect(modes[2].getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.browser-address-display').textContent).toBe('选择目录');
    expect(document.querySelector('.browser-address').hidden).toBe(true);
    expect(model.switchTab).not.toHaveBeenCalled();
    expect(preview.deactivate).not.toHaveBeenCalled();
    expect(preview.startPreview).not.toHaveBeenCalled();
    selectMode(0);
    expect(model.switchTab).toHaveBeenCalledWith('a');
    expect(model.navigateTab).toHaveBeenCalledWith('a', 'https://a.example/', 'direct');
    expect(document.querySelector('.browser-address').value).not.toMatch(/^\//);
  });

  it('preserves modes across real Home and static-tab transitions, and only creates a confirmed directory', async () => {
    vi.spyOn(browserApi, 'fetchDir').mockResolvedValue({ path: '/home/u/site', home: '/home/u', parent: null, entries: [] });
    const start = vi.fn();
    function StatefulSheet() {
      const [webTabs, setWebTabs] = useState(tabs);
      const [activeId, setActiveId] = useState('a');
      const [historyActive, setHistory] = useState(false);
      const [staticTab, setStaticTab] = useState(null);
      const [selected, setSelected] = useState(false);
      const model = browser({ tabs: webTabs, activeId, historyActive,
        switchTab: (id) => { setHistory(id === 'history'); if (id !== 'history') setActiveId(id); },
        navigateTab: (id, url, mode) => setWebTabs((current) => current.map((tab) => tab.id === id ? { ...tab, mode, originalUrl: url } : tab)),
      });
      return <BrowserSheet browser={model} staticPreview={staticPreview({
        selected, shownPreview: selected ? staticTab : null, tabs: staticTab ? [staticTab] : [],
        lastPreviewDir: '/home/u/site',
        deactivate: () => setSelected(false), switchTab: () => setSelected(true),
        startPreview: async (dir) => {
          start(dir); setStaticTab({ name: 'static-one', dir, status: 'ready', url: '/preview/site/' }); setSelected(true);
        },
      })} />;
    }
    await act(() => root.render(<StatefulSheet />));
    const modes = () => [...document.querySelectorAll('.browser-mode-menu button')];
    selectMode(2);
    expect(document.querySelector('iframe[data-tab-id="a"]').closest('.browser-pane').classList.contains('active')).toBe(true);
    await clickAndFlush(document.querySelector('.browser-address-form'));
    expect(document.querySelector('.dirpick-card')).not.toBeNull();
    click(document.querySelector('.dirpick-card button[aria-label="关闭"]'));
    expect(start).not.toHaveBeenCalled();
    const display = document.querySelector('.browser-address-display');
    act(() => display.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    act(() => display.dispatchEvent(new Event('pointercancel', { bubbles: true })));
    const folder = document.querySelector('.browser-address-form');
    act(() => folder.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    await clickAndFlush(folder);
    await act(async () => { await Promise.resolve(); });
    await clickAndFlush(document.querySelector('.browse-pick-confirm'));
    expect(start).toHaveBeenCalledWith('/home/u/site');
    expect(modes()[2].getAttribute('aria-pressed')).toBe('true');
    click(document.querySelector('.browser-history-tab'));
    expect(modes()[2].getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.browser-address-display').textContent).toBe('选择目录');
    click(document.querySelector('button[aria-label="新建标签页"]'));
    expect(document.querySelector('.browser-address').hidden).toBe(true);
    selectMode(0);
    expect(modes()[0].getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.browser-address').value).toBe('https://a.example/');
    expect(document.querySelector('iframe[data-tab-id="a"]').closest('.browser-pane').classList.contains('active')).toBe(true);
    click(document.querySelector('.browser-tab-wrap.static .browser-tab'));
    expect(modes()[2].getAttribute('aria-pressed')).toBe('true');
    selectMode(1);
    expect(modes()[1].getAttribute('aria-pressed')).toBe('true');
  });

  it.each(['mode', 'tab', 'close'])('does not open a late directory picker after changing %s', async (change) => {
    let resolveCwd;
    vi.spyOn(browserApi, 'fetchPaneCwd').mockReturnValue(new Promise((resolve) => { resolveCwd = resolve; }));
    const model = browser();
    const preview = staticPreview({ pane: '%1' });
    await render(model, preview);
    selectMode(2);
    click(document.querySelector('.browser-address-display'));
    if (change === 'mode') selectMode(0);
    else await render({ ...model, ...(change === 'tab' ? { activeId: 'b' } : { open: false }) }, preview);
    await act(async () => { resolveCwd({ cwd: '/home/u/site' }); await Promise.resolve(); });
    expect(document.querySelector('.dirpick-card')).toBeNull();
  });

  it('returns from an empty static draft to a URL Home without submitting a directory', async () => {
    const model = browser({ tabs: [], activeId: null, historyActive: true });
    await render(model, staticPreview());
    const modes = [...document.querySelectorAll('.browser-mode-menu button')];
    selectMode(2);
    submit(document.querySelector('.browser-address-form'));
    expect(model.openUrl).not.toHaveBeenCalled();
    selectMode(1);
    expect(model.switchTab).toHaveBeenCalledWith('history');
    expect(document.querySelector('.browser-address').hidden).toBe(false);
    expect(document.querySelector('.browser-address').value).toBe('');
    expect(modes[1].getAttribute('aria-pressed')).toBe('true');
    await render({ ...model, proxyAvailable: false });
    expect(modes[1].getAttribute('aria-pressed')).toBe('true');
    expect(modes[1].disabled).toBe(true);
  });

  it('leaves a static draft when web history reuses the same retained tab id', async () => {
    const preview = staticPreview();
    function HistorySheet() {
      const [historyActive, setHistory] = useState(true);
      return <BrowserSheet browser={browser({ historyActive,
        tabs: [{ ...tabs[0], mode: 'direct' }],
        history: [{ url: tabs[0].originalUrl, title: 'Alpha', visitedAt: 1, lastMode: 'direct' }],
        openUrl: () => setHistory(false),
      })} staticPreview={preview} />;
    }
    await act(() => root.render(<HistorySheet />));
    selectMode(2);
    click(document.querySelector('.browser-history-main'));
    expect(document.querySelectorAll('.browser-mode-menu button')[0].getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.browser-address-display').textContent).toBe(tabs[0].originalUrl);
    expect(preview.deactivate).toHaveBeenCalled();
  });

  it('uses one current-mode icon and opens an exclusive dismissible mode picker', async () => {
    const model = browser();
    await render(model);
    const trigger = document.querySelector('.browser-mode-switch');
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toBe('');
    expect(trigger.getAttribute('aria-label')).toContain('经电脑代理');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    click(trigger);
    const menu = document.querySelector('.browser-mode-menu');
    expect(menu.hidden).toBe(false);
    expect(document.activeElement.getAttribute('aria-pressed')).toBe('true');
    expect(menu.querySelector('[aria-pressed="true"] svg')).not.toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    click(document.querySelector('button[aria-label="网页预览器菜单"]'));
    click(trigger);
    expect(document.querySelector('.browser-options-card')).toBeNull();
    click(document.querySelector('.browser-mode-backdrop'));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    click(trigger);
    click(menu.querySelector('button'));
    expect(menu.hidden).toBe(true);
    expect(model.navigateTab).toHaveBeenCalledWith('a', tabs[0].originalUrl, 'direct');
    expect(document.activeElement).toBe(trigger);
  });

  it('moves focus through enabled modes and dismisses on toolbar navigation or lifecycle changes', async () => {
    const model = browser({ proxyAvailable: false });
    await render(model);
    const trigger = document.querySelector('.browser-mode-switch');
    click(trigger);
    const menu = document.querySelector('.browser-mode-menu');
    const choices = [...menu.querySelectorAll('button')];
    expect(document.activeElement).toBe(choices[0]);
    act(() => choices[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(choices[2]);
    act(() => choices[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    click(trigger);
    await render({ ...model, activeId: 'b' });
    expect(menu.hidden).toBe(true);
    click(trigger);
    await render({ ...model, activeId: 'b', open: false });
    expect(menu.hidden).toBe(true);
  });

  it('keeps mode, address and actions in one compact toolbar, with proxy guidance after menu actions', async () => {
    await render(browser());
    const nav = document.querySelector('.browser-nav');
    expect(nav.querySelector('.browser-mode-switch')).not.toBeNull();
    expect(nav.querySelector('.browser-address-form')).not.toBeNull();
    expect(nav.querySelector('.browser-address-form > svg')).toBeNull();
    expect(document.querySelector('.browser-mode-row')).toBeNull();
    expect(document.querySelector('.browser-mode-segment')).toBeNull();
    expect(styles).toMatch(/\.browser-nav-button\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/);
    expect(styles).toMatch(/\.browser-address-form\s*\{[^}]*min-width:\s*0/);
    expect(styles).not.toMatch(/\.browser-nav-button\s*\{[^}]*width:\s*36px/);
    click(document.querySelector('button[aria-label="网页预览器菜单"]'));
    const menu = document.querySelector('.browser-options-card');
    expect(menu.firstElementChild.classList.contains('browser-width-row')).toBe(true);
    expect(menu.lastElementChild.classList.contains('browser-options-footer')).toBe(true);
    expect(menu.lastElementChild.querySelector('.browser-proxy-limit')).not.toBeNull();
    expect(styles).toMatch(/\.browser-options-footer\s*\{[^}]*padding:\s*12px 4px/);
    expect(styles).not.toMatch(/\.browser-options-hint\s*\{[^}]*margin:\s*-/);
  });

  it('keeps unavailable proxy visible with a reason in the permanent selector', async () => {
    await render(browser({ proxyAvailable: false, historyActive: true }));
    const modes = [...document.querySelectorAll('.browser-mode-menu button')];
    expect(modes).toHaveLength(3);
    expect(modes[1].disabled).toBe(true);
    expect(document.getElementById(modes[1].getAttribute('aria-describedby')).textContent)
      .toContain('handmux setup');
    click(document.querySelector('button[aria-label="网页预览器菜单"]'));
    expect(document.querySelector('.browser-options-card .browser-mode-menu')).toBeNull();
  });

  it('renders a static directory as a green tab with only view and zoom in its menu', async () => {
    const tab = {
      name: 'main-3', dir: '/home/u/site', kind: 'static', status: 'ready',
      url: '/preview/main-3/preview-only/',
    };
    const preview = staticPreview({ selected: true, shownPreview: tab, tabs: [tab] });
    await render(browser({ historyActive: true, activeId: null }), preview);
    const staticTab = document.querySelector('.browser-tab-wrap.static');
    const frame = document.querySelector('.browser-pane.static iframe');
    expect(staticTab).toBeTruthy();
    expect(staticTab.querySelector('.browser-mode-badge')).toBeNull();
    const sandbox = frame.getAttribute('sandbox').split(/\s+/);
    expect(sandbox).toEqual(expect.arrayContaining([
      'allow-scripts', 'allow-forms', 'allow-downloads', 'allow-modals', 'allow-popups',
    ]));
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox.some((value) => value.startsWith('allow-top-navigation'))).toBe(false);
    expect(document.querySelector('.browser-address').readOnly).toBe(true);
    expect(document.querySelector('.browser-address-display').textContent).toBe('/home/u/site');

    click(document.querySelector('button[aria-label="网页预览器菜单"]'));
    const menu = document.querySelector('.browser-options-card');
    expect(menu.textContent).toContain('页面宽度');
    expect(menu.textContent).not.toContain('向网站请求');
    expect(menu.textContent).toContain('缩放网页');
    expect(menu.textContent).not.toContain('源目录');
    expect(menu.textContent).not.toContain('停止预览');
    expect(menu.textContent).not.toContain('用系统浏览器打开');
    expect(menu.textContent).not.toContain('连接方式');
    expect(menu.textContent).not.toContain('后台关闭');
    expect(menu.textContent).not.toMatch(/分钟/);
    expect(styles).toMatch(/\.browser-tab-wrap\.static[^}]*var\(--green\)/);
  });

  it('closes a static tab through its unified lifecycle action', async () => {
    const tab = {
      name: 'main-3', dir: '/home/u/site', kind: 'static', status: 'ready',
      url: '/preview/main-3/capability-x/',
    };
    const preview = staticPreview({ selected: true, shownPreview: tab, tabs: [tab] });
    await render(browser({ historyActive: true, activeId: null }), preview);
    click(document.querySelector('.browser-tab-wrap.static .browser-tab-close'));
    expect(preview.closeTab).toHaveBeenCalledWith('main-3');
  });

  it('shows the actual static registration error with retry', async () => {
    const tab = {
      name: 'main-3', dir: '/home/u/site', kind: 'static', status: 'error', url: null,
      error: new Error('directory not found'),
    };
    const preview = staticPreview({ selected: true, shownPreview: tab, tabs: [tab] });
    await render(browser({ historyActive: true, activeId: null }), preview);
    expect(document.querySelector('.browser-pane.static iframe')).toBeNull();
    expect(document.querySelector('.browser-static-state').textContent).toContain('directory not found');
    const retry = document.querySelector('.browser-static-state button');
    expect(retry.textContent).toBe('重试');
    click(retry);
    expect(preview.retryPreview).toHaveBeenCalledWith('main-3');
  });

  it('keeps visited static iframes mounted when tabs are switched', async () => {
    const firstTab = {
      name: 'main-3', dir: '/home/u/site', kind: 'static', status: 'ready',
      url: '/preview/main-3/capability-x/',
    };
    const secondTab = {
      name: 'docs-4', dir: '/home/u/docs', kind: 'static', status: 'ready',
      url: '/preview/docs-4/capability-y/',
    };
    const model = browser({ historyActive: true, activeId: null });
    await render(model, staticPreview({ selected: true, shownPreview: firstTab, tabs: [firstTab, secondTab] }));
    const first = document.querySelector('iframe[data-static-tab-name="main-3"]');

    await render(model, staticPreview({ selected: true, shownPreview: secondTab, tabs: [firstTab, secondTab] }));
    const second = document.querySelector('iframe[data-static-tab-name="docs-4"]');
    expect(first.closest('.browser-pane').classList.contains('active')).toBe(false);
    expect(second.closest('.browser-pane').classList.contains('active')).toBe(true);

    await render(model, staticPreview({ selected: true, shownPreview: firstTab, tabs: [firstTab, secondTab] }));
    expect(document.querySelector('iframe[data-static-tab-name="main-3"]')).toBe(first);
    expect(document.querySelector('iframe[data-static-tab-name="docs-4"]')).toBe(second);
  });

  it.each([320, 390, 430, 767, 768, 1024, 1280, 1440])('fits the available %ipx width and chooses the initial mode at 768px', async (width) => {
    mockBrowserSize(width);
    await render(browser());
    const frame = document.querySelector('.browser-pane.active .browser-frame');
    const layoutWidth = width >= 768 ? Math.max(1280, width) : width;
    expect(document.querySelector('.browser-content').classList.contains(width >= 768 ? 'wide' : 'narrow')).toBe(true);
    expect(frame.style.width).toBe(`${layoutWidth}px`);
    expect(frame.style.transform).toBe(`scale(${width / layoutWidth})`);
    expect(frame.parentElement.style.width).toBe(`${width}px`);
  });

  it('preserves forced wide layout, zoom, and iframe identity across resizing and reopening', async () => {
    const resize = mockBrowserSize(430);
    const model = browser();
    await render(model);
    click(document.querySelector('button[aria-label="网页预览器菜单"]'));
    click(document.querySelectorAll('.browser-width-row button')[1]);
    const frame = document.querySelector('.browser-pane.active .browser-frame');
    expect(frame.style.width).toBe('1280px');
    expect(frame.style.transform).toBe(`scale(${430 / 1280})`);
    click(document.querySelector('.browser-zoom-stepper button[aria-label="放大"]'));
    expect(frame.style.transform).toBe(`scale(${430 / 1280 * 1.1})`);
    expect(frame.parentElement.style.width).toBe('473px');
    resize(600);
    expect(frame.style.width).toBe('1280px');
    expect(frame.style.transform).toBe(`scale(${600 / 1280 * 1.1})`);
    await render({ ...model, open: false });
    await render(model);
    expect(document.querySelector('.browser-pane.active .browser-frame')).toBe(frame);
    expect(frame.style.width).toBe('1280px');
  });

  it('keeps manual narrow mode and follows actual width after desktop resize', async () => {
    const resize = mockBrowserSize(1440);
    await render(browser());
    click(document.querySelector('button[aria-label="网页预览器菜单"]'));
    click(document.querySelectorAll('.browser-width-row button')[0]);
    resize(430);
    const frame = document.querySelector('.browser-pane.active .browser-frame');
    expect(frame.style.width).toBe('430px');
    expect(frame.style.transform).toBe('scale(1)');
    resize(1440);
    expect(document.querySelector('.browser-content').classList.contains('narrow')).toBe(true);
    expect(frame.style.width).toBe('1440px');
    expect(frame.style.transform).toBe('scale(1)');
  });

  it('keeps fine-grained page zoom controls in the menu without blocking webpage interaction', async () => {
    const viewport = document.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    document.head.appendChild(viewport);
    try {
      await render(browser());
      click(document.querySelector('button[aria-label="网页预览器菜单"]'));
      const stepper = document.querySelector('.browser-zoom-stepper');
      const scaler = document.querySelector('.browser-pane.active .browser-frame-scaler');
      const frame = document.querySelector('.browser-pane.active .browser-frame');
      expect(stepper.parentElement.parentElement.textContent).toContain('缩放网页');
      expect(document.querySelector('.browser-zoom-layer')).toBeNull();

      click(stepper.querySelector('button[aria-label="放大"]'));
      expect(stepper.textContent).toContain('110%');
      expect(frame.style.transform).toContain('scale(1.1)');
      expect(scaler.style.width).toBe('429px');
      expect(scaler.style.height).toBe('110%');
      expect(frame.style.width).toBe('390px');
      expect(styles).toMatch(/\.browser-pane\s*\{[^}]*overflow:\s*auto/);
      expect(styles).toMatch(/\.browser-pane::.*scrollbar:horizontal\s*\{[^}]*height:\s*7px/);
      expect(styles).toMatch(/\.browser-content\s*\{[^}]*isolation:\s*isolate[^}]*contain:\s*paint/);
      expect(styles).not.toMatch(/\.browser-frame\s*\{[^}]*will-change:\s*transform/);
      expect(styles).toMatch(/\.browser-tabs\s*\{[^}]*z-index:\s*2/);
      expect(styles).toMatch(/\.browser-nav\s*\{[^}]*z-index:\s*2/);
      expect(frame.hasAttribute('inert')).toBe(false);
      act(() => frame.dispatchEvent(new Event('load')));
      expect(frame.hasAttribute('inert')).toBe(false);
      expect(document.querySelector('.browser-tabs').style.transform).toBe('');
      expect(document.querySelector('.browser-nav').style.transform).toBe('');

      click(stepper.querySelector('button[aria-label="放大"]'));
      expect(stepper.textContent).toContain('125%');
      expect(scaler.style.width).toBe('487.5px');
      expect(frame.style.width).toBe('390px');
      click(stepper.querySelector('button[aria-label="重置网页缩放"]'));
      expect(stepper.textContent).toContain('100%');
      expect(scaler.style.width).toBe('390px');
      expect(frame.style.width).toBe('390px');
      expect(frame.style.transform).toBe('scale(1)');

      const zoomOut = stepper.querySelector('button[aria-label="缩小"]');
      const zoomIn = stepper.querySelector('button[aria-label="放大"]');
      for (const value of [90, 80, 75]) {
        click(zoomOut);
        expect(stepper.textContent).toContain(`${value}%`);
      }
      expect(zoomOut.disabled).toBe(true);
      click(stepper.querySelector('button[aria-label="重置网页缩放"]'));
      for (const value of [110, 125, 150, 175, 200]) {
        click(zoomIn);
        expect(stepper.textContent).toContain(`${value}%`);
      }
      expect(zoomIn.disabled).toBe(true);
      expect(viewport.content).toBe('width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    } finally {
      viewport.remove();
    }
  });

  it('explains direct and proxy access accurately before first use and requires an explicit enable action', async () => {
    const model = browser({ open: false, consentOpen: true });
    await render(model);
    const consent = document.querySelector('.browser-consent').textContent;
    expect(consent).toContain('网页预览器');
    expect(consent).toContain('不是真正的浏览器');
    expect(consent).toContain('开发服务');
    expect(consent).toContain('localhost');
    expect(consent).toContain('手机直连');
    expect(consent).toContain('经电脑代理');
    expect(consent).toContain('iframe 或 CSP');
    expect(consent).toContain('未必能判断原因');
    expect(consent).toContain('系统浏览器');
    expect(consent).not.toContain('关闭并销毁登录状态');
    const acknowledge = document.querySelector('.browser-consent-enable');
    expect(acknowledge.textContent).toBe('好的');
    click(acknowledge);
    expect(model.enableAccess).toHaveBeenCalledOnce();
  });
  it('renders tabs above navigation with a fixed icon-only Recent tab first', async () => {
    await render(browser());
    const sheet = document.querySelector('.browser-sheet');
    expect(sheet.children[0].classList.contains('browser-tabs')).toBe(true);
    expect(sheet.children[1].classList.contains('browser-nav')).toBe(true);
    expect(document.querySelector('.browser-mode-row')).toBeNull();
    const tabButtons = [...document.querySelectorAll('[role="tab"]')];
    expect(tabButtons.map((node) => node.textContent)).toEqual(['', 'Alpha', 'Beta']);
    const recent = document.querySelector('.browser-history-tab');
    expect(recent.getAttribute('aria-label')).toBe('最近访问');
    expect(recent.getAttribute('title')).toBe('最近访问');
    expect(recent.querySelector('svg')).not.toBeNull();
    expect(recent.querySelector('.browser-tab-close')).toBeNull();
  });

  it('shows Close only on the active tab without reserving space on inactive tabs', async () => {
    const staticTab = {
      name: 'main-3', dir: '/home/u/site', kind: 'static', status: 'ready',
      url: '/preview/main-3/capability-x/',
    };
    const model = browser();
    const preview = staticPreview({ tabs: [staticTab] });
    await render(model, preview);

    expect(document.querySelector('button[aria-label="关闭 Alpha"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="关闭 Beta"]')).toBeNull();
    expect(document.querySelectorAll('.browser-tab-close')).toHaveLength(1);
    const beta = [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent === 'Beta');
    const staticButton = [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent === 'site');
    expect(beta.closest('.browser-tab-wrap').querySelector('.browser-tab-close')).toBeNull();
    expect(staticButton.closest('.browser-tab-wrap').querySelector('.browser-tab-close')).toBeNull();

    click(beta);
    expect(model.switchTab).toHaveBeenCalledWith('b');
    click(staticButton);
    expect(model.switchTab).toHaveBeenLastCalledWith('history');
    expect(preview.switchTab).toHaveBeenCalledWith('main-3');
  });

  it('orders web and static tabs together so a newly opened web tab stays last', async () => {
    const staticTab = {
      name: 'main-3', dir: '/home/u/site', kind: 'static', status: 'ready', createdAt: 200,
      url: '/preview/main-3/capability-x/',
    };
    await render(browser({
      tabs: [
        { ...tabs[0], createdAt: 100 },
        { ...tabs[1], createdAt: 300 },
      ],
    }), staticPreview({ tabs: [staticTab] }));

    expect([...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent))
      .toEqual(['', 'Alpha', 'site', 'Beta']);
  });

  it('keeps direct, proxy, and static tabs compact with synchronized accent bars and no leading dots', async () => {
    const staticTab = {
      name: 'main-3', dir: '/home/u/site', kind: 'static', status: 'ready',
      url: '/preview/main-3/capability-x/',
    };
    const preview = staticPreview({ tabs: [staticTab] });
    await render(browser({
      tabs: [
        { ...tabs[0], mode: 'direct' },
        tabs[1],
      ],
    }), preview);
    expect(document.querySelectorAll('.browser-mode-badge')).toHaveLength(0);
    expect(styles).toMatch(/\.browser-tabs\s*\{[^}]*min-height:\s*38px/);
    expect(styles).toMatch(/\.browser-tab\s*\{[^}]*min-height:\s*38px/);
    expect(styles).toMatch(/\.browser-tab-wrap\s*\{[^}]*min-width:\s*52px/);
    expect(styles).toMatch(/\.browser-tab\s*\{[^}]*min-width:\s*0/);
    expect(styles).toMatch(/\.browser-tab-wrap\.active \.browser-tab\s*\{[^}]*padding-right:\s*0/);
    expect(styles).toMatch(/\.browser-history-tab, \.browser-head-button\s*\{[^}]*flex:\s*0 0 44px[^}]*width:\s*44px/);
    expect(styles).toMatch(/\.browser-tab-wrap, \.browser-mode-switch, \.browser-mode-option\s*\{[^}]*--browser-mode-accent:\s*var\(--blue\)/);
    expect(styles).toMatch(/\.browser-tab-wrap\.proxy, \.browser-mode-switch\.proxy, \.browser-mode-option\.proxy\s*\{[^}]*--browser-mode-accent:\s*#e8892f/);
    expect(styles).toMatch(/\.browser-tab-wrap\.static, \.browser-mode-switch\.static, \.browser-mode-option\.static\s*\{[^}]*--browser-mode-accent:\s*var\(--green\)/);
    expect(styles).toMatch(/\.browser-tab-wrap\.active\s*\{[^}]*inset 0 2px 0 var\(--browser-mode-accent\)[^}]*inset 0 -2px 0 var\(--browser-mode-accent\)/);
  });

  it('scrolls a newly active tab into view', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const model = browser();
    try {
      await render(model);
      scrollIntoView.mockClear();
      await act(async () => {
        root.render(<BrowserSheet browser={{
          ...model,
          tabs: [...tabs, {
            id: 'c', mode: 'direct', url: 'https://c.example/',
            originalUrl: 'https://c.example/', title: 'Gamma',
          }],
          activeId: 'c',
        }} />);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
      expect(scrollIntoView.mock.contexts.at(-1).textContent).toContain('Gamma');
    } finally {
      delete Element.prototype.scrollIntoView;
    }
  });

  it('marks proxy tabs orange without a leading dot and lets an existing tab switch modes in place', async () => {
    const model = browser();
    await render(model);
    const alpha = [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.includes('Alpha'));
    expect(alpha.querySelector('.browser-mode-badge')).toBeNull();
    expect(alpha.closest('.browser-tab-wrap').classList.contains('proxy')).toBe(true);
    click(document.querySelector('button[aria-label="网页预览器菜单"]'));
    const modeButtons = [...document.querySelectorAll('.browser-mode-menu button')];
    expect(modeButtons.map((node) => node.textContent)).toEqual(['直连', '代理', '静态']);
    expect(modeButtons.map((node) => node.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(document.querySelector('.browser-proxy-limit').textContent)
      .toBe('电脑代理会转发并改写网页，不保证兼容所有网站。');
    selectMode(0);
    expect(model.navigateTab).toHaveBeenCalledWith('a', 'https://a.example/', 'direct');
  });

  it('closes the options card when entering History and does not revive it on return', async () => {
    const model = browser();
    await render(model);
    click(document.querySelector('button[aria-label="网页预览器菜单"]'));
    expect(document.querySelector('.browser-options-card')).not.toBeNull();

    click(document.querySelector('.browser-history-tab'));
    await render({ ...model, historyActive: true });
    expect(document.querySelector('.browser-options-card')).toBeNull();
    await render({ ...model, historyActive: false });
    expect(document.querySelector('.browser-options-card')).toBeNull();
    expect(model.navigateTab).not.toHaveBeenCalled();
  });

  it('hides bridge-only controls on direct tabs and refreshes the iframe locally', async () => {
    const directTabs = tabs.map((tab) => tab.id === 'b'
      ? { ...tab, mode: 'direct', url: tab.originalUrl }
      : tab);
    const model = browser({ activeId: 'b', tabs: directTabs });
    await render(model);
    expect(document.querySelector('button[aria-label="后退"]')).toBeNull();
    expect(document.querySelector('button[aria-label="前进"]')).toBeNull();
    expect(document.querySelector('button[aria-label="停止加载"]')).toBeNull();
    const frame = document.querySelector('iframe[data-tab-id="b"]');
    act(() => frame.dispatchEvent(new Event('load')));
    click(document.querySelector('button[aria-label="刷新"]'));
    expect(document.querySelector('iframe[data-tab-id="b"]')).not.toBe(frame);
  });

  it('does not infer an iframe failure from elapsed loading time', async () => {
    vi.useFakeTimers();
    const directTabs = [{ ...tabs[0], mode: 'direct', url: tabs[0].originalUrl }];
    try {
      await render(browser({ tabs: directTabs, activeId: 'a', proxyAvailable: true }));
      act(() => vi.advanceTimersByTime(60_000));

      expect(document.querySelector('.browser-page-progress')).not.toBeNull();
      expect(document.querySelector('.browser-error')).toBeNull();
      expect(document.querySelector('.browser-try-proxy')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still surfaces confirmed errors returned by navigation or proxy requests', async () => {
    await render(browser({ error: new Error('代理请求返回 502') }));

    const error = document.querySelector('.browser-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('代理请求返回 502');
  });

  it('lets history mode menus escape the rounded list instead of clipping them', () => {
    const rule = styles.match(/\.browser-history-list\s*\{([^}]*)\}/)?.[1] || '';
    expect(rule).not.toMatch(/overflow:\s*hidden/);
  });

  it('opens history in its last mode and supports a three-dot override', async () => {
    const model = browser();
    await render(model);
    click(document.querySelector('.browser-history-tab'));
    await render({ ...model, historyActive: true, activeId: null });
    click(document.querySelector('.browser-history-main'));
    expect(model.openUrl).toHaveBeenCalledWith('https://old.example/', { mode: 'direct' });
    click(document.querySelector('.browser-history-more'));
    click([...document.querySelectorAll('.browser-history-mode-option')].find((node) => node.textContent === '经电脑代理'));
    expect(model.openUrl).toHaveBeenLastCalledWith('https://old.example/', { mode: 'proxy' });
    expect(model.setHistoryMode).toHaveBeenCalledWith(model.history[0], 'proxy');
  });

  it('records ready static previews and reopens their directories from history without web mode choices', async () => {
    const staticTab = {
      name: 'main-3', dir: '/home/u/site', kind: 'static', status: 'ready',
      url: '/preview/main-3/capability-secret/',
    };
    const model = browser({ historyActive: true, activeId: null });
    const selectedPreview = staticPreview({ selected: true, shownPreview: staticTab, tabs: [staticTab] });
    await render(model, selectedPreview);
    expect(model.recordStaticHistory).toHaveBeenCalledWith({ dir: '/home/u/site', title: 'site' });

    const entry = { kind: 'static', dir: '/home/u/site', title: 'site', visitedAt: 123 };
    const historyModel = browser({ historyActive: true, activeId: null, history: [entry] });
    const preview = staticPreview();
    await render(historyModel, preview);
    expect(document.querySelector('.browser-history-mode.static').textContent).toBe('静态');
    expect(document.querySelector('.browser-history-url').textContent).toBe('/home/u/site');
    click(document.querySelector('.browser-history-main'));
    expect(preview.startPreview).toHaveBeenCalledWith('/home/u/site');
    expect(historyModel.openUrl).not.toHaveBeenCalled();

    click(document.querySelector('.browser-history-more'));
    const menu = document.querySelector('.browser-history-mode-menu');
    expect(menu.textContent).toBe('删除此记录');
  });

  it('shows each history mode inline and keeps Cookie cleanup out of history-row menus', async () => {
    const model = browser({ historyActive: true, activeId: null });
    await render(model);

    expect(document.querySelector('.browser-history-mode.direct').textContent).toBe('直连');
    click(document.querySelector('.browser-history-more'));
    const menu = document.querySelector('.browser-history-mode-menu');
    expect(menu.textContent).toContain('手机直连');
    expect(menu.textContent).toContain('经电脑代理');
    expect(menu.textContent).not.toContain('清理本站代理 Cookie');
    expect(menu.textContent).toContain('删除此记录');
  });

  it('makes site-clear confirmation keyboard-modal and restores trigger focus', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const model = browser();
    await render(model);
    const menuTrigger = document.querySelector('button[aria-label="网页预览器菜单"]');
    click(menuTrigger);
    const trigger = [...document.querySelectorAll('.browser-options-card button')]
      .find((node) => node.textContent === '清理本站代理 Cookie');
    trigger.focus();
    click(trigger);
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });

    const dialog = document.querySelector('.browser-profile-confirm');
    const [cancel, confirm] = dialog.querySelectorAll('button');
    expect(document.activeElement).toBe(cancel);
    expect(document.querySelector('.browser-tabs').hasAttribute('inert')).toBe(true);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    })));
    expect(document.activeElement).toBe(confirm);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    })));
    expect(document.activeElement).toBe(cancel);
    outside.focus();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    })));
    expect(document.activeElement).toBe(cancel);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.querySelector('.browser-profile-confirm')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    outside.remove();
  });

  it('deletes history locally without invoking profile cleanup', async () => {
    const model = browser({ historyActive: true, activeId: null });
    await render(model);
    click(document.querySelector('.browser-history-more'));
    click([...document.querySelectorAll('.browser-history-mode-menu button')]
      .find((node) => node.textContent === '删除此记录'));

    expect(model.deleteHistory).toHaveBeenCalledWith(model.history[0]);
    expect(model.clearProxyLogin).not.toHaveBeenCalled();
  });

  it('uses an overridden history mode again in the same mount even when the first open fails', async () => {
    const model = browser({ historyActive: true, activeId: null, openUrl: vi.fn().mockResolvedValue(null) });
    function Harness() {
      const [history, setHistory] = useState(model.history);
      return <BrowserSheet browser={{
        ...model,
        history,
        setHistoryMode: (entry, mode) => {
          model.setHistoryMode(entry, mode);
          setHistory((current) => current.map((item) => item.url === entry.url ? { ...item, lastMode: mode } : item));
        },
      }} />;
    }
    await act(() => root.render(<Harness />));

    click(document.querySelector('.browser-history-more'));
    click([...document.querySelectorAll('.browser-history-mode-option')].find((node) => node.textContent === '经电脑代理'));
    click(document.querySelector('.browser-history-main'));

    expect(model.openUrl).toHaveBeenNthCalledWith(1, 'https://old.example/', { mode: 'proxy' });
    expect(model.openUrl).toHaveBeenNthCalledWith(2, 'https://old.example/', { mode: 'proxy' });
  });

  it('disables unavailable proxy choices in history and mode switching', async () => {
    const model = browser({ proxyAvailable: false, historyActive: true, activeId: null });
    await render(model);
    click(document.querySelector('.browser-history-more'));
    const proxy = [...document.querySelectorAll('.browser-history-mode-option')].find((node) => node.textContent === '经电脑代理');
    expect(proxy.disabled).toBe(true);
    const reason = document.querySelector('.browser-history-mode-menu p');
    expect(reason.textContent)
      .toBe('请在电脑终端运行 handmux setup，选择“网页预览器”配置代理域名；配置前只能使用手机直连。');
    expect(proxy.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('shows localized proxyUnavailable instead of opening stale proxy history', async () => {
    const model = browser({
      proxyAvailable: false, historyActive: true, activeId: null,
      history: [{ url: 'https://old.example/', title: 'Old', visitedAt: 1000, lastMode: 'proxy' }],
    });
    await render(model);

    click(document.querySelector('.browser-history-main'));

    expect(model.openUrl).not.toHaveBeenCalled();
    expect(document.querySelector('.browser-error').textContent)
      .toContain('请在电脑终端运行 handmux setup，选择“网页预览器”配置代理域名；配置前只能使用手机直连。');
  });

  it('clears stale history errors when switching tabs or starting a valid address operation', async () => {
    const model = browser({
      proxyAvailable: false, historyActive: true, activeId: null,
      history: [{ url: 'https://old.example/', title: 'Old', visitedAt: 1000, lastMode: 'proxy' }],
    });
    await render(model);
    click(document.querySelector('.browser-history-main'));
    expect(document.querySelector('.browser-error')).not.toBeNull();

    await clickAndFlush([...document.querySelectorAll('[role="tab"]')]
      .find((node) => node.textContent.includes('Alpha')));
    expect(document.querySelector('.browser-error')).toBeNull();

    click(document.querySelector('.browser-history-main'));
    setInput(document.querySelector('.browser-address'), 'https://valid.example/');
    submit(document.querySelector('.browser-address-form'));
    expect(model.openUrl).toHaveBeenCalledWith('https://valid.example/', { mode: 'direct' });
    expect(document.querySelector('.browser-error')).toBeNull();
  });

  it('submits the editable address and refreshes through the same authoritative navigation path', async () => {
    const model = browser({ navigateTab: vi.fn().mockResolvedValue(tabs[0]) });
    await render(model);
    const input = document.querySelector('.browser-address');
    setInput(input, 'https://next.example/path');
    submit(document.querySelector('.browser-address-form'));
    expect(model.navigateTab).toHaveBeenCalledWith('a', 'https://next.example/path');

    const frame = document.querySelector('iframe[data-tab-id="a"]');
    act(() => frame.dispatchEvent(new Event('load')));
    const post = vi.spyOn(frame.contentWindow, 'postMessage');
    expect(document.querySelector('button[aria-label="后退"]')).toBeNull();
    expect(document.querySelector('button[aria-label="前进"]')).toBeNull();
    await clickAndFlush(document.querySelector('button[aria-label="刷新"]'));
    expect(model.navigateTab).toHaveBeenLastCalledWith('a', 'https://a.example/', 'proxy');
    expect(post).not.toHaveBeenCalled();
    expect(document.querySelector('iframe[data-tab-id="a"]')).not.toBe(frame);
  });

  it('shows a top progress bar and changes Refresh into Stop while loading', async () => {
    await render(browser({ navigateTab: vi.fn(() => new Promise(() => {})) }));
    const frame = document.querySelector('iframe[data-tab-id="a"]');
    const overlay = document.querySelector('.browser-page-loading');
    const progress = document.querySelector('.browser-page-progress');
    const progressRule = styles.match(/\.browser-page-progress\s*\{([^}]*)\}/)?.[1] || '';
    const proxyProgressRule = styles.match(/\.browser-pane\.proxy \.browser-page-progress\s*\{([^}]*)\}/)?.[1] || '';
    const proxyProgressFillRule = styles.match(/\.browser-pane\.proxy \.browser-page-progress::after\s*\{([^}]*)\}/)?.[1] || '';
    expect(overlay).not.toBeNull();
    expect(document.querySelector('.browser-loading-hud')).toBeNull();
    expect(progress).not.toBeNull();
    expect(progress.getAttribute('role')).toBe('progressbar');
    expect(progressRule).toMatch(/height:\s*3px/);
    expect(proxyProgressRule).toMatch(/background:\s*rgba\(217,130,43/);
    expect(proxyProgressFillRule).toMatch(/background:\s*#d9822b/);
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(styles.match(/\.browser-page-loading\s*\{([^}]*)\}/)?.[1]).toMatch(/pointer-events:\s*none/);
    expect(document.querySelector('button[aria-label="停止加载"]')).not.toBeNull();

    act(() => frame.dispatchEvent(new Event('load')));
    expect(document.querySelector('.browser-page-loading')).toBeNull();
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('button[aria-label="刷新"]')).not.toBeNull();

    click(document.querySelector('button[aria-label="刷新"]'));
    expect(document.querySelector('.browser-page-loading')).not.toBeNull();
    act(() => frame.dispatchEvent(new Event('load')));
    expect(document.querySelector('.browser-page-loading')).toBeNull();

    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: { source: 'handmux-browser', channel: 'ca', type: 'navigate', url: 'https://a.example/next' },
    })));
    expect(document.querySelector('.browser-page-loading')).not.toBeNull();
    act(() => frame.dispatchEvent(new Event('load')));
    expect(document.querySelector('.browser-page-loading')).toBeNull();
  });

  it('stops the current iframe navigation and keeps its mounted page state', async () => {
    let resolveNavigate;
    const model = browser({
      navigateTab: vi.fn(() => new Promise((resolve) => { resolveNavigate = resolve; })),
    });
    await render(model);
    const frame = document.querySelector('iframe[data-tab-id="a"]');
    const post = vi.spyOn(frame.contentWindow, 'postMessage');

    act(() => frame.dispatchEvent(new Event('load')));
    click(document.querySelector('button[aria-label="刷新"]'));
    click(document.querySelector('button[aria-label="停止加载"]'));

    expect(model.navigateTab).toHaveBeenCalledWith('a', 'https://a.example/', 'proxy');
    expect(post.mock.calls.map(([message]) => message.command)).toEqual(['stop']);
    expect(document.querySelector('iframe[data-tab-id="a"]')).toBe(frame);
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('.browser-page-loading')).toBeNull();

    await act(async () => {
      resolveNavigate(tabs[0]);
      await Promise.resolve();
    });
    expect(document.querySelector('iframe[data-tab-id="a"]')).toBe(frame);
  });

  it('switches, closes, starts a new address and minimizes through the model', async () => {
    const model = browser();
    await render(model);
    await clickAndFlush([...document.querySelectorAll('[role="tab"]')][2]);
    click(document.querySelector('button[aria-label="关闭 Alpha"]'));
    click(document.querySelector('button[aria-label="新建标签页"]'));
    click(document.querySelector('button[aria-label="收起"]'));

    expect(model.switchTab).toHaveBeenNthCalledWith(1, 'b');
    expect(model.closeTab).toHaveBeenCalledWith('a');
    expect(model.switchTab).toHaveBeenNthCalledWith(2, 'history');
    expect(model.setOpen).toHaveBeenCalledWith(false);
  });

  it('cold-loads only the active iframe, then retains visited iframes', async () => {
    const model = browser();
    await render(model);
    expect(document.querySelectorAll('.browser-frame')).toHaveLength(1);
    await render({ ...model, activeId: 'b' });
    const frames = [...document.querySelectorAll('.browser-frame')];
    expect(frames).toHaveLength(2);
    expect(frames[0].closest('.browser-pane').classList.contains('active')).toBe(false);
    expect(frames[0].closest('.browser-pane').getAttribute('aria-hidden')).toBe('true');
    expect(frames[1].closest('.browser-pane').classList.contains('active')).toBe(true);
    expect(frames[1].closest('.browser-pane').getAttribute('aria-hidden')).toBe('false');
    expect(styles).not.toMatch(/\.browser-pane\[hidden\]\s*\{[^}]*display:\s*none/);
    for (const frame of frames) {
      const sandbox = frame.getAttribute('sandbox').split(/\s+/);
      expect(sandbox).toEqual(expect.arrayContaining([
        'allow-scripts', 'allow-forms', 'allow-downloads', 'allow-modals', 'allow-popups', 'allow-same-origin',
      ]));
      expect(sandbox.some((value) => value.startsWith('allow-top-navigation'))).toBe(false);
    }
  });

  it('keeps iframe state mounted without reloading when tabs are switched', async () => {
    const model = browser({ switchTab: vi.fn().mockResolvedValue(true) });
    await render(model);
    await render({ ...model, activeId: 'b' });
    await render(model);
    const first = document.querySelector('iframe[data-tab-id="a"]');
    const second = document.querySelector('iframe[data-tab-id="b"]');
    const postFirst = vi.spyOn(first.contentWindow, 'postMessage');
    const postSecond = vi.spyOn(second.contentWindow, 'postMessage');
    const tabButtons = [...document.querySelectorAll('[role="tab"]')];

    await clickAndFlush(tabButtons[2]);
    expect(postSecond).not.toHaveBeenCalled();
    await render({ ...model, activeId: 'b' });
    await clickAndFlush([...document.querySelectorAll('[role="tab"]')][2]);
    await render({ ...model, activeId: 'b' });
    await clickAndFlush([...document.querySelectorAll('[role="tab"]')][1]);
    await render({ ...model, activeId: 'a' });

    expect(document.querySelector('iframe[data-tab-id="a"]')).toBe(first);
    expect(document.querySelector('iframe[data-tab-id="b"]')).toBe(second);
    expect(postSecond).not.toHaveBeenCalled();
    expect(postFirst).not.toHaveBeenCalled();
  });

  it('does not reload a proxy page merely because its bridge script stays silent', async () => {
    vi.useFakeTimers();
    const model = browser();
    await render(model);
    const first = document.querySelector('iframe[data-tab-id="a"]');
    act(() => first.dispatchEvent(new Event('load')));
    act(() => vi.advanceTimersByTime(30_000));
    expect(model.recoverBinding).not.toHaveBeenCalled();

    await render({ ...model, activeId: 'b' });
    await render(model);
    expect(model.recoverBinding).not.toHaveBeenCalled();
  });

  it('does not reload either tab when switch promises finish out of order', async () => {
    let resolveA;
    let resolveB;
    const switchTab = vi.fn((id) => new Promise((resolve) => {
      if (id === 'a') resolveA = resolve;
      if (id === 'b') resolveB = resolve;
    }));
    const model = browser({ switchTab });
    await render(model);
    await render({ ...model, activeId: 'b' });
    await render(model);
    const first = document.querySelector('iframe[data-tab-id="a"]');
    const second = document.querySelector('iframe[data-tab-id="b"]');
    const postFirst = vi.spyOn(first.contentWindow, 'postMessage');
    const postSecond = vi.spyOn(second.contentWindow, 'postMessage');
    const tabButtons = [...document.querySelectorAll('[role="tab"]')];

    click(tabButtons[2]);
    click(tabButtons[1]);
    await act(async () => { resolveA(true); await Promise.resolve(); });
    await render({ ...model, activeId: 'a' });
    await act(async () => { resolveB(true); await Promise.resolve(); });
    await render({ ...model, activeId: 'b' });

    expect(postFirst).not.toHaveBeenCalled();
    expect(postSecond).not.toHaveBeenCalled();
  });

  it('accepts bridge messages only from the matching iframe and channel', async () => {
    const model = browser();
    await render(model);
    const frame = document.querySelector('iframe[data-tab-id="a"]');
    const data = { source: 'handmux-browser', channel: 'ca', type: 'title', url: 'https://a.example/next', title: 'Next' };

    act(() => window.dispatchEvent(new MessageEvent('message', { source: window, data })));
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { ...data, channel: 'wrong' } })));
    expect(model.updateTabMeta).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data })));
    expect(model.updateTabMeta).toHaveBeenCalledWith('a', { url: 'https://a.example/next', title: 'Next' });
  });

  it('rebuilds an unavailable proxy session once until the replacement bridge is ready', async () => {
    const model = browser({ recoverBinding: vi.fn().mockResolvedValue(tabs[0]) });
    await render(model);
    const frame = document.querySelector('iframe[data-tab-id="a"]');
    const unavailable = {
      source: 'handmux-browser', channel: 'ca', type: 'session-unavailable',
    };

    act(() => window.dispatchEvent(new MessageEvent('message', { source: window, data: unavailable })));
    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow, data: { ...unavailable, channel: 'wrong' },
    })));
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: unavailable })));
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: unavailable })));
    await act(async () => { await Promise.resolve(); });
    expect(model.recoverBinding).toHaveBeenCalledTimes(1);
    expect(model.recoverBinding).toHaveBeenCalledWith('a');

    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: { source: 'handmux-browser', channel: 'ca', type: 'ready' },
    })));
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: unavailable })));
    expect(model.recoverBinding).toHaveBeenCalledTimes(2);
  });

  it('releases the session recovery lock when a replacement page never reports ready', async () => {
    vi.useFakeTimers();
    const model = browser({ recoverBinding: vi.fn().mockResolvedValue(tabs[0]) });
    await render(model);
    const frame = document.querySelector('iframe[data-tab-id="a"]');
    const unavailable = {
      source: 'handmux-browser', channel: 'ca', type: 'session-unavailable',
    };

    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow, data: unavailable,
    })));
    await act(async () => { await Promise.resolve(); });
    act(() => vi.advanceTimersByTime(15_000));
    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow, data: unavailable,
    })));

    expect(model.recoverBinding).toHaveBeenCalledTimes(2);
  });

  it('matches bridge messages by iframe when same-origin tabs share one session channel', async () => {
    const sharedTabs = tabs.map((tab) => ({ ...tab, channel: 'shared' }));
    const model = browser({ tabs: sharedTabs });
    await render(model);
    await render({ ...model, activeId: 'b' });
    const frame = document.querySelector('iframe[data-tab-id="b"]');

    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: { source: 'handmux-browser', channel: 'shared', type: 'title', url: 'https://b.example/next', title: 'Beta Next' },
    })));

    expect(model.updateTabMeta).toHaveBeenCalledWith('b', { url: 'https://b.example/next', title: 'Beta Next' });
  });

  it('lets page-driven cross-origin navigation finish natively without replaying it', async () => {
    const model = browser();
    await render(model);
    const frame = document.querySelector('iframe[data-tab-id="a"]');

    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: { source: 'handmux-browser', channel: 'ca', type: 'navigate', url: 'https://other.example/path', title: '' },
    })));

    expect(model.navigateTab).not.toHaveBeenCalled();
    expect(model.updateTabMeta).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: { source: 'handmux-browser', channel: 'ca', type: 'load', url: 'https://other.example/path', title: 'Other' },
    })));

    expect(model.navigateTab).not.toHaveBeenCalled();
    expect(model.updateTabMeta).toHaveBeenCalledWith('a', {
      url: 'https://other.example/path',
      title: 'Other',
    });
  });

  it('does not intercept page-driven form navigation through the parent API', async () => {
    const model = browser();
    await render(model);
    const frame = document.querySelector('iframe[data-tab-id="a"]');
    const postMessage = vi.spyOn(frame.contentWindow, 'postMessage');

    act(() => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: {
        source: 'handmux-browser', channel: 'ca', type: 'prepare-form-navigation',
        url: 'https://sso.example/login', requestId: 'request-1',
      },
    })));

    expect(model.prepareFormNavigation).not.toHaveBeenCalled();
    expect(model.navigateTab).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('shows site Cookie cleanup only in a proxied webpage menu', async () => {
    const model = browser({
      persistProxyLogin: false,
      proxyLoginRetentionDays: 30,
    });
    await render(model);
    expect(document.querySelectorAll('.browser-nav > button')).toHaveLength(3);
    const menuButton = document.querySelector('button[aria-label="网页预览器菜单"]');
    expect(menuButton.querySelector('svg')).not.toBeNull();
    expect(menuButton.textContent).toBe('');
    click(menuButton);
    let card = document.querySelector('.browser-options-card');
    expect(card).not.toBeNull();
    expect(card.textContent).not.toContain('连接方式');
    expect(card.textContent).not.toContain('当前网页');
    expect(card.textContent).toContain('页面宽度');
    expect(card.textContent).toContain('向网站请求');
    expect(card.textContent).toContain('后台页签关闭');
    expect(card.textContent).toContain('清理本站代理 Cookie');
    const external = card.querySelector('.browser-open-external');
    expect(external.textContent).toBe('用系统浏览器打开');
    expect(external.getAttribute('href')).toBe('https://a.example/');
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toContain('noopener');
    expect(external.getAttribute('rel')).toContain('noreferrer');
    expect(card.textContent).not.toContain('清理全部代理 Cookie');
    expect(card.textContent).not.toContain('代理登录持久化');
    expect(card.textContent).not.toContain('关闭网页预览器');
    const cookieRow = card.querySelector('.browser-site-cookie-row');
    expect(cookieRow).not.toBeNull();
    expect(cookieRow.querySelector('strong')).toBeNull();
    expect(cookieRow.querySelector('.settings-close').textContent).toBe('?');
    expect([...cookieRow.querySelectorAll('button')].map((node) => node.textContent)).toEqual([
      '清理本站代理 Cookie', '?',
    ]);

    const modeButtons = [...document.querySelectorAll('.browser-mode-menu button')];
    expect(modeButtons.map((node) => node.textContent)).toEqual(['直连', '代理', '静态']);
    const segmentRule = styles.match(/\n\.browser-mode-option\s*\{([^}]*)\}/)?.[1] || '';
    expect(segmentRule).toMatch(/min-height:\s*44px/);
    selectMode(0);
    expect(model.navigateTab).toHaveBeenCalledWith('a', 'https://a.example/', 'direct');
    click(document.querySelector('button[aria-label="网页预览器菜单"]'));
    card = document.querySelector('.browser-options-card');
    expect(card).not.toBeNull();

    const widthButtons = [...card.querySelectorAll('.browser-width-row button')];
    expect(widthButtons.map((node) => node.textContent)).toEqual(['窄屏', '宽屏']);
    const navigationCount = model.navigateTab.mock.calls.length;
    click(widthButtons[1]);
    expect(widthButtons[1].getAttribute('aria-pressed')).toBe('true');
    expect(model.navigateTab).toHaveBeenCalledTimes(navigationCount);
    const siteVersionButtons = [...card.querySelectorAll('.browser-site-version-row button')];
    expect(siteVersionButtons.map((node) => node.textContent)).toEqual(['手机版', '电脑版']);
    await clickAndFlush(siteVersionButtons[1]);
    expect(model.navigateTab).toHaveBeenCalledWith('a', 'https://a.example/', 'proxy', 'desktop');

    click(card.querySelector('.browser-close-trigger'));
    const closeChoices = [...card.querySelectorAll('.browser-time-option')];
    expect(closeChoices.map((node) => node.textContent)).toEqual(['10 分钟', '30 分钟', '60 分钟', '120 分钟']);
    click(closeChoices[1]);
    expect(model.setCloseAfter).toHaveBeenCalledWith(30);

    click(card.querySelector('.browser-title-help'));
    expect(document.querySelector('.browser-profile-confirm').textContent).toContain('手机直连 Cookie 不受影响');
    click(document.querySelector('.browser-profile-confirm button'));
    click([...card.querySelectorAll('button')].find((node) => node.textContent === '清理本站代理 Cookie'));
    expect(document.querySelector('.browser-profile-confirm').textContent).toContain('父域 Cookie');
    click([...document.querySelectorAll('.browser-profile-confirm button')]
      .find((node) => node.textContent === '确认'));
    expect(model.clearProxyLogin).toHaveBeenCalledWith('https://a.example');
  });

  it('keeps proxy persistence and clear-all controls only in the Home menu', async () => {
    const model = browser({
      historyActive: true,
      activeId: null,
      persistProxyLogin: false,
      proxyLoginRetentionDays: 30,
    });
    await render(model);
    click(document.querySelector('button[aria-label="网页预览器菜单"]'));
    const card = document.querySelector('.browser-options-card');

    expect(card.textContent).toContain('在电脑上持久化保存代理 Cookie');
    expect(card.textContent).toContain('清理全部代理 Cookie');
    expect(card.textContent).toContain('关于网页预览器');
    expect(card.textContent).not.toContain('清理本站代理 Cookie');
    expect(card.textContent).not.toContain('关闭网页预览器');

    click([...card.querySelectorAll('button')].find((node) => node.textContent === '关于网页预览器'));
    const about = document.querySelector('.browser-profile-confirm');
    expect(about.querySelector('h2').textContent).toBe('网页预览器');
    expect(about.textContent).toContain('不是真正的浏览器');
    expect(about.textContent).toContain('手机直连');
    expect(about.textContent).toContain('经电脑代理');
    expect(about.textContent).toContain('按当前设备隔离');
    expect([...about.querySelectorAll('button')].map((node) => node.textContent)).toEqual(['好的']);
    click(about.querySelector('button'));

    const persistence = card.querySelector('.browser-profile-persist');
    expect(persistence).not.toBeNull();
    expect(persistence.textContent).toContain('在电脑上持久化保存代理 Cookie');
    const persistenceTitle = persistence.querySelector('.browser-options-title');
    expect(persistenceTitle.querySelector('strong').textContent).toBe('在电脑上持久化保存代理 Cookie');
    expect(persistenceTitle.querySelector('.settings-close').textContent).toBe('?');
    expect(persistenceTitle.querySelector('.settings-close').parentElement).toBe(persistenceTitle);
    expect(card.querySelector('.browser-retention')).toBeNull();
    expect(card.querySelector('.browser-profile-retention-trigger')).toBeNull();
    click(persistence.querySelector('input'));
    expect(model.setProxyLoginPolicy).toHaveBeenCalledWith({ persist: true, retentionDays: null });

    click(card.querySelector('.browser-title-help'));
    expect(document.querySelector('.browser-profile-confirm p').textContent).toBe(
      '是否将代理 Cookie 加密保存在运行 Handmux 的电脑上，以便重启后保持登录状态。',
    );
    click(document.querySelector('.browser-profile-confirm button'));

    click([...card.querySelectorAll('button')].find((node) => node.textContent === '清理全部代理 Cookie'));
    expect(document.querySelector('.browser-profile-confirm').textContent).toContain('当前设备');
    click([...document.querySelectorAll('.browser-profile-confirm button')]
      .find((node) => node.textContent === '确认'));
    expect(model.clearProxyLogin).toHaveBeenCalledWith(null);
  });

  it('stops persistent proxy Cookie storage immediately without confirmation', async () => {
    const model = browser({
      historyActive: true,
      activeId: null,
      persistProxyLogin: true,
      proxyLoginRetentionDays: null,
    });
    await render(model);
    click(document.querySelector('button[aria-label="网页预览器菜单"]'));
    click(document.querySelector('.browser-profile-persist input'));

    expect(model.setProxyLoginPolicy).toHaveBeenCalledWith({ persist: false, retentionDays: null });
    expect(document.querySelector('.browser-profile-confirm')).toBeNull();
  });

  it('lets a new page choose its connection mode before opening the address', async () => {
    const model = browser({ historyActive: true });
    await render(model);
    click(document.querySelector('button[aria-label="网页预览器菜单"]'));

    const modeButtons = [...document.querySelectorAll('.browser-mode-menu button')];
    expect(modeButtons.map((node) => node.disabled)).toEqual([false, false, false]);
    expect(modeButtons.map((node) => node.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(document.querySelector('.browser-address-mode')).toBeNull();
    selectMode(1);
    expect(modeButtons.map((node) => node.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(document.querySelector('.browser-address-mode')).toBeNull();

    setInput(document.querySelector('.browser-address'), 'https://portal.example/');
    submit(document.querySelector('.browser-address-form'));
    expect(model.openUrl).toHaveBeenCalledWith('https://portal.example/', { mode: 'proxy' });
    expect(model.navigateTab).not.toHaveBeenCalled();
  });
});
