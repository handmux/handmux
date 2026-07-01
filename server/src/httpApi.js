import express from 'express';
import { expressAuth } from './auth.js';
import { isPaneId, isWindowId, isSessionId, isValidSessionName, isValidStartupCmd } from './tmux/commands.js';
import * as defaultCommands from './tmux/commands.js';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { capTrailingBlankRows } from './trimCapture.js';
import { defaultDocs, MAX_TRANSFER_BYTES } from './docs.js';
import { defaultGit } from './git.js';
import * as push from './push.js';
import { buildIatSignedUrl } from './asr/iflySign.js';
import { asrConfig, isAsrConfigured } from './asr/iflyConfig.js';
import { createClaudeEvents } from './claudeEvents.js';
import busboy from 'busboy';
import { promises as fsp, createWriteStream } from 'node:fs';
import { join as joinPath, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { safeUploadName } from './docPath.js';
import { safePreviewName } from './previews.js';
import { isAllowedUploadExt, DEFAULT_UPLOAD_EXTS } from './uploadTypes.js';
import { hooksStatus, installHooks } from './cli/claudeHooks.js';
import { claudeStatePath } from './cli/state.js';
import { scanOrphans, defaultProjectsDir } from './orphans.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOOKS_SRC = resolvePath(here, '../hooks'); // server/hooks (bundled scripts)

const ALLOWED_KEYS = new Set([
  'Up', 'Down', 'Left', 'Right', 'Space', 'Enter', 'Escape', 'Tab', 'BTab', 'BSpace',
  'C-c', 'C-d', 'C-z', 'C-l', 'C-r', 'C-o', 'C-e',
]);

// Pause between typing the text and pressing Enter on a /send. A TUI like Claude Code needs a
// beat to ingest the pasted line; without it, the Enter can fold into the input as a newline
// instead of submitting. 120ms is imperceptible but enough to settle.
const SUBMIT_GAP_MS = 120;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function createApiRouter({
  token, commands = defaultCommands, docs = defaultDocs, git = defaultGit, events,
  uploadExts = DEFAULT_UPLOAD_EXTS, maxUploadBytes = MAX_TRANSFER_BYTES,
  asrEnv = process.env, previews, previewDomain = null,
  home = homedir(), stateFile = process.env.CLAUDE_STATE_FILE || claudeStatePath(homedir()),
} = {}) {
  const r = express.Router();
  r.use(expressAuth(token));
  r.use(express.json());
  const claudeEvents = events || createClaudeEvents({ commands, push });

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

  // --- git viewer (read-only) ----------------------------------------------------------------
  // Each route calls the git data layer and maps its {error,status} to an HTTP status (same shape
  // as the docs routes); the layer enforces the under-$HOME containment and validation.
  const q = (v) => (typeof v === 'string' ? v : '');
  r.get('/git/repos', async (req, res, next) => {
    try {
      const out = await git.detectRepos(q(req.query.dir));
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ repos: out.repos });
    } catch (e) { next(e); }
  });
  r.get('/git/status', async (req, res, next) => {
    try {
      const out = await git.status(q(req.query.repo));
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ changes: out.changes });
    } catch (e) { next(e); }
  });
  r.get('/git/log', async (req, res, next) => {
    try {
      const out = await git.log(q(req.query.repo), req.query.limit, req.query.ref ? q(req.query.ref) : undefined);
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ commits: out.commits });
    } catch (e) { next(e); }
  });
  r.get('/git/branches', async (req, res, next) => {
    try {
      const out = await git.branches(q(req.query.repo));
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ branches: out.branches });
    } catch (e) { next(e); }
  });
  r.get('/git/diff', async (req, res, next) => {
    try {
      const out = await git.diff(q(req.query.repo), {
        path: q(req.query.path),
        commit: req.query.commit ? q(req.query.commit) : undefined,
        staged: req.query.staged === '1',
      });
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ diff: out.diff, truncated: out.truncated });
    } catch (e) { next(e); }
  });
  r.get('/git/commit', async (req, res, next) => {
    try {
      const out = await git.commit(q(req.query.repo), q(req.query.hash));
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ message: out.message, files: out.files });
    } catch (e) { next(e); }
  });

  // Read a single doc (md/html) under $HOME. The docs layer realpaths and enforces containment;
  // the route only maps its {error,status} to an HTTP status.
  r.get('/file', async (req, res, next) => {
    try {
      const out = await docs.readDoc(typeof req.query.path === 'string' ? req.query.path : '');
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ name: out.name, type: out.type, content: out.content });
    } catch (e) { next(e); }
  });

  // List a directory under $HOME (empty path → $HOME). Only subdirs + md/html files are returned.
  r.get('/dir', async (req, res, next) => {
    try {
      const out = await docs.listDir(typeof req.query.path === 'string' ? req.query.path : '');
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json(out);
    } catch (e) { next(e); }
  });

  // Create a directory `name` inside `dir` (both must be under $HOME). docs.makeDir enforces the
  // boundary check and validates the name; the route maps {error,status} to an HTTP response.
  r.post('/dir', async (req, res, next) => {
    const { dir, name } = req.body || {};
    if (typeof dir !== 'string' || typeof name !== 'string') return res.status(400).json({ error: 'bad request' });
    try {
      const out = await docs.makeDir(dir, name);
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.status(201).json({ path: out.real });
    } catch (e) { next(e); }
  });

  // Download ANY regular file under $HOME (no extension white-list). docs.statForDownload enforces
  // the realpath+isUnder boundary and the 50MB cap; res.download streams it and forces
  // Content-Disposition: attachment (so HTML/SVG can never render inline → no stored-XSS via open).
  r.get('/download', async (req, res, next) => {
    try {
      const out = await docs.statForDownload(typeof req.query.path === 'string' ? req.query.path : '');
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.download(out.real, out.name, (err) => { if (err && !res.headersSent) next(err); });
    } catch (e) { next(e); }
  });

  // Upload a file into a directory under $HOME. Multipart streamed via busboy (the file never fully
  // buffers in memory, and the size cap aborts mid-stream). Guards, in order: target dir must be a
  // non-hidden subdir of home (resolveUploadDir); filename sanitised to a dotless basename; extension
  // in the allow-list; no overwrite of an existing name. The client appends `dir` BEFORE the file
  // part, so the field is known by the time the file event fires.
  r.post('/upload', (req, res) => {
    let bb;
    // defParamCharset:'utf8' — browsers put a non-ASCII (e.g. Chinese) filename into the multipart
    // Content-Disposition as raw UTF-8 bytes; busboy's default 'latin1' would decode it to mojibake.
    try { bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fileSize: maxUploadBytes + 1 } }); }
    catch { return res.status(400).json({ error: 'bad multipart request' }); }

    let dir = '';
    let stash = false; // stash=1 → upload into the per-cwd space under ~/.handmux/uploads; `dir` is the cwd
    let sawFile = false;
    let handled = false;
    let ws = null;
    let tmp = null;
    const done = (status, body) => { if (!handled) { handled = true; res.status(status).json(body); } };
    const cleanup = () => (tmp ? fsp.rm(tmp, { force: true }).catch(() => {}) : Promise.resolve());

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
        if (target.error) { file.resume(); return done(target.status, { error: target.error }); }

        const dest = joinPath(target.real, name);
        try { await fsp.access(dest); file.resume(); return done(409, { error: 'exists' }); }
        catch { /* name free → proceed */ }

        tmp = joinPath(target.real, `.${name}.uploading-${randomBytes(6).toString('hex')}`);
        ws = createWriteStream(tmp);
        ws.on('error', () => { file.resume(); cleanup().finally(() => done(500, { error: 'write failed' })); });
        ws.on('finish', async () => {
          // busboy sets file.truncated synchronously when it emits 'limit'; it's reliably true here
          // if the stream exceeded the cap. (We size the limit at cap+1 so a file of EXACTLY
          // maxUploadBytes is allowed; only strictly-larger trips it.)
          if (file.truncated) { await cleanup(); return done(413, { error: 'too large' }); }
          try {
            // link (NOT rename): if the name appeared meanwhile (a concurrent upload won the race)
            // link throws EEXIST → the loser gets 409. So we NEVER silently overwrite another file.
            try { await fsp.link(tmp, dest); }
            catch (e) { if (e.code === 'EEXIST') { await cleanup(); return done(409, { error: 'exists' }); } throw e; }
            await cleanup(); // link made dest a second name for the data; drop the temp name
            const st = await fsp.stat(dest);
            done(201, { name, size: st.size, path: dest }); // absolute path: the dock pastes it into the box
          } catch { await cleanup(); done(500, { error: 'finalize failed' }); }
        });
        file.pipe(ws);
      } catch {
        // resolveUploadDir / fs errors etc. — never let the async handler reject (busboy won't catch
        // it → unhandledRejection + hung request).
        file.resume();
        await cleanup();
        done(500, { error: 'upload failed' });
      }
    });

    bb.on('error', () => { cleanup().finally(() => done(400, { error: 'parse error' })); });
    bb.on('close', () => { if (!sawFile) done(400, { error: 'no file' }); });
    // Client aborted mid-upload (mobile networks drop constantly). req.pipe(bb) does NOT forward the
    // source's destroy to busboy, so ws/file/bb emit nothing — we'd leak the half-written temp file
    // and its fd on every dropped upload. Clean up ourselves on abort.
    req.on('aborted', () => { if (handled) return; handled = true; if (ws) ws.destroy(); cleanup(); });
    req.pipe(bb);
  });

  r.get('/history', async (req, res, next) => {
    if (!isPaneId(req.query.pane)) return res.status(400).json({ error: 'bad pane id' });
    const lines = Math.min(Math.max(Number(req.query.lines) || 1000, 1), 5000);
    try {
      // Cap the empty grid below the cursor (a fresh shell is "prompt + a wall of blank rows") so the
      // phone's bottom-anchored render shows content instead of blank — and so the hash/body/render
      // all key off the same trimmed capture. See trimCapture.js.
      const raw = await commands.capturePane(req.query.pane, lines);
      const ansi = capTrailingBlankRows(raw);
      const { width, height, cursorX, cursorY, cursorVisible } = await commands.paneInfo(req.query.pane);
      // The cursor's row counted from the BOTTOM of the (trimmed) capture. The live screen is the
      // capture's last `height` rows, so the cursor sits `height-1-cursorY` rows above the bottom —
      // less however many trailing blank rows capTrailingBlankRows dropped (all of them below the
      // cursor). The client re-places xterm's cursor this many rows up from the seed's last row.
      const rowsOf = (s) => (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n').length;
      const cur = {
        row: Math.max(0, (height - 1 - cursorY) - (rowsOf(raw) - rowsOf(ansi))),
        col: cursorX, vis: cursorVisible,
      };
      // Short content hash over size + cursor + ansi. The client echoes its last hash as ?since=… ;
      // an unchanged screen returns 204 (empty) so an idle pane stops re-sending the whole capture.
      // The cursor is folded in so a bare left/right (which moves the cursor but not the text) still
      // yields a fresh frame — otherwise the move would 204 and the cursor would never visibly track.
      const hash = createHash('sha1')
        .update(`${width}x${height}\n${cur.col},${cursorY},${cur.vis ? 1 : 0}\n${ansi}`)
        .digest('hex').slice(0, 16);
      if (req.query.since === hash) return res.status(204).end();
      const json = JSON.stringify({ ansi, width, height, hash, cur });
      res.set('Content-Type', 'application/json');
      res.set('Vary', 'Accept-Encoding'); // both 200 branches vary on encoding (correct for any caching proxy)
      // Capture text is mostly SGR codes + spaces — gzip crushes it ~10x. (204s are empty, never gzipped.)
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        res.set('Content-Encoding', 'gzip');
        // gzipSync is fine here — captures are KBs; the event-loop stall is sub-ms.
        res.end(gzipSync(json));
      } else {
        res.end(json);
      }
    } catch (e) { next(e); }
  });

  r.post('/send', async (req, res, next) => {
    const { pane, text, enter } = req.body || {};
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    const body = typeof text === 'string' ? text : '';
    try {
      await commands.exitCopyModeIfActive(pane);
      await commands.sendText(pane, body);
      if (enter) {
        if (body) await delay(SUBMIT_GAP_MS); // a bare Enter has nothing to settle — send at once
        await commands.sendEnter(pane);
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Resize the tmux window so it reflows to the phone (auto:false), or hand sizing back to
  // attached clients (auto:true). NOTE: this mutates the shared window — the PC's view of it
  // changes too.
  r.get('/layout', async (req, res, next) => {
    if (!isWindowId(req.query.window)) return res.status(400).json({ error: 'bad window id' });
    try { res.json({ layout: await commands.getWindowLayout(req.query.window) }); }
    catch (e) { next(e); }
  });

  r.post('/resize', async (req, res, next) => {
    const { window, pane, cols, rows, auto, layout } = req.body || {};
    const c = Math.min(Math.max(Number(cols) || 0, 20), 500);
    try {
      if (auto) {
        if (!isWindowId(window)) return res.status(400).json({ error: 'bad window id' });
        // restore the split arrangement (resizePane) then hand window sizing back (resizeWindow)
        if (typeof layout === 'string' && layout) await commands.applyWindowLayout(window, layout);
        await commands.restoreWindowSize(window);
      } else if (isPaneId(pane)) {
        await commands.resizePane(pane, c); // a pane in a split — resize only it
      } else if (isWindowId(window)) {
        const rw = rows != null ? Math.min(Math.max(Number(rows) || 0, 5), 500) : null;
        await commands.resizeWindow(window, c, rw); // a lone pane fills the window
      } else {
        return res.status(400).json({ error: 'bad resize target' });
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/keys', async (req, res, next) => {
    const { pane, keys } = req.body || {};
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    if (!Array.isArray(keys) || keys.some((k) => !ALLOWED_KEYS.has(k))) {
      return res.status(400).json({ error: 'disallowed key' });
    }
    try {
      await commands.exitCopyModeIfActive(pane);
      for (const k of keys) await commands.sendKey(pane, k);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // --- Capabilities probe ---------------------------------------------------------------------
  // Optional integrations are configured per-install (open-source installs ship without keys), so the
  // client asks what's actually available and hides controls that can't work — e.g. the mic when no
  // ASR engine is configured. Add more flags here as optional integrations land.
  r.get('/config', (req, res) => {
    res.json({ asr: isAsrConfigured(asrEnv), claudeHooks: hooksStatus(home) });
  });

  // One-tap enable from the phone: install the Claude Code hooks on the host (token-gated, like every API
  // here). Opt-in — the inbox only offers this when status is 'absent'. Never creates ~/.claude.
  r.post('/hooks/install', (req, res) => {
    try {
      const { status } = installHooks(home, { srcDir: HOOKS_SRC, stateFile });
      res.json({ ok: status === 'installed', status });
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  });

  // --- Voice input: iFlytek IAT signed-URL handoff -------------------------------------------
  // The browser connects to iFlytek directly; we only mint a short-lived signed wss URL so the
  // apiSecret never reaches the phone. 503 if creds aren't configured (front-end hides the mic).
  r.get('/asr/sign', (req, res) => {
    if (!isAsrConfigured(asrEnv)) return res.status(503).json({ error: 'asr not configured' });
    const { appId, apiKey, apiSecret } = asrConfig(asrEnv);
    res.json(buildIatSignedUrl({ appId, apiKey, apiSecret, date: new Date().toUTCString() }));
  });

  // --- Web Push (minimal slice) ---------------------------------------------------------------
  // The client needs the VAPID public key to subscribe; 503 if the server has no keys configured.
  r.get('/push/vapid', (req, res) => {
    if (!push.isConfigured()) return res.status(503).json({ error: 'push not configured' });
    res.json({ key: push.publicKey() });
  });

  // Store a browser PushSubscription, then immediately fire a welcome push back to it — so enabling
  // the toggle proves the whole pipe (subscribe → push service → SW → notification) end to end.
  r.post('/push/subscribe', async (req, res, next) => {
    const sub = req.body?.subscription;
    const boundSessions = Array.isArray(req.body?.boundSessions) ? req.body.boundSessions : [];
    if (!sub || typeof sub.endpoint !== 'string') return res.status(400).json({ error: 'bad subscription' });
    try {
      push.addSubscription(sub, boundSessions);
      await push.sendToOne(sub, { title: '通知已开启 ✅', body: '会话「需要你」或「已完成」时提醒你', tag: 'handmux-welcome' }, { topic: 'handmux', urgency: 'high' });
      res.json({ ok: true, count: push.count() });
    } catch (e) { next(e); }
  });

  r.post('/push/unsubscribe', (req, res) => {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint === 'string') push.removeSubscription(endpoint);
    res.json({ ok: true });
  });

  // Manual "send me a test" — pushes to every stored subscription.
  r.post('/push/test', async (req, res, next) => {
    try {
      const out = await push.sendToAll(
        { title: 'handmux 测试', body: '这是一条测试通知 — 点我回到 app', tag: 'handmux-test' },
        { topic: 'handmux', urgency: 'high' },
      );
      res.json(out);
    } catch (e) { next(e); }
  });

  // Client reports which sessions this device cares about; updates the stored subscription.
  r.post('/push/bound', (req, res) => {
    const endpoint = req.body?.endpoint;
    const boundSessions = Array.isArray(req.body?.boundSessions) ? req.body.boundSessions : [];
    if (typeof endpoint === 'string') push.updateBound(endpoint, boundSessions);
    res.json({ ok: true });
  });

  // ?sessions=a,b scopes the roster to the session NAMES this device subscribed to (per-device inbox
  // isolation). Omitted → null → all (back-compat); present-but-empty → [] → nothing.
  r.get('/states', async (req, res, next) => {
    const q = req.query.sessions;
    const allowed = q === undefined ? null : String(q).split(',').map((s) => s.trim()).filter(Boolean);
    try { res.json(await claudeEvents.getStates(allowed)); } catch (e) { next(e); }
  });

  // Orphan Claude sessions: `claude` processes running on this host but NOT inside a tmux pane, so
  // handmux can't steer them. Surfaced at the bottom of the Inbox with a "takeover" (spawn
  // `claude --resume` in tmux). Best-effort process scan (see orphans.js); never throws.
  r.get('/orphans', async (req, res, next) => {
    try { res.json(await scanOrphans({ projectsDir: defaultProjectsDir(home) })); } catch (e) { next(e); }
  });

  // --- Preview registry (static dir OR dynamic port) -----------------------------------------
  // POST {name,dir} registers a static dir served at /preview/<name>/; POST {name,port} registers a
  // dynamic reverse-proxy reachable at https://<name>.<DOMAIN>/ (only when previewDomain is set). The
  // url carries ?token= so the browser's first navigation sets the preview cookie.
  r.post('/previews', async (req, res, next) => {
    if (!previews) return res.status(503).json({ error: 'previews disabled' });
    const { name, dir, port } = req.body || {};
    if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'bad request' });
    const hasPort = port !== undefined && port !== null && port !== '';
    if (!hasPort && (typeof dir !== 'string' || !dir)) return res.status(400).json({ error: 'bad request' });
    try {
      const out = await previews.register(hasPort ? { name, port } : { name, dir });
      if (out.error) return res.status(out.status).json({ error: out.error });
      const url = out.kind === 'dynamic'
        ? `https://${encodeURIComponent(out.name)}.${previewDomain}/?token=${encodeURIComponent(token)}`
        : `/preview/${encodeURIComponent(out.name)}/?token=${encodeURIComponent(token)}`;
      res.json({ name: out.name, kind: out.kind, url, expiresAt: out.expiresAt });
    } catch (e) { next(e); }
  });

  r.get('/previews', (req, res) => {
    if (!previews) return res.status(503).json({ error: 'previews disabled' });
    res.json({ previews: previews.list(), dynamicEnabled: !!previewDomain, domain: previewDomain });
  });

  r.delete('/previews/:name', (req, res) => {
    if (!previews) return res.status(503).json({ error: 'previews disabled' });
    if (!safePreviewName(req.params.name)) return res.status(400).json({ error: 'bad name' });
    previews.remove(req.params.name);
    res.status(204).end();
  });

  return r;
}
