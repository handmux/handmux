import type { Terminal } from '@xterm/xterm';
import type { MutableRefObject } from 'react';
import { cellToPx, selectionCounts } from './terminalSelection.js';
import type { TerminalCell, TerminalCellRange } from './terminalSelection.js';

export interface TerminalSelectionUI {
  start: { x: number; y: number; ch: number };
  end: { x: number; y: number; ch: number };
  wrapW: number;
}

export interface TerminalSelectionActions {
  currentRange(): TerminalCellRange | null;
  paraLineText(row: number): string;
  selectRange(range: TerminalCellRange | null | undefined): void;
}

export interface TerminalSelectionController {
  start(x: number, y: number): void;
  extend(x: number, y: number): void;
  clear(): void;
  refresh(): void;
  dispose(): void;
}

export interface TerminalSelectionControllerOptions {
  term: Terminal;
  host: HTMLElement;
  screenHost?: HTMLElement;
  desktop: boolean;
  activeRef: MutableRefObject<boolean>;
  actionsRef: MutableRefObject<TerminalSelectionActions | null>;
  setUI: (ui: TerminalSelectionUI | null) => void;
  setInfo: (info: string) => void;
}

export function createTerminalSelectionController({
  term,
  host,
  screenHost = host,
  desktop,
  activeRef,
  actionsRef,
  setUI,
  setInfo,
}: TerminalSelectionControllerOptions): TerminalSelectionController {
  const buffer = () => term.buffer.active;
  const wrap = host.parentElement;
  if (!wrap) throw new Error('terminal selection host must have a parent');
  const viewport = screenHost.querySelector<HTMLElement>('.xterm-viewport');
  let anchor: TerminalCell | null = null;
  let dragEnd: 'start' | 'end' | null = null;
  let dragAnchorEdge: number | null = null;
  let autoScrollRAF: number | null = null;
  let lastHandlePoint: { x: number; y: number } | null = null;
  let autoDirection = 0;
  let autoStep = 0;

  const cellFromPoint = (x: number, y: number): TerminalCell | null => {
    const screen = screenHost.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || !term.cols || !term.rows) return null;
    const rect = screen.getBoundingClientRect();
    const cellWidth = rect.width / term.cols;
    const cellHeight = rect.height / term.rows;
    if (!cellWidth || !cellHeight) return null;
    return {
      col: Math.max(0, Math.min(term.cols - 1, Math.floor((x - rect.left) / cellWidth))),
      row: buffer().viewportY
        + Math.max(0, Math.min(term.rows - 1, Math.floor((y - rect.top) / cellHeight))),
    };
  };

  // xterm reports a half-open end. Keep the rest of handmux selection math inclusive.
  const cells = (): TerminalCellRange | null => {
    const position = term.getSelectionPosition?.();
    if (!position) return null;
    let endCol = position.end.x - 1;
    let endRow = position.end.y;
    if (endCol < 0) {
      endRow -= 1;
      endCol = term.cols - 1;
    }
    return {
      start: { col: position.start.x, row: position.start.y },
      end: { col: endCol, row: endRow },
    };
  };

  const refresh = (): void => {
    const selection = cells();
    const screen = screenHost.querySelector<HTMLElement>('.xterm-screen');
    if (!selection || !screen) {
      setUI(null);
      setInfo('');
      return;
    }
    const screenRect = screen.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const cellWidth = screenRect.width / term.cols;
    const cellHeight = screenRect.height / term.rows;
    const viewportY = buffer().viewportY;
    const offset = { x: screenRect.left - wrapRect.left, y: screenRect.top - wrapRect.top };
    const start = cellToPx(
      selection.start.col,
      selection.start.row,
      viewportY,
      cellWidth,
      cellHeight,
    );
    const end = cellToPx(
      selection.end.col + 1,
      selection.end.row,
      viewportY,
      cellWidth,
      cellHeight,
    );
    setUI({
      start: { x: start.x + offset.x, y: start.y + offset.y, ch: cellHeight },
      end: { x: end.x + offset.x, y: end.y + offset.y, ch: cellHeight },
      wrapW: wrapRect.width,
    });
    const text = term.getSelection();
    if (!text) {
      setInfo('');
      return;
    }
    const { lines, chars } = selectionCounts(text);
    setInfo(`复制模式 · ${lines} 行 · ${chars} 字`);
  };

  const lineText = (row: number): string => buffer().getLine(row)?.translateToString(true) ?? '';
  const selectRange = (range: TerminalCellRange | null | undefined): void => {
    if (!range) return;
    const length = (range.end.row * term.cols + range.end.col)
      - (range.start.row * term.cols + range.start.col) + 1;
    term.select(range.start.col, range.start.row, length);
    refresh();
  };
  actionsRef.current = { currentRange: cells, paraLineText: lineText, selectRange };

  const start = (x: number, y: number): void => {
    const cell = cellFromPoint(x, y);
    if (!cell) return;
    const text = buffer().getLine(cell.row)?.translateToString(false) ?? '';
    let first = cell.col;
    let last = cell.col;
    if (/\S/.test(text[cell.col] || '')) {
      while (first > 0 && /\S/.test(text[first - 1])) first -= 1;
      while (last < term.cols - 1 && /\S/.test(text[last + 1])) last += 1;
    }
    anchor = { col: first, row: cell.row };
    activeRef.current = true;
    setUI(null);
    term.select(first, cell.row, last - first + 1);
    refresh();
    navigator.vibrate?.(12);
  };

  const widthAt = (offset: number, cols: number): number => (
    buffer().getLine(Math.floor(offset / cols))?.getCell(offset % cols)?.getWidth() ?? 1
  );
  const snapLow = (offset: number, cols: number): number => (
    offset > 0 && widthAt(offset, cols) === 0 ? offset - 1 : offset
  );
  const snapHigh = (offset: number, cols: number): number => (
    widthAt(offset, cols) === 2 ? offset + 1 : offset
  );

  const extend = (x: number, y: number): void => {
    const current = cellFromPoint(x, y);
    if (!current || !anchor) return;
    const anchorOffset = anchor.row * term.cols + anchor.col;
    const currentOffset = current.row * term.cols + current.col;
    const low = snapLow(Math.min(anchorOffset, currentOffset), term.cols);
    const high = snapHigh(Math.max(anchorOffset, currentOffset), term.cols);
    term.select(low % term.cols, Math.floor(low / term.cols), high - low + 1);
    refresh();
  };

  const clear = (): void => {
    anchor = null;
    activeRef.current = false;
    setUI(null);
    setInfo('');
    term.clearSelection();
  };

  const dragSelect = (x: number, y: number): void => {
    const current = cellFromPoint(x, y);
    if (!current || dragAnchorEdge == null) return;
    const offset = current.row * term.cols + current.col;
    const dragEdge = dragEnd === 'start' ? offset : offset + 1;
    let low = Math.min(dragAnchorEdge, dragEdge);
    let high = Math.max(dragAnchorEdge, dragEdge);
    if (high <= low) high = low + 1;
    low = snapLow(low, term.cols);
    high = snapHigh(high - 1, term.cols) + 1;
    term.select(low % term.cols, Math.floor(low / term.cols), high - low);
    refresh();
  };

  const onHandleDown = (event: PointerEvent): void => {
    const handle = event.target instanceof Element
      ? event.target.closest<HTMLElement>('.sel-handle')
      : null;
    const end = handle?.dataset.end;
    if (end !== 'start' && end !== 'end') return;
    dragEnd = end;
    const selection = cells();
    if (selection) {
      const startOffset = selection.start.row * term.cols + selection.start.col;
      const endOffset = selection.end.row * term.cols + selection.end.col;
      dragAnchorEdge = dragEnd === 'start' ? endOffset + 1 : startOffset;
    } else {
      dragAnchorEdge = null;
    }
    event.preventDefault();
    event.stopPropagation();
    wrap.setPointerCapture?.(event.pointerId);
  };

  const onHandleMove = (event: PointerEvent): void => {
    if (!dragEnd || dragAnchorEdge == null || !viewport) return;
    dragSelect(event.clientX, event.clientY);
    const edge = 28;
    lastHandlePoint = { x: event.clientX, y: event.clientY };
    const rect = viewport.getBoundingClientRect();
    let over = 0;
    if (event.clientY < rect.top + edge) {
      autoDirection = -1;
      over = rect.top + edge - event.clientY;
    } else if (event.clientY > rect.bottom - edge) {
      autoDirection = 1;
      over = event.clientY - (rect.bottom - edge);
    } else {
      autoDirection = 0;
    }
    autoStep = Math.min(14, 2 + over * 0.28);
    if (autoDirection !== 0 && autoScrollRAF == null) {
      const tick = (): void => {
        if (!dragEnd || autoDirection === 0 || !lastHandlePoint) {
          autoScrollRAF = null;
          return;
        }
        const before = viewport.scrollTop;
        viewport.scrollTop = before + autoDirection * autoStep;
        dragSelect(lastHandlePoint.x, lastHandlePoint.y);
        if (viewport.scrollTop === before) {
          autoScrollRAF = null;
          return;
        }
        autoScrollRAF = requestAnimationFrame(tick);
      };
      autoScrollRAF = requestAnimationFrame(tick);
    } else if (autoDirection === 0 && autoScrollRAF != null) {
      cancelAnimationFrame(autoScrollRAF);
      autoScrollRAF = null;
    }
    event.preventDefault();
  };

  const onHandleUp = (event: PointerEvent): void => {
    if (!dragEnd) return;
    dragEnd = null;
    dragAnchorEdge = null;
    autoDirection = 0;
    if (autoScrollRAF != null) {
      cancelAnimationFrame(autoScrollRAF);
      autoScrollRAF = null;
    }
    wrap.releasePointerCapture?.(event.pointerId);
  };
  const onViewportScroll = (): void => {
    if (!desktop && activeRef.current) refresh();
  };

  wrap.addEventListener('pointerdown', onHandleDown, { capture: true });
  wrap.addEventListener('pointermove', onHandleMove, { capture: true });
  wrap.addEventListener('pointerup', onHandleUp, { capture: true });
  wrap.addEventListener('pointercancel', onHandleUp, { capture: true });
  viewport?.addEventListener('scroll', onViewportScroll, { passive: true });

  return {
    start,
    extend,
    clear,
    refresh,
    dispose() {
      if (autoScrollRAF != null) cancelAnimationFrame(autoScrollRAF);
      wrap.removeEventListener('pointerdown', onHandleDown, { capture: true });
      wrap.removeEventListener('pointermove', onHandleMove, { capture: true });
      wrap.removeEventListener('pointerup', onHandleUp, { capture: true });
      wrap.removeEventListener('pointercancel', onHandleUp, { capture: true });
      viewport?.removeEventListener('scroll', onViewportScroll);
      actionsRef.current = null;
    },
  };
}
