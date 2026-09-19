// web/test/documentViewerStyles.test.js — CSS contracts for the viewer's chrome.
//
// Both are device-only properties (jsdom has no layout), and both came from looking at a real screen: a
// long file name must not take over the tab strip, and the loading page's spinner must be a plain CSS
// animation that respects reduced-motion.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');

describe('file tab name', () => {
  it('is capped and ellipsized instead of stretching the tab strip', () => {
    const rule = /\.file-tab-name\s*\{([^}]*)\}/.exec(styles)?.[1] ?? '';
    expect(rule).toMatch(/max-width:/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).toMatch(/white-space:\s*nowrap/);
  });
});

describe('viewer loading page', () => {
  it('exists as a CSS spinner with a reduced-motion fallback', () => {
    expect(styles).toMatch(/\.doc-loading\s*\{/);
    expect(styles).toMatch(/\.doc-loading-spinner\s*\{/);
    const animated = /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.doc-loading-spinner/.test(styles);
    expect(animated).toBe(true); // the animation lives inside the media query → static under reduce
  });
});
