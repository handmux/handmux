// The OpenAI Codex CLI agent driver — the second agent, added to prove the driver contract generalizes (see
// claude.js for the shape). Codex 0.142+ ships a Claude-parity hook system (verified against the real CLI):
// the SAME lifecycle events (UserPromptSubmit / PermissionRequest / Stop …) delivering the SAME stdin JSON
// fields (prompt / tool_input / last_assistant_message / stop_hook_active …). So handmux wires Codex through
// its config.toml hooks (see cli/codexHooks.js) reusing the shared Claude hook scripts, and Codex CLASSIFIES
// with the very same function as Claude — full working / 需要你 / done parity, not just turn-done.
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { readHead, readTail, firstCwd, isSessionUuid } from './scanUtils.js';
import { classifyClaude } from './claude.js';
import { resolveByExecutable, executableBasename } from './processIdentity.js';

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
  // Ambiguous `node` launchers are normalized by resolveCodexComms only after real-executable proof.
  procNames: ['codex'],
  procMatch: /^(\S*\/)?codex(\s|$)/,
  takeoverPrefix: 'cx', // tmux session name prefix for a takeover (cx-<label>-<n>)
  classify: classifyClaude, // Codex hook payloads match Claude's field-for-field — same classifier

  sessions: {
    isId: isSessionUuid,
    dirOptKey: 'sessionsDir', // scanOrphans option that overrides `dir`
    dir: sessionsDir,
    resolve: (dir, cwd, opts = {}) => resolveCodexSession(dir, cwd, opts),
    // `codex resume <uuid>` continues the session from its rollout file.
    resumeArgs: (id) => ['codex', 'resume', id],
    resumeCmd: (id) => `codex resume ${id}`,
  },
};
