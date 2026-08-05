import express from 'express';
import { isPaneId } from '../tmux/commands.js';

async function binding(claudeEvents, codexApp, pane) {
  if (!isPaneId(pane)) return { error: 'bad pane id', status: 400 };
  const agent = claudeEvents?.paneAgent?.(pane);
  const session = claudeEvents?.paneSession?.(pane);
  if (agent !== 'codex' && session?.agent !== 'codex') return { error: 'pane is not running Codex', status: 409 };
  if (session?.sessionId && session.bindingVersion === 2) return { pane, threadId: session.sessionId };
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
  const conflict = /not managed|no longer pending|decision is unavailable/i.test(message);
  return res.status(conflict ? 409 : 503).json({ error: message });
}

export function codexRoutes({ claudeEvents, codexApp }) {
  const r = express.Router();
  if (!codexApp) return r;

  r.get('/codex/session', async (req, res) => {
    const target = await binding(claudeEvents, codexApp, req.query.pane);
    if (routeError(res, target)) return;
    try { res.json(await codexApp.status(target.pane, target.threadId)); }
    catch (error) { codexError(res, error); }
  });

  r.post('/codex/send', async (req, res) => {
    const target = await binding(claudeEvents, codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'message is empty' });
    try { res.json(await codexApp.send(target.pane, target.threadId, text)); }
    catch (error) { codexError(res, error); }
  });

  r.post('/codex/compact', async (req, res) => {
    const target = await binding(claudeEvents, codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    try { res.json(await codexApp.compact(target.pane, target.threadId)); }
    catch (error) { codexError(res, error); }
  });

  r.post('/codex/interrupt', async (req, res) => {
    const target = await binding(claudeEvents, codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    try { res.json(await codexApp.interrupt(target.pane, target.threadId)); }
    catch (error) { codexError(res, error); }
  });

  r.post('/codex/approval', async (req, res) => {
    const target = await binding(claudeEvents, codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    const requestId = req.body?.requestId;
    const decision = req.body?.decision;
    if ((typeof requestId !== 'string' && typeof requestId !== 'number') || typeof decision !== 'string') {
      return res.status(400).json({ error: 'bad approval response' });
    }
    try { res.json(await codexApp.decide(target.pane, target.threadId, requestId, decision)); }
    catch (error) { codexError(res, error); }
  });

  return r;
}
