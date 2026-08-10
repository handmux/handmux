import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { appendCodexStreamEvent, codexRoutes } from '../src/routes/codex.js';
import type {
  CodexRouteApp,
  CodexRouteClaudeEvents,
  CodexRouteCommands,
} from '../src/routes/codex.js';
import { projectCodexStreamEvent } from '../src/codexStreamProtocol.js';
import type { CodexStreamEvent } from '../src/codexStreamProtocol.js';

interface AppForOptions {
  sessionId?: string | null;
  codexApp?: Partial<CodexRouteApp> & {
    clear?: (pane: string, threadId: string) => Promise<unknown>;
  };
  commands?: CodexRouteCommands;
  claudeEvents?: CodexRouteClaudeEvents;
  wait?: (ms: number) => Promise<unknown>;
}

const empty = async (): Promise<Record<string, never>> => ({});

function appFor({
  sessionId = 'thread-1', codexApp = {}, commands = {}, claudeEvents = {}, wait,
}: AppForOptions = {}) {
  const app = express();
  app.use(express.json());
  const service: CodexRouteApp = {
    discover: async () => ({ managed: true, threadId: sessionId }),
    status: empty,
    subscribe: async () => () => {},
    send: empty,
    steerQueued: empty,
    removeQueued: empty,
    beginQueuedEdit: empty,
    renewQueuedEdit: empty,
    commitQueuedEdit: empty,
    cancelQueuedEdit: empty,
    compact: empty,
    models: async () => [],
    getGoal: async () => null,
    updateGoal: empty,
    clearGoal: empty,
    updateSettings: empty,
    interrupt: empty,
    decide: empty,
    answerInput: empty,
    ...codexApp,
  };
  app.use(codexRoutes({
    codexApp: service,
    commands,
    claudeEvents,
    wait,
  }));
  return app;
}

const THREAD_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function takeoverHarness({ exitId = THREAD_ID } = {}) {
  const runPaneCommand = vi.fn(async () => {});
  const identifyPaneAgents = vi.fn()
    .mockResolvedValueOnce({ '%1': 'codex' })
    .mockResolvedValue({});
  const capturePlain = vi.fn()
    .mockResolvedValueOnce('■ Conversation interrupted\nuser@host %')
    .mockResolvedValue(`To continue this session, run codex resume ${exitId}\nuser@host %`);
  return {
    runPaneCommand,
    commands: {
      listLivePanes: async () => [{ id: '%1', cmd: 'codex' }],
      sendKey: vi.fn(async () => {}),
      capturePlain,
      runPaneCommand,
    },
    claudeEvents: { identifyPaneAgents },
  };
}

describe('Codex App Server routes', () => {
  it('coalesces adjacent text deltas without reordering lifecycle events', () => {
    const queue: CodexStreamEvent[] = [];
    appendCodexStreamEvent(queue, { type: 'delta', threadId: 'one', turnId: 't', itemId: 'i', delta: '你' });
    appendCodexStreamEvent(queue, { type: 'delta', threadId: 'one', turnId: 't', itemId: 'i', delta: '好' });
    appendCodexStreamEvent(queue, { type: 'completed', threadId: 'one', turnId: 't', itemId: 'i', text: '你好' });
    expect(queue).toEqual([
      expect.objectContaining({ type: 'delta', delta: '你好' }),
      expect.objectContaining({ type: 'completed', text: '你好' }),
    ]);

    const projected: CodexStreamEvent[] = [];
    appendCodexStreamEvent(projected, {
      type: 'delta', threadId: 'one', turnId: 't', itemId: 'i', delta: '你', sequence: 1,
    });
    appendCodexStreamEvent(projected, {
      type: 'delta', threadId: 'one', turnId: 't', itemId: 'i', delta: '好', sequence: 2,
    });
    expect(projected).toHaveLength(2);
  });

  it('streams batched App Server deltas for the exact pane thread', async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(async (pane, threadId, listener) => {
      setTimeout(() => {
        listener(projectCodexStreamEvent({
          type: 'delta', threadId, turnId: 'turn-1', itemId: 'agent-1', delta: '你',
        }, 1));
        listener(projectCodexStreamEvent({
          type: 'delta', threadId, turnId: 'turn-1', itemId: 'agent-1', delta: '好',
        }, 2));
        listener(projectCodexStreamEvent({
          type: 'completed', threadId, turnId: 'turn-1', itemId: 'agent-1', text: '你好',
        }, 3));
        listener({ type: 'disconnected', threadId });
      }, 0);
      return unsubscribe;
    });
    const app = appFor({ codexApp: { subscribe } });

    const response = await request(app).get('/codex/stream?pane=%251').expect(200);
    expect(response.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(response.text).toContain('"type":"ready"');
    expect(response.text).toContain('"sequence":1');
    expect(response.text).toContain('"operation":"upsert"');
    expect(response.text).toContain('"id":"codex:turn-1:agent-1"');
    expect(response.text).toContain('"type":"completed"');
    expect(subscribe).toHaveBeenCalledWith('%1', 'thread-1', expect.any(Function), null);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('passes a validated stream cursor to the App Server subscription', async () => {
    const subscribe = vi.fn(async (_pane, threadId, listener) => {
      setTimeout(() => listener({ type: 'disconnected', threadId }), 0);
      return vi.fn();
    });
    const app = appFor({ codexApp: { subscribe } });

    await request(app).get('/codex/stream?pane=%251&after=12').expect(200);
    expect(subscribe).toHaveBeenCalledWith('%1', 'thread-1', expect.any(Function), 12);
    await request(app).get('/codex/stream?pane=%251&after=-1')
      .expect(400, { error: 'bad Codex stream cursor' });
  });

  it('binds every operation to the exact App Server thread without Hook metadata', async () => {
    const status = vi.fn(async () => ({ managed: true, threadId: 'thread-1' }));
    const send = vi.fn(async () => ({ turn: { id: 'turn-1' } }));
    const app = appFor({ codexApp: { status, send } });

    await request(app).get('/codex/session?pane=%251').expect(200, { managed: true, threadId: 'thread-1' });
    await request(app).post('/codex/send').send({ pane: '%1', text: ' continue ' }).expect(200);
    expect(status).toHaveBeenCalledWith('%1', 'thread-1');
    expect(send).toHaveBeenCalledWith('%1', 'thread-1', 'continue', null);
  });

  it('passes a stable send request id through and rejects malformed ids', async () => {
    const send = vi.fn(async () => ({ queued: true, item: { id: 'queued-1' } }));
    const app = appFor({ codexApp: { send } });

    await request(app).post('/codex/send').send({
      pane: '%1', text: 'queue this', requestId: 'codex-send-request_1',
    }).expect(200, { queued: true, item: { id: 'queued-1' } });
    expect(send).toHaveBeenCalledWith('%1', 'thread-1', 'queue this', 'codex-send-request_1');

    await request(app).post('/codex/send').send({
      pane: '%1', text: 'invalid', requestId: 'spaces are not allowed',
    }).expect(400, { error: 'bad Codex request id' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('runs /clear through the remote TUI and returns only after App Server confirms its new thread', async () => {
    let threadId = 'thread-1';
    const discover = vi.fn(async () => ({ managed: true, threadId }));
    const commands = {
      exitCopyModeIfActive: vi.fn(async () => {}),
      sendKey: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
      sendEnter: vi.fn(async () => { threadId = 'thread-2'; }),
    };
    const directClear = vi.fn(async () => ({ threadId: 'wrong-thread' }));
    const app = appFor({
      codexApp: { discover, clear: directClear }, commands, wait: async () => {},
    });

    await request(app).post('/codex/clear').send({ pane: '%1' })
      .expect(200, { threadId: 'thread-2' });
    expect(commands.exitCopyModeIfActive).toHaveBeenCalledWith('%1');
    expect(commands.sendKey).toHaveBeenCalledWith('%1', 'C-u');
    expect(commands.sendText).toHaveBeenCalledWith('%1', '/clear');
    expect(commands.sendEnter).toHaveBeenCalledWith('%1');
    expect(directClear).not.toHaveBeenCalled();
  });

  it('fails /clear instead of splitting chat from a terminal that did not switch sessions', async () => {
    const discover = vi.fn(async () => ({ managed: true, threadId: 'thread-1' }));
    const commands = {
      exitCopyModeIfActive: vi.fn(async () => {}),
      sendKey: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
      sendEnter: vi.fn(async () => {}),
    };
    const app = appFor({ codexApp: { discover }, commands, wait: async () => {} });

    await request(app).post('/codex/clear').send({ pane: '%1' }).expect(503, {
      error: 'Codex terminal did not accept /clear; switch to the terminal, close any open panel, and try again',
    });
    expect(commands.sendText).toHaveBeenCalledWith('%1', '/clear');
    expect(discover).toHaveBeenCalledTimes(61);
  });

  it('reports expected unmanaged and starting states without turning them into API failures', async () => {
    await request(appFor({ codexApp: { discover: async () => ({ managed: false, threadId: null }) } }))
      .get('/codex/session?pane=%251').expect(200, { managed: false, threadId: null });
    await request(appFor({ sessionId: null, codexApp: { discover: async () => ({ managed: true, threadId: null }) } }))
      .get('/codex/session?pane=%251').expect(200, { managed: true, threadId: null });
  });

  it('reads, exits and resumes the exact current Codex session without hooks', async () => {
    const harness = takeoverHarness();
    const app = appFor({
      codexApp: { discover: async () => ({ managed: false, threadId: null }) },
      commands: harness.commands,
      claudeEvents: harness.claudeEvents,
    });

    const response = await request(app).post('/codex/takeover').send({ pane: '%1' }).expect(200);
    expect(response.body).toEqual({
      started: true, takeover: { state: 'starting', needsTerminal: false },
    });
    expect(harness.commands.sendKey).toHaveBeenCalledWith('%1', 'C-c');
    expect(harness.commands.sendKey).toHaveBeenCalledTimes(1);
    expect(harness.commands.capturePlain).toHaveBeenCalledTimes(2);
    expect(harness.runPaneCommand).toHaveBeenCalledWith('%1', `handmux codex resume ${THREAD_ID}`);

    // A retry while startup is pending is idempotent and cannot interrupt the replacement.
    await request(app).post('/codex/takeover').send({ pane: '%1' }).expect(200);
    expect(harness.runPaneCommand).toHaveBeenCalledTimes(1);
  });

  it('does not restart the pane when Codex exit output has no verifiable session', async () => {
    const harness = takeoverHarness();
    harness.commands.capturePlain.mockReset().mockResolvedValue('recovery output unavailable');
    const app = appFor({
      codexApp: { discover: async () => ({ managed: false, threadId: null }) },
      commands: harness.commands,
      claudeEvents: harness.claudeEvents,
    });

    await request(app).post('/codex/takeover').send({ pane: '%1' })
      .expect(409, { error: 'codex-session-unconfirmed' });
    expect(harness.runPaneCommand).not.toHaveBeenCalled();
  });

  it('waits for a slow Codex exit without ever sending a second Ctrl+C', async () => {
    const harness = takeoverHarness();
    harness.claudeEvents.identifyPaneAgents
      .mockReset()
      .mockResolvedValueOnce({ '%1': 'codex' }) // preflight
      .mockResolvedValueOnce({ '%1': 'codex' })
      .mockResolvedValueOnce({ '%1': 'codex' })
      .mockResolvedValueOnce({ '%1': 'codex' })
      .mockResolvedValue({});
    const app = appFor({
      codexApp: { discover: async () => ({ managed: false, threadId: null }) },
      commands: harness.commands,
      claudeEvents: harness.claudeEvents,
    });
    await request(app).post('/codex/takeover').send({ pane: '%1' }).expect(200);
    expect(harness.commands.sendKey.mock.calls).toEqual([['%1', 'C-c']]);
    expect(harness.runPaneCommand).toHaveBeenCalledWith('%1', `handmux codex resume ${THREAD_ID}`);
  });

  it('sends a second Ctrl+C only after the full first exit window expires', async () => {
    const harness = takeoverHarness();
    const identify = harness.claudeEvents.identifyPaneAgents;
    identify.mockReset().mockImplementation(async () => (
      identify.mock.calls.length <= 11 ? { '%1': 'codex' } : {}
    )); // preflight + all 10 half-second polls remain Codex; the next poll observes the shell
    const app = appFor({
      codexApp: { discover: async () => ({ managed: false, threadId: null }) },
      commands: harness.commands,
      claudeEvents: harness.claudeEvents,
    });
    await request(app).post('/codex/takeover').send({ pane: '%1' }).expect(200);
    expect(harness.commands.sendKey.mock.calls).toEqual([['%1', 'C-c'], ['%1', 'C-c']]);
    expect(harness.runPaneCommand).toHaveBeenCalledWith('%1', `handmux codex resume ${THREAD_ID}`);
  }, 10_000);

  it('leaves a pane untouched when its live process is no longer Codex', async () => {
    const app = appFor({
      codexApp: { discover: async () => ({ managed: false, threadId: null }) },
      commands: { listLivePanes: async () => [{ id: '%1', cmd: 'zsh' }] },
      claudeEvents: { identifyPaneAgents: async () => ({}) },
    });
    await request(app).post('/codex/takeover').send({ pane: '%1' })
      .expect(409, { error: 'codex-pane-changed' });
  });

  it('does not restart a managed App Server that is still binding its first thread', async () => {
    const app = appFor({
      codexApp: { discover: async () => ({ managed: true, threadId: null }) },
      commands: {},
    });
    await request(app).post('/codex/takeover').send({ pane: '%1' })
      .expect(409, { error: 'codex-session-starting' });
  });

  it('does not expose a different App Server thread while takeover is starting', async () => {
    const discover = vi.fn()
      .mockResolvedValueOnce({ managed: false, threadId: null })
      .mockResolvedValueOnce({ managed: true, threadId: 'wrong-thread' })
      .mockResolvedValueOnce({ managed: true, threadId: THREAD_ID });
    const status = vi.fn(async () => ({ managed: true, threadId: THREAD_ID, status: { type: 'idle' } }));
    const harness = takeoverHarness();
    const app = appFor({
      codexApp: { discover, status },
      commands: harness.commands,
      claudeEvents: harness.claudeEvents,
    });

    await request(app).post('/codex/takeover').send({ pane: '%1' }).expect(200);
    const waiting = await request(app).get('/codex/session?pane=%251').expect(200);
    expect(waiting.body).toEqual({
      managed: false, threadId: null,
      takeover: { state: 'starting', needsTerminal: false },
    });
    await request(app).get('/codex/session?pane=%251').expect(200, {
      managed: true, threadId: THREAD_ID, status: { type: 'idle' },
    });
    expect(status).toHaveBeenCalledWith('%1', THREAD_ID);
  });

  it('caps takeover waiting at 30 seconds without claiming another App Server thread', async () => {
    const base = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(base);
    try {
      const harness = takeoverHarness();
      const app = appFor({
        codexApp: {
          discover: vi.fn()
            .mockResolvedValueOnce({ managed: false, threadId: null })
            .mockResolvedValue({ managed: true, threadId: 'wrong-thread' }),
        },
        commands: harness.commands,
        claudeEvents: harness.claudeEvents,
      });

      await request(app).post('/codex/takeover').send({ pane: '%1' }).expect(200);
      now.mockReturnValue(base + 30_000);
      await request(app).get('/codex/session?pane=%251').expect(200, {
        managed: false, threadId: null,
        takeover: { state: 'timed-out', needsTerminal: true },
      });
    } finally {
      now.mockRestore();
    }
  });

  it('rejects malformed structured responses before calling App Server', async () => {
    await request(appFor({ codexApp: {} }))
      .post('/codex/approval').send({ pane: '%1', requestId: null, decision: 'accept' })
      .expect(400, { error: 'bad approval response' });
    await request(appFor({ codexApp: {} }))
      .post('/codex/input').send({ pane: '%1', requestId: '92', answers: [] })
      .expect(400, { error: 'bad user input response' });
  });

  it('uses the only thread loaded by this managed pane before hooks bind its first turn', async () => {
    const status = vi.fn(async () => ({ managed: true, threadId: 'thread-new' }));
    const discover = vi.fn(async () => ({ managed: true, threadId: 'thread-new' }));
    await request(appFor({ sessionId: null, codexApp: { discover, status } }))
      .get('/codex/session?pane=%251').expect(200, { managed: true, threadId: 'thread-new' });
    expect(status).toHaveBeenCalledWith('%1', 'thread-new');
  });

  it('returns an actionable conflict when the pane is not managed', async () => {
    const send = vi.fn(async () => { throw new Error('Codex session is not managed by Handmux'); });
    await request(appFor({ codexApp: { send } }))
      .post('/codex/send').send({ pane: '%1', text: 'hello' })
      .expect(409, { error: 'Codex session is not managed by Handmux' });
  });

  it('lists models and updates model and effort for the bound thread', async () => {
    const models = vi.fn(async () => [{ id: 'model-1', model: 'gpt-test' }]);
    const updateSettings = vi.fn(async (_pane, _thread, updates) => updates);
    const app = appFor({ codexApp: { models, updateSettings } });
    await request(app).get('/codex/models?pane=%251').expect(200, {
      models: [{ id: 'model-1', model: 'gpt-test' }],
    });
    await request(app).post('/codex/settings').send({
      pane: '%1', model: 'gpt-new', effort: 'high',
    }).expect(200, { settings: {
      model: 'gpt-new', effort: 'high',
    } });
    expect(models).toHaveBeenCalledWith('%1', 'thread-1');
    expect(updateSettings).toHaveBeenCalledWith('%1', 'thread-1', {
      model: 'gpt-new', effort: 'high',
    });
  });

  it('reads and manages the native goal for the bound thread', async () => {
    const getGoal = vi.fn(async () => ({ objective: 'Ship it', status: 'active' }));
    const updateGoal = vi.fn(async (_pane, _thread, updates) => ({
      objective: updates.objective || 'Ship it', status: updates.status || 'active',
    }));
    const clearGoal = vi.fn(async () => ({ cleared: true }));
    const app = appFor({ codexApp: { getGoal, updateGoal, clearGoal } });

    await request(app).get('/codex/goal?pane=%251').expect(200, {
      goal: { objective: 'Ship it', status: 'active' },
    });
    await request(app).post('/codex/goal').send({ pane: '%1', objective: ' Finish tests ' })
      .expect(200, { goal: { objective: 'Finish tests', status: 'active' } });
    await request(app).post('/codex/goal').send({ pane: '%1', status: 'paused' })
      .expect(200, { goal: { objective: 'Ship it', status: 'paused' } });
    await request(app).post('/codex/goal/clear').send({ pane: '%1' }).expect(200, { cleared: true });

    expect(getGoal).toHaveBeenCalledWith('%1', 'thread-1');
    expect(updateGoal).toHaveBeenNthCalledWith(1, '%1', 'thread-1', { objective: 'Finish tests' });
    expect(updateGoal).toHaveBeenNthCalledWith(2, '%1', 'thread-1', { status: 'paused' });
    expect(clearGoal).toHaveBeenCalledWith('%1', 'thread-1');
  });

  it('accepts catalog service tiers, including returning to the default tier', async () => {
    const updateSettings = vi.fn(async (_pane, _thread, updates) => updates);
    const app = appFor({ codexApp: { updateSettings } });
    await request(app).post('/codex/settings').send({ pane: '%1', serviceTier: 'priority' })
      .expect(200, { settings: { serviceTier: 'priority' } });
    await request(app).post('/codex/settings').send({ pane: '%1', serviceTier: null })
      .expect(200, { settings: { serviceTier: null } });
    expect(updateSettings).toHaveBeenNthCalledWith(1, '%1', 'thread-1', { serviceTier: 'priority' });
    expect(updateSettings).toHaveBeenNthCalledWith(2, '%1', 'thread-1', { serviceTier: null });
  });

  it.each([
    ['default', {
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite' },
    }],
    ['auto-review', {
      approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite' },
    }],
    ['full-access', {
      approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' },
    }],
  ])('maps the %s permission mode to the matching App Server settings', async (permissionMode, expected) => {
    const updateSettings = vi.fn(async (_pane, _thread, updates) => updates);
    const app = appFor({ codexApp: { updateSettings } });

    await request(app).post('/codex/settings').send({ pane: '%1', permissionMode })
      .expect(200, { settings: expected });
    expect(updateSettings).toHaveBeenCalledWith('%1', 'thread-1', expected);
  });

  it('answers questions through the exact bound App Server thread', async () => {
    const answerInput = vi.fn(async () => ({ ok: true }));
    const app = appFor({ codexApp: { answerInput } });
    await request(app).post('/codex/input').send({
      pane: '%1', requestId: '92', answers: { color: ['蓝色'] },
    }).expect(200, { ok: true });
    expect(answerInput).toHaveBeenCalledWith('%1', 'thread-1', '92', { color: ['蓝色'] });
  });

  it('steers and removes queued messages through the exact bound thread', async () => {
    const steerQueued = vi.fn(async () => ({ steered: true }));
    const removeQueued = vi.fn(async () => ({ removed: true }));
    const app = appFor({ codexApp: { steerQueued, removeQueued } });

    await request(app).post('/codex/queue/steer').send({ pane: '%1', id: 'queued-1' })
      .expect(200, { steered: true });
    await request(app).post('/codex/queue/remove').send({ pane: '%1', id: 'queued-2' })
      .expect(200, { removed: true });
    expect(steerQueued).toHaveBeenCalledWith('%1', 'thread-1', 'queued-1');
    expect(removeQueued).toHaveBeenCalledWith('%1', 'thread-1', 'queued-2');
  });

  it('begins, renews, commits and cancels queued-message editing through the exact bound thread', async () => {
    const beginQueuedEdit = vi.fn(async () => ({ editing: true, token: 'edit-token' }));
    const renewQueuedEdit = vi.fn(async () => ({ editing: true }));
    const commitQueuedEdit = vi.fn(async () => ({ edited: true }));
    const cancelQueuedEdit = vi.fn(async () => ({ editing: false }));
    const app = appFor({ codexApp: {
      beginQueuedEdit, renewQueuedEdit, commitQueuedEdit, cancelQueuedEdit,
    } });

    await request(app).post('/codex/queue/edit/begin').send({ pane: '%1', id: 'queued-1' })
      .expect(200, { editing: true, token: 'edit-token' });
    await request(app).post('/codex/queue/edit/renew').send({
      pane: '%1', id: 'queued-1', token: 'edit-token',
    }).expect(200, { editing: true });
    await request(app).post('/codex/queue/edit/commit').send({
      pane: '%1', id: 'queued-1', token: 'edit-token', text: ' revised text ',
    }).expect(200, { edited: true });
    await request(app).post('/codex/queue/edit/cancel').send({
      pane: '%1', id: 'queued-2', token: 'edit-token-2',
    }).expect(200, { editing: false });

    expect(beginQueuedEdit).toHaveBeenCalledWith('%1', 'thread-1', 'queued-1');
    expect(renewQueuedEdit).toHaveBeenCalledWith('%1', 'thread-1', 'queued-1', 'edit-token');
    expect(commitQueuedEdit).toHaveBeenCalledWith(
      '%1', 'thread-1', 'queued-1', 'edit-token', 'revised text',
    );
    expect(cancelQueuedEdit).toHaveBeenCalledWith('%1', 'thread-1', 'queued-2', 'edit-token-2');
  });

  it('rejects empty or malformed settings updates', async () => {
    const app = appFor({ codexApp: { updateSettings: vi.fn() } });
    await request(app).post('/codex/settings').send({ pane: '%1' }).expect(400, { error: 'no settings supplied' });
    await request(app).post('/codex/settings').send({ pane: '%1', effort: '' }).expect(400, { error: 'bad effort' });
    await request(app).post('/codex/settings').send({ pane: '%1', serviceTier: '' })
      .expect(400, { error: 'bad serviceTier' });
    await request(app).post('/codex/settings').send({ pane: '%1', approvalPolicy: 'always' })
      .expect(400, { error: 'bad approvalPolicy' });
    await request(app).post('/codex/settings').send({ pane: '%1', permissionMode: 'automatic' })
      .expect(400, { error: 'bad permissionMode' });
    await request(app).post('/codex/goal').send({ pane: '%1', objective: '' })
      .expect(400, { error: 'bad goal objective' });
    await request(app).post('/codex/goal').send({ pane: '%1', status: 'complete' })
      .expect(400, { error: 'bad goal status' });
  });

});
