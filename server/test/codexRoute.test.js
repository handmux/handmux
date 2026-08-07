import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { codexRoutes } from '../src/routes/codex.js';

function appFor({
  sessionId = 'thread-1', bindingVersion = 2, agent = 'codex', codexApp = {},
  commands = {}, claudeEvents = {}, routeOptions = {},
} = {}) {
  const app = express();
  app.use(express.json());
  app.use(codexRoutes({
    claudeEvents: {
      paneAgent: () => agent,
      paneSession: () => ({ agent, sessionId, bindingVersion }),
      getStates: async () => ({ '%1': { agent } }),
      ...claudeEvents,
    },
    commands: {
      paneCurrentPath: async () => '/work',
      respawnPane: async () => {},
      ...commands,
    },
    codexApp: {
      discover: async () => ({ managed: true, threadId: sessionId }),
      ...codexApp,
    },
    ...routeOptions,
  }));
  return app;
}

describe('Codex App Server routes', () => {
  it('binds every operation to the exact App Server thread without Hook metadata', async () => {
    const status = vi.fn(async () => ({ managed: true, threadId: 'thread-1' }));
    const send = vi.fn(async () => ({ turn: { id: 'turn-1' } }));
    const app = appFor({ agent: 'claude', codexApp: { status, send } });

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

  it('takes over the exact Hook-bound Codex session in the same pane', async () => {
    const sessionId = '019fbaf3-ff76-7923-a61a-c89a3acb8ca9';
    const respawnPane = vi.fn(async () => {});
    const status = vi.fn(async () => ({ managed: true, threadId: sessionId }));
    const discover = vi.fn()
      .mockResolvedValueOnce({ managed: false, threadId: null })
      .mockResolvedValue({ managed: true, threadId: sessionId });
    await request(appFor({
      sessionId,
      commands: { respawnPane },
      codexApp: { discover, status },
      routeOptions: { takeoverWait: async () => {} },
    })).post('/codex/takeover').send({ pane: '%1' }).expect(200, { managed: true, threadId: sessionId });

    expect(respawnPane).toHaveBeenCalledWith('%1', '/work', `handmux codex resume ${sessionId}`);
    expect(status).toHaveBeenCalledWith('%1', sessionId);
  });

  it('refuses takeover without a current exact binding', async () => {
    const respawnPane = vi.fn(async () => {});
    await request(appFor({
      sessionId: '019fbaf3-ff76-7923-a61a-c89a3acb8ca9',
      bindingVersion: 1,
      commands: { respawnPane },
      codexApp: { discover: async () => ({ managed: false, threadId: null }) },
    })).post('/codex/takeover').send({ pane: '%1' })
      .expect(409, { error: 'codex-session-unbound' });
    expect(respawnPane).not.toHaveBeenCalled();
  });

  it('rechecks that the pane is still Codex before replacing it', async () => {
    const respawnPane = vi.fn(async () => {});
    await request(appFor({
      sessionId: '019fbaf3-ff76-7923-a61a-c89a3acb8ca9',
      claudeEvents: { getStates: async () => ({ '%1': { agent: 'claude' } }) },
      commands: { respawnPane },
      codexApp: { discover: async () => ({ managed: false, threadId: null }) },
    })).post('/codex/takeover').send({ pane: '%1' })
      .expect(409, { error: 'codex-pane-unavailable' });
    expect(respawnPane).not.toHaveBeenCalled();
  });

  it('allows only one takeover mutation per pane at a time', async () => {
    const sessionId = '019fbaf3-ff76-7923-a61a-c89a3acb8ca9';
    let releaseRespawn;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const respawnPane = vi.fn(() => {
      markStarted();
      return new Promise((resolve) => { releaseRespawn = resolve; });
    });
    const discover = vi.fn()
      .mockResolvedValueOnce({ managed: false, threadId: null })
      .mockResolvedValue({ managed: true, threadId: sessionId });
    const app = appFor({
      sessionId,
      commands: { respawnPane },
      codexApp: { discover, status: async () => ({ managed: true, threadId: sessionId }) },
      routeOptions: { takeoverWait: async () => {} },
    });

    const first = request(app).post('/codex/takeover').send({ pane: '%1' })
      .expect(200, { managed: true, threadId: sessionId });
    const firstDone = first.then(() => {});
    await started;
    await request(app).post('/codex/takeover').send({ pane: '%1' })
      .expect(409, { error: 'codex-takeover-in-progress' });
    releaseRespawn();
    await firstDone;
    expect(respawnPane).toHaveBeenCalledTimes(1);
  });
});
