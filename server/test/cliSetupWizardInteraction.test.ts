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

describe('setup wizard authentication', () => {
  let root = '';
  let ttyDescriptor: PropertyDescriptor | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'handmux-setup-auth-'));
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    vi.resetAllMocks();
    prompt.select.mockResolvedValue(prompt.cancelled); prompt.confirm.mockResolvedValue(prompt.cancelled);
    prompt.text.mockResolvedValue(prompt.cancelled); prompt.password.mockResolvedValue(prompt.cancelled);
    vi.stubEnv('HANDMUX_TOKEN', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor); else Reflect.deleteProperty(process.stdin, 'isTTY');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('saves a durable Token on a new setup without an authentication mode field', async () => {
    const target = path.join(root, 'config.json');
    prompt.select.mockResolvedValueOnce('en').mockResolvedValueOnce('none')
      // Direct mode exposes an optional public URL field; leave it blank and
      // return to the hub before editing the Token.
      .mockResolvedValueOnce(prompt.cancelled)
      .mockResolvedValueOnce('custom').mockResolvedValueOnce(prompt.cancelled).mockResolvedValueOnce('save');
    prompt.text.mockResolvedValueOnce('fixed-token');
    const result = await runSetup({ target, home: root });
    expect(result?.cfg).toMatchObject({ token: 'fixed-token' });
    expect(result?.cfg).not.toHaveProperty('authMode');
    expect(new PrivateStateStore<Record<string, unknown>>(target).readStrict()).toMatchObject({ token: 'fixed-token' });
    expect(prompt.confirm).not.toHaveBeenCalled();
  });

  it('edits the existing Token without exposing an authentication mode switch', async () => {
    const target = path.join(root, 'config.json');
    new PrivateStateStore(target).write({ token: 'current-token', tunnel: 'none', port: 19999 });
    prompt.select.mockResolvedValueOnce('auth').mockResolvedValueOnce('custom').mockResolvedValueOnce(prompt.cancelled).mockResolvedValueOnce('save');
    prompt.text.mockResolvedValueOnce('new-token');
    const result = await runSetup({ target, home: root });
    expect(result?.cfg).toMatchObject({ token: 'new-token' });
    expect(result?.cfg).not.toHaveProperty('authMode');
    const authChoice = prompt.select.mock.calls.find(([options]) => options?.options?.some((row: { value: string }) => row.value === 'token' || row.value === 'trusted-device'));
    expect(authChoice).toBeUndefined();
  });

  it('keeps a disabled multi-provider voice config when Esc backs out of enable confirmation', async () => {
    const target = path.join(root, 'config.json');
    const voice = {
      enabled: false as const,
      provider: 'tencent',
      mode: 'sentence' as const,
      providers: {
        xfyun: { appId: 'XFYUN_APP', apiKey: 'XFYUN_KEY', apiSecret: 'XFYUN_SECRET' },
        tencent: {
          appId: 'TENCENT_APP', secretId: 'TENCENT_ID', secretKey: 'TENCENT_SECRET',
          engineModelType: '16k_zh',
        },
      },
    };
    new PrivateStateStore(target).write({ tunnel: 'none', port: 19999, voice });
    prompt.select.mockResolvedValueOnce('voice').mockResolvedValueOnce('save');
    prompt.confirm.mockResolvedValueOnce(prompt.cancelled);

    const result = await runSetup({ target, home: root, log: console });

    expect(result?.cfg.voice).toEqual(voice);
    expect(new PrivateStateStore<Record<string, unknown>>(target).readStrict()?.voice).toEqual(voice);
    expect(prompt.confirm).toHaveBeenCalledOnce();
  });

  it.each([false, true])('keeps edited Token and auth storage unchanged when setup is canceled (running: %s)', async (running) => {
    const target = path.join(root, 'config.json');
    const original = { token: 'current-token', tunnel: 'none', port: 19999 };
    new PrivateStateStore(target).write(original);
    const before = fs.readFileSync(target, 'utf8');
    prompt.select.mockResolvedValueOnce('auth').mockResolvedValueOnce('custom')
      .mockResolvedValueOnce(prompt.cancelled).mockResolvedValueOnce('exit');
    prompt.text.mockResolvedValueOnce('replacement-token');
    expect(await runSetup({ target, home: root, running })).toBeNull();
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(root, '.handmux', 'handmux.sqlite'))).toBe(false);
  });

  it('refuses to overwrite a corrupt config as if it were a new installation', async () => {
    const target = path.join(root, 'config.json');
    fs.writeFileSync(target, '{broken');
    const log = { log: vi.fn(), error: vi.fn() };
    expect(await runSetup({ target, home: root, log })).toBeNull();
    expect(fs.readFileSync(target, 'utf8')).toBe('{broken');
    expect(log.error).toHaveBeenCalledOnce();
    expect(prompt.select).not.toHaveBeenCalled();
  });

  it('does not treat an existing empty config as a new installation', async () => {
    const target = path.join(root, 'config.json');
    new PrivateStateStore(target).write({});
    prompt.select.mockResolvedValueOnce('save');
    const result = await runSetup({ target, home: root });
    expect(result?.cfg.token).toBeTruthy();
    expect(result?.cfg).not.toHaveProperty('authMode');
    expect(prompt.select).toHaveBeenCalledOnce();
  });

  it('does not write when leaving the setup hub', async () => {
    const target = path.join(root, 'config.json');
    const original = { token: 'current-token', tunnel: 'none', port: 19999 };
    new PrivateStateStore(target).write(original);
    prompt.select.mockResolvedValueOnce(prompt.cancelled);
    expect(await runSetup({ target, home: root })).toBeNull();
    expect(new PrivateStateStore(target).readStrict()).toEqual(original);
  });
});
