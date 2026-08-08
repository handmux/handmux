import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { codexRoutes } from '../src/routes/codex.js';

function appFor({
  sessionId = 'thread-1', codexApp = {}, commands = {}, claudeEvents = {},
} = {}) {
  const app = express();
  app.use(express.json());
  app.use(codexRoutes({
    codexApp: {
      discover: async () => ({ managed: true, threadId: sessionId }),
      ...codexApp,
    },
    commands,
    claudeEvents,
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
  it('binds every operation to the exact App Server thread without Hook metadata', async () => {
    const status = vi.fn(async () => ({ managed: true, threadId: 'thread-1' }));
    const send = vi.fn(async () => ({ turn: { id: 'turn-1' } }));
    const app = appFor({ codexApp: { status, send } });

    await request(app).get('/codex/session?pane=%251').expect(200, { managed: true, threadId: 'thread-1' });
    await request(app).post('/codex/send').send({ pane: '%1', text: ' continue ' }).expect(200);
    expect(status).toHaveBeenCalledWith('%1', 'thread-1');
    expect(send).toHaveBeenCalledWith('%1', 'thread-1', 'continue');
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

  it('lists models and updates model, effort, and approval policy for the bound thread', async () => {
    const models = vi.fn(async () => [{ id: 'model-1', model: 'gpt-test' }]);
    const updateSettings = vi.fn(async (_pane, _thread, updates) => updates);
    const app = appFor({ codexApp: { models, updateSettings } });
    await request(app).get('/codex/models?pane=%251').expect(200, {
      models: [{ id: 'model-1', model: 'gpt-test' }],
    });
    await request(app).post('/codex/settings').send({
      pane: '%1', model: 'gpt-new', effort: 'high', approvalPolicy: 'never',
    }).expect(200, { settings: { model: 'gpt-new', effort: 'high', approvalPolicy: 'never' } });
    expect(models).toHaveBeenCalledWith('%1', 'thread-1');
    expect(updateSettings).toHaveBeenCalledWith('%1', 'thread-1', {
      model: 'gpt-new', effort: 'high', approvalPolicy: 'never',
    });
  });

  it('clears and answers questions through the exact bound App Server thread', async () => {
    const clear = vi.fn(async () => ({ threadId: 'thread-new' }));
    const answerInput = vi.fn(async () => ({ ok: true }));
    const app = appFor({ codexApp: { clear, answerInput } });
    await request(app).post('/codex/clear').send({ pane: '%1' })
      .expect(200, { threadId: 'thread-new' });
    await request(app).post('/codex/input').send({
      pane: '%1', requestId: '92', answers: { color: ['蓝色'] },
    }).expect(200, { ok: true });
    expect(clear).toHaveBeenCalledWith('%1', 'thread-1');
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

  it('rejects empty or malformed settings updates', async () => {
    const app = appFor({ codexApp: { updateSettings: vi.fn() } });
    await request(app).post('/codex/settings').send({ pane: '%1' }).expect(400, { error: 'no settings supplied' });
    await request(app).post('/codex/settings').send({ pane: '%1', effort: '' }).expect(400, { error: 'bad effort' });
    await request(app).post('/codex/settings').send({ pane: '%1', approvalPolicy: 'always' })
      .expect(400, { error: 'bad approvalPolicy' });
  });

});
