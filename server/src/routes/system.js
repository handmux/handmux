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
import { codexHooksStatus, installCodexHooks } from '../cli/codexHooks.js';
import { scanOrphans, takeoverOrphan, defaultProjectsDir } from '../orphans.js';
import { getUsageCached } from '../usage.js';
import { readCache, isNewer, shouldRefresh, refreshLatestAsync } from '../cli/updateCheck.js';
import { normalizeShortcuts } from '../shortcutConfig.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOOKS_SRC = resolvePath(here, '../../hooks'); // server/hooks (bundled scripts)

// The installed CLI version (server/package.json) — read once. The phone compares this against the cached
// npm "latest" to surface an update hint ("run `handmux update` on your computer"); see the /version route.
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(resolvePath(here, '../../package.json'), 'utf8')).version || null; }
  catch { return null; }
})();

// Summarize hook state across every installed coding agent. A partial install is still 'absent' so the
// phone offers the one-tap action that completes the missing agent; otherwise a Claude-only hook install
// could make Codex chat look enabled while providing no approval/status events.
export function combineHookStatuses(claude, codex) {
  const present = [claude, codex].filter((status) => status !== 'no-claude' && status !== 'no-codex');
  if (!present.length) return 'no-claude'; // back-compatible public token: no supported agent installed
  return present.every((status) => status === 'installed') ? 'installed' : 'absent';
}

export function combinedHooksStatus(home) {
  const c = hooksStatus(home);      // 'no-claude' | 'installed' | 'absent'
  const x = codexHooksStatus(home); // 'no-codex' | 'installed' | 'absent'
  return combineHookStatuses(c, x);
}

export function systemRoutes({ commands, claudeEvents, asrEnv, shortcuts, home, stateFile, previewDomain }) {
  const r = express.Router();
  let activeShortcuts = normalizeShortcuts(shortcuts);

  // --- Capabilities probe ---------------------------------------------------------------------
  // Optional integrations are configured per-install (open-source installs ship without keys), so the
  // client asks what's actually available and hides controls that can't work — e.g. the mic when no
  // ASR engine is configured. Add more flags here as optional integrations land.
  // `claudeHooks` (name kept for web back-compat) summarizes EVERY coding agent: installed only when all
  // present agents are wired, absent when any needs setup, and no-claude when no supported agent exists.
  r.get('/config', (req, res) => {
    res.json({
      asr: isAsrConfigured(asrEnv),
      claudeHooks: combinedHooksStatus(home),
      shortcuts: activeShortcuts,
      browserProxy: !!previewDomain,
    });
  });

  r.put('/config/shortcuts', (req, res) => {
    if (!req.body || !Object.hasOwn(req.body, 'shortcuts')) {
      return res.status(400).json({ error: 'shortcuts required' });
    }
    try { activeShortcuts = normalizeShortcuts(req.body.shortcuts); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    res.json({ ok: true });
  });

  // Update hint for the phone: is the globally-installed CLI behind the latest npm release? `current` is
  // this server's version; `latest` comes from the same cache the CLI maintains (~/.handmux/update-check.json).
  // We never block on the network here — if the cache is stale we kick a best-effort async refresh (throttled
  // to once an hour, like the CLI) and return the currently-known value. The upgrade itself is a computer-side
  // `handmux update`; the phone only shows the notice.
  r.get('/version', (req, res) => {
    const cache = readCache(home);
    if (shouldRefresh(cache)) refreshLatestAsync(home);
    const latest = cache?.latest ?? null;
    const updateAvailable = !!(latest && PKG_VERSION && isNewer(latest, PKG_VERSION));
    // `whatsNew` is the concise per-version highlights the newer package carries (via npm). Trim to the
    // versions the user would actually GAIN by upgrading (strictly newer than what's installed here).
    const whatsNew = (updateAvailable && Array.isArray(cache?.whatsNew))
      ? cache.whatsNew.filter((e) => e && e.version && isNewer(e.version, PKG_VERSION))
      : [];
    res.json({ current: PKG_VERSION, latest, updateAvailable, whatsNew });
  });

  // One-tap enable from the phone: install the hooks for every present agent (Claude Code, Codex) on the
  // host (token-gated, like every API here). Opt-in — the inbox only offers this when status is 'absent'.
  // Never creates ~/.claude or ~/.codex; a user's own Codex `notify` is left untouched (see codexHooks.js).
  r.post('/hooks/install', (req, res) => {
    try {
      let installed = 0;
      if (hooksStatus(home) !== 'no-claude') { installHooks(home, { srcDir: HOOKS_SRC, stateFile }); installed++; }
      if (codexHooksStatus(home) !== 'no-codex') { installCodexHooks(home, { srcDir: HOOKS_SRC, stateFile }); installed++; }
      res.json({ ok: installed > 0, status: combinedHooksStatus(home) });
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

  // ?sessions=a,b scopes the roster to the session NAMES this device subscribed to (per-device inbox
  // isolation). Omitted → null → all (back-compat); present-but-empty → [] → nothing.
  r.get('/states', async (req, res, next) => {
    const q = req.query.sessions;
    const allowed = q === undefined ? null : String(q).split(',').map((s) => s.trim()).filter(Boolean);
    try { res.json(await claudeEvents.getStates(allowed)); } catch (e) { next(e); }
  });

  // Agent usage/quota for the Usage page. Claude reads its statusLine snapshot; Codex asks its own local
  // app-server for account limits and merges rollout token/context data. Cached briefly; never handles auth.
  r.get('/usage', async (req, res, next) => {
    try { res.json(await getUsageCached(home)); } catch (e) { next(e); }
  });

  // Orphan Claude sessions: `claude` processes running on this host but NOT inside a tmux pane, so
  // handmux can't steer them. Surfaced at the bottom of the Inbox with a "takeover" (spawn
  // `claude --resume` in tmux). Best-effort process scan (see orphans.js); never throws.
  r.get('/orphans', async (req, res, next) => {
    try { res.json(await scanOrphans({ projectsDir: defaultProjectsDir(home) })); } catch (e) { next(e); }
  });

  // Take over an orphan: spawn `claude --resume <sessionId>` in tmux and (default) SIGTERM the original.
  // pid/sessionId are re-verified against a fresh scan server-side; sessionId must be a UUID (it's typed
  // into a shell). target.mode 'new' (fresh session) or 'window' (into an existing session id).
  r.post('/orphans/takeover', async (req, res, next) => {
    const { pid, sessionId, kill, target } = req.body || {};
    const t = target && target.mode === 'window' && isSessionId(target.session)
      ? { mode: 'window', session: target.session } : { mode: 'new' };
    try {
      const out = await takeoverOrphan(
        { commands, scanOpts: { projectsDir: defaultProjectsDir(home) } },
        { pid, sessionId, target: t, kill: kill !== false },
      );
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json(out);
    } catch (e) { next(e); }
  });

  return r;
}
