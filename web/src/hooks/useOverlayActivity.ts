import { useSyncExternalStore } from 'react';
import { overlayStackActive, subscribeOverlayStack } from '../overlays/overlayStack.js';

export function useOverlayActivity(): boolean {
  return useSyncExternalStore(subscribeOverlayStack, overlayStackActive, overlayStackActive);
}
