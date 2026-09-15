import { beforeEach, describe, expect, it, vi } from 'vitest';
const prompts = vi.hoisted(() => ({ canceled: Symbol('cancel'), text: vi.fn(), select: vi.fn(), confirm: vi.fn() }));
vi.mock('@clack/prompts', () => ({ ...prompts, isCancel: (value: unknown) => value === prompts.canceled }));
import { runAuthCommand } from '../src/cli/authCmd.js';
import { AuthControlError } from '../src/deviceAuth/control.js';

describe('interactive device add', () => {
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
    expect(await runAuthCommand({ argv: ['device', 'add'], home: '/unused', interactive: true, connect: c.connect, log })).toBe(0);
    expect(c.request).toHaveBeenLastCalledWith({ op: 'authorize', id: 'pair_1', name: 'Office', expire: '7d' }); expect(c.close).toHaveBeenCalledOnce();
  });
  it('asks only missing fields, uses summary for blank name, and closes control on cancel', async () => {
    const c = control(); prompts.text.mockResolvedValueOnce(''); prompts.confirm.mockResolvedValueOnce(true);
    expect(await runAuthCommand({ argv: ['device', 'add', '--code', '038271', '--expire', 'never'], home: '/unused', interactive: true, connect: c.connect, log: vi.fn() })).toBe(0);
    expect(prompts.select).not.toHaveBeenCalled(); expect(c.request).toHaveBeenLastCalledWith({ op: 'authorize', id: 'pair_1', name: 'Safari', expire: 'never' });
    const c2 = control(); prompts.text.mockResolvedValueOnce(prompts.canceled);
    expect(await runAuthCommand({ argv: ['device', 'add', '--code', '038271'], home: '/unused', interactive: true, connect: c2.connect, log: vi.fn(), err: vi.fn() })).toBe(1);
    expect(c2.request).toHaveBeenCalledOnce(); expect(c2.close).toHaveBeenCalledOnce();
  });
  it('complete parameters never prompt even in a TTY', async () => {
    const c = control();
    expect(await runAuthCommand({ argv: ['device', 'add', '--code', '038271', '--name', 'A', '--expire', '1h'], home: '/unused', interactive: true, connect: c.connect, log: vi.fn() })).toBe(0);
    expect(prompts.text).not.toHaveBeenCalled(); expect(prompts.select).not.toHaveBeenCalled(); expect(prompts.confirm).not.toHaveBeenCalled();
  });
});

describe('auth policy controls', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('reports and changes device protection without a trusted qualifier', async () => {
    const request = vi.fn(async (args: Record<string, unknown>) => args.op === 'device-status'
      ? { enabled: true, devices: [] } : { enabled: false });
    const connect = vi.fn(async () => ({ request, close: vi.fn() }));
    expect(await runAuthCommand({ argv: ['device', 'status'], home: '/unused', interactive: true, connect, log: vi.fn() })).toBe(0);
    expect(request).toHaveBeenLastCalledWith({ op: 'device-status' });
    prompts.confirm.mockResolvedValueOnce(true);
    expect(await runAuthCommand({ argv: ['device', 'off'], home: '/unused', interactive: true, connect, log: vi.fn() })).toBe(0);
    expect(request).toHaveBeenLastCalledWith({ op: 'device-policy', enabled: false });
  });
  it('reports and changes address restriction', async () => {
    const request = vi.fn(async (args: Record<string, unknown>) => args.op === 'address-status'
      ? { enabled: true, origins: [] } : { enabled: false });
    const connect = vi.fn(async () => ({ request, close: vi.fn() }));
    expect(await runAuthCommand({ argv: ['address', 'status'], home: '/unused', interactive: true, connect, log: vi.fn() })).toBe(0);
    expect(request).toHaveBeenLastCalledWith({ op: 'address-status' });
    prompts.confirm.mockResolvedValueOnce(true);
    expect(await runAuthCommand({ argv: ['address', 'off'], home: '/unused', interactive: true, connect, log: vi.fn() })).toBe(0);
    expect(request).toHaveBeenLastCalledWith({ op: 'address-policy', enabled: false });
  });
});

describe('authorization error copy', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('localizes control-socket error codes instead of exposing internal messages', async () => {
    const err = vi.fn();
    const connect = vi.fn(async () => ({
      request: vi.fn(async () => { throw new AuthControlError('CODE_INVALID', 'Code is invalid, expired, or already used'); }),
      close: vi.fn(),
    }));
    expect(await runAuthCommand({ argv: ['device', 'add', '--code', '038271', '--name', 'Office', '--expire', '7d'], home: '/unused', interactive: false, connect, log: vi.fn(), err })).toBe(1);
    expect(err).toHaveBeenCalledWith('The code is invalid, expired, or already used. Request a new code in the browser.');
  });
});
