import { describe, expect, it, vi } from 'vitest';
import { AgentConversationControlService } from '../src/agent-runtime/conversationControls.js';
import type { AgentRunLease } from '../src/agent-runtime/run.js';
import { createCodexConversationControls } from '../src/agents/codexConversationControls.js';
import { createPiConversationContextAdapter } from '../src/agents/piConversationContext.js';

const run: AgentRunLease = {
  ref: { agentId: 'future-agent', paneId: '%1', runId: 'run-1', sessionId: 'session-1' },
  signal: new AbortController().signal,
};

describe('AgentConversationControlService capability isolation', () => {
  it('reads context without permission and permission without context', async () => {
    const contextOnly = new AgentConversationControlService({
      'future-agent': { context: {
        apiVersion: 1, read: vi.fn(async () => ({ activity: 'idle' as const })),
      } },
    });
    expect(await contextOnly.read(run)).toEqual({ context: { activity: 'idle' } });

    const permissionOnly = new AgentConversationControlService({
      'future-agent': { permission: {
        apiVersion: 1,
        read: vi.fn(async () => ({
          mode: 'default' as const, options: ['default' as const, 'auto-review' as const],
        })),
        update: vi.fn(async (_run, mode) => ({
          mode, options: ['default' as const, 'auto-review' as const],
        })),
      } },
    });
    expect(await permissionOnly.read(run)).toEqual({
      permission: { mode: 'default', options: ['default', 'auto-review'] },
      permissionCanUpdate: true,
    });
    await expect(permissionOnly.permissionAction(run, {
      action: 'set_permission', permissionMode: 'auto-review',
    })).resolves.toMatchObject({ mode: 'auto-review' });
  });

  it('preserves fail-closed unknown activity in the public context snapshot', async () => {
    const service = new AgentConversationControlService({
      'future-agent': { context: {
        apiVersion: 1, read: vi.fn(async () => ({ activity: 'unknown' as const })),
      } },
    });

    await expect(service.read(run)).resolves.toEqual({ context: { activity: 'unknown' } });
  });

  it('isolates a permission slot failure from a healthy context slot', async () => {
    const service = new AgentConversationControlService({
      'future-agent': {
        context: {
          apiVersion: 1,
          read: vi.fn(async () => ({ activity: 'working' as const, cwd: '/work' })),
        },
        permission: { apiVersion: 1, read: vi.fn(async () => {
          throw new Error('/private/provider.sock RPC payload');
        }) },
      },
    });
    const snapshot = await service.read(run);
    expect(snapshot.context).toEqual({ activity: 'working', cwd: '/work' });
    expect(snapshot.slotErrors).toEqual({ permission: 'temporarily unavailable' });
    expect(JSON.stringify(snapshot)).not.toContain('/private/provider.sock');
  });

  it('isolates a context slot failure from a healthy permission slot', async () => {
    const service = new AgentConversationControlService({
      'future-agent': {
        context: { apiVersion: 1, read: vi.fn(async () => {
          throw new Error('/private/rollout.jsonl read failure');
        }) },
        permission: {
          apiVersion: 1,
          read: vi.fn(async () => ({ mode: 'default' as const, options: ['default' as const] })),
        },
      },
    });
    const snapshot = await service.read(run);
    expect(snapshot.permission).toEqual({ mode: 'default', options: ['default'] });
    expect(snapshot.slotErrors).toEqual({ context: 'temporarily unavailable' });
    expect(JSON.stringify(snapshot)).not.toContain('/private/rollout.jsonl');
  });
});

describe('Pi conversation context', () => {
  const piRun = (implementationVersion: number): AgentRunLease => ({
    ...run,
    ref: { ...run.ref, agentId: 'pi', implementationVersion },
  });

  it('does not probe pre-v7 Connectors and maps the native v7 context snapshot', async () => {
    const request = vi.fn(async () => ({
      activity: 'working', usedTokens: 42_000, totalTokens: 128_000, cwd: '/work/project',
    }));
    const context = createPiConversationContextAdapter({
      host: { request } as unknown as Parameters<typeof createPiConversationContextAdapter>[0]['host'],
    });

    await expect(context.read(piRun(6))).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
    await expect(context.read(piRun(7))).resolves.toEqual({
      activity: 'working', usedTokens: 42_000, totalTokens: 128_000, cwd: '/work/project',
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ ref: expect.objectContaining({ implementationVersion: 7 }) }),
      'conversation', 'context', {}, expect.objectContaining({ timeoutMs: 8_000 }),
    );
  });

  it('rejects incomplete native usage instead of publishing a misleading ring', async () => {
    const request = vi.fn(async () => ({ activity: 'idle', usedTokens: 42 }));
    const context = createPiConversationContextAdapter({
      host: { request } as unknown as Parameters<typeof createPiConversationContextAdapter>[0]['host'],
    });

    await expect(context.read(piRun(7))).rejects.toThrow('invalid context usage');
  });
});

describe('Codex conversation context recovery', () => {
  const app = (state: Record<string, unknown>) => ({
    status: vi.fn(async () => state), steerQueued: vi.fn(), removeQueued: vi.fn(),
    beginQueuedEdit: vi.fn(), renewQueuedEdit: vi.fn(), commitQueuedEdit: vi.fn(),
    cancelQueuedEdit: vi.fn(), compact: vi.fn(), getGoal: vi.fn(), startGoal: vi.fn(),
    updateGoal: vi.fn(), clearGoal: vi.fn(), updateSettings: vi.fn(),
  });
  const codexRun = (sessionId: string): AgentRunLease => ({
    ...run,
    ref: { ...run.ref, agentId: 'codex', sessionId },
  });

  it('recovers missing first-status usage from the exact thread rollout', async () => {
    const findRollout = vi.fn(async (root: string, threadId: string) => `${root}/${threadId}.jsonl`);
    const reader = vi.fn(async () => ({ usedTokens: 731, totalTokens: 258_400 }));
    const controls = createCodexConversationControls(
      app({ status: { type: 'idle' }, settings: {}, contextUsage: null }),
      vi.fn(async () => {}),
      { sessionsRoot: '/sessions', findRollout, reader,
        stat: vi.fn(async () => ({ size: 1, mtimeMs: 1 })) },
    );

    await expect(controls.context.read(codexRun('thread-a'))).resolves.toMatchObject({
      activity: 'idle', usedTokens: 731, totalTokens: 258_400,
    });
    expect(findRollout).toHaveBeenCalledWith('/sessions', 'thread-a');
    expect(reader).toHaveBeenCalledWith('/sessions/thread-a.jsonl');
  });

  it('prefers live context usage and keeps Permission independent from rollout recovery', async () => {
    const findRollout = vi.fn(async () => '/sessions/thread-a.jsonl');
    const reader = vi.fn(async () => ({ usedTokens: 999, totalTokens: 999 }));
    const controls = createCodexConversationControls(app({
      status: { type: 'active' }, contextUsage: { usedTokens: 42, totalTokens: 100 },
      settings: { approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'workspaceWrite' } },
    }), vi.fn(async () => {}), { sessionsRoot: '/sessions', findRollout, reader,
      stat: vi.fn(async () => ({ size: 1, mtimeMs: 1 })) });

    await expect(controls.context.read(codexRun('thread-a'))).resolves.toMatchObject({
      activity: 'working', usedTokens: 42, totalTokens: 100,
    });
    await expect(controls.permission.read(codexRun('thread-a'))).resolves.toMatchObject({ mode: 'default' });
    expect(findRollout).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

  it('does not consult rollout recovery when only Permission is read and usage is missing', async () => {
    const findRollout = vi.fn(async () => '/sessions/thread-a.jsonl');
    const reader = vi.fn(async () => ({ usedTokens: 731, totalTokens: 258_400 }));
    const controls = createCodexConversationControls(app({
      status: { type: 'idle' }, contextUsage: null,
      settings: { approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'workspaceWrite' } },
    }), vi.fn(async () => {}), { sessionsRoot: '/sessions', findRollout, reader,
      stat: vi.fn(async () => ({ size: 1, mtimeMs: 1 })) });

    await expect(controls.permission.read(codexRun('thread-a'))).resolves.toMatchObject({ mode: 'default' });
    expect(findRollout).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();

    await expect(controls.context.read(codexRun('thread-a'))).resolves.toMatchObject({
      usedTokens: 731, totalTokens: 258_400,
    });
    expect(findRollout).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledOnce();
  });

  it.each([
    ['readOnly', 'on-request', 'auto_review', 'auto-review'],
    ['readOnly', 'on-request', 'guardian_subagent', 'auto-review'],
    ['readOnly', 'never', 'auto_review', 'custom'],
    ['dangerFullAccess', 'never', 'auto_review', 'full-access'],
    ['workspaceWrite', 'on-request', undefined, 'default'],
    ['workspaceWrite', 'on-request', 'future_reviewer', 'custom'],
  ] as const)('maps sandbox %s, approval %s, and reviewer %s to %s', async (
    sandbox, approvalPolicy, approvalsReviewer, mode,
  ) => {
    const controls = createCodexConversationControls(app({
      status: { type: 'idle' },
      settings: {
        sandboxPolicy: { type: sandbox }, approvalPolicy,
        ...(approvalsReviewer === undefined ? {} : { approvalsReviewer }),
      },
    }), vi.fn(async () => {}));

    await expect(controls.permission.read(codexRun('thread-a'))).resolves.toMatchObject({ mode });
  });

  it('never crosses thread identities while recovering two contexts', async () => {
    const findRollout = vi.fn(async (root: string, threadId: string) => `${root}/${threadId}.jsonl`);
    const reader = vi.fn(async (file: string) => file.endsWith('/thread-a.jsonl')
      ? { usedTokens: 10, totalTokens: 100 }
      : { usedTokens: 20, totalTokens: 200 });
    const controls = createCodexConversationControls(
      app({ status: { type: 'idle' }, settings: {}, contextUsage: null }),
      vi.fn(async () => {}),
      { sessionsRoot: '/sessions', findRollout, reader,
        stat: vi.fn(async () => ({ size: 1, mtimeMs: 1 })) },
    );

    await expect(controls.context.read(codexRun('thread-a'))).resolves.toMatchObject({
      usedTokens: 10, totalTokens: 100,
    });
    await expect(controls.context.read(codexRun('thread-b'))).resolves.toMatchObject({
      usedTokens: 20, totalTokens: 200,
    });
    expect(findRollout.mock.calls.map((call) => call[1])).toEqual(['thread-a', 'thread-b']);
  });

  it('coalesces concurrent scans and rereads only after rollout metadata changes', async () => {
    let clock = 0;
    let metadata = { size: 1, mtimeMs: 1 };
    const findRollout = vi.fn(async () => '/sessions/thread-a.jsonl');
    const stat = vi.fn(async () => metadata);
    const reader = vi.fn()
      .mockResolvedValueOnce({ usedTokens: 10, totalTokens: 100 })
      .mockResolvedValueOnce({ usedTokens: 20, totalTokens: 100 });
    const controls = createCodexConversationControls(
      app({ status: { type: 'idle' }, settings: {}, contextUsage: null }),
      vi.fn(async () => {}),
      { sessionsRoot: '/sessions', findRollout, reader, stat, now: () => clock },
    );

    const [first, concurrent] = await Promise.all([
      controls.context.read(codexRun('thread-a')),
      controls.context.read(codexRun('thread-a')),
    ]);
    expect(first).toMatchObject({ usedTokens: 10, totalTokens: 100 });
    expect(concurrent).toMatchObject({ usedTokens: 10, totalTokens: 100 });
    expect(findRollout).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledOnce();

    await controls.context.read(codexRun('thread-a'));
    expect(findRollout).toHaveBeenCalledOnce();
    expect(stat).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledOnce();

    clock = 2_001;
    await expect(controls.context.read(codexRun('thread-a'))).resolves.toMatchObject({ usedTokens: 10 });
    expect(stat).toHaveBeenCalledTimes(2);
    expect(reader).toHaveBeenCalledOnce();

    metadata = { size: 1, mtimeMs: 2 };
    clock = 4_002;
    await expect(controls.context.read(codexRun('thread-a'))).resolves.toMatchObject({ usedTokens: 20 });
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('keeps a null reader result cached while rollout metadata is unchanged', async () => {
    let clock = 0;
    let metadata = { size: 1, mtimeMs: 1 };
    const findRollout = vi.fn(async () => '/sessions/thread-a.jsonl');
    const stat = vi.fn(async () => metadata);
    const reader = vi.fn(async () => null);
    const controls = createCodexConversationControls(
      app({ status: { type: 'idle' }, settings: {}, contextUsage: null }),
      vi.fn(async () => {}),
      { sessionsRoot: '/sessions', findRollout, reader, stat, now: () => clock },
    );

    await controls.context.read(codexRun('thread-a'));
    await controls.context.read(codexRun('thread-a'));
    expect(reader).toHaveBeenCalledOnce();

    clock = 2_001;
    await controls.context.read(codexRun('thread-a'));
    expect(stat).toHaveBeenCalledTimes(2);
    expect(reader).toHaveBeenCalledOnce();

    metadata = { size: 2, mtimeMs: 1 };
    clock = 4_002;
    await controls.context.read(codexRun('thread-a'));
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('keeps the last recovered usage when a changed rollout cannot be read', async () => {
    let clock = 0;
    let metadata = { size: 1, mtimeMs: 1 };
    const reader = vi.fn()
      .mockResolvedValueOnce({ usedTokens: 10, totalTokens: 100 })
      .mockRejectedValueOnce(new Error('transient read failure'));
    const controls = createCodexConversationControls(
      app({ status: { type: 'idle' }, settings: {}, contextUsage: null }),
      vi.fn(async () => {}),
      {
        sessionsRoot: '/sessions',
        findRollout: vi.fn(async () => '/sessions/thread-a.jsonl'),
        reader,
        stat: vi.fn(async () => metadata),
        now: () => clock,
      },
    );

    await expect(controls.context.read(codexRun('thread-a'))).resolves.toMatchObject({ usedTokens: 10 });
    metadata = { size: 2, mtimeMs: 2 };
    clock = 2_001;
    await expect(controls.context.read(codexRun('thread-a'))).resolves.toMatchObject({ usedTokens: 10 });
  });

  it('negative-caches a missing rollout only for the short metadata-check interval', async () => {
    let clock = 0;
    const findRollout = vi.fn(async () => null);
    const reader = vi.fn(async () => ({ usedTokens: 10, totalTokens: 100 }));
    const controls = createCodexConversationControls(
      app({ status: { type: 'idle' }, settings: {}, contextUsage: null }),
      vi.fn(async () => {}),
      { sessionsRoot: '/sessions', findRollout, reader,
        stat: vi.fn(async () => ({ size: 1, mtimeMs: 1 })), now: () => clock },
    );

    await controls.context.read(codexRun('thread-a'));
    await controls.context.read(codexRun('thread-a'));
    expect(findRollout).toHaveBeenCalledOnce();
    expect(reader).not.toHaveBeenCalled();

    clock = 2_001;
    await controls.context.read(codexRun('thread-a'));
    expect(findRollout).toHaveBeenCalledTimes(2);
    expect(reader).not.toHaveBeenCalled();
  });
});
