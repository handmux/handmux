import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePushArgs, runPush, type PushFetch } from '../src/cli/pushCmd.js';
import { writeState } from '../src/cli/state.js';

describe('parsePushArgs', () => {
  it('reads title/body positionally and collects repeated --session/--device', () => {
    const r = parsePushArgs(['push', 'T', 'B', '--session', 'a', '--session', 'b', '--tag', 'x', '--url', '/u']);
    expect(r).toMatchObject({ title: 'T', body: 'B', sessions: ['a', 'b'], tag: 'x', url: '/u' });
  });
  it('splits a comma-separated --session', () => {
    expect(parsePushArgs(['push', 'T', 'B', '--session', 'a,b']).sessions).toEqual(['a', 'b']);
  });
  it('collects multiple --device', () => {
    expect(parsePushArgs(['push', 'T', 'B', '--device', 'k1', '--device', 'k2']).devices).toEqual(['k1', 'k2']);
  });
  it('errors when title or body missing', () => {
    expect(parsePushArgs(['push', 'onlytitle']).error).toBeTruthy();
  });
  it('errors when both --session and --device are given (mutex)', () => {
    expect(parsePushArgs(['push', 'T', 'B', '--session', 'a', '--device', 'k']).error).toMatch(/session|device/);
  });
  it('rejects a non-web --url protocol before contacting the server', () => {
    expect(parsePushArgs(['push', 'T', 'B', '--url', 'javascript:alert(1)']).error).toMatch(/url/i);
  });
});

describe('runPush', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hmpush-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('errors (non-zero) when the server is not running', async () => {
    const errs: string[] = [];
    const code = await runPush({ argv: ['push', 't', 'b'], home, err: (m) => errs.push(m), log: () => {} });
    expect(code).not.toBe(0);
    expect(errs.join(' ')).toMatch(/start/i);
  });

  it('POSTs to the running server with token + body, prints result', async () => {
    writeState({ localUrl: 'http://localhost:12345', token: 'tok' }, home);
    let captured: { url: string; opts: Parameters<PushFetch>[1] } | undefined;
    const fetchImpl: PushFetch = async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => ({ sent: 1, configured: true }) }; };
    const logs: string[] = [];
    const code = await runPush({ argv: ['push', 't', 'b', '--device', 'k1'], home, fetchImpl, log: (m) => logs.push(m), err: () => {} });
    expect(code).toBe(0);
    if (!captured) throw new Error('push request was not captured');
    expect(captured.url).toBe('http://localhost:12345/api/push/send-local');
    expect(captured.opts.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(captured.opts.body)).toMatchObject({ title: 't', body: 'b', devices: ['k1'] });
    expect(logs.join(' ')).toMatch(/1/);
  });

  it('returns non-zero when no notification was delivered', async () => {
    writeState({ localUrl: 'http://localhost:12345', token: 'tok' }, home);
    const fetchImpl: PushFetch = async () => ({ ok: true, json: async () => ({ configured: true, sent: 0, failed: 0, gone: 0 }) });
    const logs: string[] = []; const errs: string[] = [];
    const code = await runPush({ argv: ['push', 't', 'b'], home, fetchImpl, log: (m) => logs.push(m), err: (m) => errs.push(m) });
    expect(code).not.toBe(0);
    expect(logs).toEqual([]);
    expect(errs.join(' ')).toMatch(/no notification|sent: 0/i);
  });

  it('returns non-zero with complete counts when every delivery fails', async () => {
    writeState({ localUrl: 'http://localhost:12345', token: 'tok' }, home);
    const fetchImpl: PushFetch = async () => ({ ok: true, json: async () => ({ configured: true, sent: 0, failed: 2, gone: 1 }) });
    const errs: string[] = [];
    const code = await runPush({ argv: ['push', 't', 'b'], home, fetchImpl, log: () => {}, err: (m) => errs.push(m) });
    expect(code).not.toBe(0);
    expect(errs.join(' ')).toMatch(/sent: 0.*failed: 2.*gone: 1/i);
  });

  it('returns non-zero and reports partial delivery', async () => {
    writeState({ localUrl: 'http://localhost:12345', token: 'tok' }, home);
    const fetchImpl: PushFetch = async () => ({ ok: true, json: async () => ({ configured: true, sent: 2, failed: 1, gone: 1 }) });
    const logs: string[] = []; const errs: string[] = [];
    const code = await runPush({ argv: ['push', 't', 'b'], home, fetchImpl, log: (m) => logs.push(m), err: (m) => errs.push(m) });
    expect(code).not.toBe(0);
    expect(logs).toEqual([]);
    expect(errs.join(' ')).toMatch(/partial.*sent: 2.*failed: 1.*gone: 1/i);
  });

  it('returns zero only when at least one delivery succeeds and none fail', async () => {
    writeState({ localUrl: 'http://localhost:12345', token: 'tok' }, home);
    const fetchImpl: PushFetch = async () => ({ ok: true, json: async () => ({ configured: true, sent: 2, failed: 0, gone: 0 }) });
    const logs: string[] = [];
    const code = await runPush({ argv: ['push', 't', 'b'], home, fetchImpl, log: (m) => logs.push(m), err: () => {} });
    expect(code).toBe(0);
    expect(logs.join(' ')).toMatch(/sent: 2.*failed: 0.*gone: 0/i);
  });
});
