import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
const terminalSource = readFileSync(`${process.cwd()}/src/components/Terminal.tsx`, 'utf8');

describe('desktop scrollbar styles', () => {
  it('uses one custom scrollbar skin only for precise pointing devices', () => {
    expect(styles).toMatch(
      /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*\{[\s\S]*scrollbar-color:\s*var\(--scroll-thumb\)\s+transparent/,
    );
    expect(styles).toMatch(/\*::\-webkit-scrollbar\s*\{[^}]*width:\s*10px[^}]*height:\s*10px/);
    expect(styles).toMatch(
      /\*::\-webkit-scrollbar-thumb\s*\{[^}]*background-color:\s*var\(--scroll-thumb\)[^}]*background-clip:\s*padding-box/,
    );
    expect(styles).toMatch(/\*::\-webkit-scrollbar-thumb:active\s*\{[^}]*var\(--scroll-thumb-active\)/);
  });

  it('shows an arrowless horizontal scrollbar only when the terminal overflows', () => {
    expect(styles).toMatch(/\.terminal\s*\{[^}]*overflow-x:\s*auto/);
    expect(styles).toMatch(/\*::\-webkit-scrollbar:horizontal\s*\{[^}]*height:\s*0/);
    expect(styles).toMatch(
      /\.terminal::\-webkit-scrollbar:horizontal\s*\{[^}]*height:\s*10px/,
    );
    expect(styles).toMatch(
      /\.terminal::\-webkit-scrollbar-button\s*\{[^}]*display:\s*none[^}]*width:\s*0[^}]*height:\s*0/,
    );
    expect(styles).not.toMatch(/overflow-x:\s*scroll/);
    expect(styles).not.toMatch(/\.terminal\s*\{[^}]*padding-bottom:/);
    expect(styles).toMatch(
      /@media\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)\s*\{[\s\S]*\.terminal\.terminal--x-overflow\s*\{[^}]*padding-bottom:\s*4px[\s\S]*\.terminal::\-webkit-scrollbar:horizontal\s*\{[^}]*height:\s*4px[\s\S]*\.terminal::\-webkit-scrollbar-thumb:horizontal\s*\{[^}]*border:\s*0/,
    );
    expect(styles).toMatch(/\.terminal \.xterm-viewport::\-webkit-scrollbar:vertical\s*\{[^}]*width:\s*0/);
    expect(styles).toMatch(/\.terminal-y-scrollbar\s*\{[^}]*display:\s*none/);
    expect(styles).not.toMatch(/\.terminal-y-scrollbar\s*\{[^}]*display:\s*block/);
    expect(styles).not.toMatch(/\.terminal\.terminal--y-overflow\s*\{[^}]*(?:width|padding-right):/);
  });

  it('uses one visible terminal for history and the live frame', () => {
    expect(styles).toMatch(
      /\.terminal__live\s*\{[^}]*width:\s*100%[^}]*min-width:\s*100%[^}]*height:\s*100%/,
    );
    expect(terminalSource).not.toMatch(/terminal__history|terminal__stack|terminal--stream-composite/);
    expect(styles).toMatch(
      /\.terminal-history-boundary\s*\{[^}]*repeating-linear-gradient/,
    );
  });
});
