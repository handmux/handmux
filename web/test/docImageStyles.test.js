// web/test/docImageStyles.test.js — CSS contract for the inline-image loading skeleton.
//
// The skeleton is device-only (jsdom has no layout, and the old "120px dark block" bug was a
// visual/UX regression nobody could unit-test through behaviour). This asserts the SOURCE rules:
// a thin bar keyed on the missing-`src` attribute, no tall placeholder, and a reduced-motion fallback.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');

describe('inline image skeleton CSS contract', () => {
  it('uses the "no src yet" attribute selector (never a JS-toggled class)', () => {
    expect(styles).toMatch(/\.doc-md img\[data-handmux-src\]:not\(\[src\]\)/);
    expect(styles).not.toMatch(/\.md-img-loading\s*\{/); // the old class-toggled placeholder is gone
  });

  it('is a thin bar, not a tall block that makes the page jump', () => {
    const rule = /\.doc-md img\[data-handmux-src\]:not\(\[src\]\)\s*\{([^}]*)\}/.exec(styles);
    expect(rule).not.toBeNull();
    const body = rule?.[1] ?? '';
    expect(body).toMatch(/height:\s*3px/);
    expect(body).not.toMatch(/min-height:\s*(1[0-9]{2,}|[2-9][0-9])px/); // no 120px-style placeholder
    expect(body).toMatch(/color:\s*transparent/); // alt text must not render while loading
  });

  it('degrades to a static bar under prefers-reduced-motion', () => {
    expect(styles).toMatch(/@media \(prefers-reduced-motion: no-preference\)/);
    const animated = /@media \(prefers-reduced-motion: no-preference\)\s*\{([\s\S]*?)\n\}/.exec(styles);
    expect(animated?.[1] ?? '').toMatch(/animation:\s*doc-img-loading/);
  });
});
