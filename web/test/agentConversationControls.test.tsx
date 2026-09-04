import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentConversationActionControls,
  AgentConversationContextControl,
  AgentConversationPermissionControl,
  AgentConversationQueueControl,
} from '../src/components/AgentConversationCapabilityControls.js';
import type { AgentConversationControlsController } from '../src/hooks/useAgentConversationControls.js';
import { ApiError } from '../src/apiErrors.js';

afterEach(() => cleanup());

function controller(overrides: Partial<AgentConversationControlsController> = {}): AgentConversationControlsController {
  return {
    status: 'ready', error: null, busy: false,
    snapshot: { queue: { items: [{ id: 'q1', text: 'queued', createdAt: 1 }],
      canSteer: true, canEdit: false, canRemove: true } },
    refresh: vi.fn(async () => {}), queueAction: vi.fn(async () => null),
    goalAction: vi.fn(async () => null),
    setPermission: vi.fn(async () => ({
      mode: 'default' as const, options: ['default' as const],
    })), command: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('Agent Conversation controls UI', () => {
  it('keeps Permission left of Context in the shared composer action slot', () => {
    const { container } = render(<AgentConversationActionControls
      controller={controller({
        snapshot: {
          permission: { mode: 'default', options: ['default'] },
          permissionCanUpdate: true,
          context: { activity: 'idle', usedTokens: 25, totalTokens: 100 },
        },
      })}
      sessionId="session-1" showPermission showContext />);

    const actions = Array.from(container.children);
    expect(actions[0]).toBe(screen.getByRole('button', { name: '权限模式' }));
    expect(actions[1]).toBe(screen.getByRole('button', { name: '会话状态，上下文占用 25%' }));
  });

  it('uses a same-size neutral Context ring while usage is unavailable and updates it in place', () => {
    const initial = controller({ snapshot: { context: { activity: 'idle' } } });
    const view = render(<AgentConversationContextControl sessionId="session-1" controller={initial} />);
    const trigger = screen.getByRole('button', { name: '上下文状态，用量暂不可用' });
    expect(trigger.querySelector('.cc-context-ring.is-placeholder')).toBeTruthy();
    expect(trigger.querySelector('.cc-context-value')).toBeNull();
    expect(view.container.textContent).not.toContain('•••');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: '会话状态' })).toBeTruthy();
    fireEvent.click(trigger);

    view.rerender(<AgentConversationContextControl sessionId="session-1" controller={controller({
      snapshot: { context: { activity: 'idle', usedTokens: 40, totalTokens: 100 } },
    })} />);
    const recovered = screen.getByRole('button', { name: '会话状态，上下文占用 40%' });
    expect(recovered).toBe(trigger);
    expect(recovered.querySelector('.cc-context-ring.is-placeholder')).toBeNull();
    expect(recovered.querySelector('.cc-context-value')).toBeTruthy();
  });

  it.each(['degraded', 'error'] as const)(
    'keeps last-good controls without a global banner while status is %s',
    (status) => {
      const { container } = render(<AgentConversationActionControls
        controller={controller({
          status,
          error: '/Users/private/provider.sock',
          snapshot: {
            permission: { mode: 'default', options: ['default'] },
            permissionCanUpdate: true,
            context: { activity: 'idle', usedTokens: 25, totalTokens: 100 },
          },
        })}
        sessionId="session-1" showPermission showContext />);
      expect(screen.getByRole('button', { name: '权限模式' })).toBeTruthy();
      expect(container.textContent).not.toContain('部分会话控制');
      expect(container.textContent).not.toContain('暂时不可用');
      expect(container.textContent).not.toContain('/Users/private');
    },
  );

  it('keeps the delete confirmation open and visible after failure', async () => {
    const queueAction = vi.fn(async () => { throw new Error('/private/rpc'); });
    render(<AgentConversationQueueControl controller={controller({ queueAction })} />);
    fireEvent.click(screen.getByRole('button', { name: '删除排队消息' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    expect(screen.getByText('没有处理成功，请稍后重试')).toBeTruthy();
    expect(document.body.textContent).not.toContain('/private/rpc');
  });

  it('uses Activity and Adapter steer support for the guide-now button', () => {
    const compacting = render(<AgentConversationQueueControl activity="compacting"
      controller={controller()} />);
    expect((screen.getByRole('button', { name: '立刻引导' }) as HTMLButtonElement).disabled).toBe(true);
    compacting.rerender(<AgentConversationQueueControl activity="unknown" controller={controller()} />);
    expect(screen.queryByRole('button', { name: '立刻引导' })).toBeNull();
    compacting.rerender(<AgentConversationQueueControl activity="working" controller={controller({
      snapshot: { queue: {
        items: [{ id: 'q1', text: 'queued', createdAt: 1 }],
        canSteer: false, canEdit: false, canRemove: true,
      } },
    })} />);
    expect(screen.queryByRole('button', { name: '立刻引导' })).toBeNull();
  });

  it('keeps public edit and delete actions when an Adapter cannot steer', () => {
    render(<AgentConversationQueueControl activity="working" controller={controller({
      snapshot: { queue: {
        items: [{ id: 'pi-queue', text: 'pi queued', createdAt: 1, state: 'queued' }],
        canSteer: false, canEdit: true, canRemove: true,
      } },
    })} />);

    expect(screen.getByRole('button', { name: 'pi queued' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除排队消息' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '立刻引导' })).toBeNull();
  });

  it('enables public mutations after a local Queue receipt but not while it is sending', () => {
    const queueSnapshot = { queue: {
      items: [], canSteer: false, canEdit: true, canRemove: true,
    } };
    const localItem = {
      id: 'local-queue', requestId: 'local-queue', text: 'local queued', createdAt: 1,
      state: 'queued' as const,
    };
    const view = render(<AgentConversationQueueControl activity="working"
      controller={controller({ snapshot: queueSnapshot })}
      items={[localItem]}
      conversation={{
        items: [],
        localSubmissions: [{
          clientRequestId: 'local-queue', text: 'local queued', owner: 'queue',
          status: 'accepted', createdAt: 1,
        }],
      } as never} />);

    expect(screen.getByRole('button', { name: 'local queued' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '删除排队消息' }) as HTMLButtonElement).disabled)
      .toBe(false);

    view.rerender(<AgentConversationQueueControl activity="working"
      controller={controller({ snapshot: queueSnapshot })}
      items={[localItem]}
      conversation={{
        items: [],
        localSubmissions: [{
          clientRequestId: 'local-queue', text: 'local queued', owner: 'queue',
          status: 'sending', createdAt: 1,
        }],
      } as never} />);
    expect(screen.queryByRole('button', { name: 'local queued' })).toBeNull();
    expect((screen.getByRole('button', { name: '删除排队消息' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('starts Queue-to-Timeline ownership before waiting for the steer response', () => {
    const beginQueueSteer = vi.fn();
    const queueAction = vi.fn(() => new Promise<null>(() => {}));
    render(<AgentConversationQueueControl activity="working" controller={controller({ queueAction })}
      conversation={{
        items: [], localSubmissions: [], beginQueueSteer, settleQueueSteer: vi.fn(),
      } as never} />);
    fireEvent.click(screen.getByRole('button', { name: '立刻引导' }));
    expect(beginQueueSteer).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1' }));
    expect(queueAction).toHaveBeenCalledWith('steer', 'q1');
  });

  it('forwards settled identities with the same authoritative submission snapshot', async () => {
    const observeQueueSnapshot = vi.fn();
    const observeSubmissionSnapshot = vi.fn();
    render(<AgentConversationQueueControl controller={controller({
      snapshot: {
        queue: {
          items: [], settled: [{ id: 'settled-1', nativeId: 'native-turn-1' }],
          canSteer: true, canEdit: true, canRemove: true,
        },
        submissions: [],
      },
    })} conversation={{
      items: [], localSubmissions: [], observeQueueSnapshot, observeSubmissionSnapshot,
    } as never} />);

    await waitFor(() => expect(observeSubmissionSnapshot).toHaveBeenCalledWith([], {
      authoritative: true,
      queue: [],
      settled: [{ id: 'settled-1', nativeId: 'native-turn-1' }],
    }));
    expect(observeQueueSnapshot).toHaveBeenCalledWith([]);
  });

  it('keeps a 500 steer failure as unknown instead of rolling it back', async () => {
    const settleQueueSteer = vi.fn();
    const queueAction = vi.fn(async () => {
      throw new ApiError('server failed', 500, 'server failed');
    });
    render(<AgentConversationQueueControl activity="working" controller={controller({ queueAction })}
      conversation={{
        descriptor: { viewId: 'view-1' }, items: [], localSubmissions: [],
        beginQueueSteer: () => ({
          submissionId: 'q1', actionId: 'action-1', baseRevision: 2,
          anchor: { viewId: 'view-1' },
        }),
        settleQueueSteer,
      } as never} />);
    fireEvent.click(screen.getByRole('button', { name: '立刻引导' }));
    await waitFor(() => expect(settleQueueSteer).toHaveBeenCalledWith('q1', {
      status: 'unknown', actionId: 'action-1', nativeMutation: 'unknown',
    }, 'server failed'));
    expect(screen.queryByText('没有处理成功，请稍后重试')).toBeNull();
    expect(queueAction).toHaveBeenCalledWith('steer', 'q1', {
      actionId: 'action-1', baseRevision: 2, anchor: { viewId: 'view-1' },
    });
  });

  it('removes local Queue ownership only after an explicit delete succeeds', async () => {
    const removeQueueSubmission = vi.fn();
    render(<AgentConversationQueueControl controller={controller()}
      conversation={{ items: [], localSubmissions: [], removeQueueSubmission } as never} />);
    fireEvent.click(screen.getByRole('button', { name: '删除排队消息' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(removeQueueSubmission).toHaveBeenCalledWith('q1'));
  });

  it('keeps dispatching Queue rows visible but removes edit, steer, and delete actions', () => {
    render(<AgentConversationQueueControl activity="working" controller={controller({
      snapshot: { queue: {
        items: [{
          id: 'q1', text: 'dispatching', createdAt: 1,
          state: 'dispatching', dispatchOrigin: 'queue', revision: 3,
        }],
        canSteer: true, canEdit: true, canRemove: true,
      } },
    })} />);
    expect(screen.getByText('dispatching')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'dispatching' })).toBeNull();
    expect(screen.queryByRole('button', { name: '立刻引导' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除排队消息' })).toBeNull();
  });

  it('shows neutral terminal guidance and retries an unknown Queue row', async () => {
    const retryOutgoing = vi.fn(async () => false);
    const view = render(<AgentConversationQueueControl activity="idle" controller={controller({
      snapshot: { queue: {
        items: [{
          id: 'q1', text: 'rejected', createdAt: 1, state: 'queued', revision: 3,
          dispatchOrigin: 'queue', autoDispatchBlockedReason: 'provider_rejected',
        }],
        canSteer: true, canEdit: true, canRemove: true,
      } },
    })} />);
    expect(screen.getByText('未发送，可编辑后重试或删除')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '立刻引导' })).toBeNull();
    expect(screen.getByRole('button', { name: '删除排队消息' })).toBeTruthy();

    view.rerender(<AgentConversationQueueControl activity="idle" controller={controller({
      snapshot: { queue: {
        items: [{
          id: 'q1', text: 'unknown', createdAt: 1, state: 'unknown', revision: 4,
          dispatchOrigin: 'queue',
        }],
        canSteer: true, canEdit: true, canRemove: true,
      } },
    })} conversation={{ items: [], localSubmissions: [], retryOutgoing } as never} />);
    expect(screen.getByText('发送状态待确认，不会自动重发')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '立刻引导' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除排队消息' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(retryOutgoing).toHaveBeenCalledWith('q1'));
  });

  it('reacquires an expired queue edit lease after foregrounding and preserves the draft', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-31T00:00:00Z'));
      let begins = 0;
      const queueAction = vi.fn(async (action: string) => {
        if (action === 'begin_edit') {
          begins += 1;
          return { token: `lease-${begins}`, text: 'queued', expiresAt: Date.now() + 30_000 };
        }
        if (action === 'commit_edit') return null;
        return null;
      });
      render(<AgentConversationQueueControl controller={controller({
        queueAction: queueAction as AgentConversationControlsController['queueAction'],
        snapshot: { queue: { items: [{ id: 'q1', text: 'queued', createdAt: 1 }],
          canSteer: true, canEdit: true, canRemove: true } },
      })} />);
      fireEvent.keyDown(screen.getByRole('button', { name: 'queued' }), { key: 'Enter' });
      await act(async () => { await Promise.resolve(); });
      const input = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'preserved edit' } });
      vi.setSystemTime(new Date('2026-08-31T00:01:00Z'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve(); await Promise.resolve();
      });

      expect(queueAction.mock.calls.filter(([action]) => action === 'begin_edit')).toHaveLength(2);
      expect(input.value).toBe('preserved edit');
      expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
      await act(async () => { await Promise.resolve(); });
      expect(queueAction).toHaveBeenCalledWith('commit_edit', 'q1', {
        token: 'lease-2', text: 'preserved edit',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('grows the queue editor with content and leaves overflow to the textarea', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return this.value.length > 20 ? 300 : 140; },
    });
    try {
      const queueAction = vi.fn(async (action: string) => action === 'begin_edit'
        ? { token: 'lease-1', text: 'queued', expiresAt: Date.now() + 30_000 } : null);
      render(<AgentConversationQueueControl controller={controller({
        queueAction: queueAction as AgentConversationControlsController['queueAction'],
        snapshot: { queue: { items: [{ id: 'q1', text: 'queued', createdAt: 1 }],
          canSteer: true, canEdit: true, canRemove: true } },
      })} />);
      fireEvent.keyDown(screen.getByRole('button', { name: 'queued' }), { key: 'Enter' });
      await act(async () => { await Promise.resolve(); });
      const input = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(input.style.height).toBe('140px');
      fireEvent.change(input, { target: { value: 'a sufficiently long queued message for growth' } });
      expect(input.style.height).toBe('300px');
    } finally {
      if (original) Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', original);
      else delete (HTMLTextAreaElement.prototype as unknown as { scrollHeight?: number }).scrollHeight;
    }
  });

  it('preserves the draft and reports a real queue edit revision conflict', async () => {
    const queueAction = vi.fn(async (action: string) => {
      if (action === 'begin_edit') {
        return { token: 'lease-1', text: 'queued', expiresAt: Date.now() + 30_000 };
      }
      if (action === 'commit_edit') {
        throw new ApiError('request failed', 409, 'Queue item changed', 'invalid_request');
      }
      return null;
    });
    render(<AgentConversationQueueControl controller={controller({
      queueAction: queueAction as AgentConversationControlsController['queueAction'],
      snapshot: { queue: { items: [{ id: 'q1', text: 'queued', createdAt: 1 }],
        canSteer: true, canEdit: true, canRemove: true } },
    })} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'queued' }), { key: 'Enter' });
    await act(async () => { await Promise.resolve(); });
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'my preserved draft' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await screen.findByText('这条排队消息已在其他页面更新。草稿已保留，请关闭后确认最新内容。');
    expect(input.value).toBe('my preserved draft');
  });

  it('renders context without requiring a permission capability', () => {
    render(<AgentConversationContextControl sessionId="session-1" controller={controller({
      snapshot: { context: { activity: 'idle', branch: 'main' } },
    })} />);
    fireEvent.click(screen.getByRole('button', { name: '上下文状态，用量暂不可用' }));
    expect(screen.getByRole('dialog', { name: '会话状态' }).textContent).toContain('main');
    expect(screen.queryByRole('button', { name: '权限模式' })).toBeNull();
  });

  it('renders and updates permission without requiring a context capability', async () => {
    const setPermission = vi.fn(async () => ({
      mode: 'auto-review' as const, options: ['default' as const, 'auto-review' as const],
    }));
    render(<AgentConversationPermissionControl controller={controller({
      setPermission,
      snapshot: {
        permission: { mode: 'default', options: ['default', 'auto-review'] },
        permissionCanUpdate: true,
      },
    })} />);
    fireEvent.click(screen.getByRole('button', { name: '权限模式' }));
    fireEvent.click(screen.getByRole('radio', { name: /自动审批/ }));
    await waitFor(() => expect(setPermission).toHaveBeenCalledWith('auto-review'));
  });

  it('closes without rewriting settings when the selected permission is tapped', () => {
    const setPermission = vi.fn();
    render(<AgentConversationPermissionControl controller={controller({
      setPermission,
      snapshot: {
        permission: { mode: 'auto-review', options: ['default', 'auto-review'] },
        permissionCanUpdate: true,
      },
    })} />);

    fireEvent.click(screen.getByRole('button', { name: '权限模式' }));
    fireEvent.click(screen.getByRole('radio', { name: /自动审批/ }));
    expect(setPermission).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '权限模式' })).toBeNull();
  });
});
