// Delimiters that bound a path token: whitespace, quotes, brackets/parens/angles, ASCII prose
// separators (, ;) AND full-width CJK punctuation — CC output is often Chinese, where a path like
// `口播稿-纯配音版.md，` is wrapped in full-width colons/commas that the ASCII-only set missed.
// Also included, because they cling to real terminal paths but never appear inside one:
//   `*` — markdown emphasis/bullets (`*note.md`, `**foo.md**`);
//   `…` — Claude Code's own truncation ellipsis (`… overview.md…`);
//   `:` — a label/line-number separator with no space (`参考:docs/plan.md`, `file.md:12`);
//   `│` — box-drawing border, so a path never fuses across a framed panel's `│ … │` padding.
const DELIMS = "\\s'\"`()\\[\\]<>,;，。、；：！？（）【】《》「」“”‘’*…:│";
// Openable extensions: in-app docs (md/html) AND images the viewer shows inline (the same set as the
// server's imageTypeFor). A terminal path ending in any of these is a tappable link; onOpenDoc routes
// it to the doc reader or the image viewer by extension.
const LINK_EXT = 'md|markdown|html|htm|txt|log|sh|png|jpg|jpeg|jfif|gif|webp|svg|bmp|ico|avif|apng';
// Match a path token (≥1 non-delimiter char) ending in an openable extension; the lookahead pins the
// extension to a boundary (a delimiter, end-of-line, or a trailing `.`) so `foo.png.` yields `foo.png`
// and `archive.mdx` matches nothing.
const DOC_LINK_RE = new RegExp(`[^${DELIMS}]+\\.(?:${LINK_EXT})(?=$|[${DELIMS}.])`, 'gi');

// Find every doc-path link in one line of text → [{ start, end, path }] (end exclusive).
export function findDocLinks(line) {
  const out = [];
  if (!line) return out;
  DOC_LINK_RE.lastIndex = 0;
  let m;
  while ((m = DOC_LINK_RE.exec(line)) !== null) {
    let start = m.index;
    let path = m[0];
    // Strip a leading `@` (Claude Code's `@file` mention prefix) but ONLY at the head, so an internal
    // `@` in a genuine path (`node_modules/@types/x.md`) is kept — `@` can't be a plain delimiter.
    const lead = /^@+/.exec(path);
    if (lead) { start += lead[0].length; path = path.slice(lead[0].length); }
    if (!path) continue;
    out.push({ start, end: start + path.length, path });
  }
  return out;
}

export const isAbsolute = (p) => typeof p === 'string' && p.startsWith('/');

// Pure posix join + normalize (resolves '.' and '..'). An absolute `rel` ignores `base`.
export function joinPath(base, rel) {
  const raw = isAbsolute(rel) ? rel : `${base.replace(/\/+$/, '')}/${rel}`;
  const abs = raw.startsWith('/');
  const out = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/');
}
