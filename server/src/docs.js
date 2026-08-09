import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { TextDecoder } from 'node:util';
import { docTypeFor, imageTypeFor, isUnder, hasHiddenSegment } from './docPath.js';

const MAX_READ_BYTES = 2 * 1024 * 1024;        // 2MB cap for in-app text reads (readDoc)
// Single source of truth for the 50MB transfer cap, shared by download (maxDownloadBytes default
// below) and upload (httpApi.js imports this as the maxUploadBytes default). Server-side only.
export const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;

// Decode only actual text. `Buffer.toString('utf8')` silently replaces malformed bytes, which would
// make arbitrary binaries look previewable; fatal decoders keep that boundary honest. UTF-16 needs a
// BOM because zero bytes are otherwise our strongest cheap binary signal.
function decodeText(buffer) {
  let encoding = 'utf-8';
  let offset = 0;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = 'utf-16le'; offset = 2;
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = 'utf-16be'; offset = 2;
  } else if (buffer.includes(0)) {
    return null;
  }
  try { return new TextDecoder(encoding, { fatal: true }).decode(buffer.subarray(offset)); }
  catch { return null; }
}

// Flatten an absolute cwd into ONE filesystem-safe path segment for the per-project upload space,
// Claude-Code style: '/' → '-' (so /Users/x/proj → -Users-x-proj), and any other non-portable char
// → '_'. A valid cwd always starts with '/', so the key always starts with '-' — it can never be
// '..'/'.' and, having no separators, can never escape the uploads root. Empty/relative → '_default'.
export function encodeCwdKey(cwd) {
  if (typeof cwd !== 'string' || cwd[0] !== '/') return '_default';
  return cwd.replace(/\//g, '-').replace(/[^A-Za-z0-9._-]/g, '_') || '_default';
}

// Factory bound to a `home` root. All reads pass through fs.realpath then isUnder(realHome):
// realpath collapses ../ and resolves symlinks, so the home-containment check is the final word —
// a symlink whose target escapes home resolves outside and gets rejected.
export function createDocs({ home, extraRoots = [], maxDownloadBytes = MAX_TRANSFER_BYTES } = {}) {
  // $HOME is constant at runtime — resolve once at construction, reuse the same promise everywhere.
  const realHomeP = fs.realpath(home);
  // Browse / read / download / upload may also reach a few EXTRA roots OUTSIDE $HOME (e.g. /tmp,
  // $TMPDIR) so transient files an agent drops there are reachable from the phone. Resolved once:
  // realpath'd, deduped, missing ones skipped, and any extra already inside home dropped (home
  // covers it). `home` is always roots[0]. Session-cwd (resolveCwd) and the upload stash stay
  // home-only on purpose. The "under one of these roots" check replaces the old single isUnder(home).
  const rootsP = (async () => {
    const rh = await realHomeP;
    const out = [rh];
    for (const r of extraRoots) {
      if (typeof r !== 'string' || !r) continue;
      let real;
      try { real = await fs.realpath(r); } catch { continue; } // not present on this host → skip
      if (isUnder(real, rh) || out.includes(real)) continue;   // already covered by home / dup
      out.push(real);
    }
    return out;
  })();
  // The allowed root that contains `real` (longest match wins should roots ever nest), or null.
  const rootOf = (real, roots) => {
    let best = null;
    for (const r of roots) if (isUnder(real, r) && (!best || r.length > best.length)) best = r;
    return best;
  };

  // `knownMtime` (ms) makes this a conditional read: if the file's mtime is unchanged the body is
  // skipped and `{ notModified: true }` comes back (no readFile), so re-visiting an unchanged doc on
  // the phone neither transfers content nor forces a re-render. `mtimeMs` is always returned so the
  // client can store it for the next check.
  async function readDoc(rawPath, knownMtime = null) {
    if (typeof rawPath !== 'string' || rawPath[0] !== '/') return { error: 'not absolute', status: 400 };
    // Markdown/HTML keep their rich renderer; every other filename gets a content-checked plain-text
    // preview. Extension is presentation metadata, never the permission to read a file as text.
    const type = docTypeFor(rawPath) || 'text';
    let real;
    try { real = await fs.realpath(rawPath); }
    catch { return { error: 'not found', status: 404 }; }
    if (!rootOf(real, await rootsP)) return { error: 'outside home', status: 400 };
    let st;
    try { st = await fs.stat(real); }
    catch { return { error: 'not accessible', status: 404 }; }
    if (!st.isFile()) return { error: 'not a file', status: 400 };
    if (st.size > MAX_READ_BYTES) return { error: 'too large', status: 413 };
    const mtimeMs = st.mtimeMs;
    if (knownMtime != null && mtimeMs === knownMtime) return { name: basename(real), type, mtimeMs, notModified: true };
    const content = decodeText(await fs.readFile(real));
    if (content == null) return { error: 'not text', status: 415 };
    return { name: basename(real), type, content, mtimeMs };
  }

  async function listDir(rawPath) {
    const rh = await realHomeP;
    const roots = await rootsP;
    let real;
    try { real = await fs.realpath(rawPath ? rawPath : home); }
    catch { return { error: 'not found', status: 404 }; }
    if (!rootOf(real, roots)) return { error: 'outside home', status: 400 };
    const st = await fs.stat(real);
    if (!st.isDirectory()) return { error: 'not a directory', status: 400 };
    const dirents = await fs.readdir(real, { withFileTypes: true });
    // withFileTypes uses lstat semantics: d.isFile() is false for symlinks, so symlinks are
    // intentionally NOT listed (security property). Every regular file is listed now (not just
    // docs); the extension decides whether it opens in-app as a doc ('doc'), an image viewer
    // ('image'), or can only be downloaded ('file').
    const dirEntries = [];
    const fileDirents = [];
    for (const d of dirents) {
      if (d.isDirectory()) dirEntries.push({ name: d.name, type: 'dir' });
      else if (d.isFile()) fileDirents.push(d);
    }
    // stat every file IN PARALLEL — a big dir is thousands of files, and one awaited stat each
    // (serial) is what made listing hang for seconds. Promise.all lets the OS pipeline them.
    const fileEntries = await Promise.all(fileDirents.map(async (d) => {
      const type = docTypeFor(d.name) ? 'doc' : imageTypeFor(d.name) ? 'image' : 'file';
      let size = 0;
      try { size = (await fs.stat(join(real, d.name))).size; } catch { /* gone mid-list → size 0 */ }
      return { name: d.name, type, size };
    }));
    const entries = [...dirEntries, ...fileEntries];
    // dirs first; files (doc+file) interleaved alphabetically
    entries.sort((a, b) =>
      (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
    // "up" stops at whichever allowed root we're in (each root is a ceiling), not only at home.
    const parent = roots.includes(real) ? null : join(real, '..');
    return { path: real, home: rh, roots, parent, entries };
  }

  // Resolve a path for DOWNLOAD: any regular file under home, no extension white-list (unlike
  // readDoc). Same realpath+isUnder boundary; symlinks escaping home resolve outside → rejected.
  async function statForDownload(rawPath) {
    if (typeof rawPath !== 'string' || rawPath[0] !== '/') return { error: 'not absolute', status: 400 };
    let real;
    try { real = await fs.realpath(rawPath); }
    catch { return { error: 'not found', status: 404 }; }
    if (!rootOf(real, await rootsP)) return { error: 'outside home', status: 400 };
    let st;
    try { st = await fs.stat(real); }
    catch { return { error: 'not accessible', status: 404 }; }
    if (!st.isFile()) return { error: 'not a file', status: 400 };
    if (st.size > maxDownloadBytes) return { error: 'too large', status: 413 };
    return { real, name: basename(real), size: st.size, mtimeMs: st.mtimeMs };
  }

  // Resolve a path for UPLOAD TARGET: a directory under one of the allowed roots, not inside any
  // hidden directory (relative to its own root). The $HOME root itself is off-limits (don't litter
  // the home dir); an extra root like /tmp IS uploadable directly, since dropping files there is the
  // whole point. Same realpath boundary as the rest.
  async function resolveUploadDir(rawDir) {
    if (typeof rawDir !== 'string' || rawDir[0] !== '/') return { error: 'not absolute', status: 400 };
    const rh = await realHomeP;
    let real;
    try { real = await fs.realpath(rawDir); }
    catch { return { error: 'not found', status: 404 }; }
    const root = rootOf(real, await rootsP);
    if (!root) return { error: 'outside home', status: 400 };
    if (real === rh) return { error: 'home root not allowed', status: 400 };
    if (hasHiddenSegment(real, root)) return { error: 'hidden directory not allowed', status: 400 };
    let st;
    try { st = await fs.stat(real); }
    catch { return { error: 'not accessible', status: 404 }; }
    if (!st.isDirectory()) return { error: 'not a directory', status: 400 };
    return { real };
  }

  // Resolve the STASH upload target: a per-project folder under ~/.handmux/uploads, created on
  // demand. Deliberately OUTSIDE the user's project trees (so uploads can never be `git add`-ed by
  // accident) yet still under $HOME, so the absolute path the chat box pastes stays readable by an
  // agent running anywhere. Mirrors Claude Code's per-project layout: the caller's cwd is flattened
  // ('/'→'-') into a single path segment (see encodeCwdKey), so each working directory gets its own
  // space; an unknown cwd falls into `_default`. Returns the realpath'd dir.
  async function resolveStashDir(rawCwd) {
    const rh = await realHomeP;
    const target = join(rh, '.handmux', 'uploads', encodeCwdKey(rawCwd));
    try { await fs.mkdir(target, { recursive: true }); }
    catch { return { error: 'mkdir failed', status: 500 }; }
    let real;
    try { real = await fs.realpath(target); }       // re-resolve in case a segment is a symlink
    catch { return { error: 'not accessible', status: 404 }; }
    if (!isUnder(real, rh)) return { error: 'outside home', status: 400 };
    return { real };
  }

  // Resolve a path for use as a NEW session/window CWD: any directory under home (home root IS
  // allowed, and hidden dirs ARE allowed — the browser can navigate into them). Same realpath +
  // isUnder boundary as the rest; symlinks escaping home resolve outside → rejected.
  async function resolveCwd(rawDir) {
    if (typeof rawDir !== 'string' || rawDir[0] !== '/') return { error: 'not absolute', status: 400 };
    const rh = await realHomeP;
    let real;
    try { real = await fs.realpath(rawDir); }
    catch { return { error: 'not found', status: 404 }; }
    if (!isUnder(real, rh)) return { error: 'outside home', status: 400 };
    let st;
    try { st = await fs.stat(real); }
    catch { return { error: 'not accessible', status: 404 }; }
    if (!st.isDirectory()) return { error: 'not a directory', status: 400 };
    return { real };
  }

  // Resolve a directory for BROWSE-side ops (the mkdir target): a directory under ANY allowed root
  // (the root itself + hidden dirs allowed, like resolveCwd but multi-root). resolveCwd stays
  // home-only — a new session's cwd should never land in a temp root by accident.
  async function resolveBrowseDir(rawDir) {
    if (typeof rawDir !== 'string' || rawDir[0] !== '/') return { error: 'not absolute', status: 400 };
    let real;
    try { real = await fs.realpath(rawDir); }
    catch { return { error: 'not found', status: 404 }; }
    if (!rootOf(real, await rootsP)) return { error: 'outside home', status: 400 };
    let st;
    try { st = await fs.stat(real); }
    catch { return { error: 'not accessible', status: 404 }; }
    if (!st.isDirectory()) return { error: 'not a directory', status: 400 };
    return { real };
  }

  // Create a new directory `name` inside `parentRaw`. The parent must be a directory under one of
  // the allowed roots (root + hidden dirs allowed). `name` must be a single safe path segment.
  async function makeDir(parentRaw, name) {
    const nm = typeof name === 'string' ? name.trim() : '';
    if (!nm || nm === '.' || nm === '..' || nm.includes('/') || nm.includes('\\') || nm.includes('\0')) {
      return { error: 'bad name', status: 400 };
    }
    const parent = await resolveBrowseDir(parentRaw); // realpath + under-a-root + isDirectory
    if (parent.error) return parent;
    const target = join(parent.real, nm);
    try {
      await fs.mkdir(target);
    } catch (e) {
      if (e.code === 'EEXIST') return { error: 'exists', status: 409 };
      return { error: 'mkdir failed', status: 500 };
    }
    return { real: target };
  }

  return { readDoc, listDir, statForDownload, resolveUploadDir, resolveStashDir, resolveCwd, makeDir };
}

// The extra (outside-$HOME) roots the file browser may reach: the system temp dir and, if set, the
// per-user $TMPDIR (on macOS that's /var/folders/.../T). Missing ones are skipped at resolve time.
export function defaultExtraRoots(env = process.env) {
  const roots = ['/tmp'];
  if (env.TMPDIR) roots.push(env.TMPDIR);
  return roots;
}

export const defaultDocs = createDocs({ home: homedir(), extraRoots: defaultExtraRoots() });
