import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrivateStateStore } from '../src/privateStateStore.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-private-state-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('PrivateStateStore', () => {
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
});
