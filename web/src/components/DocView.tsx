// web/src/components/DocView.jsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getDocFontIndex, setDocFontIndex, DOC_FONT_SIZES } from '../storage.js';
import { markSentences } from '../voice/docSpeech.js';
import { useDocSpeech } from '../voice/useDocSpeech.js';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock.js';
import { PlayIcon, PauseIcon, StopIcon } from './icons.jsx';
import ImageViewer from './ImageViewer.jsx';
import { t } from '../i18n';

export interface DocViewProps {
  type: string;
  name: string;
  content?: string | null;
}

const collectSentences = markSentences;
const rawFontSizes: unknown = DOC_FONT_SIZES;
const FONT_SIZES: readonly number[] = Array.isArray(rawFontSizes)
  && rawFontSizes.length > 0
  && rawFontSizes.every((value) => typeof value === 'number' && Number.isFinite(value))
  ? rawFontSizes
  : [10, 11, 12, 13, 14, 16, 18, 20, 22];
const LAST = FONT_SIZES.length - 1;

const readFontIndex = (): number => {
  const value: unknown = getDocFontIndex();
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= LAST
    ? value
    : Math.min(4, LAST);
};

const renderMarkdown = (source: string): string => {
  const rendered = marked.parse(source, { async: false });
  if (typeof rendered !== 'string') throw new Error('Synchronous Markdown rendering returned a Promise');
  return DOMPurify.sanitize(rendered);
};

// Render one doc. markdown → marked → DOMPurify → injected HTML, with A−/A+ font stepping over a
// discrete 9-level ladder (persisted, shared across docs). Single-file html → sandboxed iframe with
// allow-scripts but NOT allow-same-origin, so report JS runs yet can't reach our token or the
// parent page. `content` is already fetched (the tab carries it).
//
// Markdown docs also get read-aloud (TTS): the play button wraps each sentence in a span (markSentences)
// the first time, then useDocSpeech speaks them one at a time; the current sentence is highlighted and
// scrolled into view. HTML docs (iframe, cross-origin) can't be read, so they show no controls.
export default function DocView({ type, name, content = '' }: DocViewProps) {
  const [fontIdx, setFontIdx] = useState<number>(readFontIndex);
  const mdRef = useRef<HTMLDivElement | null>(null);
  const speech = useDocSpeech();
  useScreenWakeLock(speech.playing && !speech.paused); // screen sleep kills TTS — hold it awake while reading

  const html = useMemo(
    () => (type === 'markdown' ? renderMarkdown(content || '') : ''),
    [type, content],
  );

  // Content swapped (different doc) → stop any in-flight reading (React rebuilds innerHTML, so the
  // old sentence spans are gone anyway).
  useEffect(() => { speech.stop(); }, [html]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reflect the spoken sentence as a highlight and keep it in view.
  useEffect(() => {
    const root = mdRef.current;
    if (!root) return;
    root.querySelectorAll('.tts-active').forEach((el) => el.classList.remove('tts-active'));
    if (speech.idx < 0) return;
    const els = root.querySelectorAll(`.tts-sent[data-tts="${speech.idx}"]`);
    els.forEach((el) => el.classList.add('tts-active'));
    els[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [speech.idx]);

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

  // Plain text / logs / scripts: render verbatim (no markdown, no TTS), just the font-zoom ladder.
  if (type === 'text') {
    return (
      <div className="doc-md-wrap">
        <div className="doc-zoom">
          <div className="doc-fonts">
            <button className="doc-zoom-btn" onClick={() => bump(-1)} disabled={fontIdx <= 0} aria-label={t('doc.fontSmaller')}>A−</button>
            <button className="doc-zoom-btn" onClick={() => bump(1)} disabled={fontIdx >= LAST} aria-label={t('doc.fontLarger')}>A+</button>
          </div>
        </div>
        <pre className="doc-text" style={{ fontSize: `${FONT_SIZES[fontIdx]}px` }}>{content || ''}</pre>
      </div>
    );
  }

  const onPlayToggle = (): void => {
    if (speech.playing) { speech.paused ? speech.resume() : speech.pause(); return; }
    const sentences = collectSentences(mdRef.current);
    if (sentences.length) speech.play(sentences);
  };
  const reading = speech.playing && !speech.paused;

  return (
    <div className="doc-md-wrap">
      <div className="doc-zoom">
        {speech.supported && (
          <div className="doc-tts">
            <button className="doc-zoom-btn doc-zoom-icon" onClick={onPlayToggle}
              aria-label={reading ? t('doc.pauseRead') : speech.paused ? t('doc.resumeRead') : t('doc.read')}>
              {reading ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="doc-zoom-btn doc-zoom-icon" onClick={speech.stop} disabled={!speech.playing} aria-label={t('doc.stopRead')}>
              <StopIcon />
            </button>
            <button className="doc-zoom-btn" onClick={speech.cycleRate} aria-label={t('doc.rate')}>{speech.rate}×</button>
          </div>
        )}
        <div className="doc-fonts">
          <button className="doc-zoom-btn" onClick={() => bump(-1)} disabled={fontIdx <= 0} aria-label={t('doc.fontSmaller')}>A−</button>
          <button className="doc-zoom-btn" onClick={() => bump(1)} disabled={fontIdx >= LAST} aria-label={t('doc.fontLarger')}>A+</button>
        </div>
      </div>
      <div ref={mdRef} className="doc-md" style={{ fontSize: `${FONT_SIZES[fontIdx]}px` }}
        dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
