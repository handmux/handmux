// Delimiters that bound a path token: whitespace, quotes, brackets/parens/angles, ASCII prose
// separators (, ;) AND full-width CJK punctuation — CC output is often Chinese, where a path like
// `口播稿-纯配音版.md，` is wrapped in full-width colons/commas that the ASCII-only set missed.
// Also included, because they cling to real terminal paths but never appear inside one:
//   `*` — markdown emphasis/bullets (`*note.md`, `**foo.md**`);
//   `…` — Claude Code's own truncation ellipsis (`… overview.md…`);
//   `:` — a label/line-number separator with no space (`参考:docs/plan.md`, `file.md:12`);
//   `│` — box-drawing border, so a path never fuses across a framed panel's `│ … │` padding.
export const DELIMS = "\\s'\"`()\\[\\]<>,;，。、；：！？（）【】《》「」“”‘’*…:│";
// Rich-rendered document extensions and inline-image extensions. The server content-checks every other
// filename as plain text, so these lists choose presentation only; they no longer gate whether a path
// is tappable. They still mirror the server's rich/image classifiers.
export const DOC_LINK_EXTS = ['md', 'markdown', 'html', 'htm', 'txt', 'log', 'sh'];
export const IMAGE_LINK_EXTS = ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'apng'];
const FILE_TOKEN_RE = new RegExp(`[^${DELIMS}]+`, 'g');
const RESERVED_BARE_EXT = new Set([...DOC_LINK_EXTS, ...IMAGE_LINK_EXTS].map((ext) => `.${ext}`));
const EXTENSIONLESS_NAMES = /^(?:readme|license|makefile|dockerfile|gemfile|rakefile|procfile|notice)$/i;
// A bare `name.ext` has no path syntax to distinguish it from prose joined by a period. Keep the
// automatic case conservative; arbitrary extensions remain available when the token carries explicit
// path evidence (`dir/file.unknown`, `./file.unknown`, `/...`).
const BARE_FILE_EXTS = new Set([
  ...DOC_LINK_EXTS, ...IMAGE_LINK_EXTS,
  'mdx', 'rst', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml',
  'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp',
  'cs', 'swift', 'php', 'sql', 'graphql', 'gql', 'proto', 'properties', 'gradle', 'lock',
]);

export interface DocumentPathLink {
  start: number;
  end: number;
  path: string;
}

function looksLikeFilePath(value: string): boolean {
  if (!value || value === '.' || value === '..') return false;
  if (value.endsWith('/')) return false; // directory path, not a previewable file
  if (RESERVED_BARE_EXT.has(value.toLowerCase())) return false;
  if (/^v?\d+(?:\.\d+)+$/i.test(value)) return false; // versions/IP-like numbers are prose, not paths
  if (value.includes('@') && !value.includes('/')) return false; // bare email address
  // A slash alone is not enough evidence: ordinary prose is full of alternatives such as
  // `start/stop`, `iOS/Android`, `设置/清除` and slash commands such as `/goal`. Extensionless paths must
  // identify themselves with an explicit relative prefix or an absolute path that has a directory segment;
  // ordinary relative paths still qualify when their leaf looks like a file.
  if (/^(?:\.\.?\/|~\/)/.test(value)) return true;
  if (value.includes('/')) {
    const leaf = value.slice(value.lastIndexOf('/') + 1);
    return (value.startsWith('/') && value.indexOf('/', 1) >= 0)
      || /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(leaf)
      || EXTENSIONLESS_NAMES.test(leaf)
      || /^[^.][^/]*\.[^.]+$/.test(leaf);
  }
  if (/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return true; // dotfiles such as .env
  if (EXTENSIONLESS_NAMES.test(value)) return true;
  const extension = /\.([A-Za-z0-9]+)$/.exec(value)?.[1]?.toLowerCase();
  return extension !== undefined && BARE_FILE_EXTS.has(extension);
}

// Find every doc-path link in one line of text → [{ start, end, path }] (end exclusive).
export function findDocLinks(line: string): DocumentPathLink[] {
  const out: DocumentPathLink[] = [];
  if (!line) return out;
  FILE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_TOKEN_RE.exec(line)) !== null) {
    let start = m.index;
    let path = m[0].replace(/\.+$/, ''); // sentence-ending dots cling to terminal output
    const assignment = path.lastIndexOf('=');
    if (assignment >= 0) { start += assignment + 1; path = path.slice(assignment + 1); }
    // Strip a leading `@` (Claude Code's `@file` mention prefix) but ONLY at the head, so an internal
    // `@` in a genuine path (`node_modules/@types/x.md`) is kept — `@` can't be a plain delimiter.
    const lead = /^@+/.exec(path);
    if (lead) { start += lead[0].length; path = path.slice(lead[0].length); }
    if (!looksLikeFilePath(path)) continue;
    out.push({ start, end: start + path.length, path });
  }
  return out;
}

export const isAbsolute = (path: unknown): path is string => (
  typeof path === 'string' && (path.startsWith('/') || path === '~' || path.startsWith('~/'))
);

// Pure posix join + normalize (resolves '.' and '..'). An absolute `rel` ignores `base`.
export function joinPath(base: string, rel: string): string {
  const raw = isAbsolute(rel) ? rel : `${base.replace(/\/+$/, '')}/${rel}`;
  const abs = raw.startsWith('/');
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/');
}
