import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CodexActivationReceiptStore,
} from '../src/agents/codexActivationReceipt.js';
import { PrivateStateStore } from '../src/privateStateStore.js';

const SESSION_ID = '12345678-1234-1234-1234-123456789abc';

function input(overrides: Record<string, unknown> = {}) {
  return {
    pane: {
      paneId: '%1', sessionName: 'work', windowId: '@1',
      tmuxEpoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    process: {
      pid: 42, startedAt: 1_000, tty: '/dev/ttys001', executable: '/usr/bin/codex',
    },
    sessionId: SESSION_ID,
    command: `handmux codex resume ${SESSION_ID}`,
    ...overrides,
  };
}

function writeState(file: string, state: unknown): void {
  new PrivateStateStore<unknown>(file).write(state);
}

describe('Codex activation recovery receipts', () => {
  it('persists before interruption and reloads the same idempotent receipt after restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-receipt-'));
    const file = path.join(directory, 'receipts.json');
    const store = new CodexActivationReceiptStore(file, { now: () => 10_000 });
    const first = store.prepare(input());
    const duplicate = store.prepare(input());
    expect(duplicate).toEqual(first);
    expect(first.agentId).toBe('codex');
    expect(first.operationId).toBe(crypto.createHash('sha256').update(JSON.stringify({
      agentId: 'codex',
      ...input(),
    })).digest('hex'));
    expect(first.phase).toBe('prepared');

    const restarted = new CodexActivationReceiptStore(file, { now: () => 20_000 });
    expect(restarted.latestForPane('%1')).toEqual(first);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.receipts).toHaveLength(1);
    expect(persisted.receipts[0].agentId).toBe('codex');
  });

  it('uses compare-and-set transitions and clears only the matching managed session', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-receipt-'));
    const store = new CodexActivationReceiptStore(path.join(directory, 'receipts.json'), {
      now: (() => { let now = 10_000; return () => ++now; })(),
    });
    const receipt = store.prepare(input());
    expect(store.transition(receipt.operationId, 'prepared', 'interrupted').phase).toBe('interrupted');
    expect(() => store.transition(receipt.operationId, 'prepared', 'resuming'))
      .toThrow(/receipt changed/);
    expect(store.transition(receipt.operationId, ['interrupted', 'resuming'], 'resuming').phase)
      .toBe('resuming');
    expect(store.clearManaged('%1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(false);
    expect(store.clearManaged('%1', SESSION_ID)).toBe(true);
    expect(store.latestForPane('%1')).toBeNull();
  });

  it('keeps a reused pane epoch as a separate stale recovery record', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-receipt-'));
    const store = new CodexActivationReceiptStore(path.join(directory, 'receipts.json'));
    const old = store.prepare(input());
    const current = store.prepare(input({
      pane: { ...input().pane, tmuxEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      process: { ...input().process, pid: 43, startedAt: 2_000 },
    }));
    expect(current.operationId).not.toBe(old.operationId);
    expect(store.list()).toHaveLength(2);
    expect(store.latestForPane('%1')).toEqual(current);
  });

  it('fails closed on corrupt persisted state without crashing construction', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-receipt-'));
    const file = path.join(directory, 'receipts.json');
    fs.writeFileSync(file, '{"version":1,"receipts":[{"bad":true}]}');
    const store = new CodexActivationReceiptStore(file);
    expect(() => store.list()).toThrow(/state is unavailable/);
    expect(() => store.prepare(input())).toThrow(/state is unavailable/);
  });

  it('rejects a persisted receipt that claims another Agent', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-receipt-'));
    const file = path.join(directory, 'receipts.json');
    const store = new CodexActivationReceiptStore(file);
    store.prepare(input());
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    persisted.receipts[0].agentId = 'claude';
    fs.writeFileSync(file, JSON.stringify(persisted));

    const reopened = new CodexActivationReceiptStore(file);
    expect(() => reopened.list()).toThrow(/state is unavailable/);
  });

  it('does not commit prepare in memory until the state write succeeds', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-receipt-'));
    const file = path.join(directory, 'receipts.json');
    let fail = true;
    const write = vi.fn((state: unknown) => {
      if (fail) {
        fail = false;
        throw new Error('write failed');
      }
      writeState(file, state);
    });
    const store = new CodexActivationReceiptStore(file, { write, now: () => 10_000 });

    expect(() => store.prepare(input())).toThrow(/write failed/);
    expect(store.list()).toEqual([]);
    expect(store.prepare(input()).phase).toBe('prepared');
    expect(write).toHaveBeenCalledTimes(2);
    expect(new CodexActivationReceiptStore(file).list()).toHaveLength(1);
  });

  it('keeps the old phase in memory and on disk when transition write fails', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-receipt-'));
    const file = path.join(directory, 'receipts.json');
    let fail = false;
    const write = (state: unknown): void => {
      if (fail) throw new Error('write failed');
      writeState(file, state);
    };
    const store = new CodexActivationReceiptStore(file, { write });
    const receipt = store.prepare(input());
    fail = true;

    expect(() => store.transition(receipt.operationId, 'prepared', 'interrupted'))
      .toThrow(/write failed/);
    expect(store.get(receipt.operationId)?.phase).toBe('prepared');
    expect(new CodexActivationReceiptStore(file).get(receipt.operationId)?.phase).toBe('prepared');
  });

  it('keeps a managed receipt in memory and on disk when its removal write fails', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-receipt-'));
    const file = path.join(directory, 'receipts.json');
    let fail = false;
    const write = (state: unknown): void => {
      if (fail) throw new Error('write failed');
      writeState(file, state);
    };
    const store = new CodexActivationReceiptStore(file, { write });
    const receipt = store.prepare(input());
    fail = true;

    expect(() => store.clearManaged('%1', SESSION_ID)).toThrow(/write failed/);
    expect(store.get(receipt.operationId)).not.toBeNull();
    expect(new CodexActivationReceiptStore(file).get(receipt.operationId)).not.toBeNull();
  });

  it('does not commit memory when directory fsync cannot confirm durability', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-receipt-'));
    const file = path.join(directory, 'receipts.json');
    let fail = true;
    const fsyncDirectory = vi.fn(() => {
      if (fail) {
        fail = false;
        throw new Error('directory fsync failed');
      }
    });
    const store = new CodexActivationReceiptStore(file, { fsyncDirectory });

    expect(() => store.prepare(input())).toThrow(/directory fsync failed/);
    expect(store.list()).toEqual([]);
    expect(store.prepare(input()).phase).toBe('prepared');
    expect(fsyncDirectory).toHaveBeenCalledTimes(2);
  });

});
