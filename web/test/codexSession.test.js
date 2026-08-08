import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { getCodexSession } from '../src/api.js';
import { codexKind, useCodexSession } from '../src/hooks/useCodexSession.js';

vi.mock('../src/api.js', () => ({ getCodexSession: vi.fn() }));

beforeEach(() => { getCodexSession.mockReset(); });
afterEach(cleanup);

describe('codexKind', () => {
  it('uses authoritative App Server wait states', () => {
    expect(codexKind({ managed: true, status: { type: 'active', activeFlags: [] } })).toBe('working');
    expect(codexKind({ managed: true, status: { type: 'active', activeFlags: ['waitingOnApproval'] } })).toBe('permission');
    expect(codexKind({ managed: true, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } })).toBe('permission');
  });

  it('does not inherit terminal-derived state for unmanaged sessions', () => {
    expect(codexKind({ managed: false })).toBeNull();
  });
});

describe('useCodexSession', () => {
  it('does not expose the previous pane session while the next pane loads', async () => {
    getCodexSession.mockImplementation((pane) => {
      if (pane === '%plain') return Promise.resolve({ managed: false });
      return new Promise(() => {});
    });
    const renders = [];
    const { result, rerender } = renderHook(
      ({ pane }) => {
        const session = useCodexSession(pane, true);
        renders.push({ pane, loaded: session.loaded, managed: session.managed });
        return session;
      },
      { initialProps: { pane: '%plain' } },
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    const nextRender = renders.length;
    rerender({ pane: '%managed' });

    expect(renders[nextRender]).toEqual({ pane: '%managed', loaded: false, managed: false });
  });
});
