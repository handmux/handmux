import { describe, expect, it, vi } from 'vitest';
import { InboxPushProjection } from '../src/agent-runtime/inboxPushProjection.js';
import type { InboxUserNotificationEvent } from '../src/agent-runtime/inboxTypes.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';

async function setup() {
  const runs = new AgentRunRuntime({ newRunId: () => 'run-1' });
  const lease = await runs.controller('pi', async () => true).attach({
    paneId: '%1', attachmentId: 'pi-extension', sessionId: 'session-1', process: { pid: 101 },
  });
  let listener: ((event: InboxUserNotificationEvent) => void | Promise<void>) | undefined;
  const unsubscribe = vi.fn();
  const inbox = {
    subscribeNotifications: vi.fn((next: typeof listener) => { listener = next; return unsubscribe; }),
  };
  const panes = { list: vi.fn(async () => [{
    paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'Agent', currentCommand: 'pi',
  }]) };
  const push = { sendToSession: vi.fn(async () => ({})) };
  const projection = new InboxPushProjection({ inbox, runs, panes, push });
  projection.start();
  return { runs, lease, listener: () => listener!, unsubscribe, panes, push, projection };
}

describe('InboxPushProjection', () => {
  it('projects a canonical current-run notification to the tmux session device scope', async () => {
    const h = await setup();
    await h.listener()({
      run: h.lease.ref, state: 'waiting', eventId: 'approval-1', message: 'Allow command?',
      correlationId: 'tool-1', acceptedAt: 1_000,
    });
    expect(h.push.sendToSession).toHaveBeenCalledWith('main', {
      title: '需要你 · main', body: 'Allow command?', tag: 'pane-%1',
      data: {
        session: 'main', window: '@1', pane: '%1', agentId: 'pi', runId: 'run-1',
        sessionId: 'session-1',
      },
    }, { topic: 'pane-%1', ttl: 14_400, urgency: 'high' });
  });

  it('does not route a revoked or replaced run through the pane current location', async () => {
    const h = await setup();
    const old = h.lease.ref;
    await h.runs.revokePane('%1', 'session_replaced');
    await h.listener()({
      run: old, state: 'done', eventId: 'done-1', acceptedAt: 2_000,
      terminalNotificationId: 'notification-1',
    });
    expect(h.push.sendToSession).not.toHaveBeenCalled();
  });

  it('uses the state label instead of a provider reason when the notification has no message', async () => {
    const h = await setup();
    await h.listener()({
      run: h.lease.ref, state: 'error', eventId: 'error-1', reason: 'agent_end_idle',
      acceptedAt: 2_000, terminalNotificationId: 'notification-1',
    });

    expect(h.push.sendToSession).toHaveBeenCalledWith('main', expect.objectContaining({
      title: '出错 · main', body: '出错',
    }), expect.any(Object));
    expect(JSON.stringify(h.push.sendToSession.mock.calls)).not.toContain('agent_end_idle');
  });

  it('rechecks the exact lease after the asynchronous pane lookup and unsubscribes cleanly', async () => {
    const h = await setup();
    h.panes.list.mockImplementationOnce(async () => {
      await h.runs.revokePane('%1', 'process_exit');
      return [{
        paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'Agent', currentCommand: 'pi',
      }];
    });
    await h.listener()({
      run: h.lease.ref, state: 'error', eventId: 'error-1', reason: 'Provider failed', acceptedAt: 3_000,
      terminalNotificationId: 'notification-1',
    });
    expect(h.push.sendToSession).not.toHaveBeenCalled();
    h.projection.close();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });
});
