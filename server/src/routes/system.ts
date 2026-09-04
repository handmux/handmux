// Capabilities / agents / inbox routes: what optional integrations are configured (/config), the update
// hint (/version), one-tap hook install, the ASR signed-URL handoff, the inbox roster (/states), agent
// usage (/usage), and orphan-session scan + takeover. Mounted under /api by createApiRouter.
import express from 'express';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { isSessionId } from '../tmux/commands.js';
import { buildIatSignedUrl } from '../asr/iflySign.js';
import { asrConfig } from '../asr/config.js';
import { buildTencentAsrSignedUrl } from '../asr/tencentSign.js';
import {
  recognizeTencentSentence,
  TencentSentenceError,
} from '../asr/tencentSentence.js';
import { hooksStatus, installHooks } from '../cli/claudeHooks.js';
import {
  agentIntegrationStatus,
  defaultAgentIntegrationContext,
  enableAgentIntegration,
} from '../cli/agentIntegration.js';
import { scanOrphans, takeoverOrphan, defaultProjectsDir } from '../orphans.js';
import { readCache, isNewer, shouldRefresh, refreshLatestAsync } from '../cli/updateCheck.js';
import { normalizeShortcuts } from '../shortcutConfig.js';
import { projectLegacyInboxStates } from '../agent-runtime/legacyInboxProjection.js';
import type { AgentRuntime } from '../agent-runtime/runtime.js';
import type { LivePane } from '../agent-runtime/adapter.js';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import type { ShortcutConfig } from '../shortcutConfig.js';
import type { AgentIntegrationContext, AgentName } from '../cli/agentIntegration.js';

type TakeoverCommands = Parameters<typeof takeoverOrphan>[0]['commands'];
interface LivePaneCommands {
  listLivePanes?(): Promise<Array<{
    id: string; cmd: string; tty: string; session: string; window: string; windowName: string;
  }>>;
}
interface ClaudeEvents {
  getStates(allowedSessions: string[] | null): Promise<unknown>;
}
interface SystemRouteOptions {
  commands: TakeoverCommands & LivePaneCommands;
  claudeEvents: ClaudeEvents;
  agentRuntime?: Pick<AgentRuntime, 'activeRuns' | 'inbox' | 'deprecatedSubscriptionUsage'> | null;
  asrEnv: NodeJS.ProcessEnv;
  shortcuts: unknown;
  home: string;
  stateFile: string;
  previewDomain?: string | null;
  agentIntegrationContext?: AgentIntegrationContext;
  sentenceRecognizer?: typeof recognizeTencentSentence;
}

export const MAX_SENTENCE_PCM_BYTES = 2 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const here = dirname(fileURLToPath(import.meta.url));
const HOOKS_SRC = resolvePath(here, '../../hooks'); // server/hooks (bundled scripts)
const PI_ENTRY = resolvePath(here, '../../connectors/pi/index.js');
const WEB_AGENT_INTEGRATIONS = ['claude', 'pi'] as const satisfies readonly AgentName[];

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
  commands, claudeEvents, agentRuntime, asrEnv, shortcuts, home, stateFile, previewDomain,
  agentIntegrationContext, sentenceRecognizer = recognizeTencentSentence,
}: SystemRouteOptions): Router {
  const r = express.Router();
  let activeShortcuts: ShortcutConfig = normalizeShortcuts(shortcuts);
  const integrationContext = agentIntegrationContext ?? defaultAgentIntegrationContext({
    home,
    piEntryFile: PI_ENTRY,
    hooksSrcDir: HOOKS_SRC,
    claudeStateFile: stateFile,
  });

  // --- Capabilities probe ---------------------------------------------------------------------
  // Optional integrations are configured per-install (open-source installs ship without keys), so the
  // client asks what's actually available and hides controls that can't work — e.g. the mic when no
  // ASR engine is configured. Add more flags here as optional integrations land.
  // `claudeHooks` is intentionally Claude-only. Codex is always App Server-backed and never affects
  // this setup prompt or endpoint.
  r.get('/config', (_req: Request, res: Response) => {
    const voice = asrConfig(asrEnv);
    return res.json({
      asr: voice !== null,
      asrProvider: voice?.provider ?? null,
      asrMode: voice?.mode ?? null,
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

  // User-facing Agent integration management. The shared CLI service owns all provider-specific status,
  // ownership, repair, and install behavior; Web only exposes Claude Code and Pi as product concepts.
  r.get('/agent-integrations', (_req: Request, res: Response, next: NextFunction) => {
    try {
      return res.json({
        integrations: WEB_AGENT_INTEGRATIONS.map((name) => {
          const status = agentIntegrationStatus(name, integrationContext);
          return {
            name,
            status,
            ...(name === 'claude' && status === 'not-enabled'
              && hooksStatus(integrationContext.home) === 'no-claude'
              ? { reason: 'initialize-first' as const } : {}),
          };
        }),
      });
    } catch (error) { return next(error); }
  });

  r.post('/agent-integrations/:name/enable', (req: Request, res: Response, next: NextFunction) => {
    const name = WEB_AGENT_INTEGRATIONS.find((candidate) => candidate === req.params.name);
    if (!name) return res.status(404).json({ error: 'agent integration not found' });
    try { return res.json(enableAgentIntegration(name, integrationContext)); }
    catch (error) { return next(error); }
  });

  // --- Voice input: provider-neutral, short-lived session handoff -----------------------------
  r.get('/asr/session', (_req: Request, res: Response) => {
    const config = asrConfig(asrEnv);
    if (!config) return res.status(503).json({ error: 'asr not configured' });
    if (config.mode !== 'streaming') {
      return res.status(503).json({ error: 'streaming asr is not selected' });
    }
    if (config.provider === 'tencent') {
      return res.json({
        provider: 'tencent',
        protocol: 'tencent-asr-v2',
        ...buildTencentAsrSignedUrl(config),
      });
    }
    return res.json({
      provider: 'xfyun',
      protocol: 'xfyun-iat-v2',
      ...buildIatSignedUrl({ ...config, date: new Date().toUTCString() }),
    });
  });

  const rawSentenceAudio = express.raw({
    type: 'application/octet-stream', limit: MAX_SENTENCE_PCM_BYTES,
  });
  const parseSentenceAudio: RequestHandler = (req, res, next) => {
    if (!req.is('application/octet-stream')) {
      res.status(415).json({
        error: 'audio must use application/octet-stream',
        code: 'unsupported_audio_type', requestId: res.locals.requestId,
      });
      return;
    }
    rawSentenceAudio(req, res, (error?: unknown) => {
      const bodyError = error && typeof error === 'object'
        ? error as { status?: unknown; type?: unknown } : null;
      if (bodyError?.status === 413 || bodyError?.type === 'entity.too.large') {
        res.status(413).json({
          error: `audio exceeds ${MAX_SENTENCE_PCM_BYTES} bytes`,
          code: 'audio_too_large', requestId: res.locals.requestId,
        });
        return;
      }
      next(error);
    });
  };

  r.post('/asr/sentence', parseSentenceAudio, async (req: Request, res: Response, next: NextFunction) => {
    const config = asrConfig(asrEnv);
    if (!config || config.provider !== 'tencent' || config.mode !== 'sentence') {
      return res.status(503).json({
        error: 'Tencent sentence ASR is not selected',
        code: 'sentence_asr_not_selected', requestId: res.locals.requestId,
      });
    }
    const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (audio.byteLength === 0) return res.status(400).json({
      error: 'audio is empty', code: 'audio_empty', requestId: res.locals.requestId,
    });
    try {
      const result = await sentenceRecognizer(config, audio);
      return res.json({ text: result.text });
    } catch (error) {
      if (error instanceof TencentSentenceError) {
        return res.status(502).json({
          error: error.message,
          code: error.code,
          requestId: res.locals.requestId,
          ...(error.requestId ? { providerRequestId: error.requestId } : {}),
        });
      }
      return next(error);
    }
  });

  // Historical endpoint retained for already-loaded Web clients. It can only describe XFYUN's protocol.
  r.get('/asr/sign', (_req: Request, res: Response) => {
    const config = asrConfig(asrEnv);
    if (!config || config.provider !== 'xfyun') return res.status(503).json({ error: 'xfyun asr not configured' });
    const { appId, apiKey, apiSecret } = config;
    return res.json(buildIatSignedUrl({ appId, apiKey, apiSecret, date: new Date().toUTCString() }));
  });

  // ?sessions=a,b scopes the roster to the session NAMES this device subscribed to (per-device inbox
  // isolation). Omitted → null → all (back-compat); present-but-empty → [] → nothing.
  r.get('/states', async (req: Request, res: Response, next: NextFunction) => {
    const q = req.query.sessions;
    const allowed = q === undefined ? null : String(q).split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const snapshot = agentRuntime?.inbox.read();
      const runs = agentRuntime?.activeRuns() ?? [];
      // revision is scoped to this serviceEpoch. Persisted availability from an older Server process is
      // diagnostic state, not proof that this Runtime has completed its first provider baseline.
      const coreReady = snapshot !== undefined && snapshot.revision > 0;
      if (coreReady) {
        let panes: LivePane[] = [];
        try {
          panes = commands.listLivePanes ? (await commands.listLivePanes()).map((pane) => ({
            paneId: pane.id,
            sessionName: pane.session,
            windowId: pane.window,
            windowName: pane.windowName,
            currentCommand: pane.cmd,
            ...(pane.tty ? { tty: pane.tty } : {}),
          })) : [];
        } catch { /* Core state remains authoritative; location degrades to unknown. */ }
        return res.json(projectLegacyInboxStates({ snapshot, runs, panes, allowedSessions: allowed }));
      }
      return res.json(await claudeEvents.getStates(allowed));
    } catch (e) { return next(e); }
  });

  // Historical provider-shaped response. It is a pure projection of the same Runtime/Core snapshot used
  // by /agents/usage and never performs another provider read.
  r.get('/usage', async (_req: Request, res: Response, next: NextFunction) => {
    if (!agentRuntime?.deprecatedSubscriptionUsage) {
      return res.status(503).json({ error: 'subscription usage unsupported', code: 'unsupported' });
    }
    try {
      return res.json(await agentRuntime.deprecatedSubscriptionUsage.snapshot());
    } catch (e) { return next(e); }
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
