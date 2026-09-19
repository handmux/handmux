// Shared Markdown → HTML pipeline for BOTH the file preview (DocView) and assistant bubbles
// (ConversationEntry): strip frontmatter → marked → DOMPurify → one DOM pass. The DOM pass runs
// AFTER sanitization on purpose — everything it writes (data-handmux-src, classes, notes) is
// authored by us, so there is no injection surface, and it covers <img>s from BOTH markdown image
// syntax and raw inline HTML (a marked renderer hook would miss the latter).
//
// Inline images are the special part: <img> can never carry the Authorization header /api/download
// requires (and the token must not leak into a URL), so the render pass NEVER emits a usable local
// src. In doc mode (baseDir set) local images become <img data-handmux-src="<abs path>"> placeholders
// that useMarkdownImages fills with an authenticated blob URL. In bubble mode images are stripped
// entirely (terminal agents don't inline local images) — alt text survives, nothing else.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { findOutputLinks } from './docDecorations.js';
import { isAbsolute, joinPath } from './docPath.js';
import { applyFootnotes, stripFootnoteDefs } from './docFootnotes.js';
import { prepareMermaid } from './docMermaid.js';
import { t } from './i18n';

export interface ConversationOutputLink {
  kind: 'url' | 'doc';
  path?: string;
  /** Doc links: `file.md#heading` — the heading to jump to after opening. */
  anchor?: string;
  protocol?: 'http' | 'https';
  port?: number;
  urlPath?: string;
  raw?: string;
}

export function outputLinkFromAnchor(anchor: HTMLAnchorElement): ConversationOutputLink | null {
  const explicitKind = anchor.dataset.handmuxOutputLink;
  const raw = anchor.dataset.handmuxOutputValue || anchor.getAttribute('href') || '';
  const links = findOutputLinks(raw);
  const match = explicitKind ? links.find((link) => link.kind === explicitKind) : links[0];
  if (!match) return null;
  if (match.kind === 'url') {
    return {
      kind: 'url', protocol: match.protocol, port: match.port,
      urlPath: match.urlPath, raw: match.raw,
    };
  }
  const path = match.path || raw.slice(match.start, match.end);
  const decoded = (() => {
    try { return decodeURIComponent(path); } catch { return path; }
  })();
  if (explicitKind) return { kind: 'doc', path, ...(match.anchor ? { anchor: match.anchor } : {}) };
  return { kind: 'doc', path: decoded, ...(match.anchor ? { anchor: match.anchor } : {}) };
}

// Strip a YAML frontmatter block (opening `---` line … closing `---` or `...` line). Line-based on
// purpose: a lazy multiline regex can run past an invalid closer and swallow real document content.
// No valid closer → not frontmatter → source returned untouched.
function stripFrontmatter(source: string): string {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return source;
  const lines = source.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/\r$/, '');
    if (line === '---' || line === '...') return lines.slice(i + 1).join('\n');
  }
  return source;
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// Turn a Markdown image destination into a REAL filesystem path. marked percent-encodes destinations:
// `assets/图片示例.png` (and the `<assets/图 片.png>` / `assets/%E5%9B%BE...png` spellings) arrive as
// `assets/%E5%9B%BE%E7%89%87%E7%A4%BA%E4%BE%8B.png`. Handing that to fetchImageUrl unchanged
// double-encodes it (`%` → `%25`) and the server looks for a file whose name literally contains `%E5%9B%BE…`.
//
// Order matters: `#`/`?` are stripped FIRST (they are URL syntax), and that is safe for a filename that
// genuinely contains them — those are spelled `%23`/`%3F` and survive the split. Only then decode, once.
// A malformed escape (`100%.png`) falls back to the raw text rather than throwing mid-render.
function decodeImagePath(raw: string): string {
  const clean = raw.split(/[?#]/)[0] ?? '';
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
}

function keepAltTextOnly(img: Element): void {
  const alt = img.getAttribute('alt') || '';
  if (alt) img.replaceWith(document.createTextNode(alt));
  else img.remove();
}

function noteInstead(img: Element, reason: string): void {
  const alt = img.getAttribute('alt') || '';
  const note = document.createElement('span');
  note.className = 'md-img-note';
  note.setAttribute('data-tts-skip', ''); // interface chrome — never read aloud
  note.textContent = alt ? `${alt} — ${reason}` : reason;
  img.replaceWith(note);
}

// Wide tables scroll sideways, but nothing said so. Wrapping each table in its own scroll box lets the
// CSS fade the edge that still has content beyond it — pure CSS, position-aware, no scroll listeners:
// the page-coloured layers are `background-attachment: local` (they move with the content) and cover the
// shadow layers (`scroll`, pinned to the box) exactly while the table is scrolled to that edge.
function wrapTables(root: HTMLElement): void {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const parent = table.parentElement;
    if (!parent || parent.classList.contains('md-table-scroll')) continue;
    const box = document.createElement('div');
    box.className = 'md-table-scroll';
    parent.insertBefore(box, table);
    box.appendChild(table);
  }
}

function rewriteImages(root: HTMLElement, baseDir: string | null): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const raw = img.getAttribute('src') || '';
    if (!baseDir) { keepAltTextOnly(img); continue; }             // bubble mode: no images
    if (!raw) { keepAltTextOnly(img); continue; }                 // DOMPurify dropped the URI
    if (/^https:\/\//i.test(raw)) continue;                       // direct load is fine
    if (/^http:\/\//i.test(raw)) {
      // On an https site the browser silently blocks http images (mixed content) — say so instead
      // of showing a broken image. A plain-http page (LAN direct connect) loads them fine.
      if (typeof location !== 'undefined' && location.protocol === 'https:') {
        noteInstead(img, t('doc.imageInsecure'));
      }
      continue;
    }
    if (raw.startsWith('//') || SCHEME_RE.test(raw)) { keepAltTextOnly(img); continue; }
    // Local image (relative to the doc, absolute, or ~/): hand the ABSOLUTE path to the loader.
    const clean = decodeImagePath(raw);
    const abs = (isAbsolute(clean) ? clean : joinPath(baseDir, clean)).replace(/\/+$/, '');
    img.removeAttribute('src');
    img.setAttribute('data-handmux-src', abs);
    // No loading class here: the loader adds it only when it actually has to fetch, so a cached or
    // 304 image never flashes a placeholder first.
  }
}

// Wrap bare URLs and doc paths (terminal output artifacts) in tappable anchors — assistant-bubble
// mode only. Anchors that marked already produced but that don't resolve to a known output link are
// unwrapped so only real targets stay tappable.
function linkify(root: HTMLElement): void {
  for (const anchor of Array.from(root.querySelectorAll('a'))) {
    if (!outputLinkFromAnchor(anchor)) anchor.replaceWith(...Array.from(anchor.childNodes));
  }
  const walker = document.createTreeWalker(root, 4);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest('a')) continue;
    const links = findOutputLinks(node.data);
    if (!links.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const link of links) {
      fragment.append(node.data.slice(offset, link.start));
      const anchor = document.createElement('a');
      const value = (link.kind === 'url' ? link.raw : link.path) ?? '';
      anchor.href = value;
      anchor.dataset.handmuxOutputLink = link.kind;
      anchor.dataset.handmuxOutputValue = value;
      anchor.textContent = node.data.slice(link.start, link.end);
      fragment.append(anchor);
      offset = link.end;
    }
    fragment.append(node.data.slice(offset));
    node.replaceWith(fragment);
  }
}

export interface RenderMarkdownOptions {
  /** Directory of the markdown FILE — resolves relative image srcs and switches on the
   *  authenticated inline-image pipeline. Omit for bubble mode (images stripped). */
  baseDir?: string | null;
  /** Wrap bare URLs / doc paths in tap anchors (assistant bubbles). */
  links?: boolean;
}

export function renderMarkdown(source: string, options: RenderMarkdownOptions = {}): string {
  const root = document.createElement('div');
  // Footnote definitions are lifted BEFORE parsing: left in place, marked renders `[^1]` as a link to
  // the definition text and swallows the definition line (see docFootnotes.ts).
  const { source: body, notes } = stripFootnoteDefs(stripFrontmatter(source || ''));
  root.innerHTML = DOMPurify.sanitize(marked.parse(body, { async: false }) as string);
  applyFootnotes(root, notes);
  wrapTables(root);
  if (options.baseDir) prepareMermaid(root); // doc mode only: a chat bubble renders no diagrams
  rewriteImages(root, options.baseDir ?? null);
  if (options.links) linkify(root);
  return root.innerHTML;
}
