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

// Re-exported for tests (test/keys.test.js) and any caller that imported it by this path historically.
export { isAllowedKey } from './routes/terminal.js';

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

  const deps = {
    token, commands, docs, git, push, notifications, claudeEvents,
    uploadExts, maxUploadBytes, asrEnv, previews, previewDomain, home, stateFile,
  };

  r.use(sessionRoutes(deps));
  r.use(terminalRoutes(deps));
  r.use(gitRoutes(deps));
  r.use(fileRoutes(deps));
  r.use(pushRoutes(deps));
  r.use(notificationRoutes(deps));
  r.use(systemRoutes(deps));
  r.use(previewRoutes(deps));

  return r;
}
