// server/test/previews.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs, { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviews, safePreviewName } from '../src/previews.js';

let home, outside, store, clock, previews;
beforeEach(async () => {
  home = await fsp.mkdtemp(join(tmpdir(), 'pvhome-'));
  outside = await fsp.mkdtemp(join(tmpdir(), 'pvout-'));
  await fsp.mkdir(join(home, 'site'));
  await fsp.mkdir(join(home, 'site-2'));
  store = join(home, 'previews.json');
  clock = { t: 1_000_000 };
  previews = createPreviews({
    home,
    store,
    now: () => clock.t,
    ttlMs: 600_000,
    randomToken: () => `preview-token-${clock.t}`,
  });
});
afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

describe('safePreviewName', () => {
  it('accepts a slug, rejects dots/slashes/empty', () => {
    expect(safePreviewName('my-sess_1.2')).toBe('my-sess_1.2');
    expect(safePreviewName('.')).toBeNull();
    expect(safePreviewName('..')).toBeNull();
    expect(safePreviewName('.hidden')).toBeNull();
    expect(safePreviewName('a/b')).toBeNull();
    expect(safePreviewName('')).toBeNull();
    expect(safePreviewName('空格 x')).toBeNull();
  });
  it('lowercases (subdomain hosts are case-insensitive)', () => {
    expect(safePreviewName('jly-Tunlite-0')).toBe('jly-tunlite-0');
  });
});

describe('register', () => {
  it('uses the same two-hour safety lease as browser proxy tabs by default', async () => {
    const defaultLease = createPreviews({
      home,
      store: join(home, 'default-previews.json'),
      now: () => clock.t,
    });
    const out = await defaultLease.register({ name: 'foo', dir: join(home, 'site') });
    expect(out.expiresAt).toBe(clock.t + 2 * 60 * 60_000);
  });
  it('registers a dir under home and returns expiresAt = now + ttl', async () => {
    const out = await previews.register({ name: 'foo', dir: join(home, 'site') });
    expect(out.name).toBe('foo');
    expect(out.kind).toBe('static');
    expect(out.expiresAt).toBe(1_000_000 + 600_000);
    expect(out.accessToken).toBe('preview-token-1000000');
    expect(previews.get('foo').entry.accessToken).toBe(out.accessToken);
    expect(JSON.parse(await fsp.readFile(store, 'utf8'))[0]).not.toHaveProperty('accessToken');
    expect(fs.statSync(store).mode & 0o777).toBe(0o600);
  });
  it('rejects a dir outside home', async () => {
    expect(await previews.register({ name: 'foo', dir: outside })).toMatchObject({ status: 400 });
  });
  it('rejects a missing dir', async () => {
    expect(await previews.register({ name: 'foo', dir: join(home, 'nope') })).toMatchObject({ status: 404 });
  });
  it('rejects a bad name', async () => {
    expect(await previews.register({ name: '../x', dir: join(home, 'site') })).toMatchObject({ status: 400 });
  });
  it('same active name and dir renews without replacing the capability token', async () => {
    const first = await previews.register({ name: 'foo', dir: join(home, 'site') });
    clock.t = 1_500_000;
    const out = await previews.register({ name: 'foo', dir: join(home, 'site') });
    expect(out.expiresAt).toBe(1_500_000 + 600_000);
    expect(previews.list()).toHaveLength(1);
    expect(out.accessToken).toBe(first.accessToken);
  });
  it('same name with a different dir replaces the capability token', async () => {
    const first = await previews.register({ name: 'foo', dir: join(home, 'site') });
    clock.t = 1_500_000;
    const out = await previews.register({ name: 'foo', dir: join(home, 'site-2') });
    expect(out.accessToken).not.toBe(first.accessToken);
    expect(previews.get('foo').entry.dir).toBe(await fsp.realpath(join(home, 'site-2')));
  });
});

describe('get / list / remove', () => {
  it('get renews an active lease from real preview traffic', async () => {
    await previews.register({ name: 'foo', dir: join(home, 'site') });
    clock.t += 30_000;
    expect(previews.get('foo').state).toBe('active');
    expect(previews.list()[0].expiresAt).toBe(clock.t + 600_000);
    clock.t += 600_001;
    expect(previews.get('foo').state).toBe('expired');
    expect(previews.get('foo').state).toBe('missing'); // expired entry was purged
  });
  it('persists traffic renewals at most once per minute', async () => {
    await previews.register({ name: 'foo', dir: join(home, 'site') });
    clock.t += 30_000;
    previews.get('foo');
    expect(JSON.parse(await fsp.readFile(store, 'utf8'))[0].expiresAt).toBe(1_600_000);
    clock.t += 30_000;
    previews.get('foo');
    expect(JSON.parse(await fsp.readFile(store, 'utf8'))[0].expiresAt).toBe(clock.t + 600_000);
  });
  it('get returns missing for unknown name', () => {
    expect(previews.get('nope').state).toBe('missing');
  });
  it('list does not renew leases and purges expired entries', async () => {
    await previews.register({ name: 'a', dir: join(home, 'site') });
    clock.t += 600_001;
    await previews.register({ name: 'b', dir: join(home, 'site') });
    const list = previews.list();
    expect(list.map((e) => e.name)).toEqual(['b']);
  });
  it('remove drops an entry', async () => {
    await previews.register({ name: 'foo', dir: join(home, 'site') });
    previews.remove('foo');
    expect(previews.get('foo').state).toBe('missing');
  });
});

describe('legacy registry migration', () => {
  it('drops old dynamic entries and keeps rows without a kind as static', async () => {
    await fsp.writeFile(store, JSON.stringify([
      { name: 'old-port', kind: 'dynamic', port: 3000, expiresAt: clock.t + 1000 },
      { name: 'old-dir', dir: join(home, 'site'), expiresAt: clock.t + 1000 },
    ]));
    const reloaded = createPreviews({ home, store, now: () => clock.t, ttlMs: 600_000 });
    expect(reloaded.list()).toEqual([
      { name: 'old-dir', kind: 'static', dir: join(home, 'site'), expiresAt: clock.t + 1000 },
    ]);
  });
});
