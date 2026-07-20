import { describe, it, expect, beforeEach } from 'vitest';
import { loadFavs, saveFavs, addFav, removeFav, moveFav, cmdScope, CMD_GLOBAL, DEFAULT_FAVS } from '../src/favStore.js';

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
    expect(JSON.parse(localStorage.getItem('hm_favs7_agent'))).toEqual(loadFavs('agent'));
  });
  it('addFav carries the enter flag (a with-Enter command runs on tap)', () => {
    const next = addFav('command', { kind: 'cmd', text: 'make', enter: true });
    expect(next.at(-1).enter).toBe(true);
  });
  it('moveFav swaps an item with its neighbour; no-op at the ends', () => {
    saveFavs('command', [{ kind: 'cmd', text: 'a' }, { kind: 'cmd', text: 'b' }, { kind: 'cmd', text: 'c' }]);
    expect(moveFav('command', 'b', -1).map((f) => f.text)).toEqual(['b', 'a', 'c']); // up
    // moveFav re-reads from storage each call, so operate on the persisted order.
    expect(moveFav('command', 'a', 1).map((f) => f.text)).toEqual(['b', 'c', 'a']);  // down
    expect(moveFav('command', 'b', -1).map((f) => f.text)).toEqual(['b', 'c', 'a']); // top, up → no-op
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
  it('the two modes are independent', () => {
    addFav('command', { kind: 'cmd', text: 'git status' });
    expect(loadFavs('agent').find((f) => f.text === 'git status')).toBeUndefined();
  });
});
