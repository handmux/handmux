import fs from 'node:fs';
import path from 'node:path';
import { isSessionUuid } from './scanUtils.js';
import { claudeLocalCommandCompletion } from './claudeLocalCommand.js';

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const METADATA = new Set(['last-prompt', 'ai-title', 'mode', 'permission-mode', 'file-history-snapshot']);
const MAX_BYTES = 65536;
const MAX_SESSIONS = 128;
export interface ClaudeNativeCompletion {
  interruption: string | null;
  settled?: string | null;
  localCommand: string | null | undefined;
  lastRecord?: Readonly<Row> | null;
}
interface Tail {
  sessionId: string;
  fingerprint: string;
  rows: Array<Row | null>;
  complete: boolean;
  lastHookTime: number;
  invalidatedThrough?: number;
}

function interruption(rows: readonly (Row | null)[], sessionId: string, promptId: unknown, after: number, now: number): string | null {
  let duration: Row | undefined;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (!row) return null;
    if (typeof row.type === 'string' && METADATA.has(row.type)) continue;
    if (row.sessionId !== sessionId || row.isSidechain !== false || !isSessionUuid(row.uuid)
      || row.isMeta === true || row.isCompactSummary === true) return null;
    const timestamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(timestamp) || timestamp <= after || timestamp > now) return null;
    if (row.type === 'system' && row.subtype === 'turn_duration' && !duration) { duration = row; continue; }
    if (row.type !== 'user' || (promptId !== undefined && promptId !== row.promptId)
      || ['promptSource', 'origin', 'permissionMode'].some((key) => Object.hasOwn(row, key))) return null;
    const message = record(row.message);
    const content = message?.content;
    if (message?.role !== 'user' || !Array.isArray(content) || content.length !== 1) return null;
    const block = record(content[0]);
    if (block?.type !== 'text') return null;
    if (block.text !== '[Request interrupted by user for tool use]'
      && !(block.text === '[Request interrupted by user]' && typeof row.interruptedMessageId === 'string'
        && row.interruptedMessageId.length > 0 && row.interruptedMessageId.length <= 256)) return null;
    if (duration && (duration.parentUuid !== row.uuid || Date.parse(String(duration.timestamp)) < timestamp)) return null;
    return `claude-interrupted:${sessionId}:${row.uuid}`;
  }
  return null;
}

// Shared by the Claude activity reader and its Inbox Connector. No timer: existing polls stat first,
// and one changed file produces at most one 64 KiB read and JSON parse across both consumers.
export class ClaudeNativeTailReader {
  readonly #tails = new Map<string, Tail>();

  read(payload: Row, after: number, now: number): ClaudeNativeCompletion {
    const sessionId = payload.session_id;
    const file = payload.transcript_path;
    const absent = { interruption: null, localCommand: undefined };
    if (!isSessionUuid(sessionId) || typeof file !== 'string' || path.basename(file) !== `${sessionId}.jsonl`) return absent;
    let tail: Tail;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return { interruption: null, localCommand: null };
      const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
      const cached = this.#tails.get(file);
      if (cached?.fingerprint === fingerprint) tail = cached;
      else {
        const fd = fs.openSync(file, 'r');
        let text: string;
        try {
          const current = fs.fstatSync(fd);
          if ([current.dev, current.ino, current.size, current.mtimeMs, current.ctimeMs].join(':') !== fingerprint) {
            this.#invalidate(file, after);
            return { interruption: null, localCommand: null };
          }
          const length = Math.min(stat.size, MAX_BYTES);
          const buffer = Buffer.alloc(length);
          const read = fs.readSync(fd, buffer, 0, length, stat.size - length);
          const finished = fs.fstatSync(fd);
          if (read !== length
            || [finished.dev, finished.ino, finished.size, finished.mtimeMs, finished.ctimeMs].join(':') !== fingerprint) {
            this.#invalidate(file, after);
            return { interruption: null, localCommand: null };
          }
          text = buffer.subarray(0, read).toString('utf8');
        } finally { fs.closeSync(fd); }
        const lines = text.split('\n');
        if (stat.size > MAX_BYTES) lines.shift();
        const rows = lines.filter((line) => line.trim()).map((line) => {
          try { return record(JSON.parse(line)); } catch { return null; }
        });
        const invalidatedThrough = cached && (cached.fingerprint.split(':')[1] !== String(stat.ino)
          || cached.fingerprint.split(':')[0] !== String(stat.dev)
          || Number(cached.fingerprint.split(':')[2]) > stat.size)
          ? Math.max(cached.lastHookTime, cached.invalidatedThrough ?? 0) : cached?.invalidatedThrough;
        tail = { sessionId, fingerprint, rows, complete: !text || text.endsWith('\n'), lastHookTime: Math.max(cached?.lastHookTime ?? 0, after),
          ...(invalidatedThrough === undefined ? {} : { invalidatedThrough }) };
      }
      this.#tails.delete(file);
      this.#tails.set(file, tail);
      while (this.#tails.size > MAX_SESSIONS) this.#tails.delete(this.#tails.keys().next().value!);
    } catch { this.#invalidate(file, after); return { interruption: null, localCommand: null }; }
    if (!tail.complete) return { interruption: null, localCommand: null };
    tail.lastHookTime = Math.max(tail.lastHookTime, after);
    const interrupted = interruption(tail.rows, sessionId, payload.prompt_id, after, now);
    const localCommand = claudeLocalCommandCompletion(payload, after, now, tail.rows);
    // A local picker dispatched after an interrupt fires no new Hook either. Only inherit the idle
    // lifecycle when that exact command/output pair immediately follows a proven interruption.
    let settled = interrupted;
    if (!settled && localCommand) {
      let native = tail.rows.filter((row) => !row || typeof row.type !== 'string' || !METADATA.has(row.type));
      while (native.length >= 3 && claudeLocalCommandCompletion(payload, after, now, native)) {
        const commandTime = Date.parse(String(native.at(-2)?.timestamp));
        native = native.slice(0, -2);
        if (Date.parse(String(native.at(-1)?.timestamp)) > commandTime) break;
        if (interruption(native, sessionId, payload.prompt_id, after, now)) { settled = localCommand; break; }
      }
    }
    return {
      interruption: interrupted,
      settled,
      localCommand: localCommand === undefined && tail.invalidatedThrough !== undefined && after <= tail.invalidatedThrough
        ? null : localCommand,
      lastRecord: tail.rows.at(-1) ?? null,
    };
  }

  retain(sessionIds: ReadonlySet<string>): void {
    for (const [file, tail] of this.#tails) if (!sessionIds.has(tail.sessionId)) this.#tails.delete(file);
  }

  #invalidate(file: string, after: number): void {
    const previous = this.#tails.get(file);
    if (!previous) return;
    // Keep only the invalidation boundary across a rotation's temporary ENOENT, never old evidence.
    this.#tails.set(file, { ...previous, fingerprint: '', rows: [], complete: false,
      lastHookTime: Math.max(previous.lastHookTime, after),
      invalidatedThrough: Math.max(previous.lastHookTime, previous.invalidatedThrough ?? 0, after) });
  }

  release(sessionId: string): void {
    for (const [file, tail] of this.#tails) if (tail.sessionId === sessionId) this.#tails.delete(file);
  }

  clear(): void { this.#tails.clear(); }
}
