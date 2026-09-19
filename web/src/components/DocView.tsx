// web/src/components/DocView.jsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { getDocFontIndex, setDocFontIndex, DOC_FONT_SIZES } from '../storage.js';
import { markSentences } from '../voice/docSpeech.js';
import { useDocSpeech } from '../voice/useDocSpeech.js';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock.js';
import { useMarkdownImages } from '../hooks/useMarkdownImages.js';
import { useBackButton } from '../hooks/useBackButton.js';
import { copyText } from '../clipboard.js';
import { renderMarkdown } from '../markdown.js';
import { clearFind, focusMatch, runFind } from '../docFind.js';
import { useKeyboardInset } from '../hooks/useKeyboardInset.js';
import {
  CheckIcon, CopyIcon, MoreHorizontalIcon, PauseIcon, PlayIcon, SearchIcon, StopIcon, TocIcon,
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

const readFontIndex = (): number => {
  const value: unknown = getDocFontIndex();
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= LAST
    ? value
    : Math.min(4, LAST);
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
}: DocViewProps) {
  const [fontIdx, setFontIdx] = useState<number>(readFontIndex);
  const [followPaused, setFollowPaused] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [toc, setToc] = useState<DocTocItem[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [matchIndex, setMatchIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const keyboardInset = useKeyboardInset();
  const [copied, setCopied] = useState(false);
  const [readNotice, setReadNotice] = useState<string | null>(null);
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
  useBackButton(!!imageView, closeImageView);
  useBackButton(infoOpen, () => setInfoOpen(false));
  useBackButton(tocOpen, () => setTocOpen(false));
  useBackButton(findOpen, () => closeFind());

  // Outline for the 目录 drawer. Heading ids are assigned here (the rendered HTML carries none) so a
  // tap can scroll to the exact node; `scroll-margin-top` on headings keeps them clear of the pinned
  // toolbar. Runs whenever the document content changes.
  useEffect(() => {
    const root = mdRef.current;
    if (!root) { setToc([]); return; }
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));
    const items: DocTocItem[] = [];
    headings.forEach((heading, index) => {
      const text = (heading.textContent || '').trim();
      if (!text) return;
      const id = `doc-h-${index}`;
      heading.id = id;
      items.push({ id, level: Number(heading.tagName.slice(1)) || 1, text });
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

  useEffect(() => () => { if (copiedTimer.current !== null) clearTimeout(copiedTimer.current); }, []);

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

  // Tap a sentence → read on from there — but ONLY while read-aloud is already running (playing or
  // paused). Tapping the text of an idle document must stay a normal reading gesture (selection,
  // scrolling), never a surprise start. markSentences is idempotent, so the list is re-read from the
  // existing spans.
  const onMarkdownClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!speech.supported || !speech.playing) return;
    const target = event.target instanceof Element ? event.target : null;
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

  if (type === 'image') {
    return <ImageViewer url={content} name={name} />;
  }

  if (type === 'html') {
    return <iframe className="doc-iframe" sandbox="allow-scripts" srcDoc={content || ''} title={name} />;
  }

  const bump = (delta: number): void => {
    const next = Math.min(LAST, Math.max(0, fontIdx + delta));
    setFontIdx(next);
    setDocFontIndex(next);
  };

  // ── Find in document (single file, no indexing: a plain case-insensitive substring scan) ────────
  // The search root is whichever container holds the document text — markdown or the verbatim <pre>.
  const findRoot = (): HTMLElement | null => mdRef.current ?? textRef.current;

  const closeFind = (): void => {
    clearFind(findRoot());
    setFindOpen(false);
    setQuery('');
    setMatchCount(0);
    setMatchIndex(-1);
  };

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

  const onCopyPath = (): void => {
    void copyText(fullPath).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1600);
    });
  };

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
                </div>
              )}
            </div>
          </>
        )}
      </div>

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
