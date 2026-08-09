import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');

function token(name) {
  const match = styles.match(new RegExp(`--z-overlay-${name}:\\s*(\\d+)`));
  return match ? Number(match[1]) : null;
}

describe('global Overlay layers', () => {
  it('keeps the semantic levels strictly ordered from navigation to blocking UI', () => {
    const levels = [
      'drawer-backdrop', 'drawer', 'base-backdrop', 'base', 'sheet-backdrop', 'sheet',
      'nested-backdrop', 'nested', 'nested-content', 'dialog-backdrop', 'dialog',
      'tool-backdrop', 'tool', 'popover-backdrop', 'popover', 'detail-backdrop', 'detail',
      'workspace', 'confirm', 'link-backdrop', 'link', 'toast', 'browser-confirm', 'blocking',
    ].map(token);
    expect(levels.every((value) => value != null)).toBe(true);
    expect(levels).toEqual([...levels].sort((left, right) => left - right));
    expect(new Set(levels).size).toBe(levels.length);
  });

  it('routes representative cross-surface selectors through semantic tokens', () => {
    for (const selector of [
      '.drawer', '.settings-backdrop', '.cmd-backdrop', '.workspace-restore-backdrop',
      '.file-sheet', '.tool-sheet-backdrop', '.codex-plan-backdrop', '.cc-queue-dialog-backdrop',
      '.doclink-backdrop', '.upload-overlay',
    ]) {
      const escaped = selector.replace('.', '\\.');
      expect(styles).toMatch(new RegExp(`${escaped}\\s*\\{[^}]*z-index:\\s*var\\(--z-overlay-`));
    }
  });
});
