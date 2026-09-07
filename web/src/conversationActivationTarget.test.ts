import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  activationRunFor,
  activationTargetMatches,
  conversationRecoveryForSessionlessPane,
  conversationIdentityForActivation,
  invalidateRememberedConversationOnTakeover,
  useConversationActivationTarget,
} from './conversationActivationTarget.js';

const original = { agentId: 'codex', paneId: '%1', runId: 'run-1' };
const target = { agentId: 'codex', paneId: '%1', run: original, ownsPane: true };

interface Context {
  paneId: string | null;
  rootView: 'session' | 'project';
  lens: 'terminal' | 'chat';
  enabled: boolean;
  runs: Array<typeof original & { sessionId?: string }>;
}

const initial: Context = {
  paneId: '%1', rootView: 'session', lens: 'chat', enabled: true, runs: [original],
};

function activationTargetHook() {
  return renderHook((props: Context) => useConversationActivationTarget({
    paneId: props.paneId,
    rootView: props.rootView,
    lens: props.lens,
    runs: props.runs,
    isConversationEnabled: () => props.enabled,
  }), { initialProps: initial });
}

describe('Conversation activation target', () => {
  it('does not replace an explicitly different current Agent run with the old target', () => {
    const claude = { agentId: 'claude', paneId: '%1', runId: 'claude-run' };
    expect(activationRunFor(target, '%1', claude)).toBe(claude);
  });

  it.each([true, false])('releases a target on a different verified Agent, ownsPane=%s', async (pending) => {
    const { result, rerender } = activationTargetHook();
    act(() => result.current.setPending(original, true));
    if (!pending) act(() => result.current.setPending(original, false));
    rerender({ ...initial, runs: [] });
    expect(result.current.displayTarget?.run).toBe(original);
    rerender({ ...initial, runs: [{ agentId: 'claude', paneId: '%2', runId: 'other-pane' }] });
    expect(result.current.displayTarget?.run).toBe(original);
    rerender({ ...initial, runs: [{ agentId: 'claude', paneId: '%1', runId: 'new-agent' }] });
    await waitFor(() => expect(result.current.displayTarget).toBeNull());
    expect(result.current.ownershipPin).toBeNull();
  });

  it('never lets a durable receipt replace an authoritatively discovered run', () => {
    const receipt = { operationId: 'receipt-1', state: 'current' as const };
    expect(conversationRecoveryForSessionlessPane(receipt, {
      agentId: 'codex', paneId: '%1', runId: 'managed', sessionId: 'session-1',
    })).toBeNull();
    expect(conversationRecoveryForSessionlessPane(receipt, {
      agentId: 'codex', paneId: '%1', runId: 'native',
    })).toBeNull();
    expect(conversationRecoveryForSessionlessPane(receipt, null)).toBe(receipt);
  });

  it('lets the exact prepared native run win without consuming its receipt', () => {
    const prepared = {
      operationId: 'receipt-prepared', state: 'current' as const, phase: 'prepared' as const,
    };
    const nativeRun = { agentId: 'codex', paneId: '%1', runId: 'native' };

    expect(conversationRecoveryForSessionlessPane(prepared, nativeRun)).toBeNull();
    expect(conversationRecoveryForSessionlessPane(prepared, null)).toBe(prepared);
  });

  it('lets a different same-pane sessionless run replace current and stale receipts', () => {
    const currentRun = { agentId: 'codex', paneId: '%1', runId: 'native' };
    const current = { operationId: 'receipt-current', state: 'current' as const };
    const stale = { operationId: 'receipt-stale', state: 'stale' as const };

    expect(conversationRecoveryForSessionlessPane(current, currentRun)).toBeNull();
    expect(conversationRecoveryForSessionlessPane(stale, currentRun)).toBeNull();
  });

  it('lets a current sessionless run win while recovery is already resuming', () => {
    const resuming = {
      operationId: 'receipt-resuming', state: 'current' as const, phase: 'resuming' as const,
    };
    expect(conversationRecoveryForSessionlessPane(resuming, {
      agentId: 'codex', paneId: '%1', runId: 'native',
    })).toBeNull();
  });

  it('keeps current and stale receipts only while Runtime has no current run', () => {
    const current = { operationId: 'receipt-current', state: 'current' as const };
    const stale = { operationId: 'receipt-stale', state: 'stale' as const };

    expect(conversationRecoveryForSessionlessPane(current, null)).toBe(current);
    expect(conversationRecoveryForSessionlessPane(stale, null)).toBe(stale);
  });

  it('keeps a remembered managed conversation until takeover is authoritatively available', () => {
    const remembered = { agentId: 'codex', paneId: '%1', sessionId: 'session-1' };
    const sessionless = { agentId: 'codex', paneId: '%1', runId: 'run-2' };
    expect(conversationIdentityForActivation(sessionless, remembered, false)).toEqual(remembered);
    expect(conversationIdentityForActivation(sessionless, remembered, true)).toBeNull();
    expect(conversationIdentityForActivation(sessionless, null, false)).toBeNull();

    const identities = new Map([['%1\0codex', remembered]]);
    invalidateRememberedConversationOnTakeover(identities, '%1\0codex', sessionless, true);
    expect(identities.has('%1\0codex')).toBe(false);
    expect(conversationIdentityForActivation(sessionless, identities.get('%1\0codex') ?? null, false))
      .toBeNull();
  });

  it('keeps the confirmed source run across the shell and a replacement sessionless run', () => {
    expect(activationTargetMatches(target, '%1', 'codex')).toBe(true);
    expect(activationTargetMatches(target, '%2', 'codex')).toBe(false);
    expect(activationRunFor(target, '%1', null)).toBe(original);
    expect(activationRunFor(target, '%1', {
      agentId: 'codex', paneId: '%1', runId: 'run-2',
    })).toBe(original);
  });

  it('releases pane ownership but retains the failure page until retry or explicit exit', () => {
    const { result } = activationTargetHook();
    act(() => result.current.setPending(original, true));
    expect(result.current.ownershipPin?.ownsPane).toBe(true);

    act(() => result.current.setPending(original, false));
    expect(result.current.ownershipPin).toBeNull();
    expect(result.current.displayTarget?.run).toBe(original);
    expect(activationRunFor(result.current.displayTarget, '%1', null)).toBe(original);

    act(() => result.current.setPending(original, true));
    expect(result.current.ownershipPin?.ownsPane).toBe(true);
    act(() => result.current.clear());
    expect(result.current.displayTarget).toBeNull();
  });

  it.each([
    ['pane navigation', { paneId: '%2' }],
    ['top Lens switch', { lens: 'terminal' }],
    ['Agent Conversation disabled', { enabled: false }],
    ['leaving Session root', { rootView: 'project' }],
  ] as const)('clears display and ownership on %s', async (_name, change) => {
    const { result, rerender } = activationTargetHook();
    act(() => result.current.setPending(original, true));
    rerender({ ...initial, ...change });
    await waitFor(() => expect(result.current.target).toBeNull());
  });

  it('clears display and ownership when the replacement session appears', async () => {
    const { result, rerender } = activationTargetHook();
    act(() => result.current.setPending(original, true));
    rerender({
      ...initial,
      runs: [{ ...original, runId: 'run-2', sessionId: 'session-1' }],
    });
    await waitFor(() => expect(result.current.target).toBeNull());
  });
});
