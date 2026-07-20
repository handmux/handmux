import { describe, it, expect, vi } from 'vitest';
import { tmpHome } from './tmphome.js';
import request from 'supertest';
import express from 'express';
import { createApiRouter } from '../src/httpApi.js';
import { writeCache } from '../src/cli/updateCheck.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function appWith(commands) {
  const app = express();
  app.use('/api', createApiRouter({ token: 'good', commands }));
  return app;
}
const auth = (r) => r.set('Authorization', 'Bearer good');

const baseCommands = {
  listSessions: vi.fn(async () => [{ id: '$0', name: 'main' }]),
  listWindows: vi.fn(async () => [{ id: '@1', name: 'w', active: true, panes: 2 }]),
  listPanes: vi.fn(async () => [{ id: '%1', active: true, width: 80, height: 24, command: 'zsh', cwd: '/home/u/proj' }]),
  capturePane: vi.fn(async () => 'history-text'),
  paneInfo: vi.fn(async () => ({ width: 80, height: 24, cursorX: 0, cursorY: 23, cursorVisible: false, altScreen: false, mouseAware: false, mouseSgr: false })),
  exitCopyModeIfActive: vi.fn(async () => {}),
  sendText: vi.fn(async () => {}),
  sendEnter: vi.fn(async () => {}),
  sendKey: vi.fn(async () => {}),
  sendWheel: vi.fn(async () => {}),
  resizeWindow: vi.fn(async () => {}),
  resizePane: vi.fn(async () => {}),
  getWindowLayout: vi.fn(async () => 'c89a,200x50,0,0{100x50,0,0,1,99x50,101,0,2}'),
  applyWindowLayout: vi.fn(async () => {}),
  restoreWindowSize: vi.fn(async () => {}),
  newSession: vi.fn(async () => '$7'),
  paneCurrentPath: vi.fn(async () => '/home/u/proj'),
  newWindow: vi.fn(async () => '@9'),
  renameSession: vi.fn(async () => {}),
  renameWindow: vi.fn(async () => {}),
  sessionWindowCount: vi.fn(async () => 2),
  killWindow: vi.fn(async () => {}),
  swapWindows: vi.fn(async () => {}),
  splitPane: vi.fn(async () => '%91'),
  windowPaneCount: vi.fn(async () => 2),
  killPane: vi.fn(async () => {}),
};

describe('REST API', () => {
  it('requires auth', async () => {
    await request(appWith(baseCommands)).get('/api/sessions').expect(401);
  });

  it('GET /sessions', async () => {
    const res = await auth(request(appWith(baseCommands)).get('/api/sessions')).expect(200);
    expect(res.body).toEqual([{ id: '$0', name: 'main' }]);
  });

  it('POST /sessions creates a session with a valid new name', async () => {
    const cmds = { ...baseCommands, listSessions: vi.fn(async () => [{ id: '$0', name: 'main' }]), newSession: vi.fn(async () => '$7') };
    const res = await auth(request(appWith(cmds)).post('/api/sessions')).send({ name: 'new-sess' }).expect(201);
    expect(res.body).toEqual({ id: '$7', name: 'new-sess' });
    expect(cmds.newSession).toHaveBeenCalledWith('new-sess', undefined, undefined);
  });

  it('POST /sessions returns 409 for an existing name and does not create', async () => {
    const cmds = { ...baseCommands, listSessions: vi.fn(async () => [{ id: '$0', name: 'main' }]), newSession: vi.fn(async () => '$7') };
    await auth(request(appWith(cmds)).post('/api/sessions')).send({ name: 'main' }).expect(409);
    expect(cmds.newSession).not.toHaveBeenCalled();
  });

  it('POST /sessions returns 400 for an invalid name and does not create', async () => {
    const cmds = { ...baseCommands, newSession: vi.fn(async () => '$7') };
    await auth(request(appWith(cmds)).post('/api/sessions')).send({ name: 'bad name' }).expect(400);
    await auth(request(appWith(cmds)).post('/api/sessions')).send({ name: '会话' }).expect(400);
    expect(cmds.newSession).not.toHaveBeenCalled();
  });

  it('POST /sessions requires auth', async () => {
    await request(appWith(baseCommands)).post('/api/sessions').send({ name: 'x' }).expect(401);
  });

  it('POST /windows resolves the pane cwd then creates an auto-named window (no name)', async () => {
    const cmds = { ...baseCommands, paneCurrentPath: vi.fn(async () => '/home/u/proj'), newWindow: vi.fn(async () => '@9') };
    const res = await auth(request(appWith(cmds)).post('/api/windows')).send({ session: '$0', pane: '%1' }).expect(201);
    expect(res.body).toEqual({ id: '@9' });
    expect(cmds.paneCurrentPath).toHaveBeenCalledWith('%1');
    expect(cmds.newWindow).toHaveBeenCalledWith('$0', '/home/u/proj', undefined, undefined); // blank name → auto-name
  });

  it('POST /windows passes a valid name through to newWindow', async () => {
    const cmds = { ...baseCommands, paneCurrentPath: vi.fn(async () => '/home/u/proj'), newWindow: vi.fn(async () => '@9') };
    await auth(request(appWith(cmds)).post('/api/windows')).send({ session: '$0', pane: '%1', name: 'build-1' }).expect(201);
    expect(cmds.newWindow).toHaveBeenCalledWith('$0', '/home/u/proj', 'build-1', undefined);
  });

  it('POST /windows rejects an invalid window name and does not create', async () => {
    const cmds = { ...baseCommands, newWindow: vi.fn(async () => '@9') };
    await auth(request(appWith(cmds)).post('/api/windows')).send({ session: '$0', pane: '%1', name: 'bad name' }).expect(400);
    expect(cmds.newWindow).not.toHaveBeenCalled();
  });

  it('POST /windows forwards a startup command (auto-run in the new window)', async () => {
    const cmds = { ...baseCommands, paneCurrentPath: vi.fn(async () => '/home/u/proj'), newWindow: vi.fn(async () => '@9') };
    await auth(request(appWith(cmds)).post('/api/windows')).send({ session: '$0', pane: '%1', cmd: 'claude -c' }).expect(201);
    expect(cmds.newWindow).toHaveBeenCalledWith('$0', '/home/u/proj', undefined, 'claude -c');
  });

  it('POST /windows rejects a startup command with control chars (e.g. a newline) and does not create', async () => {
    const cmds = { ...baseCommands, newWindow: vi.fn(async () => '@9') };
    await auth(request(appWith(cmds)).post('/api/windows')).send({ session: '$0', pane: '%1', cmd: 'claude\nrm -rf /' }).expect(400);
    expect(cmds.newWindow).not.toHaveBeenCalled();
  });

  it('POST /sessions forwards a startup command', async () => {
    const cmds = { ...baseCommands, listSessions: vi.fn(async () => []), newSession: vi.fn(async () => '$7') };
    await auth(request(appWith(cmds)).post('/api/sessions')).send({ name: 'proj', cmd: 'claude' }).expect(201);
    expect(cmds.newSession).toHaveBeenCalledWith('proj', undefined, 'claude');
  });

  it('POST /windows rejects a bad session id and does not create', async () => {
    const cmds = { ...baseCommands, newWindow: vi.fn(async () => '@9') };
    await auth(request(appWith(cmds)).post('/api/windows')).send({ session: 'main', pane: '%1' }).expect(400);
    expect(cmds.newWindow).not.toHaveBeenCalled();
  });

  it('POST /windows rejects a bad pane id and does not create', async () => {
    const cmds = { ...baseCommands, newWindow: vi.fn(async () => '@9') };
    await auth(request(appWith(cmds)).post('/api/windows')).send({ session: '$0', pane: '1' }).expect(400);
    expect(cmds.newWindow).not.toHaveBeenCalled();
  });

  it('POST /windows requires auth', async () => {
    await request(appWith(baseCommands)).post('/api/windows').send({ session: '$0', pane: '%1' }).expect(401);
  });

  it('GET /windows validates session id and returns per-window pane counts', async () => {
    await auth(request(appWith(baseCommands)).get('/api/windows?session=main')).expect(400);
    const res = await auth(request(appWith(baseCommands)).get('/api/windows?session=$0')).expect(200);
    expect(res.body).toEqual([{ id: '@1', name: 'w', active: true, panes: 2 }]);
  });

  it('GET /history returns ansi + size + a content hash', async () => {
    const res = await auth(request(appWith(baseCommands)).get('/api/history?pane=%1&lines=100')).expect(200);
    expect(res.body).toMatchObject({ ansi: 'history-text', width: 80, height: 24 });
    expect(res.body.hash).toEqual(expect.any(String));
    expect(baseCommands.capturePane).toHaveBeenCalledWith('%1', 100);
  });

  it('GET /history returns 204 when ?since matches the current hash', async () => {
    const app = appWith(baseCommands);
    const first = await auth(request(app).get('/api/history?pane=%1&lines=100')).expect(200);
    const res = await auth(request(app).get(`/api/history?pane=%1&lines=100&since=${first.body.hash}`)).expect(204);
    expect(res.body).toEqual({}); // empty body
  });

  it('GET /history sends a fresh body when ?since does not match', async () => {
    const res = await auth(request(appWith(baseCommands)).get('/api/history?pane=%1&lines=100&since=stale')).expect(200);
    expect(res.body).toMatchObject({ ansi: 'history-text' });
  });

  it('GET /history reports the cursor as {row,col,vis}, row counted from the bottom of the capture', async () => {
    // 5-row capture, cursor on row 2 (0-based, of a 5-high pane) col 3, visible → 5-1-2 = 2 rows
    // up from the bottom (no trailing blanks trimmed here).
    const cmds = {
      ...baseCommands,
      capturePane: vi.fn(async () => 'r0\nr1\nr2\nr3\nr4\n'),
      paneInfo: vi.fn(async () => ({ width: 80, height: 5, cursorX: 3, cursorY: 2, cursorVisible: true })),
    };
    const res = await auth(request(appWith(cmds)).get('/api/history?pane=%1&lines=100')).expect(200);
    expect(res.body.cur).toEqual({ row: 2, col: 3, vis: true });
  });

  it('GET /history accounts for capped trailing blank rows when placing the cursor', async () => {
    // A fresh-shell shape: prompt at top, a wall of blank rows below. capTrailingBlankRows keeps only
    // 3 of them, so the cursor's distance-from-bottom shrinks by however many were dropped.
    const cmds = {
      ...baseCommands,
      capturePane: vi.fn(async () => `prompt${'\n'.repeat(10)}`), // 'prompt' row + 9 blank rows = 10 rows
      paneInfo: vi.fn(async () => ({ width: 80, height: 10, cursorX: 8, cursorY: 0, cursorVisible: true })),
    };
    const res = await auth(request(appWith(cmds)).get('/api/history?pane=%1&lines=100')).expect(200);
    // raw: 10 rows, cursor 10-1-0 = 9 up. Trim drops 9-3 = 6 trailing blanks → 9-6 = 3 up.
    expect(res.body.cur).toEqual({ row: 3, col: 8, vis: true });
  });

  it('GET /history captures an ALT-screen pane as the exact visible screen — no scrollback, no blank-trim', async () => {
    // An alt-screen (full-screen app) pane has NO scrollback: asking tmux for history (-S -lines) bleeds
    // the MAIN screen's scrollback in above the app, and capping its trailing blank rows mangles the
    // fixed-height screen. So alt panes must be captured as exactly their `height` rows: capturePane with
    // lines=0 (visible only) and NO capTrailingBlankRows.
    const cmds = {
      ...baseCommands,
      // content at the top, real blank rows below — a short full-screen app filling a 6-row pane
      capturePane: vi.fn(async () => 'a0\na1\n\n\n\n\n'),
      paneInfo: vi.fn(async () => ({ width: 80, height: 6, cursorX: 0, cursorY: 1, cursorVisible: true, altScreen: true, mouseAware: false, mouseSgr: false })),
    };
    const res = await auth(request(appWith(cmds)).get('/api/history?pane=%1&lines=100')).expect(200);
    expect(cmds.capturePane).toHaveBeenCalledWith('%1', 0); // visible screen only, not the requested 100
    expect(res.body.ansi).toBe('a0\na1\n\n\n\n\n');          // trailing blanks kept — the fixed screen is intact
    expect(res.body.alt).toBe(true);
    // cursor on row 1 of 6 → 6-1-1 = 4 up from the bottom; no trim, so no extra adjustment
    expect(res.body.cur).toEqual({ row: 4, col: 0, vis: true });
  });

  it('GET /history: a bare cursor move (same text) is a FRESH frame, not a 204', async () => {
    // left/right moves the cursor but not the text — folding the cursor into the hash means the move
    // still yields a new frame, so the client can re-place the cursor (otherwise it'd never track).
    const at = (x) => ({
      ...baseCommands,
      capturePane: vi.fn(async () => 'same-text\n'),
      paneInfo: vi.fn(async () => ({ width: 80, height: 1, cursorX: x, cursorY: 0, cursorVisible: true })),
    });
    const a = await auth(request(appWith(at(2))).get('/api/history?pane=%1&lines=100')).expect(200);
    const b = await auth(request(appWith(at(5))).get('/api/history?pane=%1&lines=100')).expect(200);
    expect(a.body.hash).not.toEqual(b.body.hash);            // cursor moved → different hash
    // and the old hash no longer matches → no 204, a fresh body comes back
    await auth(request(appWith(at(5))).get(`/api/history?pane=%1&lines=100&since=${a.body.hash}`)).expect(200);
  });

  it('GET /history gzip-compresses the body when the client accepts gzip', async () => {
    const res = await auth(request(appWith(baseCommands)).get('/api/history?pane=%1&lines=100'))
      .set('Accept-Encoding', 'gzip').expect(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body).toMatchObject({ ansi: 'history-text', width: 80, height: 24 }); // supertest gunzips transparently
  });

  it('GET /history caps the empty grid below the cursor (a fresh shell stays visible, not pushed off-screen)', async () => {
    // capture-pane of a fresh shell: a prompt at the top, then a wall of blank rows down to the pane bottom.
    const cmds = { ...baseCommands, capturePane: vi.fn(async () => 'admin@host %\n\n\n\n\n\n') };
    const res = await auth(request(appWith(cmds)).get('/api/history?pane=%1&lines=100')).expect(200);
    expect(res.body.ansi).toBe('admin@host %\n\n\n\n'); // 5 trailing blanks → capped to MAX_TRAILING_BLANK (3)
  });

  it('POST /send sends text then Enter', async () => {
    await auth(request(appWith(baseCommands)).post('/api/send'))
      .send({ pane: '%1', text: 'ls', enter: true }).expect(200);
    expect(baseCommands.sendText).toHaveBeenCalledWith('%1', 'ls');
    expect(baseCommands.sendEnter).toHaveBeenCalledWith('%1');
  });

  it('POST /send with an empty box sends a bare Enter (the merged 发送 submit)', async () => {
    const cmds = { ...baseCommands, sendText: vi.fn(async () => {}), sendEnter: vi.fn(async () => {}) };
    await auth(request(appWith(cmds)).post('/api/send'))
      .send({ pane: '%1', enter: true }).expect(200);
    expect(cmds.sendText).toHaveBeenCalledWith('%1', '');
    expect(cmds.sendEnter).toHaveBeenCalledWith('%1');
  });

  it('POST /resize validates window id and clamps size', async () => {
    await auth(request(appWith(baseCommands)).post('/api/resize'))
      .send({ window: 'main', cols: 50, rows: 20 }).expect(400);
    await auth(request(appWith(baseCommands)).post('/api/resize'))
      .send({ window: '@1', cols: 5, rows: 99 }).expect(200);
    expect(baseCommands.resizeWindow).toHaveBeenCalledWith('@1', 20, 99); // cols clamped to >=20
  });

  it('POST /resize with a pane resizes only that pane', async () => {
    await auth(request(appWith(baseCommands)).post('/api/resize'))
      .send({ pane: '%1', cols: 60 }).expect(200);
    expect(baseCommands.resizePane).toHaveBeenCalledWith('%1', 60);
  });

  it('GET /layout returns the window layout', async () => {
    const res = await auth(request(appWith(baseCommands)).get('/api/layout?window=@1')).expect(200);
    expect(res.body.layout).toContain('200x50');
  });

  it('POST /resize with auto restores layout then client sizing', async () => {
    await auth(request(appWith(baseCommands)).post('/api/resize'))
      .send({ window: '@1', auto: true, layout: 'c89a,200x50,0,0{...}' }).expect(200);
    expect(baseCommands.applyWindowLayout).toHaveBeenCalledWith('@1', 'c89a,200x50,0,0{...}');
    expect(baseCommands.restoreWindowSize).toHaveBeenCalledWith('@1');
  });

  it('POST /keys rejects keys outside allowlist', async () => {
    await auth(request(appWith(baseCommands)).post('/api/keys'))
      .send({ pane: '%1', keys: ['rm-rf'] }).expect(400);
    await auth(request(appWith(baseCommands)).post('/api/keys'))
      .send({ pane: '%1', keys: ['Up', 'Enter'] }).expect(200);
    expect(baseCommands.sendKey).toHaveBeenCalledWith('%1', 'Up');
  });

  it('POST /keys accepts BTab (Shift+Tab) and C-r (Ctrl+R)', async () => {
    await auth(request(appWith(baseCommands)).post('/api/keys'))
      .send({ pane: '%1', keys: ['BTab', 'C-r'] }).expect(200);
    expect(baseCommands.sendKey).toHaveBeenCalledWith('%1', 'BTab');
    expect(baseCommands.sendKey).toHaveBeenCalledWith('%1', 'C-r');
  });

  it('POST /keys accepts C-o (Ctrl+O) and C-e (Ctrl+E)', async () => {
    await auth(request(appWith(baseCommands)).post('/api/keys'))
      .send({ pane: '%1', keys: ['C-o', 'C-e'] }).expect(200);
    expect(baseCommands.sendKey).toHaveBeenCalledWith('%1', 'C-o');
    expect(baseCommands.sendKey).toHaveBeenCalledWith('%1', 'C-e');
  });

  it('GET /history exposes alt + mouseAware so the client can pick wheel-scroll vs hint', async () => {
    const cmds = { ...baseCommands, paneInfo: vi.fn(async () => ({ width: 80, height: 24, cursorX: 0, cursorY: 23, cursorVisible: false, altScreen: true, mouseAware: true, mouseSgr: true })) };
    const res = await auth(request(appWith(cmds)).get('/api/history?pane=%1&lines=100')).expect(200);
    expect(res.body).toMatchObject({ alt: true, mouseAware: true });
  });

  it('POST /scroll injects wheel events at the pane centre when the app is mouse-reporting', async () => {
    const cmds = { ...baseCommands, paneInfo: vi.fn(async () => ({ width: 80, height: 24, altScreen: true, mouseAware: true, mouseSgr: true })), sendWheel: vi.fn(async () => {}) };
    const res = await auth(request(appWith(cmds)).post('/api/scroll')).send({ pane: '%1', dir: 'down', lines: 3 }).expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(cmds.sendWheel).toHaveBeenCalledWith('%1', 'down', 3, { sgr: true, col: 40, row: 12 });
  });

  it('POST /scroll REFUSES to inject when the pane is not mouse-reporting (bytes would leak as text)', async () => {
    const cmds = { ...baseCommands, paneInfo: vi.fn(async () => ({ width: 80, height: 24, altScreen: true, mouseAware: false, mouseSgr: false })), sendWheel: vi.fn(async () => {}) };
    const res = await auth(request(appWith(cmds)).post('/api/scroll')).send({ pane: '%1', dir: 'up', lines: 2 }).expect(200);
    expect(res.body).toEqual({ ok: false, reason: 'no-mouse' });
    expect(cmds.sendWheel).not.toHaveBeenCalled();
  });

  it('POST /scroll rejects a bad direction / pane id', async () => {
    await auth(request(appWith(baseCommands)).post('/api/scroll')).send({ pane: '%1', dir: 'sideways' }).expect(400);
    await auth(request(appWith(baseCommands)).post('/api/scroll')).send({ pane: 'nope', dir: 'up' }).expect(400);
  });

  it('PATCH /sessions renames when the new name is valid and free', async () => {
    const cmds = { ...baseCommands, listSessions: vi.fn(async () => [{ id: '$0', name: 'main' }, { id: '$1', name: 'other' }]), renameSession: vi.fn(async () => {}) };
    const res = await auth(request(appWith(cmds)).patch('/api/sessions')).send({ id: '$0', name: 'prod' }).expect(200);
    expect(res.body).toEqual({ id: '$0', name: 'prod' });
    expect(cmds.renameSession).toHaveBeenCalledWith('$0', 'prod');
  });

  it('PATCH /sessions allows renaming to the SAME name (the collision check excludes itself)', async () => {
    const cmds = { ...baseCommands, listSessions: vi.fn(async () => [{ id: '$0', name: 'main' }]), renameSession: vi.fn(async () => {}) };
    await auth(request(appWith(cmds)).patch('/api/sessions')).send({ id: '$0', name: 'main' }).expect(200);
    expect(cmds.renameSession).toHaveBeenCalledWith('$0', 'main');
  });

  it('PATCH /sessions returns 409 when another session already has the name', async () => {
    const cmds = { ...baseCommands, listSessions: vi.fn(async () => [{ id: '$0', name: 'main' }, { id: '$1', name: 'other' }]), renameSession: vi.fn(async () => {}) };
    await auth(request(appWith(cmds)).patch('/api/sessions')).send({ id: '$0', name: 'other' }).expect(409);
    expect(cmds.renameSession).not.toHaveBeenCalled();
  });

  it('PATCH /sessions rejects a bad id or bad name', async () => {
    const cmds = { ...baseCommands, renameSession: vi.fn(async () => {}) };
    await auth(request(appWith(cmds)).patch('/api/sessions')).send({ id: 'main', name: 'ok' }).expect(400);
    await auth(request(appWith(cmds)).patch('/api/sessions')).send({ id: '$0', name: 'bad name' }).expect(400);
    expect(cmds.renameSession).not.toHaveBeenCalled();
  });

  it('PATCH /windows renames a window with a valid name', async () => {
    const cmds = { ...baseCommands, renameWindow: vi.fn(async () => {}) };
    const res = await auth(request(appWith(cmds)).patch('/api/windows')).send({ id: '@1', name: 'build' }).expect(200);
    expect(res.body).toEqual({ id: '@1', name: 'build' });
    expect(cmds.renameWindow).toHaveBeenCalledWith('@1', 'build');
  });

  it('PATCH /windows rejects a bad id or bad name', async () => {
    const cmds = { ...baseCommands, renameWindow: vi.fn(async () => {}) };
    await auth(request(appWith(cmds)).patch('/api/windows')).send({ id: 'w', name: 'ok' }).expect(400);
    await auth(request(appWith(cmds)).patch('/api/windows')).send({ id: '@1', name: '会话' }).expect(400);
    expect(cmds.renameWindow).not.toHaveBeenCalled();
  });

  it('DELETE /windows kills a window when it is not the only one', async () => {
    const cmds = { ...baseCommands, sessionWindowCount: vi.fn(async () => 3), killWindow: vi.fn(async () => {}) };
    await auth(request(appWith(cmds)).delete('/api/windows?window=@2')).expect(204);
    expect(cmds.killWindow).toHaveBeenCalledWith('@2');
  });

  it('DELETE /windows kills the only window too (taking the session down — client-confirmed)', async () => {
    const cmds = { ...baseCommands, sessionWindowCount: vi.fn(async () => 1), killWindow: vi.fn(async () => {}) };
    await auth(request(appWith(cmds)).delete('/api/windows?window=@2')).expect(204);
    expect(cmds.killWindow).toHaveBeenCalledWith('@2');
  });

  it('DELETE /windows rejects a bad window id', async () => {
    const cmds = { ...baseCommands, killWindow: vi.fn(async () => {}) };
    await auth(request(appWith(cmds)).delete('/api/windows?window=2')).expect(400);
    expect(cmds.killWindow).not.toHaveBeenCalled();
  });

  it('POST /windows/swap swaps two windows', async () => {
    const cmds = { ...baseCommands, swapWindows: vi.fn(async () => {}) };
    await auth(request(appWith(cmds)).post('/api/windows/swap')).send({ a: '@1', b: '@2' }).expect(200);
    expect(cmds.swapWindows).toHaveBeenCalledWith('@1', '@2');
  });

  it('POST /windows/swap rejects a bad window id and does not swap', async () => {
    const cmds = { ...baseCommands, swapWindows: vi.fn(async () => {}) };
    await auth(request(appWith(cmds)).post('/api/windows/swap')).send({ a: '@1', b: 'w' }).expect(400);
    await auth(request(appWith(cmds)).post('/api/windows/swap')).send({ a: '1', b: '@2' }).expect(400);
    expect(cmds.swapWindows).not.toHaveBeenCalled();
  });

  it('POST /windows/swap rejects swapping a window with itself', async () => {
    const cmds = { ...baseCommands, swapWindows: vi.fn(async () => {}) };
    await auth(request(appWith(cmds)).post('/api/windows/swap')).send({ a: '@1', b: '@1' }).expect(400);
    expect(cmds.swapWindows).not.toHaveBeenCalled();
  });

  it('POST /windows/swap requires auth', async () => {
    await request(appWith(baseCommands)).post('/api/windows/swap').send({ a: '@1', b: '@2' }).expect(401);
  });

  it('PATCH /sessions, PATCH /windows and DELETE /windows require auth', async () => {
    await request(appWith(baseCommands)).patch('/api/sessions').send({ id: '$0', name: 'x' }).expect(401);
    await request(appWith(baseCommands)).patch('/api/windows').send({ id: '@1', name: 'x' }).expect(401);
    await request(appWith(baseCommands)).delete('/api/windows?window=@2').expect(401);
  });

  it('GET /panes passes through cwd', async () => {
    const res = await auth(request(appWith(baseCommands)).get('/api/panes?window=@1')).expect(200);
    expect(res.body[0].cwd).toBe('/home/u/proj');
  });

  it('GET /pane-cwd returns the pane cwd', async () => {
    const res = await auth(request(appWith(baseCommands)).get('/api/pane-cwd?pane=%1')).expect(200);
    expect(res.body).toEqual({ cwd: '/home/u/proj' });
  });

  it('GET /pane-cwd rejects a bad pane id', async () => {
    await auth(request(appWith(baseCommands)).get('/api/pane-cwd?pane=1')).expect(400);
  });

  describe('pane split / close routes', () => {
    it('POST /panes/split splits with the pane cwd and returns the new id', async () => {
      const cmds = { ...baseCommands, paneCurrentPath: vi.fn(async () => '/home/u/proj'), splitPane: vi.fn(async () => '%91') };
      const res = await auth(request(appWith(cmds)).post('/api/panes/split')).send({ pane: '%1', dir: 'h' }).expect(201);
      expect(res.body).toEqual({ id: '%91' });
      expect(cmds.splitPane).toHaveBeenCalledWith('%1', 'h', '/home/u/proj');
    });

    it('POST /panes/split rejects a bad pane id', async () => {
      const cmds = { ...baseCommands };
      await auth(request(appWith(cmds)).post('/api/panes/split')).send({ pane: 'nope', dir: 'h' }).expect(400);
      expect(cmds.splitPane).not.toHaveBeenCalled();
    });

    it('POST /panes/split rejects a bad direction', async () => {
      const cmds = { ...baseCommands };
      await auth(request(appWith(cmds)).post('/api/panes/split')).send({ pane: '%1', dir: 'diag' }).expect(400);
      expect(cmds.splitPane).not.toHaveBeenCalled();
    });

    it('DELETE /panes kills a non-last pane', async () => {
      const cmds = { ...baseCommands, windowPaneCount: vi.fn(async () => 2), killPane: vi.fn(async () => {}) };
      await auth(request(appWith(cmds)).delete('/api/panes?pane=%2')).expect(204);
      expect(cmds.killPane).toHaveBeenCalledWith('%2');
    });

    it('DELETE /panes refuses the last pane (409) and does not kill', async () => {
      const cmds = { ...baseCommands, windowPaneCount: vi.fn(async () => 1), killPane: vi.fn(async () => {}) };
      await auth(request(appWith(cmds)).delete('/api/panes?pane=%2')).expect(409);
      expect(cmds.killPane).not.toHaveBeenCalled();
    });

    it('DELETE /panes rejects a bad pane id', async () => {
      await auth(request(appWith(baseCommands)).delete('/api/panes?pane=nope')).expect(400);
    });
  });
});

function appWithDocs(commands, docs) {
  const app = express();
  app.use('/api', createApiRouter({ token: 'good', commands, docs }));
  return app;
}

describe('POST /sessions with cwd', () => {
  it('validates and passes a picked cwd to newSession', async () => {
    const cmds = { ...baseCommands, newSession: vi.fn(async () => '$7') };
    const docs = { resolveCwd: vi.fn(async () => ({ real: '/home/u/proj' })) };
    await auth(request(appWithDocs(cmds, docs)).post('/api/sessions').send({ name: 'web', cwd: '/home/u/proj' })).expect(201);
    expect(docs.resolveCwd).toHaveBeenCalledWith('/home/u/proj');
    expect(cmds.newSession).toHaveBeenCalledWith('web', '/home/u/proj', undefined);
  });
  it('rejects an invalid cwd without creating', async () => {
    const cmds = { ...baseCommands, newSession: vi.fn(async () => '$7') };
    const docs = { resolveCwd: vi.fn(async () => ({ error: 'outside home', status: 400 })) };
    await auth(request(appWithDocs(cmds, docs)).post('/api/sessions').send({ name: 'web', cwd: '/etc' })).expect(400);
    expect(cmds.newSession).not.toHaveBeenCalled();
  });
  it('creates with no cwd (old behavior) when none given', async () => {
    const cmds = { ...baseCommands, newSession: vi.fn(async () => '$7') };
    await auth(request(appWith(cmds)).post('/api/sessions').send({ name: 'web' })).expect(201);
    expect(cmds.newSession).toHaveBeenCalledWith('web', undefined, undefined);
  });
});

describe('POST /windows with cwd', () => {
  it('validates and passes a picked cwd to newWindow', async () => {
    const cmds = { ...baseCommands, newWindow: vi.fn(async () => '@9'), paneCurrentPath: vi.fn(async () => '/home/u/proj') };
    const docs = { resolveCwd: vi.fn(async () => ({ real: '/home/u/sub' })) };
    await auth(request(appWithDocs(cmds, docs)).post('/api/windows').send({ session: '$0', pane: '%1', name: 'build-1', cwd: '/home/u/sub' })).expect(201);
    expect(cmds.newWindow).toHaveBeenCalledWith('$0', '/home/u/sub', 'build-1', undefined);
    expect(cmds.paneCurrentPath).not.toHaveBeenCalled();
  });
  it('falls back to pane cwd when none given', async () => {
    const cmds = { ...baseCommands, newWindow: vi.fn(async () => '@9'), paneCurrentPath: vi.fn(async () => '/home/u/proj') };
    await auth(request(appWith(cmds)).post('/api/windows').send({ session: '$0', pane: '%1' })).expect(201);
    expect(cmds.newWindow).toHaveBeenCalledWith('$0', '/home/u/proj', undefined, undefined);
  });
  it('rejects an invalid cwd without creating', async () => {
    const cmds = { ...baseCommands, newWindow: vi.fn(async () => '@9') };
    const docs = { resolveCwd: vi.fn(async () => ({ error: 'not a directory', status: 400 })) };
    await auth(request(appWithDocs(cmds, docs)).post('/api/windows').send({ session: '$0', pane: '%1', cwd: '/home/u/x' })).expect(400);
    expect(cmds.newWindow).not.toHaveBeenCalled();
  });
});

describe('docs routes', () => {
  function appWithDocs(docs) {
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands, docs }));
    return app;
  }

  it('GET /file returns the doc + mtimeMs on success (no mtime param → knownMtime null)', async () => {
    const docs = { readDoc: vi.fn(async () => ({ name: 'a.md', type: 'markdown', content: '# x', mtimeMs: 42 })), listDir: vi.fn() };
    const res = await auth(request(appWithDocs(docs)).get('/api/file?path=/home/u/a.md')).expect(200);
    expect(res.body).toEqual({ name: 'a.md', type: 'markdown', content: '# x', mtimeMs: 42 });
    expect(docs.readDoc).toHaveBeenCalledWith('/home/u/a.md', null);
  });

  it('GET /file?mtime= passes the known mtime and returns notModified without content', async () => {
    const docs = { readDoc: vi.fn(async () => ({ name: 'a.md', type: 'markdown', mtimeMs: 99, notModified: true })), listDir: vi.fn() };
    const res = await auth(request(appWithDocs(docs)).get('/api/file?path=/home/u/a.md&mtime=99')).expect(200);
    expect(res.body).toEqual({ name: 'a.md', type: 'markdown', mtimeMs: 99, notModified: true });
    expect(res.body.content).toBeUndefined();
    expect(docs.readDoc).toHaveBeenCalledWith('/home/u/a.md', 99);
  });

  it('GET /file maps the error status from the docs layer', async () => {
    const docs = { readDoc: vi.fn(async () => ({ error: 'not found', status: 404 })), listDir: vi.fn() };
    await auth(request(appWithDocs(docs)).get('/api/file?path=/home/u/nope.md')).expect(404);
  });

  it('GET /dir returns a listing and defaults path to empty string', async () => {
    const docs = { readDoc: vi.fn(), listDir: vi.fn(async () => ({ path: '/home/u', home: '/home/u', parent: null, entries: [] })) };
    const res = await auth(request(appWithDocs(docs)).get('/api/dir')).expect(200);
    expect(res.body.parent).toBeNull();
    expect(docs.listDir).toHaveBeenCalledWith('');
  });

  it('GET /dir maps the error status', async () => {
    const docs = { readDoc: vi.fn(), listDir: vi.fn(async () => ({ error: 'outside home', status: 400 })) };
    await auth(request(appWithDocs(docs)).get('/api/dir?path=/etc')).expect(400);
  });

  it('docs routes require auth', async () => {
    const docs = { readDoc: vi.fn(), listDir: vi.fn() };
    await request(appWithDocs(docs)).get('/api/file?path=/x.md').expect(401);
    await request(appWithDocs(docs)).get('/api/dir').expect(401);
  });
});

describe('POST /dir (mkdir)', () => {
  it('creates a directory and returns its path', async () => {
    const docs = { makeDir: vi.fn(async () => ({ real: '/home/u/proj/new' })) };
    const res = await auth(request(appWithDocs(baseCommands, docs)).post('/api/dir').send({ dir: '/home/u/proj', name: 'new' })).expect(201);
    expect(docs.makeDir).toHaveBeenCalledWith('/home/u/proj', 'new');
    expect(res.body).toMatchObject({ path: '/home/u/proj/new' });
  });
  it('propagates a validation error status', async () => {
    const docs = { makeDir: vi.fn(async () => ({ error: 'exists', status: 409 })) };
    await auth(request(appWithDocs(baseCommands, docs)).post('/api/dir').send({ dir: '/home/u', name: 'dup' })).expect(409);
  });
  it('400 when dir or name missing', async () => {
    const docs = { makeDir: vi.fn() };
    await auth(request(appWithDocs(baseCommands, docs)).post('/api/dir').send({ dir: '/home/u' })).expect(400);
    expect(docs.makeDir).not.toHaveBeenCalled();
  });
});

describe('claude events + push bound', () => {
  function appWithEvents(events) {
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands, events }));
    return app;
  }

  it('GET /states returns the pane state map (read from the hook state file by events.getStates)', async () => {
    const events = { getStates: async () => ({ '%1': { session: 'proj', kind: 'idle' } }) };
    const res = await auth(request(appWithEvents(events)).get('/api/states')).expect(200);
    expect(res.body).toEqual({ '%1': { session: 'proj', kind: 'idle' } });
  });

  it('GET /states awaits an async getStates', async () => {
    const events = { getStates: async () => ({ '%1': { session: 's', window: '@1', kind: 'working' } }) };
    const res = await auth(request(appWithEvents(events)).get('/api/states')).expect(200);
    expect(res.body['%1'].kind).toBe('working');
  });

  it('GET /states passes ?sessions= as a session filter; omitted → null (all)', async () => {
    const getStates = vi.fn(async () => ({}));
    const events = { getStates };
    const app = appWithEvents(events);
    await auth(request(app).get('/api/states?sessions=alpha,beta')).expect(200);
    expect(getStates).toHaveBeenLastCalledWith(['alpha', 'beta']);
    await auth(request(app).get('/api/states?sessions=')).expect(200);  // present-but-empty → []
    expect(getStates).toHaveBeenLastCalledWith([]);
    await auth(request(app).get('/api/states')).expect(200);            // omitted → null
    expect(getStates).toHaveBeenLastCalledWith(null);
  });
});

describe('previews API', () => {
  const fakePreviews = (over = {}) => ({
    register: vi.fn(async () => ({ name: 'foo', kind: 'static', expiresAt: 42 })),
    list: vi.fn(() => [{ name: 'foo', kind: 'static', dir: '/home/u/site', expiresAt: 42 }]),
    remove: vi.fn(),
    ...over,
  });
  const appPv = (previews, previewDomain) => {
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands, previews, previewDomain }));
    return app;
  };

  it('POST {name,dir} returns a static path url', async () => {
    const pv = fakePreviews();
    const res = await auth(request(appPv(pv)).post('/api/previews')).send({ name: 'foo', dir: '/home/u/site' }).expect(200);
    expect(res.body).toEqual({ name: 'foo', kind: 'static', url: '/preview/foo/?token=good', expiresAt: 42 });
    expect(pv.register).toHaveBeenCalledWith({ name: 'foo', dir: '/home/u/site' });
  });
  it('POST {name,port} returns a subdomain url (dynamic enabled)', async () => {
    const pv = fakePreviews({ register: vi.fn(async () => ({ name: 'app', kind: 'dynamic', expiresAt: 99 })) });
    const res = await auth(request(appPv(pv, 'preview.example.com')).post('/api/previews')).send({ name: 'app', port: 3000 }).expect(200);
    expect(res.body).toEqual({ name: 'app', kind: 'dynamic', url: 'https://app.preview.example.com/?token=good', expiresAt: 99 });
    expect(pv.register).toHaveBeenCalledWith({ name: 'app', port: 3000 });
  });
  it('POST forwards an HTTPS loopback protocol to the registry', async () => {
    const pv = fakePreviews({ register: vi.fn(async () => ({ name: 'app', kind: 'dynamic', expiresAt: 99 })) });
    await auth(request(appPv(pv, 'preview.example.com')).post('/api/previews'))
      .send({ name: 'app', port: 8443, protocol: 'https' }).expect(200);
    expect(pv.register).toHaveBeenCalledWith({ name: 'app', port: 8443, protocol: 'https' });
  });
  it('POST maps a registry error to its status', async () => {
    const pv = fakePreviews({ register: vi.fn(async () => ({ error: 'outside home', status: 400 })) });
    await auth(request(appPv(pv)).post('/api/previews')).send({ name: 'foo', dir: '/etc' }).expect(400);
  });
  it('POST 400s when neither dir nor port is given', async () => {
    await auth(request(appPv(fakePreviews())).post('/api/previews')).send({ name: 'foo' }).expect(400);
  });
  it('GET lists active + reports dynamicEnabled/domain', async () => {
    const res = await auth(request(appPv(fakePreviews(), 'preview.example.com')).get('/api/previews')).expect(200);
    expect(res.body).toEqual({
      previews: [{ name: 'foo', kind: 'static', dir: '/home/u/site', expiresAt: 42 }],
      dynamicEnabled: true, domain: 'preview.example.com',
    });
  });
  it('GET reports dynamic disabled when no domain', async () => {
    const res = await auth(request(appPv(fakePreviews())).get('/api/previews')).expect(200);
    expect(res.body.dynamicEnabled).toBe(false);
    expect(res.body.domain).toBeNull();
  });
  it('DELETE /previews/:name removes', async () => {
    const pv = fakePreviews();
    await auth(request(appPv(pv)).delete('/api/previews/foo')).expect(204);
    expect(pv.remove).toHaveBeenCalledWith('foo');
  });
  it('503 when previews not configured', async () => {
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands }));
    await auth(request(app).get('/api/previews')).expect(503);
  });
  it('DELETE /previews/:name 400s a malformed name', async () => {
    const pv = fakePreviews();
    await auth(request(appPv(pv)).delete('/api/previews/..%2Ffoo')).expect(400);
    expect(pv.remove).not.toHaveBeenCalled();
  });
});

describe('git viewer routes', () => {
  const appWithGit = (git) => {
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands, git }));
    return app;
  };

  it('GET /git/repos returns the detected repos', async () => {
    const git = { detectRepos: vi.fn(async () => ({ repos: [{ name: 'proj', path: '/h/proj', branch: 'main', dirty: false }] })) };
    const res = await auth(request(appWithGit(git)).get('/api/git/repos?dir=/h')).expect(200);
    expect(res.body.repos[0].name).toBe('proj');
    expect(git.detectRepos).toHaveBeenCalledWith('/h');
  });

  it('GET /git/repos maps the error status from the git layer', async () => {
    const git = { detectRepos: vi.fn(async () => ({ error: 'outside home', status: 400 })) };
    const res = await auth(request(appWithGit(git)).get('/api/git/repos?dir=/etc')).expect(400);
    expect(res.body.error).toBe('outside home');
  });

  it('GET /git/status returns the changes', async () => {
    const git = { status: vi.fn(async () => ({ changes: [{ path: 'a.js', code: 'M' }] })) };
    const res = await auth(request(appWithGit(git)).get('/api/git/status?repo=/h/proj')).expect(200);
    expect(res.body.changes[0].path).toBe('a.js');
    expect(git.status).toHaveBeenCalledWith('/h/proj');
  });

  it('GET /git/log passes the limit through and returns commits', async () => {
    const git = { log: vi.fn(async () => ({ commits: [{ hash: 'abc', subject: 'init' }] })) };
    const res = await auth(request(appWithGit(git)).get('/api/git/log?repo=/h/proj&limit=10')).expect(200);
    expect(res.body.commits[0].hash).toBe('abc');
    expect(git.log).toHaveBeenCalledWith('/h/proj', '10', undefined);
  });

  it('GET /git/log forwards the ref (read-only branch view)', async () => {
    const git = { log: vi.fn(async () => ({ commits: [] })) };
    await auth(request(appWithGit(git)).get('/api/git/log?repo=/h/proj&ref=feature')).expect(200);
    expect(git.log).toHaveBeenCalledWith('/h/proj', undefined, 'feature');
  });

  it('GET /git/branches returns the branches', async () => {
    const git = { branches: vi.fn(async () => ({ branches: ['main', 'dev'] })) };
    const res = await auth(request(appWithGit(git)).get('/api/git/branches?repo=/h/proj')).expect(200);
    expect(res.body.branches).toEqual(['main', 'dev']);
  });

  it('GET /git/diff forwards path/commit/staged options', async () => {
    const git = { diff: vi.fn(async () => ({ diff: '@@ -1 +1 @@', truncated: false })) };
    const res = await auth(request(appWithGit(git)).get('/api/git/diff?repo=/h/proj&path=a.js&commit=abc&staged=1')).expect(200);
    expect(res.body).toEqual({ diff: '@@ -1 +1 @@', truncated: false });
    expect(git.diff).toHaveBeenCalledWith('/h/proj', { path: 'a.js', commit: 'abc', staged: true });
  });

  it('GET /git/diff defaults commit→undefined and staged→false', async () => {
    const git = { diff: vi.fn(async () => ({ diff: '', truncated: false })) };
    await auth(request(appWithGit(git)).get('/api/git/diff?repo=/h/proj&path=a.js')).expect(200);
    expect(git.diff).toHaveBeenCalledWith('/h/proj', { path: 'a.js', commit: undefined, staged: false });
  });

  it('GET /git/commit returns the commit message + files', async () => {
    const git = { commit: vi.fn(async () => ({ message: 'init', files: ['a.js'] })) };
    const res = await auth(request(appWithGit(git)).get('/api/git/commit?repo=/h/proj&hash=abc')).expect(200);
    expect(res.body).toEqual({ message: 'init', files: ['a.js'] });
    expect(git.commit).toHaveBeenCalledWith('/h/proj', 'abc');
  });

  it('git routes require auth', async () => {
    const git = { detectRepos: vi.fn() };
    await request(appWithGit(git)).get('/api/git/repos?dir=/h').expect(401);
  });
});

describe('GET /api/asr/sign', () => {
  it('503 when XFYUN env is not configured', async () => {
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands, asrEnv: {} }));
    await request(app).get('/api/asr/sign').set('Authorization', 'Bearer good').expect(503);
  });

  it('returns a signed wss url + appId when configured', async () => {
    // The secret is a long distinctive sentinel, NOT a 2-char value: the leak-check below scans the whole
    // response for it, and a short string (e.g. 'S1') collides by chance with the base64 signature ~3% of
    // the time (random base64 contains "S1"), which made this test flaky. A long sentinel can't collide.
    const asrEnv = { XFYUN_APPID: 'A1', XFYUN_APIKEY: 'K1', XFYUN_APISECRET: 'topsecret-DO-NOT-LEAK' };
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands, asrEnv }));
    const res = await request(app).get('/api/asr/sign').set('Authorization', 'Bearer good').expect(200);
    expect(res.body.appId).toBe('A1');
    const u = new URL(res.body.url);
    expect(u.protocol).toBe('wss:');
    expect(u.pathname).toBe('/v2/iat');
    expect(u.searchParams.get('authorization')).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('topsecret-DO-NOT-LEAK'); // apiSecret never crosses the wire
  });
});

describe('GET /api/config (capabilities)', () => {
  it('reports asr:false when XFYUN env is not configured', async () => {
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands, asrEnv: {} }));
    const res = await request(app).get('/api/config').set('Authorization', 'Bearer good').expect(200);
    expect(res.body.asr).toBe(false);
  });
  it('reports asr:true when configured', async () => {
    const asrEnv = { XFYUN_APPID: 'A1', XFYUN_APIKEY: 'K1', XFYUN_APISECRET: 'S1' };
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands, asrEnv }));
    const res = await request(app).get('/api/config').set('Authorization', 'Bearer good').expect(200);
    expect(res.body.asr).toBe(true);
  });
  it('returns the server-owned mandatory shortcuts', async () => {
    const shortcuts = {
      command: [{ type: 'text', text: 'pwd', enter: true }],
      chat: [{ type: 'key', key: 'Escape', label: 'Esc' }],
    };
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands, asrEnv: {}, shortcuts }));
    const res = await request(app).get('/api/config').set('Authorization', 'Bearer good').expect(200);
    expect(res.body.shortcuts).toEqual(shortcuts);
  });
  it('updates the in-memory shortcuts without restarting the server', async () => {
    const initial = { command: [], chat: [{ type: 'text', text: 'old', enter: true }] };
    const updated = {
      command: [{ type: 'key', key: 'Escape', label: 'Esc' }],
      chat: [{ type: 'text', text: 'new', enter: false }],
    };
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands, shortcuts: initial }));

    await request(app).put('/api/config/shortcuts').set('Authorization', 'Bearer good')
      .send({ shortcuts: updated }).expect(200, { ok: true });
    const res = await request(app).get('/api/config').set('Authorization', 'Bearer good').expect(200);
    expect(res.body.shortcuts).toEqual(updated);
  });
  it('rejects invalid live shortcuts without replacing the last good value', async () => {
    const initial = { command: [], chat: [{ type: 'text', text: 'old', enter: true }] };
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands, shortcuts: initial }));

    await request(app).put('/api/config/shortcuts').set('Authorization', 'Bearer good')
      .send({ shortcuts: { command: 'bad', chat: [] } }).expect(400);
    const res = await request(app).get('/api/config').set('Authorization', 'Bearer good').expect(200);
    expect(res.body.shortcuts).toEqual(initial);
  });

  it('requires auth to replace live shortcuts', async () => {
    await request(appWith(baseCommands)).put('/api/config/shortcuts')
      .send({ shortcuts: { command: [], chat: [] } }).expect(401);
  });
});

describe('claude hooks API', () => {
  // A fresh temp $HOME WITH a .claude dir (but no hooks) — installHooks refuses to create ~/.claude,
  // so the dir must already exist for status to move from 'no-claude' → 'absent' → 'installed'.
  function homeWithClaude() {
    const home = tmpHome('twapi-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    return home;
  }
  // Build the app the same inline way the /config capability tests do, forwarding home + stateFile.
  function makeApp({ home, stateFile }) {
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands, home, stateFile }));
    return app;
  }

  it('GET /api/config includes claudeHooks status (absent on a fresh .claude)', async () => {
    const home = homeWithClaude();
    const app = makeApp({ home, stateFile: path.join(home, '.handmux/claude-state.json') });
    const res = await request(app).get('/api/config').set('Authorization', 'Bearer good').expect(200);
    expect(res.body.claudeHooks).toBe('absent');
  });

  it('POST /api/hooks/install installs and flips status to installed', async () => {
    const home = homeWithClaude();
    const app = makeApp({ home, stateFile: path.join(home, '.handmux/claude-state.json') });
    const res = await request(app).post('/api/hooks/install').set('Authorization', 'Bearer good').expect(200);
    expect(res.body).toMatchObject({ ok: true, status: 'installed' });
    const s = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
    expect(s.hooks.Stop[0].hooks[0].command).toContain('handmux-notify.sh');
  });

  it('POST /api/hooks/install requires auth', async () => {
    const app = makeApp({ home: homeWithClaude() });
    await request(app).post('/api/hooks/install').expect(401);
  });
});

describe('orphans routes', () => {
  // GET runs the real process scan (read-only, may be empty) — assert only shape. The takeover
  // bad-input paths reject BEFORE any tmux spawn/kill, so they're safe to exercise on a live host.
  const app = appWith(baseCommands);

  it('GET /api/orphans returns an array', async () => {
    const res = await auth(request(app).get('/api/orphans')).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/orphans requires auth', async () => {
    await request(app).get('/api/orphans').expect(401);
  });

  it('POST /api/orphans/takeover rejects a non-UUID sessionId (injection guard)', async () => {
    await auth(request(app).post('/api/orphans/takeover'))
      .send({ pid: 4717, sessionId: 'x; rm -rf ~' }).expect(400);
  });

  it('POST /api/orphans/takeover 409s for a pid that is not a live orphan', async () => {
    await auth(request(app).post('/api/orphans/takeover'))
      .send({ pid: 2147483000, sessionId: '4442e3d0-8d46-4cce-9822-b86558f69922' }).expect(409);
  });
});

describe('GET /version (update hint)', () => {
  const appWithHome = (home) => {
    const app = express();
    app.use('/api', createApiRouter({ token: 'good', commands: baseCommands, home }));
    return app;
  };
  // Fresh cache (checkedAt: now) so the route never spawns a real `npm view` during the test.
  it('flags an available update when the cached npm latest is ahead of the installed version', async () => {
    const home = tmpHome('ver-');
    writeCache(home, { checkedAt: Date.now(), latest: '999.0.0' });
    const res = await auth(request(appWithHome(home)).get('/api/version')).expect(200);
    expect(res.body).toMatchObject({ latest: '999.0.0', updateAvailable: true });
    expect(typeof res.body.current).toBe('string');
  });
  it('reports no update when the cached latest is not newer', async () => {
    const home = tmpHome('ver-');
    writeCache(home, { checkedAt: Date.now(), latest: '0.0.1' });
    const res = await auth(request(appWithHome(home)).get('/api/version')).expect(200);
    expect(res.body.updateAvailable).toBe(false);
    expect(res.body.whatsNew).toEqual([]);
  });
  it('returns whatsNew trimmed to versions strictly newer than the installed one', async () => {
    const home = tmpHome('ver-');
    const wn = [
      { version: '999.0.0', date: '2099-01-01', zh: '新', en: 'New' },
      { version: '0.0.1', date: '2020-01-01', zh: '旧', en: 'Old' }, // older than installed → dropped
    ];
    writeCache(home, { checkedAt: Date.now(), latest: '999.0.0', whatsNew: wn });
    const res = await auth(request(appWithHome(home)).get('/api/version')).expect(200);
    expect(res.body.whatsNew).toEqual([wn[0]]);
  });
});
