import { useState, useRef, useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';

export interface TerminalFlashState {
  dbg: string;
  dbgVisible: boolean;
  flash(): void;
}

// The transient cols×rows·font readout that flashes for ~3s after a ⊟/⊞ column step (App calls flash()
// through the terminal's imperative handle). Fully self-contained and component-scope — it never touched
// the poll/gesture/selection machinery in Terminal's main effect. It polls the size briefly because
// term.cols only catches up on the next ~1s refresh. `termRef` is Terminal's xterm ref.
export function useFlash(
  termRef: MutableRefObject<Terminal | null>,
): TerminalFlashState {
  const [dbg, setDbg] = useState('');          // cols×rows·font readout
  const [dbgVisible, setDbgVisible] = useState(false);
  const flashHideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => {
    if (flashHideRef.current != null) clearTimeout(flashHideRef.current);
    if (flashPollRef.current != null) clearInterval(flashPollRef.current);
  }, []);

  const flash = () => {
    const read = () => {
      const term = termRef.current;
      if (term) setDbg(`${term.cols}×${term.rows} · ${term.options.fontSize}px`);
    };
    read();
    setDbgVisible(true);
    if (flashHideRef.current != null) clearTimeout(flashHideRef.current);
    if (flashPollRef.current != null) clearInterval(flashPollRef.current);
    flashPollRef.current = setInterval(read, 400);
    flashHideRef.current = setTimeout(() => {
      setDbgVisible(false);
      if (flashPollRef.current != null) clearInterval(flashPollRef.current);
    }, 3000);
  };

  return { dbg, dbgVisible, flash };
}
