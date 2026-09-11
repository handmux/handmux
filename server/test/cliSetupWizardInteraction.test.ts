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
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    fs.rmSync(root, { recursive: true, force: true });
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
