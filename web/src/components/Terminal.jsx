import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { getHistory, scrollPane, sendKeys, UnauthorizedError } from '../api.js';
import { drainWheel, notchDir } from '../wheelScroll.js';
import { shouldKeepKeyboard } from '../dockKeyboard.js';
import { prepareSeed, cursorSeq } from '../terminalSeed.js';
import { getFont, setFont, clearFont, getDocHighlight } from '../storage.js';
import { backoffDelay } from '../backoff.js';
import { idleDelay } from '../cadence.js';
import { flingStep, shouldFling } from '../momentum.js';
import { initialConnection, nextConnection } from '../connection.js';
import { scanDocLinks, docLinksOnLine } from '../docDecorations.js';
import { ensureBundledFonts } from '../bundledFonts.js';
import { trimCopy, expandToLines, expandToParagraph, cellToPx } from '../terminalSelection.js';

const CALLOUT_W = 176; // estimated callout width (px) used for right-edge clamping; real-device-tuned
const LIVE_MARGIN = 20; // capture this many rows beyond the viewport so a small scroll-up has slack
                        // before triggering a deeper history pull (replaces the old fixed 100-line tail)
const CHUNK = 100; // how much more history to pull each time the top is reached (one page)
const MAX_LINES = 5000; // backend cap on capture depth
const LIVE_SCROLL_SLACK = 15; // scrolled up within this many lines of the bottom still counts as "live"
                              // (keep polling + follow new output); scroll up further to browse/pause

// Pane view backed by capture-pane snapshots (tmux's already-rendered grid — no cursor
// seam). While at the bottom we cheaply repaint a short tail every second. Scrolling up
// pauses the refresh; reaching the top pulls a deeper history slice and keeps the content
// you were looking at anchored in place, so it reads like loading more history above.
//
// Sizing: cols always match the real pane (identical wrapping; wider-than-screen panes scroll
// horizontally — see styles.css). Rows are sized to fill the container height at the current
// font and the grid is bottom-anchored, so the latest line is always flush with the bottom:
// a smaller font shows more rows (filled from scrollback), a larger font fewer. In AUTO mode
// (no manual pinch) the font also shrinks so the whole pane fits — full-screen TUIs stay whole.
// All of this lives in fit() below.
const Terminal = forwardRef(function Terminal({ pane, onAuthFail, onDocLinkTap, onTap }, ref) {
  const elRef = useRef(null);
  const termRef = useRef(null);
  const onTapRef = useRef(onTap); // a clean single tap → dismiss the dock keyboard (called synchronously)
  onTapRef.current = onTap;
  // Clickable doc-path underlines (xterm decorations), rebuilt after every full repaint. The tap
  // handler is held in a ref so the poll loop's stable closure always calls the latest prop (mirrors
  // how the loop reaches outside state via fitRef/wakeRef). Tapping a path does NOT open it directly
  // — it hands the path + tap coords to App, which shows a confirm popover (anti-误触).
  const decosRef = useRef([]);
  const onDocLinkTapRef = useRef(onDocLinkTap);
  onDocLinkTapRef.current = onDocLinkTap;
  // The doc-path wash is an opt-in visual cue (Settings toggle, default off) — paths stay tappable
  // regardless. Held in a ref the poll-loop closure reads; setDocHighlight() (imperative handle) flips it
  // and pokes refreshDecosRef to re-scan at once, without waiting for the next repaint.
  const docHighlightRef = useRef(getDocHighlight());
  const refreshDecosRef = useRef(null);
  // Terminal font is set by two-finger pinch and persisted. null = auto-fit (height).
  const fontRef = useRef(getFont());
  // Kills an in-flight inertial coast. Held in a ref (like fitRef/wakeRef) so resume() — defined in
  // component scope — can cancel the fling that lives in the touch-handling effect closure.
  const stopFlingRef = useRef(null);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(true); // false → show the disconnect banner
  // Touch selection: long-press starts a selection on the real grid (xterm draws the highlight
  // on its own layer, WebGL included), drag extends it, then a "复制" bubble copies it. selActive
  // is a ref so liveTick (effect scope) and the bubble (render scope) share the "don't repaint /
  // a selection is showing" flag without a re-render race.
  const selActiveRef = useRef(false);
  const [selUI, setSelUI] = useState(null); // {start:{x,y}, end:{x,y}} in .terminal-wrap px, or null
  const [selHint, setSelHint] = useState(false); // drag-to-select guidance; lingers a few sec after lift
  const selHintTimerRef = useRef(null);
  // Alt-screen (a full-screen app: vim/htop/less/a mouse-mode TUI) has no scrollback of its own, so a
  // vertical swipe can't scroll it the ordinary way. altScreenRef tracks the pane's state (set each poll
  // from the server's `alt` flag); a swipe over such a pane is forwarded to the app as scroll input it
  // understands — wheel events when it reports mouse (mouseAwareRef), else arrow keys (see flushWheel /
  // the vertical branch). altScreen (state) drives the always-available page up/down pager buttons.
  const altScreenRef = useRef(false);
  const mouseAwareRef = useRef(false);
  const [altScreen, setAltScreen] = useState(false);
  const [dbg, setDbg] = useState(''); // cols×rows·font readout, flashed on ⊟/⊞ then hidden
  const [dbgVisible, setDbgVisible] = useState(false);
  const flashHideRef = useRef(null);
  const flashPollRef = useRef(null);
  // History-mode banner text (历史模式 · 行 viewportY/baseY): non-empty only while browsing outside
  // the live zone; '' (hidden) when at/near the bottom and still live. Set by showScrollPos.
  const [scrollInfo, setScrollInfo] = useState('');
  // First-paint gate. A freshly-switched pane seeds into a default-size grid, then fit() grows/re-fits
  // it over a few RAF passes (and may shrink the font). Showing that means the screen appears
  // bottom-half-first and fills upward (the grid is bottom-anchored, see .terminal .xterm flex-end).
  // Keep the terminal hidden (opacity:0 — geometry preserved so fit can still measure) until the first
  // seed+fit settles, then reveal the complete frame in one go. false ⇔ still seeding/fitting.
  const [ready, setReady] = useState(false);
  // The effect's scheduleFit, surfaced so the font controls (below) can re-fit the row count
  // after changing the size from outside the effect scope.
  const fitRef = useRef(null);
  // wake() lets outside input (sends/keys, via App) snap the poll loop back to the live cadence and
  // poll immediately. Bridged through a ref like fitRef so the imperative handle can reach effect scope.
  const wakeRef = useRef(null);
  // Callout 整行/整段 buttons live in render scope but need effect-scope helpers (term, buf, refreshSelUI).
  // Bridged via a ref, same pattern as fitRef/wakeRef. Populated once inside the effect.
  const selActionsRef = useRef(null);

  // App's ⊟/⊞ buttons call getSize to step the grid, and flash to surface the resulting
  // cols×rows·font for ~3s (polling briefly because term.cols only catches up on the next
  // ~1s refresh).
  useImperativeHandle(ref, () => ({
    getSize: () => {
      const term = termRef.current;
      return term ? { cols: term.cols, rows: term.rows } : null;
    },
    flash: () => {
      const read = () => {
        const term = termRef.current;
        if (term) setDbg(`${term.cols}×${term.rows} · ${term.options.fontSize}px`);
      };
      read();
      setDbgVisible(true);
      clearTimeout(flashHideRef.current);
      clearInterval(flashPollRef.current);
      flashPollRef.current = setInterval(read, 400);
      flashHideRef.current = setTimeout(() => {
        setDbgVisible(false);
        clearInterval(flashPollRef.current);
      }, 3000);
    },
    // Settings-modal font controls (A−/A+/自适应). The two-finger pinch still works the same;
    // these are just an explicit way to drive the same persisted size.
    getFontSize: () => {
      const term = termRef.current;
      return term ? { size: term.options.fontSize, auto: fontRef.current == null } : null;
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
    // Settings' doc-path-highlight switch: flip the flag and re-scan now (default off, so no wash until on).
    setDocHighlight: (on) => { docHighlightRef.current = !!on; refreshDecosRef.current?.(); },
  }), []);

  useEffect(() => () => {
    clearTimeout(flashHideRef.current);
    clearInterval(flashPollRef.current);
  }, []);

  useEffect(() => {
    const term = new XTerm({
      disableStdin: true,
      // registerDecoration() — the doc-path highlight below — is a PROPOSED xterm API; without this it
      // throws "You must set the allowProposedApi option", which refreshDocDecorations' catch swallowed,
      // so the tappable paths never got their blue underline (only the link provider, which needs no
      // proposed API, kept working — hence "tappable but invisible").
      allowProposedApi: true,
      scrollback: MAX_LINES + 100,
      convertEol: false,
      fontSize: fontRef.current ?? 14,
      // The platform's native monospace comes FIRST so body text stays crisp (Android's WebGL
      // atlas renders the JetBrains web font a bit soft at small sizes). The two bundled fonts sit
      // at the end purely as fallbacks for glyphs the system lacks: 'JetBrainsMono Nerd Font' for
      // the Powerline/Nerd icons, then 'TW Unifont' (full BMP) for anything still missing — e.g.
      // Claude Code's ⏵ (U+23F5) and braille spinner, which Android has no system font for.
      // iOS/desktop have these in their system fonts, so the bundled ones rarely get used there.
      fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', 'Roboto Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Courier New', 'JetBrainsMono Nerd Font', 'TW Unifont', monospace",
      // A clearly visible touch-selection highlight (the default is a faint grey).
      theme: { selectionBackground: 'rgba(74,124,255,0.45)' },
      // The grid is read-only and never focused, so xterm draws the INACTIVE cursor — 'block'
      // (solid, inverts its cell) reads as a real cursor on Claude's input. It's only ever shown
      // where placeCursor()/cursorSeq puts it (and DECTCEM-hidden when Claude's cursor is hidden).
      cursorInactiveStyle: 'block',
    });
    term.open(elRef.current);
    termRef.current = term;
    // Make doc paths TAPPABLE. xterm decorations (the underline below) are visual-only — they sit
    // under the event-capturing .xterm-viewport and never receive taps — so clicks go through the
    // link provider instead, which hooks xterm's own hit-testing and fires through the viewport.
    // Same findDocLinks logic as the underline; handles wrapped paths (tap any row → open).
    const linkProvider = term.registerLinkProvider({
      provideLinks(lineNo, cb) {
        if (!onDocLinkTapRef.current) { cb(undefined); return; }
        const links = docLinksOnLine(term, lineNo).map(({ range, path }) => ({
          range,
          text: path,
          decorations: { pointerCursor: true, underline: false }, // underline is the persistent decoration
          activate: (e) => onDocLinkTapRef.current?.(path, e?.clientX ?? 0, e?.clientY ?? 0),
        }));
        cb(links.length ? links : undefined);
      },
    });
    // GPU rendering — much smoother scrolling than the default DOM renderer. Falls back to
    // the DOM renderer automatically if WebGL is unavailable or the context is lost.
    let webgl = null;
    const mountWebgl = () => {
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch { webgl = null; /* keep the default renderer */ }
    };
    mountWebgl();
    // Read-only display: keep xterm's hidden input from opening the mobile keyboard.
    const ta = elRef.current.querySelector('.xterm-helper-textarea');
    if (ta) {
      ta.readOnly = true;
      ta.tabIndex = -1;
      ta.setAttribute('inputmode', 'none');
      ta.setAttribute('aria-hidden', 'true');
    }
    let timer = null;
    let disposed = false;
    let busy = false;
    let wakeAgain = false; // a wake() landed mid-poll — re-poll right after the in-flight one finishes
    let seeded = false;
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
    setSelHint(false);
    // Live capture depth tracks the viewport (+margin) instead of a fixed 100, so we transmit and hash
    // only what's shown plus a little scroll-up slack. Floor 24 covers a not-yet-fit grid; cap at MAX_LINES.
    const liveDepth = () => Math.min(MAX_LINES, Math.max(24, term.rows + LIVE_MARGIN));
    let depth = liveDepth();
    let lastAnsi = null;
    let lastCur = ''; // last frame's cursor key (row,col,vis) — a cursor-only move must still repaint
    let curInfo = null; // last frame's cursor {row,col,vis}, placed by placeCursor() after sizing settles
    let seedRows = 0; // rows in the last seed (trimmed capture) — cur.row counts up from its bottom
    let lastHash = null; // last frame's server hash, echoed as ?since= so an unchanged screen returns 204
    let idleSince = Date.now(); // timestamp of the last change/activity → drives the adaptive cadence
    setPaused(false);
    setReady(false); // hide until the first seed+fit settles (see `ready` state above)
    let revealed = false;
    const reveal = () => {
      if (disposed || revealed) return;
      revealed = true;
      // One more frame so xterm paints the settled grid before we flip opacity — no stale 1-frame flash.
      requestAnimationFrame(() => { if (!disposed) setReady(true); });
    };
    let connState = initialConnection;
    const setConn = (s) => { connState = s; setConnected(s.connected); };

    // The WebGL glyph atlas is rasterized at open() time. On first open the bundled fonts often
    // aren't loaded yet, so the icons bake in as blank — switching panes (which remounts this
    // component, hence the renderer) is what made them appear. Reproduce that: once BOTH bundled
    // fonts are loaded, remount the WebGL renderer so its atlas is rebuilt with them.
    // ensureBundledFonts also RETRIES a failed font fetch (a failed @font-face never retries by
    // itself — the "symbols missing until restart" bug), so this may resolve late; the rebuild
    // then still happens and the icons pop in instead of staying blank for the session.
    ensureBundledFonts(fontRef.current ?? 14).then(() => {
      if (disposed || !webgl) return; // DOM renderer (no webgl) repaints on its own
      try { webgl.dispose(); } catch { /* ignore */ }
      mountWebgl();
      term.refresh(0, term.rows - 1);
    });

    const buf = () => term.buffer.active;
    // History-mode banner text. Shown ONLY while browsing outside the live zone (scrolled up far
    // enough that live refresh is paused) — inside the live zone, or at the bottom, it's still live so
    // there's nothing to show. Non-empty scrollInfo ⇔ history mode. `tag` marks a deeper-history pull.
    const showScrollPos = (tag = '') => {
      const b = buf();
      setScrollInfo(seeded && !nearBottom()
        ? `历史模式 · 行 ${b.viewportY}/${b.baseY}${busy ? ' · 拉取中' : ''}${tag}`
        : '');
    };
    const atBottom = () => buf().viewportY >= buf().baseY;
    // "Live zone": at the bottom OR scrolled up only a little. Inside it we keep polling so the screen
    // stays fresh — but only a true at-bottom view follows new output (scrollToBottom); scrolled up a
    // little we refresh IN PLACE (keepPosition, no yank to the bottom). Past the zone = browsing → pause.
    const nearBottom = () => buf().baseY - buf().viewportY <= LIVE_SCROLL_SLACK;
    // A few lines of slack: on mobile, momentum scrolling can stop a line or two short of
    // the very top and never fire another scroll event landing exactly on 0, so pulling
    // more history would never trigger. Treat "within 3 lines of the top" as the top.
    const atTop = () => buf().viewportY <= 3;
    // Pull a deeper history slice when sitting at the top. Driven from BOTH term.onScroll and the
    // touch handler: on some Androids onScroll doesn't fire reliably at the very top during native
    // momentum scroll, so the touch path is the dependable trigger. Idempotent while one is in
    // flight (!busy) and once the deepest slice is loaded (depth >= MAX_LINES).
    const maybePullMore = () => {
      if (!seeded || busy || depth >= MAX_LINES || !atTop()) return;
      depth = Math.min(depth + CHUNK, MAX_LINES);
      showScrollPos(' · 拉取↑');
      repaint(depth, true);
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
    const placeCursor = () => { if (!disposed) term.write(cursorSeq(curInfo, term.rows, seedRows)); };

    const fit = (pass = 0) => {
      if (disposed || !elRef.current || !term.rows) return;
      const avail = elRef.current.clientHeight;
      const screen = elRef.current.querySelector('.xterm-screen');
      const curH = screen ? screen.getBoundingClientRect().height : 0;
      if (!avail || !curH) return;
      const cellH = curH / term.rows;

      if (fontRef.current == null && paneRows && pass < 4) {
        const needed = paneRows * cellH;
        if (needed > avail + 4) {
          const cur = term.options.fontSize || 14;
          const next = Math.max(6, Math.round(cur * (avail / needed)));
          if (next < cur) {
            term.options.fontSize = next;
            requestAnimationFrame(() => fit(pass + 1));
            return;
          }
        }
      }

      const want = Math.max(1, Math.floor(avail / cellH));
      if (want !== term.rows) {
        // Hide + park the cursor at the bottom, WAIT for that write to apply (callback), THEN resize.
        // term.write is async (parsed on a later tick) but term.resize is SYNCHRONOUS — parking without
        // waiting let resize run while the cursor was still mid-buffer (placeCursor had put it on Claude's
        // cell), so growing the grid reflowed content into scrollback and left the screen half-blank for a
        // poll (the window-switch half-screen bug). Hidden too, so the cursor doesn't flash at the bottom
        // before placeCursor re-places it.
        term.write(`\x1b[?25l\x1b[${term.rows};1H`, () => {
          if (disposed) return;
          term.resize(term.cols, want);
          term.scrollToBottom();
          if (pass < 4) requestAnimationFrame(() => fit(pass + 1));
          else { placeCursor(); reveal(); } // last pass → grid settled: place cursor + reveal
        });
        return;
      }
      placeCursor(); // grid settled → safe to put the cursor on Claude's input cell
      reveal();      // …and unhide the now-complete frame (first paint only; idempotent after)
    };
    const scheduleFit = () => requestAnimationFrame(() => fit(0));
    fitRef.current = scheduleFit; // let the imperative font controls trigger a re-fit
    const onResize = () => scheduleFit();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
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
          if (grew) scheduleFit();
        })
      : null;
    if (ro && elRef.current) ro.observe(elRef.current);

    // Map a viewport point to a buffer cell {col,row}, clamped to the visible grid. cellW/cellH
    // come from the live .xterm-screen box so they track the current font and horizontal scroll.
    const cellFromPoint = (x, y) => {
      const screen = elRef.current?.querySelector('.xterm-screen');
      if (!screen || !term.cols || !term.rows) return null;
      const r = screen.getBoundingClientRect();
      const cw = r.width / term.cols;
      const ch = r.height / term.rows;
      if (!cw || !ch) return null;
      const col = Math.max(0, Math.min(term.cols - 1, Math.floor((x - r.left) / cw)));
      const vrow = Math.max(0, Math.min(term.rows - 1, Math.floor((y - r.top) / ch)));
      return { col, row: buf().viewportY + vrow };
    };
    let selAnchor = null; // {col,row} fixed end of the drag selection
    // Start a selection at the long-pressed cell, pre-selecting the word under the finger so
    // there's immediate visible feedback (lift without dragging copies just that word).
    // Recompute the handle/callout overlay from xterm's current selection (the single source of truth).
    const refreshSelUI = () => {
      const pos = term.getSelectionPosition?.();
      const screen = elRef.current?.querySelector('.xterm-screen');
      if (!pos || !screen) { setSelUI(null); return; }
      const sr = screen.getBoundingClientRect();
      const wr = elRef.current.parentElement.getBoundingClientRect(); // .terminal-wrap
      const cw = sr.width / term.cols;
      const ch = sr.height / term.rows;
      const vy = buf().viewportY;
      const off = { x: sr.left - wr.left, y: sr.top - wr.top };
      const s = cellToPx(pos.start.x, pos.start.y, vy, cw, ch);
      const e = cellToPx(pos.end.x + 1, pos.end.y, vy, cw, ch); // end handle sits after the last cell
      setSelUI({
        start: { x: s.x + off.x, y: s.y + off.y, ch },
        end: { x: e.x + off.x, y: e.y + off.y, ch },
        wrapW: wr.width,
      });
    };
    // Helpers for the callout expand buttons (整行 / 整段). currentRange() reads xterm's live
    // selection in the {start,end} col/row form expected by terminalSelection.js. selectRange()
    // applies a new range back to xterm and refreshes the overlay. paraLineText() feeds the
    // paragraph-expand function the line text it needs to locate blank-line boundaries.
    const currentRange = () => {
      const p = term.getSelectionPosition();
      return p && { start: { col: p.start.x, row: p.start.y }, end: { col: p.end.x, row: p.end.y } };
    };
    const paraLineText = (row) => buf().getLine(row)?.translateToString(true) ?? '';
    const selectRange = (r) => {
      if (!r) return;
      const cols = term.cols;
      const len = (r.end.row * cols + r.end.col) - (r.start.row * cols + r.start.col) + 1;
      term.select(r.start.col, r.start.row, len);
      refreshSelUI();
    };
    selActionsRef.current = { currentRange, paraLineText, selectRange };
    const startSelection = (x, y) => {
      const cell = cellFromPoint(x, y);
      if (!cell) return;
      const s = buf().getLine(cell.row)?.translateToString(false) ?? '';
      let a = cell.col;
      let b = cell.col;
      if (/\S/.test(s[cell.col] || '')) {
        while (a > 0 && /\S/.test(s[a - 1])) a--;
        while (b < term.cols - 1 && /\S/.test(s[b + 1])) b++;
      }
      selAnchor = { col: a, row: cell.row };
      selActiveRef.current = true;
      setSelUI(null);
      // tell the user to KEEP dragging — the missing step most users never discover. Stays up while
      // the finger is down (no timer yet); the linger timer starts on lift (onTouchEnd).
      clearTimeout(selHintTimerRef.current);
      setSelHint(true);
      term.select(a, cell.row, b - a + 1);
      refreshSelUI();
      navigator.vibrate?.(12);
    };
    // Extend from the fixed anchor to the finger cell (offsets flatten the grid so the run wraps
    // across rows exactly like text selection).
    const extendSelection = (x, y) => {
      const cur = cellFromPoint(x, y);
      if (!cur || !selAnchor) return;
      const cols = term.cols;
      const aOff = selAnchor.row * cols + selAnchor.col;
      const cOff = cur.row * cols + cur.col;
      const startOff = Math.min(aOff, cOff);
      term.select(startOff % cols, Math.floor(startOff / cols), Math.abs(cOff - aOff) + 1);
      refreshSelUI();
    };
    // Drop the current selection + bubble and let live refresh resume.
    const clearSelection = () => {
      selAnchor = null;
      selActiveRef.current = false;
      setSelUI(null);
      clearTimeout(selHintTimerRef.current);
      setSelHint(false);
      term.clearSelection();
    };
    // Touch handling (capture phase):
    //  - two fingers  → pinch to change the terminal font size (our render only);
    //  - long press   → start an in-terminal text selection, drag to extend (see selecting);
    //  - one finger horizontal → pan the container ourselves (xterm would swallow it);
    //  - one finger vertical → fall through to xterm's scrollback scrolling.
    const host = elRef.current;
    let sx = 0;
    let sy = 0;
    let sLeft = 0;
    let axis = 0; // 0 = undecided, 1 = horizontal, -1 = vertical/ignored
    let pinching = false;
    let pinchDist0 = 0; // finger distance and font size at pinch start
    let pinchFont0 = 0;
    let selecting = false; // a long-press fired and we're dragging out a selection
    let clearedOnDown = false; // this touch started by dismissing a live selection → its tap must NOT dismiss the kbd
    // Long-press (one finger held still ~500ms) starts a selection; any real movement, a lift,
    // or a second finger cancels it before it fires.
    let lpTimer = null;
    const cancelLongPress = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    // Inertial scroll on BOTH axes: neither the vertical scrollback (xterm's Viewport.handleTouchMove
    // sets scrollTop per touchmove) nor our own horizontal pan (host.scrollLeft, below) has momentum —
    // both track the finger 1:1 and stop dead on lift. So we sample the finger's velocity during the
    // drag (lastMove{X,Y}/T → scrollVel{X,Y}, px/ms) and, after a flick, coast the relevant scroll
    // offset ourselves. Vertical drives .xterm-viewport.scrollTop (each write fires xterm's own native
    // `scroll` listener → rows repaint through the glide); horizontal drives .terminal.scrollLeft.
    // No fight: vertical's owner (xterm) only scrolls while a finger is down; horizontal we own outright.
    let lastMoveX = 0;
    let lastMoveY = 0;
    let lastMoveT = 0;
    let scrollVelX = 0; // px/ms in scrollLeft direction (finger left = content scrolls right = +)
    let scrollVelY = 0; // px/ms in scrollTop  direction (finger up   = content scrolls down  = +)
    let flingRAF = null;
    const stopFling = () => { if (flingRAF != null) { cancelAnimationFrame(flingRAF); flingRAF = null; } };
    stopFlingRef.current = stopFling; // let resume() (component scope) interrupt a coast it can't reach
    // Coast `el[prop]` (prop = 'scrollTop' | 'scrollLeft') from velocity v0 with the shared decay curve.
    const startFling = (el, prop, v0) => {
      if (!el) return;
      let v = v0;
      let prevT = null;
      const frame = (t) => {
        if (prevT == null) { prevT = t; flingRAF = requestAnimationFrame(frame); return; } // set time base
        const dt = t - prevT;
        prevT = t;
        const s = flingStep(v, dt);
        v = s.v;
        const before = el[prop];
        el[prop] = before + s.delta; // scrollTop → fires xterm's scroll listener → repaint
        const hitEdge = Math.abs(s.delta) >= 1 && el[prop] === before; // clamped at an edge
        if (s.done || hitEdge) { flingRAF = null; return; }
        flingRAF = requestAnimationFrame(frame);
      };
      flingRAF = requestAnimationFrame(frame);
    };

    // Alt-screen swipe-to-scroll: translate the vertical drag into `count` line-notches the app scrolls on.
    // We accumulate finger travel (wheelAccum, px) and emit one notch per WHEEL_PX; notches are coalesced
    // (wheelPending) and sent one request at a time — so a fast flick becomes a couple of multi-line requests,
    // not dozens. HOW they're sent depends on the app: a mouse-reporting app gets real wheel events (/scroll,
    // which it scrolls on and ignores if it can't); a non-mouse app gets arrow keys instead — Up/Down scroll
    // any pager (less/man/git log) line-by-line (in an editor they move the cursor, the accepted trade-off).
    // After each send we poke the poll loop so the scrolled frame repaints at once (poll-and-repaint would
    // otherwise lag the jump up to a tick).
    const WHEEL_PX = 22;   // finger travel per notch — ~one text row, tuned for a natural drag feel
    let wheelAccum = 0;    // unsent finger travel, px (+ = finger moved down the screen)
    let wheelPrevY = 0;    // last sampled clientY, for the incremental delta
    let wheelPending = 0;  // notches queued while a request is in flight (+ = toward earlier content)
    let wheelBusy = false;
    const flushWheel = async () => {
      if (wheelBusy || wheelPending === 0) return;
      wheelBusy = true;
      const dir = notchDir(wheelPending);
      const n = Math.min(Math.abs(wheelPending), 40);
      wheelPending = 0;
      try {
        if (mouseAwareRef.current) await scrollPane(pane, dir, n);
        else await sendKeys(pane, Array(n).fill(dir === 'up' ? 'Up' : 'Down'));
        wakeRef.current?.(); // repaint immediately so the jump shows
      } catch { /* transient (offline/timeout) — the next drag retries; nothing to undo */ }
      finally { wheelBusy = false; if (wheelPending !== 0) flushWheel(); }
    };

    const onTouchStart = (e) => {
      idleSince = Date.now(); // touching the pane is activity → keep the cadence live
      cancelLongPress();
      stopFling(); // any new touch interrupts an in-flight coast (tap-to-stop)
      // A tap anywhere dismisses a showing selection before doing anything else.
      clearedOnDown = selActiveRef.current;
      if (selActiveRef.current) clearSelection();
      selecting = false;
      if (e.touches.length === 2) {
        pinching = true;
        axis = -1;
        pinchDist0 = dist(e.touches);
        pinchFont0 = term.options.fontSize || 14;
        return;
      }
      pinching = false;
      if (e.touches.length !== 1) { axis = -1; return; }
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      sLeft = host.scrollLeft;
      axis = 0;
      lastMoveX = sx; // seed the velocity sampler for a possible fling (either axis)
      lastMoveY = sy;
      lastMoveT = e.timeStamp;
      scrollVelX = 0;
      scrollVelY = 0;
      wheelPrevY = sy; // seed the alt-screen wheel sampler; accum carries no travel across a fresh touch
      wheelAccum = 0;
      lpTimer = setTimeout(() => {
        lpTimer = null;
        selecting = true;
        axis = -1; // take this gesture away from pan/scroll
        startSelection(sx, sy);
      }, 500);
    };
    const onTouchMove = (e) => {
      if (pinching && e.touches.length === 2) {
        if (pinchDist0 > 0) {
          const f = Math.max(8, Math.min(40, Math.round(pinchFont0 * (dist(e.touches) / pinchDist0))));
          if (f !== (term.options.fontSize || 14)) {
            term.options.fontSize = f;
            fontRef.current = f; // mark manual so auto-fit won't fight the pinch
          }
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (selecting && e.touches.length === 1) {
        extendSelection(e.touches[0].clientX, e.touches[0].clientY);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // One finger dragging: surface the live position even when the buffer can't scroll (the
      // readout staying pinned at "行 N/N" is the tell that there's nothing more to load). Also the
      // dependable place to trigger a deeper pull — onScroll can miss the very top on mobile.
      if (e.touches.length === 1) { showScrollPos(); maybePullMore(); }
      if (e.touches.length !== 1) return; // multi-finger: pinch handled above, otherwise ignore
      const dx = e.touches[0].clientX - sx;
      const dy = e.touches[0].clientY - sy;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) cancelLongPress(); // moved → it's a scroll, not a hold
      if (axis === 0) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        axis = Math.abs(dx) > Math.abs(dy) ? 1 : -1;
      }
      if (axis === 1) {
        host.scrollLeft = sLeft - dx;
        const cx = e.touches[0].clientX; // sample velocity so touchend can coast it (mirrors vertical)
        const ddt = e.timeStamp - lastMoveT;
        if (ddt > 0) scrollVelX = (lastMoveX - cx) / ddt; // finger left (cx↓) → scroll right (+)
        lastMoveX = cx;
        lastMoveT = e.timeStamp;
        e.preventDefault();
        e.stopPropagation();
      } else { // axis === -1 vertical
        if (altScreenRef.current) {
          // Alt-screen (full-screen app): no scrollback to move, and letting the drag fall through only
          // scrolls the browser page (chrome peeks in on old iOS). Always swallow it, and forward the drag
          // as scroll input (wheel events or arrow keys — flushWheel picks by mouse mode). The travel→notch
          // conversion + finger-direction mapping lives in drainWheel.
          e.preventDefault();
          e.stopPropagation();
          const cy = e.touches[0].clientY;
          const { notches, rem } = drainWheel(wheelAccum + (cy - wheelPrevY), WHEEL_PX);
          wheelAccum = rem;
          wheelPrevY = cy;
          if (notches) { wheelPending += notches; flushWheel(); }
          return;
        }
        // Normal screen: let xterm own the 1:1 drag (don't preventDefault/stopPropagation — cutting xterm
        // off with no native scroller to take over is what killed scrolling entirely). Just sample the
        // velocity here so touchend can coast it onward.
        const cy = e.touches[0].clientY;
        const ddt = e.timeStamp - lastMoveT;
        if (ddt > 0) scrollVelY = (lastMoveY - cy) / ddt; // finger up (cy↓) → scroll down (+)
        lastMoveY = cy;
        lastMoveT = e.timeStamp;
      }
    };
    const onTouchEnd = (e) => {
      cancelLongPress();
      if (selecting && e.touches.length === 0) {
        selecting = false;
        clearTimeout(selHintTimerRef.current);
        selHintTimerRef.current = setTimeout(() => setSelHint(false), 3500);
        const text = term.getSelection();
        if (text && text.trim()) refreshSelUI();  // persist handles + callout
        else clearSelection();
        return;
      }
      if (pinching && e.touches.length < 2) {
        pinching = false;
        setFont(term.options.fontSize || 14); // persist the pinched size across panes
        scheduleFit(); // re-fit the row count to the new font so the grid still fills the height
        return;
      }
      // A pan just ended — if it left the finger on a flick, coast that axis onward.
      if (e.touches.length === 0 && shouldFling(axis === 1 ? scrollVelX : scrollVelY, e.timeStamp - lastMoveT)) {
        if (axis === 1) startFling(host, 'scrollLeft', scrollVelX);
        else if (axis === -1) startFling(host.querySelector('.xterm-viewport'), 'scrollTop', scrollVelY);
      }
      // A clean single tap on the terminal DISMISSES the keyboard — the iOS-native "tap outside the field to
      // put the keyboard away" habit. A SWIPE never does (a pan sets axis, a long-press sets selecting, so a
      // scroll reads through with the keyboard up); onKeepKbdDown pins focus through the gesture so only this
      // explicit tap blurs. Call SYNCHRONOUSLY — this touchend is the user gesture iOS wants. clearedOnDown
      // skips the tap that merely dismissed a live selection (its job was the dismiss, not the keyboard).
      if (e.touches.length === 0 && !selecting && !pinching && axis === 0 && !clearedOnDown) {
        onTapRef.current?.();
      }
    };
    // Desktop mouse wheel has no equivalent of the touch handler's smart scroll — wire the SAME two
    // behaviours here (the touch path branches on altScreenRef the same way, see onTouchMove).
    //  • Alt-screen: forward the wheel to the app as notches (it owns the scrollback), and swallow the
    //    event so xterm doesn't scroll its stale main-screen buffer underneath — the exact "scrolling up
    //    shows history that isn't this full-screen app's" bug. Sign: wheel DOWN (deltaY>0) reveals LATER
    //    content, which drainWheel expects as NEGATIVE finger travel, so feed it -deltaY.
    //  • Normal screen: let xterm own the native scroll, but ALSO trigger the deeper-history pull
    //    directly — onScroll alone can miss the very top after a reseed (its native scrollbar doesn't
    //    resync), which is what left desktop stuck at the first loaded chunk. onTouchMove does this
    //    same redundant call on every move; the wheel had no such safety net.
    const onWheel = (e) => {
      if (!e.deltaY) return;
      if (altScreenRef.current) {
        e.preventDefault();
        e.stopPropagation();
        const px = e.deltaMode === 1 ? e.deltaY * WHEEL_PX          // lines → px (Firefox)
                 : e.deltaMode === 2 ? e.deltaY * term.rows * WHEEL_PX // pages → px
                 : e.deltaY;                                        // already px
        const { notches, rem } = drainWheel(wheelAccum - px, WHEEL_PX);
        wheelAccum = rem;
        if (notches) { wheelPending += notches; flushWheel(); }
        return;
      }
      showScrollPos();
      maybePullMore();
    };
    // Keep the on-screen keyboard up when a touch lands on the terminal. By default the browser blurs the
    // focused command capture / composer the moment you touch a non-input element, collapsing the keyboard —
    // so scrolling the output would dismiss it (the very thing good terminals avoid). If a real handmux field
    // holds focus, preventDefault the pointerdown to keep it (the same keepFocus trick the dock buttons use):
    // onClick/taps and the custom touch gestures still fire, the keyboard just no longer drops on every touch.
    // Only pins a genuine input — never xterm's own hidden helper textarea.
    const onKeepKbdDown = (e) => { if (shouldKeepKeyboard(document.activeElement) && e.cancelable) e.preventDefault(); };
    host.addEventListener('pointerdown', onKeepKbdDown, { capture: true });
    host.addEventListener('wheel', onWheel, { capture: true, passive: false });
    host.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    host.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    host.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });

    // Handle drag: pointer events on .terminal-wrap (handles are siblings of .terminal, so they don't
    // go through host's capture listeners). Event delegation via closest('.sel-handle').
    const wrap = elRef.current.parentElement;
    let dragEnd = null; // 'start' | 'end' — which handle is being dragged
    let autoScrollRAF = null;
    let lastHandlePt = null;
    // autoDir is hoisted so the rAF tick always reads the CURRENT edge direction, not the one
    // captured when the loop started. Without this, dragging from the bottom edge to the top
    // kept scrolling downward (the tick captured dir=1 from the start branch and couldn't update).
    let autoDir = 0;
    const onHandleDown = (ev) => {
      const h = ev.target.closest?.('.sel-handle');
      if (!h) return;
      dragEnd = h.dataset.end;
      ev.preventDefault();
      ev.stopPropagation();
      wrap.setPointerCapture?.(ev.pointerId);
    };
    const onHandleMove = (ev) => {
      if (!dragEnd) return;
      const pos = term.getSelectionPosition();
      if (!pos) return;
      // Anchor = the OTHER end; drag = the finger.
      const anchorCell = dragEnd === 'start' ? { col: pos.end.x, row: pos.end.y }
                                             : { col: pos.start.x, row: pos.start.y };
      selAnchor = anchorCell;
      extendSelection(ev.clientX, ev.clientY);
      refreshSelUI();
      // Auto-scroll when the dragged handle nears the viewport top/bottom edge, extending the selection
      // into scrollback / newer rows. rAF loop; keeps the last finger point to re-extend each frame.
      // autoDir is written every move so the single persistent tick always scrolls toward the current edge.
      const EDGE = 28;   // px band at each edge that triggers auto-scroll
      const STEP = 24;   // px scrolled per frame
      lastHandlePt = { x: ev.clientX, y: ev.clientY };
      const vpRect = vp.getBoundingClientRect();
      if (ev.clientY < vpRect.top + EDGE) autoDir = -1;
      else if (ev.clientY > vpRect.bottom - EDGE) autoDir = 1;
      else autoDir = 0;
      if (autoDir !== 0 && autoScrollRAF == null) {
        // Start one persistent tick; it reads autoDir each frame so direction changes propagate naturally.
        const tick = () => {
          if (!dragEnd || autoDir === 0) { autoScrollRAF = null; return; }
          const before = vp.scrollTop;
          vp.scrollTop = before + autoDir * STEP; // fires xterm scroll → repaint + onVpScroll
          extendSelection(lastHandlePt.x, lastHandlePt.y);
          refreshSelUI();
          if (vp.scrollTop === before) { autoScrollRAF = null; return; } // hit an edge — stop
          autoScrollRAF = requestAnimationFrame(tick);
        };
        autoScrollRAF = requestAnimationFrame(tick);
      } else if (autoDir === 0 && autoScrollRAF != null) {
        cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null;
      }
      ev.preventDefault();
    };
    const onHandleUp = (ev) => {
      if (!dragEnd) return;
      dragEnd = null;
      autoDir = 0;
      if (autoScrollRAF != null) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
      wrap.releasePointerCapture?.(ev.pointerId);
    };
    wrap.addEventListener('pointerdown', onHandleDown, { capture: true });
    wrap.addEventListener('pointermove', onHandleMove, { capture: true });
    wrap.addEventListener('pointerup', onHandleUp, { capture: true });
    wrap.addEventListener('pointercancel', onHandleUp, { capture: true });

    // Rebuild the persistent doc-path UNDERLINE after each full repaint (the visual cue; the actual
    // tap is handled by the link provider above). Underline-only (no bg) so it can't trigger the
    // scroll/BCE shading trap. Markers/decorations are disposed and recreated every repaint to match
    // the poll-and-repaint model. decoration.dispose() does NOT dispose its marker in @xterm/xterm
    // 5.5, so we track and dispose both each refresh (markers near baseY aren't trimmed, so they'd
    // otherwise accumulate over a long session).
    const refreshDocDecorations = (t) => {
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

    const repaint = async (lines, keepPosition) => {
      if (busy || disposed) return;
      busy = true;
      const anchorFromBottom = keepPosition ? buf().length - buf().viewportY : 0;
      try {
        const hist = await getHistory(pane, lines, lastHash);
        if (disposed) return;
        setConn(nextConnection(connState, 'ok')); // a successful poll → connected (clears the banner)
        // 204: server says the screen is identical to lastHash — keep what's drawn, transmit nothing.
        if (hist.unchanged) { setPaused(keepPosition); return; }
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
          return;
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
        seedRows = seed ? seed.split('\n').length : 0; // content height — placeCursor counts cur.row up from it
        await new Promise((res) => term.write('\x1b[?25l\x1b[0m\x1b[2J\x1b[3J\x1b[H' + seed, res));
        if (disposed) return;
        lastAnsi = hist.ansi;
        lastCur = curKey;
        curInfo = hist.cur; // placed by placeCursor() below (and again by fit, after any resize)
        if (keepPosition) term.scrollToLine(Math.max(0, buf().length - anchorFromBottom));
        else term.scrollToBottom();
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
      } catch (e) {
        if (e instanceof UnauthorizedError) onAuthFail?.();
        else if (!disposed) setConn(nextConnection(connState, 'fail')); // network/500/timeout → maybe disconnect
      } finally {
        busy = false;
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
      if (seeded && !nearBottom()) { setPaused(true); return; } // browsing history (past the live zone) — hold still
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
    async function tick(myEpoch) {
      if (!disposed && myEpoch === epoch) await pollOnce();
      if (disposed || document.hidden || myEpoch !== epoch) return;
      const delay = connState.failCount > 0
        ? backoffDelay(connState.failCount)
        : idleDelay(Date.now() - idleSince); // healthy: slow down while idle, fast while active
      timer = setTimeout(() => tick(myEpoch), delay);
    }
    const startLoop = () => {
      epoch += 1;
      if (timer) { clearTimeout(timer); timer = null; }
      tick(epoch);
    };
    startLoop();
    // Outside input (a send/keypress from App) calls this: reset the idle clock and poll NOW — the
    // keystroke's echo should be visible immediately, not at the next tick (up to 1s away even on
    // the fast cadence). If a poll is already in flight its frame predates the keystroke, so flag
    // wakeAgain and repaint() re-polls the moment it finishes — rapid keys coalesce into
    // back-to-back polls instead of stacking timer chains.
    const wake = () => {
      idleSince = Date.now();
      if (busy) { wakeAgain = true; return; }
      startLoop();
    };
    wakeRef.current = wake;

    // Pause polling in the background (saves battery + server-side tmux spawns); on return, reset
    // health, repaint immediately (instant refresh), and resume the loop.
    const onVisibility = () => {
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
    document.addEventListener('visibilitychange', onVisibility);

    const sub = term.onScroll(() => {
      if (disposed) return;
      if (atBottom()) { setPaused(false); setScrollInfo(''); return; }
      setPaused(true);
      showScrollPos();
      maybePullMore();
    });

    // When the user scrolls the xterm viewport (e.g. during an active selection), the handle and
    // callout positions need to be recomputed — their y offsets are viewport-relative.
    const vp = elRef.current.querySelector('.xterm-viewport');
    const onVpScroll = () => { if (selActiveRef.current) refreshSelUI(); };
    vp?.addEventListener('scroll', onVpScroll, { passive: true });

    return () => {
      disposed = true;
      if (autoScrollRAF != null) cancelAnimationFrame(autoScrollRAF);
      fitRef.current = null;
      wakeRef.current = null;
      stopFlingRef.current = null;
      refreshDecosRef.current = null;
      selActionsRef.current = null;
      cancelLongPress();
      stopFling();
      if (timer) clearTimeout(timer);
      clearTimeout(selHintTimerRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      ro?.disconnect();
      host.removeEventListener('pointerdown', onKeepKbdDown, { capture: true });
      host.removeEventListener('wheel', onWheel, { capture: true });
      host.removeEventListener('touchstart', onTouchStart, { capture: true });
      host.removeEventListener('touchmove', onTouchMove, { capture: true });
      host.removeEventListener('touchend', onTouchEnd, { capture: true });
      wrap.removeEventListener('pointerdown', onHandleDown, { capture: true });
      wrap.removeEventListener('pointermove', onHandleMove, { capture: true });
      wrap.removeEventListener('pointerup', onHandleUp, { capture: true });
      wrap.removeEventListener('pointercancel', onHandleUp, { capture: true });
      vp?.removeEventListener('scroll', onVpScroll);
      sub.dispose();
      linkProvider.dispose();
      for (const { deco, marker } of decosRef.current) { deco.dispose(); marker.dispose(); }
      decosRef.current = [];
      term.dispose();
      termRef.current = null;
    };
  }, [pane]);

  const resume = () => {
    stopFlingRef.current?.();
    // Force the xterm-viewport scrollTop to its maximum directly — the fling operates on this
    // element too, and xterm's scrollToBottom() may lag one frame if ydisp is still mid-fling.
    const vp = elRef.current?.querySelector('.xterm-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
    termRef.current?.scrollToBottom();
    setPaused(false);
    setScrollInfo(''); // clear the history-mode banner immediately
    wakeRef.current?.(); // re-poll right away so the live screen is confirmed at the bottom
  };

  // Page a full-screen (alt-screen) pane up/down. PageUp/PageDown is the one manual scroll that works in
  // any pager/editor regardless of mouse mode (arrows would move the cursor instead) — so it covers the
  // apps the wheel gesture can't (no mouse reporting) and gives precise paging in the ones it can.
  const pageScroll = async (dir) => {
    try { await sendKeys(pane, [dir === 'up' ? 'PageUp' : 'PageDown']); wakeRef.current?.(); }
    catch { /* transient (offline/timeout) — the button can just be tapped again */ }
  };

  // Copy the live selection, then drop the highlight + bubble. navigator.clipboard only exists in
  // a secure context (https/localhost); over plain http we fall back to a throwaway textarea +
  // execCommand so copy still works on the LAN.
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
    term?.clearSelection();
    selActiveRef.current = false;
    setSelUI(null);
    clearTimeout(selHintTimerRef.current);
    setSelHint(false);
  };

  return (
    <div className="terminal-wrap">
      <div ref={elRef} className={ready ? 'terminal' : 'terminal terminal--loading'} />
      {!connected && <div className="term-banner term-banner--err">⚠ 连接断开,重连中…</div>}
      {dbgVisible && <div className="dbg">{dbg}</div>}
      {connected && scrollInfo && <div className="term-banner term-banner--hist">{scrollInfo}</div>}
      {scrollInfo && <button className="new-output" onClick={resume}>↓ 回到底部</button>}
      {selHint && <div className="sel-hint">拖动两端手柄调整选区，点「拷贝」复制</div>}
      {altScreen && (
        <div className="term-pager" role="group" aria-label="翻页">
          <button type="button" className="term-pager-btn" aria-label="上翻页" onClick={() => pageScroll('up')}>
            <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
              <path d="M6 14.5l6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <span className="term-pager-div" aria-hidden="true" />
          <button type="button" className="term-pager-btn" aria-label="下翻页" onClick={() => pageScroll('down')}>
            <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
              <path d="M6 9.5l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}
      {selUI && (() => {
        const minX = Math.min(selUI.start.x, selUI.end.x);
        const minY = Math.min(selUI.start.y, selUI.end.y);
        const maxY = Math.max(selUI.start.y, selUI.end.y);
        // Clamp left within wrap bounds, also guard right edge (CALLOUT_W is an estimate for clamping).
        const calloutLeft = Math.max(8, Math.min(minX, (selUI.wrapW ?? 0) - CALLOUT_W - 8));
        // Flip below the selection when the above-position would clip the top of the wrap.
        const aboveY = minY - 44;
        const belowY = maxY + (selUI.start.ch || 0) + 8;
        const calloutTop = aboveY < 4 ? belowY : aboveY;
        return (
        <>
          <div className="sel-handle sel-handle--start"
               style={{ left: selUI.start.x, top: selUI.start.y, '--h': `${selUI.start.ch}px` }}
               data-end="start" />
          <div className="sel-handle sel-handle--end"
               style={{ left: selUI.end.x, top: selUI.end.y, '--h': `${selUI.end.ch}px` }}
               data-end="end" />
          <div className="sel-callout"
               style={{ left: calloutLeft, top: calloutTop }}>
            <button type="button" onClick={doCopy}>拷贝</button>
            <button type="button" onClick={() => {
              const a = selActionsRef.current;
              if (a) a.selectRange(expandToLines(a.currentRange(), termRef.current.cols));
            }}>整行</button>
            <button type="button" onClick={() => {
              const a = selActionsRef.current;
              if (!a) return;
              const b = termRef.current.buffer.active;
              a.selectRange(expandToParagraph(a.currentRange(), termRef.current.cols, a.paraLineText, 0, b.length - 1));
            }}>整段</button>
          </div>
        </>
        );
      })()}
    </div>
  );
});

export default Terminal;
