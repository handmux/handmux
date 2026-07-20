import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { loadToken } from './auth.js';
import { createApiRouter } from './httpApi.js';
import { loadUploadExts } from './uploadTypes.js';
import { createClaudeEvents } from './claudeEvents.js';
import { syncHooks } from './cli/claudeHooks.js';
import { claudeStatePath } from './cli/state.js';
import * as commands from './tmux/commands.js';
import * as push from './push.js';
import { cacheControlFor } from './staticCache.js';
import { applyAppName, applyManifestName } from './appName.js';
import { homedir } from 'node:os';
import { createPreviews } from './previews.js';
import { createPreview } from './previewServer.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// There is ONE config source — ~/.handmux/config.json — and ONE way to run handmux: `handmux start`
// (the CLI; `node bin/handmux.js start` from a source checkout is the same thing). The CLI resolves
// the config and spawns this server with everything it needs in the environment, so the server reads
// only process.env here (no .env files, no NODE_ENV branching). Running this file directly is not a
// supported entry point — go through the CLI.
const cfg = loadConfig();
const token = loadToken();
const uploadExts = loadUploadExts();

// The inbox is driven by a JSON state file the Claude hooks maintain (server/hooks/handmux-notify.sh →
// handmux-write.js). We only READ it. start() watches it so idle/permission push fires even when no
// client is polling; getStates reads it fresh on each /states.
const events = createClaudeEvents({ commands, push });
events.start();

// Keep an already-opted-in user's Claude hooks in step with this handmux version on restart: newly-added
// lifecycle events (e.g. SessionStart, which rebinds the 对话 lens after /clear) and a refreshed
// handmux-write.cjs land via `./deploy.sh` alone — no phone re-enable. A strict no-op unless our hooks are
// already installed; best-effort and must never block or crash startup (pure fs, no subprocess).
try {
  syncHooks(homedir(), {
    srcDir: path.resolve(here, '../hooks'),
    stateFile: process.env.CLAUDE_STATE_FILE || claudeStatePath(homedir()),
  });
} catch { /* best effort — hook sync never fails startup */ }

// Static-site + dynamic preview. The dynamic side is enabled by HANDMUX_PREVIEW_DOMAIN (the wildcard
// base domain, e.g. preview.example.com); unset → static only. One registry instance is shared by the
// API (register/list/remove), the /preview static layer, and the Host-based dynamic proxy.
const previewDomain = process.env.HANDMUX_PREVIEW_DOMAIN || null;
const previews = createPreviews({ home: homedir(), dynamicEnabled: !!previewDomain });
const preview = createPreview({ previews, token, domain: previewDomain });

const app = express();
// Host-based dispatch FIRST: a request to <name>.<domain> is reverse-proxied to its dynamic preview;
// every other Host falls straight through (next()) to the app below, unaffected.
app.use(preview.dynamicProxy);
app.use('/api', createApiRouter({ token, events, uploadExts, previews, previewDomain, shortcuts: cfg.shortcuts }));
app.use('/preview', preview.router);
app.use(preview.refererFallback);

// Serve the built web client so one process hosts both the API and the frontend (single origin, no dev
// proxy). Prefer the bundled copy inside the package (server/public — what `npm publish` ships); fall back
// to the sibling web/dist of a source checkout. Override either with HANDMUX_STATIC_DIR.
const bundledDir = path.resolve(here, '../public');
const sourceDir = path.resolve(here, '../../web/dist');
const staticDir = process.env.HANDMUX_STATIC_DIR || (fs.existsSync(bundledDir) ? bundledDir : sourceDir);
const indexPath = path.join(staticDir, 'index.html');

// Optional custom instance name (handmux start --name). When set, the prebuilt shell + manifest are
// rewritten on the way out so the browser-tab title and "Add to Home Screen" label match the user's
// name — the bundle ships generic and is renamed at serve time, never rebuilt. Unset → serve as-is.
const appName = process.env.HANDMUX_APP_NAME || null;
let renamedIndex = null; // computed once; the name is fixed for the process lifetime
if (appName) {
  app.get('/manifest.webmanifest', (req, res, next) => {
    try {
      const raw = fs.readFileSync(path.join(staticDir, 'manifest.webmanifest'), 'utf8');
      res.type('application/manifest+json').send(JSON.stringify(applyManifestName(JSON.parse(raw), appName)));
    } catch { next(); }
  });
}

// index:false so the renamed shell below owns "/" too (otherwise static would serve the generic one).
app.use(express.static(staticDir, {
  index: false,
  // Cache-Control policy lives in staticCache.js (unit-tested): index.html + sw.js are never cached
  // (stale-shell / stale-SW trap), content-hashed assets cache forever.
  setHeaders: (res, filePath) => res.setHeader('Cache-Control', cacheControlFor(filePath)),
}));
// SPA fallback: serve index.html for any non-API GET (client routing lives in the URL hash, so
// the server only ever needs to hand back the one HTML shell). API 404s pass through untouched.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.setHeader('Cache-Control', 'no-store');
  if (appName) {
    try {
      if (renamedIndex == null) renamedIndex = applyAppName(fs.readFileSync(indexPath, 'utf8'), appName);
      return res.type('html').send(renamedIndex);
    } catch { /* fall through to sendFile */ }
  }
  res.sendFile(indexPath);
});

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`[handmux] listening on http://${cfg.host}:${cfg.port} (serving ${staticDir})`);
});
// WebSocket/HMR for dynamic previews: route raw Upgrade by Host to the right loopback port.
server.on('upgrade', preview.onUpgrade);
