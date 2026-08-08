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

  it('revalidates the pane and resumes only the exact current Codex binding', async () => {
    const respawnPane = vi.fn(async () => {});
    const app = appFor({
      codexApp: { discover: async () => ({ managed: false, threadId: null }) },
      commands: {
        listLivePanes: async () => [{ id: '%1', cmd: 'codex' }],
        paneCurrentPath: async () => '/work/project',
        respawnPane,
      },
      claudeEvents: {
        identifyPaneAgents: async () => ({ '%1': 'codex' }),
        paneSession: () => ({ agent: 'codex', bindingVersion: 2, sessionId: THREAD_ID }),
      },
    });

    const response = await request(app).post('/codex/takeover').send({ pane: '%1' }).expect(200);
    expect(response.body).toEqual({
      started: true, takeover: { state: 'starting', needsTerminal: false },
    });
    expect(respawnPane).toHaveBeenCalledWith(
      '%1', '/work/project', `handmux codex resume ${THREAD_ID}`,
    );

    // A retry while startup is pending is idempotent and cannot kill the replacement twice.
    await request(app).post('/codex/takeover').send({ pane: '%1' }).expect(200);
    expect(respawnPane).toHaveBeenCalledTimes(1);
  });

  it('leaves the process untouched when the exact session binding is unavailable', async () => {
    const respawnPane = vi.fn(async () => {});
    const app = appFor({
      codexApp: { discover: async () => ({ managed: false, threadId: null }) },
      commands: {
        listLivePanes: async () => [{ id: '%1', cmd: 'codex' }],
        paneCurrentPath: async () => '/work/project',
        respawnPane,
      },
      claudeEvents: {
        identifyPaneAgents: async () => ({ '%1': 'codex' }),
        paneSession: () => null,
      },
    });

    await request(app).post('/codex/takeover').send({ pane: '%1' })
      .expect(409, { error: 'codex-session-unbound' });
    expect(respawnPane).not.toHaveBeenCalled();
  });

  it('leaves a pane untouched when its live process is no longer Codex', async () => {
    const respawnPane = vi.fn(async () => {});
    const app = appFor({
      codexApp: { discover: async () => ({ managed: false, threadId: null }) },
      commands: { listLivePanes: async () => [{ id: '%1', cmd: 'zsh' }], respawnPane },
      claudeEvents: { identifyPaneAgents: async () => ({}) },
    });
    await request(app).post('/codex/takeover').send({ pane: '%1' })
      .expect(409, { error: 'codex-pane-changed' });
    expect(respawnPane).not.toHaveBeenCalled();
  });

  it('does not restart a managed App Server that is still binding its first thread', async () => {
    const respawnPane = vi.fn(async () => {});
    const app = appFor({
      codexApp: { discover: async () => ({ managed: true, threadId: null }) },
      commands: { respawnPane },
    });
    await request(app).post('/codex/takeover').send({ pane: '%1' })
      .expect(409, { error: 'codex-session-starting' });
    expect(respawnPane).not.toHaveBeenCalled();
  });

  it('does not expose a different App Server thread while takeover is starting', async () => {
    const discover = vi.fn()
      .mockResolvedValueOnce({ managed: false, threadId: null })
      .mockResolvedValueOnce({ managed: true, threadId: 'wrong-thread' })
      .mockResolvedValueOnce({ managed: true, threadId: THREAD_ID });
    const status = vi.fn(async () => ({ managed: true, threadId: THREAD_ID, status: { type: 'idle' } }));
    const app = appFor({
      codexApp: { discover, status },
      commands: {
        listLivePanes: async () => [{ id: '%1', cmd: 'codex' }],
        paneCurrentPath: async () => '/work/project',
        respawnPane: async () => {},
      },
      claudeEvents: {
        identifyPaneAgents: async () => ({ '%1': 'codex' }),
        paneSession: () => ({ agent: 'codex', bindingVersion: 2, sessionId: THREAD_ID }),
      },
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
    await request(app).post('/codex/settings').send({ pane: '%1', model: 'gpt-new', effort: 'high' })
      .expect(200, { settings: { model: 'gpt-new', effort: 'high' } });
    expect(models).toHaveBeenCalledWith('%1', 'thread-1');
    expect(updateSettings).toHaveBeenCalledWith('%1', 'thread-1', { model: 'gpt-new', effort: 'high' });
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
  });

});
