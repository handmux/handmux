// Session / window / pane management routes. Each validates its tmux ids/names at the boundary, then
// delegates to the tmux command layer (which self-guards too). Mounted under /api by createApiRouter.
import express from 'express';
import { isPaneId, isWindowId, isSessionId, isValidSessionName, isValidStartupCmd } from '../tmux/commands.js';
import type { NextFunction, Request, Response, Router } from 'express';
import type { TmuxPane, TmuxSession, TmuxWindow } from '../tmux/commands.js';
import type { RealPathResult } from '../docs.js';
import type { LivePane } from '../agent-runtime/adapter.js';

interface SessionCommands {
  listSessions(): Promise<TmuxSession[]>;
  newSession(name: string, cwd?: string | null, command?: string | null): Promise<string>;
  listWindows(sessionId: string): Promise<TmuxWindow[]>;
  newWindow(sessionId: string, cwd?: string | null, name?: string | null, command?: string | null): Promise<string>;
  paneCurrentPath(paneId: string): Promise<string>;
  renameSession(sessionId: string, name: string): Promise<unknown>;
  renameWindow(windowId: string, name: string): Promise<unknown>;
  swapWindows(firstWindowId: string, secondWindowId: string): Promise<unknown>;
  killWindow(windowId: string): Promise<unknown>;
  listPanes(windowId: string): Promise<TmuxPane[]>;
  splitPane(paneId: string, direction: 'h' | 'v', cwd: string): Promise<string>;
  windowPaneCount(paneId: string): Promise<number>;
  killPane(paneId: string): Promise<unknown>;
}
interface SessionDocs { resolveCwd(cwd: unknown): Promise<RealPathResult> }
interface WorkspaceNotifier {
  requestReconcile?(): unknown;
  confirmEmpty?(): unknown;
}
interface AgentIdentity {
  identifyPanes?(panes: readonly LivePane[]): Promise<unknown> | unknown;
}
interface SessionRouteOptions {
  commands: SessionCommands;
  docs: SessionDocs;
  workspace?: WorkspaceNotifier | null;
  agentIdentity?: AgentIdentity | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const requestBody = (req: Request): Record<string, unknown> => isRecord(req.body) ? req.body : {};
const missingTmuxTarget = (error: unknown, kind: 'session' | 'window'): boolean => (
  error instanceof Error && error.message.includes(`can't find ${kind}:`)
);

export function sessionRoutes({ commands, docs, workspace, agentIdentity }: SessionRouteOptions): Router {
  const r = express.Router();

  function notify(method: keyof WorkspaceNotifier): void {
    try { Promise.resolve(workspace?.[method]?.()).catch(() => {}); } catch { /* optional best effort */ }
  }

  r.get('/sessions', async (_req: Request, res: Response, next: NextFunction) => {
    try { return res.json(await commands.listSessions()); } catch (e) { return next(e); }
  });

  r.post('/sessions', async (req: Request, res: Response, next: NextFunction) => {
    const body = requestBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!isValidSessionName(name)) return res.status(400).json({ error: 'bad session name' });
    const { cwd } = body;
    const cmd = typeof body.cmd === 'string' ? body.cmd.trim() : '';
    if (cmd && !isValidStartupCmd(cmd)) return res.status(400).json({ error: 'bad startup command' });
    try {
      if ((await commands.listSessions()).some((s) => s.name === name)) {
        return res.status(409).json({ error: 'exists' });
      }
      let startDir; // undefined → newSession uses $HOME (old behavior)
      if (cwd != null) {
        const out = await docs.resolveCwd(cwd);
        if ('error' in out) return res.status(out.status).json({ error: out.error });
        startDir = out.real;
      }
      const id = await commands.newSession(name, startDir, cmd || undefined);
      notify('requestReconcile');
      return res.status(201).json({ id, name });
    } catch (e) { return next(e); }
  });

  r.get('/windows', async (req: Request, res: Response, next: NextFunction) => {
    if (!isSessionId(req.query.session)) return res.status(400).json({ error: 'bad session id' });
    try { return res.json(await commands.listWindows(req.query.session)); } catch (e) {
      if (missingTmuxTarget(e, 'session')) return res.status(404).json({ error: 'session not found' });
      return next(e);
    }
  });

  r.post('/windows', async (req: Request, res: Response, next: NextFunction) => {
    const body = requestBody(req);
    const { session, pane, name, cwd } = body;
    if (!isSessionId(session)) return res.status(400).json({ error: 'bad session id' });
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    // The window name is optional (blank → tmux auto-names); when given it shares the session name rule.
    const wname = typeof name === 'string' ? name.trim() : '';
    if (wname && !isValidSessionName(wname)) return res.status(400).json({ error: 'bad window name' });
    const cmd = typeof body.cmd === 'string' ? body.cmd.trim() : '';
    if (cmd && !isValidStartupCmd(cmd)) return res.status(400).json({ error: 'bad startup command' });
    try {
      let startDir;
      if (cwd != null) {
        const out = await docs.resolveCwd(cwd);
        if ('error' in out) return res.status(out.status).json({ error: out.error });
        startDir = out.real;
      } else {
        startDir = await commands.paneCurrentPath(pane); // old behavior: inherit the pane's dir
      }
      const id = await commands.newWindow(session, startDir, wname || undefined, cmd || undefined);
      notify('requestReconcile');
      return res.status(201).json({ id });
    } catch (e) { return next(e); }
  });

  r.patch('/sessions', async (req: Request, res: Response, next: NextFunction) => {
    const body = requestBody(req);
    const { id } = body;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!isSessionId(id)) return res.status(400).json({ error: 'bad session id' });
    if (!isValidSessionName(name)) return res.status(400).json({ error: 'bad session name' });
    try {
      // Block only a collision with a DIFFERENT session — renaming to the current name is a no-op,
      // not a conflict (the user may have opened the modal and kept the name).
      if ((await commands.listSessions()).some((s) => s.name === name && s.id !== id)) {
        return res.status(409).json({ error: 'exists' });
      }
      await commands.renameSession(id, name);
      notify('requestReconcile');
      return res.json({ id, name });
    } catch (e) { return next(e); }
  });

  r.patch('/windows', async (req: Request, res: Response, next: NextFunction) => {
    const body = requestBody(req);
    const { id } = body;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!isWindowId(id)) return res.status(400).json({ error: 'bad window id' });
    // Window names share the session-name rule. tmux allows duplicate window names, so no 409 check.
    if (!isValidSessionName(name)) return res.status(400).json({ error: 'bad window name' });
    try {
      await commands.renameWindow(id, name);
      notify('requestReconcile');
      return res.json({ id, name });
    } catch (e) { return next(e); }
  });

  r.post('/windows/swap', async (req: Request, res: Response, next: NextFunction) => {
    const { a, b } = requestBody(req);
    if (!isWindowId(a) || !isWindowId(b)) return res.status(400).json({ error: 'bad window id' });
    if (a === b) return res.status(400).json({ error: 'same window' });
    // swap-window is non-destructive and reversible, so unlike DELETE we don't re-verify the windows
    // server-side — the client only ever swaps adjacent windows of the open session.
    try {
      await commands.swapWindows(a, b);
      notify('requestReconcile');
      return res.json({ ok: true });
    } catch (e) { return next(e); }
  });

  r.delete('/windows', async (req: Request, res: Response, next: NextFunction) => {
    if (!isWindowId(req.query.window)) return res.status(400).json({ error: 'bad window id' });
    try {
      // Killing the only window takes the whole session down with it — that's allowed and intended.
      // The client warns ("确认后将删除整个会话") before sending, so there's no last-window guard here.
      await commands.killWindow(req.query.window);
      notify('confirmEmpty');
      return res.status(204).end();
    } catch (e) { return next(e); }
  });

  r.get('/panes', async (req: Request, res: Response, next: NextFunction) => {
    if (!isWindowId(req.query.window)) return res.status(400).json({ error: 'bad window id' });
    try {
      const panes = await commands.listPanes(req.query.window);
      let agents: Record<string, string | null> = {};
      try {
        const value = await agentIdentity?.identifyPanes?.(panes.map((pane) => ({
          paneId: pane.id,
          sessionName: '',
          windowId: req.query.window as string,
          windowName: '',
          currentCommand: pane.command,
          ...(pane.tty ? { tty: pane.tty } : {}),
        })));
        if (isRecord(value)) {
          agents = Object.fromEntries(Object.entries(value).filter(
            (entry): entry is [string, string | null] => typeof entry[1] === 'string' || entry[1] === null,
          ));
        }
      } catch { /* identity is additive */ }
      return res.json(panes.map(({ tty: _tty, ...pane }) => (
        Object.hasOwn(agents, pane.id) ? { ...pane, agent: agents[pane.id] } : pane
      )));
    } catch (e) {
      if (missingTmuxTarget(e, 'window')) return res.status(404).json({ error: 'window not found' });
      return next(e);
    }
  });

  // A pane's current working directory — the file browser uses it to land on (and "jump to") the
  // session's dir. Absolute path; the client folds it to a home-relative path and lets the existing
  // /dir listing enforce the under-$HOME boundary (a cwd outside $HOME just fails to browse).
  r.get('/pane-cwd', async (req: Request, res: Response, next: NextFunction) => {
    if (!isPaneId(req.query.pane)) return res.status(400).json({ error: 'bad pane id' });
    try { return res.json({ cwd: await commands.paneCurrentPath(req.query.pane) }); } catch (e) { return next(e); }
  });

  r.post('/panes/split', async (req: Request, res: Response, next: NextFunction) => {
    const body = requestBody(req);
    const { pane, dir } = body;
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    if (dir !== 'h' && dir !== 'v') return res.status(400).json({ error: 'bad direction' });
    try {
      const cwd = await commands.paneCurrentPath(pane); // new pane inherits the pane's dir
      const id = await commands.splitPane(pane, dir, cwd);
      notify('requestReconcile');
      return res.status(201).json({ id });
    } catch (e) { return next(e); }
  });

  r.delete('/panes', async (req: Request, res: Response, next: NextFunction) => {
    if (!isPaneId(req.query.pane)) return res.status(400).json({ error: 'bad pane id' });
    try {
      // Never let the phone collapse a window/session: refuse to kill the last pane. The map UI only
      // offers close at ≥2 panes, so this is a defensive boundary, not a normal path.
      if (await commands.windowPaneCount(req.query.pane) <= 1) {
        return res.status(409).json({ error: 'last pane' });
      }
      await commands.killPane(req.query.pane);
      notify('requestReconcile');
      return res.status(204).end();
    } catch (e) { return next(e); }
  });

  return r;
}
