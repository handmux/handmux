// web/src/components/DocView.jsx
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getDocFontIndex, setDocFontIndex, getDocAutoFollow, setDocAutoFollow, DOC_FONT_SIZES,
} from '../storage.js';
import { markSentences } from '../voice/docSpeech.js';
import { useDocSpeech } from '../voice/useDocSpeech.js';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock.js';
import { useMarkdownImages } from '../hooks/useMarkdownImages.js';
import { useBackButton } from '../hooks/useBackButton.js';
import { renderMarkdown } from '../markdown.js';
import {
  MoreHorizontalIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon, StopIcon,
} from './icons.jsx';
import ImageViewer from './ImageViewer.jsx';
import ActionSheet from './ActionSheet.jsx';
import { t } from '../i18n';
import type { MouseEvent as ReactMouseEvent } from 'react';

export interface DocViewProps {
  type: string;
  name: string;
  /** Absolute path of the doc file — resolves relative image srcs inside markdown. */
  path?: string | null;
  content?: string | null;
}

type SheetKind = 'more';

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

// Render one doc behind a sticky TOOLBAR. markdown → shared pipeline (markdown.ts) → injected HTML;
// single-file html → sandboxed iframe (allow-scripts, NOT allow-same-origin, so report JS can't reach
// our token or the parent page); everything else → verbatim <pre>. `content` is already fetched (the
// tab carries it).
//
// Toolbar has two states: idle (▶ 朗读 | Aa 排版 | ⋯ 更多) and reading (⏮ ⏯ ⏭ | progress | 语速 | ⏹).
// The idle state stays out of the way; Aa/⋯ sheets hold the settings that don't deserve permanent
// space, and are the container future reader features (目录/查找/刷新…) drop into.
//
// Read-aloud (TTS) speaks one sentence at a time (see useDocSpeech) and the sentence spans laid down
// by docSpeech.markSentences make any position addressable: tapping a sentence reads on from there,
// which is the natural phone gesture — no scrubbing needed. Following keeps the spoken sentence in
// view until the reader scrolls away, then a pill offers to come back.
export default function DocView({ type, name, path = null, content = '' }: DocViewProps) {
  const [fontIdx, setFontIdx] = useState<number>(readFontIndex);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [autoFollow, setAutoFollow] = useState<boolean>(getDocAutoFollow);
  const [followPaused, setFollowPaused] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const mdRef = useRef<HTMLDivElement | null>(null);
  const scrollGuardUntil = useRef(0); // timestamp until which scroll events are treated as our own
  const speech = useDocSpeech();
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
  useBackButton(sheet !== null, () => setSheet(null));

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

  // Reflect the spoken sentence as a highlight and keep it in view — unless the reader scrolled away
  // (followPaused) or turned following off.
  useEffect(() => {
    const root = mdRef.current;
    if (!root) return;
    root.querySelectorAll('.tts-active').forEach((el) => el.classList.remove('tts-active'));
    if (speech.idx < 0) return;
    const els = root.querySelectorAll(`.tts-sent[data-tts="${speech.idx}"]`);
    els.forEach((el) => el.classList.add('tts-active'));
    if (!autoFollow || followPaused) return;
    scrollGuardUntil.current = Date.now() + FOLLOW_SCROLL_GUARD_MS;
    els[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [speech.idx, autoFollow, followPaused]);

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

  // Tap a sentence → read on from there. Works whether idle, paused or playing (markSentences is
  // idempotent, so the sentence list is re-read from the existing spans).
  const onMarkdownClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!speech.supported) return;
    const target = event.target instanceof Element ? event.target : null;
    const span = target?.closest<HTMLElement>('.tts-sent[data-tts]');
    if (!span) return;
    const index = Number(span.dataset.tts);
    if (!Number.isInteger(index)) return;
    const sentences = collectSentences(mdRef.current);
    if (!sentences.length) return;
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

  const toggleAutoFollow = (): void => {
    const next = !autoFollow;
    setAutoFollow(next);
    setDocAutoFollow(next);
    if (next) setFollowPaused(false);
  };

  const onPlayToggle = (): void => {
    if (speech.playing) { speech.paused ? speech.resume() : speech.pause(); return; }
    setFollowPaused(false); // a fresh read always follows
    const sentences = collectSentences(mdRef.current);
    if (sentences.length) speech.play(sentences);
  };

  const reading = speech.playing && !speech.paused;
  const total = speech.total;
  const shownIdx = speech.idx >= 0 ? speech.idx + 1 : 0;
  const progress = total > 0 && shownIdx > 0 ? `${(shownIdx / total) * 100}%` : '0%';
  const canRead = type === 'markdown' && speech.supported;

  return (
    <div className="doc-md-wrap" ref={wrapRef}>
      <div className="doc-toolbar">
        {speech.playing ? (
          <div className="doc-player">
            <button className="doc-zoom-btn doc-zoom-icon" onClick={speech.prev} disabled={speech.idx <= 0}
              aria-label={t('doc.prevSentence')}><SkipBackIcon /></button>
            <button className="doc-zoom-btn doc-zoom-icon" onClick={onPlayToggle}
              aria-label={reading ? t('doc.pauseRead') : t('doc.resumeRead')}>
              {reading ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="doc-zoom-btn doc-zoom-icon" onClick={speech.next}
              aria-label={t('doc.nextSentence')}><SkipForwardIcon /></button>
            <div className="doc-progress" role="progressbar" aria-label={t('doc.progress')}
              aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={shownIdx}>
              <span className="doc-progress-fill" style={{ width: progress }} />
            </div>
            <span className="doc-progress-num" aria-hidden="true">{shownIdx}/{total || '–'}</span>
            <button className="doc-zoom-btn" onClick={speech.cycleRate}
              aria-label={t('doc.rate')}>{speech.rate}×</button>
            <button className="doc-zoom-btn doc-zoom-icon" onClick={speech.stop}
              aria-label={t('doc.stopRead')}><StopIcon /></button>
          </div>
        ) : (
          <div className="doc-tools">
            {canRead && (
              <button className="doc-zoom-btn doc-zoom-icon" onClick={onPlayToggle}
                aria-label={t('doc.read')}><PlayIcon /></button>
            )}
            <div className="doc-fonts">
              <button className="doc-zoom-btn" onClick={() => bump(-1)} disabled={fontIdx <= 0}
                aria-label={t('doc.fontSmaller')}>A−</button>
              <button className="doc-zoom-btn" onClick={() => bump(1)} disabled={fontIdx >= LAST}
                aria-label={t('doc.fontLarger')}>A+</button>
            </div>
            <button className="doc-zoom-btn doc-zoom-icon" onClick={() => setSheet('more')}
              aria-label={t('doc.more')}><MoreHorizontalIcon /></button>
          </div>
        )}
      </div>

      {type === 'text' ? (
        <pre className="doc-text" style={{ fontSize: `${FONT_SIZES[fontIdx]}px` }}>{content || ''}</pre>
      ) : (
        <div ref={mdRef} className="doc-md" style={{ fontSize: `${FONT_SIZES[fontIdx]}px` }}
          onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: html }} />
      )}

      {/* Pinned to the bottom of the reading area; only while reading and only after a manual scroll. */}
      {speech.playing && autoFollow && followPaused && (
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

      <ActionSheet open={sheet === 'more'} title={t('doc.more')} onClose={() => setSheet(null)}
        actions={[
          ...(canRead ? [{
            key: 'rate',
            label: `${t('doc.rate')} · ${speech.rate}×`,
            onClick: speech.cycleRate,
          }] : []),
          ...(canRead ? [{
            key: 'follow',
            label: `${t('doc.autoFollow')} · ${autoFollow ? t('common.on') : t('common.off')}`,
            onClick: toggleAutoFollow,
          }] : []),
        ]} />
    </div>
  );
}
