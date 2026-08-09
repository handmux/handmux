import { useLayoutEffect, useRef } from 'react';
import {
  createOverlayStackEntry,
  overlayStackSize,
  registerOverlayStackEntry,
  topOverlayStackEntry,
  type OverlayStackEntry,
} from '../overlays/overlayStack.js';

const onKeyDown = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape' || event.repeat || event.isComposing) return;
  const top = topOverlayStackEntry('escape');
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  top.invoke();
};

export function useEscapeLayer(active: boolean, onEscape: () => void, layerId?: number): void {
  const callback = useRef(onEscape);
  const layer = useRef<OverlayStackEntry | null>(null);
  callback.current = onEscape;
  if (!layer.current) {
    layer.current = createOverlayStackEntry('escape', () => callback.current(), layerId);
  }

  // Layout timing lets focus/keyboard ownership update before the newly opened layer is painted.
  useLayoutEffect(() => {
    if (!active) return undefined;
    const entry = layer.current;
    if (!entry) return undefined;
    const unregister = registerOverlayStackEntry(entry);
    if (overlayStackSize('escape') === 1) window.addEventListener('keydown', onKeyDown, true);
    return () => {
      unregister();
      if (overlayStackSize('escape') === 0) window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [active]);
}
