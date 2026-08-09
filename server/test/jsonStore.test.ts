import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonArray, writeJsonAtomic } from '../src/jsonStore.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-json-store-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('private JSON array store', () => {
  it('repairs a legacy registry and atomically replaces it with private permissions', () => {
    const directory = path.join(home, '.handmux', 'notifications');
    const file = path.join(directory, 'device.json');
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, '[{"title":"old"}]', { mode: 0o644 });

    expect(readJsonArray(file)).toEqual([{ title: 'old' }]);
    expect(fs.statSync(path.join(home, '.handmux')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    writeJsonAtomic(file, [{ title: 'new' }]);
    expect(readJsonArray(file)).toEqual([{ title: 'new' }]);
    expect(fs.readdirSync(directory)).toEqual(['device.json']);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('degrades missing, corrupt, and non-array values to an empty array', () => {
    const file = path.join(home, '.handmux', 'push.json');
    expect(readJsonArray(file)).toEqual([]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json', { mode: 0o600 });
    expect(readJsonArray(file)).toEqual([]);
    writeJsonAtomic(file, { not: 'an array' });
    expect(readJsonArray(file)).toEqual([]);
  });
});
