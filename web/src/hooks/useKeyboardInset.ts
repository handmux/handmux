import { useEffect, useState } from 'react';

// True while the on-screen keyboard is up. `fullHeight` is the last keyboard-down viewport height:
// some mobile browsers shrink window.innerHeight together with visualViewport.height, so comparing only
// those two CURRENT values can incorrectly produce zero. offsetTop stays deliberately excluded because
// iOS focus scrolling changes it while the keyboard remains open.
export function softKeyboardUp(fullHeight = window.innerHeight): boolean {
  const viewport = window.visualViewport;
  if (!viewport) return false;
  return Math.max(fullHeight, window.innerHeight) - viewport.height > 120;
}

// Pixels the on-screen keyboard overlaps the layout viewport's bottom. iOS Safari shrinks the
// visual viewport (not the layout viewport) when the keyboard opens, leaving bottom-docked UI
// hidden behind it; we read that overlap so the caller can shrink the app to the visible area
// (height: calc(100% - inset)), lifting the whole column above the keyboard.
// Returns 0 when there's no keyboard or when visualViewport is unsupported (safe fallback).
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const update = (): void => {
      // This is LAYOUT overlap, not keyboard presence. iOS may already scroll the visual viewport upward
      // to reveal the focused field, so offsetTop must cancel that part of our app lift. Android may shrink
      // innerHeight together with visualViewport.height, in which case the layout already fits and needs no
      // second lift. Keyboard PRESENCE deliberately uses the separate baseline-aware softKeyboardUp().
      const overlap = window.innerHeight - viewport.height - viewport.offsetTop;
      setInset(Math.max(0, Math.round(overlap)));
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}
