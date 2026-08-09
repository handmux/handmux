import { useEffect, useRef } from 'react';
import { unwindHistory, useHistoryLayer } from './useBackButton.js';

interface BrowserBackStackProps {
  open: boolean;
  historyActive: boolean;
  switchTab?: (id: 'history') => unknown;
  setOpen?: (open: boolean) => unknown;
}

// Mirror Browser's two UI levels into window.history: History (root) → page (drill). The shared
// history-layer callback only consumes entries; it never pushes from popstate, keeping WebViews balanced.
export function useBrowserBackStack({
  open,
  historyActive,
  switchTab,
  setOpen,
}: BrowserBackStackProps): void {
  const depthRef = useRef(0);
  const previousHistoryActiveRef = useRef(historyActive);
  const suppressNextPopRef = useRef(false);
  const switchTabRef = useRef(switchTab);
  const setOpenRef = useRef(setOpen);
  switchTabRef.current = switchTab;
  setOpenRef.current = setOpen;

  useHistoryLayer(open, () => {
    const previousDepth = depthRef.current;
    depthRef.current = Math.max(0, previousDepth - 1);
    if (suppressNextPopRef.current) {
      suppressNextPopRef.current = false;
      return;
    }
    if (previousDepth > 1) {
      void switchTabRef.current?.('history');
    } else {
      void setOpenRef.current?.(false);
    }
  });

  useEffect(() => {
    if (!open) {
      previousHistoryActiveRef.current = historyActive;
      return undefined;
    }
    window.history.pushState({ overlay: true }, '');
    depthRef.current = 1;
    previousHistoryActiveRef.current = historyActive;
    return () => {
      if (depthRef.current > 0) unwindHistory(depthRef.current);
      depthRef.current = 0;
      suppressNextPopRef.current = false;
    };
  }, [open]); // callbacks and current level are read through refs

  useEffect(() => {
    if (!open) {
      previousHistoryActiveRef.current = historyActive;
      return;
    }
    const previous = previousHistoryActiveRef.current;
    previousHistoryActiveRef.current = historyActive;
    if (previous && !historyActive) {
      window.history.pushState({ overlay: true }, '');
      depthRef.current += 1;
    } else if (!previous && historyActive && depthRef.current > 1) {
      suppressNextPopRef.current = true;
      window.history.back();
    }
  }, [historyActive, open]);
}
