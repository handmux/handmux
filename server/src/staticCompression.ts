import compression from 'compression';
import type { RequestHandler } from 'express';

const compress = compression({ threshold: 1024 });

// Only compress Vite's content-hashed frontend assets. API responses keep their existing
// latency/streaming behavior, while the large JS/CSS needed for first paint becomes much smaller.
export const compressStaticAssets: RequestHandler = (req, res, next) => {
  if (!req.path.startsWith('/assets/')) return next();
  return compress(req, res, next);
};
