import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prompt = vi.hoisted(() => ({
  cancelled: Symbol('cancelled'), select: vi.fn(), confirm: vi.fn(), text: vi.fn(), password: vi.fn(),
  intro: vi.fn(), outro: vi.fn(), note: vi.fn(), cancel: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({ ...prompt, isCancel: (value: unknown) => value === prompt.cancelled }));
import { runSetup } from '../src/cli/setupWizard.js';
import { PrivateStateStore } from '../src/privateStateStore.js';

describe('setup wizard authentication migration', () => {
  let root = '';
  let ttyDescriptor: PropertyDescriptor | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'handmux-setup-auth-'));
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    vi.resetAllMocks();
    prompt.select.mockResolvedValue(prompt.cancelled); prompt.confirm.mockResolvedValue(prompt.cancelled);
    prompt.text.mockResolvedValue(prompt.cancelled); prompt.password.mockResolvedValue(prompt.cancelled);
    vi.stubEnv('HANDMUX_AUTH_MODE', undefined); vi.stubEnv('HANDMUX_TOKEN', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor); else Reflect.deleteProperty(process.stdin, 'isTTY');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('saves trusted-device mode and a durable Token on a new setup', async () => {
    const target = path.join(root, 'config.json');
    prompt.select.mockResolvedValueOnce('en').mockResolvedValueOnce('none')
      .mockResolvedValueOnce('custom').mockResolvedValueOnce(prompt.cancelled).mockResolvedValueOnce('save');
    prompt.text.mockResolvedValueOnce('fixed-token');
    const result = await runSetup({ target, home: root });
    expect(result?.cfg).toMatchObject({ authMode: 'trusted-device', token: 'fixed-token' });
    expect(new PrivateStateStore<Record<string, unknown>>(target).readStrict()).toMatchObject({ authMode: 'trusted-device', token: 'fixed-token' });
    expect(prompt.confirm).not.toHaveBeenCalled();
  });

  it('does not expose an authentication mode switch and preserves an existing Token', async () => {
    const target = path.join(root, 'config.json');
    new PrivateStateStore(target).write({ authMode: 'token', token: 'legacy-token', tunnel: 'none', port: 19999 });
    prompt.select.mockResolvedValueOnce('auth').mockResolvedValueOnce('custom').mockResolvedValueOnce(prompt.cancelled).mockResolvedValueOnce('save');
    prompt.text.mockResolvedValueOnce('new-token');
    const result = await runSetup({ target, home: root });
    expect(result?.cfg).toMatchObject({ authMode: 'trusted-device', token: 'new-token' });
    const authChoice = prompt.select.mock.calls.find(([options]) => options?.options?.some((row: { value: string }) => row.value === 'token' || row.value === 'trusted-device'));
    expect(authChoice).toBeUndefined();
  });

  it('does not write when leaving the setup hub', async () => {
    const target = path.join(root, 'config.json');
    const original = { authMode: 'token', token: 'legacy-token', tunnel: 'none', port: 19999 };
    new PrivateStateStore(target).write(original);
    prompt.select.mockResolvedValueOnce(prompt.cancelled);
    expect(await runSetup({ target, home: root })).toBeNull();
    expect(new PrivateStateStore(target).readStrict()).toEqual(original);
  });
});
