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
    expect(claudeSvg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(new Set(Array.from(claudeSvg?.querySelectorAll('rect') ?? [])
      .map((rect) => rect.getAttribute('fill')))).toEqual(new Set(['#000000', '#d7af87']));

    rerender(<AgentMark agent="codex" />);
    expect(container.querySelector('[data-agent-icon="codex"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-icon="codex"] svg')?.getAttribute('viewBox'))
      .toBe('0 0 24 24');

    rerender(<AgentMark agent="pi" />);
    const pi = container.querySelector('[data-agent-icon="pi"]');
    const svg = pi?.querySelector('svg');
    expect(pi).not.toBeNull();
    expect(container.querySelector('[data-agent-icon="generic"]')).toBeNull();
    // Every bundled logo uses the same full 24×24 canvas; shared .agent-mark sizing then stays visually
    // consistent in tabs, the pane map, and Usage without per-location Pi overrides.
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
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

  it('bundles the CodeBuddy brand logo on the shared 24×24 canvas', () => {
    const { container } = render(<AgentMark agent="codebuddy" />);
    const mark = container.querySelector('[data-agent-icon="codebuddy"]');
    expect(mark).not.toBeNull();
    expect(container.querySelector('[data-agent-icon="generic"]')).toBeNull();
    // The mark ships on its own wider canvas; it is fitted into the shared one so every badge stays the
    // same rendered size without per-location overrides.
    const svg = mark?.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    // Brand colour kept as shipped, and no defs ids: these logos are inlined into one shared document.
    const paths = Array.from(svg?.querySelectorAll('path') ?? []);
    expect(paths).toHaveLength(3);
    expect(new Set(paths.map((path) => path.getAttribute('fill')))).toEqual(new Set(['#00BC90']));
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
