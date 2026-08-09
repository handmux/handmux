// server/src/previewServer.js
// Serves registered static-preview directories under a per-registration capability path. The main
// Handmux token is never a preview credential. Absolute-rooted assets (/assets/...) are served from the
// right preview dir via an authenticated Referer fallback (design's "方案 A").
// Dynamic ports and arbitrary websites are handled by the built-in browser instead.
import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tokenEquals } from './auth.js';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import type { ActivePreviewEntry, PreviewRegistry } from './previews.js';

function credentialOk(provided: unknown, token: unknown): boolean {
  if (!provided) return false;
  try { return tokenEquals(provided, token); } catch { return false; }
}

// Resolve the on-disk file for a request path under a preview: '' or '<dir>/' → its index.html.
function fileFor(rest: string): string { return (!rest || rest.endsWith('/')) ? `${rest}index.html` : rest; }

function previewHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Keep preview code isolated even if its capability URL is opened outside the in-app iframe.
  res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-downloads allow-modals allow-popups');
  // A sandboxed static document intentionally has an opaque origin. Its capability path needs to remain
  // readable by relative fetch(), module scripts, and fonts without restoring same-origin parent access.
  res.setHeader('Access-Control-Allow-Origin', 'null');
}

function prefixedRoot(url: string, prefix: string): string {
  return url.startsWith('/') && !url.startsWith('//') ? `${prefix}${url.slice(1)}` : url;
}

function rewriteCssRoots(source: string, prefix: string): string {
  return source
    .replace(/(url\(\s*["']?)\/(?!\/)/gi, `$1${prefix}`)
    .replace(/(@import\s+["'])\/(?!\/)/gi, `$1${prefix}`);
}

function rewriteModuleRoots(source: string, prefix: string): string {
  return source.replace(
    /(\b(?:from|import)\s*(?:\(\s*)?)(["'])\/(?!\/)/g,
    `$1$2${prefix}`,
  );
}

export function rewritePreviewText(source: string, extension: string, prefix: string): string {
  if (extension === '.css') return rewriteCssRoots(source, prefix);
  if (extension === '.js' || extension === '.mjs') return rewriteModuleRoots(source, prefix);
  if (extension !== '.html' && extension !== '.htm') return source;
  let output = source.replace(
    /(\b(?:src|href|action|poster|data|formaction)\s*=\s*)(["'])(\/[^"']*)\2/gi,
    (_match: string, start: string, quote: string, url: string) => `${start}${quote}${prefixedRoot(url, prefix)}${quote}`,
  );
  output = output.replace(
    /(\bsrcset\s*=\s*)(["'])([^"']*)\2/gi,
    (_match: string, start: string, quote: string, value: string) => {
      const rewritten = value.split(',').map((candidate: string) => {
        const match = /^(\s*)(\S+)(.*)$/.exec(candidate);
        return match ? `${match[1]}${prefixedRoot(match[2], prefix)}${match[3]}` : candidate;
      }).join(',');
      return `${start}${quote}${rewritten}${quote}`;
    },
  );
  output = output.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_match: string, open: string, css: string, close: string) => `${open}${rewriteCssRoots(css, prefix)}${close}`,
  );
  output = output.replace(
    /(\bstyle\s*=\s*)(["'])([^"']*)\2/gi,
    (_match: string, start: string, quote: string, css: string) => `${start}${quote}${rewriteCssRoots(css, prefix)}${quote}`,
  );
  return output.replace(
    /(<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_match: string, open: string, script: string, close: string) => `${open}${rewriteModuleRoots(script, prefix)}${close}`,
  );
}

interface CreatePreviewOptions {
  previews: Pick<PreviewRegistry, 'get'>;
}

interface PreviewServer {
  router: Router;
  refererFallback: RequestHandler;
}

const errorStatus = (error: unknown, fallback: number): number => {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const statusCode = Number((error as { statusCode?: unknown }).statusCode);
    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) return statusCode;
  }
  return fallback;
};

const errorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : null;
};

export function createPreview({ previews }: CreatePreviewOptions): PreviewServer {
  const router = express.Router();

  function resolveEntry(name: string, accessToken: string, res: Response): ActivePreviewEntry | null {
    const lookup = previews.get(name);
    if (lookup.state === 'missing') {
      res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><h1>预览不存在</h1>');
      return null;
    }
    if (lookup.state === 'expired') {
      res.status(410).type('html').send('<!doctype html><meta charset="utf-8"><h1>预览已过期</h1><p>请回到 app 重新启动预览。</p>');
      return null;
    }
    if (!credentialOk(accessToken, lookup.entry.accessToken)) {
      res.status(401).send('unauthorized');
      return null;
    }
    return lookup.entry;
  }

  async function serve(entry: ActivePreviewEntry, rest: string, prefix: string, res: Response): Promise<void> {
    previewHeaders(res);
    const requested = fileFor(rest);
    const segments = requested.split('/');
    const target = path.resolve(entry.dir, requested);
    const relative = path.relative(entry.dir, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
      || segments.some((segment) => segment.startsWith('.'))) {
      if (!relative && requested === 'index.html') {
        // The root index is the normal preview entry point.
      } else {
        res.status(404).end();
        return;
      }
    }
    const extension = path.extname(target).toLowerCase();
    if (['.html', '.htm', '.css', '.js', '.mjs'].includes(extension)) {
      try {
        const source = await fs.readFile(target, 'utf8');
        res.type(extension).send(rewritePreviewText(source, extension, prefix));
      } catch (error) {
        if (!res.headersSent) res.status(errorCode(error) === 'ENOENT' ? 404 : 500).end();
      }
      return;
    }
    res.sendFile(requested, { root: entry.dir, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(errorStatus(err, 404)).end();
    });
  }

  // A name without its independent capability is never accepted, including the old ?token=<app-token>
  // shape. Keeping this explicit makes the failure an authentication result instead of an SPA fallback.
  router.get('/:name', (_req: Request, res: Response) => res.status(401).send('unauthorized'));
  router.get('/:name/:accessToken', (req: Request, res: Response) => {
    const entry = resolveEntry(req.params.name, req.params.accessToken, res);
    if (!entry || res.headersSent) return undefined;
    const prefix = `/preview/${encodeURIComponent(req.params.name)}/${encodeURIComponent(req.params.accessToken)}/`;
    if (!(req.url.split('?', 1)[0] ?? '').endsWith('/')) {
      return res.redirect(301, prefix);
    }
    return void serve(entry, '', prefix, res);
  });
  router.get('/:name/:accessToken/*', (req: Request, res: Response) => {
    const entry = resolveEntry(req.params.name, req.params.accessToken, res);
    if (!entry || res.headersSent) return undefined;
    const prefix = `/preview/${encodeURIComponent(req.params.name)}/${encodeURIComponent(req.params.accessToken)}/`;
    return void serve(entry, req.params[0] ?? '', prefix, res);
  });

  // Referer fallback (mount AFTER /preview, BEFORE express.static): an absolute /assets/... request
  // whose Referer is a preview page is served from that preview's dir. Reuses credOk so it can never
  // read a dir without a valid token/cookie. Misses fall through to the normal static/SPA layer.
  function refererFallback(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/preview')) return next();
    const ref = req.headers.referer;
    if (!ref) return next();
    let refPath: string;
    try { refPath = new URL(ref).pathname; } catch { return next(); }
    const m = /^\/preview\/([^/]+)\/([^/]+)\//.exec(refPath);
    if (!m) return next();
    const encodedName = m[1];
    const encodedToken = m[2];
    if (!encodedName || !encodedToken) return next();
    let name: string;
    let accessToken: string;
    try {
      name = decodeURIComponent(encodedName);
      accessToken = decodeURIComponent(encodedToken);
    } catch { return next(); }
    const lookup = previews.get(name);
    if (lookup.state !== 'active') return next();
    if (!credentialOk(accessToken, lookup.entry.accessToken)) return next();
    previewHeaders(res);
    res.sendFile(req.path, { root: lookup.entry.dir, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) next();
    });
  }

  return { router, refererFallback };
}
