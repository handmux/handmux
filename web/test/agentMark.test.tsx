import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentMark } from '../src/components/icons.js';
import { AgentCatalogProvider } from '../src/agentCatalog.js';

describe('AgentMark', () => {
  it('uses bundled brand assets only for known icon ids', () => {
    const { container, rerender } = render(<AgentMark agent="claude" />);
    expect(container.querySelector('[data-agent-icon="claude"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-icon="claude"] svg')?.getAttribute('viewBox'))
      .toBe('0 0 24 24');

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
    // The official mark ships on its own 40×40 canvas; it is scaled into the shared one so every badge
    // stays the same rendered size without per-location overrides.
    const svg = mark?.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    // Its gradient/clip ids are namespaced, because these logos are inlined into one shared document.
    expect(Array.from(svg?.querySelectorAll('[id]') ?? []).map((node) => node.getAttribute('id')))
      .toContain('clip0_hmcb');
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
