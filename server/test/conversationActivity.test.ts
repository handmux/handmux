import { describe, expect, it } from 'vitest';
import { RuntimeConversationActivitySource } from '../src/agent-runtime/conversationActivity.js';
import type { ConversationActivity } from '../src/agent-runtime/conversationTypes.js';
import type { AgentRunLease } from '../src/agent-runtime/run.js';

interface RawActivity {
  activity: ConversationActivity;
  activeTurn: { state: 'active'; nativeTurnId: string } | { state: 'none' };
  completionToken?: string;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function lease(runId: string, abort = new AbortController()): AgentRunLease {
  return {
    ref: { agentId: 'test', paneId: '%1', runId, sessionId: 'session-1' },
    signal: abort.signal,
  };
}

describe('RuntimeConversationActivitySource read ordering', () => {
  it('keeps the newer same-owner read when two provider reads complete in reverse order', async () => {
    const older = deferred<RawActivity>();
    const newer = deferred<RawActivity>();
    let calls = 0;
    const source = new RuntimeConversationActivitySource({
      test: { read: async () => (++calls === 1 ? older.promise : newer.promise) },
    });
    const run = lease('run-1');
    const first = source.read(run);
    const second = source.read(run);
    newer.resolve({
      activity: 'idle', activeTurn: { state: 'none' }, completionToken: 'completed:2',
    });
    const current = await second;
    older.resolve({
      activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-old' },
      completionToken: 'completed:1',
    });
    expect(await first).toEqual(current);
    expect(current).toEqual({
      activity: 'idle', activeTurn: { state: 'none' }, completionToken: 'completed:2',
      revision: 1, epoch: 'run-1',
    });
  });

  it('drops a revoked old-epoch completion after the replacement run has published', async () => {
    const older = deferred<RawActivity>();
    const newer = deferred<RawActivity>();
    let calls = 0;
    const source = new RuntimeConversationActivitySource({
      test: { read: async () => (++calls === 1 ? older.promise : newer.promise) },
    });
    const oldAbort = new AbortController();
    const oldRead = source.read(lease('run-old', oldAbort));
    const newRead = source.read(lease('run-new'));
    newer.resolve({
      activity: 'idle', activeTurn: { state: 'none' }, completionToken: 'completed:new',
    });
    const current = await newRead;
    oldAbort.abort();
    older.resolve({
      activity: 'working', activeTurn: { state: 'active', nativeTurnId: 'turn-old' },
      completionToken: 'completed:old',
    });
    expect(await oldRead).toEqual(current);
    expect(current).toMatchObject({ epoch: 'run-new', revision: 1, completionToken: 'completed:new' });
  });

  it('does not roll back an advanced completion token with a late older snapshot', async () => {
    const older = deferred<RawActivity>();
    const newer = deferred<RawActivity>();
    let calls = 0;
    const source = new RuntimeConversationActivitySource({
      test: { read: async () => (++calls === 1 ? older.promise : newer.promise) },
    });
    const run = lease('run-1');
    const first = source.read(run);
    const second = source.read(run);
    newer.resolve({
      activity: 'idle', activeTurn: { state: 'none' }, completionToken: 'completed:2',
    });
    const advanced = await second;
    older.resolve({
      activity: 'idle', activeTurn: { state: 'none' }, completionToken: 'completed:1',
    });
    expect(await first).toEqual(advanced);
    expect(advanced.completionToken).toBe('completed:2');
  });
});
