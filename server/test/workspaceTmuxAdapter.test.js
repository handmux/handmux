import { describe, expect, it } from 'vitest';
import { createWorkspaceTmux, createdTargetGuard } from '../src/workspace/tmuxAdapter.js';

const IDS = {
  server: '00000000-0000-4000-8000-000000000001',
  sessionA: '00000000-0000-4000-8000-000000000002',
  sessionB: '00000000-0000-4000-8000-000000000003',
  window: '00000000-0000-4000-8000-000000000004',
  paneA: '00000000-0000-4000-8000-000000000005',
  paneB: '00000000-0000-4000-8000-000000000006',
};

const SESSION_FORMAT = '#{session_id}\t#{session_name}\t#{session_last_attached}\t#{@handmux_session_id}';
const WINDOW_FORMAT = '#{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_layout}\t#{@handmux_window_id}';
const PANE_FORMAT = '#{window_id}\t#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_path}\t#{@handmux_pane_id}';

function captureRun({ reverse = false } = {}) {
  const calls = [];
  const sessionRows = [
    `$2\tbeta\t10\t${IDS.sessionA}`,
    `$1\talpha\t20\t${IDS.sessionA}`,
  ];
  const windowRows = [
    `$2\t@9\t4\tshared\t1\tlayout-x\t${IDS.window}`,
    `$1\t@9\t1\tshared\t1\tlayout-x\t${IDS.window}`,
  ];
  const paneRows = [
    `@9\t%8\t1\t0\t/work/b\t${IDS.paneA}`,
    `@9\t%7\t0\t1\t/work/a\t${IDS.paneA}`,
  ];
  const rows = (items) => `${(reverse ? [...items].reverse() : items).join('\n')}\n`;
  const run = async (args) => {
    calls.push(args);
    const key = args[0];
    if (key === 'show-options') return `${IDS.server}\n`;
    if (key === '-V') return 'tmux 3.6a\n';
    if (key === 'list-sessions') return rows(sessionRows);
    if (key === 'list-windows') return rows(windowRows);
    if (key === 'list-panes') return rows(paneRows);
    if (key === 'display-message') return '$1\t@9\t%7\n';
    return '';
  };
  return { run, calls };
}

describe('workspace tmux environment and topology', () => {
  it('writes the global server id only when it is missing or invalid', async () => {
    for (const current of ['', 'not-a-uuid']) {
      const calls = [];
      const tmux = createWorkspaceTmux({
        run: async (args) => { calls.push(args); return args[0] === 'show-options' ? current : ''; },
        randomUUID: () => IDS.server,
      });
      expect(await tmux.observeEnvironment()).toEqual({ status: 'present', tmuxServerId: IDS.server });
      expect(calls).toEqual([
        ['show-options', '-gv', '@handmux_server_id'],
        ['set-option', '-g', '@handmux_server_id', IDS.server],
      ]);
    }

    const calls = [];
    const tmux = createWorkspaceTmux({ run: async (args) => { calls.push(args); return IDS.server; } });
    expect(await tmux.observeEnvironment()).toEqual({ status: 'present', tmuxServerId: IDS.server });
    expect(calls).toEqual([['show-options', '-gv', '@handmux_server_id']]);

    const paddedCalls = [];
    const padded = createWorkspaceTmux({
      run: async (args) => { paddedCalls.push(args); return args[0] === 'show-options' ? ` ${IDS.server} \n` : ''; },
      randomUUID: () => IDS.sessionA,
    });
    expect(await padded.observeEnvironment()).toEqual({ status: 'present', tmuxServerId: IDS.sessionA });
    expect(paddedCalls).toContainEqual(['set-option', '-g', '@handmux_server_id', IDS.sessionA]);
  });

  it('uses tab formats, preserves links, and repairs duplicate logical ids without rewriting the first owner', async () => {
    const { run, calls } = captureRun();
    const generated = [IDS.sessionB, IDS.paneB];
    const tmux = createWorkspaceTmux({ run, randomUUID: () => generated.shift() });
    const topology = await tmux.captureTopology();

    expect(calls).toContainEqual(['list-sessions', '-F', SESSION_FORMAT]);
    expect(calls).toContainEqual(['list-windows', '-a', '-F', WINDOW_FORMAT]);
    expect(calls).toContainEqual(['list-panes', '-a', '-F', PANE_FORMAT]);
    expect(calls).toContainEqual(['display-message', '-p', '-t', '$1', '#{session_id}\t#{window_id}\t#{pane_id}']);
    expect(calls).toContainEqual(['set-option', '-t', '$2', '@handmux_session_id', IDS.sessionB]);
    expect(calls).toContainEqual(['set-option', '-p', '-t', '%8', '@handmux_pane_id', IDS.paneB]);
    expect(calls).not.toContainEqual(['set-option', '-t', '$1', '@handmux_session_id', expect.anything()]);
    expect(calls).not.toContainEqual(['set-option', '-p', '-t', '%7', '@handmux_pane_id', expect.anything()]);
    expect(calls).not.toContainEqual(['set-option', '-w', '-t', '@9', '@handmux_window_id', expect.anything()]);

    expect(topology).toMatchObject({ status: 'ok', tmuxVersion: '3.6a' });
    expect(topology.windows).toHaveLength(1);
    expect(topology.sessions).toEqual([
      { id: IDS.sessionA, runtimeId: '$1', name: 'alpha', windowLinks: [{ windowId: IDS.window, index: 1 }], activeWindowId: IDS.window },
      { id: IDS.sessionB, runtimeId: '$2', name: 'beta', windowLinks: [{ windowId: IDS.window, index: 4 }], activeWindowId: IDS.window },
    ]);
    expect(topology.windows[0].panes.map((pane) => pane.id)).toEqual([IDS.paneA, IDS.paneB]);
    expect(topology.active).toEqual({ sessionId: IDS.sessionA, windowId: IDS.window, paneId: IDS.paneA });
  });

  it('has an order-independent topology fingerprint', async () => {
    const idsA = [IDS.sessionB, IDS.paneB];
    const idsB = [IDS.sessionB, IDS.paneB];
    const a = createWorkspaceTmux({ ...captureRun(), randomUUID: () => idsA.shift() });
    const b = createWorkspaceTmux({ ...captureRun({ reverse: true }), randomUUID: () => idsB.shift() });
    expect(await a.topologyFingerprint()).toBe(await b.topologyFingerprint());
  });

  it('reports no server as empty but query and format failures as unknown', async () => {
    const absent = createWorkspaceTmux({
      run: async () => { throw new Error('no server running on /tmp/tmux.sock'); },
    });
    expect(await absent.captureTopology()).toMatchObject({ status: 'empty', sessions: [], windows: [] });

    const failed = createWorkspaceTmux({
      run: async () => { throw new Error('operation timed out'); },
    });
    expect(await failed.captureTopology()).toMatchObject({ status: 'unknown' });

    for (const message of ['failed to connect to server: Permission denied', 'failed to connect to server']) {
      const connectionFailure = createWorkspaceTmux({ run: async () => { throw new Error(message); } });
      expect(await connectionFailure.captureTopology()).toMatchObject({ status: 'unknown' });
    }
  });
});

describe('workspace restore command safety', () => {
  it('guards every mutating target and rejects unsafe agent tokens before running tmux', async () => {
    const created = new Set(['$new']);
    expect(createdTargetGuard(created)('$new')).toBe('$new');
    expect(() => createdTargetGuard(created)('$old')).toThrow('workspace target was not created by this restore: $old');

    const calls = [];
    const run = async (args) => {
      calls.push(args);
      if (args[0] === 'new-session') return '$10\t@20\t%30\t0\n';
      if (args[0] === 'new-window') return '@21\t%31\n';
      if (args[0] === 'split-window') return '%32\n';
      return '';
    };
    const tmux = createWorkspaceTmux({ run, randomUUID: () => 'abcdef12-0000-4000-8000-000000000000' });
    const temp = await tmux.createTemporarySession({
      cwd: '/work dir', sessionLogicalId: IDS.sessionA, windowLogicalId: IDS.window, paneLogicalId: IDS.paneA,
      windowName: 'first window', windowIndex: 3,
    });
    expect(temp).toEqual({ sessionId: '$10', windowId: '@20', paneId: '%30', name: 'hm-r-abcdef12' });
    const second = await tmux.createWindow('$10', {
      name: 'two words', index: 7, cwd: '/other dir', windowLogicalId: IDS.sessionB, paneLogicalId: IDS.paneB,
    });
    expect(second).toEqual({ windowId: '@21', paneId: '%31' });
    expect(await tmux.splitPane('%31', { cwd: '/pane dir', paneLogicalId: IDS.server })).toBe('%32');
    await tmux.linkWindow('@21', '$10', 8);
    await tmux.applyLayout('@21', 'abcd,80x24,0,0,1');
    await tmux.startAgent('%32', 'codex', ['resume', IDS.server]);

    expect(calls).toContainEqual(['new-session', '-d', '-P', '-F', '#{session_id}\t#{window_id}\t#{pane_id}\t#{window_index}', '-s', 'hm-r-abcdef12', '-n', 'first window', '-c', '/work dir']);
    expect(calls).toContainEqual(['move-window', '-s', '@20', '-t', '$10:3']);
    expect(calls).toContainEqual(['new-window', '-d', '-P', '-F', '#{window_id}\t#{pane_id}', '-t', '$10:7', '-n', 'two words', '-c', '/other dir']);
    expect(calls).toContainEqual(['link-window', '-s', '@21', '-t', '$10:8']);
    expect(calls).toContainEqual(['send-keys', '-t', '%32', '-l', '--', `codex resume ${IDS.server}`]);
    expect(calls).toContainEqual(['send-keys', '-t', '%32', 'Enter']);

    const before = calls.length;
    await expect(tmux.applyLayout('@pre-existing', 'layout')).rejects.toThrow(/was not created/);
    await expect(tmux.killCreatedSession('$pre-existing')).rejects.toThrow(/was not created/);
    await expect(tmux.startAgent('%32', 'codex;rm', ['x'])).rejects.toThrow(/unsafe agent command token/);
    await expect(tmux.startAgent('%32', 'codex', ['resume', 'x y'])).rejects.toThrow(/unsafe agent command token/);
    await expect(tmux.startAgent('%32', 'codex', ['resume', ` ${IDS.server} `])).rejects.toThrow(/unsafe agent command token/);
    expect(calls).toHaveLength(before);
    for (const args of calls) expect(Array.isArray(args)).toBe(true);
  });

  it('accepts canonical UUIDs without version constraints and rejects whitespace-padded values before tmux', async () => {
    const calls = [];
    const anyCanonicalUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const tmux = createWorkspaceTmux({
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'new-session') return '$1\t@1\t%1\t0\n';
        return '';
      },
      randomUUID: () => 'abcdef12-0000-0000-0000-000000000000',
    });
    await expect(tmux.createTemporarySession({
      cwd: '/work', sessionLogicalId: anyCanonicalUuid, windowLogicalId: IDS.window,
      paneLogicalId: IDS.paneA, windowName: 'main', windowIndex: 0,
    })).resolves.toMatchObject({ sessionId: '$1' });
    const before = calls.length;
    await expect(tmux.startAgent('%1', 'codex', ['resume', ` ${anyCanonicalUuid}`])).rejects.toThrow(/unsafe agent command token/);
    expect(calls).toHaveLength(before);
  });

  it('supports a disposable seed when every checkpoint window is reused and only links it into the new session', async () => {
    const calls = [];
    const tmux = createWorkspaceTmux({
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'new-session') return '$10\t@20\t%30\t0\n';
        return '';
      },
      randomUUID: () => 'abcdef12-0000-4000-8000-000000000000',
    });
    const temp = await tmux.createTemporarySession({ cwd: '/work', sessionLogicalId: IDS.sessionA });
    await tmux.linkWindow('@90', temp.sessionId, 2, { existing: true });
    await tmux.selectWindowInSession(temp.sessionId, 2);
    await tmux.killCreatedWindow(temp.windowId);

    expect(calls).toContainEqual(['set-option', '-t', '$10', '@handmux_session_id', IDS.sessionA]);
    expect(calls).not.toContainEqual(['set-option', '-w', '-t', '@20', '@handmux_window_id', expect.anything()]);
    expect(calls).not.toContainEqual(['set-option', '-p', '-t', '%30', '@handmux_pane_id', expect.anything()]);
    expect(calls).toContainEqual(['link-window', '-s', '@90', '-t', '$10:2']);
    expect(calls).toContainEqual(['select-window', '-t', '$10:2']);
    expect(calls).toContainEqual(['kill-window', '-t', '@20']);

    const before = calls.length;
    await expect(tmux.linkWindow('@90', '$91', 0, { existing: true })).rejects.toThrow(/was not created/);
    await expect(tmux.linkWindow('@91', '$10', 0)).rejects.toThrow(/was not created/);
    expect(calls).toHaveLength(before);
  });
});
