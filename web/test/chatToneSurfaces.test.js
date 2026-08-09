import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'));
  expect(match, `missing CSS rule: ${selector}`).toBeTruthy();
  return match[1];
}

describe('chat tone overlay surfaces', () => {
  it('gives the warm-gold tone an opaque overlay surface', () => {
    const tone = cssRule('.chat-tone-surface[data-chat-tone="ink"]');
    expect(tone).toMatch(/--ct-overlay:\s*#[0-9a-f]{6}\s*;/i);
    expect(tone.match(/--ct-overlay:\s*([^;]+)/)?.[1]).not.toMatch(/rgba|transparent|color-mix/i);
  });

  it.each(['.tool-sheet', '.cc-context-popover', '.codex-config-menu', '.codex-goal-menu'])(
    'keeps %s isolated from the conversation behind it',
    (selector) => {
      expect(cssRule(selector)).toMatch(/background:\s*var\(--ct-overlay\)/);
    },
  );

  it('keeps the model menu footer on the same opaque surface', () => {
    expect(cssRule('.codex-config-footer')).toMatch(/background:\s*var\(--ct-overlay\)/);
    expect(cssRule('.codex-goal-actions')).toMatch(/background:\s*var\(--ct-overlay\)/);
  });
});
