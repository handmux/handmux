// Read a pane's agent session as normalized chat messages. Claude reads its Hook-bound jsonl and keeps its
// established cwd fallback. Managed Codex reads only the pane-owned App Server thread.
// Server-side paginated — the phone must never receive the whole transcript:
//   - Recent window (default + polling): ?pane=&limit=10&since=<hash> — the last `limit` messages, with
//     the same content-hash `since`省流 as /history (unchanged window → 204). `hasMore`/`firstSeq` tell the
//     client whether/where an older page starts.
//   - History page (scroll-up, not polled): ?pane=&before=<k>&limit=10 — the last `limit` messages with
//     `k < before`, no hash.
// `k` = each message's global ordinal in the parsed transcript — stable because the jsonl is append-only,
// so it doubles as the client's dedup key. Only the requested page is copied and decorated with `k`; the
// full parsed transcript is never mapped/filtered on every poll. The underlying reader asynchronously scans once,
// then parses only appended complete lines; replacement/truncation resets it. `limit` clamps to [1,100],
// default 10. Mounted under /api.
import express from 'express';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isPaneId } from '../tmux/commands.js';
import { projectsDir } from '../agents/claude.js';
import { AGENTS } from '../agents/index.js';
import { resolveEncodedDirSession, encodeProjectDir } from '../agents/scanUtils.js';
import { transcriptReader } from '../transcriptReader.js';
import { parsePendingPrompt } from '../pendingPrompt.js';
import { readClaudeContext } from '../usage.js';
import { projectCodexThread } from '../codexAppServer.js';

// Pure index-based projection: O(page size), not O(transcript size). `before` stays exclusive, including
// for unusual fractional cursors (the old `k < before` filter included indices through ceil(before) - 1).
export function pageTranscript(parsed, before, limit) {
  const length = parsed.length;
  const rawEnd = before == null ? length : (Number.isNaN(before) ? 0 : Math.ceil(before));
  const end = Math.min(Math.max(rawEnd, 0), length);
  const start = Math.max(0, end - Math.max(0, Math.trunc(limit)));
  const messages = parsed.slice(start, end).map((message, offset) => ({ ...message, k: start + offset }));
  return {
    messages,
    firstSeq: messages.length ? start : null,
    hasMore: start > 0,
  };
}

export function transcriptRoutes({ commands, claudeEvents, reader = transcriptReader, codexApp }) {
  const r = express.Router();

  // Bind every request to the pane's actual agent before touching a session file. A caller cannot claim
  // Claude for a Codex pane (or vice versa) and make cwd fallback expose a different agent's conversation.
  r.use(['/pending-prompt', '/context', '/transcript'], (req, res, next) => {
    const pane = req.query.pane;
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    const requested = typeof req.query.agent === 'string' && req.query.agent ? req.query.agent : null;
    const hooked = claudeEvents?.paneSession ? claudeEvents.paneSession(pane) : null;
    const bound = (claudeEvents?.paneAgent ? claudeEvents.paneAgent(pane) : null) || hooked?.agent || null;
    if (requested && bound && requested !== bound) return res.status(409).json({ error: 'pane agent mismatch' });
    const id = bound || requested || 'claude';
    const agent = AGENTS.find((candidate) => candidate.id === id);
    if (!agent || (agent.id !== 'codex' && !agent.transcript?.createParser)) {
      return res.status(409).json({ error: 'chat lens unsupported for this agent' });
    }
    req.chatAgent = agent;
    req.chatSession = hooked;
    next();
  });

  // Claude's pending menus and context meter come from its TUI. Codex exposes both through App Server and
  // therefore never calls these terminal-specific endpoints.
  r.use(['/pending-prompt', '/context'], (req, res, next) => {
    if (req.chatAgent.id !== 'claude') return res.status(409).json({ error: 'interactive chat controls unsupported for this agent' });
    next();
  });

  // The pending interactive PROMPT on the pane's screen — an AskUserQuestion menu or a tool-permission
  // menu — scraped from `capture-pane` (its options are NOT in the .jsonl while pending; see pendingPrompt.js).
  // Returns { prompt: {kind,title,options,cursor} | null }. Polled by the 对话 lens only while a gate is up.
  r.get('/pending-prompt', async (req, res, next) => {
    try {
      const text = await commands.capturePlain(req.query.pane);
      return res.json({ prompt: parsePendingPrompt(text) });
    } catch (e) { next(e); }
  });

  // The pane's CURRENT context-window occupancy (model + used %) — the number Claude Code shows before
  // auto-compact. Joined pane→session (hook state) → the statusLine capturer's per-session snapshot. Returns
  // { model, usedPercent } (either may be null: capturer not opted in / session hasn't rendered / no hooks).
  // The 对话 composer polls this to show a small "模型 · 24%" chip. Best-effort: never 500 on a missing file.
  r.get('/context', (req, res, next) => {
    try {
      const hooked = req.chatSession;
      const sid = hooked && (hooked.sessionId || (hooked.transcriptPath ? path.basename(hooked.transcriptPath).replace(/\.jsonl$/, '') : null));
      const ctx = sid ? readClaudeContext(sid) : null;
      return res.json({ model: (ctx && ctx.model) || null, usedPercent: (ctx && typeof ctx.usedPercent === 'number') ? ctx.usedPercent : null });
    } catch (e) { next(e); }
  });

  r.get('/transcript', async (req, res, next) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
    const before = req.query.before != null && req.query.before !== '' ? Number(req.query.before) : null;
    try {
      if (req.chatAgent.id === 'codex') {
        const empty = { messages: [], hash: '', session: null, hasMore: false, firstSeq: null };
        try {
          const discovered = await codexApp?.discover?.(req.query.pane);
          if (!discovered?.managed) return res.json({ ...empty, unavailable: 'session-unmanaged' });
          const sessionId = discovered?.threadId || null;
          if (!sessionId) return res.json({ ...empty, unavailable: 'session-unbound' });
          let opened = null;
          try { opened = codexApp ? await codexApp.read(req.query.pane, sessionId) : null; }
          catch (error) {
            return res.json({ ...empty, unavailable: 'app-server-unavailable', detail: error?.message || String(error) });
          }
          if (!opened) return res.json({ ...empty, unavailable: 'session-unmanaged' });
          const parsed = projectCodexThread(opened.thread);
          const { messages, firstSeq, hasMore } = pageTranscript(parsed, before, limit);
          if (before == null) {
            const hash = createHash('sha1').update(JSON.stringify(messages)).digest('hex').slice(0, 16);
            if (req.query.since === hash) return res.status(204).end();
            return res.json({ messages, hash, session: sessionId, hasMore, firstSeq });
          }
          return res.json({ messages, session: sessionId, hasMore, firstSeq });
        } catch (error) {
          return res.json({ ...empty, unavailable: 'app-server-unavailable', detail: error?.message || String(error) });
        }
      }

      // Claude binds pane→session via Hook transcript_path, with its established cwd fallback.
      let file = null;
      let sessionId = null;
      const hooked = claudeEvents && claudeEvents.paneSession ? claudeEvents.paneSession(req.query.pane) : null;
      if (hooked?.transcriptPath) {
        file = hooked.transcriptPath;
        sessionId = hooked.sessionId || path.basename(file).replace(/\.jsonl$/, '');
      }
      const empty = { messages: [], hash: '', session: sessionId || null, hasMore: false, firstSeq: null };
      if (!file) {
        const cwd = await commands.paneCurrentPath(req.query.pane);
        const dir = projectsDir();
        const resolved = await resolveEncodedDirSession(dir, cwd);
        if (resolved.sessionId) {
          file = path.join(dir, encodeProjectDir(cwd), resolved.sessionId + '.jsonl');
          sessionId = resolved.sessionId;
        }
      }
      if (!file) return res.json(empty);
      const parsed = await reader.read(file, req.chatAgent.transcript.createParser);
      const { messages, firstSeq, hasMore } = pageTranscript(parsed, before, limit);
      if (before == null) {
        const hash = createHash('sha1').update(JSON.stringify(messages)).digest('hex').slice(0, 16);
        if (req.query.since === hash) return res.status(204).end();
        return res.json({ messages, hash, session: sessionId, hasMore, firstSeq });
      }
      return res.json({ messages, session: sessionId, hasMore, firstSeq });
    } catch (e) { next(e); }
  });
  return r;
}
