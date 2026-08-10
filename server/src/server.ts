import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { expressAuth, loadToken } from './auth.js';
import { createApiRouter } from './httpApi.js';
import { loadUploadExts } from './uploadTypes.js';
import { createClaudeEvents } from './claudeEvents.js';
import { syncHooks } from './cli/claudeHooks.js';
import { removeLegacyCodexHooks } from './cli/legacyCodexHooks.js';
import { claudeStatePath, codexOutboxPath } from './cli/state.js';
import * as commands from './tmux/commands.js';
import * as push from './push.js';
import { cacheControlFor } from './staticCache.js';
import { compressStaticAssets } from './staticCompression.js';
import { applyAppName, applyManifestName } from './appName.js';
import { homedir } from 'node:os';
import { createPreviews } from './previews.js';
import { createPreview } from './previewServer.js';
import { createWorkspaceStore } from './workspace/store.js';
import { createWorkspaceTmux } from './workspace/tmuxAdapter.js';
import { createEnvironmentProvider } from './workspace/environment.js';
import { createWorkspaceLock } from './workspace/lock.js';
import { createGracefulShutdown, createWorkspaceBackground } from './workspace/checkpointer.js';
import { createWorkspaceRuntime } from './workspace/runtime.js';
import { createBrowserWorkerClient } from './browser/workerClient.js';
import { createTerminalStream } from './terminalStream.js';
import { createCodexAppServer } from './codexAppServer.js';
import { apiErrorBoundary, apiRequestContext } from './apiErrors.js';
import { PrivateStateStore } from './privateStateStore.js';
import { RuntimeHealth } from './healthProtocol.js';
import { healthRoutes } from './routes/health.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// There is ONE config source — ~/.handmux/config.json — and ONE way to run handmux: `handmux start`
// (the CLI; `node bin/handmux.js start` from a source checkout is the same thing). The CLI resolves
// the config and spawns this server with everything it needs in the environment, so the server reads
// only process.env here (no .env files, no NODE_ENV branching). Running this file directly is not a
// supported entry point — go through the CLI.
const cfg = loadConfig();
const token = loadToken();
const uploadExts = loadUploadExts();
const home = homedir();
const previewDomain = process.env.HANDMUX_PREVIEW_DOMAIN || null;
const health = new RuntimeHealth({ browserRequired: Boolean(previewDomain) });

// One writer set is shared by background capture today and the restore runtime added on top of it. The
// lock is filesystem-backed because the CLI may restore while this daemon is alive in another process.
const workspaceStore = createWorkspaceStore({ home });
const workspaceTmux = createWorkspaceTmux({ run: commands.runTmux });
const workspaceLock = createWorkspaceLock({ dir: workspaceStore.paths.lockDir });
const observeEnvironment = createEnvironmentProvider({
  tmuxServerIdProvider: async () => {
    const observed = await workspaceTmux.observeEnvironment();
    if (observed.status === 'unknown') throw new Error('tmux environment unavailable');
    return observed.tmuxServerId;
  },
});
const stateFile = process.env.CLAUDE_STATE_FILE || claudeStatePath(home);
let codexApp: ReturnType<typeof createCodexAppServer> | null = null;
const workspaceBackground = createWorkspaceBackground({
  store: workspaceStore,
  tmux: workspaceTmux,
  observeEnvironment,
  lock: workspaceLock,
  stateFile,
  getCodexApp: () => codexApp,
});
const workspace = createWorkspaceRuntime({
  store: workspaceStore,
  tmux: workspaceTmux,
  lock: workspaceLock,
  checkpointer: workspaceBackground,
  home,
});

// Claude states come from Hooks; Codex states come only from App Server. Both feed the same inbox and
// workspace checkpointer, but no Codex Hook state is accepted as a fallback.
let events: ReturnType<typeof createClaudeEvents> | null = null;
codexApp = createCodexAppServer({
  home,
  outboxStore: new PrivateStateStore(codexOutboxPath(home)),
  onStateChange: () => {
    if (!events) return;
    events.getStates().then(() => workspace.requestReconcile()).catch(() => {});
  },
});
events = createClaudeEvents({ commands, push, codexApp, file: stateFile, onStateChange: workspace.requestReconcile });
events.start();
try {
  codexApp.start();
  health.set('codex', 'ready');
} catch {
  health.set('codex', 'degraded', 'codex-start-failed');
}
workspace.start().catch(() => {});

// Keep an already-opted-in user's Claude hooks in step with this handmux version on restart: newly-added
// lifecycle events (e.g. SessionStart, which rebinds the 对话 lens after /clear) and a refreshed
// handmux-write.cjs land via `./deploy.sh` alone — no phone re-enable. A strict no-op unless our hooks are
// already installed; best-effort and must never block or crash startup (pure fs, no subprocess).
try {
  syncHooks(home, {
    srcDir: path.resolve(here, '../hooks'),
    stateFile,
  });
} catch { /* best effort — hook sync never fails startup */ }
// Versions before App Server support installed a marked Handmux block under ~/.codex. Remove only that
// exact legacy block and Handmux-owned files; all user Codex configuration and third-party hooks remain.
try { removeLegacyCodexHooks(home); } catch { /* best effort — migration never fails startup */ }

// Static directory preview remains for folders without a web server. Arbitrary sites and local ports
// use the built-in browser below; previewDomain may provide its dedicated public origin.
const previews = createPreviews({ home });
const preview = createPreview({ previews });
const handmuxOrigin = (() => {
  try {
    return new URL(process.env.HANDMUX_PUBLIC_URL || `http://127.0.0.1:${cfg.port}`).origin;
  } catch {
    return `http://127.0.0.1:${cfg.port}`;
  }
})();
const browserWorker = createBrowserWorkerClient({ appToken: token, previewDomain, handmuxOrigin });
const app = express();
app.use(healthRoutes({
  health,
  refresh: async () => {
    const browser = browserWorker.health();
    health.set('browser', browser.status, browser.detail);
    const workspaceStatus = workspace.health();
    health.set('workspace', workspaceStatus.status, workspaceStatus.detail);
  },
}));
// Browser proxy leases stay behind normal Handmux auth. Client-owned direct tabs never enter
// server state; proxy operations and all claimed Hammerhead paths use the isolated worker.
app.use(browserWorker.publicHandler);
app.use('/api/browser-proxy', apiRequestContext(), expressAuth(token), express.json(), browserWorker.apiHandler);
app.use('/api', createApiRouter({
  token, events, uploadExts, previews, shortcuts: cfg.shortcuts, workspace, previewDomain, codexApp,
}));
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
let renamedIndex: string | null = null; // computed once; the name is fixed for the process lifetime
if (appName) {
  app.get('/manifest.webmanifest', (req, res, next) => {
    try {
      const raw = fs.readFileSync(path.join(staticDir, 'manifest.webmanifest'), 'utf8');
      res.type('application/manifest+json').send(JSON.stringify(applyManifestName(JSON.parse(raw), appName)));
    } catch { next(); }
  });
}

// index:false so the renamed shell below owns "/" too (otherwise static would serve the generic one).
app.use(compressStaticAssets);
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
app.use(apiErrorBoundary());

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`[handmux] listening on http://${cfg.host}:${cfg.port} (serving ${staticDir})`);
});
const terminalStream = createTerminalStream({ token, commands });
server.on('upgrade', (req, socket, head) => {
  if (terminalStream.onUpgrade(req, socket, head)) return;
  if (!browserWorker.onUpgrade(req, socket, head)) socket.destroy();
});

const shutdown = createGracefulShutdown({ events, workspace, browser: browserWorker, server });
const handleSignal = () => {
  terminalStream.close();
  codexApp.close();
  shutdown().catch(() => {});
};
process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);
