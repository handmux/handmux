// web/test/docFindStyles.test.js — CSS contract for find highlighting.
//
// This exists because the bug it guards against CANNOT be seen in jsdom: jsdom has no layout, so a
// source-level assertion is the only way to catch a styling regression before a device does. Two real
// regressions came from here:
//   • the match class collided with the toolbar's search-row class (.doc-find → display:flex), which
//     blockified every hit onto its own full-width line;
//   • the highlight carried `padding: 0 1px`, which shifted inline width and re-wrapped pre-wrapped
//     code lines.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');

// Every declaration block whose selector targets the inline match mark.
function findMarkBlocks() {
  const blocks = [];
  const re = /([^{}]*mark\.doc-find-hit[^{}]*)\{([^}]*)\}/g;
  let match;
  while ((match = re.exec(styles)) !== null) blocks.push({ selector: match[1].trim(), body: match[2] });
  return blocks;
}

describe('find highlight CSS contract', () => {
  it('has rules for both the plain and the current match', () => {
    const selectors = findMarkBlocks().map((block) => block.selector);
    expect(selectors.some((s) => !s.includes('is-current'))).toBe(true);
    expect(selectors.some((s) => s.includes('is-current'))).toBe(true);
  });

  it('never uses layout-affecting properties', () => {
    const blocks = findMarkBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    for (const { selector, body } of blocks) {
      const declarations = body.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(`${selector}: ${declarations}`).not.toMatch(
        /(^|[;{\s])(display|padding|border|border-width|margin|width|height|position|float|font-size)\s*:/,
      );
    }
  });

  it('does not reuse a class name that the toolbar row styles', () => {
    // The search ROW is `.doc-find`; the markup must use a distinct class, or the row's flex layout
    // applies to every match.
    expect(styles).toMatch(/\.doc-find\s*\{[^}]*display:\s*flex/); // the row really is a flex box…
    expect(styles).not.toMatch(/mark\.doc-find(?!-hit)/);           // …and no rule targets marks as the row
  });

  it('still marks the current match visually (background + a layout-neutral emphasis)', () => {
    const current = findMarkBlocks().find((block) => block.selector.includes('is-current'));
    expect(current?.body).toMatch(/background\s*:/);
    expect(current?.body).toMatch(/box-shadow\s*:|outline\s*:/);
  });
});
