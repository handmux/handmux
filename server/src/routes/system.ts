// Capabilities / agents / inbox routes: what optional integrations are configured (/config), the update
// hint (/version), one-tap hook install, the ASR signed-URL handoff, the inbox roster (/states), agent
// usage (/usage), and orphan-session scan + takeover. Mounted under /api by createApiRouter.
import express from 'express';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { isSessionId } from '../tmux/commands.js';
import { buildIatSignedUrl } from '../asr/iflySign.js';
import { asrConfig, isAsrConfigured } from '../asr/iflyConfig.js';
import { hooksStatus, installHooks } from '../cli/claudeHooks.js';
import { scanOrphans, takeoverOrphan, defaultProjectsDir } from '../orphans.js';
import { getUsageCached } from '../usage.js';
import { readCache, isNewer, shouldRefresh, refreshLatestAsync } from '../cli/updateCheck.js';
import { normalizeShortcuts } from '../shortcutConfig.js';
import type { NextFunction, Request, Response, Router } from 'express';
import type { ShortcutConfig } from '../shortcutConfig.js';

type TakeoverCommands = Parameters<typeof takeoverOrphan>[0]['commands'];
interface ClaudeEvents {
  getStates(allowedSessions: string[] | null): Promise<unknown>;
}
interface SystemRouteOptions {
  commands: TakeoverCommands;
  claudeEvents: ClaudeEvents;
  asrEnv: NodeJS.ProcessEnv;
  shortcuts: unknown;
  home: string;
  stateFile: string;
  previewDomain?: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const here = dirname(fileURLToPath(import.meta.url));
const HOOKS_SRC = resolvePath(here, '../../hooks'); // server/hooks (bundled scripts)

// The installed CLI version (server/package.json) — read once. The phone compares this against the cached
// npm "latest" to surface an update hint ("run `handmux update` on your computer"); see the /version route.
const PKG_VERSION = (() => {
  try {
    const value: unknown = JSON.parse(readFileSync(resolvePath(here, '../../package.json'), 'utf8'));
    return isRecord(value) && typeof value.version === 'string' ? value.version : null;
  }
  catch { return null; }
})();

export function systemRoutes({
  commands, claudeEvents, asrEnv, shortcuts, home, stateFile, previewDomain,
}: SystemRouteOptions): Router {
  const r = express.Router();
  let activeShortcuts: ShortcutConfig = normalizeShortcuts(shortcuts);

  // --- Capabilities probe ---------------------------------------------------------------------
  // Optional integrations are configured per-install (open-source installs ship without keys), so the
  // client asks what's actually available and hides controls that can't work — e.g. the mic when no
  // ASR engine is configured. Add more flags here as optional integrations land.
  // `claudeHooks` is intentionally Claude-only. Codex is always App Server-backed and never affects
  // this setup prompt or endpoint.
  r.get('/config', (_req: Request, res: Response) => {
    return res.json({
      asr: isAsrConfigured(asrEnv),
      claudeHooks: hooksStatus(home),
      managedCodex: true,
      shortcuts: activeShortcuts,
      browserProxy: !!previewDomain,
    });
  });

  r.put('/config/shortcuts', (req: Request, res: Response) => {
    const body: unknown = req.body;
    if (!isRecord(body) || !Object.hasOwn(body, 'shortcuts')) {
      return res.status(400).json({ error: 'shortcuts required' });
    }
    try { activeShortcuts = normalizeShortcuts(body.shortcuts); }
    catch (error) { return res.status(400).json({ error: errorMessage(error) }); }
    return res.json({ ok: true });
  });

  // Update hint for the phone: is the globally-installed CLI behind the latest npm release? `current` is
  // this server's version; `latest` comes from the same cache the CLI maintains (~/.handmux/update-check.json).
  // We never block on the network here — if the cache is stale we kick a best-effort async refresh (throttled
  // to once an hour, like the CLI) and return the currently-known value. The upgrade itself is a computer-side
  // `handmux update`; the phone only shows the notice.
  r.get('/version', (_req: Request, res: Response) => {
    const cache = readCache(home);
    if (shouldRefresh(cache)) refreshLatestAsync(home);
    const latest = cache?.latest ?? null;
    const updateAvailable = !!(latest && PKG_VERSION && isNewer(latest, PKG_VERSION));
    // `whatsNew` is the concise per-version highlights the newer package carries (via npm). Trim to the
    // versions the user would actually GAIN by upgrading (strictly newer than what's installed here).
    const whatsNew = (updateAvailable && Array.isArray(cache?.whatsNew))
      ? cache.whatsNew.filter((e) => e && e.version && isNewer(e.version, PKG_VERSION))
      : [];
    return res.json({ current: PKG_VERSION, latest, updateAvailable, whatsNew });
  });

  // One-tap enable from the phone installs Claude Code hooks only. Codex uses App Server and must never
  // write to ~/.codex as part of this endpoint.
  r.post('/hooks/install', (_req: Request, res: Response) => {
    try {
      if (hooksStatus(home) === 'no-claude') return res.json({ ok: false, status: 'no-claude' });
      installHooks(home, { srcDir: HOOKS_SRC, stateFile });
      return res.json({ ok: true, status: hooksStatus(home) });
    } catch (e) { return res.status(500).json({ ok: false, error: String(e) }); }
  });

  // --- Voice input: iFlytek IAT signed-URL handoff -------------------------------------------
  // The browser connects to iFlytek directly; we only mint a short-lived signed wss URL so the
  // apiSecret never reaches the phone. 503 if creds aren't configured (front-end hides the mic).
  r.get('/asr/sign', (_req: Request, res: Response) => {
    if (!isAsrConfigured(asrEnv)) return res.status(503).json({ error: 'asr not configured' });
    const { appId, apiKey, apiSecret } = asrConfig(asrEnv);
    return res.json(buildIatSignedUrl({ appId, apiKey, apiSecret, date: new Date().toUTCString() }));
  });

  // ?sessions=a,b scopes the roster to the session NAMES this device subscribed to (per-device inbox
  // isolation). Omitted → null → all (back-compat); present-but-empty → [] → nothing.
  r.get('/states', async (req: Request, res: Response, next: NextFunction) => {
    const q = req.query.sessions;
    const allowed = q === undefined ? null : String(q).split(',').map((s) => s.trim()).filter(Boolean);
    try { return res.json(await claudeEvents.getStates(allowed)); } catch (e) { return next(e); }
  });

  // Agent usage/quota for the Usage page. Claude reads its statusLine snapshot; Codex asks its own local
  // app-server for account limits and merges rollout token/context data. Cached briefly; never handles auth.
  r.get('/usage', async (_req: Request, res: Response, next: NextFunction) => {
    try { return res.json(await getUsageCached(home)); } catch (e) { return next(e); }
  });

  // Orphan Claude sessions: `claude` processes running on this host but NOT inside a tmux pane, so
  // handmux can't steer them. Surfaced at the bottom of the Inbox with a "takeover" (spawn
  // `claude --resume` in tmux). Best-effort process scan (see orphans.js); never throws.
  r.get('/orphans', async (_req: Request, res: Response, next: NextFunction) => {
    try { return res.json(await scanOrphans({ projectsDir: defaultProjectsDir(home) })); } catch (e) { return next(e); }
  });

  // Take over an orphan: spawn `claude --resume <sessionId>` in tmux and (default) SIGTERM the original.
  // pid/sessionId are re-verified against a fresh scan server-side; sessionId must be a UUID (it's typed
  // into a shell). target.mode 'new' (fresh session) or 'window' (into an existing session id).
  r.post('/orphans/takeover', async (req: Request, res: Response, next: NextFunction) => {
    const requestBody: unknown = req.body;
    const body = isRecord(requestBody) ? requestBody : {};
    const { pid, sessionId, kill } = body;
    const target = isRecord(body.target) ? body.target : null;
    const t = target?.mode === 'window' && isSessionId(target.session)
      ? { mode: 'window' as const, session: target.session } : { mode: 'new' as const };
    try {
      const out = await takeoverOrphan(
        { commands, scanOpts: { projectsDir: defaultProjectsDir(home) } },
        { pid, sessionId, target: t, kill: kill !== false },
      );
      if (out.error) return res.status(out.status ?? 500).json({ error: out.error });
      return res.json(out);
    } catch (e) { return next(e); }
  });

  return r;
}
