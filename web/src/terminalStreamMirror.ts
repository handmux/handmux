import { Terminal as XTerm } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { cursorSeq, prepareLiveSeed } from './terminalSeed.js';
import type { TerminalCursor } from './terminalViewport.js';

const DEFAULT_RENDER_SCROLLBACK = 100;
const MAX_TRAILING_BLANK_ROWS = 3;

interface MirrorBufferCell {
  getChars(): string;
  isAttributeDefault(): boolean;
}

interface MirrorBufferLine {
  getCell(column: number): MirrorBufferCell | undefined;
}

interface MirrorBuffer {
  readonly type: 'normal' | 'alternate';
  readonly length: number;
  readonly baseY: number;
  readonly cursorY: number;
  readonly cursorX: number;
  getLine(line: number): MirrorBufferLine | undefined;
}

interface MirrorTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: { readonly active: MirrorBuffer; readonly normal: MirrorBuffer };
  readonly modes?: { readonly mouseTrackingMode?: string };
  loadAddon(addon: unknown): void;
  resize(columns: number, rows: number): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  dispose(): void;
}

interface MirrorTerminalConstructor {
  new(options?: { allowProposedApi?: boolean; scrollback?: number; convertEol?: boolean }): MirrorTerminal;
}

interface MirrorSerializer {
  serialize(options?: {
    excludeModes?: boolean;
    scrollback?: number;
    range?: { start: number; end: number };
  }): string;
}

interface MirrorSerializerConstructor {
  new(): MirrorSerializer;
}

interface CursorVisibilityState {
  visible: boolean;
  tail: string;
}

interface MouseTrackingState {
  active: boolean;
  tail: string;
}

export interface TerminalStreamSeedFrame {
  ansi: string;
  width: number;
  height: number;
  alt: boolean;
  mouseAware?: boolean;
}

export interface TerminalStreamSnapshot {
  revision: number;
  ansi: string;
  cur: TerminalCursor | null;
  cursorVisible: boolean;
  alt: boolean;
  mouseAware: boolean;
  boundaryLine: number | null;
  bufferRows: number;
  paneRows: number;
  paneCols: number;
}

export interface TerminalStreamMirror {
  seed(frame: TerminalStreamSeedFrame): Promise<void>;
  data(bytes: Uint8Array): Promise<void>;
  ready(cur: TerminalCursor | null | undefined): Promise<void>;
  snapshot(): TerminalStreamSnapshot | null;
  readonly revision: number;
  dispose(): void;
}

export interface TerminalStreamMirrorOptions {
  scrollback?: number;
  renderScrollback?: number;
  TerminalCtor?: MirrorTerminalConstructor;
  SerializeAddonCtor?: MirrorSerializerConstructor;
}

const write = (term: MirrorTerminal, data: string | Uint8Array): Promise<void> => (
  new Promise((resolve) => term.write(data, resolve))
);

function cursorVisibility(data: Uint8Array, previous: CursorVisibilityState): CursorVisibilityState {
  let ascii = previous.tail;
  for (const byte of data) ascii += byte < 0x80 ? String.fromCharCode(byte) : ' ';
  let visible = previous.visible;
  for (const match of ascii.matchAll(/\x1b\[\?25([hl])/g)) visible = match[1] === 'h';
  return { visible, tail: ascii.slice(-8) };
}

function mouseTracking(data: Uint8Array, previous: MouseTrackingState): MouseTrackingState {
  let ascii = previous.tail;
  for (const byte of data) ascii += byte < 0x80 ? String.fromCharCode(byte) : ' ';
  let active = previous.active;
  for (const match of ascii.matchAll(/\x1b\[\?(9|1000|1002|1003)([hl])/g)) {
    active = match[2] === 'h';
  }
  return { active, tail: ascii.slice(-12) };
}

function isDefaultBlankLine(line: MirrorBufferLine | undefined, cols: number): boolean {
  if (!line) return true;
  for (let col = 0; col < cols; col += 1) {
    const cell = line.getCell(col);
    if (!cell) continue;
    const chars = cell.getChars();
    if ((chars && /[^ \t]/.test(chars)) || !cell.isAttributeDefault()) return false;
  }
  return true;
}

function normalProjection(
  term: MirrorTerminal,
  serializer: MirrorSerializer,
  renderScrollback: number,
  cursorVisible: boolean,
): Pick<TerminalStreamSnapshot, 'ansi' | 'bufferRows' | 'cur'> & { start: number } {
  const buffer = term.buffer.normal;
  const bufferRows = Math.min(buffer.length, term.rows + renderScrollback);
  const start = buffer.length - bufferRows;
  const cursorLine = buffer.baseY + buffer.cursorY;
  let lastRequiredLine = cursorLine;

  // Only the source pane's live grid can contain the empty tail. Never trim history above baseY,
  // and preserve any row with text or terminal attributes (notably Codex/Claude shaded padding).
  for (let line = buffer.length - 1; line >= buffer.baseY; line -= 1) {
    if (!isDefaultBlankLine(buffer.getLine(line), term.cols)) {
      lastRequiredLine = Math.max(lastRequiredLine, line);
      break;
    }
  }

  const trailingBlankRows = buffer.length - 1 - lastRequiredLine;
  if (trailingBlankRows <= MAX_TRAILING_BLANK_ROWS) {
    return {
      ansi: serializer.serialize({ excludeModes: true, scrollback: renderScrollback }),
      bufferRows,
      start,
      cur: null,
    };
  }

  const end = lastRequiredLine + MAX_TRAILING_BLANK_ROWS;
  return {
    // Range serialization keeps the selected blank rows but deliberately omits cursor restoration.
    // Return the cursor from this same mirror revision so the visible projection can place it after
    // adding its own top padding, without changing the exact pane-sized parser state.
    ansi: serializer.serialize({
      excludeModes: true,
      range: { start, end },
    }),
    bufferRows: end - start + 1,
    start,
    cur: {
      row: end - cursorLine,
      col: buffer.cursorX,
      vis: cursorVisible,
    },
  };
}

// An exact pane-sized xterm core with no DOM renderer. Raw tmux bytes always land here, so their
// cursor-addressing semantics stay correct. The UI consumes immutable serialized revisions from it
// and can therefore use one independently-sized visible xterm for both history and the live pane.
export function createTerminalStreamMirror({
  scrollback,
  renderScrollback = DEFAULT_RENDER_SCROLLBACK,
  TerminalCtor = XTerm,
  SerializeAddonCtor = SerializeAddon,
}: TerminalStreamMirrorOptions = {}): TerminalStreamMirror {
  let term: MirrorTerminal | null = null;
  let serializer: MirrorSerializer | null = null;
  let disposed = false;
  let seeded = false;
  let ready = false;
  let seedRows = 0;
  let revision = 0;
  let cursor: CursorVisibilityState = { visible: false, tail: '' };
  let mouse: MouseTrackingState = { active: false, tail: '' };

  const ensureOpen = (): void => {
    if (disposed) throw new Error('terminal stream mirror disposed');
  };

  return {
    async seed(frame) {
      ensureOpen();
      const nextTerm = new TerminalCtor({
        allowProposedApi: true,
        ...(scrollback !== undefined ? { scrollback } : {}),
        convertEol: false,
      });
      const nextSerializer = new SerializeAddonCtor();
      nextTerm.loadAddon(nextSerializer);
      if (nextTerm.cols !== frame.width || nextTerm.rows !== frame.height) {
        nextTerm.resize(frame.width, frame.height);
      }
      const seed = prepareLiveSeed(frame.ansi, frame.height);
      const screenMode = frame.alt ? '\x1b[?1049h' : '\x1b[?1049l';
      try {
        await write(nextTerm, `${screenMode}\x1b[?25l\x1b[0m\x1b[2J\x1b[3J\x1b[H${seed}`);
        ensureOpen();
      } catch (error) {
        nextTerm.dispose();
        throw error;
      }
      const previousTerm = term;
      term = nextTerm;
      serializer = nextSerializer;
      previousTerm?.dispose();
      ready = false;
      cursor = { visible: false, tail: '' };
      mouse = { active: !!frame.mouseAware, tail: '' };
      seedRows = seed ? seed.split('\r\n').length : 0;
      seeded = true;
      revision += 1;
    },

    async data(bytes) {
      ensureOpen();
      cursor = cursorVisibility(bytes, cursor);
      mouse = mouseTracking(bytes, mouse);
      await write(term!, bytes);
      ensureOpen();
      revision += 1;
    },

    async ready(cur) {
      ensureOpen();
      cursor.visible = !!cur?.vis;
      await write(term!, cursorSeq(cur, term!.rows, seedRows));
      ensureOpen();
      ready = true;
      revision += 1;
    },

    snapshot() {
      ensureOpen();
      if (!seeded || !ready) return null;
      const currentTerm = term!;
      const currentSerializer = serializer!;
      const active = currentTerm.buffer.active;
      // The hidden core remains the complete, pane-sized terminal state. The visible terminal is only a
      // projection, so repainting its entire accumulated scrollback on every output revision is wasted
      // work (and eventually blocks the browser for tens of milliseconds per frame). Keep one history
      // page beside the live grid; deeper scrolling already switches to the snapshot history loader.
      const projection = active.type === 'alternate'
        ? {
            ansi: currentSerializer.serialize({ excludeModes: true, scrollback: renderScrollback }),
            bufferRows: active.length,
            start: 0,
            cur: null,
          }
        : normalProjection(currentTerm, currentSerializer, renderScrollback, cursor.visible);
      const mouseMode = currentTerm.modes?.mouseTrackingMode;
      return {
        revision,
        ansi: projection.ansi,
        cur: projection.cur,
        cursorVisible: cursor.visible,
        alt: active.type === 'alternate',
        mouseAware: mouse.active || (!!mouseMode && mouseMode !== 'none'),
        boundaryLine: active.type === 'alternate'
          ? null
          : Math.max(0, currentTerm.buffer.normal.baseY - projection.start),
        bufferRows: projection.bufferRows,
        paneRows: currentTerm.rows,
        paneCols: currentTerm.cols,
      };
    },

    get revision() {
      return revision;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      term?.dispose();
    },
  };
}
