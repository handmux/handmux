import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentMark } from '../src/components/icons.js';
import { AgentCatalogProvider } from '../src/agentCatalog.js';

describe('AgentMark', () => {
  it('uses bundled brand assets only for known icon ids', () => {
    const { container, rerender } = render(<AgentMark agent="claude" />);
    const claude = container.querySelector('[data-agent-icon="claude"]');
    expect(claude).not.toBeNull();
    // Claude's mark is the pixel robot its CLI prints on startup: block art, so it is drawn as rects in the
    // terminal's own two colours rather than as a single-colour glyph.
    const claudeSvg = claude?.querySelector('svg');
    // Each artwork carries its OWN box — Claude's robot is 17:10 — so a badge sized by height can show it
    // at full height instead of letterboxing it inside the shared square.
    expect(claudeSvg?.getAttribute('viewBox')).toBe('0 0 17 10');
    expect(new Set(Array.from(claudeSvg?.querySelectorAll('path') ?? [])
      .map((path) => path.getAttribute('fill')))).toEqual(new Set(['#000000', '#d7af87']));

    rerender(<AgentMark agent="codex" />);
    const codex = container.querySelector('[data-agent-icon="codex"]');
    expect(codex).not.toBeNull();
    // The prompt glyph the CLI ships, with the circle it draws around it dropped: geometry and stroke
    // weight are the CLI's own, and the stroke is currentColor so the badge follows the tab's text.
    const codexSvg = codex?.querySelector('svg');
    expect(codexSvg?.getAttribute('viewBox')).toBe('6.826 9.998 18.366 12.089');
    const glyph = codexSvg?.querySelector('path');
    expect(glyph?.getAttribute('d')).toMatch(/^M22\.356 19\.797H17\.17/);
    expect(glyph?.getAttribute('stroke')).toBe('currentColor');
    expect(glyph?.getAttribute('stroke-width')).toBe('2.484');
    expect(codexSvg?.querySelector('mask')).toBeNull();

    rerender(<AgentMark agent="pi" />);
    const pi = container.querySelector('[data-agent-icon="pi"]');
    const svg = pi?.querySelector('svg');
    expect(pi).not.toBeNull();
    expect(container.querySelector('[data-agent-icon="generic"]')).toBeNull();
    // A square mark keeps the full 24×24 canvas, so shared .agent-mark sizing stays visually consistent in
    // tabs, the pane map, and Usage without per-location Pi overrides. (The two robots declare their own
    // wider boxes; .agent-mark sizes every mark by height.)
    expect(svg?.getAttribute('viewBox')).toBe('-1.200 -1.200 26.400 26.400');
    expect(svg?.querySelectorAll('path')).toHaveLength(2);
    expect(Array.from(svg?.querySelectorAll('path') ?? []).map((path) => path.getAttribute('fill')))
      .toEqual(['currentColor', 'currentColor']);
    expect(svg?.querySelector('path')?.getAttribute('fill-rule')).toBe('evenodd');
    const piCoordinates = Array.from(svg?.querySelectorAll('path') ?? []).flatMap((path) => (
      (path.getAttribute('d')?.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    ));
    // Pi keeps a deliberate 1px optical inset inside the shared 24×24 canvas: slightly smaller than a
    // full-bleed mark, centered, and consistent everywhere AgentMark is used.
    expect(Math.min(...piCoordinates)).toBe(1);
    expect(Math.max(...piCoordinates)).toBe(23);
  });

  it('bundles the CodeBuddy brand logo on its own artwork box', () => {
    const { container } = render(<AgentMark agent="codebuddy" />);
    const mark = container.querySelector('[data-agent-icon="codebuddy"]');
    expect(mark).not.toBeNull();
    expect(container.querySelector('[data-agent-icon="generic"]')).toBeNull();
    // The mark is the block-art robot the CLI prints on startup, on its own box (10% padded so it reads the
    // same weight as the other marks) so a badge sized by height shows it at full height.
    const svg = mark?.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('-2.000 -1.400 44.000 30.800');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    // One path in the colour the CLI emits for the banner, and no defs ids: these logos are inlined into
    // one shared document, and neighbouring cells must not show a seam.
    const paths = Array.from(svg?.querySelectorAll('path') ?? []);
    expect(paths).toHaveLength(1);
    expect(paths[0]?.getAttribute('fill')).toBe('#5fd7af');
    expect(svg?.querySelectorAll('[id]').length).toBe(0);
  });

  it('uses a neutral mark for unknown and missing ids', () => {
    const { container, rerender } = render(<AgentMark agent="third-party" />);
    expect(container.querySelector('[data-agent-icon="generic"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="third-party"]')).not.toBeNull();

    rerender(<AgentMark />);
    expect(container.querySelector('[data-agent-icon="generic"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="agent"]')).not.toBeNull();
  });

  it('uses the discovered label and bundled iconId instead of assuming the agent id', () => {
    const { container, rerender } = render(
      <AgentCatalogProvider loaded descriptors={[{
        id: 'internal-agent', label: 'Internal Agent', iconId: 'codex',
        capabilities: { inbox: true, conversation: false, interaction: false, subscriptionUsage: true },
      }]}>
        <AgentMark agent="internal-agent" />
      </AgentCatalogProvider>,
    );
    expect(container.querySelector('[data-agent-icon="codex"]')?.getAttribute('aria-label'))
      .toBe('Internal Agent');

    rerender(
      <AgentCatalogProvider loaded descriptors={[{
        id: 'claude', label: 'Unbranded', iconId: 'not-bundled',
        capabilities: { inbox: true, conversation: true, interaction: false, subscriptionUsage: false },
      }]}>
        <AgentMark agent="claude" />
      </AgentCatalogProvider>,
    );
    expect(container.querySelector('[data-agent-icon="generic"]')?.getAttribute('aria-label'))
      .toBe('Unbranded');
  });
});
