import { createReadStream, promises as fsp } from 'node:fs';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { createTranscriptParser } from './transcriptParse.js';

// Append-aware JSONL reader for chat transcripts. A live Claude session is append-only, so after the
// first asynchronous scan we read and parse only newly completed lines. Replacement/truncation resets
// the parser; a small LRU bounds server memory across panes. Parsing yields periodically so the initial
// scan of a long session cannot monopolize the Node event loop.
export function createTranscriptReader({ maxEntries = 8, yieldEvery = 500 } = {}) {
  const cache = new Map();
  const inflight = new Map();

  async function readCompleteLines(file, start) {
    const lines = [];
    let pending = Buffer.alloc(0);
    let consumed = 0;
    let bytesRead = 0;
    for await (const chunk of createReadStream(file, { start })) {
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

  async function applyLines(parser, lines) {
    for (let i = 0; i < lines.length; i += yieldEvery) {
      parser.push(lines.slice(i, i + yieldEvery));
      if (i + yieldEvery < lines.length) await yieldImmediate();
    }
  }

  function trim() {
    if (cache.size <= maxEntries) return;
    const oldest = Array.from(cache.entries()).sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [file] of oldest) {
      if (cache.size <= maxEntries) break;
      if (!inflight.has(file)) cache.delete(file);
    }
  }

  async function load(file, createParser) {
    let st;
    try { st = await fsp.stat(file); } catch { cache.delete(file); return []; }
    if (!st.isFile()) { cache.delete(file); return []; }

    let entry = cache.get(file);
    const sameFile = entry && entry.createParser === createParser && entry.dev === st.dev && entry.ino === st.ino;
    if (sameFile && entry.size === st.size && entry.mtimeMs === st.mtimeMs) {
      entry.usedAt = Date.now();
      return entry.parser.messages;
    }

    // A larger file with the same inode is the normal append path. Anything else (truncate, atomic
    // replace, or an in-place rewrite with unchanged size) gets a clean parser so stale messages cannot
    // leak across /clear or log rotation.
    const append = sameFile && st.size > entry.size;
    if (!append) {
      entry = { parser: createParser(), createParser, offset: 0, dev: st.dev, ino: st.ino, size: 0, mtimeMs: 0, usedAt: 0 };
    }

    const { lines, offset, size } = await readCompleteLines(file, entry.offset);
    await applyLines(entry.parser, lines);
    // Re-stat after reading: the writer may have appended while the stream was open. Metadata reflects
    // the latest observed file; any bytes not consumed as complete lines are deliberately retried later.
    let end = st;
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
    cache.set(file, entry);
    trim();
    return entry.parser.messages;
  }

  async function read(file, createParser = createTranscriptParser) {
    if (inflight.has(file)) return inflight.get(file);
    const run = load(file, createParser).finally(() => inflight.delete(file));
    inflight.set(file, run);
    return run;
  }

  return { read, clear: () => cache.clear(), size: () => cache.size };
}

export const transcriptReader = createTranscriptReader();
