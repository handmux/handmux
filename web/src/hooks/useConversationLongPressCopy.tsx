import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import {
  characterRect,
  conversationTextMap,
  copyTextForRange,
  domRangeForOffsets,
  normalizedOffsetRange,
  paragraphRange,
  textOffsetAtPoint,
  visualLineFlowRange,
  visualLineRange,
  wordRangeAt,
  type TextOffsetRange,
} from '../conversationSelection.js';
import { t } from '../i18n';
import { useBackButton } from './useBackButton.js';

const LONG_PRESS_MS = 480;
const MOVE_SLOP_PX = 10;
const EDGE_SCROLL_PX = 36;

export interface ConversationCopyBlock {
  el: HTMLElement;
  id: string;
}

interface HandleUI {
  x: number;
  y: number;
  h: number;
  visible: boolean;
}

interface CopyUI {
  start: HandleUI;
  end: HandleUI;
  callout: { top: number; left: number; maxWidth: number };
}

interface SelectionModel extends TextOffsetRange {
  rootId: string;
  selectedText: string;
  preserveStructure: boolean;
}

interface LongPressState {
  timer: ReturnType<typeof setTimeout> | null;
  x: number;
  y: number;
  target: EventTarget | null;
  pointerId: number | null;
  captureTarget: Element | null;
}

interface DragState {
  mode: 'handle' | 'initial-word';
  fixedOffset: number;
  initialRange: TextOffsetRange | null;
  touchIdentifier: number | null;
  pointerId: number;
  captureTarget: Element;
  point: { x: number; y: number };
  scroller: HTMLElement;
  direction: number;
  step: number;
}

interface PendingOutsideTap {
  owner: 'view' | 'document';
  pointerId: number;
  x: number;
  y: number;
}

const sameUI = (left: CopyUI | null, right: CopyUI): boolean => !!left
  && left.start.x === right.start.x && left.start.y === right.start.y
  && left.start.h === right.start.h && left.start.visible === right.start.visible
  && left.end.x === right.end.x && left.end.y === right.end.y
  && left.end.h === right.end.h && left.end.visible === right.end.visible
  && left.callout.left === right.callout.left && left.callout.top === right.callout.top
  && left.callout.maxWidth === right.callout.maxWidth;

function copyRootById(view: HTMLElement, id: string): HTMLElement | null {
  return Array.from(view.querySelectorAll<HTMLElement>('[data-conversation-copy-root]'))
    .find((candidate) => candidate.dataset.conversationCopyId === id) ?? null;
}

const SCROLL_SURFACE = [
  '.chat-scroll', '.tool-sheet-body', '.tool-sheet-cmd', '.chat-tool-body',
  '.chat-diff', '.es-diff', '.dv',
].join(', ');

function scrollSurfaces(root: HTMLElement, fallback: HTMLElement | null): HTMLElement[] {
  const candidates: HTMLElement[] = [];
  let current: HTMLElement | null = root;
  while (current) {
    if (current.matches(SCROLL_SURFACE)) candidates.push(current);
    current = current.parentElement;
  }
  if (fallback?.contains(root) && !candidates.includes(fallback)) candidates.push(fallback);
  return candidates;
}

function scrollContainer(root: HTMLElement, fallback: HTMLElement | null): HTMLElement {
  const candidates = scrollSurfaces(root, fallback);
  return candidates.find((candidate) => candidate.scrollHeight > candidate.clientHeight + 1)
    ?? candidates[0] ?? root;
}

function intersectRect(left: DOMRect, right: DOMRect): DOMRect {
  const x = Math.max(left.left, right.left);
  const y = Math.max(left.top, right.top);
  const edgeX = Math.min(left.right, right.right);
  const edgeY = Math.min(left.bottom, right.bottom);
  return {
    x, y, left: x, top: y,
    right: Math.max(x, edgeX), bottom: Math.max(y, edgeY),
    width: Math.max(0, edgeX - x), height: Math.max(0, edgeY - y),
    toJSON: () => ({}),
  } as DOMRect;
}

export function useConversationLongPressCopy({
  viewRef,
  scrollRef,
  resolveBlock,
  resetKey,
  restoreKey,
  onActivate,
  onPointerDown,
  onPointerMove,
}: {
  viewRef: RefObject<HTMLElement | null>;
  scrollRef?: RefObject<HTMLElement | null>;
  resolveBlock: (target: EventTarget | null) => ConversationCopyBlock | null;
  resetKey: string | null;
  restoreKey?: unknown;
  onActivate?: () => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const [copyUI, setCopyUI] = useState<CopyUI | null>(null);
  const modelRef = useRef<SelectionModel | null>(null);
  const activeRef = useRef(false);
  const pressRef = useRef<LongPressState>({
    timer: null, x: 0, y: 0, target: null, pointerId: null, captureTarget: null,
  });
  const dragRef = useRef<DragState | null>(null);
  const touchIdentifierRef = useRef<number | null>(null);
  const multiTouchBlockedRef = useRef(false);
  const pendingOutsideRef = useRef<PendingOutsideTap | null>(null);
  const autoScrollRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const calloutRef = useRef<HTMLDivElement>(null);

  const cancel = useCallback((): void => {
    const press = pressRef.current;
    if (press.timer != null) window.clearTimeout(press.timer);
    press.timer = null;
    press.pointerId = null;
    press.captureTarget = null;
  }, []);

  const stopAutoScroll = useCallback((): void => {
    if (autoScrollRef.current != null) cancelAnimationFrame(autoScrollRef.current);
    autoScrollRef.current = null;
    if (dragRef.current) dragRef.current.direction = 0;
  }, []);

  const finishDrag = useCallback(({
    releaseCapture = true,
  }: { releaseCapture?: boolean } = {}): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    stopAutoScroll();
    if (drag?.mode === 'initial-word') touchIdentifierRef.current = null;
    if (!drag || !releaseCapture) return;
    try {
      drag.captureTarget.releasePointerCapture?.(drag.pointerId);
    } catch { /* capture may already have been released by the browser */ }
  }, [stopAutoScroll]);

  const clearNativeSelection = useCallback((): void => {
    viewRef.current?.ownerDocument.getSelection()?.removeAllRanges();
  }, [viewRef]);

  const dismiss = useCallback((): void => {
    cancel();
    finishDrag();
    suppressClickRef.current = false;
    pendingOutsideRef.current = null;
    modelRef.current = null;
    activeRef.current = false;
    viewRef.current?.classList.remove('chat-copy-active');
    clearNativeSelection();
    setCopyUI(null);
  }, [cancel, clearNativeSelection, finishDrag, viewRef]);

  const refresh = useCallback((validateText = true): boolean => {
    const view = viewRef.current;
    const model = modelRef.current;
    if (!view || !model) return false;
    const root = copyRootById(view, model.rootId);
    if (!root) {
      dismiss();
      return false;
    }
    const map = conversationTextMap(root);
    if (model.end > map.text.length
      || (validateText && map.text.slice(model.start, model.end) !== model.selectedText)) {
      dismiss();
      return false;
    }
    const range = domRangeForOffsets(root, model, map);
    if (!range) {
      dismiss();
      return false;
    }
    const selection = root.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const viewRect = view.getBoundingClientRect();
    const baseSurface = root.closest<HTMLElement>('.tool-sheet')?.getBoundingClientRect() ?? viewRect;
    const surfaceRect = scrollSurfaces(root, scrollRef?.current ?? null)
      .reduce((current, scroller) => intersectRect(current, scroller.getBoundingClientRect()), baseSurface);
    const layoutRects = typeof range.getClientRects === 'function'
      ? Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
      : [];
    const first = characterRect(root, model.start, map) ?? layoutRects[0] ?? null;
    const last = characterRect(root, Math.max(model.start, model.end - 1), map)
      ?? layoutRects.at(-1) ?? null;
    const visibleTop = Math.max(surfaceRect.top, 0);
    const visibleBottom = Math.min(
      surfaceRect.bottom,
      window.innerHeight || surfaceRect.bottom,
    );
    const handle = (rect: DOMRect | null, edge: 'left' | 'right'): HandleUI => rect ? ({
      x: rect[edge],
      y: rect.top,
      h: Math.max(1, rect.height),
      visible: rect.bottom >= visibleTop && rect.top <= visibleBottom
        && rect.right >= surfaceRect.left && rect.left <= surfaceRect.right,
    }) : ({ x: 0, y: 0, h: 1, visible: false });
    const start = handle(first, 'left');
    const end = handle(last, 'right');
    const firstAnchor = first ?? last;
    const lastAnchor = last ?? first;
    const topEdge = visibleTop + 4;
    const bottomEdge = Math.max(topEdge, visibleBottom - 44);
    const selectedTop = firstAnchor && lastAnchor
      ? Math.max(topEdge, Math.min(firstAnchor.top, lastAnchor.top)) : topEdge;
    const selectedBottom = firstAnchor && lastAnchor
      ? Math.min(bottomEdge, Math.max(firstAnchor.bottom, lastAnchor.bottom)) : topEdge;
    const above = selectedTop - 44;
    const calloutTop = Math.max(topEdge, Math.min(
      above >= topEdge ? above : selectedBottom + 8,
      bottomEdge,
    ));
    const measuredWidth = Math.min(
      calloutRef.current?.getBoundingClientRect().width ?? 0,
      Math.max(0, surfaceRect.width - 16),
    );
    const calloutLeft = Math.max(surfaceRect.left + 8, Math.min(
      firstAnchor && lastAnchor
        ? Math.min(firstAnchor.left, lastAnchor.right) : surfaceRect.left + 8,
      Math.max(surfaceRect.left + 8, surfaceRect.right - measuredWidth - 8),
    ));
    const next = {
      start,
      end,
      callout: { top: calloutTop, left: calloutLeft, maxWidth: Math.max(0, surfaceRect.width - 16) },
    };
    setCopyUI((current) => sameUI(current, next) ? current : next);
    return true;
  }, [dismiss, scrollRef, viewRef]);

  const select = useCallback((
    root: HTMLElement,
    rootId: string,
    next: TextOffsetRange,
    preserveStructure = false,
  ): void => {
    const map = conversationTextMap(root);
    const start = Math.max(0, Math.min(map.text.length, next.start));
    const end = Math.max(start, Math.min(map.text.length, next.end));
    if (end <= start) return;
    modelRef.current = {
      rootId,
      start,
      end,
      selectedText: map.text.slice(start, end),
      preserveStructure,
    };
    activeRef.current = true;
    viewRef.current?.classList.add('chat-copy-active');
    refresh(false);
  }, [refresh, viewRef]);

  const fire = useCallback((): void => {
    const press = pressRef.current;
    press.timer = null;
    const pointerId = press.pointerId;
    const captureTarget = press.captureTarget;
    press.pointerId = null;
    press.captureTarget = null;
    const block = resolveBlock(press.target);
    if (!block || !viewRef.current || pointerId == null || !captureTarget) return;
    const map = conversationTextMap(block.el);
    const offset = textOffsetAtPoint(block.el, press.x, press.y, press.target);
    const initial = offset == null ? null : wordRangeAt(map.text, offset);
    if (!initial) return;
    suppressClickRef.current = true;
    onActivate?.();
    select(block.el, block.id, initial);
    dragRef.current = {
      mode: 'initial-word',
      fixedOffset: initial.start,
      initialRange: initial,
      touchIdentifier: touchIdentifierRef.current,
      pointerId,
      captureTarget,
      point: { x: press.x, y: press.y },
      scroller: scrollContainer(block.el, scrollRef?.current ?? null),
      direction: 0,
      step: 0,
    };
    try {
      captureTarget.setPointerCapture?.(pointerId);
    } catch { /* selection still works when pointer capture is unavailable */ }
    navigator.vibrate?.(12);
  }, [onActivate, resolveBlock, scrollRef, select, viewRef]);

  const updateDrag = useCallback((x: number, y: number): void => {
    const drag = dragRef.current;
    const view = viewRef.current;
    const model = modelRef.current;
    if (!drag || !view || !model) return;
    const root = copyRootById(view, model.rootId);
    if (!root) return;
    const scrollerRect = drag.scroller.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const minY = Math.max(rootRect.top + 1, scrollerRect.top + 1);
    const maxY = Math.min(rootRect.bottom - 1, scrollerRect.bottom - 1);
    const pointX = Math.max(rootRect.left + 1, Math.min(rootRect.right - 1, x));
    const pointY = minY <= maxY ? Math.max(minY, Math.min(maxY, y)) : y;
    let offset = textOffsetAtPoint(root, pointX, pointY);
    const map = conversationTextMap(root);
    if (offset == null) {
      offset = y <= rootRect.top ? 0 : y >= rootRect.bottom ? map.text.length : null;
    }
    if (offset == null) return;
    let next: TextOffsetRange | null;
    if (drag.mode === 'initial-word' && drag.initialRange) {
      const initial = drag.initialRange;
      if (offset < initial.start) {
        next = normalizedOffsetRange(initial.end, offset, map.text.length);
      } else if (offset >= initial.end) {
        next = normalizedOffsetRange(
          initial.start,
          Math.min(map.text.length, offset + 1),
          map.text.length,
        );
      } else {
        next = initial;
      }
    } else {
      // Once a handle crosses the fixed edge, the finger naturally becomes the opposite endpoint.
      // Select the character under the finger on either side: its left edge below the anchor, right edge above.
      const draggedEdge = offset < drag.fixedOffset ? offset : Math.min(map.text.length, offset + 1);
      next = normalizedOffsetRange(drag.fixedOffset, draggedEdge, map.text.length);
    }
    if (next) select(root, model.rootId, next, model.preserveStructure);
  }, [select, viewRef]);

  const startAutoScroll = useCallback((): void => {
    if (autoScrollRef.current != null) return;
    const tick = (): void => {
      const drag = dragRef.current;
      if (!drag || drag.direction === 0) {
        autoScrollRef.current = null;
        return;
      }
      const before = drag.scroller.scrollTop;
      drag.scroller.scrollTop += drag.direction * drag.step;
      updateDrag(drag.point.x, drag.point.y);
      if (drag.scroller.scrollTop === before) {
        autoScrollRef.current = null;
        return;
      }
      autoScrollRef.current = requestAnimationFrame(tick);
    };
    autoScrollRef.current = requestAnimationFrame(tick);
  }, [updateDrag]);

  const moveDrag = useCallback((x: number, y: number): void => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.point = { x, y };
    updateDrag(x, y);
    const rect = drag.scroller.getBoundingClientRect();
    let over = 0;
    if (y < rect.top + EDGE_SCROLL_PX) {
      drag.direction = -1;
      over = rect.top + EDGE_SCROLL_PX - y;
    } else if (y > rect.bottom - EDGE_SCROLL_PX) {
      drag.direction = 1;
      over = y - (rect.bottom - EDGE_SCROLL_PX);
    } else {
      drag.direction = 0;
    }
    drag.step = Math.min(16, 2 + over * .3);
    if (drag.direction) startAutoScroll();
    else stopAutoScroll();
  }, [startAutoScroll, stopAutoScroll, updateDrag]);

  useBackButton(copyUI != null, dismiss);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return undefined;
    const passiveOptions: AddEventListenerOptions = { passive: true };
    const blockingOptions: AddEventListenerOptions = { passive: false };
    const onlyTouch = (touches: TouchList): Touch | null => touches.length === 1
      ? touches.item(0) : null;
    const includesTouch = (touches: TouchList, identifier: number): boolean => Array.from(touches)
      .some((touch) => touch.identifier === identifier);
    const onTouchStart = (event: TouchEvent): void => {
      const touch = onlyTouch(event.touches);
      const drag = dragRef.current;
      if (!touch) {
        cancel();
        if (drag?.mode === 'initial-word') finishDrag();
        touchIdentifierRef.current = null;
        pendingOutsideRef.current = null;
        multiTouchBlockedRef.current = true;
        return;
      }
      if (drag?.mode === 'initial-word') {
        if (drag.touchIdentifier !== touch.identifier) finishDrag();
        return;
      }
      if (!multiTouchBlockedRef.current) touchIdentifierRef.current = touch.identifier;
    };
    const onTouchMove = (event: TouchEvent): void => {
      const drag = dragRef.current;
      if (drag?.mode === 'initial-word') {
        const touch = onlyTouch(event.touches);
        if (!touch || drag.touchIdentifier == null
          || touch.identifier !== drag.touchIdentifier) {
          finishDrag();
          return;
        }
        event.preventDefault();
        moveDrag(touch.clientX, touch.clientY);
        return;
      }
      const press = pressRef.current;
      if (press.timer == null) return;
      const touch = onlyTouch(event.touches);
      const identifier = touchIdentifierRef.current;
      if (!touch || (identifier != null && touch.identifier !== identifier)) {
        cancel();
        return;
      }
      if (Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > MOVE_SLOP_PX) cancel();
    };
    const endTouch = (event: TouchEvent): void => {
      if (event.touches.length === 0) multiTouchBlockedRef.current = false;
      const drag = dragRef.current;
      const identifier = drag?.mode === 'initial-word'
        ? drag.touchIdentifier : touchIdentifierRef.current;
      if (identifier != null && !includesTouch(event.changedTouches, identifier)) return;
      if (identifier == null && event.touches.length > 0) return;
      cancel();
      if (drag?.mode === 'initial-word') finishDrag();
      touchIdentifierRef.current = null;
    };
    view.addEventListener('touchstart', onTouchStart, passiveOptions);
    view.addEventListener('touchmove', onTouchMove, blockingOptions);
    view.addEventListener('touchend', endTouch, passiveOptions);
    view.addEventListener('touchcancel', endTouch, passiveOptions);
    return () => {
      view.removeEventListener('touchstart', onTouchStart, passiveOptions);
      view.removeEventListener('touchmove', onTouchMove, blockingOptions);
      view.removeEventListener('touchend', endTouch, passiveOptions);
      view.removeEventListener('touchcancel', endTouch, passiveOptions);
      multiTouchBlockedRef.current = false;
    };
  }, [cancel, finishDrag, moveDrag, viewRef]);
  useEffect(() => () => {
    cancel();
    finishDrag();
    clearNativeSelection();
  }, [cancel, clearNativeSelection, finishDrag]);
  useEffect(() => {
    suppressClickRef.current = false;
    dismiss();
  }, [dismiss, resetKey]);
  useLayoutEffect(() => {
    if (activeRef.current) refresh(true);
  }, [refresh, restoreKey]);
  useLayoutEffect(() => {
    if (copyUI && calloutRef.current) refresh(true);
  }, [copyUI, refresh]);
  useEffect(() => {
    if (!copyUI) return undefined;
    const onResize = (): void => { refresh(true); };
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, [copyUI, refresh]);
  useEffect(() => {
    if (!copyUI) return undefined;
    const view = viewRef.current;
    const doc = view?.ownerDocument;
    if (!view || !doc) return undefined;
    const outside = (target: EventTarget | null): boolean => target instanceof Node
      && !view.contains(target)
      && !(target instanceof Element && target.closest('.conversation-copy-overlay'));
    const onDocumentPointerDown = (event: PointerEvent): void => {
      const staleDrag = dragRef.current;
      if (staleDrag?.mode === 'initial-word') {
        const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : 0;
        finishDrag({ releaseCapture: pointerId !== staleDrag.pointerId });
      }
      if (!outside(event.target)) return;
      pendingOutsideRef.current = {
        owner: 'document',
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
    };
    const onDocumentPointerMove = (event: PointerEvent): void => {
      const pending = pendingOutsideRef.current;
      if (pending && pending.pointerId === event.pointerId
        && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > MOVE_SLOP_PX) {
        pendingOutsideRef.current = null;
      }
    };
    const onDocumentPointerUp = (event: PointerEvent): void => {
      const pending = pendingOutsideRef.current;
      if (!pending || pending.owner !== 'document' || pending.pointerId !== event.pointerId) return;
      pendingOutsideRef.current = null;
      dismiss();
    };
    const clearDocumentPointer = (): void => { pendingOutsideRef.current = null; };
    doc.addEventListener('pointerdown', onDocumentPointerDown, true);
    doc.addEventListener('pointermove', onDocumentPointerMove, true);
    doc.addEventListener('pointerup', onDocumentPointerUp, true);
    doc.addEventListener('pointercancel', clearDocumentPointer, true);
    doc.addEventListener('scroll', clearDocumentPointer, true);
    return () => {
      doc.removeEventListener('pointerdown', onDocumentPointerDown, true);
      doc.removeEventListener('pointermove', onDocumentPointerMove, true);
      doc.removeEventListener('pointerup', onDocumentPointerUp, true);
      doc.removeEventListener('pointercancel', clearDocumentPointer, true);
      doc.removeEventListener('scroll', clearDocumentPointer, true);
    };
  }, [copyUI, dismiss, finishDrag, viewRef]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target instanceof Element ? event.target : null;
    const eventPointerId = Number.isFinite(event.pointerId) ? event.pointerId : 0;
    const currentDrag = dragRef.current;
    if (currentDrag?.mode === 'initial-word') {
      // Any new pointerdown means the original hold ended even when its terminal event was lost.
      // Releasing a reused id here could drop the new gesture's implicit browser capture.
      finishDrag({ releaseCapture: eventPointerId !== currentDrag.pointerId });
    }
    if (event.pointerType === 'touch' && multiTouchBlockedRef.current) {
      cancel();
      pendingOutsideRef.current = null;
      return;
    }
    if (target?.closest('.chat-copy-callout')) return;
    const handleTarget = target?.closest<HTMLElement>('.chat-copy-handle') ?? null;
    const endpoint = handleTarget?.dataset.end;
    const model = modelRef.current;
    const view = viewRef.current;
    if (handleTarget && (endpoint === 'start' || endpoint === 'end') && model && view) {
      const root = copyRootById(view, model.rootId);
      if (!root) return;
      finishDrag();
      dragRef.current = {
        mode: 'handle',
        fixedOffset: endpoint === 'start' ? model.end : model.start,
        initialRange: null,
        touchIdentifier: null,
        pointerId: eventPointerId,
        captureTarget: handleTarget,
        point: { x: event.clientX, y: event.clientY },
        scroller: scrollContainer(root, scrollRef?.current ?? null),
        direction: 0,
        step: 0,
      };
      suppressClickRef.current = true;
      try {
        handleTarget.setPointerCapture?.(eventPointerId);
      } catch { /* drag remains available without pointer capture */ }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (activeRef.current) {
      onPointerDown?.(event);
      const block = resolveBlock(event.target);
      const selected = modelRef.current;
      const offset = block && selected?.rootId === block.id
        ? textOffsetAtPoint(block.el, event.clientX, event.clientY, event.target) : null;
      if (offset == null || !selected || offset < selected.start || offset >= selected.end) {
        pendingOutsideRef.current = {
          owner: 'view',
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        };
      } else {
        suppressClickRef.current = true;
        event.preventDefault();
      }
      return;
    }
    onPointerDown?.(event);
    if (event.pointerType === 'mouse') return;
    cancel();
    pressRef.current = {
      timer: window.setTimeout(fire, LONG_PRESS_MS),
      x: Number.isFinite(event.clientX) ? event.clientX : 0,
      y: Number.isFinite(event.clientY) ? event.clientY : 0,
      target: event.target,
      pointerId: eventPointerId,
      captureTarget: event.target instanceof Element ? event.target : event.currentTarget,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag) {
      const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : 0;
      if (drag.pointerId !== pointerId) return;
      moveDrag(event.clientX, event.clientY);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onPointerMove?.(event);
    const pending = pendingOutsideRef.current;
    if (pending && pending.pointerId === event.pointerId
      && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > MOVE_SLOP_PX) {
      pendingOutsideRef.current = null;
    }
    const press = pressRef.current;
    if (press.timer != null
      && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_SLOP_PX) cancel();
  };

  const endPointer = (
    event: ReactPointerEvent<HTMLDivElement>,
    commitOutsideTap: boolean,
  ): void => {
    cancel();
    const drag = dragRef.current;
    if (drag) {
      const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : 0;
      if (drag.pointerId !== pointerId) return;
      finishDrag();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const pending = pendingOutsideRef.current;
    pendingOutsideRef.current = null;
    if (commitOutsideTap && pending?.owner === 'view' && pending.pointerId === event.pointerId) {
      dismiss();
      suppressClickRef.current = true;
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest('.chat-copy-callout')) return;
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.stopPropagation();
    event.preventDefault();
  };

  const onScroll = (): void => {
    cancel();
    pendingOutsideRef.current = null;
    if (activeRef.current) refresh(true);
  };

  const expandLine = (): void => {
    const view = viewRef.current;
    const model = modelRef.current;
    if (!view || !model) return;
    const root = copyRootById(view, model.rootId);
    if (!root) return;
    const map = conversationTextMap(root);
    const next = visualLineRange(
      model,
      map.text.length,
      (offset) => characterRect(root, offset, map),
      (offset) => visualLineFlowRange(root, offset, map),
    );
    select(root, model.rootId, next, true);
  };

  const expandParagraph = (): void => {
    const view = viewRef.current;
    const model = modelRef.current;
    if (!view || !model) return;
    const root = copyRootById(view, model.rootId);
    if (!root) return;
    select(root, model.rootId, paragraphRange(root, model), true);
  };

  const copy = async (): Promise<void> => {
    const view = viewRef.current;
    const model = modelRef.current;
    if (!view || !model) return;
    const root = copyRootById(view, model.rootId);
    const range = root ? domRangeForOffsets(root, model) : null;
    if (!range) return;
    try {
      await navigator.clipboard.writeText(copyTextForRange(range, model.preserveStructure));
      navigator.vibrate?.(8);
    } catch { /* clipboard unavailable or denied */ }
    dismiss();
  };

  return {
    active: copyUI != null,
    ui: copyUI,
    calloutRef,
    cancel,
    dismiss,
    refresh,
    onScroll,
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => endPointer(event, true),
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => endPointer(event, false),
    onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => endPointer(event, false),
    onClickCapture: handleClickCapture,
    copy,
    expandLine,
    expandParagraph,
  };
}

export function ConversationCopyControls({
  ui,
  calloutRef,
  onCopy,
  onLine,
  onParagraph,
}: {
  ui: CopyUI;
  calloutRef: RefObject<HTMLDivElement>;
  onCopy: () => void;
  onLine: () => void;
  onParagraph: () => void;
}) {
  const handleStyle = (handle: HandleUI): CSSProperties => ({
    left: handle.x,
    top: handle.y,
    '--h': `${handle.h}px`,
    visibility: handle.visible ? 'visible' : 'hidden',
  } as CSSProperties);
  return (
    <>
      <div className="sel-handle sel-handle--start chat-copy-handle"
        data-end="start" style={handleStyle(ui.start)} />
      <div className="sel-handle sel-handle--end chat-copy-handle"
        data-end="end" style={handleStyle(ui.end)} />
      <div className="sel-callout chat-copy-callout" style={ui.callout} ref={calloutRef}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}>
        <button type="button" onClick={onCopy}>{t('common.copy')}</button>
        <button type="button" onClick={onLine}>{t('conversationCopy.line')}</button>
        <button type="button" onClick={onParagraph}>{t('conversationCopy.paragraph')}</button>
      </div>
    </>
  );
}
