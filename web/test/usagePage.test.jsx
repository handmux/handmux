import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import fs from 'node:fs';

vi.mock('../src/api.js', () => ({
  getAgentUsage: vi.fn(),
  getApiAccounts: vi.fn(),
  createApiAccount: vi.fn(),
  patchApiAccount: vi.fn(),
  deleteApiAccount: vi.fn(),
  queryApiAccount: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(status, code) { super(code); this.status = status; this.code = code; }
  },
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import UsagePage, {
  apiAccountSaveErrorText, isApiAccountNameValid, isApiCredentialContextSafe,
  parseApiAccounts, parseUsageSnapshot,
} from '../src/components/UsagePage.jsx';
import {
  ApiError, createApiAccount, deleteApiAccount, getAgentUsage, getApiAccounts, patchApiAccount,
  queryApiAccount, UnauthorizedError,
} from '../src/api.js';
import { AgentCatalogProvider } from '../src/agentCatalog.js';
import { OverlayProvider } from '../src/overlays/OverlayHost.js';

let container, root;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem('tw_agent_usage_enabled_v1');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const render = ({ catalogDescriptors = [], catalogLoaded = false, keyboardInset = 0, ...props } = {}) => act(async () => root.render(
  <OverlayProvider host={container} keyboardInset={keyboardInset}>
    <AgentCatalogProvider descriptors={catalogDescriptors} loaded={catalogLoaded}>
      <UsagePage open onClose={() => {}} onAuthFail={() => {}} {...props} />
    </AgentCatalogProvider>
  </OverlayProvider>,
));
const settle = async () => { await act(async () => {}); await act(async () => {}); };

describe('UsagePage', () => {
  it('uses the shared vector menu icon instead of raw ellipsis glyphs', () => {
    const source = fs.readFileSync('src/components/UsagePage.tsx', 'utf8');
    expect(source).toContain('<MoreHorizontalIcon />');
    expect(source).not.toMatch(/>\s*…\s*</);
  });

  it('keeps keyboard-aware centered forms and scoped 44px close targets in the CSS contract', () => {
    const styles = fs.readFileSync('src/styles.css', 'utf8');
    const formRule = styles.match(/\.api-account-form\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(formRule).toContain('var(--overlay-keyboard-inset');
    expect(formRule).toContain('var(--overlay-keyboard-center-shift');
    expect(formRule).toContain('max-height:');
    const closeRule = styles.match(/\.usage-card \.settings-close, \.api-account-form \.settings-close\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(closeRule).toContain('width: 44px');
    expect(closeRule).toContain('height: 44px');
    const actionsRule = styles.match(/\.api-form-actions\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(actionsRule).toContain('flex: none');
    const menuTriggerRule = styles.match(/\.api-balance-menu, \.usage-agent-menu\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(menuTriggerRule).toContain('width: 44px');
    expect(menuTriggerRule).toContain('height: 44px');
    const apiAddRule = styles.match(/\.api-balance-add-row\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(apiAddRule).toContain('width: 100%');
    expect(apiAddRule).toContain('min-height: 50px');
    expect(apiAddRule).toContain('border: 0');
    expect(apiAddRule).not.toMatch(/gradient|box-shadow/);
    const apiCardRule = styles.match(/\.api-balance-card\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(apiCardRule).not.toContain('position: relative');
    expect(menuTriggerRule).not.toMatch(/position:|right:|top:|z-index:/);
    const menuIconRule = styles.match(/\.api-balance-menu svg, \.usage-agent-menu svg\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(menuIconRule).toContain('width: 20px');
    expect(menuIconRule).toContain('height: 20px');
    expect(styles).toMatch(/\.usage-agent-menu\s*\{[^}]*grid-column:\s*4/);
    const popoverRule = styles.match(/\.usage-action-popover\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(popoverRule).toContain('position: fixed');
    expect(popoverRule).toContain('max-width:');
    const actionIconRule = styles.match(/\.usage-popover-icon svg\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(actionIconRule).toContain('width: 18px');
    expect(actionIconRule).toContain('height: 18px');
    const apiPrimaryRule = styles.match(/\.api-balance-primary-row\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(apiPrimaryRule).toContain('minmax(0, 1fr) minmax(96px, auto) 44px');
    expect(apiPrimaryRule).not.toContain('padding-right');
    const apiEmptyRule = styles.match(/\.api-balance-empty\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(apiEmptyRule).not.toContain('min-height');
    const secondaryDetailsRule = styles.match(/\.api-balance-secondary > \.api-balance-details\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(secondaryDetailsRule).toContain('grid-column: 1 / -1');
    const modelLimitsRule = styles.match(/\.usage-model-limits\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(modelLimitsRule).toContain('border-top:');
    expect(modelLimitsRule).not.toMatch(/border-radius:|background:|box-shadow:/);
    const modelContentRule = styles.match(/\.usage-model-limits-content\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(modelContentRule).toContain('background: transparent');
    expect(styles).toMatch(/prefers-reduced-motion:[^)]+\)[\s\S]*\.api-balance-skeleton i\s*\{ animation: none;/);
  });

  it('mounts fixed Claude and Codex cards immediately and loads inside each card', async () => {
    let resolveUsage;
    getAgentUsage.mockImplementation(() => new Promise((resolve) => { resolveUsage = resolve; }));
    await render();
    expect([...container.querySelectorAll('[data-usage-agent]')]
      .map((card) => card.getAttribute('data-usage-agent'))).toEqual(['claude', 'codex']);
    expect(container.querySelectorAll('.usage-agent-skeleton')).toHaveLength(2);
    expect(container.querySelectorAll('.usage-agent-menu')).toHaveLength(2);
    expect([...container.querySelectorAll('.usage-agent-menu')].every((button) => button.disabled)).toBe(true);
    expect([...container.querySelectorAll('.usage-agent-menu')]
      .every((button) => button.textContent === '' && button.querySelector('svg'))).toBe(true);
    expect(container.querySelector('.usage-agent-menu .api-balance-spinner')).toBeNull();
    expect(container.querySelector('[data-usage-agent="claude"] .usage-agent-menu')
      ?.getAttribute('aria-label')).toMatch(/Claude Code.*(?:Usage options|用量选项)/i);
    expect(container.querySelector('[data-usage-agent="codex"] .usage-agent-menu')
      ?.getAttribute('aria-label')).toMatch(/Codex.*(?:Usage options|用量选项)/i);

    await act(async () => resolveUsage({ agents: [{
      agentId: 'codex', label: 'Codex CLI', status: 'pending', groups: [],
    }] }));
    await settle();
    expect(container.querySelectorAll('.usage-agent-skeleton')).toHaveLength(0);
    expect([...container.querySelectorAll('.usage-agent-menu')].every((button) => !button.disabled)).toBe(true);
    expect(container.querySelector('[data-usage-agent="claude"]')).not.toBeNull();
    expect(container.querySelector('[data-usage-agent="codex"]')?.textContent).toMatch(/message|消息/);
  });

  it('keeps the subscription menu in its trailing grid column without hook usage timestamps', async () => {
    getAgentUsage.mockResolvedValue({ agents: [{
      agentId: 'claude', label: 'Claude Code', status: 'setup_required', groups: [],
    }] });
    await render(); await settle();

    const head = container.querySelector('[data-usage-agent="claude"] .usage-agent-head');
    expect(head?.querySelector('.usage-updated')).toBeNull();
    expect(head?.querySelector('.usage-agent-menu')).not.toBeNull();
  });

  it('persists each fixed provider display toggle and leaves only its title row when hidden', async () => {
    getAgentUsage.mockResolvedValue({ agents: [{
      agentId: 'claude', label: 'Claude Code', status: 'ready', groups: [{
        kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 12 }],
      }],
    }, {
      agentId: 'codex', label: 'Codex CLI', status: 'ready', groups: [{
        kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 22 }],
      }],
    }] });
    await render(); await settle();
    const claude = container.querySelector('[data-usage-agent="claude"]');
    const codex = container.querySelector('[data-usage-agent="codex"]');
    await act(async () => claude.querySelector('.usage-agent-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const hide = [...container.querySelectorAll('.sheet-action')]
      .find((button) => /Hide usage|关闭用量显示/.test(button.textContent));
    await act(async () => hide.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(claude.classList.contains('usage-agent-collapsed')).toBe(true);
    expect(claude.children).toHaveLength(1);
    expect(claude.querySelector('.usage-agent-head')?.textContent).toContain('Claude Code');
    expect(codex.querySelector('.usage-bar-fill')?.style.width).toBe('22%');
    expect(JSON.parse(localStorage.getItem('tw_agent_usage_enabled_v1'))).toMatchObject({ claude: false });

    await act(async () => claude.querySelector('.usage-agent-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const show = [...container.querySelectorAll('.sheet-action')]
      .find((button) => /Show usage|开启用量显示/.test(button.textContent));
    expect(container.querySelectorAll('.sheet-action')).toHaveLength(1);
    expect([...container.querySelectorAll('.sheet-action')]
      .some((button) => /^(Refresh|刷新)$/.test(button.textContent))).toBe(false);
    await act(async () => show.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(claude.classList.contains('usage-agent-collapsed')).toBe(false);
    expect(claude.querySelector('.usage-bar-fill')?.style.width).toBe('12%');
    expect(JSON.parse(localStorage.getItem('tw_agent_usage_enabled_v1'))).toMatchObject({ claude: true });
  });

  it('shows subscription load failures inside both fixed cards', async () => {
    getAgentUsage.mockRejectedValue(new Error('offline'));
    await render(); await settle();
    expect(container.querySelectorAll('.usage-agent-error')).toHaveLength(2);
    expect([...container.querySelectorAll('.usage-agent-error')]
      .every((node) => /Failed to load usage|加载用量失败/.test(node.textContent))).toBe(true);
    expect(container.querySelector('.usage-sheet-content > .bind-error')).toBeNull();
  });

  it('keeps old cards but disables provider menus while a reopen full load is pending', async () => {
    getAgentUsage.mockResolvedValueOnce({ agents: [{
      agentId: 'codex', label: 'Codex CLI', status: 'ready', groups: [{
        kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 27 }],
      }],
    }] });
    await render(); await settle();
    await render({ open: false });
    let resolveReload;
    getAgentUsage.mockImplementationOnce(() => new Promise((resolve) => { resolveReload = resolve; }));
    await render();

    expect(container.querySelector('[data-usage-agent="codex"] .usage-bar-fill')?.style.width).toBe('27%');
    expect(container.querySelector('.usage-agent-skeleton')).toBeNull();
    expect([...container.querySelectorAll('.usage-agent-menu')].every((button) => button.disabled)).toBe(true);
    await act(async () => container.querySelector('[data-usage-agent="codex"] .usage-agent-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('.usage-nested-overlay')).toBeNull();
    expect(getAgentUsage).toHaveBeenCalledTimes(2);

    await act(async () => resolveReload({ agents: [{
      agentId: 'codex', label: 'Codex CLI', status: 'ready', groups: [{
        kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 31 }],
      }],
    }] }));
    await settle();
    expect([...container.querySelectorAll('.usage-agent-menu')].every((button) => !button.disabled)).toBe(true);
    expect(container.querySelector('[data-usage-agent="codex"] .usage-bar-fill')?.style.width).toBe('31%');
  });

  it('keeps old cards and shows a top-level error when a reopen full load fails', async () => {
    getAgentUsage.mockResolvedValueOnce({ agents: [{
      agentId: 'codex', label: 'Codex CLI', status: 'ready', groups: [{
        kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 19 }],
      }],
    }] });
    await render(); await settle();
    await render({ open: false });
    getAgentUsage.mockRejectedValueOnce(new Error('offline'));
    await render(); await settle();

    expect(container.querySelector('[data-usage-agent="codex"] .usage-bar-fill')?.style.width).toBe('19%');
    expect(container.querySelector('.usage-agent-skeleton')).toBeNull();
    expect(container.querySelector('.usage-load-error')?.textContent)
      .toMatch(/Failed to load usage|加载用量失败/);
    expect([...container.querySelectorAll('.usage-agent-menu')].every((button) => !button.disabled)).toBe(true);
  });

  it('puts per-provider refresh first in the card menu and refreshes only that card', async () => {
    let resolveRefresh;
    getAgentUsage
      .mockResolvedValueOnce({ agents: [{
        agentId: 'codex', label: 'Codex CLI', status: 'ready', groups: [{
          kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 12 }],
        }],
    }] })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    await render(); await settle();
    expect(container.querySelector('.usage-sheet-refresh')).toBeNull();
    expect(container.querySelector('[data-usage-agent="codex"] .usage-bar-fill')?.style.width).toBe('12%');

    await act(async () => container.querySelector('[data-usage-agent="codex"] .usage-agent-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const actions = [...container.querySelectorAll('.sheet-action')];
    expect(actions.map((button) => button.textContent)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^(Refresh|刷新)$/), expect.stringMatching(/Hide usage|关闭用量显示/),
    ]));
    expect(actions[0]?.textContent).toMatch(/^(Refresh|刷新)$/);
    await act(async () => actions[0].dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(getAgentUsage).toHaveBeenLastCalledWith(true, 'codex');
    const codexMenu = container.querySelector('[data-usage-agent="codex"] .usage-agent-menu');
    expect(codexMenu.disabled).toBe(false);
    expect(codexMenu.textContent).toBe('');
    expect(codexMenu.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('[data-usage-agent="codex"] .usage-refresh-status .api-balance-spinner')).not.toBeNull();
    expect(container.querySelector('[data-usage-agent="claude"] .usage-refresh-status')).toBeNull();
    expect(container.querySelector('[data-usage-agent="codex"] .usage-bar-fill')?.style.width).toBe('12%');
    expect(container.querySelector('.usage-agent-skeleton')).toBeNull();
    await act(async () => codexMenu.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('.sheet-action')?.disabled).toBe(true);
    expect([...container.querySelectorAll('.sheet-action')]
      .find((button) => /Hide usage|关闭用量显示/.test(button.textContent))?.disabled).toBe(false);

    await act(async () => resolveRefresh({ agents: [{
      agentId: 'codex', label: 'Codex CLI', status: 'ready', refreshStatus: 'fresh', groups: [{
        kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 34 }],
      }],
    }] }));
    await settle();
    expect(codexMenu.disabled).toBe(false);
    expect(container.querySelector('[data-usage-agent="codex"] .usage-refresh-status')).toBeNull();
    expect(container.querySelector('[data-usage-agent="codex"] .usage-bar-fill')?.style.width).toBe('34%');
  });

  it('keeps the last subscription snapshot visible when manual refresh fails', async () => {
    getAgentUsage
      .mockResolvedValueOnce({ agents: [{
        agentId: 'codex', label: 'Codex CLI', status: 'ready', groups: [{
          kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 18 }],
        }],
      }] })
      .mockResolvedValueOnce({ agents: [{
        agentId: 'codex', label: 'Codex CLI', status: 'ready', refreshStatus: 'stale', groups: [{
          kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 18 }],
        }],
    }] });
    await render(); await settle();
    await act(async () => container.querySelector('[data-usage-agent="codex"] .usage-agent-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const refresh = [...container.querySelectorAll('.sheet-action')]
      .find((button) => /^(Refresh|刷新)$/.test(button.textContent));
    await act(async () => refresh.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(getAgentUsage).toHaveBeenLastCalledWith(true, 'codex');
    expect(container.querySelector('[data-usage-agent="codex"] .usage-bar-fill')?.style.width).toBe('18%');
    expect(container.querySelector('[data-usage-agent="codex"] .usage-refresh-error')?.textContent)
      .toMatch(/could not be refreshed|无法刷新订阅用量/i);

    await act(async () => container.querySelector('[data-usage-agent="codex"] .usage-agent-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const hide = [...container.querySelectorAll('.sheet-action')]
      .find((button) => /Hide usage|关闭用量显示/.test(button.textContent));
    await act(async () => hide.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => container.querySelector('[data-usage-agent="codex"] .usage-agent-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => container.querySelector('.sheet-action')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('[data-usage-agent="codex"] .usage-refresh-error')).toBeNull();
  });

  it('uses browser Back to close only the nested usage menu', async () => {
    const onClose = vi.fn();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    try {
      getAgentUsage.mockResolvedValue({ agents: [] });
      await render({ onClose }); await settle();
      await act(async () => container.querySelector('[data-usage-agent="claude"] .usage-agent-menu')
        .dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(container.querySelector('[role="menu"]')).not.toBeNull();

      await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
      await settle();
      expect(container.querySelector('.settings-card.usage-card')).not.toBeNull();
      expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      back.mockRestore();
    }
  });

  it('routes Escape through Back and closes only the nested usage menu', async () => {
    const onClose = vi.fn();
    const back = vi.spyOn(window.history, 'back')
      .mockImplementationOnce(() => window.dispatchEvent(new PopStateEvent('popstate')))
      .mockImplementation(() => {});
    try {
      getAgentUsage.mockResolvedValue({ agents: [] });
      await render({ onClose }); await settle();
      await act(async () => container.querySelector('[data-usage-agent="codex"] .usage-agent-menu')
        .dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(container.querySelector('[role="menu"]')).not.toBeNull();

      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      })));
      await settle();
      expect(back).toHaveBeenCalled();
      expect(container.querySelector('.settings-card.usage-card')).not.toBeNull();
      expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      back.mockRestore();
    }
  });

  it('anchors the compact menu inside the viewport and supports focus, keys, outside tap, and scrolled anchors', async () => {
    getAgentUsage.mockResolvedValue({ agents: [] });
    await render(); await settle();
    const trigger = container.querySelector('[data-usage-agent="codex"] .usage-agent-menu');
    const rect = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 272, right: 316, top: 420, bottom: 464, width: 44, height: 44,
      x: 272, y: 420, toJSON: () => ({}),
    });
    const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    const innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const innerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    try {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 210 });
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 98 });
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 480 });

      await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await settle();
      const menu = container.querySelector('[role="menu"]');
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      expect(menu.style.left).toBe('102px');
      expect(menu.style.top).toBe('316px');
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.querySelector('.usage-popover-icon svg'))).toBe(true);
      expect(document.activeElement).toBe(items[0]);
      expect(items.map((item) => item.tabIndex)).toEqual([0, -1]);
      await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
      expect(document.activeElement).toBe(items[1]);
      expect(items.map((item) => item.tabIndex)).toEqual([-1, 0]);
      await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
      expect(document.activeElement).toBe(items[0]);
      expect(items.map((item) => item.tabIndex)).toEqual([0, -1]);

      const backdrop = container.querySelector('.usage-menu-backdrop');
      await act(async () => backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
      expect(container.querySelector('[role="menu"]')).not.toBeNull();
      await act(async () => backdrop.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })));
      await act(async () => backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);

      await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await act(async () => container.querySelector('[role="menu"]')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);

      await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await act(async () => container.querySelector('[role="menu"]')
        .dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
        })));
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);

      await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      rect.mockReturnValue({
        left: 272, right: 316, top: -100, bottom: -56, width: 44, height: 44,
        x: 272, y: -100, toJSON: () => ({}),
      });
      await act(async () => window.dispatchEvent(new Event('scroll')));
      expect(container.querySelector('[role="menu"]')).toBeNull();
    } finally {
      rect.mockRestore();
      if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDescriptor);
      else delete HTMLElement.prototype.offsetWidth;
      if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', heightDescriptor);
      else delete HTMLElement.prototype.offsetHeight;
      if (innerWidthDescriptor) Object.defineProperty(window, 'innerWidth', innerWidthDescriptor);
      else delete window.innerWidth;
      if (innerHeightDescriptor) Object.defineProperty(window, 'innerHeight', innerHeightDescriptor);
      else delete window.innerHeight;
    }
  });

  it('validates and clamps usage snapshots at the API boundary', () => {
    expect(parseUsageSnapshot({
      agents: [{
        agentId: 'codex', label: 'Codex CLI', status: 'ready',
        account: { label: 'dev@example.com', plan: 42 },
        groups: [{ kind: 'account', id: 'account', windows: [
          { id: 'primary', usedPercent: -5, windowMinutes: '300' },
        ] }, { kind: 'model', id: 'spark', label: 'Spark', windows: [
          { id: 'primary', usedPercent: 140 },
        ] }],
        resetCredits: { availableCount: -1 },
      }],
    })).toEqual({
      agents: [{
        agentId: 'codex', label: 'Codex CLI', account: { label: 'dev@example.com' }, status: 'ready',
        groups: [{ kind: 'account', id: 'account', windows: [
          { id: 'primary', usedPercent: 0 },
        ] }, { kind: 'model', id: 'spark', label: 'Spark', windows: [
          { id: 'primary', usedPercent: 100 },
        ] }],
      }],
    });
    expect(parseUsageSnapshot([])).toBeNull();
  });

  it('renders a Codex quota bar with percent + a freshness stamp', async () => {
    getAgentUsage.mockResolvedValue({
      agents: [{ agentId: 'codex', label: 'Codex CLI', status: 'ready', updatedAt: Date.now() - 5 * 60 * 1000,
        groups: [{ kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 16, windowMinutes: 43200, resetsAt: 9999999999 }] }] }],
    });
    await render();
    await settle();
    expect(container.textContent).toContain('Codex CLI');
    expect(container.textContent).toContain('16%');
    expect(container.querySelector('.usage-bar-fill').style.width).toBe('16%');
    expect(container.querySelector('.usage-updated').textContent).toMatch(/5m ago|5 分钟/); // freshness
    expect(container.textContent).not.toMatch(/token/i); // no misleading session-token line
    expect(container.querySelector('.usage-head-note')).toBeNull();
  });

  it('uses the catalog identity when an agent id maps to a different bundled icon', async () => {
    getAgentUsage.mockResolvedValue({
      agents: [{
        agentId: 'internal-agent', label: 'Snapshot Agent', iconId: 'claude',
        status: 'ready', groups: [],
      }],
    });
    await render({
      catalogLoaded: true,
      catalogDescriptors: [{
        id: 'internal-agent', label: 'Catalog Agent', iconId: 'codex',
        capabilities: {
          inbox: false, conversation: false, interaction: false, subscriptionUsage: true,
        },
      }],
    });
    await settle();
    expect(container.querySelector('[data-agent-icon="codex"]')?.getAttribute('aria-label'))
      .toBe('Catalog Agent');
    const card = container.querySelector('[data-usage-agent="internal-agent"]');
    expect(card?.querySelector('.usage-agent-head')?.textContent).toContain('Catalog Agent');
    expect(card?.querySelector('.usage-agent-head')?.textContent).not.toContain('Snapshot Agent');
  });

  it('keeps a generic mark and snapshot label fallback for an unknown agent', async () => {
    getAgentUsage.mockResolvedValue({
      agents: [{
        agentId: 'third-party', label: 'Snapshot Third Party', iconId: 'codex',
        status: 'ready', groups: [],
      }],
    });
    await render({ catalogLoaded: true });
    await settle();
    const card = container.querySelector('[data-usage-agent="third-party"]');
    expect(card?.querySelector('[data-agent-icon="generic"]')?.getAttribute('aria-label'))
      .toBe('third-party');
    expect(card?.querySelector('.usage-agent-head')?.textContent).toContain('Snapshot Third Party');
  });

  it('shows the remaining Codex rate-limit resets, including zero', async () => {
    getAgentUsage.mockResolvedValue({
      agents: [{ agentId: 'codex', label: 'Codex CLI', status: 'ready', groups: [],
        resetCredits: { availableCount: 0 } }],
    });
    await render();
    await settle();
    expect(container.querySelector('.usage-reset-credits')?.textContent).toMatch(/0 (available|次)/);
    expect(container.querySelector('[data-usage-agent="codex"] .usage-empty')).toBeNull();
  });

  it('shows each reset-credit expiry separately when the server provides it', async () => {
    getAgentUsage.mockResolvedValue({
      agents: [{ agentId: 'codex', label: 'Codex CLI', status: 'pending', groups: [], resetCredits: {
          availableCount: 3,
          expiryTimes: [1785259000, Number.MAX_VALUE, 1785558000],
      } }],
    });
    await render();
    await settle();
    const row = container.querySelector('.usage-reset-credits');
    expect(row?.textContent).toMatch(/3 (available|次)/);
    const expiries = [...row.querySelectorAll('small')].map((node) => node.textContent);
    expect(expiries).toHaveLength(2);
    expect(expiries[0]).toMatch(/2026/);
    expect(expiries[1]).toMatch(/2026/);
  });

  it('keeps model-specific Codex quotas collapsed until requested', async () => {
    getAgentUsage.mockResolvedValue({
      agents: [{ agentId: 'codex', label: 'Codex CLI', status: 'ready',
        account: { label: 'dev@example.com', plan: 'Pro' },
        groups: [{ kind: 'account', id: 'account', windows: [
          { id: 'primary', usedPercent: 9, windowMinutes: 10080 },
        ] }, { kind: 'model', id: 'codex_bengalfox', label: 'GPT-5.3-Codex-Spark', windows: [
          { id: 'primary', usedPercent: 3, windowMinutes: 300 },
          { id: 'secondary', usedPercent: 11, windowMinutes: 10080 },
        ] }, { kind: 'model', id: 'codex_extremely_long_model_identifier_without_breaks_1234567890', windows: [
          { id: 'primary', usedPercent: 22, windowMinutes: 300 },
        ] }], resetCredits: { availableCount: 1 } }],
    });
    await render();
    await settle();

    expect(container.querySelector('.usage-account')?.textContent).toContain('dev@example.com');
    expect(container.querySelector('.usage-account')?.textContent).toContain('Pro');
    expect(container.textContent).toMatch(/Account limits|账号额度/);
    const trigger = container.querySelector('.usage-model-limits-trigger');
    expect(trigger?.textContent).toMatch(/Model-specific limits|特定模型/);
    expect(trigger?.textContent).toContain('2');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.getAttribute('aria-controls')).toBe('usage-model-limits-codex');
    expect(trigger?.closest('.usage-model-limits')).not.toBeNull();
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    const modelContent = container.querySelector('.usage-model-limits-content');
    expect(modelContent?.hidden).toBe(true);
    expect(modelContent?.textContent).toContain('GPT-5.3-Codex-Spark');
    expect(modelContent?.textContent).toContain('codex_extremely_long_model_identifier_without_breaks_1234567890');
    expect(modelContent?.querySelectorAll(':scope > .usage-quota-group')).toHaveLength(2);
    expect([...container.querySelectorAll('.usage-agent > .usage-agent-body > .usage-quota-group .usage-bar-fill')]
      .map((bar) => bar.style.width))
      .toEqual(['9%']);

    await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(modelContent?.hidden).toBe(false);
    expect(modelContent?.id).toBe('usage-model-limits-codex');
    expect(modelContent?.parentElement).toBe(trigger.parentElement);
    expect(modelContent?.querySelectorAll('.usage-quota-group')).toHaveLength(2);
    expect(container.textContent).toContain('GPT-5.3-Codex-Spark');
    expect([...container.querySelectorAll('.usage-bar-fill')].map((bar) => bar.style.width))
      .toEqual(['9%', '3%', '11%', '22%']);

    await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(modelContent?.hidden).toBe(true);
  });

  it('shows the enable hint when the Claude capturer is not wired', async () => {
    getAgentUsage.mockResolvedValue({ agents: [{ agentId: 'claude', label: 'Claude Code', groups: [],
      status: 'setup_required', setupCommand: 'handmux agent enable claude' }] });
    await render();
    await settle();
    expect(container.textContent).toContain('Claude Code');
    expect(container.textContent).toContain('handmux agent enable claude');
  });

  it('keeps the Codex card visible when no machine-wide quota is available yet', async () => {
    getAgentUsage.mockResolvedValue({ agents: [{ agentId: 'codex', label: 'Codex CLI', groups: [], status: 'unavailable' }] });
    await render();
    await settle();
    expect(container.textContent).toContain('Codex CLI');
    expect(container.textContent).toMatch(/not detected|未检测到/);
    expect(container.querySelector('.usage-model-limits-trigger')).toBeNull();
  });

  it('renders Claude 5h + weekly bars when present', async () => {
    getAgentUsage.mockResolvedValue({
      agents: [{ agentId: 'claude', label: 'Claude Code', status: 'ready', groups: [{
        kind: 'account', id: 'account', windows: [
          { id: 'five-hour', usedPercent: 43, windowMinutes: 300, resetsAt: 9999999999 },
          { id: 'weekly', usedPercent: 15, windowMinutes: 10080, resetsAt: 9999999999 },
        ],
      }] }],
    });
    await render();
    await settle();
    const bars = [...container.querySelectorAll('.usage-bar-fill')];
    expect(bars.map((b) => b.style.width)).toEqual(['43%', '15%']);
  });

  it('shows the pending note when Claude is wired but has no rate_limits yet', async () => {
    getAgentUsage.mockResolvedValue({ agents: [{ agentId: 'claude', label: 'Claude Code', groups: [], status: 'pending' }] });
    await render();
    await settle();
    expect(container.querySelector('.usage-bar-fill')).toBeNull();
    expect(container.textContent).toMatch(/message|消息/); // "send a message…" pending copy
  });

  it('calls onAuthFail on a 401', async () => {
    getAgentUsage.mockRejectedValue(new UnauthorizedError());
    const onAuthFail = vi.fn();
    await render({ onAuthFail });
    await settle();
    expect(onAuthFail).toHaveBeenCalled();
  });

  it('validates API account views without accepting credential-shaped fields', () => {
    const view = {
      id: 'account-1', name: 'Production', providerType: 'deepseek', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: 1, lastAttemptAt: 1, lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [{
        currency: 'CNY', totalBalance: '110.00', toppedUpBalance: '100.00', grantedBalance: '10.00',
      }] },
    };
    expect(parseApiAccounts([view])).toEqual([view]);
    expect(parseApiAccounts([{ ...view, credentialConfigured: false }])).toBeNull();
  });

  it('accepts the explicit Kimi result union only for its matching provider', () => {
    const common = {
      id: 'account-provider', credentialConfigured: true, createdAt: 1, updatedAt: 1,
      lastSuccessAt: 1, lastAttemptAt: 1, lastErrorCode: null,
    };
    const moonshot = {
      ...common, id: 'account-kimi', name: 'Kimi', providerType: 'moonshot', latestSuccess: {
        providerType: 'moonshot', currency: 'CNY',
        availableBalance: 0.1234567, voucherBalance: 4, cashBalance: -1,
      },
    };
    expect(parseApiAccounts([moonshot])).toEqual([moonshot]);
    expect(parseApiAccounts([{ ...moonshot, providerType: 'deepseek' }])).toBeNull();
  });

  it('keeps subscriptions as the default tab and loads official DeepSeek balances only after switching', async () => {
    const account = {
      id: 'account-1', name: 'Production', providerType: 'deepseek', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: Date.now(), lastAttemptAt: Date.now(), lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [{
        currency: 'CNY', totalBalance: '110.00', toppedUpBalance: '100.00', grantedBalance: '10.00',
      }] },
    };
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([account]);
    await render(); await settle();
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(getApiAccounts).not.toHaveBeenCalled();
    await act(async () => tabs[1].dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(getApiAccounts).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.api-balance-card')?.textContent).toContain('Production');
    expect(container.querySelector('.api-balance-card')?.textContent).toContain('110.00');
    expect(queryApiAccount).not.toHaveBeenCalled();
  });

  it('uses one centered settings dialog with a full-width add action at the bottom of the API tab', async () => {
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([]);
    await render(); await settle();
    expect(container.querySelector('.settings-card.usage-card')).not.toBeNull();
    expect(container.querySelector('.file-sheet.usage-sheet')).toBeNull();
    expect(container.querySelector('.settings-backdrop.usage-backdrop')).not.toBeNull();
    expect(container.querySelector('.api-balance-add-row')).toBeNull();
    await act(async () => [...container.querySelectorAll('[role="tab"]')][1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    const add = container.querySelector('.api-balance-add-row');
    expect(add).not.toBeNull();
    expect(add?.textContent).toMatch(/Add API account|添加 API 账户/);
    expect(add?.nextElementSibling?.classList.contains('api-balance-storage-note')).toBe(true);
    expect(container.querySelector('.api-balance-toolbar')).toBeNull();
  });

  it('renders all provider balances in compact horizontal rows without nested metric cards', async () => {
    const common = {
      credentialConfigured: true, createdAt: 1, updatedAt: 1,
      lastSuccessAt: Date.now(), lastAttemptAt: Date.now(), lastErrorCode: null,
    };
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([{
      ...common, id: 'deep', name: 'A very long production DeepSeek account name', providerType: 'deepseek',
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [{
        currency: 'CNY', totalBalance: '110.00', toppedUpBalance: '100.00', grantedBalance: '10.00',
      }, { currency: 'USD', totalBalance: '2.00', toppedUpBalance: '1.00', grantedBalance: '1.00' }] },
    }, {
      ...common, id: 'kimi', name: 'Kimi', providerType: 'moonshot',
      latestSuccess: { providerType: 'moonshot', currency: 'CNY', availableBalance: 3, voucherBalance: 4, cashBalance: -1 },
    }]);
    await render(); await settle();
    await act(async () => [...container.querySelectorAll('[role="tab"]')][1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    const cards = [...container.querySelectorAll('.api-balance-card')];
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.api-balance-menu')?.textContent).toBe('');
    expect(cards[0].querySelector('.api-balance-menu svg')).not.toBeNull();
    expect(cards[0].querySelector(':scope > .api-balance-menu')).toBeNull();
    expect(cards[0].querySelector('.api-balance-primary-row > .api-balance-menu')).not.toBeNull();
    expect(cards[0].querySelector('.api-balance-menu')?.getAttribute('aria-label'))
      .toMatch(/A very long production DeepSeek account name.*DeepSeek/);
    for (const card of cards) {
      expect(card.querySelector('.api-balance-primary-row')).not.toBeNull();
      expect(card.querySelector('.api-balance-secondary')).not.toBeNull();
      expect(card.querySelector('.api-balance-secondary > .api-balance-provider')).not.toBeNull();
      expect(card.querySelector('.api-balance-secondary > .api-balance-details')).not.toBeNull();
    }
    const compactUpdated = cards[0].querySelector('.api-balance-update-slot .usage-updated');
    expect(compactUpdated?.textContent).toMatch(/^(now|现在)$/);
    expect(compactUpdated?.getAttribute('aria-label')).toMatch(/updated just now|刚刚更新/);
    expect(compactUpdated?.getAttribute('title')).toBe(compactUpdated?.getAttribute('aria-label'));
    expect(cards[0].querySelectorAll('.api-balance-extra')).toHaveLength(1);
    expect(cards[1].querySelector('.api-balance-details')?.textContent).toContain('-1');
    expect(container.querySelector('.api-balance-currency')).toBeNull();
  });

  it('keeps DeepSeek empty successful balances distinct from the not-queried state', async () => {
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([{
      id: 'deep-empty', name: 'Empty response', providerType: 'deepseek', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: Date.now(), lastAttemptAt: Date.now(), lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [] },
    }]);
    await render(); await settle();
    await act(async () => [...container.querySelectorAll('[role="tab"]')][1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    const card = container.querySelector('.api-balance-card');
    expect(card?.querySelector('.api-balance-not-queried')).toBeNull();
    expect(card?.querySelector('.api-balance-primary')?.textContent).toMatch(/暂无余额数据|No balance data/);
    expect(card?.querySelector('.api-balance-primary')?.textContent).toContain('—');
    expect(card?.querySelector('.api-balance-status.available')).not.toBeNull();
    expect(card?.querySelector('.usage-updated')).not.toBeNull();
  });

  it('shows card-sized skeletons during the first API account load', async () => {
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockReturnValue(new Promise(() => {}));
    await render(); await settle();
    await act(async () => [...container.querySelectorAll('[role="tab"]')][1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(container.querySelectorAll('.api-balance-skeleton')).toHaveLength(2);
    expect(container.querySelector('.api-balance-skeletons')?.getAttribute('role')).toBe('status');
    for (const skeleton of container.querySelectorAll('.api-balance-skeleton')) {
      const menuPlaceholder = skeleton.querySelector('.api-balance-primary-row > .api-balance-menu-placeholder');
      expect(menuPlaceholder).not.toBeNull();
      expect(menuPlaceholder?.textContent).toBe('');
      expect(menuPlaceholder?.querySelector('svg')).not.toBeNull();
      expect(skeleton.querySelector('.api-balance-secondary .api-balance-skeleton-meta')).not.toBeNull();
      expect(skeleton.querySelector('.api-balance-update-slot .api-balance-skeleton-time')).not.toBeNull();
    }
  });

  it('keeps the balance rows mounted while refresh uses the fixed menu slot', async () => {
    const account = {
      id: 'refreshing', name: 'Production', providerType: 'deepseek', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: 1, lastAttemptAt: 1, lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [{
        currency: 'CNY', totalBalance: '110.00', toppedUpBalance: '100.00', grantedBalance: '10.00',
      }] },
    };
    let resolveQuery;
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([account]);
    queryApiAccount.mockImplementation(() => new Promise((resolve) => { resolveQuery = resolve; }));
    await render(); await settle();
    await act(async () => [...container.querySelectorAll('[role="tab"]')][1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    const card = container.querySelector('.api-balance-card');
    expect(card?.textContent).toContain('110.00');
    expect(card?.querySelector('.api-balance-menu')?.textContent).toBe('');
    expect(card?.querySelector('.api-balance-menu svg')).not.toBeNull();
    expect(card?.querySelector('.api-balance-refreshing .api-balance-spinner')).not.toBeNull();
    await act(async () => card.querySelector('.api-balance-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('.sheet-action')?.disabled).toBe(true);
    expect(container.querySelectorAll('.sheet-action')[1]?.disabled).toBe(false);
    await act(async () => resolveQuery({ ...account, updatedAt: 2, lastSuccessAt: Date.now() }));
    await settle();
    expect(container.querySelector('.api-balance-card')).toBe(card);
    expect(card?.querySelector('.api-balance-refreshing')).toBeNull();
  });

  it('keeps API actions in an anchored menu, preserves form Back layering, and confirms delete twice', async () => {
    const account = {
      id: 'menu-account', name: 'Production', providerType: 'deepseek', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: Date.now(), lastAttemptAt: Date.now(), lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [] },
    };
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([account]);
    deleteApiAccount.mockResolvedValue(undefined);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    try {
      await render(); await settle();
      await act(async () => [...container.querySelectorAll('[role="tab"]')][1]
        .dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await settle();
      const trigger = container.querySelector('.api-balance-menu');
      await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      let menu = container.querySelector('[role="menu"]');
      let actions = [...menu.querySelectorAll('[role="menuitem"]')];
      expect(actions).toHaveLength(4);
      expect(actions.every((action) => action.querySelector('.usage-popover-icon svg'))).toBe(true);
      expect(actions[3].classList.contains('danger')).toBe(true);
      expect(menu.querySelector('.usage-popover-separator')).not.toBeNull();

      await act(async () => actions[1].dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(container.querySelector('.api-account-form')).not.toBeNull();
      expect(document.activeElement).toBe(container.querySelector('.api-account-form input:not([type="password"])'));
      await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
      await settle();
      expect(container.querySelector('.api-account-form')).toBeNull();
      expect(container.querySelector('.settings-card.usage-card')).not.toBeNull();
      expect(document.activeElement).toBe(trigger);

      await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      menu = container.querySelector('[role="menu"]');
      actions = [...menu.querySelectorAll('[role="menuitem"]')];
      await act(async () => actions[2].dispatchEvent(new MouseEvent('click', { bubbles: true })));
      const keyInput = container.querySelector('.api-account-form input[type="password"]');
      expect(keyInput).not.toBeNull();
      expect(document.activeElement).toBe(keyInput);
      await act(async () => container.querySelector('.api-account-form .settings-close')
        .dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(container.querySelector('.api-account-form')).toBeNull();
      expect(document.activeElement).toBe(trigger);

      await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      menu = container.querySelector('[role="menu"]');
      actions = [...menu.querySelectorAll('[role="menuitem"]')];
      await act(async () => actions[3].dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(deleteApiAccount).not.toHaveBeenCalled();
      expect(actions[3].textContent).toMatch(/Delete this account|确认删除/);
      expect(actions[3].querySelector('svg')).toBeNull();
      await act(async () => actions[3].dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await settle();
      expect(deleteApiAccount).toHaveBeenCalledWith('menu-account');
      expect(container.querySelector('[data-account-id="menu-account"]')).toBeNull();
    } finally {
      back.mockRestore();
    }
  });

  it('submits a new key only from the password form and never renders it back', async () => {
    const sentinel = 'hm-web-SENTINEL-key';
    const saved = {
      id: 'account-2', name: 'DeepSeek', providerType: 'deepseek', credentialConfigured: true,
      createdAt: 2, updatedAt: 2, lastSuccessAt: 2, lastAttemptAt: 2, lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [] },
    };
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([]);
    createApiAccount.mockResolvedValue(saved);
    await render(); await settle();
    const apiTab = [...container.querySelectorAll('[role="tab"]')][1];
    await act(async () => apiTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    const add = container.querySelector('.api-balance-add-row');
    await act(async () => add.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const picker = [...container.querySelectorAll('.sheet-action')]
      .find((button) => button.textContent.includes('DeepSeek'));
    await act(async () => picker.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('.settings-card.api-account-form')).not.toBeNull();
    expect(container.querySelector('.file-sheet.api-account-form')).toBeNull();
    expect(container.querySelector('.api-account-form .api-form-group')).not.toBeNull();
    expect(container.querySelectorAll('.api-account-form .api-form-row')).toHaveLength(3);
    expect(container.querySelector('.api-account-form .settings-body .api-form-actions')).toBeNull();
    expect(container.querySelector('.api-account-form > .api-form-actions')).not.toBeNull();
    const keyInput = container.querySelector('.api-account-form input[type="password"]');
    expect(keyInput).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(keyInput, sentinel);
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = container.querySelector('.api-form-submit');
    await act(async () => submit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(createApiAccount).toHaveBeenCalledWith(expect.objectContaining({
      providerType: 'deepseek', credential: { kind: 'apiKey', value: sentinel },
    }), expect.any(AbortSignal));
    expect(container.textContent).not.toContain(sentinel);
  });

  it('passes the mocked keyboard inset through the portal to the centered account form', async () => {
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([]);
    await render({ keyboardInset: 240 }); await settle();
    await act(async () => [...container.querySelectorAll('[role="tab"]')][1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    await act(async () => container.querySelector('.api-balance-add-row')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => [...container.querySelectorAll('.sheet-action')]
      .find((button) => button.textContent.includes('DeepSeek'))
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const form = container.querySelector('.api-account-form');
    const layer = form?.closest('.overlay-layer');
    expect(layer?.style.getPropertyValue('--overlay-keyboard-inset')).toBe('240px');
    expect(layer?.style.getPropertyValue('--overlay-keyboard-center-shift')).toBe('120px');
    expect(form?.classList.contains('settings-card')).toBe(true);
    expect(form?.classList.contains('file-sheet')).toBe(false);
    expect(form?.querySelector('.api-form-body')).not.toBeNull();
    expect(form?.querySelector('.api-form-body .api-form-actions')).toBeNull();
    expect(form?.querySelector(':scope > .api-form-actions')).not.toBeNull();
  });

  it('offers all verified built-in providers and renders their explicit balance fields', async () => {
    const accounts = [{
      id: 'account-kimi', name: 'Kimi', providerType: 'moonshot', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: Date.now(), lastAttemptAt: Date.now(), lastErrorCode: null,
      latestSuccess: { providerType: 'moonshot', currency: 'CNY', availableBalance: 3, voucherBalance: 4, cashBalance: -1 },
    }];
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue(accounts);
    await render(); await settle();
    await act(async () => [...container.querySelectorAll('[role="tab"]')][1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(container.textContent).toMatch(/Cash balance|现金余额/);
    await act(async () => container.querySelector('.api-balance-add-row')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect([...container.querySelectorAll('.sheet-action')].map((button) => button.textContent))
      .toEqual(expect.arrayContaining(['DeepSeek', 'Moonshot (Kimi)']));
  });

  it('keeps a concurrently refreshed snapshot authoritative when an older Provider query fails', async () => {
    const base = {
      id: 'account-race', name: 'Before refresh', providerType: 'deepseek', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: 1, lastAttemptAt: 1, lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [{
        currency: 'CNY', totalBalance: '1.00', toppedUpBalance: '1.00', grantedBalance: '0.00',
      }] },
    };
    const latest = {
      ...base, name: 'Replaced and refreshed elsewhere', updatedAt: 2, lastSuccessAt: 2, lastAttemptAt: 2,
      latestSuccess: { ...base.latestSuccess, balances: [{
        currency: 'CNY', totalBalance: '99.00', toppedUpBalance: '99.00', grantedBalance: '0.00',
      }] },
    };
    let rejectQuery;
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValueOnce([base]).mockResolvedValueOnce([latest]);
    queryApiAccount.mockImplementation(() => new Promise((_resolve, reject) => { rejectQuery = reject; }));
    await render(); await settle();
    const apiTab = [...container.querySelectorAll('[role="tab"]')][1];
    await act(async () => apiTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(queryApiAccount).toHaveBeenCalledTimes(1);
    await act(async () => rejectQuery(new ApiError(502, 'provider_unreachable')));
    await settle();
    expect(getApiAccounts).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.api-balance-card')?.textContent).toContain('Replaced and refreshed elsewhere');
    expect(container.querySelector('.api-balance-card')?.textContent).toContain('99.00');
    expect(container.querySelector('.api-balance-card .api-balance-account-error')).not.toBeNull();
    expect(container.querySelector('.api-balance-global-error')).toBeNull();
    expect(container.textContent).not.toContain('Before refresh');
  });

  it('shows the storage recovery hint when the first account load is unavailable', async () => {
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockRejectedValue(new ApiError(503, 'storage_unavailable'));
    await render(); await settle();
    const apiTab = [...container.querySelectorAll('[role="tab"]')][1];
    await act(async () => apiTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    const message = container.querySelector('.api-balance-global-error')?.textContent ?? '';
    expect(message).toContain('~/.handmux');
    expect(message).not.toMatch(/could not be loaded|无法加载 API 余额/);
  });

  it('clears an old global error after a successful manual refresh', async () => {
    const account = {
      id: 'account-retry', name: 'Retry', providerType: 'deepseek', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: Date.now(), lastAttemptAt: Date.now(), lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [] },
    };
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([account]);
    deleteApiAccount.mockRejectedValue(new Error('offline'));
    queryApiAccount.mockResolvedValue({ ...account, updatedAt: 2 });
    await render(); await settle();
    const apiTab = [...container.querySelectorAll('[role="tab"]')][1];
    await act(async () => apiTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();

    await act(async () => container.querySelector('.api-balance-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const deleteButton = [...container.querySelectorAll('.sheet-action')][3];
    await act(async () => deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(container.querySelector('.api-balance-global-error')).not.toBeNull();

    await act(async () => container.querySelector('.api-balance-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => container.querySelector('.sheet-action')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(container.querySelector('.api-balance-global-error')).toBeNull();
  });

  it('treats delete 404 as already deleted and clears that account feedback', async () => {
    const account = {
      id: 'account-gone', name: 'Gone elsewhere', providerType: 'deepseek', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: Date.now(), lastAttemptAt: Date.now(), lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [] },
    };
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([account]);
    queryApiAccount.mockRejectedValue(new ApiError(502, 'provider_unreachable'));
    deleteApiAccount.mockRejectedValue(new ApiError(404, 'not_found'));
    await render(); await settle();
    const apiTab = [...container.querySelectorAll('[role="tab"]')][1];
    await act(async () => apiTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();

    await act(async () => container.querySelector('.api-balance-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => container.querySelector('.sheet-action')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(container.querySelector('[data-account-id="account-gone"]')).not.toBeNull();

    await act(async () => container.querySelector('.api-balance-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const deleteButton = [...container.querySelectorAll('.sheet-action')][3];
    await act(async () => deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(container.querySelector('.api-balance-card')).toBeNull();
    expect(container.querySelector('[data-account-id="account-gone"]')).toBeNull();
    expect(container.querySelector('.api-balance-global-error')).toBeNull();
  });

  it('shows the storage recovery action instead of a generic delete failure', async () => {
    const account = {
      id: 'account-storage', name: 'Stored', providerType: 'deepseek', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: Date.now(), lastAttemptAt: Date.now(), lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [] },
    };
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([account]);
    deleteApiAccount.mockRejectedValue(new ApiError(503, 'storage_unavailable'));
    await render(); await settle();
    const apiTab = [...container.querySelectorAll('[role="tab"]')][1];
    await act(async () => apiTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    await act(async () => container.querySelector('.api-balance-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const deleteButton = [...container.querySelectorAll('.sheet-action')][3];
    await act(async () => deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    const message = container.querySelector('.api-balance-global-error')?.textContent ?? '';
    expect(message).toContain('api-accounts.json');
    expect(message).toContain('api-accounts.key');
    expect(message).toMatch(/\.unavailable/);
    expect(message).toMatch(/请勿直接清空|do not clear/);
    expect(message).toMatch(/最后移除|remove \.unavailable last/);
    expect(message).not.toMatch(/could not be deleted|无法删除账户/);
    expect(container.querySelector('.api-balance-card')).not.toBeNull();
  });

  it('clears only the saved or deleted account feedback after successful actions', async () => {
    const account = (id, name) => ({
      id, name, providerType: 'deepseek', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: Date.now(), lastAttemptAt: Date.now(), lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [] },
    });
    const first = account('account-first', 'First');
    const second = account('account-second', 'Second');
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([first, second]);
    queryApiAccount.mockRejectedValue(new ApiError(502, 'provider_unreachable'));
    deleteApiAccount.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    patchApiAccount.mockResolvedValue({ ...first, updatedAt: 2 });
    await render(); await settle();
    const apiTab = [...container.querySelectorAll('[role="tab"]')][1];
    await act(async () => apiTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();

    for (const card of [...container.querySelectorAll('.api-balance-card')]) {
      await act(async () => card.querySelector('.api-balance-menu')
        .dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await act(async () => container.querySelector('.sheet-action')
        .dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await settle();
    }
    expect(container.querySelectorAll('.api-balance-account-error')).toHaveLength(2);

    await act(async () => container.querySelectorAll('.api-balance-card')[1].querySelector('.api-balance-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    let deleteButton = [...container.querySelectorAll('.sheet-action')][3];
    await act(async () => deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(container.querySelector('.api-balance-global-error')).not.toBeNull();

    await act(async () => container.querySelectorAll('.api-balance-card')[0].querySelector('.api-balance-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => container.querySelectorAll('.sheet-action')[2]
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const keyInput = container.querySelector('.api-account-form input[type="password"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(keyInput, 'replacement-key');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('.api-form-submit')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(container.querySelector('.api-balance-global-error')).toBeNull();
    expect(container.querySelector('[data-account-id="account-first"] .api-balance-account-error')).toBeNull();
    expect(container.querySelector('[data-account-id="account-second"]')).not.toBeNull();

    await act(async () => container.querySelectorAll('.api-balance-card')[1].querySelector('.api-balance-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    deleteButton = [...container.querySelectorAll('.sheet-action')][3];
    await act(async () => deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(container.querySelector('[data-account-id="account-second"]')).toBeNull();
    expect(container.textContent).not.toContain('Second');
  });

  it('clears a prior global error after a new account is saved', async () => {
    const existing = {
      id: 'account-existing', name: 'Existing', providerType: 'deepseek', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: Date.now(), lastAttemptAt: Date.now(), lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [] },
    };
    const added = { ...existing, id: 'account-added', name: 'DeepSeek', updatedAt: 2 };
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([existing]);
    deleteApiAccount.mockRejectedValue(new Error('offline'));
    createApiAccount.mockResolvedValue(added);
    await render(); await settle();
    const apiTab = [...container.querySelectorAll('[role="tab"]')][1];
    await act(async () => apiTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    await act(async () => container.querySelector('.api-balance-menu')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const deleteButton = [...container.querySelectorAll('.sheet-action')][3];
    await act(async () => deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {});
    await act(async () => [...container.querySelectorAll('.sheet-action')][3]
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(container.querySelector('.api-balance-global-error')).not.toBeNull();

    await act(async () => container.querySelector('.api-balance-add-row')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => [...container.querySelectorAll('.sheet-action')]
      .find((button) => button.textContent.includes('DeepSeek'))
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const keyInput = container.querySelector('.api-account-form input[type="password"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(keyInput, 'new-key');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('.api-form-submit')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(container.querySelector('.api-balance-global-error')).toBeNull();
    expect(container.textContent).toContain('DeepSeek');
  });

  it('does not resurrect an account deleted while its Provider query fails', async () => {
    const account = {
      id: 'account-deleted', name: 'Delete elsewhere', providerType: 'deepseek', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: 1, lastAttemptAt: 1, lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [] },
    };
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValueOnce([account]).mockResolvedValueOnce([]);
    queryApiAccount.mockRejectedValue(new ApiError(422, 'invalid_credential'));
    await render(); await settle();
    const apiTab = [...container.querySelectorAll('[role="tab"]')][1];
    await act(async () => apiTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle(); await settle();
    expect(container.querySelector('.api-balance-card')).toBeNull();
    expect(container.textContent).not.toContain('Delete elsewhere');
  });

  it('reloads a credential replacement when an old query returns conflict', async () => {
    const oldAccount = {
      id: 'account-replaced', name: 'Replacement race', providerType: 'deepseek', credentialConfigured: true,
      createdAt: 1, updatedAt: 1, lastSuccessAt: 1, lastAttemptAt: 1, lastErrorCode: null,
      latestSuccess: { providerType: 'deepseek', isAvailable: true, balances: [{
        currency: 'CNY', totalBalance: '1.00', toppedUpBalance: '1.00', grantedBalance: '0.00',
      }] },
    };
    const replaced = {
      ...oldAccount, updatedAt: 2, latestSuccess: { ...oldAccount.latestSuccess, balances: [{
        currency: 'CNY', totalBalance: '99.00', toppedUpBalance: '99.00', grantedBalance: '0.00',
      }] },
    };
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValueOnce([oldAccount]).mockResolvedValueOnce([replaced]);
    queryApiAccount.mockRejectedValue(new ApiError(409, 'conflict'));
    await render(); await settle();
    const apiTab = [...container.querySelectorAll('[role="tab"]')][1];
    await act(async () => apiTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle(); await settle();
    expect(container.querySelector('.api-balance-card')?.textContent).toContain('99.00');
    expect(container.querySelector('.api-balance-card')?.textContent).not.toContain('1.00');
  });

  it('aborts credential validation when the form closes', async () => {
    let submittedSignal;
    getAgentUsage.mockResolvedValue({ agents: [] });
    getApiAccounts.mockResolvedValue([]);
    createApiAccount.mockImplementation((_body, signal) => {
      submittedSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true }));
    });
    await render(); await settle();
    const apiTab = [...container.querySelectorAll('[role="tab"]')][1];
    await act(async () => apiTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    await act(async () => container.querySelector('.api-balance-add-row')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => [...container.querySelectorAll('.sheet-action')]
      .find((button) => button.textContent.includes('DeepSeek'))
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const keyInput = container.querySelector('.api-account-form input[type="password"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(keyInput, 'cancel-me');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('.api-form-submit')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(submittedSignal?.aborted).toBe(false);
    await act(async () => container.querySelector('.api-account-form .settings-close')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(submittedSignal?.aborted).toBe(true);
    expect(container.querySelector('.api-account-form')).toBeNull();
  });

  it('maps every controlled validation failure to actionable copy', () => {
    for (const [status, code] of [
      [422, 'invalid_credential'], [429, 'rate_limited'], [504, 'provider_timeout'],
      [502, 'provider_unreachable'], [502, 'unsupported_response'], [503, 'storage_unavailable'],
      [409, 'conflict'], [409, 'account_limit_reached'], [404, 'not_found'],
    ]) {
      const message = apiAccountSaveErrorText(new ApiError(status, code));
      expect(message).not.toMatch(/^apiBalance\./);
      expect(message).not.toMatch(/could not be saved|无法保存账户/);
    }
  });

  it('uses the full IPv4 127/8 range for local credential submission', () => {
    expect(isApiCredentialContextSafe(false, '127.0.0.1')).toBe(true);
    expect(isApiCredentialContextSafe(false, '127.42.7.9')).toBe(true);
    expect(isApiCredentialContextSafe(false, '127.999.0.1')).toBe(false);
    expect(isApiCredentialContextSafe(false, '128.0.0.1')).toBe(false);
    expect(isApiCredentialContextSafe(true, 'remote.example')).toBe(true);
  });

  it('counts API account names by Unicode code point', () => {
    expect(isApiAccountNameValid('😀'.repeat(64))).toBe(true);
    expect(isApiAccountNameValid('😀'.repeat(65))).toBe(false);
  });
});
