// git viewer (read-only). Each route calls the git data layer and maps its {error,status} to an HTTP
// status (same shape as the docs routes); the layer enforces the under-$HOME containment and validation.
import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import type { GitService } from '../git.js';

interface GitRouteOptions {
  git: GitService;
}

export function gitRoutes({ git }: GitRouteOptions): Router {
  const r = express.Router();
  const q = (value: unknown): string => (typeof value === 'string' ? value : '');

  r.get('/git/worktree', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await git.worktree(q(req.query.dir));
      if ('error' in out) return res.status(out.status).json({ error: out.error });
      return res.json({ worktree: out.worktree });
    } catch (e) { return next(e); }
  });
  r.get('/git/repos', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await git.detectRepos(q(req.query.dir));
      if ('error' in out) return res.status(out.status).json({ error: out.error });
      return res.json({ repos: out.repos });
    } catch (e) { return next(e); }
  });
  r.get('/git/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await git.status(q(req.query.repo));
      if ('error' in out) return res.status(out.status).json({ error: out.error });
      return res.json({ changes: out.changes });
    } catch (e) { return next(e); }
  });
  r.get('/git/log', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await git.log(q(req.query.repo), req.query.limit, req.query.ref ? q(req.query.ref) : undefined);
      if ('error' in out) return res.status(out.status).json({ error: out.error });
      return res.json({ commits: out.commits });
    } catch (e) { return next(e); }
  });
  r.get('/git/branches', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await git.branches(q(req.query.repo));
      if ('error' in out) return res.status(out.status).json({ error: out.error });
      return res.json({ branches: out.branches });
    } catch (e) { return next(e); }
  });
  r.get('/git/diff', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await git.diff(q(req.query.repo), {
        path: q(req.query.path),
        commit: req.query.commit ? q(req.query.commit) : undefined,
        staged: req.query.staged === '1',
      });
      if ('error' in out) return res.status(out.status).json({ error: out.error });
      return res.json({ diff: out.diff, truncated: out.truncated });
    } catch (e) { return next(e); }
  });
  r.get('/git/commit', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await git.commit(q(req.query.repo), q(req.query.hash));
      if ('error' in out) return res.status(out.status).json({ error: out.error });
      return res.json({ message: out.message, files: out.files });
    } catch (e) { return next(e); }
  });

  return r;
}
