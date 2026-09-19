// web/test/storageDocScroll.test.js — per-document reading position (scroll ratio) in storage.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getDocScrollRatio, setDocScrollRatio } from '../src/storage.js';

beforeEach(() => localStorage.clear());

describe('doc scroll position storage', () => {
  it('round-trips a ratio per path', () => {
    setDocScrollRatio('/a.md', 0.42);
    setDocScrollRatio('/b.md', 0.8);
    expect(getDocScrollRatio('/a.md')).toBeCloseTo(0.42);
    expect(getDocScrollRatio('/b.md')).toBeCloseTo(0.8);
    expect(getDocScrollRatio('/missing.md')).toBe(0);
    expect(getDocScrollRatio(null)).toBe(0);
  });

  it('treats "at the top" as no position, so the map does not grow for every file ever opened', () => {
    setDocScrollRatio('/a.md', 0.5);
    setDocScrollRatio('/a.md', 0);
    expect(getDocScrollRatio('/a.md')).toBe(0);
  });

  it('clamps and ignores junk', () => {
    setDocScrollRatio('/a.md', 5);
    expect(getDocScrollRatio('/a.md')).toBe(1);
    setDocScrollRatio('/a.md', Number.NaN);
    setDocScrollRatio(null, 0.5);
    expect(getDocScrollRatio('/a.md')).toBe(1);
  });

  it('survives corrupted storage instead of throwing', () => {
    localStorage.setItem('tw_doc_scroll', '{not json');
    expect(getDocScrollRatio('/a.md')).toBe(0);
    localStorage.setItem('tw_doc_scroll', '"a string"');
    expect(getDocScrollRatio('/a.md')).toBe(0);
  });

  it('caps the number of remembered documents', () => {
    for (let i = 0; i < 260; i++) setDocScrollRatio(`/doc-${i}.md`, 0.5);
    const stored = JSON.parse(localStorage.getItem('tw_doc_scroll'));
    expect(Object.keys(stored).length).toBeLessThanOrEqual(200);
    expect(getDocScrollRatio('/doc-259.md')).toBeCloseTo(0.5); // the newest survives
  });
});
