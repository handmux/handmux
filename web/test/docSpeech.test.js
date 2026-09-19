import { describe, it, expect } from 'vitest';
import { splitSentences, markSentences } from '../src/voice/docSpeech.js';

describe('splitSentences', () => {
  it('splits on CJK terminators, keeping them attached', () => {
    expect(splitSentences('你好。今天天气不错！要出门吗？')).toEqual([
      '你好。', '今天天气不错！', '要出门吗？',
    ]);
  });
  it('splits ASCII .!? only when followed by space/end (decimals & versions stay whole)', () => {
    expect(splitSentences('Pi is 3.14 today. Run v1.2 now! Done?')).toEqual([
      'Pi is 3.14 today.', 'Run v1.2 now!', 'Done?',
    ]);
  });
  it('treats line breaks as sentence boundaries and collapses whitespace', () => {
    expect(splitSentences('第一行\n第二行   有空格')).toEqual(['第一行', '第二行 有空格']);
  });
  it('drops blank input', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n  ')).toEqual([]);
  });
});

describe('markSentences', () => {
  const root = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };

  it('wraps each sentence and returns the dense sentence list', () => {
    const el = root('<p>第一句。第二句。</p>');
    const sentences = markSentences(el);
    expect(sentences).toEqual(['第一句。', '第二句。']);
    expect([...el.querySelectorAll('.tts-sent[data-tts="0"]')].map((s) => s.textContent)).toEqual(['第一句。']);
    expect([...el.querySelectorAll('.tts-sent[data-tts="1"]')].map((s) => s.textContent)).toEqual(['第二句。']);
  });

  it('keeps a sentence that spans inline markup under ONE index', () => {
    const el = root('<p>这是<strong>加粗</strong>的一句话。</p>');
    const sentences = markSentences(el);
    expect(sentences).toEqual(['这是加粗的一句话。']);
    // three text runs (这是 / 加粗 / 的一句话。) all tagged index 0; the <strong> survives.
    expect(el.querySelectorAll('.tts-sent[data-tts="0"]').length).toBe(3);
    expect(el.querySelector('strong')).not.toBeNull();
  });

  it('reads code blocks too, one line at a time', () => {
    const el = root('<p>看代码。</p><pre><code>rm -rf /\necho done\n</code></pre>');
    expect(markSentences(el)).toEqual(['看代码。', 'rm -rf /', 'echo done']);
    expect(el.querySelector('pre .tts-sent')).not.toBeNull();
  });

  it('keeps inline code inside its sentence instead of splitting the prose', () => {
    const el = root('<p>运行 <code>npm test</code> 即可。</p>');
    expect(markSentences(el)).toEqual(['运行 npm test 即可。']);
  });

  it('never reads our own chrome ([data-tts-skip])', () => {
    const el = root('<p>正文。</p><span class="md-img-note" data-tts-skip>图片不存在</span>');
    expect(markSentences(el)).toEqual(['正文。']);
  });

  it('is idempotent — a second call returns the same list without double-wrapping', () => {
    const el = root('<p>一句。两句。</p>');
    const first = markSentences(el);
    const second = markSentences(el);
    expect(second).toEqual(first);
    expect(el.querySelector('.tts-sent .tts-sent')).toBeNull(); // no nested wrapping
  });
});
