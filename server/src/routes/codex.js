import express from 'express';
import { isPaneId } from '../tmux/commands.js';
import { getAgent } from '../agents/index.js';

const TAKEOVER_TERMINAL_HINT_MS = 5_000;

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

export function codexRoutes({ codexApp, commands, claudeEvents }) {
  const r = express.Router();
  if (!codexApp) return r;
  // A takeover is pane-scoped and deliberately kept in server memory. Besides making repeated taps
  // idempotent, this gates discovery while the replacement process starts: App Server may briefly list
  // another historical thread, but the UI must not enter chat until the exact pre-takeover thread appears.
  const takeovers = new Map(); // pane -> { threadId, startedAt }
  const takeoverView = (takeover) => ({
    state: 'starting', needsTerminal: Date.now() - takeover.startedAt >= TAKEOVER_TERMINAL_HINT_MS,
  });

  r.get('/codex/session', async (req, res) => {
    const pane = req.query.pane;
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    const takeover = takeovers.get(pane);
    try {
      const discovered = await codexApp.discover(pane);
      if (takeover && discovered?.threadId !== takeover.threadId) {
        return res.json({ managed: false, threadId: null, takeover: takeoverView(takeover) });
      }
      if (takeover) takeovers.delete(pane);
      if (!discovered?.managed || !discovered.threadId) {
        return res.json({ managed: !!discovered?.managed, threadId: discovered?.threadId || null });
      }
      return res.json(await codexApp.status(pane, discovered.threadId));
    } catch (error) {
      // A killed plain Codex and its replacement App Server have a normal short disconnect window. Keep
      // the takeover page stable through it instead of flashing a generic connection failure.
      if (takeover) return res.json({ managed: false, threadId: null, takeover: takeoverView(takeover) });
      return codexError(res, error);
    }
  });

  r.post('/codex/takeover', async (req, res) => {
    const pane = req.body?.pane;
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    const pending = takeovers.get(pane);
    if (pending) return res.json({ started: true, takeover: takeoverView(pending) });
    try {
      const discovered = await codexApp.discover(pane);
      if (discovered?.managed && discovered.threadId) {
        return res.json({ started: false, managed: true, threadId: discovered.threadId });
      }
      if (discovered?.managed) return res.status(409).json({ error: 'codex-session-starting' });

      // Re-check live process identity immediately before killing anything. A stale client must never
      // respawn a pane whose Codex has already exited or been replaced by another command.
      const panes = await commands?.listLivePanes?.();
      const live = Array.isArray(panes) ? panes.find((candidate) => candidate.id === pane) : null;
      if (!live) return res.status(404).json({ error: 'codex-pane-gone' });
      const agents = await claudeEvents?.identifyPaneAgents?.(panes) || {};
      if (agents[pane] !== 'codex') return res.status(409).json({ error: 'codex-pane-changed' });

      // Hooks are not the managed chat source, but a current v2 binding is the only safe way to know which
      // plain Codex session to resume. Never fall back to cwd/newest-rollout heuristics here.
      const hooked = claudeEvents?.paneSession?.(pane);
      const driver = getAgent('codex');
      if (hooked?.agent !== 'codex'
        || hooked.bindingVersion !== driver.sessions.bindingVersion
        || !driver.sessions.isId(hooked.sessionId)) {
        return res.status(409).json({ error: 'codex-session-unbound' });
      }

      const cwd = await commands.paneCurrentPath(pane);
      const takeover = { threadId: hooked.sessionId, startedAt: Date.now() };
      takeovers.set(pane, takeover);
      try {
        await commands.respawnPane(pane, cwd, driver.sessions.managedResumeCmd(hooked.sessionId));
      } catch (error) {
        takeovers.delete(pane);
        throw error;
      }
      return res.json({ started: true, takeover: takeoverView(takeover) });
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
