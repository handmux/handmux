import { describe, expect, it, vi } from 'vitest';
import { AgentRunError, AgentRunRuntime } from '../src/agent-runtime/run.js';
import type { AgentAttachmentCandidate } from '../src/agent-runtime/run.js';

function candidate(overrides: Partial<AgentAttachmentCandidate> = {}): AgentAttachmentCandidate {
  return {
    paneId: '%1',
    attachmentId: 'attachment-1',
    process: { pid: 101, startedAt: 1_000, tty: '/dev/ttys001' },
    ...overrides,
  };
}

function runtimeWithIds(...ids: string[]): AgentRunRuntime {
  let index = 0;
  return new AgentRunRuntime({ newRunId: () => ids[index++] ?? `run-${index}` });
}

async function expectCode(operation: Promise<unknown>, code: AgentRunError['code']): Promise<void> {
  try {
    await operation;
    throw new Error('Expected AgentRunError');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRunError);
    expect((error as AgentRunError).code).toBe(code);
  }
}

describe('AgentRunRuntime', () => {
  it('creates a scoped live lease only after attachment verification', async () => {
    const runtime = runtimeWithIds('run-1');
    const verify = vi.fn(async () => true);
    const runs = runtime.controller('pi', verify);
    const input = candidate();
    const lease = await runs.attach(input);

    expect(verify).toHaveBeenCalledWith(input);
    expect(lease.ref).toEqual({ agentId: 'pi', paneId: '%1', runId: 'run-1' });
    expect(lease.signal.aborted).toBe(false);
    expect(runtime.resolve(lease.ref)).toBe(lease);
    expect(runtime.status(lease.ref)).toBe('current');
    expect(runtime.requireLive(lease)).toBe(lease.ref);
  });

  it('rejects an unverified attachment without creating a run', async () => {
    const runtime = runtimeWithIds('unused');
    const runs = runtime.controller('pi', async () => false);
    await expectCode(runs.attach(candidate()), 'attachment-unverified');
  });

  it('reuses one logical lease across transport reconnects', async () => {
    const runtime = runtimeWithIds('run-1', 'should-not-be-used');
    const runs = runtime.controller('pi', async () => true);
    const first = await runs.attach(candidate());
    const reconnect = await runs.attach(candidate());
    expect(reconnect).toBe(first);
    expect(reconnect.ref.runId).toBe('run-1');
  });

  it('late-associates a session once while keeping the lease and run generation', async () => {
    const runtime = runtimeWithIds('run-1');
    const runs = runtime.controller('pi', async () => true);
    const lease = await runs.attach(candidate());
    const before = lease.ref;

    const associated = await runs.associateSession(lease, 'session-a');
    expect(associated).toEqual({
      agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-a',
    });
    expect(lease.ref).toBe(associated);
    expect(lease.ref).not.toBe(before);
    expect(await runs.associateSession(lease, 'session-a')).toBe(associated);
    await expectCode(runs.associateSession(lease, 'session-b'), 'session-replacement-required');
  });

  it('requires replace when reconnect reports a different known session', async () => {
    const runtime = runtimeWithIds('run-1');
    const runs = runtime.controller('pi', async () => true);
    await runs.attach(candidate({ sessionId: 'session-a' }));
    await expectCode(
      runs.attach(candidate({ sessionId: 'session-b' })),
      'session-replacement-required',
    );
  });

  it('atomically replaces a session generation and aborts every old control path', async () => {
    const runtime = runtimeWithIds('run-1', 'run-2');
    const runs = runtime.controller('pi', async () => true);
    const oldLease = await runs.attach(candidate({ sessionId: 'session-a' }));
    const nextLease = await runs.replace(
      oldLease,
      candidate({ attachmentId: 'attachment-2', sessionId: 'session-b' }),
      'provider_clear',
    );

    expect(nextLease.ref).toEqual({
      agentId: 'pi', paneId: '%1', runId: 'run-2', sessionId: 'session-b',
    });
    expect(oldLease.signal.aborted).toBe(true);
    expect(oldLease.signal.reason).toBe('provider_clear');
    expect(runtime.resolve(oldLease.ref)).toBeNull();
    expect(runtime.status(oldLease.ref)).toBe('revoked');
    expect(runtime.resolve(nextLease.ref)).toBe(nextLease);
    expect(runtime.status({ agentId: 'pi', paneId: '%9', runId: 'never-issued' })).toBe('unknown');
    await expectCode(runs.replace(oldLease, candidate(), 'session_replaced'), 'stale-lease');
  });

  it('creates a new generation for provider clear even when every attachment fact is unchanged', async () => {
    const runtime = runtimeWithIds('run-1', 'run-2');
    const runs = runtime.controller('claude', async () => true);
    const unchanged = candidate({ sessionId: 'session-a' });
    const oldLease = await runs.attach(unchanged);
    const nextLease = await runs.replace(oldLease, unchanged, 'provider_clear');
    expect(nextLease.ref).toEqual({
      agentId: 'claude', paneId: '%1', runId: 'run-2', sessionId: 'session-a',
    });
    expect(oldLease.signal.aborted).toBe(true);
    expect(runtime.resolve(oldLease.ref)).toBeNull();
  });

  it('treats a changed process fingerprint as a new run even with the same attachment id', async () => {
    const runtime = runtimeWithIds('run-1', 'run-2');
    const runs = runtime.controller('pi', async () => true);
    const oldLease = await runs.attach(candidate());
    const nextLease = await runs.attach(candidate({
      process: { pid: 202, startedAt: 2_000, tty: '/dev/ttys001' },
    }));
    expect(nextLease.ref.runId).toBe('run-2');
    expect(oldLease.signal.aborted).toBe(true);
    expect(oldLease.signal.reason).toBe('process_exit');
  });

  it('does not let a stale revoke clear the replacement generation', async () => {
    const runtime = runtimeWithIds('run-1', 'run-2');
    const runs = runtime.controller('pi', async () => true);
    const oldLease = await runs.attach(candidate());
    const nextLease = await runs.replace(
      oldLease,
      candidate({ attachmentId: 'attachment-2' }),
      'session_replaced',
    );
    await runs.revoke(oldLease, 'pane_detached');
    expect(runtime.resolve(nextLease.ref)).toBe(nextLease);
    expect(nextLease.signal.aborted).toBe(false);
  });

  it('prevents scoped controllers from mutating another adapter or pane owner', async () => {
    const runtime = runtimeWithIds('run-1');
    const pi = runtime.controller('pi', async () => true);
    const claude = runtime.controller('claude', async () => true);
    const piLease = await pi.attach(candidate());
    await expectCode(claude.revoke(piLease, 'pane_detached'), 'foreign-lease');
    await expectCode(
      claude.attach(candidate({ attachmentId: 'claude-attachment' })),
      'pane-owned-by-another-adapter',
    );
    expect(runtime.resolve(piLease.ref)).toBe(piLease);
  });

  it('lets only root Runtime revoke a pane before a different adapter takes ownership', async () => {
    const runtime = runtimeWithIds('run-pi', 'run-claude');
    const pi = runtime.controller('pi', async () => true);
    const claude = runtime.controller('claude', async () => true);
    const piLease = await pi.attach(candidate());
    expect(runtime.currentForPane('%1')).toBe(piLease);

    await runtime.revokePane('%1', 'process_exit');
    const claudeLease = await claude.attach(candidate({ attachmentId: 'claude-attachment' }));
    expect(piLease.signal.reason).toBe('process_exit');
    expect(runtime.currentForPane('%1')).toBe(claudeLease);
  });

  it('revokes one adapter independently and aborts all runs on shutdown', async () => {
    const runtime = runtimeWithIds('run-pi', 'run-claude');
    const pi = runtime.controller('pi', async () => true);
    const claude = runtime.controller('claude', async () => true);
    const piLease = await pi.attach(candidate());
    const claudeLease = await claude.attach(candidate({
      paneId: '%2', attachmentId: 'claude-attachment', process: { pid: 202 },
    }));

    await runtime.revokeAdapter('pi');
    expect(piLease.signal.reason).toBe('adapter_stopped');
    expect(claudeLease.signal.aborted).toBe(false);

    await runtime.shutdown();
    expect(claudeLease.signal.reason).toBe('runtime_shutdown');
    await expectCode(pi.attach(candidate()), 'runtime-unavailable');
  });

  it('bounds a hanging attachment verifier', async () => {
    const runtime = new AgentRunRuntime({ verifyTimeoutMs: 5 });
    const runs = runtime.controller('pi', () => new Promise(() => {}));
    await expectCode(runs.attach(candidate()), 'attachment-unverified');
  });

  it('serializes competing attachment verification per pane', async () => {
    const runtime = runtimeWithIds('run-1', 'run-2');
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const runs = runtime.controller('pi', async (input) => {
      order.push(`start:${input.attachmentId}`);
      if (input.attachmentId === 'first') await firstGate;
      order.push(`end:${input.attachmentId}`);
      return true;
    });

    const first = runs.attach(candidate({ attachmentId: 'first' }));
    const second = runs.attach(candidate({ attachmentId: 'second' }));
    await vi.waitFor(() => expect(order).toEqual(['start:first']));
    releaseFirst();
    const [firstLease, secondLease] = await Promise.all([first, second]);
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    expect(firstLease.signal.aborted).toBe(true);
    expect(runtime.resolve(secondLease.ref)).toBe(secondLease);
  });
});
