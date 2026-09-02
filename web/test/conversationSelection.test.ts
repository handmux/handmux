import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  conversationTextMap,
  copyTextForRange,
  domRangeForOffsets,
  normalizedOffsetRange,
  paragraphRange,
  textOffsetAtPoint,
  visualLineFlowRange,
  visualLineRange,
  wordRangeAt,
} from '../src/conversationSelection.js';

afterEach(() => vi.restoreAllMocks());

function rootWith(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe('conversation DOM selection', () => {
  it('maps offsets across inline nodes while excluding interface-only text', () => {
    const root = rootWith('alpha <strong>beta</strong><span class="chat-copy-ignore">done</span> gamma');
    const map = conversationTextMap(root);
    expect(map.text).toBe('alpha beta gamma');
    const range = domRangeForOffsets(root, { start: 3, end: 12 }, map);
    expect(range?.toString()).toBe('ha betadone g');
    expect(range && copyTextForRange(range)).toBe('ha beta g');
    root.remove();
  });

  it('maps a caret hit inside a nested Markdown node back to the root offset', () => {
    const root = rootWith('zero <strong>target</strong> tail');
    const text = root.querySelector('strong')!.firstChild!;
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: text, offset: 3 }),
    });
    expect(textOffsetAtPoint(root, 20, 30)).toBe(8);
    root.remove();
  });

  it('returns null for invalid caret frames unless a real in-root fallback target exists', () => {
    const root = rootWith('<strong>alpha</strong> beta');
    const outside = document.createElement('span');
    outside.textContent = 'overlay handle';
    document.body.append(outside);
    const originalPosition = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
    const originalRange = Object.getOwnPropertyDescriptor(document, 'caretRangeFromPoint');
    try {
      Object.defineProperty(document, 'caretPositionFromPoint', {
        configurable: true,
        value: () => ({ offsetNode: outside.firstChild!, offset: 0 }),
      });
      Object.defineProperty(document, 'caretRangeFromPoint', {
        configurable: true,
        value: () => null,
      });
      expect(textOffsetAtPoint(root, 20, 30)).toBeNull();
      expect(textOffsetAtPoint(root, 20, 30, outside)).toBeNull();
      expect(textOffsetAtPoint(root, 20, 30, root.querySelector('strong'))).toBe(0);

      Object.defineProperty(document, 'caretPositionFromPoint', {
        configurable: true,
        value: () => null,
      });
      expect(textOffsetAtPoint(root, 20, 30)).toBeNull();
      expect(textOffsetAtPoint(root, 20, 30, root.querySelector('strong'))).toBe(0);
    } finally {
      if (originalPosition) Object.defineProperty(document, 'caretPositionFromPoint', originalPosition);
      else Reflect.deleteProperty(document, 'caretPositionFromPoint');
      if (originalRange) Object.defineProperty(document, 'caretRangeFromPoint', originalRange);
      else Reflect.deleteProperty(document, 'caretRangeFromPoint');
      outside.remove();
      root.remove();
    }
  });

  it('selects complete Latin tokens and paths but uses language word boundaries for Chinese', () => {
    expect(wordRangeAt('run --flag=value next', 7)).toEqual({ start: 4, end: 16 });
    expect(wordRangeAt('open ~/src/main.ts now', 10)).toEqual({ start: 5, end: 18 });
    const chinese = wordRangeAt('请求失败，请稍后重试', 1);
    expect(chinese && '请求失败，请稍后重试'.slice(chinese.start, chinese.end)).toBe('请求');

    const mixed = '请使用v2版本，然后重试';
    const chineseInMixed = wordRangeAt(mixed, 1);
    const latinInMixed = wordRangeAt(mixed, mixed.indexOf('v'));
    expect(chineseInMixed && mixed.slice(chineseInMixed.start, chineseInMixed.end)).toBe('使用');
    expect(latinInMixed && mixed.slice(latinInMixed.start, latinInMixed.end)).toBe('v2');

    const pathText = '打开 /Users/me/project/file.ts 然后重试';
    const path = wordRangeAt(pathText, pathText.indexOf('project'));
    expect(path && pathText.slice(path.start, path.end)).toBe('/Users/me/project/file.ts');
  });

  it('normalizes crossed handle endpoints and never creates an empty selection', () => {
    expect(normalizedOffsetRange(8, 3, 12)).toEqual({ start: 3, end: 8 });
    expect(normalizedOffsetRange(3, 8, 12)).toEqual({ start: 3, end: 8 });
    expect(normalizedOffsetRange(12, 12, 12)).toEqual({ start: 11, end: 12 });
    expect(normalizedOffsetRange(0, 0, 0)).toBeNull();
  });

  it('expands across every covered rendered line from measured character rectangles', () => {
    const tops = [0, 0, 0, 20, 20, 20, 40, 40];
    const next = visualLineRange({ start: 1, end: 5 }, tops.length, (offset) => ({
      top: tops[offset]!, bottom: tops[offset]! + 18,
    }));
    expect(next).toEqual({ start: 0, end: 6 });

    let measurements = 0;
    expect(visualLineRange({ start: 5_000, end: 5_001 }, 10_000, () => {
      measurements += 1;
      return { top: 0, bottom: 18 };
    })).toEqual({ start: 0, end: 10_000 });
    expect(measurements).toBeLessThan(40);
  });

  it('limits visual-line binary search to each table cell layout flow', () => {
    const table = rootWith('<table><tr><td>abc</td><td>def</td></tr></table>');
    const map = conversationTextMap(table);
    const tops = [0, 20, 40, 0, 20, 40];
    const scopeAt = (offset: number) => visualLineFlowRange(table, offset, map);
    const rectAt = (offset: number) => ({ top: tops[offset]!, bottom: tops[offset]! + 18 });

    expect(visualLineRange({ start: 4, end: 5 }, map.text.length, rectAt, scopeAt))
      .toEqual({ start: 4, end: 5 });
    expect(visualLineRange({ start: 1, end: 5 }, map.text.length, rectAt, scopeAt))
      .toEqual({ start: 1, end: 5 });
    table.remove();
  });

  it('expands Markdown blocks semantically and preformatted content by blank lines', () => {
    const markdown = rootWith('<p>first <strong>paragraph</strong></p><p>second paragraph</p>');
    const map = conversationTextMap(markdown);
    expect(paragraphRange(markdown, { start: 8, end: 23 }, map)).toEqual({
      start: 0,
      end: map.text.length,
    });
    markdown.remove();

    const pre = rootWith('<pre>one\ntwo\n\nthree\nfour</pre>');
    const preMap = conversationTextMap(pre);
    expect(paragraphRange(pre, { start: 5, end: 7 }, preMap)).toEqual({ start: 0, end: 7 });
    expect(paragraphRange(pre, { start: 10, end: 12 }, preMap)).toEqual({ start: 9, end: 19 });
    pre.remove();

    const surroundedPre = rootWith(
      '<p>before paragraph</p><pre>alpha\nbeta</pre><p>after paragraph</p>',
    );
    const surroundedMap = conversationTextMap(surroundedPre);
    const codeStart = surroundedMap.text.indexOf('alpha');
    const codeRange = paragraphRange(surroundedPre, {
      start: codeStart + 2,
      end: codeStart + 4,
    }, surroundedMap);
    expect(surroundedMap.text.slice(codeRange.start, codeRange.end)).toBe('alpha\nbeta');
    surroundedPre.remove();

    const diff = rootWith([
      '<div class="chat-diff-line">first</div>',
      '<div class="chat-diff-line">second</div>',
      '<div class="chat-diff-line"> </div>',
      '<div class="chat-diff-line">third</div>',
    ].join(''));
    diff.className = 'chat-diff';
    const diffMap = conversationTextMap(diff);
    expect(paragraphRange(diff, { start: 6, end: 8 }, diffMap)).toEqual({ start: 0, end: 11 });
    expect(paragraphRange(diff, { start: 12, end: 14 }, diffMap)).toEqual({ start: 12, end: 17 });
    diff.remove();
  });

  it('copies visible block text with line breaks and preserves code indentation', () => {
    const root = rootWith('<p>first <strong>line</strong></p><p>second</p><pre>  code\n    nested</pre><table><tr><th>Name</th><th>State</th></tr><tr><td>Pi</td><td>Ready</td></tr></table>');
    const range = document.createRange();
    range.selectNodeContents(root);
    expect(copyTextForRange(range)).toBe([
      'first line', 'second', '  code\n    nested', 'Name\tState', 'Pi\tReady',
    ].join('\n'));
    root.remove();
  });

  it('preserves unordered, ordered, and nested list markers when expanding a list selection', () => {
    const root = rootWith([
      '<ul><li>plain</li></ul>',
      '<ol start="3"><li>first</li><li>second<ul><li>nested</li></ul></li></ol>',
    ].join(''));
    root.dataset.conversationCopyRoot = 'true';
    const map = conversationTextMap(root);
    const range = domRangeForOffsets(root, { start: 0, end: map.text.length }, map)!;
    expect(copyTextForRange(range, true)).toBe([
      '- plain',
      '3. first',
      '4. second',
      '  - nested',
    ].join('\n'));
    expect(root.querySelector('[data-chat-copy-marker], [data-chat-copy-depth]')).toBeNull();

    const secondStart = map.text.indexOf('second');
    const secondParagraph = paragraphRange(root, {
      start: secondStart,
      end: secondStart + 2,
    }, map);
    const secondRange = domRangeForOffsets(root, secondParagraph, map)!;
    expect(copyTextForRange(secondRange, true)).toBe('4. second\n  - nested');
    root.remove();
  });

  it('adds a list marker only when the expanded visual line starts at the item boundary', () => {
    const root = rootWith('<ul><li>abcdef</li></ul>');
    root.dataset.conversationCopyRoot = 'true';
    const map = conversationTextMap(root);
    const tops = [0, 0, 0, 20, 20, 20];
    const rectAt = (offset: number) => ({ top: tops[offset]!, bottom: tops[offset]! + 18 });

    const firstLine = visualLineRange({ start: 1, end: 2 }, map.text.length, rectAt);
    const secondLine = visualLineRange({ start: 4, end: 5 }, map.text.length, rectAt);
    expect(copyTextForRange(domRangeForOffsets(root, firstLine, map)!, true)).toBe('- abc');
    expect(copyTextForRange(domRangeForOffsets(root, secondLine, map)!, true)).toBe('def');
    const whole = paragraphRange(root, { start: 4, end: 5 }, map);
    expect(copyTextForRange(domRangeForOffsets(root, whole, map)!, true)).toBe('- abcdef');
    root.remove();
  });
});
