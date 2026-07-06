import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetForCpolar, resolveCpolar, resolveNatapp } from '../src/cli/tunnelClients.js';

describe('assetForCpolar', () => {
  it('maps linux/darwin to a per-arch stable zip url', () => {
    expect(assetForCpolar('linux', 'x64')).toMatchObject({ bin: 'cpolar', file: 'cpolar-stable-linux-amd64.zip' });
    expect(assetForCpolar('linux', 'arm64').file).toBe('cpolar-stable-linux-arm64.zip');
    expect(assetForCpolar('darwin', 'arm64').file).toBe('cpolar-stable-darwin-arm64.zip');
    expect(assetForCpolar('linux', 'x64').url).toMatch(/^https:\/\/www\.cpolar\.com\/.*cpolar-stable-linux-amd64\.zip$/);
  });
  it('has no auto-download url on windows (installer-only)', () => {
    expect(assetForCpolar('win32', 'x64')).toEqual({ bin: 'cpolar.exe', url: null });
  });
});

describe('resolveCpolar / resolveNatapp', () => {
  let home;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-tc-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('resolveCpolar returns the $PATH binary without downloading', async () => {
    const bin = await resolveCpolar(home, { which: () => '/usr/local/bin/cpolar', fetchImpl: () => { throw new Error('no fetch'); } });
    expect(bin).toBe('/usr/local/bin/cpolar');
  });
  it('resolveCpolar reuses an already-downloaded binary in ~/.handmux/bin', async () => {
    const dir = path.join(home, '.handmux', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    const existing = path.join(dir, 'cpolar');
    fs.writeFileSync(existing, 'binary');
    const bin = await resolveCpolar(home, { which: () => null, fetchImpl: () => { throw new Error('no fetch'); } });
    expect(bin).toBe(existing);
  });
  it('resolveCpolar surfaces the friendly manual hint when the download fails', async () => {
    await expect(resolveCpolar(home, { which: () => null, fetchImpl: async () => ({ ok: false, status: 404 }), log: { log: () => {} } }))
      .rejects.toThrow(/cpolar/i);
  });

  it('resolveNatapp returns the $PATH binary', () => {
    expect(resolveNatapp(home, { which: () => '/usr/local/bin/natapp' })).toBe('/usr/local/bin/natapp');
  });
  it('resolveNatapp reuses a binary dropped in ~/.handmux/bin', () => {
    const dir = path.join(home, '.handmux', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    const existing = path.join(dir, process.platform === 'win32' ? 'natapp.exe' : 'natapp');
    fs.writeFileSync(existing, 'binary');
    expect(resolveNatapp(home, { which: () => null })).toBe(existing);
  });
  it('resolveNatapp throws a clear manual-download hint when absent', () => {
    expect(() => resolveNatapp(home, { which: () => null })).toThrow(/natapp/i);
  });
});
