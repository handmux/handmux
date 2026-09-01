import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fsyncDirectorySync, PrivateStateStore } from '../src/privateStateStore.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-private-state-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('PrivateStateStore', () => {
  it('keeps directory fsync strict on POSIX and tolerates only known Windows unsupported errors', () => {
    const unsupported = Object.assign(new Error('directory fsync unsupported'), { code: 'EINVAL' });
    const open = vi.spyOn(fs, 'openSync').mockImplementation(() => { throw unsupported; });
    expect(() => fsyncDirectorySync(home, 'win32')).not.toThrow();
    expect(() => fsyncDirectorySync(home, 'linux')).toThrow(unsupported);
    open.mockRestore();

    const denied = Object.assign(new Error('unexpected'), { code: 'EACCES' });
    const deniedOpen = vi.spyOn(fs, 'openSync').mockImplementation(() => { throw denied; });
    expect(() => fsyncDirectorySync(home, 'win32')).toThrow(denied);
    deniedOpen.mockRestore();

    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw unsupported; });
    const originalClose = fs.closeSync;
    const close = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => originalClose(descriptor));
    expect(() => fsyncDirectorySync(home, 'win32')).not.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    fsync.mockRestore(); close.mockRestore();
  });

  it('writes atomically with private directory and file permissions', () => {
    const file = path.join(home, '.handmux', 'nested', 'state.json');
    const store = new PrivateStateStore<{ token: string }>(file);
    store.write({ token: 'secret' });

    expect(store.read()).toEqual({ token: 'secret' });
    expect(fs.statSync(path.join(home, '.handmux')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['state.json']);
  });

  it('repairs permissions on a legacy file before reading it', () => {
    const directory = path.join(home, '.handmux');
    const file = path.join(directory, 'state.json');
    fs.mkdirSync(directory, { mode: 0o755 });
    fs.writeFileSync(file, '{"token":"secret"}', { mode: 0o644 });

    expect(new PrivateStateStore(file).read()).toEqual({ token: 'secret' });
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('returns null for missing or corrupt JSON and removes idempotently', () => {
    const file = path.join(home, '.handmux', 'state.json');
    const store = new PrivateStateStore(file);
    expect(store.read()).toBeNull();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json');
    expect(store.read()).toBeNull();
    store.remove();
    expect(() => store.remove()).not.toThrow();
  });

  it('keeps a custom shared parent mode unchanged while protecting the file', () => {
    const shared = path.join(home, 'shared');
    const file = path.join(shared, 'custom-config.json');
    fs.mkdirSync(shared, { mode: 0o755 });
    const before = fs.statSync(shared).mode & 0o777;

    new PrivateStateStore(file).write({ token: 'secret' });

    expect(fs.statSync(shared).mode & 0o777).toBe(before);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('offers a strict read for callers that must distinguish corrupt JSON', () => {
    const file = path.join(home, '.handmux', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, 'not json', { mode: 0o644 });
    const store = new PrivateStateStore(file);

    expect(() => store.readStrict()).toThrow();
    expect(store.read()).toBeNull();
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('quarantines a corrupt file without changing its bytes and leaves the live path reusable', () => {
    const file = path.join(home, '.handmux', 'codex-outbox.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json', { mode: 0o644 });
    const store = new PrivateStateStore(file);

    const quarantined = store.quarantine();

    expect(quarantined).toMatch(/codex-outbox\.json\.corrupt\./);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(quarantined!, 'utf8')).toBe('not json');
    expect(fs.statSync(quarantined!).mode & 0o777).toBe(0o600);
    store.write({ version: 1 });
    expect(store.read()).toEqual({ version: 1 });
    expect(store.quarantine()).toMatch(/codex-outbox\.json\.corrupt\./);
    expect(store.quarantine()).toBeNull();
  });
});
