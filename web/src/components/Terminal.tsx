import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { IDecoration, IMarker, Terminal as XTerm } from '@xterm/xterm';
import { getHistory, scrollPane, sendKeys, UnauthorizedError } from '../api.js';
import { prepareSeed, cursorSeq } from '../terminalSeed.js';
import { getFont, setFont, clearFont, getDocHighlight } from '../storage.js';
import { backoffDelay } from '../backoff.js';
import { idleDelay } from '../cadence.js';
import { initialConnection, nextConnection } from '../connection.js';
import type { TerminalConnectionState } from '../connection.js';
import { scanDocLinks } from '../docDecorations.js';
import {
  fitRows, bottomPadRows, scrollDecision, cursorBufferLine, followTarget, viewportAtTop,
} from '../terminalViewport.js';
import { trimCopy } from '../terminalSelection.js';
import { useFlash } from '../hooks/useFlash.js';
import { openTerminalStream } from '../terminalStreamClient.js';
import type { TerminalStreamController, TerminalStreamStatus } from '../terminalStreamClient.js';
import { createTerminalStreamMirror } from '../terminalStreamMirror.js';
import type {
  TerminalStreamMirror,
  TerminalStreamSnapshot,
} from '../terminalStreamMirror.js';
import type { TerminalReadyMessage, TerminalSeedMessage } from '../terminalStreamProtocol.js';
import TerminalOverlays from './TerminalOverlays.jsx';
import { openXterm } from '../terminalXterm.js';
import type { TerminalDocLinkHandler } from '../terminalXterm.js';
import { createTerminalSelectionController } from '../terminalSelectionController.js';
import type {
  TerminalSelectionActions,
  TerminalSelectionUI,
} from '../terminalSelectionController.js';
import { createTerminalTouchController } from '../terminalTouchController.js';
import { createConnectionTelemetry } from '../connectionTelemetry.js';
import type { ConnectionTelemetryState } from '../connectionTelemetry.js';
import { streamPaintDelay } from '../streamPaintCadence.js';
import { useBackButton } from '../hooks/useBackButton.js';
import type { TerminalCursor } from '../terminalViewport.js';

type TerminalTransportFallback = 'network' | 'unavailable';
type TerminalInputFailure = 'pane-missing' | 'disconnected';
type TerminalDecoration = { deco: IDecoration; marker: IMarker };
type TerminalVerticalScrollbar = { top: number; height: number };

interface TerminalSeedState {
  seed: string;
  contentRows: number;
  alt: boolean;
}

export interface TerminalProps {
  pane: string;
  stream?: boolean;
  snapshotIntervalMs?: number;
  inset?: number;
  desktop?: boolean;
  autoFocusInput?: boolean;
  onAuthFail?: () => void;
  onDocLinkTap?: TerminalDocLinkHandler;
  onTap?: () => void;
  onKeepKeyboard?: () => boolean;
  onRequestDraft?: () => void;
  onInputFocusChange?: (focused: boolean) => void;
  onInputData?: (pane: string, data: string | Uint8Array) => void;
}

export interface TerminalHandle {
  getSize(): { cols: number; rows: number } | null;
  flash(): void;
  getFontSize(): { size: number; auto: boolean } | null;
  setFontSize(size: number): number | null;
  autoFont(): void;
  wake(): void;
  inputFailed(error: unknown): void;
  focusInput(): void;
  blurInput(): void;
  forwardPageKey(event: KeyboardEvent): boolean;
  setDocHighlight(on: boolean): void;
}

function serverErrorOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'serverError' in error
    ? (error as { serverError?: unknown }).serverError
    : undefined;
}

const LIVE_MARGIN = 20; // capture this many rows beyond the viewport so a small scroll-up has slack
                        // before triggering a deeper history pull (replaces the old fixed 100-line tail)
const CHUNK = 100; // how much more history to pull each time the top is reached (one page)
const MAX_LINES = 5000; // backend cap on capture depth
const LIVE_SCROLL_SLACK = 15; // scrolled up within this many lines of the bottom still counts as "live"
                              // (keep polling + follow new output); scroll up further to browse/pause
const STREAM_BACKGROUND_RESET_MS = 10000;
const STREAM_HISTORY_SUSPEND_MS = 10000;

// Snapshot mode rewrites capture-pane frames. Stream mode parses raw tmux output in an exact
// pane-sized off-screen core and paints coalesced revisions into this one visible xterm. Scrolling
// past the live zone pauses either source; reaching the top pulls deeper snapshot history while
// keeping the content anchor stable.
//
// Sizing: cols always match the real pane (identical wrapping; wider-than-screen panes scroll
// horizontally — see styles.css). Rows are sized to fill the container height at the current
// font and the grid is bottom-anchored, so the latest line is always flush with the bottom:
// a smaller font shows more rows (filled from scrollback), a larger font fewer. In AUTO mode
// (no manual pinch) the font also shrinks so the whole pane fits — full-screen TUIs stay whole.
// All of this lives in fit() below.
const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({
  pane,
  stream = false,
  snapshotIntervalMs = 1000,
  inset = 0,
  desktop = false,
  autoFocusInput = true,
  onAuthFail,
  onDocLinkTap,
  onTap,
  onKeepKeyboard,
  onRequestDraft,
  onInputFocusChange,
  onInputData,
}, ref) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const forwardPageKeyRef = useRef<((event: KeyboardEvent) => boolean) | null>(null);
  const insetRef = useRef(0); // keyboard overlap (px) — fit() subtracts it so the grid == visible height
  const userScrolledRef = useRef(false); // manual vertical scroll → disarms alt-screen cursor-follow
  const followArmedRef = useRef(false);  // alt-screen cursor-follow armed? (keyboard-focus)
  const lastCurForFollowRef = useRef(''); // last cursor key seen by follow → a change re-arms it
  const onTapRef = useRef(onTap); // a clean single tap → dismiss the dock keyboard (called synchronously)
  onTapRef.current = onTap;
  const onKeepKeyboardRef = useRef(onKeepKeyboard);
  onKeepKeyboardRef.current = onKeepKeyboard;
  const onRequestDraftRef = useRef(onRequestDraft);
  onRequestDraftRef.current = onRequestDraft;
  const onAuthFailRef = useRef(onAuthFail);
  onAuthFailRef.current = onAuthFail;
  const onInputFocusChangeRef = useRef(onInputFocusChange);
  onInputFocusChangeRef.current = onInputFocusChange;
  const onInputDataRef = useRef(onInputData);
  onInputDataRef.current = onInputData;
  const snapshotIntervalRef = useRef(snapshotIntervalMs);
  snapshotIntervalRef.current = snapshotIntervalMs;
  // Clickable doc-path underlines (xterm decorations), rebuilt after every full repaint. The tap
  // handler is held in a ref so the poll loop's stable closure always calls the latest prop (mirrors
  // how the loop reaches outside state via fitRef/wakeRef). Tapping a path does NOT open it directly
  // — it hands the path + tap coords to App, which shows a confirm popover (anti-误触).
  const decosRef = useRef<TerminalDecoration[]>([]);
  const cursorDecoRef = useRef<TerminalDecoration | null>(null); // decoration-drawn cursor for a full-screen app whose cursor is in scrollback (CUP can't reach it)
  const locateDecoRef = useRef<TerminalDecoration | null>(null); // full-row background highlight on the cursor's line (the 定位 toggle)
  const locateOnRef = useRef(false);  // is the 定位 line-highlight toggle on? (read inside effect scope)
  const locateRef = useRef<(() => void) | null>(null);     // effect-scope redraw of the locate highlight, so the toggle button can apply it now
  const onDocLinkTapRef = useRef(onDocLinkTap);
  onDocLinkTapRef.current = onDocLinkTap;
  // The doc-path wash is an opt-in visual cue (Settings toggle, default off) — paths stay tappable
  // regardless. Held in a ref the poll-loop closure reads; setDocHighlight() (imperative handle) flips it
  // and pokes refreshDecosRef to re-scan at once, without waiting for the next repaint.
  const docHighlightRef = useRef(getDocHighlight());
  const refreshDecosRef = useRef<(() => void) | null>(null);
  // Terminal font is set by two-finger pinch and persisted. null = auto-fit (height).
  const fontRef = useRef<number | null>(getFont());
  // Kills an in-flight inertial coast. Held in a ref (like fitRef/wakeRef) so resume() — defined in
  // component scope — can cancel the fling that lives in the touch-handling effect closure.
  const stopFlingRef = useRef<(() => void) | null>(null);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(true); // false → show the disconnect banner
  const [streamStatus, setStreamStatus] = useState<TerminalStreamStatus | 'off'>(
    stream ? 'connecting' : 'off',
  );
  const [connectionInfo, setConnectionInfo] = useState<ConnectionTelemetryState>({
    mode: stream ? 'live' : 'snapshot',
    quality: 'connecting',
    stableQuality: 'connecting',
    rttMs: null,
    recoveryAt: null,
  });
  const [transportFallback, setTransportFallback] = useState<TerminalTransportFallback | null>(null);
  const [transportOpen, setTransportOpen] = useState(false);
  const [transportNow, setTransportNow] = useState(() => Date.now());
  const [inputFailure, setInputFailure] = useState<TerminalInputFailure | null>(null);
  // Touch selection: long-press starts a selection on the real grid (xterm draws the highlight
  // on its own layer, WebGL included), drag extends it, then a "复制" bubble copies it. selActive
  // is a ref so liveTick (effect scope) and the bubble (render scope) share the "don't repaint /
  // a selection is showing" flag without a re-render race.
  const selActiveRef = useRef(false);
  const [selInfo, setSelInfo] = useState(''); // blue "复制模式 · N 行 · M 字" status strip; '' = hidden
  const [selUI, setSelUI] = useState<TerminalSelectionUI | null>(null); // {start:{x,y}, end:{x,y}} in .terminal-wrap px, or null
  // Alt-screen (a full-screen app: vim/htop/less/a mouse-mode TUI) has no scrollback of its own, so a
  // vertical swipe can't scroll it the ordinary way. altScreenRef tracks the pane's state (set each poll
  // from the server's `alt` flag); a swipe over such a pane is forwarded to the app as scroll input it
  // understands — wheel events when it reports mouse (mouseAwareRef), else arrow keys (see flushWheel /
  // the vertical branch). altScreen (state) drives the always-available page up/down pager buttons.
  const altScreenRef = useRef(false);
  const mouseAwareRef = useRef(false);
  const [altScreen, setAltScreen] = useState(false);
  const [locateOn, setLocateOn] = useState(false); // 定位: highlight the cursor's row (full-screen pager toggle)
  // cols×rows·font readout flashed on ⊟/⊞ then hidden — a self-contained component-scope cluster.
  const { dbg, dbgVisible, flash } = useFlash(termRef);
  // History-mode banner text (历史模式 · 行 viewportY/baseY): non-empty only while browsing outside
  // the live zone; '' (hidden) when at/near the bottom and still live. Set by showScrollPos.
  const [scrollInfo, setScrollInfo] = useState('');
  // First-paint gate. A freshly-switched pane seeds into a default-size grid, then fit() grows/re-fits
  // it over a few RAF passes (and may shrink the font). Showing that means the screen appears
  // bottom-half-first and fills upward (the grid is bottom-anchored, see .terminal .xterm flex-end).
  // Keep the terminal hidden (opacity:0 — geometry preserved so fit can still measure) until the first
  // seed+fit settles, then reveal the complete frame in one go. false ⇔ still seeding/fitting.
  const [ready, setReady] = useState(false);
  // Mobile overlay scrollbars reserve no layout space. Only when the rendered grid is actually wider than
  // its host do we add the exact scrollbar-height class; a fitting grid keeps zero gutter.
  const [xOverflow, setXOverflow] = useState(false);
  // iOS auto-hides the native vertical indicator and overlays it on the final text column. Keep the
  // geometry for a small, persistent mobile-only thumb; null means there is no vertical scrollback.
  const [yScrollbar, setYScrollbar] = useState<TerminalVerticalScrollbar | null>(null); // { top, height } in px
  const yOverflow = yScrollbar != null;
  // The effect's scheduleFit, surfaced so the font controls (below) can re-fit the row count
  // after changing the size from outside the effect scope.
  const fitRef = useRef<(() => void) | null>(null);
  const settleLayoutFitRef = useRef<(() => void) | null>(null);
  // One-shot flag for the pager's "适配高度" button: the next fit() sizes the font so the whole pane fills
  // the screen (see the fit-to-fill block in fit()). Set here, consumed in effect scope.
  const fitScreenPendingRef = useRef(false);
  // After the fit-height estimate, verify against the REAL cell height and shrink a step at a time until all
  // paneRows actually fit (xterm rounds cell height to whole pixels, so the estimate can be a row too big).
  const fitScreenVerifyRef = useRef(false);
  // One-shot flag: the keyboard just collapsed → the next fit keeps the cursor in view (scroll-into-view)
  // instead of jumping to the first line, so you don't lose your editing spot. Set in the inset effect.
  const collapseKeepCursorRef = useRef(false);
  // The last measured keyboard-DOWN visible height (the real usable area, dock excluded). "适配高度" sizes
  // the font against THIS so it fills the screen exactly — clientHeight over-counts (it includes the strip
  // under the bottom dock), which sized the font ~2 rows too big.
  const fullAvailRef = useRef(0);
  // wake() lets outside input (sends/keys, via App) snap the poll loop back to the live cadence and
  // poll immediately. Bridged through a ref like fitRef so the imperative handle can reach effect scope.
  const wakeRef = useRef<(() => void) | null>(null);
  const resyncRef = useRef<(() => void) | null>(null);
  // When true, placeCursor lights the block at the cursor's real position even if the app has hidden it
  // (cur.vis === false). Set by every key/command send (see wake); cleared by the repaint loop once the app
  // shows its own cursor again (cur.vis=1). So operating the terminal always reveals WHERE the cursor is —
  // through Claude's whole working spell — without a stray block lingering after the app deliberately hides.
  const forceCursorRef = useRef(false);
  // Callout 整行/整段 buttons live in render scope but need effect-scope helpers (term, buf, refreshSelUI).
  // Bridged via a ref, same pattern as fitRef/wakeRef. Populated once inside the effect.
  const selActionsRef = useRef<TerminalSelectionActions | null>(null);

  // App's ⊟/⊞ buttons call getSize to step the grid, and flash to surface the resulting
  // cols×rows·font for ~3s (polling briefly because term.cols only catches up on the next
  // ~1s refresh).
  useImperativeHandle(ref, () => ({
    getSize: () => {
      const term = termRef.current;
      return term ? { cols: term.cols, rows: term.rows } : null;
    },
    flash,
    // Settings-modal font controls (A−/A+/自适应). The two-finger pinch still works the same;
    // these are just an explicit way to drive the same persisted size.
    getFontSize: () => {
      const term = termRef.current;
      return term ? { size: term.options.fontSize ?? 14, auto: fontRef.current == null } : null;
    },
    setFontSize: (n) => {
      const term = termRef.current;
      if (!term) return null;
      const f = Math.max(8, Math.min(40, Math.round(n)));
      term.options.fontSize = f;
      fontRef.current = f; // mark manual so auto-fit won't fight it
      setFont(f);
      fitRef.current?.(); // re-fit the row count to the new font
      return f;
    },
    autoFont: () => {
      const term = termRef.current;
      if (!term) return;
      term.options.fontSize = 14; // reset to the base so auto-fit can shrink from a known size
      fontRef.current = null;
      clearFont();
      fitRef.current?.();
    },
    wake: () => wakeRef.current?.(),
    inputFailed: (error) => {
      setInputFailure(serverErrorOf(error) === 'pane not found' ? 'pane-missing' : 'disconnected');
      setConnected(false);
    },
    focusInput: () => termRef.current?.focus(),
    blurInput: () => termRef.current?.blur(),
    forwardPageKey: (event) => forwardPageKeyRef.current?.(event) ?? false,
    // Settings' doc-path-highlight switch: flip the flag and re-scan now (default off, so no wash until on).
    setDocHighlight: (on) => { docHighlightRef.current = !!on; refreshDecosRef.current?.(); },
  }), []);

  // Keyboard open/close changes the visible height above the keyboard. App only translateY(-inset)s the
  // page, so our clientHeight is unchanged and the container ResizeObserver never fires — re-fit here on
  // the inset change. This is the ONLY inset-driven refit; the ResizeObserver stays grow-only (no typing
  // flash), and fit() keeps the font while shrinking rows (see the insetRef.current checks in fit()).
  useEffect(() => {
    const prev = insetRef.current;
    insetRef.current = inset;
    // Keyboard just opened on a full-screen app → arm cursor-follow so a later cursor move keeps the caret
    // in view; the refit itself bottom-aligns the cursor now (see the alt-screen branch in fit()).
    if (inset > 0 && prev === 0) followArmedRef.current = true;
    // Keyboard just collapsed → keep the cursor in view and remeasure through the end of iOS's viewport
    // animation. inset can reach zero one frame before the terminal has regained its final height.
    if (inset === 0 && prev > 0) {
      collapseKeepCursorRef.current = true;
      (settleLayoutFitRef.current ?? fitRef.current)?.();
    } else if (stream) {
      (settleLayoutFitRef.current ?? fitRef.current)?.();
    } else {
      fitRef.current?.();
    }
    if (inset === 0) followArmedRef.current = false; // keyboard closed → stop following
  }, [inset]);

  // Adding/removing either conditional scrollbar gutter changes the grid's usable box.
  useEffect(() => {
    (stream ? settleLayoutFitRef.current : fitRef.current)?.();
  }, [stream, xOverflow, yOverflow]);

  useEffect(() => {
    let disposed = false;
    let hadDesktopSelection = false;
    const terminalHost = elRef.current;
    if (!terminalHost) return undefined;
    const liveHost = document.createElement('div');
    liveHost.className = 'terminal__live';
    terminalHost.replaceChildren(liveHost);
    const { term, forwardPageKey, dispose: disposeXterm } = openXterm({
      host: liveHost,
      desktop,
      autoFocusInput,
      fontSize: fontRef.current ?? 14,
      scrollback: MAX_LINES + 100,
      pane,
      onInputData: (targetPane, data) => onInputDataRef.current?.(targetPane, data),
      onInputFocusChange: (focused) => {
        if (!disposed) onInputFocusChangeRef.current?.(focused);
      },
      onRequestDraft: () => onRequestDraftRef.current?.(),
      onDesktopSelection: (active) => {
        if (disposed) return;
        if (active) {
          hadDesktopSelection = true;
          selActiveRef.current = true;
          setSelUI(null);
          setSelInfo('');
        } else if (hadDesktopSelection) {
          hadDesktopSelection = false;
          selActiveRef.current = false;
          wakeRef.current?.();
        }
      },
      getDocLinkHandler: () => onDocLinkTapRef.current,
    });
    termRef.current = term;
    forwardPageKeyRef.current = forwardPageKey;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let busy = false;
    let wakeAgain = false; // a wake() landed mid-poll — re-poll right after the in-flight one finishes
    let streamClient: TerminalStreamController | null = null;
    let streamMode = stream;
    let streamFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let streamBackgroundTimer: ReturnType<typeof setTimeout> | null = null;
    let streamHistoryTimer: ReturnType<typeof setTimeout> | null = null;
    let streamBackgroundSuspended = false;
    let hiddenAt: number | null = null;
    let streamMirror: TerminalStreamMirror | null = null;
    let streamMirrorReady = false;
    let streamPaintRaf: number | null = null;
    let streamPaintTimer: ReturnType<typeof setTimeout> | null = null;
    let lastStreamPaintAt: number | null = null;
    let streamPaintBusy = false;
    let streamPaintQueued = false;
    let streamLayoutSettled = !streamMode;
    let streamSeedNeedsFit = true;
    let fitGeneration = 0;
    let fitRaf: number | null = null;
    let layoutSettleGeneration = 0;
    let layoutSettleRaf: number | null = null;
    let scheduleStreamRender: (options?: { immediate?: boolean }) => void = () => {};
    let historyMode = false;
    let seeded = false;
    let streamRecoveryInProgress = false;
    let streamHasBeenLive = false;
    let maybeRecoverStream: () => void = () => {};
    const telemetry = createConnectionTelemetry({
      mode: stream ? 'live' : 'snapshot',
      onChange: (info) => {
        setConnectionInfo(info);
        if (streamMode && info.stableQuality === 'poor') fallbackToPolling();
        else if (!streamMode && info.mode === 'snapshot' && info.stableQuality === 'good') {
          maybeRecoverStream();
        }
      },
    });
    // Fresh slate per pane: don't carry the previous pane's alt/mouse state (else switching from a
    // full-screen pane to a normal one flashes the pager buttons until the first poll corrects it).
    // Also reset selection state: selActiveRef survives the effect re-run and its poll gate
    // (if (selActiveRef.current) return) would freeze the new pane's screen if a selection
    // was active when the user switched panes.
    altScreenRef.current = false;
    mouseAwareRef.current = false;
    setAltScreen(false);
    selActiveRef.current = false;
    setSelUI(null);
    setSelInfo('');
    setYScrollbar(null);
    // Live capture depth tracks the viewport (+margin) instead of a fixed 100, so we transmit and hash
    // only what's shown plus a little scroll-up slack. Floor 24 covers a not-yet-fit grid; cap at MAX_LINES.
    const liveDepth = () => Math.min(MAX_LINES, Math.max(24, term.rows + LIVE_MARGIN));
    let depth = liveDepth();
    let historyPullRetryAfter = 0;
    let freezeTouchForHistoryPull = () => {};
    let settleHistoryAnchor = (target: number): void => term.scrollToLine(target);
    let lastAnsi: string | null = null;
    let lastCur = ''; // last frame's cursor key (row,col,vis) — a cursor-only move must still repaint
    let curInfo: TerminalCursor | null = null; // last frame's cursor {row,col,vis}, placed by placeCursor() after sizing settles
    let seedRows = 0; // rows in the last seed (trimmed capture) — cur.row counts up from its bottom
    let streamCursorOwned = false; // after a serialized revision lands, visible xterm owns its cursor
    let streamCursorVisible = false;
    let historyBoundary: TerminalDecoration | null = null;
    let liveBoundaryLine: number | null = null;
    // The last seed's RAW (un-padded) content, so fit() can re-pad it for the FINAL row count. The seed's
    // bottom-pad is computed against term.rows AT SEED TIME (the pre-fit default); fit then grows the grid
    // to fill the container, and without re-padding the short content would sit stranded mid-grid while the
    // cursor is placed at the grown bottom (the "new window, short content, cursor at bottom" bug).
    let lastSeed: TerminalSeedState | null = null; // { seed, contentRows, alt }
    let lastHash: string | null = null; // last frame's server hash, echoed as ?since= so an unchanged screen returns 204
    let idleSince = Date.now(); // timestamp of the last change/activity → drives the adaptive cadence
    setPaused(false);
    setStreamStatus(stream ? 'connecting' : 'off');
    setTransportFallback(null);
    setTransportOpen(false);
    setReady(false); // hide until the first seed+fit settles (see `ready` state above)
    let revealed = false;
    const reveal = () => {
      if (disposed || revealed) return;
      revealed = true;
      // One more frame so xterm paints the settled grid before we flip opacity — no stale 1-frame flash.
      requestAnimationFrame(() => { if (!disposed) setReady(true); });
    };
    let connState = initialConnection;
    const setConn = (s: TerminalConnectionState): void => {
      connState = s;
      if (s.connected) setInputFailure(null);
      setConnected(s.connected);
    };

    const buf = () => term.buffer.active;
    const disposeHistoryBoundary = () => {
      if (!historyBoundary) return;
      historyBoundary.deco.dispose();
      historyBoundary.marker.dispose();
      historyBoundary = null;
    };
    const drawHistoryBoundary = () => {
      disposeHistoryBoundary();
      const boundaryLine = liveBoundaryLine;
      if (altScreenRef.current || boundaryLine == null || !Number.isFinite(boundaryLine)
        || boundaryLine < 1) return;
      const b = buf();
      const cursorLine = b.baseY + b.cursorY;
      const marker = term.registerMarker(boundaryLine - cursorLine);
      if (!marker) return;
      const deco = term.registerDecoration({ marker, x: 0, width: term.cols });
      if (!deco) {
        marker.dispose();
        return;
      }
      deco.onRender((element) => element.classList.add('terminal-history-boundary'));
      historyBoundary = { marker, deco };
    };
    const syncYScrollbar = () => {
      const vp = elRef.current?.querySelector('.xterm-viewport');
      const b = buf();
      const trackHeight = vp?.clientHeight || 0;
      const maxTop = b.baseY || 0;
      if (!trackHeight || maxTop <= 0) {
        setYScrollbar((current) => (current == null ? current : null));
        return;
      }
      const totalRows = Math.max(b.length || 0, maxTop + term.rows);
      const height = Math.min(trackHeight, Math.max(18, Math.round(trackHeight * term.rows / totalRows)));
      const top = Math.round((trackHeight - height) * Math.max(0, Math.min(maxTop, b.viewportY)) / maxTop);
      setYScrollbar((current) => (
        current?.top === top && current?.height === height ? current : { top, height }
      ));
    };
    // History-mode banner text. Shown ONLY while browsing outside the live zone (scrolled up far
    // enough that live refresh is paused) — inside the live zone, or at the bottom, it's still live so
    // there's nothing to show. Non-empty scrollInfo ⇔ history mode. `tag` marks a deeper-history pull.
    const showScrollPos = (tag = '') => {
      const b = buf();
      // Real buffer state, no display-layer rounding — what you see IS what's loaded. b.baseY = the
      // scrollable history rows, and it EQUALS the pull depth: capture returns `depth` history lines + the
      // visible screen, so baseY = length − rows = depth. maybePullMore snaps depth to whole CHUNK pages, so
      // baseY is already a clean 100/200/300 with no faking. Numerator = how far up from the live bottom
      // you've scrolled (0 at the bottom, baseY at the very top → N/N).
      // Alt-screen never shows the history banner: its scrollback is synthetic (the keyboard-shrunk grid),
      // scrolling it is our internal window pan over a live app — not browsing tmux history.
      const browsingHistory = !nearBottom();
      setScrollInfo(seeded && browsingHistory && !altScreenRef.current
        ? `历史模式 · 距底 ${b.baseY - b.viewportY}/${b.baseY} 行${busy ? ' · 拉取中' : ''}${tag}`
        : '');
    };
    const atBottom = () => buf().viewportY >= buf().baseY;
    // "Live zone": at the bottom OR scrolled up only a little. Inside it we keep polling so the screen
    // stays fresh — but only a true at-bottom view follows new output (scrollToBottom); scrolled up a
    // little we refresh IN PLACE (keepPosition, no yank to the bottom). Past the zone = browsing → pause.
    const nearBottom = () => buf().baseY - buf().viewportY <= LIVE_SCROLL_SLACK;
    const atTop = () => viewportAtTop(
      buf().viewportY,
      liveHost.querySelector('.xterm-viewport')?.scrollTop,
    );
    const pauseStreamForHistory = () => {
      if (!streamMode || historyMode) return;
      historyMode = true;
      streamCursorOwned = false;
      streamClient?.pause();
      if (streamHistoryTimer) clearTimeout(streamHistoryTimer);
      streamHistoryTimer = setTimeout(() => {
        streamHistoryTimer = null;
        if (!disposed && streamMode && historyMode) streamClient?.suspend();
      }, STREAM_HISTORY_SUSPEND_MS);
      setStreamStatus('paused');
    };
    // Pull a deeper history slice when sitting at the top. Driven from term.onScroll, the touch handler AND
    // the fling coast: xterm owns the 1:1 drag and its onScroll can miss the very top on mobile during a fast
    // glide, so the touch/fling paths are the dependable triggers. `busy` serializes requests, while
    // `depth` advances only after success: continuous scrolling can load page after page without issuing
    // the same page concurrently or skipping a failed page.
    const maybePullMore = () => {
      if (!seeded || busy || Date.now() < historyPullRetryAfter
        || depth >= MAX_LINES || !atTop()) return;
      if (streamMode && !historyMode) return;
      pauseStreamForHistory();
      freezeTouchForHistoryPull();

      // Stop only Handmux's synthetic mobile coast. Native desktop wheel input remains untouched and can
      // continue through successive pages; repaint preserves its latest position when the response arrives.
      stopFlingRef.current?.();
      // Snap the pull target to the NEXT whole CHUNK boundary (100, 200, 300 …) rather than liveDepth+k·CHUNK.
      // The first pull leaves from the small liveDepth (e.g. 47), so plain +CHUNK would load 147/247/… — the
      // loaded depth (and the count the readout shows) is then a genuine multiple of 100, not a mid-number
      // faked round at the display layer. floor()·CHUNK+CHUNK is always strictly > depth, so it never stalls.
      const previousDepth = depth;
      const requestedDepth = Math.min(Math.floor(depth / CHUNK) * CHUNK + CHUNK, MAX_LINES);
      const request = repaint(requestedDepth, true, true);
      // repaint sets busy synchronously before its first await, so this immediately exposes the existing
      // “拉取中” state in the history banner while the snapshot is in flight.
      showScrollPos();
      request.then((applied) => {
        // Commit pagination only after a successful response was accepted. A timeout, auth failure,
        // pane switch, or stale snapshot retries this same page instead of silently skipping 100 rows.
        if (applied && !disposed && depth === previousDepth) depth = requestedDepth;
        else if (!applied && !disposed) historyPullRetryAfter = Date.now() + 500;
      });
    };

    let paneRows = 0; // the real pane's row count (drives auto-shrink, below)

    // Keep the rendered grid the same height as the container and anchored at the bottom, at
    // any font size. Two passes, both off the actual measured cell height:
    //  1. AUTO mode (no manual pinch): shrink the font — never enlarge — until the whole real
    //     pane fits the height, so a full-screen TUI shows every row.
    //  2. ALWAYS: render exactly as many rows as fit the height (floor, so the grid never
    //     exceeds the container — CSS bottom-aligns it, leaving any sub-line slack at the top
    //     and the last line flush with the bottom). The extra rows are filled from the
    //     captured scrollback, so a smaller font simply shows more lines.
    // Put xterm's own cursor on Claude's input cell (or hide it), AFTER the grid is sized + scrolled —
    // never inside the seed. Absolute from the viewport bottom, so it's correct at any row count.
    const disposeCursorDeco = () => {
      if (cursorDecoRef.current) { cursorDecoRef.current.deco.dispose(); cursorDecoRef.current.marker.dispose(); cursorDecoRef.current = null; }
    };
    const cursorDisplayState = () => {
      const b = term.buffer.active;
      if (streamMode && streamCursorOwned) {
        return {
          cur: {
            row: Math.max(0, term.rows - 1 - b.cursorY),
            col: b.cursorX,
            vis: streamCursorVisible,
          },
          line: b.baseY + b.cursorY,
          liveOwned: true,
        };
      }
      const cur = curInfo;
      return {
        cur,
        line: cur ? (seedRows - 1) - (cur.row | 0) : null,
        liveOwned: false,
      };
    };
    // xterm renders its native cursor ONLY while the viewport sits at the live bottom (ydisp === ybase). For
    // a full-screen app whose caret we scrolled into a shorter window — bottom/top-aligned with rows still
    // off-screen below, or a caret up in scrollback — the viewport is scrolled up (viewportY < baseY) and the
    // native cursor is hidden, so it would vanish until the next repaint. In that case draw the cursor as a
    // DECORATION anchored to its TRUE buffer line (same registerMarker trick as the doc-path underlines): it
    // renders at the right cell at any scroll offset. At the live bottom, use the native cursor (it blinks).
    const placeCursor = () => {
      if (disposed) return;
      const { cur, line, liveOwned } = cursorDisplayState();
      const b = term.buffer.active;
      const useDeco = cur && (cur.vis || forceCursorRef.current) && altScreenRef.current && b.viewportY < b.baseY;
      if (!useDeco || !cur || line == null) {
        disposeCursorDeco();
        // Once the live stream is ready, xterm's parser is the cursor authority. Replaying an older
        // snapshot cursor here would make the real position flash and then jump backwards.
        if (!liveOwned) term.write(cursorSeq(cur, term.rows, seedRows, forceCursorRef.current));
        drawLocate();
        return;
      }
      if (!liveOwned) term.write('\x1b[?25l'); // xterm already hides its native cursor above live bottom
      disposeCursorDeco();
      const marker = term.registerMarker(line - (b.baseY + b.cursorY));
      if (!marker) { drawLocate(); return; }
      const deco = term.registerDecoration({ marker, x: Math.max(0, (cur.col ?? 0) | 0), width: 1 });
      if (!deco) { marker.dispose(); drawLocate(); return; }
      deco.onRender((el) => { el.classList.add('cursor-deco'); });
      cursorDecoRef.current = { deco, marker };
      drawLocate();
    };

    // 定位 toggle: a full-row background highlight on the cursor's line, redrawn each placeCursor so it
    // tracks the cursor. A decoration anchored to the true buffer line (like the cursor decoration), full
    // width. Off → dispose. Bridged via locateRef so the toggle button applies it immediately.
    const disposeLocate = () => {
      if (locateDecoRef.current) { locateDecoRef.current.deco.dispose(); locateDecoRef.current.marker.dispose(); locateDecoRef.current = null; }
    };
    const drawLocate = () => {
      disposeLocate();
      const { cur, line } = cursorDisplayState();
      // Only on a full-screen app (where the 定位 toggle lives). On the main screen the highlight is cleared
      // and stays cleared — switching back to Claude mustn't leave the caret-row band behind.
      if (disposed || !locateOnRef.current || !altScreenRef.current || !cur || line == null) return;
      const b = term.buffer.active;
      const marker = term.registerMarker(line - (b.baseY + b.cursorY));
      if (!marker) return;
      const deco = term.registerDecoration({ marker, x: 0, width: term.cols });
      if (!deco) { marker.dispose(); return; }
      deco.onRender((el) => { el.classList.add('locate-deco'); });
      locateDecoRef.current = { deco, marker };
    };
    locateRef.current = drawLocate;

    // Re-pad the current normal-screen seed for the CURRENT term.rows and re-write it, so short content
    // stays bottom-aligned after fit() changes the grid height. The seed's pad was computed against the
    // row count at SEED time; growing the grid afterwards (fit runs after the first seed) would otherwise
    // leave the content mid-grid with the cursor at the grown bottom — until a later repaint re-padded it
    // ("type to fix"). No-op when the pad already matches, or on alt-screen (it owns its own layout).
    // Returns a promise that resolves once the re-write has applied (or immediately when nothing changed),
    // so fit can reveal only AFTER the corrected frame lands (no mid-grid flash).
    const reframeForRows = () => {
      if (disposed || !lastSeed || lastSeed.alt) return Promise.resolve();
      const { seed, contentRows } = lastSeed;
      const pad = contentRows < term.rows ? bottomPadRows(contentRows, term.rows) : 0;
      if (contentRows + pad === seedRows) return Promise.resolve(); // pad already fits the grid → nothing to do
      const framed = pad ? ('\n'.repeat(pad) + seed) : seed;
      seedRows = framed.split('\n').length;
      return new Promise<void>((resolve) => term.write('\x1b[?25l\x1b[0m\x1b[2J\x1b[3J\x1b[H' + framed, () => {
        if (!disposed) {
          term.scrollToBottom();
          try { refreshDocDecorations(term); } catch { /* cosmetic */ } // content shifted → rescan underlines
        }
        resolve();
      }));
    };
    const settleFrame = (generation = fitGeneration) => {
      if (generation !== fitGeneration) return Promise.resolve();
      if (streamMode) {
        streamLayoutSettled = true;
        if (streamMirrorReady) scheduleStreamRender({ immediate: !revealed });
        return Promise.resolve();
      }
      return reframeForRows();
    };

    const fit = (pass = 0, generation = fitGeneration) => {
      if (disposed || generation !== fitGeneration || !elRef.current || !term.rows) return;
      const overlayHost = elRef.current.parentElement;
      const hostRect = overlayHost?.getBoundingClientRect();
      if (overlayHost && hostRect) {
        // Anchor overlays from the wrap's real clipped top instead of inferring it from visible height.
        // Ceil + 1px keeps the first border/text row inside the viewport during fractional keyboard motion.
        const overlayTop = Math.ceil(Math.max(0, -hostRect.top)) + 1;
        overlayHost.style.setProperty('--terminal-overlay-top', `${overlayTop}px`);
      }
      // Fit to the grid's ACTUAL on-screen height, not clientHeight. When horizontal overflow exists on a
      // phone, .terminal--x-overflow gives the scrollbar its own 4px row and .xterm is the content above it.
      // App translateY(-inset) lifts the whole column, so the grid's top can be clipped above the screen
      // (the topbar scrolls off) and its bottom sits at the keyboard top. Measure the visible slice = intersect its rect with
      // [0, innerHeight - inset]. Using clientHeight - inset over-subtracts the (clipped) topbar and left a
      // black band; measuring is exact for both keyboard-down (inset 0) and keyboard-up.
      const grid = liveHost.querySelector('.xterm');
      const rect = (grid || elRef.current).getBoundingClientRect();
      const visBottom = Math.min(rect.bottom, window.innerHeight - (insetRef.current || 0));
      const visTop = Math.max(rect.top, 0);
      const avail = Math.max(0, visBottom - visTop);
      const screen = liveHost.querySelector('.xterm-screen');
      const screenRect = screen?.getBoundingClientRect();
      const curH = screenRect?.height || 0;
      const hasXOverflow = (
        elRef.current.scrollWidth > elRef.current.clientWidth + 1
        || (!!screenRect && screenRect.width > elRef.current.clientWidth + 1)
      );
      setXOverflow((current) => (current === hasXOverflow ? current : hasXOverflow));
      syncYScrollbar();
      if (!avail || !curH) {
        // A newly mounted/returning PWA can expose a zero-sized grid for a frame. There is no new layout
        // to commit yet, so keep the last stable grid live instead of leaving stream paints paused forever.
        if (streamMode) settleFrame(generation);
        return;
      }
      // Publish the visible height so absolutely-positioned overlays (pager, top banner) anchor to the
      // on-screen slice instead of the full container (whose top is clipped off-screen with the keyboard up).
      overlayHost?.style.setProperty('--vis-h', `${avail}px`);
      if (insetRef.current === 0) fullAvailRef.current = avail; // remember the real keyboard-down usable height
      const cellH = curH / term.rows;

      // "适配高度" (pager button): size the font so the WHOLE pane (paneRows) fits the screen with no
      // scrollback (⇒ the cursor is always addressable), pinned as a manual size. Two steps:
      //  1) jump to a linear estimate against the real keyboard-DOWN usable height (fullAvailRef — NOT the
      //     tiny keyboard-up slice `avail`, NOT clientHeight which over-counts the strip under the dock);
      //  2) verify against the ACTUAL cell height and shrink a step at a time until all paneRows fit —
      //     xterm rounds cell height to whole pixels, so the estimate can leave the pane a row too tall.
      if (fitScreenPendingRef.current && paneRows) {
        fitScreenPendingRef.current = false;
        const cur = term.options.fontSize || 14;
        const est = Math.max(8, Math.min(40, Math.round(cur * (fullAvailRef.current || avail) / (paneRows * cellH))));
        fitScreenVerifyRef.current = true;
        fontRef.current = est; setFont(est); // pin manual so auto-shrink won't fight it
        if (est !== cur) {
          term.options.fontSize = est;
          requestAnimationFrame(() => fit(pass, generation));
          return;
        }
      }
      if (fitScreenVerifyRef.current && paneRows) {
        const rows = Math.floor((fullAvailRef.current || avail) / cellH); // rows that actually fit now
        const cur = term.options.fontSize || 14;
        if (rows < paneRows && cur > 8) { // a row is still cut → shrink one and re-check
          fontRef.current = cur - 1; setFont(cur - 1);
          term.options.fontSize = cur - 1;
          requestAnimationFrame(() => fit(pass, generation));
          return;
        }
        fitScreenVerifyRef.current = false; // all paneRows fit (or hit the min font) → settle
        fontRef.current = cur; setFont(cur);
      }

      // Auto font-shrink only when the keyboard is down. Keyboard up keeps the font and just drops rows
      // (→ scrollback), so text stays readable and the app becomes a scrollable window instead of tinier.
      if (insetRef.current === 0 && fontRef.current == null && paneRows && pass < 4) {
        const needed = paneRows * cellH;
        if (needed > avail + 4) {
          const cur = term.options.fontSize || 14;
          const next = Math.max(6, Math.round(cur * (avail / needed)));
          if (next < cur) {
            term.options.fontSize = next;
            requestAnimationFrame(() => fit(pass + 1, generation));
            return;
          }
        }
      }

      const want = fitRows(avail, cellH);
      if (want !== term.rows) {
        // Hide + park the cursor at the bottom, WAIT for that write to apply (callback), THEN resize.
        // term.write is async (parsed on a later tick) but term.resize is SYNCHRONOUS — parking without
        // waiting let resize run while the cursor was still mid-buffer (placeCursor had put it on Claude's
        // cell), so growing the grid reflowed content into scrollback and left the screen half-blank for a
        // poll (the window-switch half-screen bug). Hidden too, so the cursor doesn't flash at the bottom
        // before placeCursor re-places it.
        term.write(`\x1b[?25l\x1b[${term.rows};1H`, () => {
          if (disposed || generation !== fitGeneration) return;
          term.resize(term.cols, want);
          syncYScrollbar();
          // Full-screen app scroll after a resize:
          //  • keyboard UP → first-line reference, then bottom-align the cursor if it fell below the fold
          //    (opening the keyboard shows the first line, scrolling only if it must to keep the caret shown);
          //  • just COLLAPSED → keep the cursor in view (scroll-into-view) so closing the keyboard doesn't
          //    lose your editing spot;
          //  • otherwise (first entry / other) → the first line.
          if (altScreenRef.current) {
            const cl = cursorBufferLine(curInfo, seedRows);
            const follow = () => {
              const ct = cl == null ? null : followTarget({ cursorLine: cl, viewportY: buf().viewportY, visibleRows: term.rows, baseY: buf().baseY, armed: true });
              if (ct != null) term.scrollToLine(ct);
            };
            if (insetRef.current > 0) { term.scrollToTop(); follow(); }
            else if (collapseKeepCursorRef.current) { collapseKeepCursorRef.current = false; follow(); }
            else term.scrollToTop();
          // Entering history grows the pane-sized live grid into the local viewport. xterm already
          // preserves the visible buffer line across that resize; forcing the bottom here immediately
          // fired onScroll → resumeStream and made the first swipe flash back to live.
          } else if (!historyMode) term.scrollToBottom();
          if (pass < 4) requestAnimationFrame(() => fit(pass + 1, generation));
          // last pass → grid settled: re-pad short content for the FINAL row count, THEN cursor + reveal
          else settleFrame(generation).then(() => {
            if (!disposed && generation === fitGeneration) {
              placeCursor();
              if (!streamMode) reveal();
            }
          });
        });
        return;
      }
      // grid already matched the container (no resize) — reframe is a no-op here, but stays correct if the
      // seed had been padded for a different count. Place the cursor + unhide the now-complete frame.
      settleFrame(generation).then(() => {
        if (!disposed && generation === fitGeneration) {
          placeCursor();
          if (!streamMode) reveal();
        }
      });
    };
    const scheduleFit = () => {
      const generation = ++fitGeneration;
      if (streamMode) streamLayoutSettled = false;
      if (fitRaf != null) cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(() => {
        fitRaf = null;
        fit(0, generation);
      });
    };
    fitRef.current = scheduleFit; // let the imperative font controls trigger a re-fit

    // visualViewport emits several intermediate sizes while the software keyboard animates. Re-fitting
    // each one exposes xterm's resized-but-not-yet-repainted grid for a frame. Keep the last committed
    // bottom-anchored frame, let the mirror continue consuming output, and commit only after both the
    // reported inset and the viewport geometry stay unchanged across two frame intervals.
    const scheduleSettledFit = () => {
      const generation = ++layoutSettleGeneration;
      // Invalidate an already queued/running fit immediately. Waiting for the next stable signature to call
      // scheduleFit() is too late: the old fit could otherwise commit an intermediate keyboard height first.
      fitGeneration += 1;
      if (fitRaf != null) {
        cancelAnimationFrame(fitRaf);
        fitRaf = null;
      }
      if (streamMode) streamLayoutSettled = false;
      if (layoutSettleRaf != null) cancelAnimationFrame(layoutSettleRaf);
      let previousSignature = '';
      let stableIntervals = 0;
      const waitForStableViewport = () => {
        if (disposed || generation !== layoutSettleGeneration) return;
        const viewport = window.visualViewport;
        const signature = [
          Math.round(insetRef.current),
          Math.round(viewport?.height ?? window.innerHeight),
          Math.round(viewport?.offsetTop ?? 0),
        ].join(':');
        stableIntervals = signature === previousSignature ? stableIntervals + 1 : 0;
        previousSignature = signature;
        if (stableIntervals >= 2) {
          layoutSettleRaf = null;
          scheduleFit();
          return;
        }
        layoutSettleRaf = requestAnimationFrame(waitForStableViewport);
      };
      layoutSettleRaf = requestAnimationFrame(waitForStableViewport);
    };
    settleLayoutFitRef.current = scheduleSettledFit;
    const onResize = () => {
      if (streamMode) scheduleSettledFit();
      else scheduleFit();
    };
    // iOS opens/closes the soft keyboard by resizing visualViewport without reliably resizing window.
    // The derived inset can stay 0 on BOTH sides of close when offsetTop had already cancelled the app
    // lift, so the inset effect cannot be the only refit trigger: the terminal would keep its short grid.
    const visualViewport = window.visualViewport;
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    visualViewport?.addEventListener('resize', onResize);
    // The bottom dock's height changes (swiping to the composer, the composer growing to multi-line)
    // resize THIS container without firing a window resize, so a plain resize listener misses them.
    // Re-fit ONLY when the container GREW: the grid is bottom-aligned, so a container that grew leaves a
    // blank strip at the TOP (needs a fit to fill), while a container that SHRANK just clips a few top
    // rows harmlessly — the bottom (the live prompt) stays put. Re-fitting on every shrink is exactly
    // what made multi-line typing flash: fit() calls term.resize(), which reflows and repaints the whole
    // grid. So shrinks are skipped; only a genuine top-gap triggers a fit. fit() resizes xterm's internal
    // grid, not the container box, so it can't drive the observer into a loop.
    let lastFitH = elRef.current?.clientHeight || 0;
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          const h = elRef.current?.clientHeight || 0;
          if (!h) return;
          const grew = h > lastFitH;
          lastFitH = h;
          if (grew) onResize();
        })
      : null;
    if (ro && elRef.current) ro.observe(elRef.current);

    const selection = createTerminalSelectionController({
      term,
      host: terminalHost,
      screenHost: liveHost,
      desktop,
      activeRef: selActiveRef,
      actionsRef: selActionsRef,
      setUI: setSelUI,
      setInfo: setSelInfo,
    });
    const touch = createTerminalTouchController({
      term,
      host: terminalHost,
      desktop,
      pane,
      fontRef,
      selection,
      selectionActiveRef: selActiveRef,
      stopFlingRef,
      getStreamExact: () => false,
      getAltScreen: () => altScreenRef.current,
      getMouseAware: () => mouseAwareRef.current,
      onActivity: () => { idleSince = Date.now(); },
      onUserScroll: () => { userScrolledRef.current = true; },
      showScrollPosition: showScrollPos,
      maybePullMore,
      scheduleFit,
      wake: () => wakeRef.current?.(),
      onTap: () => onTapRef.current?.(),
      onKeepKeyboard: () => onKeepKeyboardRef.current?.() ?? false,
    });
    freezeTouchForHistoryPull = touch.freezeHistoryGesture;
    settleHistoryAnchor = touch.settleHistoryAnchor;

    // Rebuild the persistent doc-path UNDERLINE after each full repaint (the visual cue; the actual
    // tap is handled by the link provider above). Underline-only (no bg) so it can't trigger the
    // scroll/BCE shading trap. Markers/decorations are disposed and recreated every repaint to match
    // the poll-and-repaint model. decoration.dispose() does NOT dispose its marker in @xterm/xterm
    // 5.5, so we track and dispose both each refresh (markers near baseY aren't trimmed, so they'd
    // otherwise accumulate over a long session).
    const refreshDocDecorations = (t: XTerm): void => {
      for (const { deco, marker } of decosRef.current) { deco.dispose(); marker.dispose(); }
      decosRef.current = [];
      if (!onDocLinkTapRef.current || !docHighlightRef.current) return; // off → clear + draw nothing
      const b = t.buffer.active;
      const cursorAbsY = b.baseY + b.cursorY;
      for (const { y, x, width } of scanDocLinks(t)) {
        const marker = t.registerMarker(y - cursorAbsY);
        if (!marker) continue;
        const deco = t.registerDecoration({ marker, x, width });
        if (!deco) { marker.dispose(); continue; }
        deco.onRender((el) => { el.classList.add('doc-deco'); });
        decosRef.current.push({ deco, marker });
      }
    };
    refreshDecosRef.current = () => { if (!disposed && seeded) refreshDocDecorations(term); };

    const applyStreamModes = (
      frame: Pick<TerminalStreamSnapshot, 'alt' | 'mouseAware'>,
    ): boolean => {
      const wasAlt = altScreenRef.current;
      const isAlt = !!frame.alt;
      altScreenRef.current = isAlt;
      mouseAwareRef.current = !!frame.mouseAware;
      setAltScreen((value) => (value === isAlt ? value : isAlt));
      if (wasAlt !== isAlt) scheduleFit();
      return wasAlt && !isAlt;
    };

    const followLiveCursor = () => {
      if (!streamMode || insetRef.current <= 0 || !altScreenRef.current) return;
      const b = buf();
      const target = followTarget({
        cursorLine: b.baseY + b.cursorY,
        viewportY: b.viewportY,
        visibleRows: term.rows,
        baseY: b.baseY,
        armed: followArmedRef.current,
      });
      if (target != null) term.scrollToLine(target);
    };

    const paintStreamFrame = () => {
      streamPaintRaf = null;
      if (disposed || !streamMode || !streamMirrorReady || !streamLayoutSettled
        || historyMode || !streamMirror
        || selActiveRef.current) return;
      if (streamPaintBusy) {
        streamPaintQueued = true;
        return;
      }
      const mirror = streamMirror;
      const frame = mirror.snapshot();
      if (!frame) return;
      const layoutGeneration = fitGeneration;
      let paintFinished = false;
      const finishStreamPaint = ({
        aborted = false,
        resync = false,
        reschedule = true,
      } = {}) => {
        if (paintFinished) return;
        paintFinished = true;
        streamPaintBusy = false;
        if (!disposed && streamMode && resync) streamClient?.resync();
        if (!reschedule || disposed || !streamMode || historyMode || selActiveRef.current
          || !streamLayoutSettled) return;
        if (aborted || streamPaintQueued || mirror.revision > frame.revision) {
          scheduleStreamRender();
        }
      };
      streamPaintBusy = true;
      streamPaintQueued = false;
      lastStreamPaintAt = Date.now();
      const firstFrame = !seeded;
      const keepPosition = !firstFrame && !atBottom();
      const anchorFromBottom = keepPosition ? buf().length - buf().viewportY : 0;
      if (frame.paneCols && frame.paneCols !== term.cols) {
        term.resize(frame.paneCols, term.rows);
      }
      const pad = frame.alt ? 0 : Math.max(0, term.rows - frame.bufferRows);
      const padding = pad ? '\r\n'.repeat(pad) : '';
      const cursorMode = cursorSeq(
        frame.cur,
        term.rows,
        frame.bufferRows + pad,
        forceCursorRef.current,
      );
      term.write(
        `\x1b[?1049l\x1b[?25l\x1b[0m\x1b[2J\x1b[3J\x1b[H${padding}${frame.ansi}`,
        () => {
          if (disposed || !streamMode) {
            finishStreamPaint();
            return;
          }
          if (!streamLayoutSettled || layoutGeneration !== fitGeneration) {
            finishStreamPaint({ aborted: true });
            return;
          }
          const leftAltScreen = applyStreamModes(frame);
          paneRows = frame.paneRows;
          seedRows = frame.bufferRows + pad;
          curInfo = null;
          streamCursorVisible = frame.cursorVisible;
          streamCursorOwned = true;
          liveBoundaryLine = frame.boundaryLine != null
            && Number.isFinite(frame.boundaryLine) && frame.boundaryLine > 0
            ? frame.boundaryLine + pad
            : null;
          if (frame.cursorVisible) forceCursorRef.current = false;
          if (keepPosition) {
            term.scrollToLine(Math.max(0, buf().length - anchorFromBottom));
          } else if (frame.alt && firstFrame) {
            term.scrollToTop();
          } else {
            term.scrollToBottom();
          }
          followLiveCursor();
          if (!streamLayoutSettled || layoutGeneration !== fitGeneration) {
            finishStreamPaint({ aborted: true, resync: leftAltScreen });
            return;
          }
          if (streamPaintQueued || mirror.revision > frame.revision) {
            finishStreamPaint({ aborted: true, resync: leftAltScreen });
            return;
          }
          // Keep the native cursor hidden while content is replayed and the viewport is restored,
          // then place the cursor from the same immutable mirror revision in a second parser write.
          term.write(cursorMode, () => {
            if (disposed || !streamMode) {
              finishStreamPaint();
              return;
            }
            if (!streamLayoutSettled || layoutGeneration !== fitGeneration
              || streamPaintQueued || mirror.revision > frame.revision) {
              finishStreamPaint({ aborted: true, resync: leftAltScreen });
              return;
            }
            seeded = true;
            setPaused(false);
            setConn(nextConnection(connState, 'ok'));
            try { refreshDocDecorations(term); } catch { /* cosmetic */ }
            drawHistoryBoundary();
            placeCursor();
            reveal();
            finishStreamPaint({ resync: leftAltScreen });
          });
        },
      );
    };
    scheduleStreamRender = ({ immediate = false } = {}) => {
      if (disposed || historyMode || !streamLayoutSettled) return;
      if (immediate && streamPaintTimer != null) {
        clearTimeout(streamPaintTimer);
        streamPaintTimer = null;
      }
      if (streamPaintRaf != null || streamPaintTimer != null) return;
      const delay = streamPaintDelay({
        now: Date.now(),
        lastPaintAt: lastStreamPaintAt,
        immediate,
      });
      if (delay > 0) {
        streamPaintTimer = setTimeout(() => {
          streamPaintTimer = null;
          scheduleStreamRender();
        }, delay);
        return;
      }
      streamPaintRaf = requestAnimationFrame(paintStreamFrame);
    };

    const applyStreamSeed = async (frame: TerminalSeedMessage): Promise<void> => {
      const mirror = streamMirror;
      if (disposed || !mirror) return;
      const recoveringInBackground = streamRecoveryInProgress && !streamMode;
      if (streamFallbackTimer) {
        clearTimeout(streamFallbackTimer);
        streamFallbackTimer = null;
      }
      streamMirrorReady = false;
      streamCursorOwned = false;
      streamCursorVisible = false;
      historyMode = false;
      lastHash = null;
      depth = Math.max(liveDepth(), Number(frame.historyLines) || 0);
      if (!recoveringInBackground) {
        streamSeedNeedsFit = !revealed
          || frame.width !== term.cols
          || frame.height !== paneRows
          || !!frame.alt !== altScreenRef.current;
        paneRows = frame.height;
        altScreenRef.current = !!frame.alt;
        mouseAwareRef.current = !!frame.mouseAware;
        setAltScreen((value) => (value === !!frame.alt ? value : !!frame.alt));
      }
      await mirror.seed(frame);
      if (disposed) return;
      if (!recoveringInBackground) {
        lastAnsi = frame.ansi;
        lastCur = '';
        curInfo = null;
        setPaused(false);
      }
    };

    const applyStreamData = async (data: Uint8Array): Promise<void> => {
      const mirror = streamMirror;
      if (disposed || !mirror) return;
      await mirror.data(data);
      if (!disposed && streamMirrorReady && !historyMode) scheduleStreamRender();
    };

    const finishStreamSeed = async ({ cur }: TerminalReadyMessage): Promise<void> => {
      const mirror = streamMirror;
      if (disposed || !mirror) return;
      const recoveringInBackground = streamRecoveryInProgress && !streamMode;
      if (!recoveringInBackground) {
        streamCursorVisible = !!cur?.vis;
        lastCur = cur ? `${cur.row},${cur.col},${cur.vis ? 1 : 0}` : '';
      }
      await mirror.ready(cur);
      if (disposed) return;
      streamMirrorReady = true;
      if (!recoveringInBackground) {
        if (streamSeedNeedsFit) scheduleFit();
        else scheduleStreamRender({ immediate: true });
        setTimeout(() => {
          if (!disposed && streamMirrorReady && !revealed) {
            // Geometry can be temporarily unmeasurable while a newly-mounted PWA is becoming visible.
            // Keep this as a black-screen safety net only; normal first paint is released by fit().
            streamLayoutSettled = true;
            scheduleStreamRender({ immediate: true });
          }
        }, 400);
      }
    };

    const repaint = async (
      lines: number,
      keepPosition: boolean,
      preserveLatestPosition = false,
    ): Promise<boolean> => {
      if (busy || disposed) return false;
      busy = true;
      const startedInStreamMode = streamMode;
      const requestStartedAt = Date.now();
      // Keep anchors in xterm's integer row space to avoid fractional DOM-row drift. Normal refreshes use
      // the request-start position; deeper history refreshes replace it with the latest position on arrival.
      let anchorFromBottom = keepPosition ? buf().length - buf().viewportY : 0;
      try {
        const hist = await getHistory(pane, lines, lastHash);
        if (disposed) return false;
        // A background WebSocket recovery may have completed while this snapshot request was in flight.
        // Never let the older snapshot overwrite the newly activated live frame.
        if (!startedInStreamMode && streamMode) return false;
        telemetry.sample({ ok: true, rttMs: Date.now() - requestStartedAt });
        setConn(nextConnection(connState, 'ok')); // a successful poll → connected (clears the banner)
        // A desktop drag may have started while this request was in flight. Never apply that stale
        // snapshot: rewriting xterm would erase the selection before the user can copy it.
        if (selActiveRef.current) return false;
        // 204: server says the screen is identical to lastHash — keep what's drawn, transmit nothing.
        if (hist.unchanged) { setPaused(keepPosition); return true; }
        // A desktop wheel stream remains live while the request is in flight. Preserve the position the
        // user has reached NOW, not the stale position from request start (notably after reversing direction).
        if (keepPosition && preserveLatestPosition) {
          anchorFromBottom = buf().length - buf().viewportY;
        }
        lastHash = hist.hash;       // a real frame: remember its hash for the next ?since=
        altScreenRef.current = !!hist.alt; // pane on the alternate screen? → no scrollback to swipe
        mouseAwareRef.current = !!hist.mouseAware; // …but if the app reports mouse, a swipe can wheel-scroll it
        setAltScreen((v) => (v === !!hist.alt ? v : !!hist.alt)); // toggle the pager buttons (no-op if unchanged)
        idleSince = Date.now();     // …and treat the change as activity → cadence stays/returns fast
        // Match cols to the real pane so wrapping is identical (rows are NOT pinned to the
        // pane — fit() sizes them to fill the container height instead).
        let resized = false;
        if (hist.width && hist.width !== term.cols) {
          term.resize(hist.width, term.rows);
          resized = true;
        }
        const prevPaneRows = paneRows;
        if (hist.height) paneRows = hist.height;
        const firstSeed = !seeded;
        // Skip the repaint when nothing changed (idle pane) so the 1s tick doesn't clear,
        // rewrite and scroll-to-bottom while you're trying to scroll. The cursor counts as content:
        // a bare left/right moves it without changing the text, and that still has to repaint or the
        // cursor would never visibly track (the server already folds it into the change-hash).
        const curKey = hist.cur ? `${hist.cur.row},${hist.cur.col},${hist.cur.vis ? 1 : 0}` : '';
        if (!resized && !firstSeed && hist.ansi === lastAnsi && curKey === lastCur) {
          setPaused(keepPosition);
          return true;
        }
        // prepareSeed resets attributes at every line end so an unreset background can't leak
        // between rows. The leading \x1b[0m guards the seam between frames: prepareSeed drops the
        // snapshot's trailing newline, so its last line carries no reset, and erase-in-display
        // would otherwise fill the screen with that residual background (BCE) before the repaint.
        // Lead with \x1b[?25l (hide): the seed rewrites the whole screen, parking xterm's cursor at the
        // end of the written text (≈bottom-left) until placeCursor moves it — hiding it through the
        // rewrite stops that one-frame flash at the wrong spot. placeCursor below re-shows it (or keeps
        // it hidden) at Claude's real cell.
        const seed = prepareSeed(hist.ansi);
        const contentRows = seed ? seed.split('\n').length : 0;
        // Remember the RAW content so a later fit() (which changes term.rows AFTER this seed) can re-pad it
        // for the final grid height — otherwise short content stays padded for the pre-fit rows (see reframeForRows).
        lastSeed = { seed, contentRows, alt: hist.alt };
        // Normal screen with content shorter than the grid: bottom-align it so the last row (the live
        // prompt) sits at the grid bottom (just above the keyboard/dock), not stranded at the top with
        // blank below. Alt-screen keeps its own layout (cursor-centering handles it), so skip there.
        const pad = (!hist.alt && contentRows < term.rows) ? bottomPadRows(contentRows, term.rows) : 0;
        const framed = pad ? ('\n'.repeat(pad) + seed) : seed;
        // seedRows = rows ACTUALLY written (incl. bottom-align padding). cursorSeq/cursorBufferLine count
        // cur.row up from the bottom of this, so padding shifts the cursor to the grid bottom correctly.
        seedRows = framed ? framed.split('\n').length : 0;
        await new Promise<void>((resolve) => {
          term.write('\x1b[?25l\x1b[0m\x1b[2J\x1b[3J\x1b[H' + framed, resolve);
        });
        if (disposed) return false;
        if (historyMode && typeof hist.historyLines === 'number'
          && Number.isFinite(hist.historyLines)) {
          liveBoundaryLine = hist.historyLines;
          drawHistoryBoundary();
        }
        lastAnsi = hist.ansi;
        lastCur = curKey;
        curInfo = hist.cur ?? null; // placed by placeCursor() below (and again by fit, after any resize)
        // Reveal-on-activity handoff: a send set forceCursorRef so the block stays lit while the app hides
        // the cursor (Claude working). The moment the app shows its OWN cursor again (cur.vis=1 → back to
        // idle/accepting input), drop the force so a LATER app-driven hide can hide it normally.
        if (hist.cur && hist.cur.vis) forceCursorRef.current = false;
        if (keepPosition) {
          const target = Math.max(0, buf().length - anchorFromBottom);
          if (preserveLatestPosition) settleHistoryAnchor(target);
          else term.scrollToLine(target);
        }
        // A full-screen app opens on its FIRST line (firstSeed only); after that, reaching the bottom follows
        // new output like any live pane — NOT a yank back to the top on every at-bottom repaint.
        else if (altScreenRef.current && firstSeed) term.scrollToTop();
        else term.scrollToBottom();
        // Alt-screen cursor-follow (keyboard up): a cursor MOVE re-arms follow; then recenter only if the
        // cursor left the visible window — so manual scrolling that keeps it visible stays put, typing
        // brings it back. Overrides the keepPosition/bottom scroll above when it fires.
        if (altScreenRef.current && insetRef.current > 0) {
          if (curKey !== lastCurForFollowRef.current) {
            if (!firstSeed) followArmedRef.current = true; // a real cursor MOVE arms follow; the first frame keeps the top
            lastCurForFollowRef.current = curKey;
          }
          const line = cursorBufferLine(hist.cur, seedRows);
          if (line != null) {
            const t = followTarget({
              cursorLine: line, viewportY: buf().viewportY, visibleRows: term.rows,
              baseY: buf().baseY, armed: followArmedRef.current,
            });
            if (t != null) term.scrollToLine(t);
          }
        }
        syncYScrollbar();
        seeded = true;
        // success path only — a failed/unchanged poll keeps the last decorations.
        try { refreshDocDecorations(term); } catch { /* decorations are cosmetic; never fail the poll */ }
        setPaused(keepPosition);
        // Cursor goes on AFTER the scroll (never in the seed — see cursorSeq). When a fit is coming it
        // resizes first and re-places the cursor itself; otherwise place it now.
        placeCursor();
        if (resized || firstSeed || paneRows !== prevPaneRows) scheduleFit();
        // Backstop: if that fit's RAF chain ever early-returns before settling (grid not yet
        // measurable), reveal anyway so a switched pane can't get stuck hidden. Idempotent with fit's.
        if (firstSeed) setTimeout(reveal, 400);
        return true;
      } catch (e) {
        telemetry.sample({ ok: false, rttMs: Date.now() - requestStartedAt });
        if (e instanceof UnauthorizedError) onAuthFailRef.current?.();
        else if (!disposed) setConn(nextConnection(connState, 'fail')); // network/500/timeout → maybe disconnect
        return false;
      } finally {
        busy = false;
        // Refresh the history readout now that busy cleared (drop the "· 拉取中" tag; the coast is stopped so
        // no later frame would). scrollToLine set viewportY synchronously, so a plain read is already fresh.
        if (!disposed && seeded) showScrollPos();
        // Input landed while this poll was in flight — its output isn't in the frame just drawn,
        // so go straight back for it (startLoop bumps the epoch; the stale pending tick is dropped).
        if (wakeAgain && !disposed) { wakeAgain = false; startLoop(); }
      }
    };

    // One poll attempt, with the same guards the old liveTick had. A guard hit is a "skip" — it
    // neither succeeds nor fails the connection, so the next delay falls back to the idle-adaptive cadence.
    const pollOnce = async () => {
      if (busy || disposed) return;
      if (selActiveRef.current) return; // a selection is showing — repainting would wipe it
      // Browsing history (scrolled past the live zone) → hold still. EXCEPT alt-screen: a full-screen app is
      // live, so keep polling even when scrolled up (repaint(keepPosition) preserves the internal offset).
      if (seeded && !nearBottom() && !altScreenRef.current) { setPaused(true); return; }
      depth = liveDepth();
      // at the very bottom → follow new output (scrollToBottom); scrolled up within the live zone →
      // refresh in place (keepPosition) so a live pane doesn't yank you to the bottom on every frame.
      await repaint(depth, !atBottom()); // repaint updates connState via setConn (ok / fail)
    };
    // Self-scheduling loop (replaces setInterval): healthy → idleDelay (fast while active, easing to 10s idle), failing → backoff. Each
    // run carries the epoch it started under; if the loop is restarted while a tick is suspended at
    // its awaited poll (e.g. a hide→show mid-fetch), the stale tick sees a bumped epoch on resume
    // and bails instead of scheduling a second chain — without this, hide/show during a poll leaks
    // timers (two chains, only one tracked by `timer`).
    let epoch = 0;
    async function tick(myEpoch: number): Promise<void> {
      if (!disposed && myEpoch === epoch) await pollOnce();
      if (disposed || document.hidden || myEpoch !== epoch) return;
      const delay = connState.failCount > 0
        ? backoffDelay(connState.failCount)
        : idleDelay(Date.now() - idleSince, snapshotIntervalRef.current); // healthy: slow down while idle, fast while active
      timer = setTimeout(() => tick(myEpoch), delay);
    }
    const startLoop = () => {
      epoch += 1;
      if (timer) { clearTimeout(timer); timer = null; }
      tick(epoch);
    };
    const fallbackToPolling = async (
      reason: TerminalTransportFallback = 'network',
    ): Promise<void> => {
      if (disposed || !streamMode) return;
      streamMode = false;
      streamRecoveryInProgress = false;
      historyMode = false;
      if (streamHistoryTimer) {
        clearTimeout(streamHistoryTimer);
        streamHistoryTimer = null;
      }
      streamMirrorReady = false;
      streamPaintQueued = false;
      if (streamPaintRaf != null) {
        cancelAnimationFrame(streamPaintRaf);
        streamPaintRaf = null;
      }
      if (streamPaintTimer != null) {
        clearTimeout(streamPaintTimer);
        streamPaintTimer = null;
      }
      const drained = streamClient?.suspend?.();
      setStreamStatus('off');
      setTransportFallback(reason);
      telemetry.setMode('snapshot', { fallback: true });
      setConn(nextConnection(connState, 'reset'));
      try { await drained; } catch { /* stream failure already surfaced */ }
      if (disposed) return;
      scheduleFit();
      startLoop();
    };
    const handleStreamStatus = (status: TerminalStreamStatus): void => {
      if (disposed) return;
      setStreamStatus(status);
      telemetry.status(status);
      if (status === 'live') {
        streamHasBeenLive = true;
        if (streamFallbackTimer) {
          clearTimeout(streamFallbackTimer);
          streamFallbackTimer = null;
        }
        if (streamRecoveryInProgress && !streamMode) {
          if (document.hidden || selActiveRef.current || (seeded && !nearBottom())) {
            streamRecoveryInProgress = false;
            streamMirrorReady = false;
            streamClient?.suspend();
            setStreamStatus('off');
            return;
          }
          streamRecoveryInProgress = false;
          streamMode = true;
          historyMode = false;
          epoch += 1;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          telemetry.setMode('live');
          setTransportFallback(null);
          setConn(nextConnection(connState, 'reset'));
          scheduleFit();
        }
        return;
      }
      if (status !== 'reconnecting' && status !== 'error') return;
      if (streamRecoveryInProgress && !streamMode) {
        streamRecoveryInProgress = false;
        streamClient?.suspend();
        setStreamStatus('off');
        return;
      }
      if (streamMode && !streamFallbackTimer) {
        streamFallbackTimer = setTimeout(
          () => fallbackToPolling(streamHasBeenLive ? 'network' : 'unavailable'),
          1200,
        );
      }
    };
    const connectStream = async () => {
      if (!streamMirror) {
        streamMirror = createTerminalStreamMirror({ scrollback: MAX_LINES + 100 });
      }
      if (streamClient) {
        streamClient.resync();
        return;
      }
      streamClient = openTerminalStream({
        pane,
        onSeed: applyStreamSeed,
        onData: applyStreamData,
        onReady: finishStreamSeed,
        onStatus: handleStreamStatus,
        onProbe: (sample) => telemetry.sample(sample),
        onAuthFail: () => onAuthFailRef.current?.(),
      });
    };
    maybeRecoverStream = () => {
      const currentConnection = telemetry.peek();
      if (disposed || streamMode || streamRecoveryInProgress || !stream || document.hidden
        || currentConnection.mode !== 'snapshot' || currentConnection.stableQuality !== 'good'
        || selActiveRef.current || (seeded && !nearBottom())) return;
      streamRecoveryInProgress = true;
      connectStream().catch(() => {
        if (disposed) return;
        streamRecoveryInProgress = false;
        telemetry.status('error');
        setStreamStatus('off');
      });
    };
    if (streamMode) connectStream().catch(() => fallbackToPolling('unavailable'));
    else startLoop();
    const resumeStream = () => {
      if (!streamMode || disposed) return;
      historyMode = false;
      if (streamHistoryTimer) {
        clearTimeout(streamHistoryTimer);
        streamHistoryTimer = null;
      }
      streamMirrorReady = false;
      streamCursorOwned = false;
      liveBoundaryLine = null;
      disposeHistoryBoundary();
      setPaused(false);
      setScrollInfo('');
      setStreamStatus('connecting');
      streamClient?.resync();
    };
    resyncRef.current = resumeStream;
    // Outside input (a send/keypress from App) calls this: reset the idle clock and poll NOW — the
    // keystroke's echo should be visible immediately, not at the next tick (up to 1s away even on
    // the fast cadence). If a poll is already in flight its frame predates the keystroke, so flag
    // wakeAgain and repaint() re-polls the moment it finishes — rapid keys coalesce into
    // back-to-back polls instead of stacking timer chains.
    const wake = () => {
      idleSince = Date.now();
      // A send/keypress is the user operating the terminal → reveal the cursor even if the app has hidden it
      // (Claude working). Hold it lit until the app shows its own cursor again — the repaint loop clears the
      // force on the first cur.vis=1 frame. placeCursor shows it this frame; the immediate poll re-places it.
      forceCursorRef.current = true;
      placeCursor();
      if (streamMode) {
        if (historyMode) resumeStream();
        else scheduleStreamRender();
        return;
      }
      if (busy) { wakeAgain = true; return; }
      startLoop();
    };
    wakeRef.current = wake;

    // Pause polling in the background (saves battery + server-side tmux spawns); on return, reset
    // health, repaint immediately (instant refresh), and resume the loop.
    const onVisibility = () => {
      if (streamMode) {
        if (document.hidden) {
          hiddenAt = Date.now();
          streamBackgroundSuspended = false;
          streamClient?.pause();
          if (streamBackgroundTimer) clearTimeout(streamBackgroundTimer);
          streamBackgroundTimer = setTimeout(() => {
            streamBackgroundTimer = null;
            if (!disposed && document.hidden && streamMode) {
              streamBackgroundSuspended = true;
              streamClient?.suspend();
            }
          }, STREAM_BACKGROUND_RESET_MS);
        } else {
          const hiddenFor = hiddenAt === null ? 0 : Date.now() - hiddenAt;
          hiddenAt = null;
          if (streamBackgroundTimer) {
            clearTimeout(streamBackgroundTimer);
            streamBackgroundTimer = null;
          }
          // Background timers are throttled on phones, so enforce the cutoff again on return.
          if (hiddenFor >= STREAM_BACKGROUND_RESET_MS && !streamBackgroundSuspended) {
            streamClient?.suspend();
          }
          streamBackgroundSuspended = false;
          if (!historyMode) resumeStream();
        }
        return;
      }
      if (document.hidden) {
        epoch += 1; // invalidate any in-flight tick so it won't reschedule when it resumes
        if (timer) { clearTimeout(timer); timer = null; }
      } else {
        setConn(nextConnection(connState, 'reset'));
        depth = liveDepth();
        idleSince = Date.now(); // returning to the foreground is activity → resume at the fast cadence
        startLoop();
      }
    };
    // Some installed mobile WebViews return from another app without delivering the hidden -> visible pair.
    // In that path the browser can leave a dead WebSocket looking OPEN indefinitely. A lens switch fixes it
    // only because Terminal remounts; do the same connection replacement in place on every fallback wake.
    let lastForegroundWakeAt = 0;
    const onForegroundWake = () => {
      if (disposed || document.hidden) return;
      const now = Date.now();
      // visibilitychange, pageshow and focus often arrive as one burst. One fresh socket is enough.
      if (now - lastForegroundWakeAt < 100) return;
      lastForegroundWakeAt = now;
      if (streamMode) {
        streamClient?.suspend();
        resumeStream();
      } else {
        setConn(nextConnection(connState, 'reset'));
        depth = liveDepth();
        idleSince = now;
        startLoop();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onForegroundWake);
    window.addEventListener('focus', onForegroundWake);
    window.addEventListener('online', onForegroundWake);

    const handleBufferScroll = () => {
      if (disposed) return;
      syncYScrollbar();
      if (streamPaintBusy) return;
      if (atBottom()) {
        setPaused(false);
        setScrollInfo('');
        if (historyMode) resumeStream();
        else maybeRecoverStream();
        return;
      }
      if (streamMode && historyMode && nearBottom()) {
        resumeStream();
        return;
      }
      if (streamMode && !nearBottom() && !altScreenRef.current) pauseStreamForHistory();
      setPaused(streamMode ? historyMode : !nearBottom());
      showScrollPos();
      maybePullMore();
    };
    const sub = term.onScroll(handleBufferScroll);
    // Native touch/trackpad scrolling is translated by xterm's viewport with suppressScrollEvent=true:
    // buffer.viewportY changes, but the public term.onScroll above intentionally does not fire. Observe
    // the real viewport as well so returning to the 15-line live zone always resumes the stream.
    const liveViewport = liveHost.querySelector('.xterm-viewport');
    liveViewport?.addEventListener('scroll', handleBufferScroll);

    return () => {
      disposed = true;
      fitRef.current = null;
      settleLayoutFitRef.current = null;
      wakeRef.current = null;
      resyncRef.current = null;
      refreshDecosRef.current = null;
      touch.dispose();
      stopFlingRef.current = null;
      selection.dispose();
      if (timer) clearTimeout(timer);
      fitGeneration += 1;
      layoutSettleGeneration += 1;
      if (fitRaf != null) cancelAnimationFrame(fitRaf);
      if (layoutSettleRaf != null) cancelAnimationFrame(layoutSettleRaf);
      if (streamFallbackTimer) clearTimeout(streamFallbackTimer);
      if (streamBackgroundTimer) clearTimeout(streamBackgroundTimer);
      if (streamHistoryTimer) clearTimeout(streamHistoryTimer);
      streamClient?.close();
      streamMirror?.dispose();
      streamMirror = null;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onForegroundWake);
      window.removeEventListener('focus', onForegroundWake);
      window.removeEventListener('online', onForegroundWake);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      visualViewport?.removeEventListener('resize', onResize);
      ro?.disconnect();
      sub.dispose();
      liveViewport?.removeEventListener('scroll', handleBufferScroll);
      if (streamPaintRaf != null) cancelAnimationFrame(streamPaintRaf);
      if (streamPaintTimer != null) clearTimeout(streamPaintTimer);
      telemetry.destroy();
      for (const { deco, marker } of decosRef.current) { deco.dispose(); marker.dispose(); }
      decosRef.current = [];
      disposeCursorDeco();
      disposeLocate();
      disposeHistoryBoundary();
      locateRef.current = null;
      disposeXterm();
      termRef.current = null;
      forwardPageKeyRef.current = null;
    };
  }, [pane, desktop, stream]);

  const resume = () => {
    stopFlingRef.current?.();
    // Force the xterm-viewport scrollTop to its maximum directly — the fling operates on this
    // element too, and xterm's scrollToBottom() may lag one frame if ydisp is still mid-fling.
    const vp = elRef.current?.querySelector('.terminal__live .xterm-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
    termRef.current?.scrollToBottom();
    setPaused(false);
    setScrollInfo(''); // clear the history-mode banner immediately
    resyncRef.current?.();
    wakeRef.current?.(); // re-poll right away so the live screen is confirmed at the bottom
  };

  // Page a full-screen (alt-screen) pane up/down. PageUp/PageDown is the one manual scroll that works in
  // any pager/editor regardless of mouse mode (arrows would move the cursor instead) — so it covers the
  // apps the wheel gesture can't (no mouse reporting) and gives precise paging in the ones it can.
  const pageScroll = async (dir: 'up' | 'down'): Promise<void> => {
    // Mirror the drag's nested-scroll fall-off: when the keyboard-shrunk grid leaves an internal window
    // (baseY > 0), page OUR window over the captured app screen first; only forward PageUp/PageDown to the
    // app once we're at the internal top/bottom. Keyboard down (baseY 0) → forward straight to the app.
    const term = termRef.current;
    const b = term?.buffer.active;
    const d = dir === 'up' ? -1 : 1;
    if (term && b && scrollDecision(b.viewportY, b.baseY, d) === 'internal') {
      term.scrollLines(d * Math.max(1, term.rows - 1)); // one page, minus a row of overlap
      userScrolledRef.current = true;                   // manual paging disarms cursor-follow
      return;
    }
    try { await sendKeys(pane, [dir === 'up' ? 'PageUp' : 'PageDown']); wakeRef.current?.(); }
    catch { /* transient (offline/timeout) — the button can just be tapped again */ }
  };

  // 定位 toggle: turn the cursor-line highlight on/off and apply it right away (locateRef redraws it).
  const toggleLocate = () => { const v = !locateOn; setLocateOn(v); locateOnRef.current = v; locateRef.current?.(); };
  const fitScreen = () => { fitScreenPendingRef.current = true; fitRef.current?.(); };

  // Copy the live selection, then drop the highlight + bubble. navigator.clipboard only exists in
  // a secure context (https/localhost); over plain http we fall back to a throwaway textarea +
  // execCommand so copy still works on the LAN.
  const clearSelectionUI = () => {
    termRef.current?.clearSelection();
    selActiveRef.current = false;
    setSelUI(null);
    setSelInfo('');
  };
  useBackButton(!!selUI, clearSelectionUI);
  useBackButton(transportOpen, () => setTransportOpen(false));
  useEffect(() => {
    if (!transportOpen) return undefined;
    setTransportNow(Date.now());
    const timer = setInterval(() => setTransportNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [transportOpen]);

  const doCopy = async () => {
    const term = termRef.current;
    const text = trimCopy(term?.getSelection() ?? '');
    if (text) {
      let ok = false;
      if (navigator.clipboard && window.isSecureContext) {
        try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall through */ }
      }
      if (!ok) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { document.execCommand('copy'); } catch { /* best effort */ }
        document.body.removeChild(ta);
      }
    }
    clearSelectionUI();
  };

  return (
    <div className="terminal-wrap">
      <div
        ref={elRef}
        className={`terminal${ready ? '' : ' terminal--loading'}${desktop ? ' desktop-input' : ''}${xOverflow ? ' terminal--x-overflow' : ''}${yOverflow ? ' terminal--y-overflow' : ''}${connectionInfo.mode === 'live' ? ' terminal--stream' : ''}`}
        onClick={() => setTransportOpen(false)}
      />
      {yScrollbar && (
        <div className={`terminal-y-scrollbar${xOverflow ? ' has-x' : ''}`} aria-hidden="true">
          <span style={{ top: `${yScrollbar.top}px`, height: `${yScrollbar.height}px` }} />
        </div>
      )}
      <TerminalOverlays
        ready={ready}
        connectionInfo={connectionInfo}
        configuredTransport={stream ? 'live' : 'snapshot'}
        transportFallback={transportFallback}
        transportOpen={transportOpen}
        transportNow={transportNow}
        onTransportToggle={() => {
          setTransportNow(Date.now());
          setTransportOpen((value) => !value);
        }}
        connected={connected}
        inputFailure={inputFailure}
        dbgVisible={dbgVisible}
        dbg={dbg}
        scrollInfo={scrollInfo}
        selInfo={selInfo}
        onResume={resume}
        altScreen={altScreen}
        onPageScroll={pageScroll}
        onFitScreen={fitScreen}
        locateOn={locateOn}
        onToggleLocate={toggleLocate}
        selUI={selUI}
        onCopy={doCopy}
        selActionsRef={selActionsRef}
        termRef={termRef}
      />
    </div>
  );
});

export default Terminal;
