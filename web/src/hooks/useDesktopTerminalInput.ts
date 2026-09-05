import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { sendInput, sendKeys as sendKeyBatch, UnauthorizedError } from '../api.js';
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
  sendKeys?: TerminalInputQueueOptions['sendKeys'];
}

export type EnqueueDesktopTerminalInput = (
  pane: string | null | undefined,
  data: TerminalInputData | null | undefined,
) => void;

export interface TerminalInputDispatch {
  enqueueInput: EnqueueDesktopTerminalInput;
  enqueueKeys(pane: string | null | undefined, keys: readonly string[]): void;
}

export function useTerminalInput({
  enabled,
  currentPane,
  terminalRef,
  onAuthFail,
  send = sendInput,
  sendKeys = sendKeyBatch,
}: DesktopTerminalInputOptions): TerminalInputDispatch {
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
      sendKeys,
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
  }, [enabled, send, sendKeys, terminalRef]);

  const enqueueInput = useCallback<EnqueueDesktopTerminalInput>((pane, data) => {
    queueRef.current?.enqueue(pane, data);
  }, []);
  const enqueueKeys = useCallback((pane: string | null | undefined, keys: readonly string[]) => {
    queueRef.current?.enqueueKeys(pane, keys);
  }, []);
  return useMemo(() => ({ enqueueInput, enqueueKeys }), [enqueueInput, enqueueKeys]);
}

export function useDesktopTerminalInput(
  options: DesktopTerminalInputOptions,
): EnqueueDesktopTerminalInput {
  return useTerminalInput(options).enqueueInput;
}
