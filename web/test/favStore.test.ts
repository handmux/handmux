import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadFavs, saveFavs, addFav, removeFav, moveFav,
  moveFavBeside, moveFavBesideByIdentity, removeFavByIdentity,
  addFavResult, updateFavResult, transferFavResult,
  cmdScope, CMD_GLOBAL, DEFAULT_FAVS,
} from '../src/favStore.js';
import { shortcutIdentity } from '../src/shortcutMerge.js';

beforeEach(() => localStorage.clear());

describe('favStore', () => {
  it('keeps local additions empty by default because built-ins now come from server presets', () => {
    expect(DEFAULT_FAVS.agent).toEqual([]);
    expect(DEFAULT_FAVS.command).toEqual([]);
  });
  it('loadFavs returns an empty local list on first run, then persists edits', () => {
    expect(loadFavs('agent')).toEqual(DEFAULT_FAVS.agent);
    const next = addFav('command', { kind: 'cmd', text: 'npm test' });
    expect(next.at(-1)).toEqual({ kind: 'cmd', text: 'npm test', enter: false });
    expect(loadFavs('command')).toEqual(next); // persisted
  });
  it('filters malformed v7 storage records at the localStorage boundary', () => {
    localStorage.setItem('hm_favs7_command', JSON.stringify([
      { kind: 'cmd', text: 'valid', enter: true },
      { kind: 'cmd', text: 42 },
      { kind: 'unknown', text: 'bad' },
      null,
    ]));
    expect(loadFavs('command')).toEqual([
      { kind: 'cmd', text: 'valid', enter: true },
    ]);
  });
  it('migrates v6 chat items to v7 with their historical tap behavior preserved', () => {
    localStorage.setItem('hm_favs6_agent', JSON.stringify([
      { kind: 'reply', text: 'ok', enter: false },
      { kind: 'cmd', text: '/compact' },
      { kind: 'reply', text: 'ESC' },
    ]));
    expect(loadFavs('agent')).toEqual([
      { kind: 'reply', text: 'ok', enter: true },
      { kind: 'cmd', text: '/compact', enter: true },
      { kind: 'key', text: 'Escape', label: 'Esc' },
    ]);
    expect(JSON.parse(localStorage.getItem('hm_favs7_agent')!)).toEqual(loadFavs('agent'));
  });
  it('infers the kind for earliest v6 text-only chat records', () => {
    localStorage.setItem('hm_favs6_agent', JSON.stringify([
      { text: '继续' },
      { text: '/compact' },
    ]));
    expect(loadFavs('agent')).toEqual([
      { kind: 'reply', text: '继续', enter: true },
      { kind: 'cmd', text: '/compact', enter: true },
    ]);
  });
  it('addFav carries the enter flag (a with-Enter command runs on tap)', () => {
    const next = addFav('command', { kind: 'cmd', text: 'make', enter: true });
    expect(next.at(-1)?.enter).toBe(true);
  });
  it('moveFav swaps an item with its neighbour; no-op at the ends', () => {
    saveFavs('command', [{ kind: 'cmd', text: 'a' }, { kind: 'cmd', text: 'b' }, { kind: 'cmd', text: 'c' }]);
    expect(moveFav('command', 'b', -1).map((f) => f.text)).toEqual(['b', 'a', 'c']); // up
    // moveFav re-reads from storage each call, so operate on the persisted order.
    expect(moveFav('command', 'a', 1).map((f) => f.text)).toEqual(['b', 'c', 'a']);  // down
    expect(moveFav('command', 'b', -1).map((f) => f.text)).toEqual(['b', 'c', 'a']); // top, up → no-op
  });
  it('moveFavBeside swaps visible neighbours even when a hidden duplicate sits between them', () => {
    saveFavs('command@w', [
      { kind: 'cmd', text: 'B' },
      { kind: 'cmd', text: 'global-duplicate' },
      { kind: 'cmd', text: 'C' },
    ]);
    expect(moveFavBeside('command@w', 'C', 'B').map((f) => f.text))
      .toEqual(['C', 'global-duplicate', 'B']);
  });
  it('global and per-window command lists are separate scopes', () => {
    expect(cmdScope(null)).toBe(CMD_GLOBAL);
    addFav(CMD_GLOBAL, { kind: 'cmd', text: 'global-cmd' });
    addFav(cmdScope('@7'), { kind: 'cmd', text: 'win-cmd' });
    expect(loadFavs(CMD_GLOBAL).find((f) => f.text === 'win-cmd')).toBeUndefined();
    expect(loadFavs(cmdScope('@7')).find((f) => f.text === 'global-cmd')).toBeUndefined();
  });
  it('addFav dedupes by text; removeFav removes by text', () => {
    addFav('command', { kind: 'cmd', text: 'ls' });
    const dup = addFav('command', { kind: 'cmd', text: 'ls' });
    expect(dup.filter((f) => f.text === 'ls')).toHaveLength(1);
    const after = removeFav('command', 'ls');
    expect(after.find((f) => f.text === 'ls')).toBeUndefined();
  });
  it('reports add/update conflicts without changing the stored list', () => {
    saveFavs('command', [
      { kind: 'cmd', text: 'one', enter: false },
      { kind: 'cmd', text: 'two', enter: true },
    ]);
    expect(addFavResult('command', { kind: 'cmd', text: 'two', enter: true }))
      .toMatchObject({ ok: false, reason: 'conflict' });
    expect(updateFavResult('command', 'text:one:no-enter', { kind: 'cmd', text: 'two', enter: true }))
      .toMatchObject({ ok: false, reason: 'conflict' });
    expect(loadFavs('command')).toEqual([
      { kind: 'cmd', text: 'one', enter: false },
      { kind: 'cmd', text: 'two', enter: true },
    ]);
  });
  it.each([
    ['command', 'command@w'],
    ['command@w', 'command'],
  ])('reports a %s → %s transfer conflict without deleting either scope', (source, target) => {
    saveFavs(source, [{ kind: 'cmd', text: 'source', enter: false }]);
    saveFavs(target, [{ kind: 'cmd', text: 'taken', enter: true }]);
    expect(transferFavResult(source, 'text:source:no-enter', target, { kind: 'cmd', text: 'taken', enter: true }))
      .toMatchObject({ ok: false, reason: 'conflict' });
    expect(loadFavs(source).map((f) => f.text)).toEqual(['source']);
    expect(loadFavs(target).map((f) => f.text)).toEqual(['taken']);
  });
  it('treats the same text with different Enter behavior as separate local actions', () => {
    expect(addFavResult('command', { kind: 'cmd', text: 'ok', enter: false })).toMatchObject({ ok: true });
    expect(addFavResult('command', { kind: 'cmd', text: 'ok', enter: true })).toMatchObject({ ok: true });
    expect(loadFavs('command').map(shortcutIdentity))
      .toEqual(['text:ok:no-enter', 'text:ok:enter']);
  });
  it('updates and transfers the exact identity when same-text actions coexist', () => {
    saveFavs('command', [
      { kind: 'cmd', text: 'ok', enter: false },
      { kind: 'cmd', text: 'ok', enter: true },
    ]);
    expect(updateFavResult('command', 'text:ok:no-enter', { kind: 'cmd', text: 'draft', enter: false }))
      .toMatchObject({ ok: true });
    expect(loadFavs('command').map(shortcutIdentity))
      .toEqual(['text:draft:no-enter', 'text:ok:enter']);
    expect(transferFavResult('command', 'text:ok:enter', 'command@w', {
      kind: 'cmd', text: 'ok', enter: true,
    })).toMatchObject({ ok: true });
    expect(loadFavs('command').map(shortcutIdentity)).toEqual(['text:draft:no-enter']);
    expect(loadFavs('command@w').map(shortcutIdentity)).toEqual(['text:ok:enter']);
  });
  it('moves and removes exact same-text actions without touching their sibling identity', () => {
    saveFavs('command@w', [
      { kind: 'cmd', text: 'ok', enter: false },
      { kind: 'cmd', text: 'middle', enter: false },
      { kind: 'cmd', text: 'ok', enter: true },
    ]);
    const moved = moveFavBesideByIdentity(
      'command@w', 'text:ok:enter', 'text:ok:no-enter',
    );
    expect(moved.map(shortcutIdentity))
      .toEqual(['text:ok:enter', 'text:middle:no-enter', 'text:ok:no-enter']);
    const removed = removeFavByIdentity('command@w', 'text:ok:enter');
    expect(removed.map(shortcutIdentity))
      .toEqual(['text:middle:no-enter', 'text:ok:no-enter']);
  });
  it('the two modes are independent', () => {
    addFav('command', { kind: 'cmd', text: 'git status' });
    expect(loadFavs('agent').find((f) => f.text === 'git status')).toBeUndefined();
  });
});
