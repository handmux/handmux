import express from 'express';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request, { type Test } from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiAccountService, createDeepSeekProvider, createMoonshotProvider, ProviderQueryError,
  type ProviderDefinition,
} from '../src/apiAccounts.js';
import { createApiRouter } from '../src/httpApi.js';
import { PrivateStateStore } from '../src/privateStateStore.js';
import { tmpHome } from './tmphome.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
const auth = (value: Test): Test => value.set('Authorization', 'Bearer good');

function runtime(provider: ProviderDefinition, now: () => number = Date.now) {
  const home = tmpHome('hm-api-accounts-'); homes.push(home);
  const file = path.join(home, '.handmux', 'api-accounts.json');
  return { home, file, service: new ApiAccountService({ file, providers: [provider], now }) };
}

function appWith(service: ApiAccountService, apiErrors?: { log: { error: ReturnType<typeof vi.fn> } }) {
  const app = express();
  app.use('/api', createApiRouter({ token: 'good', apiAccounts: service, ...(apiErrors ? { apiErrors } : {}) }));
  return app;
}

const balance = {
  providerType: 'deepseek' as const, isAvailable: true,
  balances: [{ currency: 'CNY', totalBalance: '110.00', toppedUpBalance: '100.00', grantedBalance: '10.00' }],
};

const storedAccount = (name = 'Stored', credential = 'key') => ({
  id: '00000000-0000-4000-8000-000000000001',
  name,
  providerType: 'deepseek' as const,
  credential: { kind: 'apiKey' as const, value: credential },
  credentialVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  latestSuccess: structuredClone(balance),
  lastSuccessAt: 1,
  lastAttemptAt: 1,
  lastErrorCode: null,
});

describe('DeepSeek balance provider', () => {
  it('uses only the fixed official endpoint and maps the official decimal-string response', async () => {
    const sentinel = 'hm-secret-SENTINEL-never-log';
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '110.00', topped_up_balance: '100.00', granted_balance: '10.00' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await createDeepSeekProvider(fetchImpl as typeof fetch)
      .queryBalance({ kind: 'apiKey', value: sentinel }, new AbortController().signal);
    expect(result).toEqual(balance);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.deepseek.com/user/balance', expect.objectContaining({
      method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${sentinel}` },
    }));
  });

  it('turns provider status/body failures into controlled errors without provider text', async () => {
    const unauthorized = createDeepSeekProvider(async () => new Response('secret provider body', { status: 401 }) as never);
    await expect(unauthorized.queryBalance({ kind: 'apiKey', value: 'secret' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_credential', message: 'invalid_credential' });
    const malformed = createDeepSeekProvider(async () => new Response('{"unexpected":true}', { status: 200 }) as never);
    await expect(malformed.queryBalance({ kind: 'apiKey', value: 'secret' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unsupported_response' });
  });
});

describe('Moonshot balance provider', () => {
  it('uses Kimi’s documented CNY balance contract, including negative cash balance', async () => {
    const sentinel = 'hm-moonshot-SENTINEL-never-log';
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0, status: true, scode: '0x0', data: {
        available_balance: 46.5889301, voucher_balance: 46.5889301, cash_balance: -3,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await createMoonshotProvider(fetchImpl as typeof fetch)
      .queryBalance({ kind: 'apiKey', value: sentinel }, new AbortController().signal);
    expect(result).toEqual({
      providerType: 'moonshot', currency: 'CNY',
      availableBalance: 46.5889301, voucherBalance: 46.5889301, cashBalance: -3,
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.moonshot.cn/v1/users/me/balance', expect.objectContaining({
      method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${sentinel}` },
    }));
  });

  it('rejects malformed Kimi balance data without retaining it', async () => {
    const moonshot = createMoonshotProvider(async () => new Response(JSON.stringify({
      code: 0, status: true, scode: '0x0', data: {
        available_balance: -1, voucher_balance: 1, cash_balance: 0,
      },
    })) as never);
    await expect(moonshot.queryBalance({ kind: 'apiKey', value: 'key' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unsupported_response' });
  });
});

describe('API account service and routes', () => {
  it('persists private credentials but returns only views through authenticated generic routes', async () => {
    const sentinel = 'hm-secret-SENTINEL-only-on-disk';
    const queryBalance = vi.fn(async () => balance);
    const { file, service } = runtime({ type: 'deepseek', label: 'DeepSeek', queryBalance });
    const app = appWith(service);

    const unauthorized = await request(app).get('/api/api-accounts').expect(401);
    expect(unauthorized.headers['cache-control']).toBe('no-store');
    expect(unauthorized.body).toEqual({
      error: 'unauthorized', code: 'unauthorized', requestId: expect.any(String),
    });
    const insecure = await auth(request(app).post('/api/api-accounts'))
      .set('Origin', 'http://phone.example').send({
        providerType: 'deepseek', name: 'Production', credential: { kind: 'apiKey', value: sentinel },
      }).expect(403);
    expect(JSON.stringify(insecure.body)).not.toContain(sentinel);
    const created = await auth(request(app).post('/api/api-accounts'))
      .set('Origin', 'http://127.0.0.42').send({
        providerType: 'deepseek', name: ' Production ', credential: { kind: 'apiKey', value: sentinel },
      }).expect(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body).toMatchObject({ name: 'Production', providerType: 'deepseek', credentialConfigured: true, latestSuccess: balance });
    expect(JSON.stringify(created.body)).not.toContain(sentinel);
    expect(JSON.stringify((await auth(request(app).get('/api/api-accounts')).expect(200)).body)).not.toContain(sentinel);
    const firstEnvelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(firstEnvelope).toMatchObject({ version: 2, algorithm: 'aes-256-gcm' });
    expect(fs.readFileSync(file, 'utf8')).not.toContain(sentinel);
    const keyFile = path.join(path.dirname(file), 'api-accounts.key');
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);

    const restarted = new ApiAccountService({
      file, providers: [{ type: 'deepseek', label: 'DeepSeek', queryBalance }],
    });
    expect(restarted.list()).toEqual([created.body]);

    await auth(request(app).post(`/api/api-accounts/${created.body.id}/query`)).expect(200);
    const limited = await auth(request(app).post(`/api/api-accounts/${created.body.id}/query`)).expect(429);
    expect(limited.body).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 10 });
    expect(limited.headers['retry-after']).toBe('10');

    const invalid = await auth(request(app).patch(`/api/api-accounts/${created.body.id}`))
      .set('Origin', 'https://handmux.example').send({ credential: { kind: 'apiKey', value: 'replacement' } });
    expect(invalid.status).toBe(200);
    expect(JSON.stringify(invalid.body)).not.toContain('replacement');
    const secondEnvelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(secondEnvelope.iv).not.toBe(firstEnvelope.iv);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('replacement');
    await auth(request(app).delete(`/api/api-accounts/${created.body.id}`)).expect(204);
    await auth(request(app).get('/api/api-accounts')).expect(200, []);
  });

  it('keeps provider authentication failures separate from Handmux auth and never echoes the key', async () => {
    const sentinel = 'hm-secret-SENTINEL-invalid-provider-key';
    const provider: ProviderDefinition = {
      type: 'deepseek', label: 'DeepSeek',
      async queryBalance() { throw new ProviderQueryError('invalid_credential'); },
    };
    const { file, service } = runtime(provider);
    const app = appWith(service);
    const response = await auth(request(app).post('/api/api-accounts'))
      .set('Origin', 'https://handmux.example').send({
        providerType: 'deepseek', name: 'Invalid', credential: { kind: 'apiKey', value: sentinel },
      }).expect(422);
    expect(response.body).toMatchObject({ code: 'invalid_credential', requestId: expect.any(String) });
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(service.list()).toEqual([]);
  });

  it('strictly validates and atomically migrates an existing plaintext v1 store', () => {
    const provider: ProviderDefinition = { type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; } };
    const home = tmpHome('hm-api-plaintext-'); homes.push(home);
    const file = path.join(home, '.handmux', 'api-accounts.json');
    const sentinel = 'hm-plaintext-SENTINEL-migrate';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: [storedAccount('Existing DeepSeek', sentinel)] }));

    const service = new ApiAccountService({ file, providers: [provider] });
    expect(service.list()).toEqual([expect.objectContaining({ name: 'Existing DeepSeek', credentialConfigured: true })]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ version: 2, algorithm: 'aes-256-gcm' });
    expect(fs.readFileSync(file, 'utf8')).not.toContain(sentinel);
    expect(new ApiAccountService({ file, providers: [provider] }).list()).toEqual(service.list());
  });

  it('keeps plaintext intact and reports unavailable when migration cannot commit', () => {
    const home = tmpHome('hm-api-migration-fail-'); homes.push(home);
    const file = path.join(home, '.handmux', 'api-accounts.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const plaintext = `${JSON.stringify({ version: 1, accounts: [storedAccount('Keep plaintext', 'migration-secret')] })}\n`;
    fs.writeFileSync(file, plaintext);
    const write = vi.spyOn(fs, 'renameSync')
      .mockImplementationOnce(() => { throw new Error('disk full'); });
    const service = new ApiAccountService({ file });
    write.mockRestore();

    expect(() => service.list()).toThrow(expect.objectContaining({ code: 'storage_unavailable' }));
    expect(fs.readFileSync(file, 'utf8')).toBe(plaintext);
    expect(fs.existsSync(`${file}.unavailable`)).toBe(true);
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith('api-accounts.json.corrupt.'))).toBe(false);
  });

  it('does not create a key merely by mounting and creates it on the first persistence attempt', async () => {
    const provider: ProviderDefinition = { type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; } };
    const { file, service } = runtime(provider);
    const keyFile = path.join(path.dirname(file), 'api-accounts.key');
    expect(fs.existsSync(keyFile)).toBe(false);
    await service.create({ providerType: 'deepseek', name: 'First', credential: { kind: 'apiKey', value: 'key' } });
    expect(fs.existsSync(keyFile)).toBe(true);
  });

  it('durably records the key directory before data rename and fsyncs the directory after rename', async () => {
    const provider: ProviderDefinition = { type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; } };
    const { file, service } = runtime(provider);
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const directoryStat = fs.statSync(directory);
    const events: string[] = [];
    const originalFsync = fs.fsyncSync;
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      const stat = fs.fstatSync(descriptor);
      if (stat.isDirectory() && stat.dev === directoryStat.dev && stat.ino === directoryStat.ino) {
        events.push('directory-fsync');
      }
      return originalFsync(descriptor);
    });
    const originalRename = fs.renameSync;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (destination === file) events.push('data-rename');
      return originalRename(source, destination);
    });
    try {
      await service.create({ providerType: 'deepseek', name: 'Durable', credential: { kind: 'apiKey', value: 'key' } });
    } finally {
      fsync.mockRestore(); rename.mockRestore();
    }
    const renameIndex = events.indexOf('data-rename');
    expect(renameIndex).toBeGreaterThan(0);
    expect(events.slice(0, renameIndex)).toContain('directory-fsync');
    expect(events.slice(renameIndex + 1)).toContain('directory-fsync');
  });

  it('restores the exact previous ciphertext when a patch rename is not durably recorded', async () => {
    const provider: ProviderDefinition = {
      type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; },
    };
    const { file, service } = runtime(provider);
    const app = appWith(service);
    const created = await auth(request(app).post('/api/api-accounts'))
      .set('Origin', 'https://handmux.example').send({
        providerType: 'deepseek', name: 'Before', credential: { kind: 'apiKey', value: 'key' },
      }).expect(201);
    const before = fs.readFileSync(file);
    const directory = path.dirname(file);
    const directoryStat = fs.statSync(directory);
    const originalFsync = fs.fsyncSync;
    let directoryFsyncs = 0;
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      const stat = fs.fstatSync(descriptor);
      if (stat.isDirectory() && stat.dev === directoryStat.dev && stat.ino === directoryStat.ino) {
        directoryFsyncs += 1;
        if (directoryFsyncs === 2) throw new Error('directory fsync failed');
      }
      return originalFsync(descriptor);
    });
    let response;
    try {
      response = await auth(request(app).patch(`/api/api-accounts/${created.body.id}`))
        .send({ name: 'After' });
    } finally {
      fsync.mockRestore();
    }

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'storage_unavailable' });
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(`${file}.unavailable`)).toBe(false);
    const restarted = new ApiAccountService({ file, providers: [provider] });
    expect(restarted.list()).toEqual([expect.objectContaining({ name: 'Before' })]);
  });

  it('removes a first data file whose rename is not durably recorded and reuses its complete key', async () => {
    const provider: ProviderDefinition = {
      type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; },
    };
    const { file, service } = runtime(provider);
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const directoryStat = fs.statSync(directory);
    const originalFsync = fs.fsyncSync;
    let directoryFsyncs = 0;
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      const stat = fs.fstatSync(descriptor);
      if (stat.isDirectory() && stat.dev === directoryStat.dev && stat.ino === directoryStat.ino) {
        directoryFsyncs += 1;
        if (directoryFsyncs === 2) throw new Error('directory fsync failed');
      }
      return originalFsync(descriptor);
    });
    let response;
    try {
      response = await auth(request(appWith(service)).post('/api/api-accounts'))
        .set('Origin', 'https://handmux.example').send({
          providerType: 'deepseek', name: 'First try', credential: { kind: 'apiKey', value: 'key' },
        });
    } finally {
      fsync.mockRestore();
    }

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'storage_unavailable' });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.unavailable`)).toBe(false);
    const keyFile = path.join(directory, 'api-accounts.key');
    const key = fs.readFileSync(keyFile);
    expect(key).toHaveLength(32);

    const retry = new ApiAccountService({ file, providers: [provider] });
    const saved = await auth(request(appWith(retry)).post('/api/api-accounts'))
      .set('Origin', 'https://handmux.example').send({
        providerType: 'deepseek', name: 'Retry', credential: { kind: 'apiKey', value: 'key' },
      }).expect(201);
    expect(fs.readFileSync(keyFile)).toEqual(key);
    expect(new ApiAccountService({ file, providers: [provider] }).list()).toEqual([saved.body]);
  });

  it('writes an unavailable marker when restoring the previous ciphertext cannot be confirmed', async () => {
    const provider: ProviderDefinition = {
      type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; },
    };
    const { file, service } = runtime(provider);
    const app = appWith(service);
    const created = await auth(request(app).post('/api/api-accounts'))
      .set('Origin', 'https://handmux.example').send({
        providerType: 'deepseek', name: 'Before', credential: { kind: 'apiKey', value: 'key' },
      }).expect(201);
    const directory = path.dirname(file);
    const directoryStat = fs.statSync(directory);
    const originalFsync = fs.fsyncSync;
    let directoryFsyncs = 0;
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      const stat = fs.fstatSync(descriptor);
      if (stat.isDirectory() && stat.dev === directoryStat.dev && stat.ino === directoryStat.ino) {
        directoryFsyncs += 1;
        if (directoryFsyncs === 2) throw new Error('directory fsync failed');
      }
      return originalFsync(descriptor);
    });
    const originalRename = fs.renameSync;
    let dataRenames = 0;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (destination === file) {
        dataRenames += 1;
        if (dataRenames === 2) throw new Error('rollback rename failed');
      }
      return originalRename(source, destination);
    });
    let response;
    try {
      response = await auth(request(app).patch(`/api/api-accounts/${created.body.id}`))
        .send({ name: 'After' });
    } finally {
      fsync.mockRestore();
      rename.mockRestore();
    }

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'storage_unavailable' });
    expect(dataRenames).toBe(2);
    expect(fs.existsSync(`${file}.unavailable`)).toBe(true);
    const restarted = new ApiAccountService({ file, providers: [provider] });
    expect(() => restarted.list()).toThrow(expect.objectContaining({ code: 'storage_unavailable' }));
  });

  it('keeps a complete orphan key after data failure and safely reuses it on retry', async () => {
    const provider: ProviderDefinition = { type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; } };
    const { file, service } = runtime(provider);
    const keyFile = path.join(path.dirname(file), 'api-accounts.key');
    const originalRename = fs.renameSync;
    const write = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (destination === file) throw new Error('disk full');
      return originalRename(source, destination);
    });
    await expect(service.create({ providerType: 'deepseek', name: 'First try', credential: { kind: 'apiKey', value: 'key' } }))
      .rejects.toMatchObject({ code: 'storage_unavailable' });
    write.mockRestore();
    const orphan = fs.readFileSync(keyFile);
    expect(orphan).toHaveLength(32);

    const retry = new ApiAccountService({ file, providers: [provider] });
    const saved = await retry.create({ providerType: 'deepseek', name: 'Retry', credential: { kind: 'apiKey', value: 'key' } });
    expect(fs.readFileSync(keyFile)).toEqual(orphan);
    expect(new ApiAccountService({ file, providers: [provider] }).list()).toEqual([saved]);
  });

  it('restores exact plaintext when encrypted migration rename is not durably recorded', () => {
    const provider: ProviderDefinition = { type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; } };
    const home = tmpHome('hm-api-migration-fsync-'); homes.push(home);
    const file = path.join(home, '.handmux', 'api-accounts.json');
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const plaintext = `${JSON.stringify({ version: 1, accounts: [storedAccount('Restore plaintext')] })}\n`;
    fs.writeFileSync(file, plaintext);
    const directoryStat = fs.statSync(directory);
    const originalFsync = fs.fsyncSync;
    let directoryFsyncs = 0;
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      const stat = fs.fstatSync(descriptor);
      if (stat.isDirectory() && stat.dev === directoryStat.dev && stat.ino === directoryStat.ino) {
        directoryFsyncs += 1;
        if (directoryFsyncs === 2) throw new Error('directory fsync failed');
      }
      return originalFsync(descriptor);
    });
    const service = new ApiAccountService({ file, providers: [provider] });
    fsync.mockRestore();
    expect(() => service.list()).toThrow(expect.objectContaining({ code: 'storage_unavailable' }));
    expect(fs.readFileSync(file, 'utf8')).toBe(plaintext);
  });

  it('logs only controlled provider failures without response bodies or credentials', async () => {
    const sentinel = 'hm-secret-SENTINEL-never-in-log';
    const provider: ProviderDefinition = {
      type: 'deepseek', label: 'DeepSeek',
      async queryBalance() { throw new ProviderQueryError('provider_unreachable'); },
    };
    const { service } = runtime(provider);
    const log = { error: vi.fn() };
    const response = await auth(request(appWith(service, { log })).post('/api/api-accounts'))
      .set('Origin', 'https://handmux.example').send({
        providerType: 'deepseek', name: 'Unavailable', credential: { kind: 'apiKey', value: sentinel },
      }).expect(502);
    expect(response.body).toMatchObject({ code: 'provider_unreachable' });
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(sentinel);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('Authorization');
  });

  it('keeps old state on failed replacement, merges in-flight queries, and locally rate limits completion', async () => {
    let now = 1_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const provider: ProviderDefinition = {
      type: 'deepseek', label: 'DeepSeek',
      async queryBalance(credential) {
        calls += 1;
        if (credential.value === 'bad') throw new ProviderQueryError('invalid_credential');
        if (calls > 1) await gate;
        return balance;
      },
    };
    const { service } = runtime(provider, () => now);
    const created = await service.create({ providerType: 'deepseek', name: 'One', credential: { kind: 'apiKey', value: 'old' } });
    await expect(service.patch(created.id, { credential: { kind: 'apiKey', value: 'bad' } }))
      .rejects.toMatchObject({ code: 'invalid_credential' });
    expect(service.list()[0]).toMatchObject({ id: created.id, name: 'One', latestSuccess: balance });
    const first = service.query(created.id);
    const second = service.query(created.id);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(calls).toBe(3); // create + failed replacement + one merged refresh
    expect(() => service.query(created.id)).toThrow(expect.objectContaining({ code: 'rate_limited' }));
    now += 10_000;
    await expect(service.query(created.id)).resolves.toMatchObject({ id: created.id });
  });

  it('does not let a slow credential replacement roll back a concurrent rename', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider: ProviderDefinition = {
      type: 'deepseek', label: 'DeepSeek',
      async queryBalance(credential) {
        if (credential.value === 'new-key') await gate;
        return balance;
      },
    };
    const { service } = runtime(provider);
    const created = await service.create({
      providerType: 'deepseek', name: 'Before', credential: { kind: 'apiKey', value: 'old-key' },
    });
    const replacing = service.patch(created.id, { credential: { kind: 'apiKey', value: 'new-key' } });
    await service.patch(created.id, { name: 'Renamed while validating' });
    release();
    await expect(replacing).resolves.toMatchObject({ name: 'Renamed while validating' });
    expect(service.list()[0]?.name).toBe('Renamed while validating');
  });

  it('lets only the first completed concurrent credential replacement commit', async () => {
    const releases = new Map<string, () => void>();
    const gates = new Map(['first-key', 'second-key'].map((key) => [key, new Promise<void>((resolve) => {
      releases.set(key, resolve);
    })]));
    const provider: ProviderDefinition = {
      type: 'deepseek', label: 'DeepSeek',
      async queryBalance(credential) {
        await gates.get(credential.value);
        return { ...balance, balances: [{ ...balance.balances[0]!, totalBalance: credential.value === 'second-key' ? '2.00' : '1.00' }] };
      },
    };
    // The initial key has no gate.
    gates.delete('old-key');
    const { service } = runtime(provider);
    const created = await service.create({
      providerType: 'deepseek', name: 'Concurrent', credential: { kind: 'apiKey', value: 'old-key' },
    });
    const first = service.patch(created.id, { credential: { kind: 'apiKey', value: 'first-key' } });
    const second = service.patch(created.id, { credential: { kind: 'apiKey', value: 'second-key' } });
    releases.get('second-key')!();
    await expect(second).resolves.toMatchObject({ latestSuccess: { balances: [{ totalBalance: '2.00' }] } });
    releases.get('first-key')!();
    await expect(first).rejects.toMatchObject({ code: 'conflict' });
    expect(service.list()[0]).toMatchObject({ latestSuccess: { balances: [{ totalBalance: '2.00' }] } });
  });

  it('turns an old credential query failure into a conflict after replacement', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider: ProviderDefinition = {
      type: 'deepseek', label: 'DeepSeek',
      async queryBalance(credential) {
        if (credential.value === 'old-key') {
          // The create succeeds immediately; only the subsequent query waits.
          if ((provider as ProviderDefinition & { created?: boolean }).created) {
            await gate;
            throw new ProviderQueryError('invalid_credential');
          }
          (provider as ProviderDefinition & { created?: boolean }).created = true;
        }
        return balance;
      },
    };
    const { service } = runtime(provider);
    const created = await service.create({
      providerType: 'deepseek', name: 'Replace during query', credential: { kind: 'apiKey', value: 'old-key' },
    });
    const querying = service.query(created.id);
    await service.patch(created.id, { credential: { kind: 'apiKey', value: 'new-key' } });
    release();
    await expect(querying).rejects.toMatchObject({ code: 'conflict' });
    expect(service.list()[0]).toMatchObject({ lastErrorCode: null, latestSuccess: balance });
  });

  it('rejects unknown stored fields at every envelope layer and keeps them out of responses', async () => {
    const mutations: Array<(raw: Record<string, any>) => void> = [
      (raw) => { raw.unknownFile = 'unknown-SENTINEL'; },
      (raw) => { raw.accounts[0].unknownAccount = 'unknown-SENTINEL'; },
      (raw) => { raw.accounts[0].credential.unknownCredential = 'unknown-SENTINEL'; },
      (raw) => { raw.accounts[0].latestSuccess.unknownResult = 'unknown-SENTINEL'; },
      (raw) => { raw.accounts[0].latestSuccess.balances[0].unknownBalance = 'unknown-SENTINEL'; },
    ];
    for (const mutate of mutations) {
      const home = tmpHome('hm-api-strict-'); homes.push(home);
      const file = path.join(home, '.handmux', 'api-accounts.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const raw: Record<string, any> = { version: 1, accounts: [storedAccount('Strict')] };
      mutate(raw);
      fs.writeFileSync(file, JSON.stringify(raw));
      const restarted = new ApiAccountService({ file, providers: [{ type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; } }] });
      expect(() => restarted.list()).toThrow(expect.objectContaining({ code: 'storage_unavailable' }));
    }
    const sentinel = 'unknown-provider-SENTINEL';
    const { service } = runtime({
      type: 'deepseek', label: 'DeepSeek',
      async queryBalance() { return { ...balance, unknown: sentinel } as typeof balance; },
    });
    await expect(service.create({ providerType: 'deepseek', name: 'No leak', credential: { kind: 'apiKey', value: 'key' } }))
      .rejects.toMatchObject({ code: 'unsupported_response' });
    expect(JSON.stringify(service.list())).not.toContain(sentinel);
  });

  it('uses code points for name limits and refuses to write a 1001st account', async () => {
    const provider: ProviderDefinition = { type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; } };
    const { file, service } = runtime(provider);
    const name64 = '😀'.repeat(64);
    const created = await service.create({ providerType: 'deepseek', name: name64, credential: { kind: 'apiKey', value: 'key' } });
    expect(created.name).toBe(name64);
    expect(new ApiAccountService({ file, providers: [provider] }).list()[0]?.name).toBe(name64);
    await expect(service.create({ providerType: 'deepseek', name: '😀'.repeat(65), credential: { kind: 'apiKey', value: 'key' } }))
      .rejects.toMatchObject({ code: 'invalid_name' });

    const raw = { version: 1, accounts: Array.from({ length: 1000 }, (_value, index) => ({
      ...structuredClone(storedAccount(name64)),
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    })) };
    fs.writeFileSync(file, JSON.stringify(raw));
    const full = new ApiAccountService({ file, providers: [provider] });
    await expect(full.create({ providerType: 'deepseek', name: 'Overflow', credential: { kind: 'apiKey', value: 'key' } }))
      .rejects.toMatchObject({ code: 'account_limit_reached' });
    expect(full.list()).toHaveLength(1000);
  });

  it('maps an account storage write failure to storage_unavailable without retaining the mutation', async () => {
    const provider: ProviderDefinition = { type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; } };
    const { file, service } = runtime(provider);
    const originalRename = fs.renameSync;
    const write = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (destination === file) throw new Error('disk full');
      return originalRename(source, destination);
    });
    await expect(service.create({ providerType: 'deepseek', name: 'No write', credential: { kind: 'apiKey', value: 'key' } }))
      .rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(() => service.list()).toThrow(expect.objectContaining({ code: 'storage_unavailable' }));
    expect(fs.existsSync(`${file}.unavailable`)).toBe(false);
    write.mockRestore();
  });

  it('rejects mutations already queued behind an account storage write failure', async () => {
    const provider: ProviderDefinition = { type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; } };
    const { file, service } = runtime(provider);
    const originalRename = fs.renameSync;
    const write = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (destination === file) throw new Error('disk full');
      return originalRename(source, destination);
    });
    const first = service.create({ providerType: 'deepseek', name: 'First', credential: { kind: 'apiKey', value: 'first' } });
    const queued = service.create({ providerType: 'deepseek', name: 'Queued', credential: { kind: 'apiKey', value: 'second' } });
    await expect(first).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(queued).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();
  });

  it('cancels a disconnected credential validation before it can persist', async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const provider: ProviderDefinition = {
      type: 'deepseek', label: 'DeepSeek',
      queryBalance(_credential, signal) {
        started();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true }));
      },
    };
    const { service } = runtime(provider);
    const pending = auth(request(appWith(service)).post('/api/api-accounts'))
      .set('Origin', 'https://handmux.example').send({
        providerType: 'deepseek', name: 'Cancelled', credential: { kind: 'apiKey', value: 'key' },
      });
    const settled = pending.then(() => undefined, () => undefined);
    await didStart;
    pending.abort();
    await settled;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.list()).toEqual([]);
  });

  it('keeps the old credential result when replacement validation is cancelled', async () => {
    const provider: ProviderDefinition = {
      type: 'deepseek', label: 'DeepSeek',
      queryBalance(credential, signal) {
        if (credential.value === 'old-key') return Promise.resolve(balance);
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true }));
      },
    };
    const { service } = runtime(provider);
    const created = await service.create({
      providerType: 'deepseek', name: 'Keep old', credential: { kind: 'apiKey', value: 'old-key' },
    });
    const controller = new AbortController();
    const replacing = service.patch(
      created.id, { credential: { kind: 'apiKey', value: 'new-key' } }, controller.signal,
    );
    controller.abort();
    await expect(replacing).rejects.toMatchObject({ code: 'request_cancelled' });
    expect(service.list()[0]).toEqual(created);
  });

  it('does not mount or touch an API account Store when the composition root omits it', async () => {
    const home = tmpHome('hm-api-not-mounted-'); homes.push(home);
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', home }));
    await auth(request(app).get('/api/api-accounts')).expect(404);
    expect(fs.existsSync(path.join(home, '.handmux', 'api-accounts.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.handmux', 'api-accounts.key'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.handmux', 'api-accounts.json.unavailable'))).toBe(false);
  });

  it.each([
    ['missing key', (file: string, keyFile: string) => { fs.unlinkSync(keyFile); }],
    ['wrong key', (_file: string, keyFile: string) => { fs.writeFileSync(keyFile, randomBytes(32)); }],
    ['tampered tag', (file: string) => {
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
      envelope.tag = randomBytes(16).toString('base64');
      fs.writeFileSync(file, JSON.stringify(envelope));
    }],
    ['invalid envelope', (file: string) => {
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
      envelope.unknown = true;
      fs.writeFileSync(file, JSON.stringify(envelope));
    }],
  ])('rejects encrypted storage with a %s and never creates or replaces its key', async (_name, damage) => {
    const provider: ProviderDefinition = { type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; } };
    const { file, service } = runtime(provider);
    await service.create({ providerType: 'deepseek', name: 'Encrypted', credential: { kind: 'apiKey', value: 'secret' } });
    const keyFile = path.join(path.dirname(file), 'api-accounts.key');
    damage(file, keyFile);
    const keyBefore = fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : null;

    const restarted = new ApiAccountService({ file, providers: [provider] });
    expect(() => restarted.list()).toThrow(expect.objectContaining({ code: 'storage_unavailable' }));
    expect(fs.existsSync(keyFile)).toBe(keyBefore !== null);
    if (keyBefore) expect(fs.readFileSync(keyFile)).toEqual(keyBefore);
  });

  it('quarantines the whole corrupt file and reports storage unavailable', async () => {
    const home = tmpHome('hm-api-corrupt-'); homes.push(home);
    const directory = path.join(home, '.handmux');
    const file = path.join(directory, 'api-accounts.json');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: [{ bad: true }] }));
    const service = new ApiAccountService({ file, providers: [{ type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; } }] });
    expect(() => service.list()).toThrow(expect.objectContaining({ code: 'storage_unavailable' }));
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(directory).some((name) => name.startsWith('api-accounts.json.corrupt.'))).toBe(true);
    const restarted = new ApiAccountService({ file, providers: [{ type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; } }] });
    expect(() => restarted.list()).toThrow(expect.objectContaining({ code: 'storage_unavailable' }));
  });

  it('uses the quarantined primary as the restart sentinel when marker persistence fails', () => {
    const home = tmpHome('hm-api-marker-write-'); homes.push(home);
    const directory = path.join(home, '.handmux');
    const file = path.join(directory, 'api-accounts.json');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, '{"version":1,"accounts":[{"bad":true}]}');
    const markerWrite = vi.spyOn(PrivateStateStore.prototype, 'write')
      .mockImplementationOnce(() => { throw new Error('disk full'); });
    const failed = new ApiAccountService({ file });
    expect(() => failed.list()).toThrow(expect.objectContaining({ code: 'storage_unavailable' }));
    expect(fs.existsSync(`${file}.unavailable`)).toBe(false);
    expect(fs.readdirSync(directory).some((name) => name.startsWith('api-accounts.json.corrupt.'))).toBe(true);
    markerWrite.mockRestore();

    const restarted = new ApiAccountService({ file });
    expect(() => restarted.list()).toThrow(expect.objectContaining({ code: 'storage_unavailable' }));
  });

  it('does not quarantine a primary file when the unavailable marker is damaged', async () => {
    const provider: ProviderDefinition = { type: 'deepseek', label: 'DeepSeek', async queryBalance() { return balance; } };
    const { file, service } = runtime(provider);
    await service.create({ providerType: 'deepseek', name: 'Recovered', credential: { kind: 'apiKey', value: 'key' } });
    fs.writeFileSync(`${file}.unavailable`, '{broken marker');

    const restarted = new ApiAccountService({ file, providers: [provider] });
    expect(() => restarted.list()).toThrow(expect.objectContaining({ code: 'storage_unavailable' }));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith('api-accounts.json.corrupt.'))).toBe(false);
  });
});
