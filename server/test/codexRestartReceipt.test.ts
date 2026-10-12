import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexRestartReceiptStore } from '../src/agents/codexRestartReceipt.js';
import { PrivateStateStore } from '../src/privateStateStore.js';
import { ConversationService } from '../src/agent-runtime/conversation.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';

const SESSION_ID = '12345678-1234-1234-1234-123456789abc';
const EPOCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function input(overrides: Record<string, unknown> = {}) {
  return {
    pane: {
      paneId: '%1', sessionName: 'work', windowId: '@1', tty: '/dev/ttys001', tmuxEpoch: EPOCH,
    },
    process: {
      tui: {
        pid: 42, startedAt: 1_000, ppid: 41, tty: '/dev/ttys001', executable: '/usr/bin/codex',
        commandLine: '/usr/bin/codex --remote unix:///home/test/.handmux/codex-app/1.sock',
      },
      wrapper: {
        pid: 41, startedAt: 900, ppid: 1, tty: '/dev/ttys001', executable: '/usr/local/bin/node',
        commandLine: '/usr/local/lib/node_modules/handmux/bin/handmux.js codex',
      },
      appServer: {
        pid: 43, startedAt: 1_001, ppid: 41, tty: '/dev/ttys001', executable: '/usr/bin/codex',
        commandLine: '/usr/bin/codex app-server --listen unix:///home/test/.handmux/codex-app/1.sock',
      },
    },
    sessionId: SESSION_ID,
    previousRunId: 'run-1',
    ...overrides,
  };
}

function writeState(file: string, state: unknown): void {
  new PrivateStateStore<unknown>(file).write(state);
}

describe('Codex conversation restart receipts', () => {
  it.each(['claude', 'pi', 'codex'])('isolates corrupt restart state during %s dispatch', async (agentId) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-restart-corrupt-'));
    const file = path.join(directory, 'receipts.json');
    fs.writeFileSync(file, '{broken');
    const receipts = new CodexRestartReceiptStore(file);
    const runs = new AgentRunRuntime();
    const run = await runs.controller(agentId, async () => true).attach({
      paneId: '%1', attachmentId: 'attachment', sessionId: 'session-1', process: { pid: 101 },
    });
    const dispatched: string[] = [];
    const service = new ConversationService({
      runs,
      isSessionRestartPending: ({ agentId, sessionId }) => receipts.isPending(agentId, sessionId),
      activitySource: { read: async () => ({
        activity: 'idle', activeTurn: { state: 'none' }, revision: 1, epoch: run.ref.runId,
      }) },
      adapters: { [agentId]: {
        apiVersion: 1,
        discoverNative: async (target) => ({
          session: { agentId, sessionId: 'session-1' }, run: target as typeof run.ref,
          sourceViewId: 'view', capabilities: { history: true, live: 'poll', sendable: true },
        }),
        readNativePage: async () => ({
          sessionId: 'session-1', sourceViewId: 'view', sourceHistoryToken: 'history', items: [], hasMore: false,
        }),
        dispatchPrompt: async (_run, request) => {
          dispatched.push(request.text);
          return { outcome: 'accepted' };
        },
      } },
    });
    const result = await service.send(run, { clientRequestId: 'request-1', text: 'hello', delivery: 'prompt' });
    expect(result.status).toBe(agentId === 'codex' ? 'queued' : 'accepted');
    expect(dispatched).toEqual(agentId === 'codex' ? [] : ['hello']);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it('persists the exact session and process generations before stop and reloads them', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-restart-receipt-'));
    const file = path.join(directory, 'receipts.json');
    const store = new CodexRestartReceiptStore(file, { now: () => 10_000 });

    const first = store.prepare(input());
    expect(first).toMatchObject({
      agentId: 'codex',
      pane: { paneId: '%1', sessionName: 'work', windowId: '@1', tty: '/dev/ttys001', tmuxEpoch: EPOCH },
      process: {
        tui: { pid: 42, startedAt: 1_000 }, wrapper: { pid: 41, startedAt: 900 },
        appServer: { pid: 43, startedAt: 1_001 },
      },
      sessionId: SESSION_ID,
      command: `handmux codex resume ${SESSION_ID}`,
      phase: 'prepared',
    });
    expect(store.prepare(input())).toEqual(first);

    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      receipts: Array<{ process: {
        tui: Record<string, unknown>; wrapper: Record<string, unknown>; appServer: Record<string, unknown>;
      } }>;
    };
    expect(persisted.receipts[0]?.process.tui).not.toHaveProperty('commandLine');
    expect(persisted.receipts[0]?.process.wrapper).not.toHaveProperty('commandLine');
    expect(persisted.receipts[0]?.process.appServer).toMatchObject({ pid: 43, startedAt: 1_001 });
    expect(persisted.receipts[0]?.process.appServer).not.toHaveProperty('commandLine');
    expect(first.process.tui).not.toHaveProperty('commandLine');
    expect(first.process.wrapper).not.toHaveProperty('commandLine');
    expect(first.process.appServer).not.toHaveProperty('commandLine');

    const restarted = new CodexRestartReceiptStore(file, { now: () => 20_000 });
    expect(restarted.get(first.operationId)).toEqual(first);
    expect(restarted.latestForPane('%1')).toEqual(first);
    expect(restarted.isPending('codex', SESSION_ID)).toBe(true);
  });

  it('removes command lines from receipts persisted by an earlier build', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-restart-receipt-'));
    const file = path.join(directory, 'receipts.json');
    const original = new CodexRestartReceiptStore(file).prepare(input());
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      version: number;
      receipts: Array<{ process: { tui: Record<string, unknown>; wrapper: Record<string, unknown> } }>;
    };
    persisted.receipts[0]!.process.tui.commandLine = input().process.tui.commandLine;
    persisted.receipts[0]!.process.wrapper.commandLine = input().process.wrapper.commandLine;
    writeState(file, persisted);

    const migrated = new CodexRestartReceiptStore(file);

    expect(migrated.get(original.operationId)?.process.tui).not.toHaveProperty('commandLine');
    expect(migrated.get(original.operationId)?.process.wrapper).not.toHaveProperty('commandLine');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('commandLine');
  });

  it('uses guarded phase transitions and only unblocks the queue at ready', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-restart-receipt-'));
    const store = new CodexRestartReceiptStore(path.join(directory, 'receipts.json'));
    const receipt = store.prepare(input());

    expect(store.transition(receipt.operationId, 'prepared', 'stopped').phase).toBe('stopped');
    expect(store.isPending('codex', SESSION_ID)).toBe(true);
    expect(() => store.transition(receipt.operationId, 'prepared', 'ready')).toThrow(/receipt changed/);
    expect(store.transition(receipt.operationId, 'stopped', 'resuming').phase).toBe('resuming');
    expect(store.isPending('codex', SESSION_ID)).toBe(true);
    expect(store.transition(receipt.operationId, 'resuming', 'ready').phase).toBe('ready');
    expect(store.isPending('codex', SESSION_ID)).toBe(false);
  });

  it('does not confuse a pane or process replacement with the same restart operation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-restart-receipt-'));
    const store = new CodexRestartReceiptStore(path.join(directory, 'receipts.json'));
    const original = store.prepare(input());
    const replacement = store.prepare(input({
      pane: { ...input().pane, tmuxEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      process: { ...input().process, tui: { ...input().process.tui, pid: 43, startedAt: 2_000 } },
    }));

    expect(replacement.operationId).not.toBe(original.operationId);
    expect(store.list()).toHaveLength(2);
    expect(store.latestForPane('%1')).toEqual(replacement);
    expect(store.isPending('codex', SESSION_ID)).toBe(true);
  });

  it('fails closed on corrupt persisted state without crashing store construction', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-restart-receipt-'));
    const file = path.join(directory, 'receipts.json');
    fs.writeFileSync(file, '{"version":1,"receipts":[{"bad":true}]}');
    const store = new CodexRestartReceiptStore(file);

    expect(() => store.list()).toThrow(/state is unavailable/);
    expect(() => store.isPending('codex', SESSION_ID)).toThrow(/state is unavailable/);
    expect(() => store.prepare(input())).toThrow(/state is unavailable/);
  });

  it('rejects persisted commands that do not resume the recorded session', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-restart-receipt-'));
    const file = path.join(directory, 'receipts.json');
    const store = new CodexRestartReceiptStore(file);
    store.prepare(input());
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    persisted.receipts[0].command = 'handmux codex resume another-session';
    fs.writeFileSync(file, JSON.stringify(persisted));

    expect(() => new CodexRestartReceiptStore(file).list()).toThrow(/state is unavailable/);
  });

  it('does not commit a receipt until its durable write succeeds', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-restart-receipt-'));
    const file = path.join(directory, 'receipts.json');
    let fail = true;
    const write = vi.fn((state: unknown) => {
      if (fail) {
        fail = false;
        throw new Error('write failed');
      }
      writeState(file, state);
    });
    const store = new CodexRestartReceiptStore(file, { write, now: () => 10_000 });

    expect(() => store.prepare(input())).toThrow(/write failed/);
    expect(store.list()).toEqual([]);
    expect(store.prepare(input()).phase).toBe('prepared');
    expect(write).toHaveBeenCalledTimes(2);
    expect(new CodexRestartReceiptStore(file).list()).toHaveLength(1);
  });

  it('keeps the previous durable phase when a transition write fails', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-restart-receipt-'));
    const file = path.join(directory, 'receipts.json');
    let fail = false;
    const write = (state: unknown): void => {
      if (fail) throw new Error('write failed');
      writeState(file, state);
    };
    const store = new CodexRestartReceiptStore(file, { write });
    const receipt = store.prepare(input());
    fail = true;

    expect(() => store.transition(receipt.operationId, 'prepared', 'stopped')).toThrow(/write failed/);
    expect(store.get(receipt.operationId)?.phase).toBe('prepared');
    expect(new CodexRestartReceiptStore(file).get(receipt.operationId)?.phase).toBe('prepared');
  });
});
