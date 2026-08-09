import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readState, writeState, clearState, isAlive, statePath, lifecycleLockPath,
  acquireLifecycleLock, claudeStatePath, pushStorePath, previewStorePath,
} from '../src/cli/state.js';

let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('state', () => {
  it('round-trips through ~/.handmux/state.json', () => {
    writeState({ supervisorPid: 123, publicUrl: 'x' }, home);
    expect(readState(home)).toEqual({ supervisorPid: 123, publicUrl: 'x' });
    expect(fs.existsSync(statePath(home))).toBe(true);
    expect(fs.statSync(path.dirname(statePath(home))).mode & 0o777).toBe(0o700);
    expect(fs.statSync(statePath(home)).mode & 0o777).toBe(0o600);
  });
  it('readState returns null when missing or corrupt', () => {
    expect(readState(home)).toBeNull();
    fs.mkdirSync(path.dirname(statePath(home)), { recursive: true });
    fs.writeFileSync(statePath(home), 'not json');
    expect(readState(home)).toBeNull();
  });
  it('clearState removes the file and is idempotent', () => {
    writeState({ a: 1 }, home);
    clearState(home);
    expect(readState(home)).toBeNull();
    expect(() => clearState(home)).not.toThrow();
  });
  it('isAlive reports on the current process and rejects bogus pids', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(0)).toBe(false);
    expect(isAlive(2 ** 30)).toBe(false);
  });
  it('lifecycle lock is exclusive and releases only its own lock', () => {
    const release = acquireLifecycleLock(home);
    expect(JSON.parse(fs.readFileSync(lifecycleLockPath(home), 'utf8')).pid).toBe(process.pid);
    expect(() => acquireLifecycleLock(home)).toThrow(/already running/);
    release();
    expect(fs.existsSync(lifecycleLockPath(home))).toBe(false);
  });
  it('lifecycle lock reclaims a dead owner', () => {
    fs.mkdirSync(path.dirname(lifecycleLockPath(home)), { recursive: true });
    fs.writeFileSync(lifecycleLockPath(home), String(2 ** 30));
    const release = acquireLifecycleLock(home);
    expect(JSON.parse(fs.readFileSync(lifecycleLockPath(home), 'utf8')).pid).toBe(process.pid);
    release();
  });
  it('lifecycle lock reclaims an expired stamp even if its pid has been reused', () => {
    fs.mkdirSync(path.dirname(lifecycleLockPath(home)), { recursive: true });
    fs.writeFileSync(lifecycleLockPath(home), JSON.stringify({ pid: process.pid, createdAt: 1 }));
    const release = acquireLifecycleLock(home);
    expect(JSON.parse(fs.readFileSync(lifecycleLockPath(home), 'utf8')).pid).toBe(process.pid);
    release();
  });
  it('claudeStatePath is ~/.handmux/claude-state.json', () => {
    expect(claudeStatePath('/home/x')).toBe('/home/x/.handmux/claude-state.json');
  });
  it('push/preview stores live in ~/.handmux (survive a global reinstall)', () => {
    expect(pushStorePath('/home/x')).toBe('/home/x/.handmux/push-subs.json');
    expect(previewStorePath('/home/x')).toBe('/home/x/.handmux/previews.json');
  });
});
