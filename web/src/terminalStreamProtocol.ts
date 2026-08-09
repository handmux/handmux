import type { TerminalStreamSeedFrame } from './terminalStreamMirror.js';
import type { TerminalCursor } from './terminalViewport.js';

export interface TerminalSeedMessage extends TerminalStreamSeedFrame {
  type: 'seed';
  historyLines: number;
  mouseSgr: boolean;
}

export interface TerminalReadyMessage {
  type: 'ready';
  cur: TerminalCursor;
}

export interface TerminalProbeMessage {
  type: 'probe';
  id: number;
}

export type TerminalStreamMessage = TerminalSeedMessage | TerminalReadyMessage | TerminalProbeMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum;
}

function parseCursor(value: unknown): TerminalCursor | null {
  if (!isRecord(value)
    || !isInteger(value.row)
    || !isInteger(value.col)
    || typeof value.vis !== 'boolean') return null;
  return { row: value.row, col: value.col, vis: value.vis };
}

export function parseTerminalStreamMessage(value: unknown): TerminalStreamMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'probe') {
    return isInteger(value.id, 1) ? { type: 'probe', id: value.id } : null;
  }
  if (value.type === 'ready') {
    const cur = parseCursor(value.cur);
    return cur ? { type: 'ready', cur } : null;
  }
  if (value.type !== 'seed'
    || typeof value.ansi !== 'string'
    || !isInteger(value.width, 1)
    || !isInteger(value.height, 1)
    || !isInteger(value.historyLines)
    || typeof value.alt !== 'boolean'
    || typeof value.mouseAware !== 'boolean'
    || typeof value.mouseSgr !== 'boolean') return null;
  return {
    type: 'seed',
    ansi: value.ansi,
    width: value.width,
    height: value.height,
    historyLines: value.historyLines,
    alt: value.alt,
    mouseAware: value.mouseAware,
    mouseSgr: value.mouseSgr,
  };
}
