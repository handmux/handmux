// web/test/docFindStyles.test.js — CSS contract for find highlighting.
//
// This exists because the bug it guards against CANNOT be seen in jsdom: the highlight rules used to
// carry `padding: 0 1px`, which shifted inline width and pushed the matched run onto the next line in
// pre-wrapped code blocks (found on a real device). jsdom has no layout, so only a source-level
// contract can catch a regression here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');

// Every declaration block whose selector mentions the find mark.
function findMarkBlocks() {
  const blocks = [];
  const re = /([^{}]*mark\.doc-find[^{}]*)\{([^}]*)\}/g;
  let match;
  while ((match = re.exec(styles)) !== null) blocks.push({ selector: match[1].trim(), body: match[2] });
  return blocks;
}

describe('find highlight CSS contract', () => {
  it('has rules for both the plain and the current match', () => {
    const selectors = findMarkBlocks().map((block) => block.selector);
    expect(selectors.some((s) => s.includes('mark.doc-find') && !s.includes('is-current'))).toBe(true);
    expect(selectors.some((s) => s.includes('is-current'))).toBe(true);
  });

  it('never uses layout-affecting properties (padding/border/margin/font-size)', () => {
    const blocks = findMarkBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    for (const { selector, body } of blocks) {
      const declarations = body.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(`${selector}: ${declarations}`).not.toMatch(/(^|[;{\s])(padding|border|border-width|margin|font-size)\s*:/);
    }
  });

  it('still marks the current match visually (background + a layout-neutral emphasis)', () => {
    const current = findMarkBlocks().find((block) => block.selector.includes('is-current'));
    expect(current?.body).toMatch(/background\s*:/);
    expect(current?.body).toMatch(/box-shadow\s*:|outline\s*:/);
  });
});
