import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { OverlayPortal, OverlayProvider } from '../src/overlays/OverlayHost.js';

afterEach(cleanup);

describe('OverlayHost', () => {
  it('portals one themed, keyboard-aware layer into the configured host', () => {
    const host = document.createElement('div');
    document.body.append(host);
    render(
      <OverlayProvider host={host} keyboardInset={280} chatTone="ink">
        <OverlayPortal><section role="dialog">Details</section></OverlayPortal>
      </OverlayProvider>,
    );

    const dialog = screen.getByRole('dialog');
    const layer = dialog.parentElement;
    expect(host.contains(dialog)).toBe(true);
    expect(layer?.classList.contains('overlay-layer')).toBe(true);
    expect(layer?.getAttribute('data-chat-tone')).toBe('ink');
    expect(layer?.style.getPropertyValue('--overlay-keyboard-inset')).toBe('280px');
    host.remove();
  });

  it('allows a layer to override the provider environment during migration', () => {
    const host = document.createElement('div');
    document.body.append(host);
    render(
      <OverlayProvider host={host} keyboardInset={120} chatTone="dusk">
        <OverlayPortal keyboardInset={36} chatTone="light">
          <section role="dialog">Details</section>
        </OverlayPortal>
      </OverlayProvider>,
    );

    const layer = screen.getByRole('dialog').parentElement;
    expect(layer?.getAttribute('data-chat-tone')).toBe('light');
    expect(layer?.style.getPropertyValue('--overlay-keyboard-inset')).toBe('36px');
    host.remove();
  });
});
