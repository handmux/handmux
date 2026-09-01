import { describe, it, expect, beforeEach } from 'vitest';
import {
  getToken, setToken,
  getLastSession, getLastWindow, getLastPane, remember,
  getBoundSessions, addBoundSession, removeBoundSession, renameBoundSession,
  getFavorites, addFavorite, removeFavorite, getRecent, pushRecent, removeRecent,
  getInboxSeen, markInboxSeen,
  getInboxReadTs, setInboxReadTs,
  getProjectTaskBeta, setProjectTaskBeta, getRootView, setRootView, getLastProject, setLastProject,
} from '../src/storage.js';
import {
  getRecentDocs, pushRecentDoc, removeRecentDoc, getPaneBase, setPaneBase,
  getBrowseDir, setBrowseDir,
  getIdeas, setIdeas, renameWindowIdeas,
  getGitRepos, addGitRepos,
} from '../src/storage.js';

beforeEach(() => localStorage.clear());

describe('browse dir per window (tw_browse_dir)', () => {
  it('remembers a dir per window and returns null when unset', () => {
    expect(getBrowseDir('@1')).toBe(null);
    setBrowseDir('@1', '/home/u/proj');
    setBrowseDir('@2', '/home/u/other');
    expect(getBrowseDir('@1')).toBe('/home/u/proj');
    expect(getBrowseDir('@2')).toBe('/home/u/other');
    expect(getBrowseDir('@3')).toBe(null);
  });
  it('ignores empty window id or path (no throw, no write)', () => {
    setBrowseDir(null, '/x');
    setBrowseDir('@1', '');
    expect(getBrowseDir(null)).toBe(null);
    expect(getBrowseDir('@1')).toBe(null);
  });
});

describe('ideas per window (tw_ideas)', () => {
  const a = { id: '1', text: 'a' };
  const b = { id: '2', text: 'b' };
  it('reads empty for unset session/window and ignores missing keys', () => {
    expect(getIdeas('s', 'w')).toEqual([]);
    expect(getIdeas(null, 'w')).toEqual([]);
    expect(getIdeas('s', null)).toEqual([]);
  });
  it('writes and reads a list scoped per session+window', () => {
    setIdeas('s1', 'w1', [a, b]);
    setIdeas('s1', 'w2', [a]);
    setIdeas('s2', 'w1', [b]);
    expect(getIdeas('s1', 'w1')).toEqual([a, b]);
    expect(getIdeas('s1', 'w2')).toEqual([a]);
    expect(getIdeas('s2', 'w1')).toEqual([b]);
    expect(getIdeas('s1', 'w9')).toEqual([]);
  });
  it('emptying a window drops its key (and an emptied session)', () => {
    setIdeas('s1', 'w1', [a]);
    setIdeas('s1', 'w1', []);
    expect(getIdeas('s1', 'w1')).toEqual([]);
    expect(JSON.parse(localStorage.getItem('tw_ideas'))).toEqual({});
  });
  it('renameWindowIdeas moves a window\'s ideas to the new name', () => {
    setIdeas('s1', 'old', [a, b]);
    renameWindowIdeas('s1', 'old', 'new');
    expect(getIdeas('s1', 'old')).toEqual([]);
    expect(getIdeas('s1', 'new')).toEqual([a, b]);
  });
  it('renameBoundSession carries ideas to the new session name', () => {
    addBoundSession('old');
    setIdeas('old', 'w1', [a]);
    renameBoundSession('old', 'new');
    expect(getIdeas('old', 'w1')).toEqual([]);
    expect(getIdeas('new', 'w1')).toEqual([a]);
  });
});

describe('storage', () => {
  it('keeps Project Task beta off by default and remembers each Project root choice explicitly', () => {
    expect(getProjectTaskBeta()).toBe(false);
    expect(getRootView()).toBe('session');
    expect(getLastProject()).toBe(null);
    setProjectTaskBeta(true);
    setRootView('project');
    setLastProject('project-1');
    expect(getProjectTaskBeta()).toBe(true);
    expect(getRootView()).toBe('project');
    expect(getLastProject()).toBe('project-1');
    setProjectTaskBeta(false);
    expect(getProjectTaskBeta()).toBe(false);
  });

  it('stores and reads token', () => {
    expect(getToken()).toBe(null);
    setToken('abc');
    expect(getToken()).toBe('abc');
  });

  it('remembers the last session, the last window per session, and the last pane per window', () => {
    expect(getLastSession()).toBe(null);
    expect(getLastWindow('$0')).toBe(null);
    expect(getLastPane('@1')).toBe(null);

    remember({ sessionId: '$0', windowId: '@1', paneId: '%1' });
    expect(getLastSession()).toBe('$0');
    expect(getLastWindow('$0')).toBe('@1');
    expect(getLastPane('@1')).toBe('%1');
  });

  it('keeps a separate last window for each session and last pane for each window', () => {
    remember({ sessionId: '$0', windowId: '@1', paneId: '%1' });
    remember({ sessionId: '$1', windowId: '@9', paneId: '%9' });
    remember({ windowId: '@1', paneId: '%2' }); // re-open window @1 on a different pane

    expect(getLastWindow('$0')).toBe('@1');
    expect(getLastWindow('$1')).toBe('@9');
    expect(getLastPane('@1')).toBe('%2'); // updated
    expect(getLastPane('@9')).toBe('%9');
  });

  it('survives a corrupt map without throwing', () => {
    localStorage.setItem('tw_win', 'not json');
    expect(getLastWindow('$0')).toBe(null);
  });

  it('binds, dedupes, and unbinds session names', () => {
    expect(getBoundSessions()).toEqual([]);
    expect(addBoundSession('main')).toEqual(['main']);
    expect(addBoundSession('server')).toEqual(['main', 'server']);
    expect(addBoundSession('main')).toEqual(['main', 'server']); // no duplicate
    expect(getBoundSessions()).toEqual(['main', 'server']);
    expect(removeBoundSession('main')).toEqual(['server']);
    expect(getBoundSessions()).toEqual(['server']);
  });

  it('returns an empty list when the bound store is corrupt', () => {
    localStorage.setItem('tw_bound', 'not json');
    expect(getBoundSessions()).toEqual([]);
  });

  it('renames a bound session in place, carrying its recent history (position preserved)', () => {
    addBoundSession('main');
    addBoundSession('server');
    pushRecent('main', '@0', 'npm test');
    expect(renameBoundSession('main', 'prod')).toEqual(['prod', 'server']); // position kept
    expect(getBoundSessions()).toEqual(['prod', 'server']);
    expect(getRecent('prod', '@0')).toEqual(['npm test']); // recent (window-scoped) followed the rename
    expect(getRecent('main', '@0')).toEqual([]);            // old name cleared
  });

  // Regression: a LEGACY flat-array value under a per-window map key (tw_git_repos was once a global
  // array, before per-window keying) must not silently swallow writes. readMap used to JSON.parse the
  // array and return it as-is; writeMapEntry then set arr['@23']=… (a non-index property) which
  // JSON.stringify DROPS — so every git-repo write vanished and getGitRepos always returned []. The map
  // key must be treated as an object, ignoring the stale legacy array.
  it('does not let a legacy flat-array value swallow per-window writes (tw_git_repos)', () => {
    localStorage.setItem('tw_git_repos', JSON.stringify(['/old/global/repo']));
    expect(getGitRepos('@23')).toEqual([]);                 // legacy array is not a per-window map
    expect(addGitRepos('@23', ['/proj'])).toEqual(['/proj']);
    expect(getGitRepos('@23')).toEqual(['/proj']);          // the write actually persisted
    // and it round-trips through storage, not just the returned value
    expect(JSON.parse(localStorage.getItem('tw_git_repos'))['@23']).toEqual(['/proj']);
  });

  it('renameBoundSession is a no-op for an unknown name and copies nothing when there is no recent', () => {
    addBoundSession('main');
    expect(renameBoundSession('nope', 'prod')).toEqual(['main']);
    expect(renameBoundSession('main', 'prod')).toEqual(['prod']); // no recent to copy → fine
    expect(getRecent('prod', '@0')).toEqual([]);
  });

  it('adds, trims, dedupes, and removes favorites', () => {
    expect(getFavorites()).toEqual([]);
    expect(addFavorite('npm test')).toEqual(['npm test']);
    expect(addFavorite('git status')).toEqual(['npm test', 'git status']);
    expect(addFavorite('npm test')).toEqual(['npm test', 'git status']); // no duplicate
    expect(addFavorite('   ')).toEqual(['npm test', 'git status']);       // blank ignored
    expect(addFavorite('  ls  ')).toEqual(['npm test', 'git status', 'ls']); // trimmed
    expect(removeFavorite('npm test')).toEqual(['git status', 'ls']);
    expect(getFavorites()).toEqual(['git status', 'ls']);
  });

  it('records recent commands per session+window: dedupe-to-front, blank-skip, trim', () => {
    expect(getRecent('main', '@0')).toEqual([]);
    expect(pushRecent('main', '@0', 'a')).toEqual(['a']);
    expect(pushRecent('main', '@0', 'b')).toEqual(['b', 'a']);
    expect(pushRecent('main', '@0', 'a')).toEqual(['a', 'b']);        // re-send → front, no dup
    expect(pushRecent('main', '@0', '   ')).toEqual(['a', 'b']);       // blank not recorded
    expect(pushRecent('main', '@0', '  c ')).toEqual(['c', 'a', 'b']); // trimmed
  });

  it('caps recent at 30 per window, dropping the oldest', () => {
    for (let i = 0; i < 35; i += 1) pushRecent('main', '@0', `cmd${i}`);
    const list = getRecent('main', '@0');
    expect(list.length).toBe(30);
    expect(list[0]).toBe('cmd34');  // newest first
    expect(list[29]).toBe('cmd5');  // cmd0..cmd4 dropped
  });

  it('a legacy flat-array session value does NOT swallow window-scoped recent writes (survives restart)', () => {
    // Before recent became window-scoped it was flat: { [session]: string[] }. An upgraded user has a
    // legacy ARRAY under a session key; writing arr['@0']=… sets a non-index prop JSON.stringify drops,
    // so every send vanished on reload. The write must persist and round-trip through storage.
    localStorage.setItem('tw_recent', JSON.stringify({ main: ['old-flat'] }));
    expect(getRecent('main', '@0')).toEqual([]);                 // legacy array is not a per-window map
    expect(pushRecent('main', '@0', 'new')).toEqual(['new']);
    expect(getRecent('main', '@0')).toEqual(['new']);            // persisted, not swallowed
    expect(JSON.parse(localStorage.getItem('tw_recent')).main['@0']).toEqual(['new']); // round-trips
  });

  it('isolates recent by session AND window, and removes a single entry', () => {
    pushRecent('main', '@0', 'x');
    pushRecent('main', '@1', 'z');   // same session, different window → separate history
    pushRecent('server', '@0', 'y');
    expect(getRecent('main', '@0')).toEqual(['x']);
    expect(getRecent('main', '@1')).toEqual(['z']);
    expect(getRecent('server', '@0')).toEqual(['y']);
    expect(removeRecent('main', '@0', 'x')).toEqual([]);
    expect(getRecent('main', '@0')).toEqual([]);
    expect(getRecent('main', '@1')).toEqual(['z']); // sibling window untouched
    expect(getRecent('server', '@0')).toEqual(['y']); // other session untouched
  });
});

describe('recent docs', () => {
  it('pushes most-recent-first and dedupes by path', () => {
    pushRecentDoc({ path: '/h/a.md', name: 'a.md', type: 'markdown', ts: 1 });
    pushRecentDoc({ path: '/h/b.md', name: 'b.md', type: 'markdown', ts: 2 });
    pushRecentDoc({ path: '/h/a.md', name: 'a.md', type: 'markdown', ts: 3 }); // moves to front
    expect(getRecentDocs().map((d) => d.path)).toEqual(['/h/a.md', '/h/b.md']);
  });
  it('caps at 30 entries', () => {
    for (let i = 0; i < 35; i++) pushRecentDoc({ path: `/h/f${i}.md`, name: `f${i}.md`, type: 'markdown', ts: i });
    expect(getRecentDocs().length).toBe(30);
    expect(getRecentDocs()[0].path).toBe('/h/f34.md');
  });
  it('removes by path', () => {
    pushRecentDoc({ path: '/h/x.md', name: 'x.md', type: 'markdown', ts: 1 });
    removeRecentDoc('/h/x.md');
    expect(getRecentDocs().some((d) => d.path === '/h/x.md')).toBe(false);
  });
});

describe('pane base dir', () => {
  it('stores and reads a base dir per pane, null when unset', () => {
    expect(getPaneBase('%9')).toBeNull();
    setPaneBase('%9', '/home/u/proj');
    expect(getPaneBase('%9')).toBe('/home/u/proj');
  });
});

describe('inbox seen (tw_inbox_seen)', () => {
  beforeEach(() => localStorage.clear());
  it('starts empty', () => {
    expect(getInboxSeen()).toEqual({});
  });
  it('marks a pane and returns the updated map', () => {
    expect(markInboxSeen('%1', 100)).toEqual({ '%1': 100 });
    expect(markInboxSeen('%2', 200)).toEqual({ '%1': 100, '%2': 200 });
  });
  it('persists across reads and overwrites a pane in place', () => {
    markInboxSeen('%1', 100);
    markInboxSeen('%1', 300);
    expect(getInboxSeen()).toEqual({ '%1': 300 });
  });
});

describe('inbox read-ts (tw_inbox_read_ts)', () => {
  beforeEach(() => localStorage.clear());
  it('returns null when unset (distinct from 0)', () => {
    expect(getInboxReadTs()).toBeNull();
  });
  it('persists and reads back a number', () => {
    setInboxReadTs(1717000000000);
    expect(getInboxReadTs()).toBe(1717000000000);
  });
});
