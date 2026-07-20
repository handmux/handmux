import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  isPaneId, isWindowId, isSessionId, isValidSessionName,
  listSessions, listWindows, listPanes, listPaneIds, capturePane, paneInfo, paneLocation, sendText, sendEnter,
  resizeWindow, restoreWindowSize, newSession, paneCurrentPath, newWindow,
  renameSession, renameWindow, sessionWindowCount, killWindow, swapWindows, wheelSeq,
  splitPane, windowPaneCount, killPane,
} from '../src/tmux/commands.js';

const execFile = promisify(_execFile);
const SES = `twtest_${process.pid}`;
let hasTmux = true;

beforeAll(async () => {
  try { await execFile('tmux', ['-V']); } catch { hasTmux = false; return; }
  await execFile('tmux', ['new-session', '-d', '-s', SES, '-x', '80', '-y', '24']);
});
afterAll(async () => {
  if (hasTmux) { try { await execFile('tmux', ['kill-session', '-t', SES]); } catch {} }
});

describe('id validators', () => {
  it('validates ids', () => {
    expect(isPaneId('%1')).toBe(true);
    expect(isPaneId('1')).toBe(false);
    expect(isWindowId('@3')).toBe(true);
    expect(isSessionId('$0')).toBe(true);
    expect(isSessionId('main')).toBe(false);
  });
});

describe('tmux commands (integration)', () => {
  it('lists the test session, its window and pane', async () => {
    if (!hasTmux) return;
    const sessions = await listSessions();
    const s = sessions.find((x) => x.name === SES);
    expect(s).toBeTruthy();
    expect(isSessionId(s.id)).toBe(true);

    const windows = await listWindows(s.id);
    expect(windows.length).toBeGreaterThan(0);
    expect(isWindowId(windows[0].id)).toBe(true);
    expect(windows[0].width).toBe(80);
    expect(windows[0].height).toBe(24);

    const panes = await listPanes(windows[0].id);
    expect(panes.length).toBeGreaterThan(0);
    expect(isPaneId(panes[0].id)).toBe(true);
    expect(panes[0].width).toBe(80);
  });

  it('listPanes includes an absolute cwd for each pane', async () => {
    if (!hasTmux) return;
    const sessions = await listSessions();
    const s = sessions.find((x) => x.name === SES);
    const windows = await listWindows(s.id);
    const panes = await listPanes(windows[0].id);
    expect(panes.length).toBeGreaterThan(0);
    expect(typeof panes[0].cwd).toBe('string');
    expect(panes[0].cwd.startsWith('/')).toBe(true);
  });

  it('listPanes includes each pane left/top so a split can be reconstructed', async () => {
    if (!hasTmux) return;
    const s = (await listSessions()).find((x) => x.name === SES);
    const w0 = (await listWindows(s.id))[0];
    const anchor = (await listPanes(w0.id))[0].id;
    try {
      // -h = side-by-side, so the second pane starts at a non-zero left.
      await execFile('tmux', ['split-window', '-h', '-d', '-t', anchor]);
      const panes = await listPanes(w0.id);
      expect(panes.length).toBe(2);
      for (const p of panes) {
        expect(Number.isInteger(p.left)).toBe(true);
        expect(Number.isInteger(p.top)).toBe(true);
      }
      // one pane hugs the left edge, the other is pushed right
      expect(Math.min(...panes.map((p) => p.left))).toBe(0);
      expect(Math.max(...panes.map((p) => p.left))).toBeGreaterThan(0);
    } finally {
      // kill every pane we added, leaving the window single-pane for other tests
      const extra = (await listPanes(w0.id)).filter((p) => p.id !== anchor);
      for (const p of extra) { try { await execFile('tmux', ['kill-pane', '-t', p.id]); } catch {} }
    }
  });

  it('captures history and round-trips send-keys', async () => {
    if (!hasTmux) return;
    const s = (await listSessions()).find((x) => x.name === SES);
    const w = (await listWindows(s.id))[0];
    const pane = (await listPanes(w.id))[0].id;

    await sendText(pane, 'echo HELLO_TWTEST');
    await sendEnter(pane);
    await new Promise((r) => setTimeout(r, 400));

    const ansi = await capturePane(pane, 100);
    expect(ansi).toContain('HELLO_TWTEST');

    // capturePane uses -N to PRESERVE trailing whitespace: the line keeps its padding instead of being
    // trimmed right after the text, so a highlighted row's background tail survives. (How far it pads
    // is tmux-version-dependent — older tmux padded short lines to the full pane width; 3.6a pads to the
    // line's allocated extent — so assert the intent "trailing space is kept", not a fixed width.)
    const outLine = ansi.split('\n').find((l) => l.includes('HELLO_TWTEST')).replace(/\x1b\[[0-9;]*m/g, '');
    expect(outLine.replace(/\s+$/, '')).toContain('HELLO_TWTEST');
    expect(outLine.length).toBeGreaterThan(outLine.replace(/\s+$/, '').length);

    const info = await paneInfo(pane);
    expect(info.width).toBe(80);
    expect(info.height).toBe(24);
    expect(info.altScreen).toBe(false); // a plain shell isn't on the alternate screen…
    expect(info.mouseAware).toBe(false); // …nor is it reporting mouse
  });

  // Named guard for the tmux capture behaviours the terminal rendering depends on (CLAUDE.md). If a tmux
  // version changes these, this fails loudly here instead of as a mysterious mobile-render glitch. Deep
  // scroll/BCE/shaded-bg behaviour is covered separately by web/test/terminalRefresh.test.js (real bytes).
  it('capture-pane keeps SGR (-e) and trailing whitespace (-N) — rendering depends on these', async () => {
    if (!hasTmux) return;
    const pane = (await listPanes((await listWindows((await listSessions()).find((x) => x.name === SES).id))[0].id))[0].id;

    // -e: a coloured run keeps its SGR escape in the capture (not stripped to plain text).
    await sendText(pane, "printf '\\033[42mTWSGR\\033[0m\\n'");
    await sendEnter(pane);
    // Poll rather than a fixed sleep so this stays green under heavy parallel test load.
    let ansi = '';
    for (let i = 0; i < 30 && !ansi.includes('TWSGR'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      ansi = await capturePane(pane, 100);
    }
    expect(ansi).toContain('TWSGR');
    expect(/\x1b\[[0-9;]*m/.test(ansi)).toBe(true);

    // -N: at least one captured line carries trailing whitespace (kept, not trimmed at end-of-text).
    const hasTrailing = ansi.split('\n').some((l) => {
      const plain = l.replace(/\x1b\[[0-9;]*m/g, '');
      return plain.length > 0 && plain.length > plain.replace(/\s+$/, '').length;
    });
    expect(hasTrailing).toBe(true);
  });

  it('resizes the window so the pane reflows to the new grid', async () => {
    if (!hasTmux) return;
    const s = (await listSessions()).find((x) => x.name === SES);
    const w = (await listWindows(s.id))[0];

    await resizeWindow(w.id, 50, 20);
    const small = await paneInfo((await listPanes(w.id))[0].id);
    expect(small.width).toBe(50);
    expect(small.height).toBe(20);

    await restoreWindowSize(w.id); // hand sizing back so we don't leave the window pinned
  });

  it('paneLocation resolves the current pane to a session + window', async () => {
    const pane = process.env.TMUX_PANE;
    if (!pane) return; // 仅在 tmux 内运行时有意义
    const loc = await paneLocation(pane);
    expect(typeof loc.session).toBe('string');
    expect(loc.session.length).toBeGreaterThan(0);
    expect(loc.window).toMatch(/^@\d+$/);
    expect(typeof loc.windowName).toBe('string');
  });

  it('listPaneIds includes the test session pane', async () => {
    if (!hasTmux) return;
    const ids = await listPaneIds();
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.every((p) => isPaneId(p))).toBe(true);
    // the test session created in beforeAll has at least one pane
    const panes = await listWindows(SES).then((ws) => listPanes(ws[0].id));
    expect(ids).toContain(panes[0].id);
  });
});

describe('isValidSessionName', () => {
  it('accepts letters, digits and hyphens up to 16 chars', () => {
    expect(isValidSessionName('my-session')).toBe(true);
    expect(isValidSessionName('abc123')).toBe(true);
    expect(isValidSessionName('a')).toBe(true);
    expect(isValidSessionName('a'.repeat(16))).toBe(true);
  });
  it('rejects empty, too long, spaces, dots, colons, CJK, control chars and non-strings', () => {
    expect(isValidSessionName('')).toBe(false);
    expect(isValidSessionName('a'.repeat(17))).toBe(false);
    expect(isValidSessionName('my session')).toBe(false);
    expect(isValidSessionName('a.b')).toBe(false);
    expect(isValidSessionName('a:b')).toBe(false);
    expect(isValidSessionName('会话')).toBe(false);
    expect(isValidSessionName('a\tb')).toBe(false);
    expect(isValidSessionName(123)).toBe(false);
  });
});

describe('newSession (integration)', () => {
  it('creates a detached session that shows up in listSessions', async () => {
    if (!hasTmux) return;
    const name = `twnew${process.pid}`.slice(0, 16); // letters+digits, ≤16 chars
    let id;
    try {
      id = await newSession(name);
      expect(isSessionId(id)).toBe(true);
      const s = (await listSessions()).find((x) => x.name === name);
      expect(s).toBeTruthy();
      expect(s.id).toBe(id);
    } finally {
      if (id) { try { await execFile('tmux', ['kill-session', '-t', name]); } catch {} }
    }
  });
});

describe('newWindow / paneCurrentPath (integration)', () => {
  it('reads a pane path and creates a new window in the session', async () => {
    if (!hasTmux) return;
    const s = (await listSessions()).find((x) => x.name === SES);
    const w0 = (await listWindows(s.id))[0];
    const pane = (await listPanes(w0.id))[0].id;

    const path = await paneCurrentPath(pane);
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);

    const before = (await listWindows(s.id)).length;
    let wid;
    try {
      wid = await newWindow(s.id, path);
      expect(isWindowId(wid)).toBe(true);
      const after = await listWindows(s.id);
      expect(after.length).toBe(before + 1);
      expect(after.some((w) => w.id === wid)).toBe(true);
      // the new window actually opened in the dir we passed (proves -c is wired, not just window creation)
      const newPane = (await listPanes(wid))[0].id;
      expect(await paneCurrentPath(newPane)).toBe(path);
    } finally {
      if (wid) { try { await execFile('tmux', ['kill-window', '-t', wid]); } catch {} }
    }
  });

  it('names the new window when a name is given', async () => {
    if (!hasTmux) return;
    const s = (await listSessions()).find((x) => x.name === SES);
    let wid;
    try {
      wid = await newWindow(s.id, null, 'build-1');
      const w = (await listWindows(s.id)).find((x) => x.id === wid);
      expect(w.name).toBe('build-1');
    } finally {
      if (wid) { try { await execFile('tmux', ['kill-window', '-t', wid]); } catch {} }
    }
  });

  it('newSession honours an explicit start dir', async () => {
    if (!hasTmux) return;
    const s = (await listSessions()).find((x) => x.name === SES);
    const w0 = (await listWindows(s.id))[0];
    const pane0 = (await listPanes(w0.id))[0].id;
    // use the test session's pane cwd as our reference dir (already an absolute realpath via tmux)
    const dir = await paneCurrentPath(pane0);
    const sid = await newSession(`cwd-sess-${Date.now()}`.slice(0, 16), dir);
    try {
      const pane = (await listPanes((await listWindows(sid))[0].id))[0];
      expect(pane.cwd).toBe(dir);
    } finally {
      try { await execFile('tmux', ['kill-session', '-t', sid]); } catch {}
    }
  });
});

describe('renameSession (integration)', () => {
  it('renames a session in place — the id is unchanged', async () => {
    if (!hasTmux) return;
    const a = `twren${process.pid}`.slice(0, 16);
    const b = `twren2${process.pid}`.slice(0, 16);
    let id, current = a;
    try {
      id = await newSession(a);
      await renameSession(id, b);
      current = b;
      const s = (await listSessions()).find((x) => x.name === b);
      expect(s).toBeTruthy();
      expect(s.id).toBe(id); // rename-session keeps the same $id
      expect((await listSessions()).some((x) => x.name === a)).toBe(false);
    } finally {
      try { await execFile('tmux', ['kill-session', '-t', current]); } catch {}
    }
  });
});

describe('renameWindow / sessionWindowCount / killWindow (integration)', () => {
  it('renames a window, counts windows, and kills a window', async () => {
    if (!hasTmux) return;
    const s = (await listSessions()).find((x) => x.name === SES);
    const before = await sessionWindowCount((await listWindows(s.id))[0].id);

    const wid = await newWindow(s.id, null, 'tmp-win');
    expect(await sessionWindowCount(wid)).toBe(before + 1); // session_windows counts the whole session

    await renameWindow(wid, 'renamed-win');
    expect((await listWindows(s.id)).find((w) => w.id === wid).name).toBe('renamed-win');

    await killWindow(wid);
    expect((await listWindows(s.id)).some((w) => w.id === wid)).toBe(false);
    expect(await sessionWindowCount((await listWindows(s.id))[0].id)).toBe(before);
  });
});

describe('swapWindows (integration)', () => {
  it('swaps two windows positions in the session order', async () => {
    if (!hasTmux) return;
    const s = (await listSessions()).find((x) => x.name === SES);
    let a, b;
    try {
      a = await newWindow(s.id, null, 'swap-a'); // created first → lower index → comes first
      b = await newWindow(s.id, null, 'swap-b');
      const before = (await listWindows(s.id)).map((w) => w.id);
      expect(before.indexOf(a)).toBeLessThan(before.indexOf(b));

      await swapWindows(a, b);

      const after = (await listWindows(s.id)).map((w) => w.id);
      expect(after.indexOf(b)).toBeLessThan(after.indexOf(a)); // positions flipped
    } finally {
      if (a) { try { await execFile('tmux', ['kill-window', '-t', a]); } catch {} }
      if (b) { try { await execFile('tmux', ['kill-window', '-t', b]); } catch {} }
    }
  });
});

describe('splitPane / windowPaneCount / killPane (integration)', () => {
  it('splits a pane, counts panes, then kills the new pane', async () => {
    if (!hasTmux) return;
    const wid = await newWindow(SES, null, 'split-tmp');
    const [base] = await listPaneIds(wid);
    expect(await windowPaneCount(base)).toBe(1);

    const right = await splitPane(base, 'h'); // left|right
    expect(isPaneId(right)).toBe(true);
    expect(right).not.toBe(base);
    expect(await windowPaneCount(base)).toBe(2);

    const bottom = await splitPane(base, 'v'); // top/bottom of the base pane
    expect(await windowPaneCount(base)).toBe(3);

    await killPane(bottom);
    expect(await windowPaneCount(base)).toBe(2);
    await killWindow(wid);
  });

  it('splitPane -c opens the new pane in the given cwd', async () => {
    if (!hasTmux) return;
    const wid = await newWindow(SES, null, 'split-cwd');
    const [base] = await listPaneIds(wid);
    const tmpPath = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
    const p = await splitPane(base, 'h', tmpPath);
    expect(await paneCurrentPath(p)).toBe(tmpPath);
    await killWindow(wid);
  });
});

describe('name self-guard', () => {
  it('renameSession/renameWindow reject an invalid name without calling tmux', async () => {
    await expect(renameSession('$0', 'bad name')).rejects.toThrow(/invalid/);
    await expect(renameWindow('@0', '会话')).rejects.toThrow(/invalid/);
  });
});

describe('wheelSeq (mouse-wheel byte encoding)', () => {
  const ESC = '\x1b';
  it('SGR: wheel-up is button 64, down is 65, at the given 1-based position', () => {
    expect(wheelSeq('up', 1, { sgr: true, col: 40, row: 12 })).toBe(`${ESC}[<64;40;12M`);
    expect(wheelSeq('down', 1, { sgr: true, col: 40, row: 12 })).toBe(`${ESC}[<65;40;12M`);
  });
  it('repeats the escape run once per notch (count clamped to 1..60)', () => {
    expect(wheelSeq('down', 3, { sgr: true, col: 1, row: 1 })).toBe(`${ESC}[<65;1;1M`.repeat(3));
    expect(wheelSeq('down', 0, { sgr: true }).match(/M/g)).toHaveLength(1);   // 0 → 1
    expect(wheelSeq('down', 999, { sgr: true }).match(/M/g)).toHaveLength(60); // capped
  });
  it('legacy X10: ESC [ M with button/coords offset by 32, coords capped at 223', () => {
    // wheel-down = 65 (+32 = 97); col 40 (+32 = 72); row 12 (+32 = 44)
    expect(wheelSeq('down', 1, { sgr: false, col: 40, row: 12 }))
      .toBe(`${ESC}[M` + String.fromCharCode(97, 72, 44));
    const capped = wheelSeq('up', 1, { sgr: false, col: 500, row: 500 });
    expect(capped).toBe(`${ESC}[M` + String.fromCharCode(64 + 32, 223 + 32, 223 + 32));
  });
  it('clamps a non-positive position to 1', () => {
    expect(wheelSeq('up', 1, { sgr: true, col: 0, row: -5 })).toBe(`${ESC}[<64;1;1M`);
  });
});
