// Session / window / pane management routes. Each validates its tmux ids/names at the boundary, then
// delegates to the tmux command layer (which self-guards too). Mounted under /api by createApiRouter.
import express from 'express';
import { isPaneId, isWindowId, isSessionId, isValidSessionName, isValidStartupCmd } from '../tmux/commands.js';

export function sessionRoutes({ commands, docs }) {
  const r = express.Router();

  r.get('/sessions', async (req, res, next) => {
    try { res.json(await commands.listSessions()); } catch (e) { next(e); }
  });

  r.post('/sessions', async (req, res, next) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!isValidSessionName(name)) return res.status(400).json({ error: 'bad session name' });
    const { cwd } = req.body || {};
    const cmd = typeof req.body?.cmd === 'string' ? req.body.cmd.trim() : '';
    if (cmd && !isValidStartupCmd(cmd)) return res.status(400).json({ error: 'bad startup command' });
    try {
      if ((await commands.listSessions()).some((s) => s.name === name)) {
        return res.status(409).json({ error: 'exists' });
      }
      let startDir; // undefined → newSession uses $HOME (old behavior)
      if (cwd != null) {
        const out = await docs.resolveCwd(cwd);
        if (out.error) return res.status(out.status).json({ error: out.error });
        startDir = out.real;
      }
      const id = await commands.newSession(name, startDir, cmd || undefined);
      res.status(201).json({ id, name });
    } catch (e) { next(e); }
  });

  r.get('/windows', async (req, res, next) => {
    if (!isSessionId(req.query.session)) return res.status(400).json({ error: 'bad session id' });
    try { res.json(await commands.listWindows(req.query.session)); } catch (e) { next(e); }
  });

  r.post('/windows', async (req, res, next) => {
    const { session, pane, name, cwd } = req.body || {};
    if (!isSessionId(session)) return res.status(400).json({ error: 'bad session id' });
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    // The window name is optional (blank → tmux auto-names); when given it shares the session name rule.
    const wname = typeof name === 'string' ? name.trim() : '';
    if (wname && !isValidSessionName(wname)) return res.status(400).json({ error: 'bad window name' });
    const cmd = typeof req.body?.cmd === 'string' ? req.body.cmd.trim() : '';
    if (cmd && !isValidStartupCmd(cmd)) return res.status(400).json({ error: 'bad startup command' });
    try {
      let startDir;
      if (cwd != null) {
        const out = await docs.resolveCwd(cwd);
        if (out.error) return res.status(out.status).json({ error: out.error });
        startDir = out.real;
      } else {
        startDir = await commands.paneCurrentPath(pane); // old behavior: inherit the pane's dir
      }
      const id = await commands.newWindow(session, startDir, wname || undefined, cmd || undefined);
      res.status(201).json({ id });
    } catch (e) { next(e); }
  });

  r.patch('/sessions', async (req, res, next) => {
    const { id } = req.body || {};
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!isSessionId(id)) return res.status(400).json({ error: 'bad session id' });
    if (!isValidSessionName(name)) return res.status(400).json({ error: 'bad session name' });
    try {
      // Block only a collision with a DIFFERENT session — renaming to the current name is a no-op,
      // not a conflict (the user may have opened the modal and kept the name).
      if ((await commands.listSessions()).some((s) => s.name === name && s.id !== id)) {
        return res.status(409).json({ error: 'exists' });
      }
      await commands.renameSession(id, name);
      res.json({ id, name });
    } catch (e) { next(e); }
  });

  r.patch('/windows', async (req, res, next) => {
    const { id } = req.body || {};
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!isWindowId(id)) return res.status(400).json({ error: 'bad window id' });
    // Window names share the session-name rule. tmux allows duplicate window names, so no 409 check.
    if (!isValidSessionName(name)) return res.status(400).json({ error: 'bad window name' });
    try {
      await commands.renameWindow(id, name);
      res.json({ id, name });
    } catch (e) { next(e); }
  });

  r.post('/windows/swap', async (req, res, next) => {
    const { a, b } = req.body || {};
    if (!isWindowId(a) || !isWindowId(b)) return res.status(400).json({ error: 'bad window id' });
    if (a === b) return res.status(400).json({ error: 'same window' });
    // swap-window is non-destructive and reversible, so unlike DELETE we don't re-verify the windows
    // server-side — the client only ever swaps adjacent windows of the open session.
    try {
      await commands.swapWindows(a, b);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete('/windows', async (req, res, next) => {
    if (!isWindowId(req.query.window)) return res.status(400).json({ error: 'bad window id' });
    try {
      // Killing the only window takes the whole session down with it — that's allowed and intended.
      // The client warns ("确认后将删除整个会话") before sending, so there's no last-window guard here.
      await commands.killWindow(req.query.window);
      res.status(204).end();
    } catch (e) { next(e); }
  });

  r.get('/panes', async (req, res, next) => {
    if (!isWindowId(req.query.window)) return res.status(400).json({ error: 'bad window id' });
    try { res.json(await commands.listPanes(req.query.window)); } catch (e) { next(e); }
  });

  // A pane's current working directory — the file browser uses it to land on (and "jump to") the
  // session's dir. Absolute path; the client folds it to a home-relative path and lets the existing
  // /dir listing enforce the under-$HOME boundary (a cwd outside $HOME just fails to browse).
  r.get('/pane-cwd', async (req, res, next) => {
    if (!isPaneId(req.query.pane)) return res.status(400).json({ error: 'bad pane id' });
    try { res.json({ cwd: await commands.paneCurrentPath(req.query.pane) }); } catch (e) { next(e); }
  });

  r.post('/panes/split', async (req, res, next) => {
    const { pane } = req.body || {};
    const dir = req.body?.dir;
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    if (dir !== 'h' && dir !== 'v') return res.status(400).json({ error: 'bad direction' });
    try {
      const cwd = await commands.paneCurrentPath(pane); // new pane inherits the pane's dir
      const id = await commands.splitPane(pane, dir, cwd);
      res.status(201).json({ id });
    } catch (e) { next(e); }
  });

  r.delete('/panes', async (req, res, next) => {
    if (!isPaneId(req.query.pane)) return res.status(400).json({ error: 'bad pane id' });
    try {
      // Never let the phone collapse a window/session: refuse to kill the last pane. The map UI only
      // offers close at ≥2 panes, so this is a defensive boundary, not a normal path.
      if (await commands.windowPaneCount(req.query.pane) <= 1) {
        return res.status(409).json({ error: 'last pane' });
      }
      await commands.killPane(req.query.pane);
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return r;
}
