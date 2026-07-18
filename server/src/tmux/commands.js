import { execFile } from 'node:child_process';
import os from 'node:os';

export const isPaneId = (s) => typeof s === 'string' && /^%\d+$/.test(s);
export const isWindowId = (s) => typeof s === 'string' && /^@\d+$/.test(s);
export const isSessionId = (s) => typeof s === 'string' && /^\$\d+$/.test(s);

// Letters, digits and hyphens only (1-16 chars). A positive allowlist sidesteps tmux's target
// syntax entirely (no '.'/':' separators, no whitespace, no control chars) and is trivial to
// mirror on the client. Only NEW session names are validated — binding an existing PC-made name
// (which may contain spaces) checks existence first and never calls this.
export const isValidSessionName = (s) =>
  typeof s === 'string' && /^[A-Za-z0-9-]{1,16}$/.test(s);

// Optional startup command run in a freshly-created window/session (e.g. "claude"). It's typed via
// send-keys + Enter, so it must be a single line: reject control chars (newline/CR/tab included) and
// cap the length. No shell-arg restriction — it runs in the new shell exactly as if typed, same trust
// model as the existing sendText. Empty means "no command" and is handled by the caller, not here.
export const isValidStartupCmd = (s) =>
  typeof s === 'string' && s.length > 0 && s.length <= 200 && [...s].every((c) => { const n = c.charCodeAt(0); return n >= 0x20 && n !== 0x7f; });

export function runTmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString() || err.message));
      else resolve(stdout.toString());
    });
  });
}

const lines = (out) => out.split('\n').filter((l) => l.length > 0);

export async function listSessions() {
  try {
    const out = await runTmux(['list-sessions', '-F', '#{session_id}\t#{session_name}']);
    return lines(out).map((l) => { const [id, name] = l.split('\t'); return { id, name }; });
  } catch (e) {
    // tmux exits non-zero with "no server running" or "no sessions" when nothing is up yet.
    const msg = e.message || '';
    if (msg.includes('no server') || msg.includes('no sessions') || msg.includes('error connecting')) return [];
    throw e;
  }
}

export async function listWindows(sessionId) {
  const out = await runTmux(['list-windows', '-t', sessionId, '-F', '#{window_id}\t#{window_name}\t#{window_active}\t#{window_panes}']);
  return lines(out).map((l) => {
    const [id, name, active, panes] = l.split('\t');
    return { id, name, active: active === '1', panes: Number(panes) };
  });
}

export async function listPanes(windowId) {
  const out = await runTmux(['list-panes', '-t', windowId, '-F', '#{pane_id}\t#{pane_active}\t#{pane_width}\t#{pane_height}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_left}\t#{pane_top}']);
  return lines(out).map((l) => {
    const [id, active, width, height, command, cwd, left, top] = l.split('\t');
    return { id, active: active === '1', width: Number(width), height: Number(height), command, cwd, left: Number(left), top: Number(top) };
  });
}

// All live pane ids across every session — used to reconcile the in-memory Claude paneState against
// reality. A hard-killed pane fires no hook, so its last state would otherwise linger as a ghost.
// If a target is provided (window id or session id), list only panes in that target.
export async function listPaneIds(target) {
  const args = ['list-panes', '-F', '#{pane_id}'];
  if (target) {
    args.push('-t', target);
  } else {
    args.push('-a');
  }
  return lines(await runTmux(args));
}

// Every live pane across all sessions WITH its foreground command AND its tmux location, in ONE call.
// getStates uses this to (a) catch "pane alive but Claude exited" (cmd flips from 'claude' back to the
// shell — a hard kill / crash / Ctrl-C-out fires no SessionEnd yet the shell keeps the pane, so it
// still EXISTS) and (b) resolve each recorded pane to its session/window for the inbox roster without a
// per-pane display-message. The hook only records the pane id; location comes from here, always fresh.
export async function listLivePanes() {
  return lines(await runTmux(['list-panes', '-a', '-F',
    '#{pane_id}\t#{pane_current_command}\t#{pane_tty}\t#{session_name}\t#{window_id}\t#{window_name}']))
    .map((l) => {
      const [id, cmd, tty, session, window, windowName] = l.split('\t');
      return { id, cmd, tty, session, window, windowName };
    });
}

// -N preserves trailing whitespace. Without it, capture-pane trims trailing cells at each line
// end — including background-colored padding — which both drops the right-hand part of a
// full-width highlight (Claude Code's sent-message bar) AND loses the SGR reset that closes the
// background, so the highlight bleeds onto the rows below when re-rendered. With -N the capture
// faithfully reproduces the pane, so the client can write it verbatim (see prepareSeed).
export async function capturePane(paneId, linesBack) {
  return runTmux(['capture-pane', '-p', '-e', '-N', '-S', String(-Math.abs(linesBack)), '-t', paneId]);
}

// Plain visible-screen capture — NO SGR escapes (unlike capturePane's `-e`), so the text parses cleanly.
// Used to scrape a pending prompt/menu off the screen (see pendingPrompt.js).
export async function capturePlain(paneId) {
  return runTmux(['capture-pane', '-p', '-t', paneId]);
}

// Size AND cursor in one display-message (capture-pane carries neither the cursor position nor its
// visibility — it snapshots cells only — so we read them here for the client to re-place xterm's own
// cursor onto Claude's input cell). cursor_x/cursor_y are 0-based, relative to the visible screen;
// cursor_flag is DECTCEM visibility (1 while Claude accepts input, 0 while it's working / in a dialog).
// alternate_on = the pane is on the ALT screen (a full-screen app: vim/htop/less/a mouse-mode TUI). The
// alt buffer has no scrollback, so the phone can't swipe-scroll it. mouse_any_flag = the app has requested
// mouse reporting (any mode); mouse_sgr_flag = it negotiated the SGR (1006) encoding. Together they let the
// client translate a swipe into wheel events the app scrolls on (sendWheel) instead of a dead swipe.
export async function paneInfo(paneId) {
  const out = await runTmux(['display-message', '-p', '-t', paneId,
    '#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}\t#{alternate_on}\t#{mouse_any_flag}\t#{mouse_sgr_flag}']);
  const [width, height, cx, cy, cflag, alt, mAny, mSgr] = out.trim().split('\t');
  return {
    width: Number(width), height: Number(height),
    cursorX: Number(cx), cursorY: Number(cy), cursorVisible: cflag === '1',
    altScreen: alt === '1', mouseAware: mAny === '1', mouseSgr: mSgr === '1',
  };
}

// Inject mouse-wheel scroll events so a full-screen app on the ALT screen scrolls itself — exactly what a
// desktop wheel does. dir 'up' scrolls toward earlier content (SGR button 64), 'down' toward later (65);
// `count` notches go out in ONE send-keys as a repeated escape run. Only meaningful when the app requested
// mouse reporting — the CALLER MUST verify paneInfo().mouseAware first, or these escape bytes land in the
// shell as literal text. `sgr` picks the 1006 encoding the app negotiated (else the legacy X10 form);
// `col`/`row` are the 1-based pointer position the event reports at (the pane centre — irrelevant to a lone
// full-screen app, but lets a split-aware app scroll the region under the finger).
export async function sendWheel(paneId, dir, count, opts = {}) {
  await runTmux(['send-keys', '-t', paneId, '-l', '--', wheelSeq(dir, count, opts)]);
}

// Pure: build the terminal byte run for `count` wheel notches (kept separate so the encoding is unit-
// tested without spawning tmux). `count` is clamped to 1..60 (one flick shouldn't inject hundreds).
export function wheelSeq(dir, count, { sgr = true, col = 1, row = 1 } = {}) {
  const n = Math.min(Math.max(Math.trunc(Number(count)) || 1, 1), 60);
  const btn = dir === 'up' ? 64 : 65;
  const c = Math.max(1, Math.trunc(col) || 1);
  const r = Math.max(1, Math.trunc(row) || 1);
  const unit = sgr
    ? `\x1b[<${btn};${c};${r}M`
    // legacy X10: ESC [ M  <btn+32> <col+32> <row+32>, each coordinate byte capped at 223.
    : `\x1b[M${String.fromCharCode(btn + 32, Math.min(c, 223) + 32, Math.min(r, 223) + 32)}`;
  return unit.repeat(n);
}

// Resolve a pane to its tmux session name + window for routing a notification back to it. The hook
// gives us only $TMUX_PANE; this turns "%263" into the session/window the phone navigates by.
export async function paneLocation(paneId) {
  const out = await runTmux(['display-message', '-p', '-t', paneId,
    '#{session_name}\t#{window_id}\t#{window_name}']);
  const [session, windowId, windowName] = out.trim().split('\t');
  return { session, window: windowId, windowName };
}

// Exit tmux copy/scroll mode if the pane is currently in it. Called before any user input so
// text and keys reach the shell instead of being swallowed by tmux's mode key-bindings.
export async function exitCopyModeIfActive(paneId) {
  const out = await runTmux(['display-message', '-p', '-t', paneId, '#{pane_in_mode}']);
  if (out.trim() === '1') await runTmux(['send-keys', '-t', paneId, 'Escape']);
}

export async function sendText(paneId, text) {
  await runTmux(['send-keys', '-t', paneId, '-l', '--', text]);
}

export async function sendEnter(paneId) {
  await runTmux(['send-keys', '-t', paneId, 'Enter']);
}

export async function sendKey(paneId, key) {
  await runTmux(['send-keys', '-t', paneId, key]);
}

// Force the window to an explicit width (and optionally height) so tmux reflows to it. This
// sets the window-size option to `manual`, so it sticks (and applies to every client on this
// window — including the PC) until restoreWindowSize is called. Pass rows = null to change
// only the column count and leave the height untouched.
export async function resizeWindow(windowId, cols, rows) {
  const args = ['resize-window', '-t', windowId, '-x', String(cols)];
  if (rows != null) args.push('-y', String(rows));
  await runTmux(args);
}

// Hand sizing back to the attached clients (tmux default), so the PC's terminal dictates
// the window size again instead of the phone-sized grid left by resizeWindow.
export async function restoreWindowSize(windowId) {
  await runTmux(['set-window-option', '-t', windowId, 'window-size', 'latest']);
}

// Resize just one pane's width inside its window (siblings absorb the difference; the window
// total is unchanged). Use this for a pane in a split — resizing the whole window would
// shrink every pane. A lone pane can't be resized this way (it fills the window).
export async function resizePane(paneId, cols) {
  await runTmux(['resize-pane', '-t', paneId, '-x', String(cols)]);
}

// The window's exact pane arrangement, captured so "restore" can put a split back the way it
// was after resizePane changed the ratio. resizePane doesn't touch window size, so window-size
// latest alone can't undo it — select-layout with this string does.
export async function getWindowLayout(windowId) {
  const out = await runTmux(['display-message', '-p', '-t', windowId, '#{window_layout}']);
  return out.trim();
}

export async function applyWindowLayout(windowId, layout) {
  await runTmux(['select-layout', '-t', windowId, layout]);
}

// -d: detached (the node server has no tty). -c cwd (defaults to $HOME): start dir for the session.
// -P -F prints the new session id so the caller can confirm/route. A duplicate name makes tmux
// error (runTmux rejects) — the route pre-checks and returns a clean 409 before reaching here.
// Self-guard the name even though the route validates first: this is an exported boundary to tmux,
// and a name with target-syntax chars ('$', ':', …) would create a hard-to-address session.
export async function newSession(name, cwd, cmd) {
  if (!isValidSessionName(name)) throw new Error(`invalid session name: ${JSON.stringify(name)}`);
  const out = await runTmux(['new-session', '-d', '-s', name, '-c', cwd || os.homedir(), '-P', '-F', '#{session_id}']);
  const id = out.trim(); // e.g. "$7"
  if (cmd) await runStartupCmd(id, cmd); // auto-run the startup command in the new session's first pane
  return id;
}

// Type a startup command into a freshly-created window/session and press Enter — same path as a user
// typing it. The target ($id / @id) resolves to the new shell's active pane. Runs inside the shell (we
// don't pass it to new-window/new-session as the pane command) so the pane survives the command exiting.
async function runStartupCmd(target, cmd) {
  await sendText(target, cmd);
  await sendEnter(target);
}

// Read a pane's working directory, so a new window can open in the dir you're working in.
export async function paneCurrentPath(paneId) {
  const out = await runTmux(['display-message', '-p', '-t', paneId, '#{pane_current_path}']);
  return out.trim();
}

// -d: don't steal the active window from the PC (the phone navigates to it itself). -c: start dir
// (omitted when cwd is falsy → tmux uses the session default). -n: window name (omitted when falsy →
// tmux auto-names after the running command). -P -F prints the new window id.
export async function newWindow(sessionId, cwd, name, cmd) {
  const args = ['new-window', '-d', '-t', sessionId, '-P', '-F', '#{window_id}'];
  if (cwd) args.push('-c', cwd); // tmux accepts -c in any position; push mirrors resizeWindow's style
  if (name) args.push('-n', name);
  const id = (await runTmux(args)).trim(); // e.g. "@32"
  if (cmd) await runStartupCmd(id, cmd); // auto-run the startup command in the new window's pane
  return id;
}

// rename-session keeps the session's $id — only the name changes. Self-guard the name (exported
// boundary to tmux; a name with target-syntax chars would create a hard-to-address session). A
// duplicate name makes tmux error (runTmux rejects); the route pre-checks and returns a clean 409.
export async function renameSession(id, name) {
  if (!isValidSessionName(name)) throw new Error(`invalid session name: ${JSON.stringify(name)}`);
  await runTmux(['rename-session', '-t', id, name]);
}

// rename-window sets the name manually (and implicitly turns off that window's automatic-rename,
// so the chosen name sticks instead of tracking the running command — the expected tmux behavior).
export async function renameWindow(id, name) {
  if (!isValidSessionName(name)) throw new Error(`invalid window name: ${JSON.stringify(name)}`);
  await runTmux(['rename-window', '-t', id, name]);
}

// The number of windows in the window's session. The delete guard refuses to kill the last one
// (killing it would take the whole session with it).
export async function sessionWindowCount(id) {
  const out = await runTmux(['display-message', '-p', '-t', id, '#{session_windows}']);
  return Number(out.trim());
}

// Split a pane into two. -d: don't move the PC's active pane (the phone navigates to the new pane
// itself, client-side). dir 'h' → left|right (`-h`), 'v' → top/bottom (`-v`). -c: the new pane's
// start dir (the target pane's cwd), omitted when falsy. -P -F prints the new pane id.
export async function splitPane(paneId, dir, cwd) {
  const flag = dir === 'v' ? '-v' : '-h';
  const args = ['split-window', '-d', flag, '-t', paneId, '-P', '-F', '#{pane_id}'];
  if (cwd) args.push('-c', cwd);
  return (await runTmux(args)).trim(); // e.g. "%91"
}

// Panes in the window that owns this pane — the kill guard refuses to kill the last one (killing it
// would take the window, and if it's the last window, the whole session).
export async function windowPaneCount(paneId) {
  const out = await runTmux(['display-message', '-p', '-t', paneId, '#{window_panes}']);
  return Number(out.trim());
}

export async function killPane(paneId) {
  await runTmux(['kill-pane', '-t', paneId]);
}

export async function killWindow(id) {
  await runTmux(['kill-window', '-t', id]);
}

// Swap two windows' positions (indices) within a session. -d keeps the active window unchanged so
// reordering from the phone doesn't yank the PC's focus to the swapped window. The window ids are
// unchanged — only their order in list-windows flips.
export async function swapWindows(a, b) {
  await runTmux(['swap-window', '-d', '-s', a, '-t', b]);
}
