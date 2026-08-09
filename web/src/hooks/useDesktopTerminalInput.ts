import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { sendInput, UnauthorizedError } from '../api.js';
import {
  createTerminalInputQueue,
  type TerminalInputData,
  type TerminalInputQueue,
  type TerminalInputQueueOptions,
} from '../terminalInputQueue.js';

export interface DesktopTerminalHandle {
  wake?(): void;
  inputFailed?(error: unknown): void;
}

export interface DesktopTerminalInputOptions {
  enabled: boolean;
  currentPane?: string | null;
  terminalRef: RefObject<DesktopTerminalHandle | null>;
  onAuthFail?: () => void;
  send?: TerminalInputQueueOptions['send'];
}

export type EnqueueDesktopTerminalInput = (
  pane: string | null | undefined,
  data: TerminalInputData | null | undefined,
) => void;

export function useDesktopTerminalInput({
  enabled,
  currentPane,
  terminalRef,
  onAuthFail,
  send = sendInput,
}: DesktopTerminalInputOptions): EnqueueDesktopTerminalInput {
  const queueRef = useRef<TerminalInputQueue | null>(null);
  const currentPaneRef = useRef(currentPane);
  const onAuthFailRef = useRef(onAuthFail);
  currentPaneRef.current = currentPane;
  onAuthFailRef.current = onAuthFail;

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    const queue = createTerminalInputQueue({
      send,
      onDelivered: (pane) => {
        if (!disposed && pane === currentPaneRef.current) terminalRef.current?.wake?.();
      },
      onError: (error, pane) => {
        if (disposed) return;
        if (error instanceof UnauthorizedError) {
          onAuthFailRef.current?.();
        } else if (pane === currentPaneRef.current) {
          terminalRef.current?.inputFailed?.(error);
        }
      },
    });
    queueRef.current = queue;
    return () => {
      disposed = true;
      queueRef.current = null;
      queue.dispose();
    };
  }, [enabled, send, terminalRef]);

  return useCallback((pane, data) => {
    queueRef.current?.enqueue(pane, data);
  }, []);
}
