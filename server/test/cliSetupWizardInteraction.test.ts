import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prompt = vi.hoisted(() => ({
  cancelled: Symbol('cancelled'),
  select: vi.fn(),
  confirm: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  select: prompt.select,
  confirm: prompt.confirm,
  text: prompt.text,
  password: prompt.password,
  intro: prompt.intro,
  outro: prompt.outro,
  note: prompt.note,
  cancel: prompt.cancel,
  isCancel: (value: unknown) => value === prompt.cancelled,
}));

import { runSetup } from '../src/cli/setupWizard.js';
import { PrivateStateStore } from '../src/privateStateStore.js';

describe('setup wizard interaction cancellation', () => {
  let root = '';
  let ttyDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'handmux-setup-cancel-'));
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    vi.resetAllMocks();
    // Exhausted scripts cancel the prompt, never spin a setup hub or silently save.
    prompt.select.mockResolvedValue(prompt.cancelled);
    prompt.confirm.mockResolvedValue(prompt.cancelled);
    prompt.text.mockResolvedValue(prompt.cancelled);
    vi.stubEnv('HANDMUX_AUTH_MODE', undefined);
    vi.stubEnv('HANDMUX_TOKEN', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('recommends trusted-device on genuinely new setup and saves that default', async () => {
    const target = path.join(root, 'config.json');
    prompt.select.mockResolvedValueOnce('en').mockResolvedValueOnce('none')
      .mockResolvedValueOnce('trusted-device').mockResolvedValueOnce('save');
    const result = await runSetup({ target, home: root });
    expect(result?.cfg.authMode).toBe('trusted-device');
    expect(prompt.select.mock.calls.find(([options]) => options.options?.some((row: { value: string }) => row.value === 'trusted-device'))?.[0].initialValue).toBe('trusted-device');
    expect(prompt.confirm).not.toHaveBeenCalled();
  });

  it('does not treat an existing empty config as a new installation', async () => {
    const target = path.join(root, 'config.json');
    new PrivateStateStore(target).write({});
    prompt.select.mockResolvedValueOnce('save');
    expect((await runSetup({ target, home: root }))?.cfg.authMode).toBe('token');
    expect(prompt.select).toHaveBeenCalledOnce();
  });

  it('respects explicit environment token mode on new setup', async () => {
    vi.stubEnv('HANDMUX_AUTH_MODE', 'token');
    const target = path.join(root, 'config.json');
    prompt.select.mockResolvedValueOnce('en').mockResolvedValueOnce('none')
      .mockResolvedValueOnce('token').mockResolvedValueOnce(prompt.cancelled).mockResolvedValueOnce('save');
    expect((await runSetup({ target, home: root }))?.cfg.authMode).toBe('token');
    expect(prompt.select.mock.calls.find(([options]) => options.options?.some((row: { value: string }) => row.value === 'trusted-device'))?.[0].initialValue).toBe('token');
    expect(prompt.confirm).not.toHaveBeenCalled();
  });

  it.each(['file', 'env'])('refuses invalid explicit authMode from %s without writing', async (source) => {
    const target = path.join(root, 'config.json');
    if (source === 'file') new PrivateStateStore(target).write({ authMode: 'invalid' });
    else vi.stubEnv('HANDMUX_AUTH_MODE', 'invalid');
    const log = { log: vi.fn(), error: vi.fn() };
    expect(await runSetup({ target, home: root, log })).toBeNull();
    expect(log.error).toHaveBeenCalledOnce();
    expect(prompt.select).not.toHaveBeenCalled();
    if (source === 'file') expect(new PrivateStateStore(target).readStrict()).toEqual({ authMode: 'invalid' });
    else expect(fs.existsSync(target)).toBe(false);
  });

  it('reads persisted disable state instead of re-enabling from a stale config', async () => {
    const target = path.join(root, 'config.json');
    new PrivateStateStore(target).write({ authMode: 'token', token: 'legacy-token' });
    prompt.select.mockResolvedValueOnce('auth').mockResolvedValueOnce('trusted-device').mockResolvedValueOnce('save');
    prompt.confirm.mockResolvedValueOnce(true); prompt.text.mockResolvedValueOnce('DISABLE TOKEN');
    expect((await runSetup({ target, home: root }))?.cfg.authMode).toBe('trusted-device');
    new PrivateStateStore(target).write({ authMode: 'token', token: 'legacy-token' });
    prompt.select.mockResolvedValueOnce('save');
    expect((await runSetup({ target, home: root }))?.cfg.authMode).toBe('trusted-device');
  });

  it.each([false, prompt.cancelled])('cancelling fixed Token disable never writes or restarts: %s', async (answer) => {
    const target = path.join(root, 'config.json');
    new PrivateStateStore(target).write({ authMode: 'token', token: 'legacy-token' });
    const before = fs.readFileSync(target, 'utf8');
    prompt.select.mockResolvedValueOnce('auth').mockResolvedValueOnce('trusted-device').mockResolvedValueOnce(prompt.cancelled);
    prompt.confirm.mockResolvedValueOnce(answer);
    expect(await runSetup({ target, home: root })).toBeNull();
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    expect(prompt.confirm.mock.calls[0]?.[0].initialValue).toBe(false);
  });

  it('does not create or mutate the auth database when enabling is canceled', async () => {
    const target = path.join(root, 'config.json');
    new PrivateStateStore(target).write({ authMode: 'trusted-device', token: 'legacy-token' });
    const databasePath = path.join(root, '.handmux', 'handmux.sqlite');
    prompt.select.mockResolvedValueOnce('auth').mockResolvedValueOnce('token')
      .mockResolvedValueOnce(prompt.cancelled).mockResolvedValueOnce(prompt.cancelled);
    prompt.confirm.mockResolvedValueOnce(true);
    expect(await runSetup({ target, home: root })).toBeNull();
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it('disables offline only after the empty-device phrase and preserves the credential', async () => {
    const target = path.join(root, 'config.json');
    new PrivateStateStore(target).write({ lang: 'en', token: 'legacy-token' });
    prompt.select.mockResolvedValueOnce('auth').mockResolvedValueOnce('trusted-device').mockResolvedValueOnce('save');
    prompt.confirm.mockResolvedValueOnce(true); prompt.text.mockResolvedValueOnce('DISABLE TOKEN');
    expect(await runSetup({ target, home: root })).toMatchObject({ cfg: { authMode: 'trusted-device', token: 'legacy-token' }, start: false });
    expect(prompt.note.mock.calls.some(([message]) => message.includes('independent SSH'))).toBe(true);
    expect(prompt.text.mock.calls[0]?.[0].message).toContain('DISABLE TOKEN');
  });

  it('enables fixed Token offline after warning and keeps credential editing in the subpage', async () => {
    const target = path.join(root, 'config.json');
    new PrivateStateStore(target).write({ authMode: 'trusted-device', token: 'legacy-token' });
    prompt.select.mockResolvedValueOnce('auth').mockResolvedValueOnce('token')
      .mockResolvedValueOnce('custom').mockResolvedValueOnce(prompt.cancelled).mockResolvedValueOnce('save');
    prompt.confirm.mockResolvedValueOnce(true); prompt.text.mockResolvedValueOnce('new-fixed-token');
    expect((await runSetup({ target, home: root }))?.cfg).toMatchObject({ authMode: 'token', token: 'new-fixed-token' });
    expect(prompt.confirm.mock.calls[0]?.[0].initialValue).toBe(false);
    // Database state overrides the old config on the next invocation.
    new PrivateStateStore(target).write({ authMode: 'trusted-device', token: 'new-fixed-token' });
    prompt.select.mockResolvedValueOnce('save');
    expect((await runSetup({ target, home: root }))?.cfg.authMode).toBe('token');
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
});
