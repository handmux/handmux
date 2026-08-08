// Codex process/session discovery. Hooks identify plain Codex sessions for inbox state and exact one-click
// takeover; once managed, App Server owns chat, approvals, stopping, and live state.
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { readHead, readTail, firstCwd, isSessionUuid } from './scanUtils.js';
import { classifyClaude } from './claude.js';
import { resolveByExecutable, executableBasename } from './processIdentity.js';
import {
  createCodexTranscriptParser, isCodexSyntheticUserText, parseCodexTranscript,
} from '../codexTranscriptParse.js';

export const sessionsDir = (home = os.homedir()) => path.join(home, '.codex', 'sessions');

// A Codex rollout file is `rollout-<ISO-ish timestamp>-<uuid>.jsonl`; the session id Codex's `resume` wants
// is that trailing uuid. Pull it out of the basename.
export function rolloutSessionId(name) {
  const m = String(name).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : null;
}

const UUID_PARTS = '([0-9a-f]{8})\\s*-\\s*([0-9a-f]{4})\\s*-\\s*([0-9a-f]{4})\\s*-\\s*([0-9a-f]{4})\\s*-\\s*([0-9a-f]{12})';

function lastUuidAfter(text, prefix) {
  const matches = [...String(text || '').matchAll(new RegExp(`${prefix}\\s*${UUID_PARTS}`, 'gi'))];
  const match = matches.at(-1);
  return match ? match.slice(1).join('-').toLowerCase() : null;
}

// A normal Codex exit prints the exact command for the session that just exited. Keep this deliberately
// stricter than a generic `codex resume` search so conversation text or shell history is not mistaken for
// the current exit notice.
export function codexExitSessionId(text) {
  return lastUuidAfter(text, 'To continue this session, run\\s+codex\\s+resume');
}

// Last user turn out of a Codex rollout tail, for a recognizable one-line label. Codex records turns as
// response_item messages: {payload:{type:'message',role:'user',content:[{type:'input_text',text}]}} (and a
// flatter {type:'message',role:'user',...} in some versions). Skips the synthetic context turns Codex
// injects (including repository instructions after a resume). Best-effort → '' on miss.
export function codexUserSnippet(tailText, max = 80) {
  const rows = String(tailText).split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = rows[i].trim();
    if (!line || line[0] !== '{') continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const msg = (d.payload && d.payload.type === 'message') ? d.payload
      : (d.type === 'message') ? d : null;
    if (!msg || msg.role !== 'user') continue;
    const c = msg.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) text = c.filter((b) => b && (b.type === 'input_text' || b.type === 'text')).map((b) => b.text).join(' ');
    if (!text || isCodexSyntheticUserText(text)) continue;
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  return '';
}

// The npm-installed Codex launcher leaves `node` as tmux's pane_current_command. Never accept that
// ambiguous name by itself: prove a foreground process on the same TTY has a real executable named
// `codex` from a Codex path, then normalize the pane to the canonical agent name.
export async function resolveCodexComms(panes, run, verdicts = new Map(), opts = {}) {
  return resolveByExecutable(panes, run, verdicts, {
    candidate: (cmd) => cmd === 'node',
    normalized: 'codex',
    matches: (exe) => /^codex(?:\.exe)?$/i.test(executableBasename(exe)) && /codex/i.test(exe),
    ...opts,
  });
}

// Walk the date-nested sessions tree (…/YYYY/MM/DD/rollout-*.jsonl) newest-first and collect up to `limit`
// rollout files with their mtimes. Unlike Claude's flat encoded-cwd dir, Codex partitions by date, so we
// descend year→month→day in descending name order and stop once we have enough — the newest sessions are
// always in the latest date dir, so a live orphan's session is found without reading the whole history.
async function recentRollouts(dir, limit = 80) {
  const out = [];
  async function descend(d, depth) {
    if (out.length >= limit) return;
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    if (depth < 3) {
      const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
      for (const name of subdirs) { if (out.length >= limit) break; await descend(path.join(d, name), depth + 1); }
      return;
    }
    const files = entries.filter((e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'));
    for (const f of files) {
      try { out.push({ file: path.join(d, f.name), name: f.name, mtime: (await fsp.stat(path.join(d, f.name))).mtimeMs }); } catch { /* gone */ }
    }
  }
  await descend(dir, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

// Resolve one known App Server thread id to its exact rollout. This never falls back by cwd: several
// Codex panes can share a project, while the UUID suffix is the durable one-to-one session identity.
const rolloutPathCache = new Map();
export async function resolveCodexRollout(dir, sessionId) {
  if (!isSessionUuid(sessionId)) return null;
  const key = `${dir}\0${sessionId}`;
  const cached = rolloutPathCache.get(key);
  if (cached) {
    try { await fsp.access(cached); return cached; } catch { rolloutPathCache.delete(key); }
  }
  const suffix = `-${sessionId}.jsonl`;
  let found = null;
  async function descend(current, depth) {
    if (found) return;
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    if (depth < 3) {
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        await descend(path.join(current, entry.name), depth + 1);
        if (found) return;
      }
      return;
    }
    const match = entries.find((entry) => entry.isFile()
      && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix));
    if (match) found = path.join(current, match.name);
  }
  await descend(dir, 0);
  if (found) rolloutPathCache.set(key, found);
  return found;
}

// Resolve a live orphan's cwd to its Codex session: the newest rollout whose recorded cwd matches. Same
// shape as Claude's resolver ({ sessionId, state, snippet, lastActivity }) so the orphan engine is agnostic.
export async function resolveCodexSession(dir, cwd, { busyMs = 8000, now = Date.now } = {}) {
  const files = await recentRollouts(dir);
  for (const { file, name, mtime } of files) {
    let head;
    try { head = await readHead(file); } catch { continue; }
    if (firstCwd(head) !== cwd) continue;
    const sessionId = rolloutSessionId(name);
    if (!sessionId) continue;
    let snippet = '';
    try { snippet = codexUserSnippet(await readTail(file)); } catch { /* best effort */ }
    return { sessionId, state: now() - mtime < busyMs ? 'busy' : 'idle', snippet, lastActivity: Math.round(mtime), file };
  }
  return {};
}

export const codex = {
  id: 'codex',
  label: 'Codex CLI',
  procName: 'codex',
  // Ambiguous `node` launchers are normalized by resolveCodexComms only after real-executable proof.
  procNames: ['codex'],
  procMatch: /^(\S*\/)?codex(\s|$)/,
  takeoverPrefix: 'cx', // tmux session name prefix for a takeover (cx-<label>-<n>)
  classify: classifyClaude, // Codex hook payloads match Claude's field-for-field — same classifier
  transcript: { createParser: createCodexTranscriptParser, parse: parseCodexTranscript },
  sessions: {
    // Rows written before SessionStart(`/clear`) support can point at a previous rollout. Consumers reject
    // those legacy rows until a refreshed hook writes the current binding at this version.
    bindingVersion: 2,
    isId: isSessionUuid,
    dirOptKey: 'sessionsDir', // scanOrphans option that overrides `dir`
    dir: sessionsDir,
    resolve: (dir, cwd, opts = {}) => resolveCodexSession(dir, cwd, opts),
    // `codex resume <uuid>` continues the session from its rollout file.
    resumeArgs: (id) => ['codex', 'resume', id],
    resumeCmd: (id) => `codex resume ${id}`,
    managedResumeCmd: (id) => `handmux codex resume ${id}`,
  },
};
