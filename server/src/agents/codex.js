// The OpenAI Codex CLI agent driver — the second agent, added to prove the driver contract generalizes (see
// claude.js for the shape). Codex exposes far less than Claude Code's hook system: its ONLY extension point
// is the `notify` program in ~/.codex/config.toml, which fires on exactly one event — `agent-turn-complete`
// — with the payload passed as a single JSON argv. So the classify vocabulary here has just one verb:
// turn-complete → done ("该你了"). Richer working/permission states would require tailing the live rollout
// jsonl (a later phase); the turn-done ping is the 90% signal for the phone and needs only the notify hook.
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { readHead, readTail, firstCwd, isSessionUuid } from './scanUtils.js';

// Map a notify event to an inbox "kind". Codex's notify JSON uses dashed keys (type: 'agent-turn-complete',
// 'last-assistant-message'); our notify adapter records src='turn-complete' and passes the payload through.
//   turn-complete → done   (the agent finished its turn; carries the last assistant message)
//   anything else → null
export function classifyCodex(src, body = {}) {
  if (src === 'turn-complete') return { kind: 'done', msg: body['last-assistant-message'] || body.last_assistant_message || '' };
  return null;
}

export const sessionsDir = (home = os.homedir()) => path.join(home, '.codex', 'sessions');

// A Codex rollout file is `rollout-<ISO-ish timestamp>-<uuid>.jsonl`; the session id Codex's `resume` wants
// is that trailing uuid. Pull it out of the basename.
export function rolloutSessionId(name) {
  const m = String(name).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : null;
}

// Last user turn out of a Codex rollout tail, for a recognizable one-line label. Codex records turns as
// response_item messages: {payload:{type:'message',role:'user',content:[{type:'input_text',text}]}} (and a
// flatter {type:'message',role:'user',...} in some versions). Skips the synthetic first turn Codex injects
// (environment_context / user_instructions, which are XML-ish and start with '<'). Best-effort → '' on miss.
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
    text = text.replace(/\s+/g, ' ').trim();
    if (!text || text[0] === '<') continue; // synthetic environment/instructions turn → keep scanning
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  return '';
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
    return { sessionId, state: now() - mtime < busyMs ? 'busy' : 'idle', snippet, lastActivity: Math.round(mtime) };
  }
  return {};
}

export const codex = {
  id: 'codex',
  label: 'Codex CLI',
  procName: 'codex',
  procMatch: /^(\S*\/)?codex(\s|$)/,
  takeoverPrefix: 'cx', // tmux session name prefix for a takeover (cx-<label>-<n>)
  classify: classifyCodex,
  sessions: {
    isId: isSessionUuid,
    dirOptKey: 'sessionsDir', // scanOrphans option that overrides `dir`
    dir: sessionsDir,
    resolve: (dir, cwd, opts = {}) => resolveCodexSession(dir, cwd, opts),
    // `codex resume <uuid>` continues the session from its rollout file.
    resumeCmd: (id) => `codex resume ${id}`,
  },
};
