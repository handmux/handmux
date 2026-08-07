import express from 'express';
import { isPaneId } from '../tmux/commands.js';

async function binding(codexApp, pane) {
  if (!isPaneId(pane)) return { error: 'bad pane id', status: 400 };
  try {
    const discovered = await codexApp?.discover?.(pane);
    if (!discovered?.managed) return { error: 'Codex session is not managed by Handmux', status: 409 };
    if (discovered.threadId) return { pane, threadId: discovered.threadId };
  } catch (error) {
    return { error: error?.message || String(error), status: 503 };
  }
  return { error: 'Codex session is not bound yet', status: 409 };
}

function routeError(res, result) {
  if (!result.error) return false;
  res.status(result.status).json({ error: result.error });
  return true;
}

function codexError(res, error) {
  const message = error?.message || String(error);
  const conflict = /not managed|session changed|no longer pending|already being sent|queue is full|decision is unavailable|bad user input response/i.test(message);
  return res.status(conflict ? 409 : 503).json({ error: message });
}

export function codexRoutes({ codexApp }) {
  const r = express.Router();
  if (!codexApp) return r;

  r.get('/codex/session', async (req, res) => {
    const pane = req.query.pane;
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    try {
      const discovered = await codexApp.discover(pane);
      if (!discovered?.managed || !discovered.threadId) {
        return res.json({ managed: !!discovered?.managed, threadId: discovered?.threadId || null });
      }
      return res.json(await codexApp.status(pane, discovered.threadId));
    } catch (error) { return codexError(res, error); }
  });

  r.post('/codex/send', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'message is empty' });
    try { res.json(await codexApp.send(target.pane, target.threadId, text)); }
    catch (error) { codexError(res, error); }
  });

  for (const [path, method] of [['/codex/queue/steer', 'steerQueued'], ['/codex/queue/remove', 'removeQueued']]) {
    r.post(path, async (req, res) => {
      const target = await binding(codexApp, req.body?.pane);
      if (routeError(res, target)) return;
      const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
      if (!id || id.length > 128) return res.status(400).json({ error: 'bad queued message id' });
      try { res.json(await codexApp[method](target.pane, target.threadId, id)); }
      catch (error) { codexError(res, error); }
    });
  }

  r.post('/codex/compact', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    try { res.json(await codexApp.compact(target.pane, target.threadId)); }
    catch (error) { codexError(res, error); }
  });

  r.post('/codex/clear', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    try { res.json(await codexApp.clear(target.pane, target.threadId)); }
    catch (error) { codexError(res, error); }
  });

  r.get('/codex/models', async (req, res) => {
    const target = await binding(codexApp, req.query.pane);
    if (routeError(res, target)) return;
    try { res.json({ models: await codexApp.models(target.pane, target.threadId) }); }
    catch (error) { codexError(res, error); }
  });

  r.post('/codex/settings', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    const updates = {};
    for (const key of ['model', 'effort']) {
      const value = req.body?.[key];
      if (value == null) continue;
      if (typeof value !== 'string' || !value.trim() || value.length > 128) {
        return res.status(400).json({ error: `bad ${key}` });
      }
      updates[key] = value.trim();
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no settings supplied' });
    try { res.json({ settings: await codexApp.updateSettings(target.pane, target.threadId, updates) }); }
    catch (error) { codexError(res, error); }
  });

  r.post('/codex/interrupt', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    try { res.json(await codexApp.interrupt(target.pane, target.threadId)); }
    catch (error) { codexError(res, error); }
  });

  r.post('/codex/approval', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    const requestId = req.body?.requestId;
    const decision = req.body?.decision;
    if ((typeof requestId !== 'string' && typeof requestId !== 'number') || typeof decision !== 'string') {
      return res.status(400).json({ error: 'bad approval response' });
    }
    try { res.json(await codexApp.decide(target.pane, target.threadId, requestId, decision)); }
    catch (error) { codexError(res, error); }
  });

  r.post('/codex/input', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    const requestId = req.body?.requestId;
    const answers = req.body?.answers;
    const entries = answers && typeof answers === 'object' && !Array.isArray(answers)
      ? Object.entries(answers) : [];
    if ((typeof requestId !== 'string' && typeof requestId !== 'number') || !entries.length
      || entries.some(([questionId, value]) => !questionId || !Array.isArray(value) || !value.length
        || value.some((answer) => typeof answer !== 'string' || !answer.trim()))) {
      return res.status(400).json({ error: 'bad user input response' });
    }
    try { res.json(await codexApp.answerInput(target.pane, target.threadId, requestId, answers)); }
    catch (error) { codexError(res, error); }
  });

  return r;
}
