// API composition root. Applies auth + JSON parsing, then mounts the per-domain route modules under
// /api. Each module (routes/*.js) owns one domain and receives only the deps it needs; the closure deps
// (commands, docs, git, previews, token, home, …) pass straight through. Behaviour is unchanged from when
// every route lived here — this file is just the wiring.
import express from 'express';
import { expressAuth } from './auth.js';
import * as defaultCommands from './tmux/commands.js';
import { defaultDocs, MAX_TRANSFER_BYTES } from './docs.js';
import { defaultGit } from './git.js';
import * as push from './push.js';
import * as notifications from './notifications.js';
import { createClaudeEvents } from './claudeEvents.js';
import { homedir } from 'node:os';
import { DEFAULT_UPLOAD_EXTS } from './uploadTypes.js';
import { claudeStatePath } from './cli/state.js';
import { sessionRoutes } from './routes/sessions.js';
import { terminalRoutes } from './routes/terminal.js';
import { gitRoutes } from './routes/git.js';
import { fileRoutes } from './routes/files.js';
import { pushRoutes } from './routes/push.js';
import { systemRoutes } from './routes/system.js';
import { previewRoutes } from './routes/previews.js';
import { notificationRoutes } from './routes/notifications.js';
import { transcriptRoutes } from './routes/transcript.js';
import { DEFAULT_SHORTCUTS } from './shortcutConfig.js';
import { workspaceRoutes } from './routes/workspace.js';
import { browserRoutes } from './browser/routes.js';
import { codexRoutes } from './routes/codex.js';
import { apiErrorBoundary, apiNotFound, apiRequestContext } from './apiErrors.js';
import type { Router } from 'express';
import type { ApiErrorOptions } from './apiErrors.js';

type NativeClaudeEvents = ReturnType<typeof createClaudeEvents>;
type RoutedClaudeEvents = NativeClaudeEvents
  & NonNullable<Parameters<typeof sessionRoutes>[0]['claudeEvents']>
  & Parameters<typeof systemRoutes>[0]['claudeEvents']
  & NonNullable<Parameters<typeof transcriptRoutes>[0]['claudeEvents']>;
type PreviewService = Parameters<typeof previewRoutes>[0]['previews'];
type BrowserOptions = Parameters<typeof browserRoutes>[0];
type WorkspaceService = Parameters<typeof workspaceRoutes>[0]['workspace']
  & NonNullable<Parameters<typeof sessionRoutes>[0]['workspace']>;
type CodexApp = Parameters<typeof codexRoutes>[0]['codexApp'];

export interface CreateApiRouterOptions {
  token: string;
  commands?: typeof defaultCommands;
  docs?: typeof defaultDocs;
  git?: typeof defaultGit;
  events?: NativeClaudeEvents | RoutedClaudeEvents | null;
  uploadExts?: ReadonlySet<string>;
  maxUploadBytes?: number;
  asrEnv?: NodeJS.ProcessEnv;
  previews?: PreviewService;
  shortcuts?: unknown;
  browser?: BrowserOptions['browser'];
  browserBootstrap?: BrowserOptions['browserBootstrap'];
  previewDomain?: string | null;
  workspace?: WorkspaceService | null;
  codexApp?: CodexApp;
  apiErrors?: ApiErrorOptions;
  home?: string;
  stateFile?: string;
}

// Re-exported for tests (test/keys.test.js) and any caller that imported it by this path historically.
export { isAllowedKey } from './routes/terminal.js';

export function createApiRouter({
  token, commands = defaultCommands, docs = defaultDocs, git = defaultGit, events,
  uploadExts = DEFAULT_UPLOAD_EXTS, maxUploadBytes = MAX_TRANSFER_BYTES,
  asrEnv = process.env, previews,
  shortcuts = DEFAULT_SHORTCUTS,
  browser,
  browserBootstrap,
  previewDomain,
  workspace,
  codexApp,
  apiErrors,
  home = homedir(), stateFile = process.env.CLAUDE_STATE_FILE || claudeStatePath(homedir()),
}: CreateApiRouterOptions): Router {
  const r = express.Router();
  r.use(apiRequestContext(apiErrors));
  r.use(expressAuth(token));
  r.use(express.json());
  const eventOptions: Parameters<typeof createClaudeEvents>[0] & {
    commands: typeof defaultCommands;
    push: typeof push;
  } = { commands, push };
  const claudeEvents: RoutedClaudeEvents = events || createClaudeEvents(eventOptions);

  const deps = {
    token, commands, docs, git, push, notifications, claudeEvents,
    uploadExts, maxUploadBytes, asrEnv, previews, shortcuts, home, stateFile, workspace, browser, browserBootstrap, previewDomain, codexApp,
  };

  r.use(sessionRoutes(deps));
  r.use(terminalRoutes(deps));
  r.use(gitRoutes(deps));
  r.use(fileRoutes(deps));
  r.use(pushRoutes(deps));
  r.use(notificationRoutes(deps));
  r.use(systemRoutes(deps));
  r.use(previewRoutes(deps));
  // In the main process browser APIs are forwarded to the isolated worker before this router. Keep
  // preview-domain wiring out of this unused fallback route so capability reporting does not require
  // the worker-owned bootstrap ticket store.
  r.use('/browser-proxy', browserRoutes(browser ? deps : { ...deps, previewDomain: null }));
  r.use(transcriptRoutes(deps));
  r.use(codexRoutes(deps));
  if (workspace) r.use(workspaceRoutes({ workspace }));
  r.use(apiNotFound(apiErrors));
  r.use(apiErrorBoundary(apiErrors));

  return r;
}
