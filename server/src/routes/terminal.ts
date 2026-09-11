// Terminal pane I/O routes: read the screen (/history), type text/keys, resize/reflow, and forward
// wheel scroll to full-screen apps. This is the hot path the phone polls. Mounted under /api.
import express from 'express';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { isPaneId, isWindowId } from '../tmux/commands.js';
import { capTrailingBlankRows } from '../trimCapture.js';
import { isAllowedKey } from '../keyNames.js';
import { restoreCaptureBackgrounds } from '../captureBackground.js';
import { serializePaneInput } from '../paneInput.js';
import type { NextFunction, Request, Response, Router } from 'express';

type CommandsModule = typeof import('../tmux/commands.js');
type TerminalCommands = Pick<CommandsModule,
  | 'paneInfo' | 'capturePane' | 'exitCopyModeIfActive' | 'sendText' | 'sendEnter'
  | 'sendHexInput' | 'getWindowLayout' | 'applyWindowLayout' | 'restoreWindowSize'
  | 'resizePane' | 'resizeWindow' | 'sendKey' | 'sendWheel'
> & { capturePaneRow?: CommandsModule['capturePaneRow'] };
interface TerminalRouteOptions { commands: TerminalCommands }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const requestBody = (req: Request): Record<string, unknown> => isRecord(req.body) ? req.body : {};

export { isAllowedKey } from '../keyNames.js';

// Keys the mobile keyboard may send via /keys. A controlled vocabulary of named tmux keys, PLUS
// live-modifier combinations (Ctrl/Alt + a single letter or digit) so the keyboard's Ctrl modifier
// can compose any readline/tmux binding (C-r, C-w, C-a, the tmux prefix, …) without enumerating each
// one here. tmux send-keys key names are themselves a closed set, so this stays a strict allowlist
// (never a passthrough): a key either names an approved token or matches the modifier shape, or it's
// rejected. The old fixed C-c/C-d/C-z/C-l/C-r/C-o/C-e all still match `C-[a-z0-9]`.
// Keep a short fallback gap for applications that do not negotiate bracketed paste. Supporting TUIs get
// an explicit paste boundary from commands.sendText; the delay is no longer the correctness mechanism.
const RAW_INPUT_MAX_BYTES = 16 * 1024;
const SUBMIT_GAP_MS = 120;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const validHexInput = (hex: unknown): hex is string => typeof hex === 'string'
  && hex.length >= 2
  && hex.length <= RAW_INPUT_MAX_BYTES * 2
  && hex.length % 2 === 0
  && /^[0-9a-f]+$/i.test(hex);
const isMissingPane = (error: unknown): boolean =>
  /(?:can't find|cannot find|no such|unknown|not found).*\bpane\b|\bpane\b.*(?:can't find|cannot find|no such|unknown|not found)/i
    .test(error instanceof Error ? error.message : String(error));

export function terminalRoutes({ commands }: TerminalRouteOptions): Router {
  const r = express.Router();

  r.get('/history', async (req: Request, res: Response, next: NextFunction) => {
    const paneId = req.query.pane;
    if (!isPaneId(paneId)) return res.status(400).json({ error: 'bad pane id' });
    const lines = Math.min(Math.max(Number(req.query.lines) || 1000, 1), 5000);
    try {
      // Read the pane's state FIRST — whether it's on the alternate screen decides how we capture it.
      const { width, height, cursorX, cursorY, cursorVisible, altScreen, mouseAware } = await commands.paneInfo(paneId);
      // An ALT-screen pane (a full-screen app: vim/less/htop) is a fixed height×width screen with NO
      // scrollback. Asking tmux for history (-S -lines) there bleeds the MAIN screen's scrollback in
      // ABOVE the app — you'd scroll up into terminal history that isn't the app's — and capping its
      // trailing blank rows mangles the fixed screen (those blanks are real cells). So capture an alt
      // pane as exactly its visible screen (lines=0) and skip the blank-trim. A normal pane still pulls
      // `lines` of scrollback and caps the empty grid below the cursor (fresh shell = "prompt + a wall of
      // blank rows") so the phone's bottom-anchored render shows content, not blank. See trimCapture.js.
      const captured = await commands.capturePane(paneId, altScreen ? 0 : lines);
      const capturePaneRow = commands.capturePaneRow;
      const restored = typeof capturePaneRow === 'function'
        ? await restoreCaptureBackgrounds(
          captured,
          height,
          (row) => capturePaneRow(paneId, row),
        )
        : {
          ansi: captured,
          historyLines: Math.max(
            0,
            (captured.endsWith('\n') ? captured.slice(0, -1) : captured).split('\n').length - height,
          ),
        };
      const raw = restored.ansi;
      const ansi = altScreen ? raw : capTrailingBlankRows(raw);
      // The cursor's row counted from the BOTTOM of the (trimmed) capture. The live screen is the
      // capture's last `height` rows, so the cursor sits `height-1-cursorY` rows above the bottom —
      // less however many trailing blank rows capTrailingBlankRows dropped (all of them below the
      // cursor). The client re-places xterm's cursor this many rows up from the seed's last row.
      const rowsOf = (value: string): number => (value.endsWith('\n') ? value.slice(0, -1) : value).split('\n').length;
      const historyLines = altScreen ? 0 : restored.historyLines;
      const cur = {
        row: Math.max(0, (height - 1 - cursorY) - (rowsOf(raw) - rowsOf(ansi))),
        col: cursorX, vis: cursorVisible,
      };
      // Short content hash over size + cursor + ansi. The client echoes its last hash as ?since=… ;
      // an unchanged screen returns 204 (empty) so an idle pane stops re-sending the whole capture.
      // The cursor is folded in so a bare left/right (which moves the cursor but not the text) still
      // yields a fresh frame — otherwise the move would 204 and the cursor would never visibly track.
      // mouseAware is folded in too: toggling an app's mouse mode (e.g. `:set mouse=a` in vim) changes
      // whether a swipe should wheel-scroll or just hint, and the client only re-reads it on a fresh frame.
      const hash = createHash('sha1')
        .update(`${width}x${height}\n${cur.col},${cursorY},${cur.vis ? 1 : 0}\n${altScreen ? 1 : 0}${mouseAware ? 'm' : ''}\n${ansi}`)
        .digest('hex').slice(0, 16);
      if (req.query.since === hash) return res.status(204).end();
      const json = JSON.stringify({
        ansi, width, height, historyLines, hash, cur, alt: altScreen, mouseAware,
      });
      res.set('Content-Type', 'application/json');
      res.set('Vary', 'Accept-Encoding'); // both 200 branches vary on encoding (correct for any caching proxy)
      // Capture text is mostly SGR codes + spaces — gzip crushes it ~10x. (204s are empty, never gzipped.)
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        res.set('Content-Encoding', 'gzip');
        // gzipSync is fine here — captures are KBs; the event-loop stall is sub-ms.
        return res.end(gzipSync(json));
      } else {
        return res.end(json);
      }
    } catch (e) { return next(e); }
  });

  r.post('/send', async (req: Request, res: Response, next: NextFunction) => {
    const { pane, text, enter } = requestBody(req);
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    const body = typeof text === 'string' ? text : '';
    try {
      await serializePaneInput(pane, async () => {
        await commands.exitCopyModeIfActive(pane);
        await commands.sendText(pane, body);
        if (enter) {
          if (body) await delay(SUBMIT_GAP_MS); // a bare Enter has nothing to settle — send at once
          await commands.sendEnter(pane);
        }
      });
      return res.json({ ok: true });
    } catch (e) { return next(e); }
  });

  r.post('/input', async (req: Request, res: Response, next: NextFunction) => {
    const { pane, hex } = requestBody(req);
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    if (!validHexInput(hex)) return res.status(400).json({ error: 'bad input bytes' });
    try {
      await serializePaneInput(pane, async () => {
        await commands.exitCopyModeIfActive(pane);
        await commands.sendHexInput(pane, hex);
      });
      return res.json({ ok: true });
    } catch (error) {
      if (isMissingPane(error)) return res.status(404).json({ error: 'pane not found' });
      return next(error);
    }
  });

  // Resize the tmux window so it reflows to the phone (auto:false), or hand sizing back to
  // attached clients (auto:true). NOTE: this mutates the shared window — the PC's view of it
  // changes too.
  r.get('/layout', async (req: Request, res: Response, next: NextFunction) => {
    if (!isWindowId(req.query.window)) return res.status(400).json({ error: 'bad window id' });
    try { return res.json({ layout: await commands.getWindowLayout(req.query.window) }); }
    catch (e) { return next(e); }
  });

  // Restore only the pane arrangement. Window sizing remains untouched; handing the whole window
  // back to an attached client is the separate `auto` resize operation below.
  r.post('/layout', async (req: Request, res: Response, next: NextFunction) => {
    const { window, layout } = requestBody(req);
    if (!isWindowId(window)) return res.status(400).json({ error: 'bad window id' });
    if (typeof layout !== 'string' || !layout) return res.status(400).json({ error: 'bad window layout' });
    try {
      await commands.applyWindowLayout(window, layout);
      return res.json({ ok: true });
    } catch (e) { return next(e); }
  });

  r.post('/resize', async (req: Request, res: Response, next: NextFunction) => {
    const { window, pane, cols, rows, auto, layout } = requestBody(req);
    const c = Math.min(Math.max(Number(cols) || 0, 20), 500);
    try {
      if (auto) {
        if (!isWindowId(window)) return res.status(400).json({ error: 'bad window id' });
        // restore the split arrangement (resizePane) then hand window sizing back (resizeWindow)
        if (typeof layout === 'string' && layout) await commands.applyWindowLayout(window, layout);
        await commands.restoreWindowSize(window);
      } else if (isPaneId(pane)) {
        await commands.resizePane(pane, c); // a pane in a split — resize only it
      } else if (isWindowId(window)) {
        const rw = rows != null ? Math.min(Math.max(Number(rows) || 0, 5), 500) : null;
        await commands.resizeWindow(window, c, rw); // a lone pane fills the window
      } else {
        return res.status(400).json({ error: 'bad resize target' });
      }
      return res.json({ ok: true });
    } catch (e) { return next(e); }
  });

  r.post('/keys', async (req: Request, res: Response, next: NextFunction) => {
    const { pane, keys } = requestBody(req);
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    if (!Array.isArray(keys) || keys.some((k) => !isAllowedKey(k))) {
      return res.status(400).json({ error: 'disallowed key' });
    }
    try {
      await serializePaneInput(pane, async () => {
        await commands.exitCopyModeIfActive(pane);
        for (const k of keys) await commands.sendKey(pane, k);
      });
      return res.json({ ok: true });
    } catch (e) { return next(e); }
  });

  // Swipe-to-scroll for full-screen (ALT-screen) apps: the client can't scroll the alt buffer itself
  // (no scrollback), so it forwards the finger travel here and we inject wheel events the app scrolls on.
  // SAFETY: we re-read the pane's mouse state at inject time and REFUSE unless it's actually reporting
  // mouse — otherwise the raw escape bytes would print into the shell as literal `<65;…M` garbage. The
  // client's cached mouseAware is only a UX hint; this check is the real guard (mouse mode can toggle
  // between the poll and the gesture). Positioned at the pane centre so a split-aware app scrolls the
  // region the finger is over; a lone full-screen app ignores the position.
  r.post('/scroll', async (req: Request, res: Response, next: NextFunction) => {
    const { pane, dir, lines } = requestBody(req);
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    if (dir !== 'up' && dir !== 'down') return res.status(400).json({ error: 'bad dir' });
    try {
      const { altScreen, mouseAware, mouseSgr, width, height } = await commands.paneInfo(pane);
      if (!altScreen || !mouseAware) return res.json({ ok: false, reason: 'no-mouse' });
      await commands.sendWheel(pane, dir, Number(lines), {
        sgr: mouseSgr,
        col: Math.max(1, Math.floor((width || 2) / 2)),
        row: Math.max(1, Math.floor((height || 2) / 2)),
      });
      return res.json({ ok: true });
    } catch (e) { return next(e); }
  });

  return r;
}
