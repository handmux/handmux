import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { codexRoutes } from '../src/routes/codex.js';

function appFor({ sessionId = 'thread-1', bindingVersion = 2, agent = 'codex', codexApp = {} } = {}) {
  const app = express();
  app.use(express.json());
  app.use(codexRoutes({
    claudeEvents: {
      paneAgent: () => agent,
      paneSession: () => ({ agent, sessionId, bindingVersion }),
    },
    codexApp: {
      discover: async () => ({ managed: true, threadId: sessionId }),
      ...codexApp,
    },
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

  it('refuses unbound panes and malformed approval responses', async () => {
    await request(appFor({ sessionId: null, codexApp: { discover: async () => ({ managed: true, threadId: null }) } }))
      .get('/codex/session?pane=%251').expect(409, { error: 'Codex session is not bound yet' });
    await request(appFor({ codexApp: {} }))
      .post('/codex/approval').send({ pane: '%1', requestId: null, decision: 'accept' })
      .expect(400, { error: 'bad approval response' });
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

  it('rejects empty or malformed settings updates', async () => {
    const app = appFor({ codexApp: { updateSettings: vi.fn() } });
    await request(app).post('/codex/settings').send({ pane: '%1' }).expect(400, { error: 'no settings supplied' });
    await request(app).post('/codex/settings').send({ pane: '%1', effort: '' }).expect(400, { error: 'bad effort' });
  });
});
