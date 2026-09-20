// The CodeBuddy out-of-band reconciliation. CodeBuddy fires NO Hook when the user answers a
// PermissionRequest, so an answered pane keeps its 需要你 gate lit until whatever Hook comes next — for a
// tool outside the PostToolUse matcher, until the turn ends. Claude closes the same gap from its own session
// registry (`status: idle|busy|waiting`, which flips back to busy the moment the user answers). CodeBuddy
// keeps no such status anywhere readable: its registry file carries only a heartbeat, its per-session local
// HTTP endpoint exposes no session state, and its live event channel is a Centrifugo WebSocket. The one
// artifact that does move is the session transcript, where the granted tool lands its result record.
//
// The verdict is deliberately one-sided: a result record strictly newer than the gate proves the pane's tool
// ran after the user answered, so the gate is over. Everything else — no transcript, an unparsable file, a
// result older than the gate, a row that is not a gate, or a tail that happens to hold no result at all —
// says nothing, leaving the Hook's own state exactly as it was.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codebuddyProjectsDir, codebuddySessionsDir } from './codebuddy.js';
import type { HookBridgeNativeTail } from '../../connectors/hookBridge.js';

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null
);

// A transcript is append-only and a result is written when it happens, so the newest one is always in the
// last chunk. A chunk with no result at all (a very large tool output ahead of it) closes nothing.
const MAX_TAIL_BYTES = 262_144;
const MAX_CACHED_TRANSCRIPTS = 64;

// The rows that can latch a gate. Only they are worth reading a transcript for, which keeps this reader at
// zero cost on a pane that is simply working.
function isGateRow(src: string, payload: Row): boolean {
  return src === 'permreq'
    || (src === 'notify' && payload.notification_type === 'permission_prompt');
}

// The transcript for a gate row. Three AUTHORITATIVE names, in order — never a guess: a path the Hook
// carried, the session id the Hook carried, then the pid's own registry row. The registry one matters
// because a Notification payload carries neither a session id nor a transcript path (measured) and it is
// the row a gate is often latched from; the session-id one matters because a registry row can be stale
// (observed: a resumed session keeps the pid file's older id), which would otherwise leave the gate unclosed
// on a pane whose Hook did name its session.
function transcriptFor(
  payload: Row,
  pid: unknown,
  home: string,
  locate: (projects: string, sessionId: string) => string | null,
): string | null {
  const explicit = payload.transcript_path;
  if (typeof explicit === 'string' && path.isAbsolute(explicit)
    && path.basename(explicit).endsWith('.jsonl')) return explicit;
  const projects = codebuddyProjectsDir(home);
  const payloadSession = payload.session_id;
  if (typeof payloadSession === 'string' && payloadSession) {
    const found = locate(projects, payloadSession);
    if (found) return found;
  }
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return null;
  let registry: Row | null = null;
  try {
    registry = record(JSON.parse(
      fs.readFileSync(path.join(codebuddySessionsDir(home), `${Number(pid)}.json`), 'utf8'),
    ));
  } catch { return null; }
  const sessionId = registry?.sessionId;
  const cwd = registry?.cwd;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  // CodeBuddy names a project directory after the cwd with the separating slashes replaced by dashes
  // (verified: /home/user/x → Users-admin-x, /private/tmp/cb-sim → private-tmp-cb-sim). It is only a
  // shortcut past the scan — the session UUID is what actually names the file, so a miss costs nothing.
  if (typeof cwd === 'string' && cwd) {
    const direct = path.join(projects, cwd.replace(/^\//, '').replace(/\//g, '-'), `${sessionId}.jsonl`);
    try { if (fs.statSync(direct).isFile()) return direct; } catch { /* scan below */ }
  }
  return locate(projects, sessionId);
}

// The newest tool result timestamp in the transcript's tail, or null when the tail holds none.
function newestResultAt(file: string): number | null {
  let descriptor: number | null = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return null;
    const length = Math.min(stat.size, MAX_TAIL_BYTES);
    descriptor = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, stat.size - length);
    const lines = buffer.toString('utf8').split('\n');
    // A read that started mid-file begins with a fragment of a line: it cannot parse, but drop it anyway so
    // a truncated record can never be mistaken for one.
    if (stat.size > length) lines.shift();
    let newest: number | null = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row: Row | null = null;
      try { row = record(JSON.parse(trimmed)); } catch { continue; } // a half-written last line
      if (!row || row.type !== 'function_call_result') continue;
      const timestamp = row.timestamp;
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue;
      if (newest === null || timestamp > newest) newest = timestamp;
    }
    return newest;
  } catch { return null; } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
    }
  }
}

export class CodeBuddyNativeTailReader implements HookBridgeNativeTail {
  readonly #home: string;
  // Keyed by transcript file and bounded: an unchanged file costs one `stat`, and the gate rows that get
  // here are few. `retain` is deliberately a no-op — the cache is not keyed by session, and the rows that
  // need it (a gate latched from a Notification) carry no session id to retain it by.
  readonly #tails = new Map<string, { fingerprint: string; at: number | null }>();
  // Memoized `<sessionId>.jsonl` lookups: a session's path never moves, and the walk only ever runs for a
  // session a gate actually named.
  readonly #paths = new Map<string, string | null>();

  constructor({ home = os.homedir() }: { home?: string } = {}) {
    this.#home = home;
  }

  read(
    payload: Row,
    after: number,
    now: number,
    process?: { pid: number; startedAt?: number },
    src?: string,
  ): { status?: 'idle' | 'busy' | 'waiting' | 'unknown'; settled?: string | null; statusEventId?: string } {
    const body = record(payload) ?? {};
    if (!isGateRow(String(src ?? ''), body)) return {};
    const file = transcriptFor(
      body,
      process?.pid,
      this.#home,
      (projects, sessionId) => this.#locate(projects, sessionId),
    );
    if (!file) return {};
    const at = this.#resultAt(file);
    // Strictly after the gate, and never in the future: a result from before the request cannot close it,
    // and a clock that ran away must not either.
    if (at === null || at <= after || at > now) return {};
    const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
    return {
      status: 'busy',
      statusEventId: `codebuddy-native:${sessionId}:${process?.pid ?? 0}:${at}`,
    };
  }

  retain(): void { /* see #tails: nothing is keyed by session */ }

  clear(): void {
    this.#tails.clear();
    this.#paths.clear();
  }

  #locate(projects: string, sessionId: string): string | null {
    const key = `${projects}\0${sessionId}`;
    const cached = this.#paths.get(key);
    if (cached !== undefined) return cached;
    let found: string | null = null;
    try {
      for (const entry of fs.readdirSync(projects)) {
        const candidate = path.join(projects, entry, `${sessionId}.jsonl`);
        try { if (fs.statSync(candidate).isFile()) { found = candidate; break; } } catch { /* next entry */ }
      }
    } catch { /* no projects directory */ }
    this.#paths.delete(key);
    this.#paths.set(key, found);
    if (this.#paths.size > MAX_CACHED_TRANSCRIPTS) {
      this.#paths.delete(this.#paths.keys().next().value!);
    }
    return found;
  }

  #resultAt(file: string): number | null {
    let fingerprint: string;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return null;
      fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeMs].join(':');
    } catch { this.#tails.delete(file); return null; }
    const cached = this.#tails.get(file);
    if (cached?.fingerprint === fingerprint) return cached.at;
    const at = newestResultAt(file);
    this.#tails.delete(file);
    this.#tails.set(file, { fingerprint, at });
    if (this.#tails.size > MAX_CACHED_TRANSCRIPTS) {
      this.#tails.delete(this.#tails.keys().next().value!);
    }
    return at;
  }
}
