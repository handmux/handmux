import { describe, expect, it, vi } from 'vitest';
import { createClaudeInteractionAdapter } from '../src/agents/claudeInteraction.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';

async function lease() {
  const runtime = new AgentRunRuntime({ newRunId: () => 'run-claude' });
  return runtime.controller('claude', async () => true).attach({
    paneId: '%1', attachmentId: 'claude-hooks', sessionId: 'session-1', process: { pid: 101 },
  });
}

const menu = ['Pick one', '❯ 1. Continue', '  2. Cancel', 'Esc to cancel'].join('\n');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('Claude Interaction adapter', () => {
  it('normalizes a terminal choice and dispatches it through the shared pane control', async () => {
    const run = await lease();
    const sendChoice = vi.fn(async () => {});
    const adapter = createClaudeInteractionAdapter({
      capturePlain: vi.fn(async () => menu), sendChoice,
    }, 1_000);
    const handle = await adapter.observeNative(run, () => {});
    const pending = handle.checkpoint.pending[0];
    expect(pending).toMatchObject({
      type: 'select', prompt: 'Pick one',
      options: [{ id: 'choice:1' }, { id: 'choice:2' }],
    });
    await expect(adapter.dispatchResponse(run, {
      interactionId: pending!.id,
      value: { type: 'selection', optionIds: ['choice:1'] },
    })).resolves.toEqual({ status: 'accepted' });
    expect(sendChoice).toHaveBeenCalledWith('%1', '1');
    await handle.close();
  });

  it('fails closed when provider permission state has no reliable native decisions', async () => {
    const run = await lease();
    const sendChoice = vi.fn(async () => {});
    const adapter = createClaudeInteractionAdapter({
      capturePlain: vi.fn(async () => 'Permission required'),
      pendingKind: () => 'permission',
      sendChoice,
    }, 1_000);
    const handle = await adapter.observeNative(run, () => {});
    const pending = handle.checkpoint.pending[0];
    expect(pending).toMatchObject({ type: 'local_only', prompt: 'Permission required' });
    expect(pending?.options).toBeUndefined();
    await expect(adapter.dispatchResponse(run, {
      interactionId: pending!.id,
      value: { type: 'approval', optionId: 'choice:2' },
    })).resolves.toEqual({ status: 'rejected', reason: 'invalid_value' });
    expect(sendChoice).not.toHaveBeenCalled();
    await handle.close();
  });

  it('keeps last-good pending through one failure, then degrades and cancels stale state', async () => {
    const run = await lease();
    const firstFailure = deferred<string>();
    const secondFailure = deferred<string>();
    const capture = vi.fn()
      .mockResolvedValueOnce(menu)
      .mockReturnValueOnce(firstFailure.promise)
      .mockReturnValueOnce(secondFailure.promise)
      .mockResolvedValue('');
    const health = vi.fn();
    const events: Array<{ type: string; reason?: string }> = [];
    const adapter = createClaudeInteractionAdapter({
      capturePlain: capture, sendChoice: vi.fn(async () => {}),
    }, 5, health);
    const handle = await adapter.observeNative(run, (event) => { events.push(event); });
    expect(handle.checkpoint.pending).toHaveLength(1);

    await vi.waitFor(() => expect(capture.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(events).toEqual([]);
    expect(health).not.toHaveBeenCalledWith('degraded', expect.anything());
    firstFailure.reject(new Error('/Users/private/provider.sock capture failed once'));
    await vi.waitFor(() => expect(capture.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(events).toEqual([]);
    expect(health).not.toHaveBeenCalledWith('degraded', expect.anything());
    secondFailure.reject(new Error('/Users/private/provider.sock capture failed twice'));

    await vi.waitFor(() => expect(events).toContainEqual({
      type: 'cancelled', sourceCursor: expect.any(String),
      interactionId: handle.checkpoint.pending[0]!.id, reason: 'temporarily_unavailable',
    }));
    expect(health).toHaveBeenCalledWith('degraded', 'Interaction polling is temporarily unavailable');
    expect(JSON.stringify(health.mock.calls)).not.toContain('/Users/private');
    await vi.waitFor(() => expect(health).toHaveBeenCalledWith('ready'));
    await handle.close();
  });
});
