import { beforeEach, describe, expect, it, vi } from 'vitest';
const prompts = vi.hoisted(() => ({ canceled: Symbol('cancel'), text: vi.fn(), select: vi.fn(), confirm: vi.fn() }));
vi.mock('@clack/prompts', () => ({ ...prompts, isCancel: (value: unknown) => value === prompts.canceled }));
import { runAuthCommand } from '../src/cli/authCmd.js';

describe('interactive auth add', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  function control() {
    const request = vi.fn(async (args: Record<string, unknown>) => args.op === 'claim'
      ? { id: 'pair_1', browserSummary: 'Safari' }
      : { id: 'dev_1', name: args.name, status: 'active', authorized_at: 1, last_used_at: 1, expires_at: null });
    const close = vi.fn(); const connect = vi.fn(async () => ({ request, close }));
    return { request, close, connect };
  }
  it('claims immediately after the code and before prompting for name or expiry', async () => {
    const c = control();
    prompts.text.mockResolvedValueOnce('038271').mockImplementationOnce(async () => {
      expect(c.request).toHaveBeenCalledOnce(); expect(c.request).toHaveBeenCalledWith({ op: 'claim', code: '038271' }); return 'Office';
    });
    prompts.select.mockResolvedValueOnce('7d'); prompts.confirm.mockResolvedValueOnce(true);
    const log = vi.fn();
    expect(await runAuthCommand({ argv: ['add'], home: '/unused', interactive: true, connect: c.connect, log })).toBe(0);
    expect(c.request).toHaveBeenLastCalledWith({ op: 'authorize', id: 'pair_1', name: 'Office', expire: '7d' }); expect(c.close).toHaveBeenCalledOnce();
  });
  it('asks only missing fields, uses summary for blank name, and closes control on cancel', async () => {
    const c = control(); prompts.text.mockResolvedValueOnce(''); prompts.confirm.mockResolvedValueOnce(true);
    expect(await runAuthCommand({ argv: ['add', '--code', '038271', '--expire', 'never'], home: '/unused', interactive: true, connect: c.connect, log: vi.fn() })).toBe(0);
    expect(prompts.select).not.toHaveBeenCalled(); expect(c.request).toHaveBeenLastCalledWith({ op: 'authorize', id: 'pair_1', name: 'Safari', expire: 'never' });
    const c2 = control(); prompts.text.mockResolvedValueOnce(prompts.canceled);
    expect(await runAuthCommand({ argv: ['add', '--code', '038271'], home: '/unused', interactive: true, connect: c2.connect, log: vi.fn(), err: vi.fn() })).toBe(1);
    expect(c2.request).toHaveBeenCalledOnce(); expect(c2.close).toHaveBeenCalledOnce();
  });
  it('complete parameters never prompt even in a TTY', async () => {
    const c = control();
    expect(await runAuthCommand({ argv: ['add', '--code', '038271', '--name', 'A', '--expire', '1h'], home: '/unused', interactive: true, connect: c.connect, log: vi.fn() })).toBe(0);
    expect(prompts.text).not.toHaveBeenCalled(); expect(prompts.select).not.toHaveBeenCalled(); expect(prompts.confirm).not.toHaveBeenCalled();
  });
});

describe('fixed Token login controls', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('reports that the fixed Token is always enabled', async () => {
    const request = vi.fn(async () => ({ enabled: true, devices: [] }));
    const connect = vi.fn(async () => ({ request, close: vi.fn() }));
    expect(await runAuthCommand({ argv: ['token', 'enable'], home: '/unused', interactive: true, connect, log: vi.fn() })).toBe(0);
    expect(request).toHaveBeenLastCalledWith({ op: 'token-status' });
    expect(prompts.confirm).not.toHaveBeenCalled();
  });
  it('rejects the removed disable operation without prompting', async () => {
    const request = vi.fn(async () => ({ enabled: true, devices: [] }));
    const connect = vi.fn(async () => ({ request, close: vi.fn() }));
    expect(await runAuthCommand({ argv: ['token', 'disable'], home: '/unused', interactive: true, connect, log: vi.fn(), err: vi.fn() })).toBe(1);
    expect(request).toHaveBeenLastCalledWith({ op: 'token-status' });
    expect(prompts.text).not.toHaveBeenCalled(); expect(prompts.confirm).not.toHaveBeenCalled();
  });
});
