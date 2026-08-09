import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyWorkspaceRestoreMapping,
  getBoundSessions,
  getWorkspacePromptState,
  getClaudeChatLensEnabled,
  getCodexChatLensEnabled,
  ignoreWorkspaceCheckpoint,
  markWorkspaceAutoShown,
  removeRestoredSessionBindings,
  setClaudeChatLensEnabled,
  setCodexChatLensEnabled,
} from './storage.js';

const read = (key: string): unknown => JSON.parse(localStorage.getItem(key) ?? 'null');

const snapshotStorage = (): Record<string, string | null> => Object.fromEntries(
  Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => key !== null)
    .map((key) => [key, localStorage.getItem(key)]),
);

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('agent chat-view preferences', () => {
  it('migrates the legacy shared opt-in until each agent gets an explicit value', () => {
    localStorage.setItem('tw_chat_lens', '1');
    expect(getClaudeChatLensEnabled()).toBe(true);
    expect(getCodexChatLensEnabled()).toBe(true);

    setClaudeChatLensEnabled(false);
    expect(getClaudeChatLensEnabled()).toBe(false);
    expect(getCodexChatLensEnabled()).toBe(true);

    setCodexChatLensEnabled(false);
    expect(getClaudeChatLensEnabled()).toBe(false);
    expect(getCodexChatLensEnabled()).toBe(false);
  });

  it('keeps new installs off and stores the two switches independently', () => {
    expect(getClaudeChatLensEnabled()).toBe(false);
    expect(getCodexChatLensEnabled()).toBe(false);
    setCodexChatLensEnabled(true);
    expect(getClaudeChatLensEnabled()).toBe(false);
    expect(getCodexChatLensEnabled()).toBe(true);
  });
});

describe('workspace prompt state', () => {
  it('keeps auto-shown and ignored state scoped to one checkpoint', () => {
    markWorkspaceAutoShown('checkpoint-a');
    expect(getWorkspacePromptState('checkpoint-a')).toEqual({ autoShown: true });
    expect(getWorkspacePromptState('checkpoint-b')).toEqual({});

    ignoreWorkspaceCheckpoint('checkpoint-b');
    expect(getWorkspacePromptState('checkpoint-a')).toEqual({ autoShown: true });
    expect(getWorkspacePromptState('checkpoint-b')).toEqual({ ignored: true, autoShown: true });
  });

  it('closing only marks autoShown and does not silently ignore the checkpoint', () => {
    markWorkspaceAutoShown('checkpoint-a');
    expect(getWorkspacePromptState('checkpoint-a')).toEqual({ autoShown: true });
    expect(getWorkspacePromptState('checkpoint-a').ignored).toBeUndefined();
  });
});

describe('workspace runtime mapping', () => {
  it('removes only successfully restored target names from this device bindings', () => {
    localStorage.setItem('tw_bound', JSON.stringify(['project', 'current', 'project-restored']));

    expect(removeRestoredSessionBindings([
      { status: 'restored', targetName: 'project-restored' },
      { status: 'failed', targetName: 'current' },
      { status: 'already-present', targetName: 'project' },
    ])).toEqual(['project', 'current']);
    expect(getBoundSessions()).toEqual(['project', 'current']);

    expect(removeRestoredSessionBindings([
      { status: 'restored', targetName: 'project' },
    ])).toEqual(['current']);
  });

  it('does not cascade a value mapping when its parent key belongs to the current tmux server', () => {
    localStorage.setItem('tw_win', JSON.stringify({ '$1': '@1', '$7': '@1' }));
    localStorage.setItem('tw_pane', JSON.stringify({ '@1': '%1', '@7': '%1' }));

    expect(applyWorkspaceRestoreMapping({
      id: 'checkpoint-a-runtime-reuse',
      runtime: {
        sessions: { '$1': '$9' },
        windows: { '@1': '@9' },
        panes: { '%1': '%9' },
      },
    })).toBe(true);

    expect(read('tw_win')).toEqual({ '$7': '@1', '$9': '@9' });
    expect(read('tw_pane')).toEqual({ '@7': '%1', '@9': '%9' });
  });

  it('normalizes malformed bound-session storage before applying a mapping', () => {
    localStorage.setItem('tw_bound', JSON.stringify({ project: true }));
    localStorage.setItem('tw_last_session', '$1');
    expect(getBoundSessions()).toEqual([]);

    expect(() => applyWorkspaceRestoreMapping({
      id: 'checkpoint-a-malformed-bound',
      runtime: { sessions: { '$1': '$9' }, windows: {}, panes: {} },
      names: { project: 'project-restored' },
    })).not.toThrow();
    expect(localStorage.getItem('tw_last_session')).toBe('$9');
    expect(getBoundSessions()).toEqual([]);

    localStorage.setItem('tw_bound', JSON.stringify(['project', 7, null]));
    expect(getBoundSessions()).toEqual(['project']);
  });

  it('migrates only known workspace keys and preserves a same-name current binding', () => {
    localStorage.setItem('tw_last_session', '$1');
    localStorage.setItem('tw_win', JSON.stringify({ '$1': '@1', '$current': '@current' }));
    localStorage.setItem('tw_pane', JSON.stringify({ '@1': '%1', '@current': '%current' }));
    localStorage.setItem('tw_git_repos', JSON.stringify({ '@1': ['/repo/@1'], '@current': ['/repo/current'] }));
    localStorage.setItem('tw_git_dirs', JSON.stringify({ '@1': ['/dir/@1'] }));
    localStorage.setItem('tw_browse_dir', JSON.stringify({ '@1': '/browse/@1' }));
    localStorage.setItem('tw_preview_dir', JSON.stringify({ '@1': '/preview/@1' }));
    localStorage.setItem('tw_pane_base', JSON.stringify({ '%1': '/base/%1' }));
    localStorage.setItem('tw_inbox_seen', JSON.stringify({ '%1': 123, '%current': 456 }));
    localStorage.setItem('tw_bound', JSON.stringify(['project', 'current']));
    localStorage.setItem('tw_chat_draft', 'do not replace $1, @1, or %1 here');

    const mapping = {
      id: 'checkpoint-a-mapping-1',
      runtime: {
        sessions: { '$1': '$9' },
        windows: { '@1': '@9' },
        panes: { '%1': '%9' },
      },
      names: { project: 'project-restored' },
    };

    expect(applyWorkspaceRestoreMapping(mapping)).toBe(true);
    expect(localStorage.getItem('tw_last_session')).toBe('$9');
    expect(read('tw_win')).toEqual({ '$9': '@9', '$current': '@current' });
    expect(read('tw_pane')).toEqual({ '@9': '%9', '@current': '%current' });
    expect(read('tw_git_repos')).toEqual({ '@9': ['/repo/@1'], '@current': ['/repo/current'] });
    expect(read('tw_git_dirs')).toEqual({ '@9': ['/dir/@1'] });
    expect(read('tw_browse_dir')).toEqual({ '@9': '/browse/@1' });
    expect(read('tw_preview_dir')).toEqual({ '@9': '/preview/@1' });
    expect(read('tw_pane_base')).toEqual({ '%9': '/base/%1' });
    expect(read('tw_inbox_seen')).toEqual({ '%9': 123, '%current': 456 });
    expect(getBoundSessions()).toEqual(['project', 'current', 'project-restored']);
    expect(localStorage.getItem('tw_chat_draft')).toBe('do not replace $1, @1, or %1 here');

    const snapshot = snapshotStorage();
    expect(applyWorkspaceRestoreMapping(mapping)).toBe(false);
    expect(snapshotStorage()).toEqual(snapshot);
  });

  it('accepts a later cumulative partial mapping without replay damage', () => {
    localStorage.setItem('tw_win', JSON.stringify({ '$1': '@1', '$2': '@2' }));
    localStorage.setItem('tw_pane', JSON.stringify({ '@1': '%1', '@2': '%2' }));

    expect(applyWorkspaceRestoreMapping({
      id: 'checkpoint-a-partial-1',
      runtime: {
        sessions: { '$1': '$10' },
        windows: { '@1': '@10' },
        panes: { '%1': '%10' },
      },
    })).toBe(true);
    expect(read('tw_win')).toEqual({ '$10': '@10', '$2': '@2' });

    expect(applyWorkspaceRestoreMapping({
      id: 'checkpoint-a-partial-2',
      runtime: {
        sessions: { '$1': '$10', '$2': '$20' },
        windows: { '@1': '@10', '@2': '@20' },
        panes: { '%1': '%10', '%2': '%20' },
      },
    })).toBe(true);
    expect(read('tw_win')).toEqual({ '$10': '@10', '$20': '@20' });
    expect(read('tw_pane')).toEqual({ '@10': '%10', '@20': '%20' });
  });

  it('rejects a mapping without a stable id', () => {
    localStorage.setItem('tw_last_session', '$1');
    expect(applyWorkspaceRestoreMapping({ runtime: { sessions: { '$1': '$9' } } })).toBe(false);
    expect(localStorage.getItem('tw_last_session')).toBe('$1');
  });

  it.each([
    ['unsafe id', { id: '../mapping', runtime: { sessions: { '$1': '$9' } } }],
    ['non-plain runtime', { id: 'mapping-a', runtime: [] }],
    ['non-plain runtime kind', { id: 'mapping-a', runtime: { sessions: [] } }],
    ['unknown runtime kind', { id: 'mapping-a', runtime: { other: { '$1': '$9' } } }],
    ['malformed runtime source', { id: 'mapping-a', runtime: { sessions: { session1: '$9' } } }],
    ['malformed runtime target after a valid entry', {
      id: 'mapping-a',
      runtime: { sessions: { '$1': '$9' }, windows: { '@1': '@not-numeric' } },
    }],
    ['non-plain names', { id: 'mapping-a', names: [] }],
    ['malformed name target', { id: 'mapping-a', names: { project: 7 } }],
  ])('atomically rejects %s with zero localStorage writes', (_label, mapping) => {
    localStorage.setItem('tw_last_session', '$1');
    localStorage.setItem('tw_win', 'corrupt json');
    localStorage.setItem('tw_bound', JSON.stringify(['project']));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    setItem.mockClear();

    expect(applyWorkspaceRestoreMapping(mapping)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem('tw_last_session')).toBe('$1');
    expect(localStorage.getItem('tw_win')).toBe('corrupt json');
    expect(localStorage.getItem('tw_workspace_applied_mappings')).toBeNull();
    setItem.mockRestore();
  });

  it('supports a names-only mapping without touching runtime-keyed storage', () => {
    localStorage.setItem('tw_bound', JSON.stringify(['project']));
    localStorage.setItem('tw_win', 'corrupt json');

    expect(applyWorkspaceRestoreMapping({
      id: 'mapping-names-only',
      names: { project: 'project-restored' },
    })).toBe(true);
    expect(getBoundSessions()).toEqual(['project', 'project-restored']);
    expect(localStorage.getItem('tw_win')).toBe('corrupt json');
  });

  it('touches only keys belonging to a non-empty runtime kind', () => {
    localStorage.setItem('tw_win', 'corrupt json');
    localStorage.setItem('tw_pane', 'corrupt json');
    localStorage.setItem('tw_pane_base', JSON.stringify({ '%1': '/old' }));
    localStorage.setItem('tw_inbox_seen', JSON.stringify({ '%1': 100 }));

    expect(applyWorkspaceRestoreMapping({
      id: 'mapping-panes-only',
      runtime: { panes: { '%1': '%9' } },
    })).toBe(true);
    expect(localStorage.getItem('tw_win')).toBe('corrupt json');
    expect(localStorage.getItem('tw_pane')).toBe('corrupt json');
    expect(read('tw_pane_base')).toEqual({ '%9': '/old' });
    expect(read('tw_inbox_seen')).toEqual({ '%9': 100 });
  });

  it('does not record an empty mapping or rewrite corrupt known keys', () => {
    localStorage.setItem('tw_win', 'corrupt json');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    setItem.mockClear();

    expect(applyWorkspaceRestoreMapping({
      id: 'mapping-empty',
      runtime: { sessions: {}, windows: {}, panes: {} },
      names: {},
    })).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem('tw_win')).toBe('corrupt json');
    expect(localStorage.getItem('tw_workspace_applied_mappings')).toBeNull();
    setItem.mockRestore();
  });
});
