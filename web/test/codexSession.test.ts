import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { getCodexSession } from '../src/api.js';
import {
  codexKind,
  parseCodexSessionSnapshot,
  useCodexSession,
} from '../src/hooks/useCodexSession.js';

vi.mock('../src/api.js', () => ({ getCodexSession: vi.fn() }));
const getCodexSessionMock = vi.mocked(getCodexSession);

beforeEach(() => { getCodexSessionMock.mockReset(); });
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
  it('normalizes the App Server boundary and drops malformed queue items', () => {
    expect(parseCodexSessionSnapshot({
      managed: true,
      status: { type: 'active', activeFlags: ['waitingOnApproval', 7] },
      queue: [
        { id: 'q1', text: 'valid', createdAt: 1 },
        { id: '', text: 'invalid', createdAt: 2 },
      ],
    })).toMatchObject({
      managed: true,
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      queue: [{ id: 'q1', text: 'valid', createdAt: 1 }],
    });
  });

  it('keeps an unfinished last-turn plan resident between turns', () => {
    expect(parseCodexSessionSnapshot({
      managed: true,
      plan: null,
      lastPlan: {
        turnId: 'turn-plan',
        steps: [
          { step: '完成基础设施', status: 'completed' },
          { step: '迁移 Workspace Shell', status: 'inProgress' },
        ],
      },
    })?.plan).toMatchObject({
      turnId: 'turn-plan',
      steps: [
        { step: '完成基础设施', status: 'completed' },
        { step: '迁移 Workspace Shell', status: 'inProgress' },
      ],
    });
  });

  it('hides a completed last-turn plan and prefers a current-turn replacement', () => {
    expect(parseCodexSessionSnapshot({
      managed: true,
      plan: null,
      lastPlan: { steps: [{ step: '全部完成', status: 'completed' }] },
    })?.plan).toBeNull();

    expect(parseCodexSessionSnapshot({
      managed: true,
      plan: { turnId: 'turn-new', steps: [{ step: '收尾', status: 'completed' }] },
      lastPlan: { turnId: 'turn-old', steps: [{ step: '旧任务', status: 'inProgress' }] },
    })?.plan).toMatchObject({ turnId: 'turn-new' });
  });

  it('validates approval decisions and user-input questions before exposing them to the UI', () => {
    expect(parseCodexSessionSnapshot({
      managed: true,
      approvals: [{
        id: 'approval-1',
        type: 'command',
        decisions: [
          'accept',
          { id: 'structured:1', type: 'execpolicy', rule: ['git', 'status'] },
          { id: 'bad', type: 'networkPolicy', action: 'maybe', host: 'example.com' },
        ],
      }],
      userInputs: [{
        id: 'input-1',
        questions: [{
          id: 'branch', question: '选择分支', header: '分支',
          options: [{ label: 'master', description: '当前主线' }, { label: 7 }],
        }, { id: '', question: 'invalid' }],
      }],
    })).toMatchObject({
      approvals: [{
        id: 'approval-1',
        decisions: [
          'accept',
          { id: 'structured:1', type: 'execpolicy', rule: ['git', 'status'] },
        ],
      }],
      userInputs: [{
        id: 'input-1',
        questions: [{
          id: 'branch', question: '选择分支', header: '分支',
          options: [{ label: 'master', description: '当前主线' }],
        }],
      }],
    });
  });

  it('does not expose the previous pane session while the next pane loads', async () => {
    getCodexSessionMock.mockImplementation((pane: string) => {
      if (pane === '%plain') return Promise.resolve({ managed: false });
      return new Promise(() => {});
    });
    const renders: Array<{ pane: string; loaded: boolean; managed: boolean }> = [];
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

  it('keeps the last good session through a five-second connection grace period', async () => {
    vi.useFakeTimers();
    try {
      const good = { managed: true, threadId: 'thread-1', status: { type: 'idle' } };
      getCodexSessionMock
        .mockResolvedValueOnce(good)
        .mockRejectedValue(new Error('temporary drop'));
      const { result } = renderHook(() => useCodexSession('%1', true));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(result.current).toMatchObject({ loaded: true, managed: true, threadId: 'thread-1', error: null });

      await act(async () => { await vi.advanceTimersByTimeAsync(750); });
      expect(result.current.error).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
      expect(result.current.error).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(750); });
      expect(result.current).toMatchObject({ managed: true, threadId: 'thread-1', error: 'temporary drop' });

      getCodexSessionMock.mockResolvedValue(good);
      await act(async () => { await vi.advanceTimersByTimeAsync(750); });
      expect(result.current.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the neutral loading state while an initial connection is still retrying', async () => {
    vi.useFakeTimers();
    try {
      getCodexSessionMock.mockRejectedValue(new Error('temporary drop'));
      const { result } = renderHook(() => useCodexSession('%1', true));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(result.current).toMatchObject({ loaded: false, error: null });

      await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
      expect(result.current).toMatchObject({ loaded: false, error: null });
      await act(async () => { await vi.advanceTimersByTimeAsync(750); });
      expect(result.current).toMatchObject({ loaded: true, error: 'temporary drop' });
    } finally {
      vi.useRealTimers();
    }
  });
});
