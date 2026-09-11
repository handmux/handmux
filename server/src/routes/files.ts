// File browsing under $HOME: read a doc, list/create a dir, download any file, and upload. The docs data
// layer realpaths + enforces the under-$HOME containment; these routes only map {error,status} to HTTP
// and own the multipart upload plumbing. Mounted under /api by createApiRouter.
import express from 'express';
import busboy from 'busboy';
import { promises as fsp, createWriteStream } from 'node:fs';
import { join as joinPath } from 'node:path';
import { randomBytes } from 'node:crypto';
import { safeUploadName } from '../docPath.js';
import { isAllowedUploadExt } from '../uploadTypes.js';
import type { NextFunction, Request, Response, Router } from 'express';
import type { WriteStream } from 'node:fs';
import type { createDocs } from '../docs.js';

type DocsService = ReturnType<typeof createDocs>;

interface FileRouteOptions {
  docs: DocsService;
  uploadExts: ReadonlySet<string>;
  maxUploadBytes: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function fileRoutes({ docs, uploadExts, maxUploadBytes }: FileRouteOptions): Router {
  const r = express.Router();

  // Read a single text file under $HOME. The docs layer realpaths, enforces containment and rejects
  // binary content; known Markdown/HTML extensions keep their richer renderer.
  // the route only maps its {error,status} to an HTTP status.
  r.get('/file', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Conditional read: `?mtime=<ms>` (the client's last-known mtime) lets the server answer
      // `{ notModified: true }` without re-reading/re-sending an unchanged doc.
      const m = Number(req.query.mtime);
      const knownMtime = Number.isFinite(m) ? m : null;
      const out = await docs.readDoc(typeof req.query.path === 'string' ? req.query.path : '', knownMtime);
      if ('error' in out) return res.status(out.status).json({ error: out.error });
      if (out.notModified) return res.json({ name: out.name, type: out.type, mtimeMs: out.mtimeMs, notModified: true });
      return res.json({ name: out.name, type: out.type, content: out.content, mtimeMs: out.mtimeMs });
    } catch (e) { return next(e); }
  });

  // List a directory under $HOME (empty path → $HOME). Only subdirs + md/html files are returned.
  r.get('/dir', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await docs.listDir(typeof req.query.path === 'string' ? req.query.path : '');
      if ('error' in out) return res.status(out.status).json({ error: out.error });
      return res.json(out);
    } catch (e) { return next(e); }
  });

  // Create a directory `name` inside `dir` (both must be under $HOME). docs.makeDir enforces the
  // boundary check and validates the name; the route maps {error,status} to an HTTP response.
  r.post('/dir', async (req: Request, res: Response, next: NextFunction) => {
    const body: unknown = req.body;
    const dir = isRecord(body) ? body.dir : undefined;
    const name = isRecord(body) ? body.name : undefined;
    if (typeof dir !== 'string' || typeof name !== 'string') return res.status(400).json({ error: 'bad request' });
    try {
      const out = await docs.makeDir(dir, name);
      if ('error' in out) return res.status(out.status).json({ error: out.error });
      return res.status(201).json({ path: out.real });
    } catch (e) { return next(e); }
  });

  // Download ANY regular file under $HOME (no extension white-list). docs.statForDownload enforces
  // the realpath+isUnder boundary and the 50MB cap; res.download streams it and forces
  // Content-Disposition: attachment (so HTML/SVG can never render inline → no stored-XSS via open).
  r.get('/download', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await docs.statForDownload(typeof req.query.path === 'string' ? req.query.path : '');
      if ('error' in out) return res.status(out.status).json({ error: out.error });
      // Conditional download for the inline image viewer: `?mtime=<ms>` (the client's last-known mtime)
      // → 304 when unchanged, so a large image isn't re-streamed just to re-view it. `X-Mtime` on the
      // 200 lets the client store the current mtime for the next check. Plain downloads pass no mtime.
      const m = Number(req.query.mtime);
      if (Number.isFinite(m) && m === out.mtimeMs) return res.status(304).end();
      res.setHeader('X-Mtime', String(out.mtimeMs));
      return res.download(out.real, out.name, (err) => { if (err && !res.headersSent) next(err); });
    } catch (e) { return next(e); }
  });

  // First free filename in `dir`: the name as-is, else Finder-style "base (1).ext", "base (2).ext", …
  // (the suffix goes before the extension). Bounded; a pathological fallback keeps it from looping.
  async function freeUploadName(dir: string, name: string): Promise<string> {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let cand = name;
    for (let n = 1; n <= 999; n++) {
      try { await fsp.access(joinPath(dir, cand)); } // exists → try the next suffix
      catch { return cand; }                          // ENOENT → free
      cand = `${base} (${n})${ext}`;
    }
    return `${base} (${randomBytes(3).toString('hex')})${ext}`;
  }

  // Upload a file into a directory under $HOME. Multipart streamed via busboy (the file never fully
  // buffers in memory, and the size cap aborts mid-stream). Guards, in order: target dir must be a
  // non-hidden subdir of home (resolveUploadDir); filename sanitised to a dotless basename; extension
  // in the allow-list. A name clash auto-suffixes (never overwrites). The client appends `dir` BEFORE
  // the file part, so the field is known by the time the file event fires.
  r.post('/upload', (req: Request, res: Response) => {
    let bb;
    // defParamCharset:'utf8' — browsers put a non-ASCII (e.g. Chinese) filename into the multipart
    // Content-Disposition as raw UTF-8 bytes; busboy's default 'latin1' would decode it to mojibake.
    try { bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fileSize: maxUploadBytes + 1 } }); }
    catch { return res.status(400).json({ error: 'bad multipart request' }); }

    let dir = '';
    let stash = false; // stash=1 → upload into the per-cwd space under ~/.handmux/uploads; `dir` is the cwd
    let sawFile = false;
    let handled = false;
    let ws: WriteStream | null = null;
    let tmp: string | null = null;
    const done = (status: number, body: Record<string, unknown>): void => {
      if (!handled) { handled = true; res.status(status).json(body); }
    };
    const cleanup = (): Promise<void> => (tmp ? fsp.rm(tmp, { force: true }).catch(() => {}) : Promise.resolve());

    bb.on('field', (name, val) => {
      if (name === 'dir') dir = val;
      else if (name === 'stash') stash = val === '1';
    });

    bb.on('file', async (_field, file, info) => {
      sawFile = true;
      try {
        const name = safeUploadName(info.filename);
        if (!name) { file.resume(); return done(400, { error: 'bad filename' }); }
        if (!isAllowedUploadExt(name, uploadExts)) { file.resume(); return done(415, { error: 'type not allowed' }); }

        const target = stash ? await docs.resolveStashDir(dir) : await docs.resolveUploadDir(dir);
        if ('error' in target) { file.resume(); return done(target.status, { error: target.error }); }

        // Finder-style de-dup: never 409 / overwrite on a name clash — pick the first free "base (n).ext".
        // Resolved up front for the response; re-resolved at link time if the race is lost (see below).
        const origName = name;
        let finalName = await freeUploadName(target.real, origName);
        let dest = joinPath(target.real, finalName);

        const tempPath = joinPath(target.real, `.${finalName}.uploading-${randomBytes(6).toString('hex')}`);
        tmp = tempPath;
        const writeStream = createWriteStream(tempPath);
        ws = writeStream;
        writeStream.on('error', () => { file.resume(); cleanup().finally(() => done(500, { error: 'write failed' })); });
        writeStream.on('finish', async () => {
          // busboy sets file.truncated synchronously when it emits 'limit'; it's reliably true here
          // if the stream exceeded the cap. (We size the limit at cap+1 so a file of EXACTLY
          // maxUploadBytes is allowed; only strictly-larger trips it.)
          if (file.truncated) { await cleanup(); return done(413, { error: 'too large' }); }
          try {
            // link (NOT rename): if the name appeared meanwhile (a concurrent upload won the race) link
            // throws EEXIST → we pick the NEXT free suffix and retry, so we still never overwrite another
            // file, and a clash auto-suffixes rather than 409s.
            let linked = false;
            for (let attempt = 0; attempt < 6 && !linked; attempt++) {
              try { await fsp.link(tempPath, dest); linked = true; }
              catch (e) {
                if (errorCode(e) !== 'EEXIST') throw e;
                finalName = await freeUploadName(target.real, origName);
                dest = joinPath(target.real, finalName);
              }
            }
            if (!linked) { await cleanup(); return done(409, { error: 'exists' }); }
            await cleanup(); // link made dest a second name for the data; drop the temp name
            const st = await fsp.stat(dest);
            done(201, { name: finalName, size: st.size, path: dest }); // absolute path: the dock pastes it in
          } catch { await cleanup(); done(500, { error: 'finalize failed' }); }
        });
        return void file.pipe(writeStream);
      } catch {
        // resolveUploadDir / fs errors etc. — never let the async handler reject (busboy won't catch
        // it → unhandledRejection + hung request).
        file.resume();
        await cleanup();
        return done(500, { error: 'upload failed' });
      }
    });

    bb.on('error', () => { cleanup().finally(() => done(400, { error: 'parse error' })); });
    bb.on('close', () => { if (!sawFile) done(400, { error: 'no file' }); });
    // Client aborted mid-upload (mobile networks drop constantly). req.pipe(bb) does NOT forward the
    // source's destroy to busboy, so ws/file/bb emit nothing — we'd leak the half-written temp file
    // and its fd on every dropped upload. Clean up ourselves on abort.
    req.on('aborted', () => { if (handled) return; handled = true; if (ws) ws.destroy(); cleanup(); });
    return req.pipe(bb);
  });

  return r;
}
