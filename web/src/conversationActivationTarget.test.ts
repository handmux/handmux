import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  activationRunFor,
  activationTargetMatches,
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
