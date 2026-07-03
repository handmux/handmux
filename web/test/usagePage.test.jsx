import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../src/api.js', () => ({
  getUsage: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import UsagePage from '../src/components/UsagePage.jsx';
import { getUsage, UnauthorizedError } from '../src/api.js';

let container, root;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const render = (props) => act(() => root.render(<UsagePage open onClose={() => {}} onAuthFail={() => {}} {...props} />));
const settle = async () => { await act(async () => {}); await act(async () => {}); };

describe('UsagePage', () => {
  it('renders a Codex quota bar with percent + a freshness stamp', async () => {
    getUsage.mockResolvedValue({
      claude: null,
      codex: { updatedAt: Date.now() - 5 * 60 * 1000, rateLimits: { primary: { usedPercent: 16, windowMinutes: 43200, resetsAt: 9999999999 }, secondary: null } },
    });
    await render();
    await settle();
    expect(container.textContent).toContain('Codex CLI');
    expect(container.textContent).toContain('16%');
    expect(container.querySelector('.usage-bar-fill').style.width).toBe('16%');
    expect(container.querySelector('.usage-updated').textContent).toMatch(/5m ago|5 分钟/); // freshness
    expect(container.textContent).not.toMatch(/token/i); // no misleading session-token line
  });

  it('shows the enable hint when the Claude capturer is not wired', async () => {
    getUsage.mockResolvedValue({ claude: null, codex: null });
    await render();
    await settle();
    expect(container.textContent).toContain('Claude Code');
    expect(container.textContent).toContain('handmux hooks install');
  });

  it('renders Claude 5h + weekly bars when present', async () => {
    getUsage.mockResolvedValue({
      claude: { rateLimits: { fiveHour: { usedPercent: 43, resetsAt: 9999999999 }, sevenDay: { usedPercent: 15, resetsAt: 9999999999 } } },
      codex: null,
    });
    await render();
    await settle();
    const bars = [...container.querySelectorAll('.usage-bar-fill')];
    expect(bars.map((b) => b.style.width)).toEqual(['43%', '15%']);
  });

  it('shows the pending note when Claude is wired but has no rate_limits yet', async () => {
    getUsage.mockResolvedValue({ claude: { rateLimits: {} }, codex: null });
    await render();
    await settle();
    expect(container.querySelector('.usage-bar-fill')).toBeNull();
    expect(container.textContent).toMatch(/message|消息/); // "send a message…" pending copy
  });

  it('calls onAuthFail on a 401', async () => {
    getUsage.mockRejectedValue(new UnauthorizedError());
    const onAuthFail = vi.fn();
    await render({ onAuthFail });
    await settle();
    expect(onAuthFail).toHaveBeenCalled();
  });
});
