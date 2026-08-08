// Read a pane's agent session as normalized chat messages. Claude reads its Hook-bound jsonl and keeps its
// established cwd fallback. Managed Codex gets its exact thread id from App Server, then reads that
// thread's durable rollout; App Server's history snapshot does not contain every completed tool.
// Server-side paginated — the phone must never receive the whole transcript:
//   - Recent window (default + polling): ?pane=&limit=10&since=<hash> — the last `limit` messages, with
//     the same content-hash `since`省流 as /history (unchanged window → 204). `hasMore`/`firstSeq` tell the
//     client whether/where an older page starts.
//   - History page (scroll-up, not polled): ?pane=&before=<k>&limit=10 — the last `limit` messages with
//     `k < before`, no hash.
// `k` = each message's current global ordinal and pagination cursor. It is stable because both Claude and
// Codex transcripts come from their append-only durable logs.
// Only the requested page is copied and decorated with `k`; the full parsed transcript is never mapped/filtered
// on every poll. The underlying reader asynchronously scans once,
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
import { resolveCodexRollout, sessionsDir as codexSessionsDir } from '../agents/codex.js';
import { enrichCodexFileDiffs } from '../codexDiff.js';

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

export function transcriptRoutes({
  commands, claudeEvents, reader = transcriptReader, codexApp,
  findCodexRollout = resolveCodexRollout, codexSessions = codexSessionsDir(),
}) {
  const r = express.Router();

  // Bind every request to the pane's actual agent before touching a session file. A caller cannot claim
  // Claude for a Codex pane (or vice versa) and make cwd fallback expose a different agent's conversation.
  r.use(['/pending-prompt', '/context', '/transcript'], (req, res, next) => {
    const pane = req.query.pane;
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    const requested = typeof req.query.agent === 'string' && req.query.agent ? req.query.agent : null;
    const hooked = claudeEvents?.paneSession ? claudeEvents.paneSession(pane) : null;
    const bound = (claudeEvents?.paneAgent ? claudeEvents.paneAgent(pane) : null) || hooked?.agent || null;
    // Managed Codex is verified again through its pane-owned App Server and exact thread id below. Claude
    // still fails closed against any conflicting Hook identity before cwd fallback.
    if (requested && bound && requested !== bound && requested !== 'codex') {
      return res.status(409).json({ error: 'pane agent mismatch' });
    }
    const id = requested === 'codex' ? 'codex' : (bound || requested || 'claude');
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
          const file = await findCodexRollout(codexSessions, sessionId);
          // A newly started thread has no rollout until its first turn. Keep the exact session binding and
          // show an empty conversation; the next poll will discover the file once Codex creates it.
          if (!file) return res.json({ ...empty, session: sessionId });
          const parsed = await reader.read(file, req.chatAgent.transcript.createParser);
          const page = pageTranscript(parsed, before, limit);
          let { messages } = page;
          const { firstSeq, hasMore } = page;
          const needsFileLines = messages.some((message) => message.tool?.name === 'apply_patch'
            && message.tool.diff && !message.tool.diff.hunks?.length);
          if (needsFileLines && codexApp?.read) {
            try {
              const opened = await codexApp.read(req.query.pane, sessionId);
              messages = enrichCodexFileDiffs(messages, opened?.thread);
            } catch { /* The rollout remains readable; an unavailable App Server must not fabricate lines. */ }
          }
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
