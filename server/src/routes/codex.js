import express from 'express';
import { isPaneId } from '../tmux/commands.js';
import { isSessionUuid } from '../agents/scanUtils.js';

const TAKEOVER_TIMEOUT_MS = 8_000;

async function waitForTakeover(codexApp, pane, threadId, {
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = TAKEOVER_TIMEOUT_MS,
} = {}) {
  const deadline = now() + timeoutMs;
  do {
    try {
      const discovered = await codexApp.discover(pane);
      if (discovered?.managed && discovered.threadId === threadId) return discovered;
    } catch { /* the replacement process is still starting */ }
    await wait(100);
  } while (now() < deadline);
  throw new Error('Codex takeover timed out');
}

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
  const conflict = /not managed|no longer pending|decision is unavailable|bad user input response/i.test(message);
  return res.status(conflict ? 409 : 503).json({ error: message });
}

export function codexRoutes({
  codexApp,
  claudeEvents,
  commands,
  takeoverWait,
  takeoverNow,
  takeoverTimeoutMs = TAKEOVER_TIMEOUT_MS,
}) {
  const r = express.Router();
  if (!codexApp) return r;
  const takingOver = new Set();

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

  r.post('/codex/takeover', async (req, res) => {
    const pane = req.body?.pane;
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    if (!claudeEvents?.getStates || !claudeEvents?.paneSession || !commands?.respawnPane) {
      return res.status(503).json({ error: 'Codex takeover is unavailable' });
    }
    if (takingOver.has(pane)) return res.status(409).json({ error: 'codex-takeover-in-progress' });
    takingOver.add(pane);

    try {
      const existing = await codexApp.discover(pane);
      if (existing?.managed && existing.threadId) return res.json(await codexApp.status(pane, existing.threadId));

      // Re-confirm process identity at the mutation boundary. The client can be stale, and a pane id may
      // have been reused since it rendered the button; never kill whatever happens to occupy it now.
      const states = await claudeEvents.getStates();
      if (states?.[pane]?.agent !== 'codex') {
        return res.status(409).json({ error: 'codex-pane-unavailable' });
      }

      // Only a current Hook binding is safe. cwd→newest rollout guesses can select a different Codex when
      // two sessions share a project, while bindingVersion 2 is refreshed by SessionStart after /clear.
      const bound = claudeEvents.paneSession(pane);
      const threadId = bound?.sessionId;
      if (bound?.agent !== 'codex' || bound?.bindingVersion !== 2 || !isSessionUuid(threadId)) {
        return res.status(409).json({ error: 'codex-session-unbound' });
      }

      const cwd = bound.cwd || await commands.paneCurrentPath(pane);
      await commands.respawnPane(pane, cwd, `handmux codex resume ${threadId}`);
      await waitForTakeover(codexApp, pane, threadId, {
        wait: takeoverWait,
        now: takeoverNow,
        timeoutMs: takeoverTimeoutMs,
      });
      return res.json(await codexApp.status(pane, threadId));
    } catch (error) {
      return codexError(res, error);
    } finally {
      takingOver.delete(pane);
    }
  });

  r.post('/codex/send', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'message is empty' });
    try { res.json(await codexApp.send(target.pane, target.threadId, text)); }
    catch (error) { codexError(res, error); }
  });

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
