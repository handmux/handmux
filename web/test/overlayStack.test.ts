import { describe, expect, it, vi } from 'vitest';
import {
  createOverlayStackEntry,
  overlayStackSize,
  registerOverlayStackEntry,
  topOverlayStackEntry,
} from '../src/overlays/overlayStack.js';

describe('overlayStack', () => {
  it('keeps one explicit order while selecting the top entry for each input channel', () => {
    const parentEscape = createOverlayStackEntry('escape', vi.fn());
    const parentHistory = createOverlayStackEntry('history', vi.fn(), parentEscape.id);
    const childEscape = createOverlayStackEntry('escape', vi.fn());
    const unregisterParentEscape = registerOverlayStackEntry(parentEscape);
    const unregisterParentHistory = registerOverlayStackEntry(parentHistory);
    const unregisterChildEscape = registerOverlayStackEntry(childEscape);

    expect(topOverlayStackEntry('escape')).toBe(childEscape);
    expect(topOverlayStackEntry('history')).toBe(parentHistory);
    expect(overlayStackSize('escape')).toBe(2);
    expect(overlayStackSize('history')).toBe(1);

    unregisterChildEscape();
    expect(topOverlayStackEntry('escape')).toBe(parentEscape);
    unregisterParentHistory();
    unregisterParentEscape();
    expect(topOverlayStackEntry('escape')).toBeNull();
    expect(topOverlayStackEntry('history')).toBeNull();
  });
});
