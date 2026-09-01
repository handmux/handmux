import { createReadStream, promises as fsp } from 'node:fs';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { createTranscriptParser } from './transcriptParse.js';
import type { Stats } from 'node:fs';
import type { TranscriptMessage } from './transcriptParse.js';

export interface IncrementalTranscriptParser<T> {
  messages: T[];
  push(lines: readonly unknown[]): T[];
  takeChangedFrom?(): number | null;
}
export type TranscriptParserFactory<T> = () => IncrementalTranscriptParser<T>;
export interface TranscriptReadSnapshot<T> {
  messages: T[];
  version: string;
  changedFrom: number | null;
  generation?: number;
}
interface ReaderOptions { maxEntries?: number; yieldEvery?: number }
interface ReadLinesResult { lines: string[]; offset: number; size: number }
interface CacheEntry<T> {
  parser: IncrementalTranscriptParser<T>;
  createParser: TranscriptParserFactory<T>;
  offset: number;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  usedAt: number;
  generation: number;
}
export interface TranscriptReader {
  read(file: string): Promise<TranscriptMessage[]>;
  read<T>(file: string, createParser: TranscriptParserFactory<T>): Promise<T[]>;
  readPrefix?<T>(
    file: string,
    endExclusive: number,
    createParser: TranscriptParserFactory<T>,
  ): Promise<T[]>;
  readSnapshot?<T>(
    file: string,
    createParser: TranscriptParserFactory<T>,
  ): Promise<TranscriptReadSnapshot<T>>;
  readPrefixSnapshot?<T>(
    file: string,
    endExclusive: number,
    createParser: TranscriptParserFactory<T>,
  ): Promise<TranscriptReadSnapshot<T>>;
  clear(): void;
  size(): number;
}

// Append-aware JSONL reader for chat transcripts. A live Claude session is append-only, so after the
// first asynchronous scan we read and parse only newly completed lines. Replacement/truncation resets
// the parser; a small LRU bounds server memory across panes. Parsing yields periodically so the initial
// scan of a long session cannot monopolize the Node event loop.
export function createTranscriptReader({ maxEntries = 8, yieldEvery = 500 }: ReaderOptions = {}): TranscriptReader {
  const cache = new Map<string, CacheEntry<unknown>>();
  const inflight = new Map<string, Promise<unknown[]>>();
  let generation = 0;

  async function readCompleteLines(
    file: string,
    start: number,
    endExclusive?: number,
  ): Promise<ReadLinesResult> {
    const lines: string[] = [];
    let pending = Buffer.alloc(0);
    let consumed = 0;
    let bytesRead = 0;
    if (endExclusive !== undefined && endExclusive <= start) {
      return { lines, offset: start, size: start };
    }
    const options = endExclusive === undefined
      ? { start }
      : { start, end: endExclusive - 1 };
    for await (const rawChunk of createReadStream(file, options)) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      bytesRead += chunk.length;
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let pos = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, pos);
        if (nl === -1) break;
        lines.push(data.subarray(pos, nl).toString('utf8'));
        consumed += nl - pos + 1;
        pos = nl + 1;
      }
      pending = data.subarray(pos);
    }
    return { lines, offset: start + consumed, size: start + bytesRead };
  }

  async function applyLines<T>(parser: IncrementalTranscriptParser<T>, lines: string[]): Promise<void> {
    for (let i = 0; i < lines.length; i += yieldEvery) {
      parser.push(lines.slice(i, i + yieldEvery));
      if (i + yieldEvery < lines.length) await yieldImmediate();
    }
  }

  function trim(): void {
    if (cache.size <= maxEntries) return;
    const oldest = Array.from(cache.entries()).sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [file] of oldest) {
      if (cache.size <= maxEntries) break;
      if (!inflight.has(file)) cache.delete(file);
    }
  }

  async function load<T>(file: string, createParser: TranscriptParserFactory<T>): Promise<T[]> {
    let st: Stats;
    try { st = await fsp.stat(file); } catch { cache.delete(file); return []; }
    if (!st.isFile()) { cache.delete(file); return []; }

    let entry = cache.get(file) as CacheEntry<T> | undefined;
    const sameFile = Boolean(entry
      && entry.createParser === createParser
      && entry.dev === st.dev
      && entry.ino === st.ino);
    if (entry && sameFile && entry.size === st.size && entry.mtimeMs === st.mtimeMs) {
      entry.usedAt = Date.now();
      return entry.parser.messages;
    }

    // A larger file with the same inode is the normal append path. Anything else (truncate, atomic
    // replace, or an in-place rewrite with unchanged size) gets a clean parser so stale messages cannot
    // leak across /clear or log rotation.
    const append = Boolean(sameFile && entry && st.size > entry.size);
    if (!append || !entry) {
      entry = {
        parser: createParser(), createParser, offset: 0, dev: st.dev, ino: st.ino,
        size: 0, mtimeMs: 0, usedAt: 0, generation: ++generation,
      };
    }

    const { lines, offset, size } = await readCompleteLines(file, entry.offset);
    await applyLines(entry.parser, lines);
    // Re-stat after reading: the writer may have appended while the stream was open. Metadata reflects
    // the latest observed file; any bytes not consumed as complete lines are deliberately retried later.
    let end: Stats = st;
    try { end = await fsp.stat(file); } catch { /* return the last complete snapshot */ }
    entry.offset = offset;
    // Only adopt the post-read metadata if it describes exactly the bytes the stream consumed. If the
    // file grew or was replaced in the race window, retaining the pre-read identity/observed size forces
    // the next poll down the append/reset path instead of accidentally declaring unread bytes unchanged.
    const caughtUp = end.dev === st.dev && end.ino === st.ino && end.size === size;
    entry.dev = caughtUp ? end.dev : st.dev;
    entry.ino = caughtUp ? end.ino : st.ino;
    entry.size = size;
    entry.mtimeMs = caughtUp ? end.mtimeMs : st.mtimeMs;
    entry.usedAt = Date.now();
    cache.set(file, entry as unknown as CacheEntry<unknown>);
    trim();
    return entry.parser.messages;
  }

  async function read<T = TranscriptMessage>(
    file: string,
    createParser: TranscriptParserFactory<T> = createTranscriptParser as unknown as TranscriptParserFactory<T>,
  ): Promise<T[]> {
    const active = inflight.get(file);
    if (active) return active as Promise<T[]>;
    const run = load(file, createParser).finally(() => inflight.delete(file));
    inflight.set(file, run as Promise<unknown[]>);
    return run;
  }

  async function readPrefix<T>(
    file: string,
    endExclusive: number,
    createParser: TranscriptParserFactory<T>,
  ): Promise<T[]> {
    if (!Number.isSafeInteger(endExclusive) || endExclusive < 0) {
      throw new TypeError('Transcript prefix boundary must be a non-negative safe integer');
    }
    const parser = createParser();
    if (endExclusive === 0) return parser.messages;
    const { lines } = await readCompleteLines(file, 0, endExclusive);
    await applyLines(parser, lines);
    return parser.messages;
  }

  async function readSnapshot<T>(
    file: string,
    createParser: TranscriptParserFactory<T>,
  ): Promise<TranscriptReadSnapshot<T>> {
    const messages = await read(file, createParser);
    const entry = cache.get(file) as CacheEntry<T> | undefined;
    // `offset` advances only after complete JSONL records were parsed. Metadata distinguishes an in-place
    // rewrite/replace that happens to end at the same byte boundary. Consumers can therefore skip all
    // projection and hashing work when this token is unchanged.
    const version = entry
      ? `${entry.dev}:${entry.ino}:${entry.offset}:${entry.size}:${entry.mtimeMs}`
      : 'missing';
    return {
      messages,
      version,
      changedFrom: entry
        ? entry.parser.takeChangedFrom ? entry.parser.takeChangedFrom() : 0
        : null,
      ...(entry ? { generation: entry.generation } : {}),
    };
  }

  async function readPrefixSnapshot<T>(
    file: string,
    endExclusive: number,
    createParser: TranscriptParserFactory<T>,
  ): Promise<TranscriptReadSnapshot<T>> {
    if (!Number.isSafeInteger(endExclusive) || endExclusive < 0) {
      throw new TypeError('Transcript prefix boundary must be a non-negative safe integer');
    }
    // A normal read may already be advancing this parser. Wait for that mutation before deciding whether
    // its append state can satisfy the immutable opening boundary.
    await inflight.get(file)?.catch(() => {});
    let st: Stats;
    try { st = await fsp.stat(file); } catch {
      return { messages: [], version: 'missing', changedFrom: null };
    }
    if (!st.isFile() || endExclusive > st.size) {
      return { messages: [], version: 'missing', changedFrom: null };
    }
    let entry = cache.get(file) as CacheEntry<T> | undefined;
    const reusable = Boolean(entry
      && entry.createParser === createParser
      && entry.dev === st.dev
      && entry.ino === st.ino
      && entry.offset <= endExclusive
      && entry.size <= endExclusive);
    if (!reusable || !entry) {
      // A cached parser beyond the cutoff cannot be rewound. Build this rare historical prefix in
      // isolation and leave the newer append cache intact.
      const parser = createParser();
      const { lines, offset, size } = await readCompleteLines(file, 0, endExclusive);
      await applyLines(parser, lines);
      return {
        messages: parser.messages,
        version: `${st.dev}:${st.ino}:${offset}:${size}:${st.mtimeMs}`,
        changedFrom: parser.takeChangedFrom ? parser.takeChangedFrom() : 0,
        generation: ++generation,
      };
    }
    if (entry.size < endExclusive || entry.offset < endExclusive) {
      const { lines, offset, size } = await readCompleteLines(file, entry.offset, endExclusive);
      await applyLines(entry.parser, lines);
      entry.offset = offset;
      entry.size = size;
      entry.mtimeMs = st.mtimeMs;
      entry.usedAt = Date.now();
      cache.set(file, entry as unknown as CacheEntry<unknown>);
      trim();
    }
    return {
      messages: entry.parser.messages,
      version: `${entry.dev}:${entry.ino}:${entry.offset}:${entry.size}:${entry.mtimeMs}`,
      changedFrom: entry.parser.takeChangedFrom ? entry.parser.takeChangedFrom() : 0,
      generation: entry.generation,
    };
  }

  return {
    read, readPrefix, readSnapshot, readPrefixSnapshot,
    clear: () => cache.clear(), size: () => cache.size,
  };
}

export const transcriptReader = createTranscriptReader();
