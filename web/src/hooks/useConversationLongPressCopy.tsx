import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { t } from '../i18n';
import { useBackButton } from './useBackButton.js';

const LONG_PRESS_MS = 480;
const MOVE_SLOP_PX = 10;
const CALLOUT_WIDTH_PX = 72;

export interface ConversationCopyBlock {
  el: HTMLElement;
  text: string;
}

interface CopyUI {
  top: number;
  left: number;
  text: string;
}

interface LongPressState {
  timer: ReturnType<typeof setTimeout> | null;
  x: number;
  y: number;
  fired: boolean;
}

export function useConversationLongPressCopy({
  viewRef,
  resolveBlock,
  resetKey,
  onPointerDown,
  onPointerMove,
}: {
  viewRef: RefObject<HTMLElement | null>;
  resolveBlock: (target: EventTarget | null) => ConversationCopyBlock | null;
  resetKey: string | null;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const [copyUI, setCopyUI] = useState<CopyUI | null>(null);
  const highlightRef = useRef<HTMLElement | null>(null);
  const pressRef = useRef<LongPressState>({ timer: null, x: 0, y: 0, fired: false });

  const clearHighlight = useCallback((): void => {
    highlightRef.current?.classList.remove('chat-copy-hl');
    highlightRef.current = null;
  }, []);
  const dismiss = useCallback((): void => {
    clearHighlight();
    setCopyUI(null);
  }, [clearHighlight]);
  const cancel = useCallback((): void => {
    const press = pressRef.current;
    if (!press.timer) return;
    window.clearTimeout(press.timer);
    press.timer = null;
  }, []);

  useBackButton(copyUI != null, dismiss);
  useEffect(() => cancel, [cancel]);
  useEffect(() => {
    cancel();
    pressRef.current.fired = false;
    dismiss();
  }, [cancel, dismiss, resetKey]);

  const fire = useCallback((x: number, y: number, target: EventTarget | null): void => {
    pressRef.current.timer = null;
    const block = resolveBlock(target);
    const view = viewRef.current;
    if (!block || !block.text.trim() || !view) return;
    pressRef.current.fired = true;
    navigator.vibrate?.(12);
    block.el.classList.add('chat-copy-hl');
    highlightRef.current = block.el;
    const viewRect = view.getBoundingClientRect();
    const blockRect = block.el.getBoundingClientRect();
    const left = Math.max(8, Math.min(
      x - viewRect.left - CALLOUT_WIDTH_PX / 2,
      viewRect.width - CALLOUT_WIDTH_PX - 8,
    ));
    const above = blockRect.top - viewRect.top - 44;
    const top = above < 4
      ? Math.min(blockRect.bottom - viewRect.top + 8, viewRect.height - 52) : above;
    setCopyUI({ top, left, text: block.text });
  }, [resolveBlock, viewRef]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest('.chat-copy-callout')) return;
    dismiss();
    pressRef.current.fired = false;
    onPointerDown?.(event);
    if (event.pointerType === 'mouse') return;
    const press = pressRef.current;
    press.x = Number.isFinite(event.clientX) ? event.clientX : 0;
    press.y = Number.isFinite(event.clientY) ? event.clientY : 0;
    const { target } = event;
    cancel();
    press.timer = window.setTimeout(() => fire(press.x, press.y, target), LONG_PRESS_MS);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest('.chat-copy-callout')) return;
    onPointerMove?.(event);
    const press = pressRef.current;
    if (press.timer && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_SLOP_PX) {
      cancel();
    }
  };
  const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest('.chat-copy-callout')) return;
    if (!pressRef.current.fired) return;
    pressRef.current.fired = false;
    event.stopPropagation();
    event.preventDefault();
  };
  const copy = async (): Promise<void> => {
    if (!copyUI) return;
    try {
      await navigator.clipboard.writeText(copyUI.text);
      navigator.vibrate?.(8);
    } catch { /* clipboard unavailable or denied */ }
    dismiss();
  };

  return {
    active: copyUI != null,
    calloutStyle: copyUI ? { top: copyUI.top, left: copyUI.left } : null,
    cancel,
    dismiss,
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onClickCapture: handleClickCapture,
    copy,
  };
}

export function ConversationCopyCallout({
  style,
  onCopy,
}: {
  style: { top: number; left: number };
  onCopy: () => void;
}) {
  return (
    <div className="sel-callout chat-copy-callout" style={style}
      onPointerDown={(event) => event.preventDefault()}>
      <button type="button" onClick={onCopy}>{t('common.copy')}</button>
    </div>
  );
}
