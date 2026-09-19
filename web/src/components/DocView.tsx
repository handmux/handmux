// web/src/components/DocView.jsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { getDocFontIndex, setDocFontIndex, DOC_FONT_SIZES } from '../storage.js';
import { markSentences } from '../voice/docSpeech.js';
import { useDocSpeech } from '../voice/useDocSpeech.js';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock.js';
import { useMarkdownImages } from '../hooks/useMarkdownImages.js';
import { useDocCodeCopy } from '../hooks/useDocCodeCopy.js';
import { useDocScrollMemory } from '../hooks/useDocScrollMemory.js';
import { useBackButton } from '../hooks/useBackButton.js';
import { copyText } from '../clipboard.js';
import { renderMarkdown } from '../markdown.js';
import { clearFind, focusMatch, runFind } from '../docFind.js';
import { installHeadingFolding } from '../docFolding.js';
import { useKeyboardInset } from '../hooks/useKeyboardInset.js';
import {
  CheckIcon, CopyIcon, MoreHorizontalIcon, PauseIcon, PlayIcon, RefreshIcon, SearchIcon, StopIcon, TocIcon,
} from './icons.jsx';
import ImageViewer from './ImageViewer.jsx';
import DocToc from './DocToc.jsx';
import type { DocTocItem } from './DocToc.jsx';
import { t, getLangCode } from '../i18n';
import type { MouseEvent as ReactMouseEvent } from 'react';

export interface DocViewProps {
  type: string;
  name: string;
  /** Absolute path of the doc file — resolves relative image srcs inside markdown. */
  path?: string | null;
  content?: string | null;
  /** File info for the 更多 popover (from /api/file). */
  size?: number | null;
  mtimeMs?: number | null;
  birthtimeMs?: number | null;
  /** Re-read the file from disk. Resolves when the refresh has settled, so the viewer can hold the
   *  loading state for the whole round-trip. */
  onReload?: () => void | Promise<void>;
  /** The file's bytes are still on their way (the tab is open, content not here yet). */
  loading?: boolean;
  /** Open a tapped http(s) link in the app's built-in browser instead of leaving the page. */
  onOpenUrl?: (url: string, point: { x: number; y: number }) => void;
  /** A `file.md#heading` open request (terminal/chat link): jump to that heading once rendered. */
  anchorRequest?: { anchor: string; at: number } | null;
}

// Shown while the file's bytes are on their way — for a fresh open AND for a reload. One component so
// both paths look identical, and a plain CSS spinner (no dependency, no JS animation loop).
function DocLoading({ name }: { name: string }) {
  return (
    <div className="doc-loading" role="status" aria-live="polite">
      <span className="doc-loading-spinner" aria-hidden="true" />
      <span className="doc-loading-text">{t('common.loading')}</span>
      {name ? <span className="doc-loading-name">{name}</span> : null}
    </div>
  );
}

const collectSentences = markSentences;
const rawFontSizes: unknown = DOC_FONT_SIZES;
const FONT_SIZES: readonly number[] = Array.isArray(rawFontSizes)
  && rawFontSizes.length > 0
  && rawFontSizes.every((value) => typeof value === 'number' && Number.isFinite(value))
  ? rawFontSizes
  : [10, 11, 12, 13, 14, 16, 18, 20, 22];
const LAST = FONT_SIZES.length - 1;
// Our own smooth scrollIntoView fires scroll events too; ignore them for this long so following
// doesn't switch itself off the instant it scrolls.
const FOLLOW_SCROLL_GUARD_MS = 800;
// How far below the container's top edge a jump target lands — clears the pinned toolbar, and keeps a
// find match in the upper half where the soft keyboard cannot cover it.
const TOC_TOP_OFFSET = 62;
const FIND_TOP_OFFSET = 70;
// A reload must be perceptible even when the file is unchanged and the fetch is instant.
const MIN_RELOAD_MS = 260;

const readFontIndex = (): number => {
  const value: unknown = getDocFontIndex();
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= LAST
    ? value
    : Math.min(4, LAST);
};

// A malformed percent sequence in a link fragment (`#100%`) makes decodeURIComponent throw; an uncaught
// throw in an effect/render unmounts the entire app, so decode leniently.
const safeDecode = (value: string): string => {
  try { return decodeURIComponent(value); } catch { return value; }
};

const dirnameOf = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
};

// File-info popover formatting. Times use the active UI locale (the app is bilingual/multi-locale).
const formatBytes = (bytes: number | null | undefined): string => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

const formatStamp = (ms: number | null | undefined): string => {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  return new Intl.DateTimeFormat(getLangCode(), { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(ms));
};

// Word count for a mixed CJK/Latin document: CJK ideographs count one each, runs of Latin/digits count
// as one word. Character count is the raw length without whitespace.
const countWords = (text: string): number => {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
  const latin = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
    .match(/[A-Za-z0-9_'’-]+/g)?.length ?? 0;
  return cjk + latin;
};

// Heading anchors: a stable slug from the heading text, so in-document links ([见第 2 节](#第-2-节))
// resolve — the same slug the 目录 drawer uses for its jump targets. Duplicates get a numeric suffix.
const slugifyHeading = (text: string): string => (
  text.trim().toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/^-+|-+$/g, '')
) || 'section';

// Render one doc behind the bar it always had: 开始/暂停 · 停止 · 倍速 on the left, A−/A+ pinned right.
// markdown → shared pipeline (markdown.ts) → injected HTML; single-file html → sandboxed iframe
// (allow-scripts, NOT allow-same-origin, so report JS can't reach our token or the parent page);
// everything else → verbatim <pre>. `content` is already fetched (the tab carries it).
//
// Read-aloud (TTS) speaks one sentence at a time (see useDocSpeech) and the sentence spans laid down by
// docSpeech.markSentences make every position addressable: tapping a sentence reads on from there —
// that gesture is the only "jump" control, so the bar needs no progress or skip buttons. Following
// keeps the spoken sentence in view until the reader scrolls away, then a pill offers to come back.
export default function DocView({
  type, name, path = null, content = '', size = null, mtimeMs = null, birthtimeMs = null,
  onReload, onOpenUrl, anchorRequest = null, loading = false,
}: DocViewProps) {
  const [fontIdx, setFontIdx] = useState<number>(readFontIndex);
  const [followPaused, setFollowPaused] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [toc, setToc] = useState<DocTocItem[]>([]);
  const [sourceCopied, setSourceCopied] = useState(false);
  const sourceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [matchIndex, setMatchIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const keyboardInset = useKeyboardInset();
  const [copied, setCopied] = useState(false);
  const [readNotice, setReadNotice] = useState<string | null>(null);
  const [anchorNotice, setAnchorNotice] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [showTop, setShowTop] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const mdRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLPreElement | null>(null);
  const infoRef = useRef<HTMLDivElement | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollGuardUntil = useRef(0); // timestamp until which scroll events are treated as our own
  const speech = useDocSpeech();

  // Scroll ONE element inside OUR scroll container, by hand.
  //
  // `el.scrollIntoView(...)` also scrolls every scrollable ancestor — including the page — which on iOS
  // pans the `position: fixed` file sheet (and therefore this pinned toolbar, search row and all) out of
  // the visual viewport, so the top of the panel disappears. Computed here instead so only
  // `.doc-md-wrap` moves; `topOffset` places the target that many px below the container's top edge.
  // The search root is whichever container holds the document text — markdown or the verbatim <pre>.
  const findRoot = (): HTMLElement | null => mdRef.current ?? textRef.current;

  const scrollToElement = (el: Element | null | undefined, topOffset: number, smooth = true): void => {
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    const top = el.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop - topOffset;
    const next = Math.max(0, top);
    scrollGuardUntil.current = Date.now() + FOLLOW_SCROLL_GUARD_MS;
    wrap.scrollTo({ top: next, behavior: smooth ? 'smooth' : 'auto' });
  };
  useScreenWakeLock(speech.playing && !speech.paused); // screen sleep kills TTS — hold it awake while reading

  const html = useMemo(
    () => (type === 'markdown'
      ? renderMarkdown(content || '', { baseDir: path ? dirnameOf(path) : null })
      : ''),
    [type, content, path],
  );
  // Authenticated inline images: placeholders → blob URLs; tap → fullscreen viewer.
  const [imageView, closeImageView] = useMarkdownImages(mdRef, html, type === 'markdown');
  // One-tap copy on every code block (markdown and plain-text docs alike).
  useDocCodeCopy(mdRef, html, type === 'markdown');
  // Body folding: heading carets collapse that heading's content (doc mode only — a chat bubble has
  // no sections to fold). Re-installed whenever the rendered document changes.
  useEffect(() => {
    const root = mdRef.current;
    if (!root || type !== 'markdown') return undefined;
    return installHeadingFolding(root);
  }, [html, type]);
  // Return the reader to where they left off in THIS document.
  useDocScrollMemory(path, wrapRef, html);
  useBackButton(!!imageView, closeImageView);
  useBackButton(infoOpen, () => setInfoOpen(false));
  useBackButton(tocOpen, () => setTocOpen(false));
  useBackButton(findOpen, () => closeFind());

  // Outline for the 目录 drawer, and the anchor targets for in-document links. Heading ids are assigned
  // here (the rendered HTML carries none) from the heading TEXT, so `[见第 2 节](#第-2-节)` resolves to
  // the same node the drawer jumps to; duplicates get a -1/-2 suffix.
  useEffect(() => {
    const root = mdRef.current;
    if (!root) { setToc([]); return; }
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));
    const items: DocTocItem[] = [];
    const used = new Set<string>();
    headings.forEach((heading) => {
      const label = (heading.textContent || '').trim();
      if (!label) return;
      const base = slugifyHeading(label);
      let id = base;
      let suffix = 1;
      while (used.has(id)) { id = `${base}-${suffix}`; suffix += 1; }
      used.add(id);
      heading.id = id;
      items.push({ id, level: Number(heading.tagName.slice(1)) || 1, text: label });
    });
    setToc(items);
  }, [html]);

  // The 更多 popover closes on a tap anywhere outside it (capture phase, so it beats other handlers —
  // same mechanics as Dropdown), on Back, or on the ✕.
  useEffect(() => {
    if (!infoOpen) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !infoRef.current?.contains(event.target)) setInfoOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [infoOpen]);

  useEffect(() => () => {
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    if (sourceTimer.current !== null) clearTimeout(sourceTimer.current);
  }, []);

  // Content swapped (different doc) → stop any in-flight reading (React rebuilds innerHTML, so the
  // old sentence spans are gone anyway).
  useEffect(() => { speech.stop(); }, [html]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lay the sentence marks down as soon as a readable doc is on screen — they are what makes
  // "tap a sentence to read from there" work. Idle-scheduled: wrapping is O(document) DOM surgery and
  // must not delay first paint.
  useEffect(() => {
    if (type !== 'markdown' || !speech.supported) return undefined;
    const id = setTimeout(() => { collectSentences(mdRef.current); }, 0);
    return () => clearTimeout(id);
  }, [html, type, speech.supported]);

  // Reflect the spoken sentence as a highlight and keep it in view — unless the reader scrolled away.
  useEffect(() => {
    const root = mdRef.current;
    if (!root) return;
    root.querySelectorAll('.tts-active').forEach((el) => el.classList.remove('tts-active'));
    if (speech.idx < 0) return;
    const els = root.querySelectorAll(`.tts-sent[data-tts="${speech.idx}"]`);
    els.forEach((el) => el.classList.add('tts-active'));
    if (followPaused) return;
    const wrap = wrapRef.current;
    scrollToElement(els[0], wrap ? Math.max(0, wrap.clientHeight / 2 - 20) : 0);
  }, [speech.idx, followPaused]);

  // Back-to-top appears once the reader is well into a long document. Independent of read-aloud: it is
  // about position, not playback, so it tracks the container at all times.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const update = (): void => { setShowTop(wrap.scrollTop > wrap.clientHeight * 1.5); };
    wrap.addEventListener('scroll', update, { passive: true });
    update();
    return () => wrap.removeEventListener('scroll', update);
  }, [html]);

  // A manual scroll means the reader is looking elsewhere: pause following and offer to come back.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !speech.playing) return undefined;
    const onScroll = (): void => {
      if (Date.now() < scrollGuardUntil.current) return; // our own scrollIntoView
      setFollowPaused(true);
    };
    wrap.addEventListener('scroll', onScroll, { passive: true });
    return () => wrap.removeEventListener('scroll', onScroll);
  }, [speech.playing]);

  // Re-scan on every keystroke (and when the document itself changes). Bounded by MAX_MATCHES inside
  // runFind, so a short query on a large file cannot wrap an unbounded number of nodes.
  useEffect(() => {
    if (!findOpen) return;
    const root = findRoot();
    const total = runFind(root, query);
    setMatchCount(total);
    const first = total ? 0 : -1;
    setMatchIndex(first);
    if (first >= 0) scrollToElement(focusMatch(root, first), FIND_TOP_OFFSET);
  }, [query, findOpen, html]); // eslint-disable-line react-hooks/exhaustive-deps

  // The row turns into a search field → put the caret in it.
  useEffect(() => {
    if (findOpen) searchRef.current?.focus();
  }, [findOpen]);

  // A tapped terminal/chat link can name a heading (`docs/notes.md#小节-a`): land on it once the
  // document is rendered AND the heading ids exist (they are assigned by the outline effect above), so
  // this depends on `toc` to re-run after that pass. The request object is new per tap, so tapping the
  // same link twice jumps twice, and it deliberately overrides the remembered reading position.
  useEffect(() => {
    if (!anchorRequest || loading) return; // no content yet — the heading cannot exist
    const el = document.getElementById(safeDecode(anchorRequest.anchor));
    if (!el) {
      // A link that points nowhere must SAY so: silence looks like a broken feature.
      setAnchorNotice(t('doc.anchorMissing', { anchor: anchorRequest.anchor }));
      return;
    }
    setAnchorNotice(null);
    scrollToElement(el, TOC_TOP_OFFSET, false); // instant: this is the arrival position, not a follow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorRequest, toc, loading]);

  // Clicks inside the document, in priority order:
  //   1. a tapped link — `#anchor` jumps within the doc, http(s) opens in the built-in browser (leaving
  //      the page would throw away the reader's place), anything else is left to the browser;
  //   2. while read-aloud is running, a tapped sentence restarts the read from there. Tapping an idle
  //      document must stay a normal reading gesture (selection, scrolling), never a surprise start.
  const onMarkdownClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target instanceof Element ? event.target : null;

    const anchor = target?.closest<HTMLAnchorElement>('a[href]');
    if (anchor) {
      const href = anchor.getAttribute('href') || '';
      if (href.startsWith('#')) {
        event.preventDefault();
        const id = safeDecode(href.slice(1));
        if (id) scrollToElement(document.getElementById(id), TOC_TOP_OFFSET);
        return;
      }
      if (/^https?:\/\//i.test(href)) {
        if (!onOpenUrl) return; // no in-app browser available → let the platform handle it
        event.preventDefault();
        onOpenUrl(href, { x: event.clientX, y: event.clientY });
        return;
      }
      return;
    }

    if (!speech.supported || !speech.playing) return;
    const span = target?.closest<HTMLElement>('.tts-sent[data-tts]');
    if (!span) return;
    const index = Number(span.dataset.tts);
    if (!Number.isInteger(index)) return;
    const sentences = collectSentences(mdRef.current);
    if (!sentences.length) { setReadNotice(t('doc.nothingToRead')); return; }
    setReadNotice(null);
    setFollowPaused(false);
    speech.play(sentences, index);
  };

  const bump = (delta: number): void => {
    const next = Math.min(LAST, Math.max(0, fontIdx + delta));
    setFontIdx(next);
    setDocFontIndex(next);
  };

  const closeFind = (): void => {
    clearFind(findRoot());
    setFindOpen(false);
    setQuery('');
    setMatchCount(0);
    setMatchIndex(-1);
  };

  const stepMatch = (delta: number): void => {
    if (matchCount <= 0) return;
    const next = (matchIndex + delta + matchCount) % matchCount; // wraps both ways
    setMatchIndex(next);
    // Keep the match near the TOP of the visible area: with the soft keyboard up the lower half of the
    // screen is gone, so a centred match would sit behind it.
    scrollToElement(focusMatch(findRoot(), next), FIND_TOP_OFFSET);
  };

  const onPlayToggle = (): void => {
    if (speech.playing) { speech.paused ? speech.resume() : speech.pause(); return; }
    setFollowPaused(false); // a fresh read always follows
    const sentences = collectSentences(mdRef.current);
    // Nothing readable (an all-code document, or marking found no prose) must SAY so — a silent
    // return here is indistinguishable from a broken button.
    if (!sentences.length) { setReadNotice(t('doc.nothingToRead')); return; }
    setReadNotice(null);
    speech.play(sentences);
  };

  const reading = speech.playing && !speech.paused;
  const canRead = type === 'markdown' && speech.supported;
  const fullPath = path || name;

  // Reloading shows the SAME loading page a fresh open shows, for at least one visible beat: the
  // feedback IS the loading state (no toast), and an unchanged file must still look like it did
  // something. The popover closes so the loading page is what the user sees.
  const onReloadFromDisk = (): void => {
    setInfoOpen(false);
    setReloading(true);
    const minimum = new Promise((resolve) => setTimeout(resolve, MIN_RELOAD_MS));
    void Promise.all([Promise.resolve(onReload?.()), minimum])
      .then(() => setReloading(false))
      .catch(() => setReloading(false));
  };

  const onCopyPath = (): void => {
    void copyText(fullPath).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1600);
    });
  };

  // Copy the file's Markdown SOURCE (not the rendered text) — what you would paste into another agent
  // or editor.
  const onCopySource = (): void => {
    void copyText(content || '').then((ok) => {
      if (!ok) return;
      setSourceCopied(true);
      if (sourceTimer.current !== null) clearTimeout(sourceTimer.current);
      sourceTimer.current = setTimeout(() => setSourceCopied(false), 1600);
    });
  };

  // Every hook has run by now: the returns below are decided at render time. Nothing above may be an
  // early return — a `type` that changes after mount (the viewer paints a guessed type, then the
  // server's answer replaces it) would otherwise change the hook count and unmount the whole app.
  if (loading || reloading) {
    return <DocLoading name={name} />;
  }

  if (type === 'image') {
    return <ImageViewer url={content} name={name} />;
  }

  if (type === 'html') {
    return <iframe className="doc-iframe" sandbox="allow-scripts" srcDoc={content || ''} title={name} />;
  }

  return (
    <div className="doc-md-wrap" ref={wrapRef}
      style={findOpen && keyboardInset > 0 ? { paddingBottom: `${keyboardInset}px` } : undefined}>
      <div className="doc-toolbar">
        {findOpen ? (
          <div className="doc-find">
            <SearchIcon />
            <input ref={searchRef} className="doc-find-input" type="search" value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('doc.findPlaceholder')} aria-label={t('doc.find')}
              enterKeyHint="search" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
            <span className="doc-find-count" aria-live="polite">
              {matchCount ? `${matchIndex + 1}/${matchCount}` : (query ? t('doc.findNoMatch') : '')}
            </span>
            <button className="doc-zoom-btn doc-zoom-icon" onClick={() => stepMatch(-1)}
              disabled={!matchCount} aria-label={t('doc.findPrev')}>↑</button>
            <button className="doc-zoom-btn doc-zoom-icon" onClick={() => stepMatch(1)}
              disabled={!matchCount} aria-label={t('doc.findNext')}>↓</button>
            <button className="doc-zoom-btn doc-zoom-icon" onClick={closeFind}
              aria-label={t('common.close')}>✕</button>
          </div>
        ) : (
          <>
            {toc.length > 0 && (
              <button className="doc-zoom-btn doc-zoom-icon" onClick={() => setTocOpen(true)}
                aria-label={t('doc.toc')} aria-haspopup="dialog">
                <TocIcon />
              </button>
            )}
            {canRead && (
              <div className="doc-player">
                <button className="doc-zoom-btn doc-zoom-icon" onClick={onPlayToggle}
                  aria-label={reading ? t('doc.pauseRead') : speech.paused ? t('doc.resumeRead') : t('doc.read')}>
                  {reading ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button className="doc-zoom-btn doc-zoom-icon" onClick={speech.stop} disabled={!speech.playing}
                  aria-label={t('doc.stopRead')}><StopIcon /></button>
                <button className="doc-zoom-btn" onClick={speech.cycleRate}
                  aria-label={t('doc.rate')}>{speech.rate}×</button>
              </div>
            )}
            <div className="doc-fonts">
              <button className="doc-zoom-btn" onClick={() => bump(-1)} disabled={fontIdx <= 0}
                aria-label={t('doc.fontSmaller')}>A−</button>
              <button className="doc-zoom-btn" onClick={() => bump(1)} disabled={fontIdx >= LAST}
                aria-label={t('doc.fontLarger')}>A+</button>
            </div>
            <button className="doc-zoom-btn doc-zoom-icon" onClick={() => setFindOpen(true)}
              aria-label={t('doc.find')}><SearchIcon /></button>
            <div className="doc-info" ref={infoRef}>
              <button className="doc-zoom-btn doc-zoom-icon" onClick={() => setInfoOpen((open) => !open)}
                aria-label={t('doc.fileInfo')} aria-expanded={infoOpen} aria-haspopup="dialog">
                <MoreHorizontalIcon />
              </button>
              {infoOpen && (
                <div className="doc-info-pop" role="dialog" aria-label={t('doc.fileInfo')}>
                  <div className="doc-info-title">{t('doc.fileInfo')}</div>
                  <div className="doc-info-row">
                    <span className="doc-info-key">{t('doc.filePath')}</span>
                    <span className="doc-info-val doc-info-path">{fullPath}</span>
                    <button className="doc-info-copy" onClick={onCopyPath}
                      aria-label={copied ? t('common.copied') : t('doc.copyPath')}
                      title={t('doc.copyPath')}>
                      {copied ? <CheckIcon /> : <CopyIcon />}
                    </button>
                  </div>
                  <div className="doc-info-row">
                    <span className="doc-info-key">{t('doc.fileSize')}</span>
                    <span className="doc-info-val">{formatBytes(size)}</span>
                  </div>
                  <div className="doc-info-row">
                    <span className="doc-info-key">{t('doc.fileModified')}</span>
                    <span className="doc-info-val">{formatStamp(mtimeMs)}</span>
                  </div>
                  <div className="doc-info-row">
                    <span className="doc-info-key">{t('doc.fileCreated')}</span>
                    <span className="doc-info-val">{formatStamp(birthtimeMs)}</span>
                  </div>
                  <div className="doc-info-row">
                    <span className="doc-info-key">{t('doc.words')}</span>
                    <span className="doc-info-val">{countWords(content || '').toLocaleString(getLangCode())}</span>
                  </div>
                  <div className="doc-info-row">
                    <span className="doc-info-key">{t('doc.chars')}</span>
                    <span className="doc-info-val">
                      {(content || '').replace(/\s+/g, '').length.toLocaleString(getLangCode())}
                    </span>
                  </div>
                  <div className="doc-info-actions">
                    {onReload && (
                      <button className="doc-info-action" onClick={onReloadFromDisk}>
                        <RefreshIcon />{t('doc.reload')}
                      </button>
                    )}
                    <button className="doc-info-action" onClick={onCopySource}>
                      {sourceCopied ? <CheckIcon /> : <CopyIcon />}
                      {sourceCopied ? t('common.copied') : t('doc.copySource')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {anchorNotice && <div className="doc-info-note" role="status">{anchorNotice}</div>}

      {(speech.failure || readNotice) && (
        <div className="doc-speak-error" role="status">
          {speech.failure ? `${t('doc.speakFailed')} (${speech.failure})` : readNotice}
        </div>
      )}

      {type === 'text' ? (
        <pre ref={textRef} className="doc-text" style={{ fontSize: `${FONT_SIZES[fontIdx]}px` }}>{content || ''}</pre>
      ) : (
        <div ref={mdRef} className="doc-md" style={{ fontSize: `${FONT_SIZES[fontIdx]}px` }}
          onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: html }} />
      )}

      {/* Pinned to the bottom of the reading area; only while reading and only after a manual scroll. */}
      {speech.playing && followPaused && (
        <div className="doc-follow-anchor">
          <button className="doc-follow-pill" onClick={() => setFollowPaused(false)}>
            {t('doc.backToReading')}
          </button>
        </div>
      )}

      {showTop && !loading && (
        <button className="doc-top-btn" aria-label={t('doc.backToTop')} title={t('doc.backToTop')}
          onClick={() => {
            const wrap = wrapRef.current;
            if (!wrap) return;
            scrollGuardUntil.current = Date.now() + FOLLOW_SCROLL_GUARD_MS;
            wrap.scrollTo({ top: 0, behavior: 'smooth' });
          }}>↑</button>
      )}

      {imageView && (
        <div className="md-img-viewer">
          <button className="md-img-viewer-close" onClick={closeImageView} aria-label={t('common.close')}>✕</button>
          <ImageViewer url={imageView.url} name={imageView.name} />
        </div>
      )}

      <DocToc open={tocOpen} items={toc} onClose={() => setTocOpen(false)}
        onSelect={(id) => { scrollToElement(document.getElementById(id), TOC_TOP_OFFSET); }} />
    </div>
  );
}