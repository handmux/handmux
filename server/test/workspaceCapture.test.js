import { describe, expect, it } from 'vitest';
import { captureWorkspace } from '../src/workspace/capture.js';

const UUID = {
  claude: '10000000-0000-4000-8000-000000000001',
  codex: '10000000-0000-4000-8000-000000000002',
};
const environment = { id: 'env-a', bootIdentity: 'boot-a', tmuxServerId: 'server-a' };
const topology = {
  status: 'ok',
  tmuxVersion: '3.6a',
  active: { sessionId: 's-a', windowId: 'w-a', paneId: 'p-a' },
  sessions: [{ id: 's-a', runtimeId: '$1', name: 'dev', windowLinks: [{ windowId: 'w-a', index: 0 }], activeWindowId: 'w-a' }],
  windows: [{
    id: 'w-a', runtimeId: '@1', name: 'main', index: 0, layout: 'layout-a', activePaneId: 'p-a',
    panes: [
      { id: 'p-b', runtimeId: '%2', index: 1, cwd: '/work/b', agent: null },
      { id: 'p-a', runtimeId: '%1', index: 0, cwd: '/work/a', agent: null },
      { id: 'p-c', runtimeId: '%3', index: 2, cwd: '/work/c', agent: null },
      { id: 'p-d', runtimeId: '%4', index: 3, cwd: '/work/d', agent: null },
      { id: 'p-e', runtimeId: '%5', index: 4, cwd: '/work/e', agent: null },
      { id: 'p-f', runtimeId: '%6', index: 5, cwd: '/work/f', agent: null },
    ],
  }],
};

const agents = [
  { id: 'claude', sessions: { isId: (id) => id === UUID.claude } },
  { id: 'codex', sessions: { bindingVersion: 2, isId: (id) => id === UUID.codex } },
];

describe('canonical workspace capture', () => {
  it('attaches only known, valid agent sessions with readable transcripts', async () => {
    const state = {
      '%1': { payload: { session_id: UUID.claude, transcript_path: '/transcripts/a.jsonl' } },
      '%2': { agent: 'codex', bindingVersion: 2, payload: { session_id: UUID.codex, transcript_path: '/transcripts/b.jsonl' } },
      '%3': { agent: 'codex', payload: { session_id: UUID.codex, transcript_path: '/transcripts/c.jsonl' } },
      '%4': { agent: 'unknown', payload: { session_id: UUID.claude, transcript_path: '/transcripts/d.jsonl' } },
      '%5': { agent: 'claude', payload: { session_id: UUID.claude, transcript_path: '/transcripts/directory' } },
      '%6': { agent: 'claude', payload: { session_id: UUID.claude, transcript_path: '/transcripts/unreadable.jsonl' } },
    };
    const tmux = {
      topologyFingerprint: async () => 'same',
      captureTopology: async () => topology,
    };
    const result = await captureWorkspace({
      tmux,
      stateFile: '/state.json',
      environment,
      agents,
      readFile: async (file) => {
        expect(file).toBe('/state.json');
        return JSON.stringify(state);
      },
      access: async (file, mode) => {
        expect(mode).toBe(4);
        if (file.includes('unreadable')) throw new Error('EACCES');
      },
      stat: async (file) => ({ isFile: () => !file.includes('directory') }),
      now: () => Date.parse('2026-07-20T02:00:00.000Z'),
    });

    expect(result.status).toBe('ok');
    expect(result.snapshot).toMatchObject({
      schemaVersion: 1,
      capturedAt: '2026-07-20T02:00:00.000Z',
      environment,
      tmuxVersion: '3.6a',
    });
    expect(result.snapshot.windows[0].panes.map(({ id, agent }) => [id, agent])).toEqual([
      ['p-a', { id: 'claude', sessionId: UUID.claude, transcriptPath: '/transcripts/a.jsonl' }],
      ['p-b', { id: 'codex', sessionId: UUID.codex, transcriptPath: '/transcripts/b.jsonl' }],
      ['p-c', null],
      ['p-d', null],
      ['p-e', null],
      ['p-f', null],
    ]);
  });

  it('returns changed-during-capture and never emits a snapshot from mismatched fingerprints', async () => {
    const fingerprints = ['before', 'after'];
    const result = await captureWorkspace({
      tmux: {
        topologyFingerprint: async () => fingerprints.shift(),
        captureTopology: async () => topology,
      },
      stateFile: '/state.json', environment, agents,
      readFile: async () => '{}', access: async () => {}, now: () => 0,
    });
    expect(result).toEqual({ status: 'changed-during-capture' });
  });

  it('keeps explicit empty separate from unknown capture states', async () => {
    const emptyTmux = {
      topologyFingerprint: async () => 'empty-fingerprint',
      captureTopology: async () => ({ status: 'empty', tmuxVersion: 'unknown', active: null, sessions: [], windows: [] }),
    };
    const empty = await captureWorkspace({
      tmux: emptyTmux,
      stateFile: '/state.json',
      environment: { ...environment, tmuxServerId: null },
      agents, readFile: async () => '{}', access: async () => {}, now: () => 0,
    });
    expect(empty.status).toBe('empty');
    expect(empty.snapshot).toMatchObject({ active: null, sessions: [], windows: [] });

    for (const unknownAt of ['before', 'capture', 'after']) {
      let calls = 0;
      const tmux = {
        topologyFingerprint: async () => {
          calls++;
          return unknownAt === 'before' && calls === 1 || unknownAt === 'after' && calls === 2
            ? { status: 'unknown', error: 'tmux failed' }
            : 'stable';
        },
        captureTopology: async () => unknownAt === 'capture' ? { status: 'unknown', error: 'bad format' } : topology,
      };
      expect(await captureWorkspace({
        tmux, stateFile: '/state.json', environment, agents,
        readFile: async () => '{}', access: async () => {}, now: () => 0,
      })).toEqual({ status: 'unknown' });
    }
  });
});
