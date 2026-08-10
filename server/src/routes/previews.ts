// Preview registry routes: register a static directory, list, and remove. Each registration returns a
// runtime-only capability URL; the main Handmux token is never exposed to preview content.
import express from 'express';
import { safePreviewName } from '../previews.js';
import type { NextFunction, Request, Response, Router } from 'express';
import type { PreviewRegistry } from '../previews.js';

interface PreviewRouteOptions {
  previews?: Pick<PreviewRegistry, 'register' | 'list' | 'remove'> | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function previewRoutes({ previews }: PreviewRouteOptions): Router {
  const r = express.Router();

  // POST {name,dir} registers a static directory served at /preview/<name>/.
  r.post('/previews', async (req: Request, res: Response, next: NextFunction) => {
    if (!previews) return res.status(503).json({ error: 'previews disabled' });
    const body: unknown = req.body;
    const name = isRecord(body) ? body.name : undefined;
    const dir = isRecord(body) ? body.dir : undefined;
    if (typeof name !== 'string' || !name || typeof dir !== 'string' || !dir) return res.status(400).json({ error: 'bad request' });
    try {
      const out = await previews.register({ name, dir });
      if ('error' in out) return res.status(out.status).json({ error: out.error });
      const url = `/preview/${encodeURIComponent(out.name)}/${encodeURIComponent(out.accessToken)}/`;
      return res.json({ name: out.name, kind: out.kind, url, expiresAt: out.expiresAt });
    } catch (e) { return next(e); }
  });

  r.get('/previews', (_req: Request, res: Response) => {
    if (!previews) return res.status(503).json({ error: 'previews disabled' });
    return res.json({ previews: previews.list() });
  });

  r.delete('/previews/:name', (req: Request, res: Response) => {
    if (!previews) return res.status(503).json({ error: 'previews disabled' });
    const name = req.params.name;
    if (!name || !safePreviewName(name)) return res.status(400).json({ error: 'bad name' });
    previews.remove(name);
    return res.status(204).end();
  });

  return r;
}
