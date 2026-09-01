import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceTmux, createdTargetGuard } from '../src/workspace/tmuxAdapter.js';

const IDS = {
  server: '00000000-0000-4000-8000-000000000001',
  sessionA: '00000000-0000-4000-8000-000000000002',
  sessionB: '00000000-0000-4000-8000-000000000003',
  window: '00000000-0000-4000-8000-000000000004',
  paneA: '00000000-0000-4000-8000-000000000005',
  paneB: '00000000-0000-4000-8000-000000000006',
};

const SESSION_FORMAT = '#{q:session_id}|#{q:session_name}|#{q:session_last_attached}|#{q:@handmux_session_id}';
const WINDOW_FORMAT = '#{q:session_id}|#{q:window_id}|#{q:window_index}|#{q:window_name}|#{q:window_active}|#{q:window_layout}|#{q:@handmux_window_id}';
const PANE_FORMAT = '#{q:window_id}|#{q:pane_id}|#{q:pane_index}|#{q:pane_active}|#{q:pane_current_path}|#{q:@handmux_pane_id}';

function captureRun({ reverse = false, conflictingPane = false } = {}) {
  const calls = [];
  const sessionRows = [
    `$2|beta\\ space|10|${IDS.sessionA}`,
    `$1|alpha|20|${IDS.sessionA}`,
  ];
  const windowRows = [
    `$2|@9|4|shared\\\\name|1|layout-x|${IDS.window}`,
    `$1|@9|1|shared\\\\name|1|layout-x|${IDS.window}`,
  ];
  const paneRows = [
    `@9|%8|1|0|/work/b\\|part|${IDS.paneA}`,
    `@9|%7|0|1|${conflictingPane ? '/different' : '/work/a\\|part'}|${IDS.paneA}`,
    `@9|%8|1|0|/work/b\\|part|${IDS.paneA}`,
    `@9|%7|0|1|/work/a\\|part|${IDS.paneA}`,
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
    if (key === 'display-message') return '$1|@9|%7\n';
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

  it('uses q formats, preserves links, and repairs duplicate logical ids without rewriting the first owner', async () => {
    const { run, calls } = captureRun();
    const generated = [IDS.sessionB, IDS.paneB];
    const tmux = createWorkspaceTmux({ run, randomUUID: () => generated.shift() });
    const topology = await tmux.captureTopology();

    expect(calls).toContainEqual(['list-sessions', '-F', SESSION_FORMAT]);
    expect(calls).toContainEqual(['list-windows', '-a', '-F', WINDOW_FORMAT]);
    expect(calls).toContainEqual(['list-panes', '-a', '-F', PANE_FORMAT]);
    expect(calls).toContainEqual(['display-message', '-p', '-t', '$1', '#{q:session_id}|#{q:window_id}|#{q:pane_id}']);
    expect(calls).toContainEqual(['set-option', '-t', '$2', '@handmux_session_id', IDS.sessionB]);
    expect(calls).toContainEqual(['set-option', '-p', '-t', '%8', '@handmux_pane_id', IDS.paneB]);
    expect(calls).not.toContainEqual(['set-option', '-t', '$1', '@handmux_session_id', expect.anything()]);
    expect(calls).not.toContainEqual(['set-option', '-p', '-t', '%7', '@handmux_pane_id', expect.anything()]);
    expect(calls).not.toContainEqual(['set-option', '-w', '-t', '@9', '@handmux_window_id', expect.anything()]);

    expect(topology).toMatchObject({ status: 'ok', tmuxVersion: '3.6a' });
    expect(topology.windows).toHaveLength(1);
    expect(topology.sessions).toEqual([
      { id: IDS.sessionA, runtimeId: '$1', name: 'alpha', windowLinks: [{ windowId: IDS.window, index: 1 }], activeWindowId: IDS.window },
      { id: IDS.sessionB, runtimeId: '$2', name: 'beta space', windowLinks: [{ windowId: IDS.window, index: 4 }], activeWindowId: IDS.window },
    ]);
    expect(topology.windows[0]).toMatchObject({ name: 'shared\\name', panes: [{ cwd: '/work/a|part' }, { cwd: '/work/b|part' }] });
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

  it('fails closed when duplicate linked-window pane rows conflict', async () => {
    const ids = [IDS.sessionB, IDS.paneB];
    const tmux = createWorkspaceTmux({ ...captureRun({ conflictingPane: true }), randomUUID: () => ids.shift() });
    expect(await tmux.captureTopology()).toMatchObject({
      status: 'unknown',
      error: expect.stringMatching(/duplicate pane runtime id.*conflicting/i),
    });
  });

  it('reports no server as empty but query and format failures as unknown', async () => {
    for (const message of [
      'no server running on /tmp/tmux.sock',
      'error connecting to /tmp/tmux-0/handmux-workspace-test (No such file or directory)',
    ]) {
      const absent = createWorkspaceTmux({ run: async () => { throw new Error(message); } });
      expect(await absent.captureTopology()).toMatchObject({ status: 'empty', sessions: [], windows: [] });
    }

    const failed = createWorkspaceTmux({
      run: async () => { throw new Error('operation timed out'); },
    });
    expect(await failed.captureTopology()).toMatchObject({ status: 'unknown' });

    for (const message of ['failed to connect to server: Permission denied', 'failed to connect to server']) {
      const connectionFailure = createWorkspaceTmux({ run: async () => { throw new Error(message); } });
      expect(await connectionFailure.captureTopology()).toMatchObject({ status: 'unknown' });
    }
  });

  it('captures with stable ephemeral ids when a writable adapter is asked to read-only capture', async () => {
    const calls = [];
    const generated = [IDS.server, IDS.sessionA, IDS.window, IDS.paneA];
    const tmux = createWorkspaceTmux({
      randomUUID: () => generated.shift(),
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'show-options') return '';
        if (args[0] === '-V') return 'tmux 3.6a\n';
        if (args[0] === 'list-sessions') return '$1|api||\n';
        if (args[0] === 'list-windows') return '$1|@1|0|main|1|layout-x|\n';
        if (args[0] === 'list-panes') return '@1|%1|0|1|/work|\n';
        if (args[0] === 'display-message') return '$1|@1|%1\n';
        throw new Error(`unexpected mutation: ${args.join(' ')}`);
      },
    });

    const first = await tmux.captureTopology({ readOnly: true });
    const second = await tmux.captureTopology({ readOnly: true });
    expect(first).toMatchObject({
      status: 'ok',
      sessions: [{ id: expect.stringMatching(/^[0-9a-f-]{36}$/i) }],
      windows: [{ id: expect.stringMatching(/^[0-9a-f-]{36}$/i), panes: [{ id: expect.stringMatching(/^[0-9a-f-]{36}$/i) }] }],
    });
    expect(second).toEqual(first);
    expect(calls.every((args) => ['show-options', '-V', 'list-sessions', 'list-windows', 'list-panes', 'display-message'].includes(args[0]))).toBe(true);
    expect(calls.every((args) => !['set-option', 'move-window', 'new-session', 'kill-session'].includes(args[0]))).toBe(true);
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
      if (args[0] === 'new-session') return '$10|@20|%30|0\n';
      if (args[0] === 'new-window') return '@21|%31\n';
      if (args[0] === 'split-window') return '%32\n';
      return '';
    };
    const prepared = [];
    const executableWaits = [];
    const tmux = createWorkspaceTmux({
      run,
      randomUUID: () => 'abcdef12-0000-4000-8000-000000000000',
      agentRunner: {
        command: 'handmux-agent-runner',
        prepare: async (request) => { prepared.push(request); },
        waitReady: async () => ({ status: 'ready' }),
        waitForExecutable: (command) => {
          executableWaits.push(command);
          return Promise.resolve({ status: 'ready' });
        },
      },
    });
    const agentWaits = tmux.waitForAgents(['codex', 'codex', 'claude']);
    expect([...agentWaits.keys()]).toEqual(['codex', 'claude']);
    await Promise.all(agentWaits.values());
    expect(executableWaits).toEqual(['codex', 'claude']);
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
    const beforeInvalidLayout = calls.length;
    await expect(tmux.applyLayout('@21', 'invalid-layout')).rejects.toThrow(/invalid workspace layout/i);
    expect(calls).toHaveLength(beforeInvalidLayout);
    await tmux.startAgent('%32', 'codex', ['resume', IDS.server]);

    expect(calls).toContainEqual(['new-session', '-d', '-P', '-F', '#{q:session_id}|#{q:window_id}|#{q:pane_id}|#{q:window_index}', '-s', 'hm-r-abcdef12', '-n', 'first window', '-c', '/work dir']);
    expect(calls).toContainEqual(['move-window', '-s', '@20', '-t', '$10:3']);
    expect(calls).toContainEqual(['new-window', '-d', '-P', '-F', '#{q:window_id}|#{q:pane_id}', '-t', '$10:7', '-n', 'two words', '-c', '/other dir']);
    expect(calls).toContainEqual(['link-window', '-s', '@21', '-t', '$10:8']);
    expect(prepared).toEqual([{ paneId: '%32', cmd: 'codex', args: ['resume', IDS.server] }]);
    expect(calls).toContainEqual(['send-keys', '-t', '%32', '-l', '--', 'handmux-agent-runner']);
    expect(calls).toContainEqual(['send-keys', '-t', '%32', 'Enter']);
    expect(calls.find((args) => args[0] === 'send-keys' && args.includes('-l')).join(' ')).not.toContain(IDS.server);

    const before = calls.length;
    await expect(tmux.applyLayout('@pre-existing', 'layout')).rejects.toThrow(/was not created/);
    await expect(tmux.killCreatedSession('$pre-existing')).rejects.toThrow(/was not created/);
    await expect(tmux.startAgent('%32', 'codex;rm', ['x'])).rejects.toThrow(/unsafe agent command token/);
    await expect(tmux.startAgent('%32', 'codex', ['resume', 'x y'])).rejects.toThrow(/unsafe agent command token/);
    await expect(tmux.startAgent('%32', 'codex', ['resume', ` ${IDS.server} `])).rejects.toThrow(/unsafe agent command token/);
    expect(calls).toHaveLength(before);
    for (const args of calls) expect(Array.isArray(args)).toBe(true);
  });

  it('reports a missing/immediately-failing agent binary while leaving the fixed helper to return to the same shell', async () => {
    const calls = [];
    const tmux = createWorkspaceTmux({
      run: async (args) => { calls.push(args); return args[0] === 'new-session' ? '$10|@20|%30|0\n' : ''; },
      randomUUID: () => 'abcdef12-0000-4000-8000-000000000000',
      agentRunner: {
        command: 'handmux-agent-runner',
        prepare: async () => {},
        waitReady: async () => ({ status: 'failed', error: 'agent binary not found' }),
      },
    });
    const temp = await tmux.createTemporarySession({
      cwd: '/work', sessionLogicalId: IDS.sessionA, windowLogicalId: IDS.window,
      paneLogicalId: IDS.paneA, windowName: 'main', windowIndex: 0,
    });
    await expect(tmux.startAgent(temp.paneId, 'claude', ['--resume', IDS.server])).rejects.toThrow(/binary not found/i);
    expect(calls.filter((args) => args[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', '%32', '-l', '--', 'handmux-agent-runner'],
      ['send-keys', '-t', '%32', 'Enter'],
      ['send-keys', '-t', '%32', 'C-c'],
    ].map((args) => args.map((value) => value === '%32' ? temp.paneId : value)));
    expect(calls.filter((args) => args[0] === 'send-keys').flat().join(' ')).not.toContain(IDS.server);
  });

  it.each([
    ['status read failure', async () => { throw new Error('status read failed'); }],
    ['readiness timeout', async () => ({ status: 'failed', error: 'agent readiness timed out' })],
  ])('interrupts the fixed foreground runner when %s occurs', async (_label, waitReady) => {
    const calls = [];
    const cancel = vi.fn(async () => {});
    const tmux = createWorkspaceTmux({
      run: async (args) => { calls.push(args); return args[0] === 'new-session' ? '$10|@20|%30|0\n' : ''; },
      randomUUID: () => 'abcdef12-0000-4000-8000-000000000000',
      agentRunner: { command: 'handmux-agent-runner', prepare: async () => {}, waitReady, cancel },
    });
    const temp = await tmux.createTemporarySession({
      cwd: '/work', sessionLogicalId: IDS.sessionA, windowLogicalId: IDS.window,
      paneLogicalId: IDS.paneA, windowName: 'main', windowIndex: 0,
    });

    await expect(tmux.startAgent(temp.paneId, 'claude', ['--resume', IDS.server])).rejects.toThrow(/status read failed|timed out/i);
    expect(calls).toContainEqual(['send-keys', '-t', temp.paneId, 'C-c']);
    expect(cancel).toHaveBeenCalledWith(temp.paneId);
    expect(calls.flat().join(' ')).not.toContain(IDS.server);
  });

  it('aggregates foreground interrupt and request cleanup failures with the readiness failure', async () => {
    const tmux = createWorkspaceTmux({
      run: async (args) => {
        if (args[0] === 'new-session') return '$10|@20|%30|0\n';
        if (args.at(-1) === 'C-c') throw new Error('foreground interrupt failed');
        return '';
      },
      randomUUID: () => 'abcdef12-0000-4000-8000-000000000000',
      agentRunner: {
        command: 'handmux-agent-runner', prepare: async () => {},
        waitReady: async () => ({ status: 'failed', error: 'agent readiness timed out' }),
        cancel: async () => { throw new Error('request cleanup failed'); },
      },
    });
    const temp = await tmux.createTemporarySession({
      cwd: '/work', sessionLogicalId: IDS.sessionA, windowLogicalId: IDS.window,
      paneLogicalId: IDS.paneA, windowName: 'main', windowIndex: 0,
    });

    await expect(tmux.startAgent(temp.paneId, 'codex', ['resume', IDS.server]))
      .rejects.toThrow(/timed out.*foreground interrupt failed.*request cleanup failed/i);
  });

  it('accepts canonical UUIDs without version constraints and rejects whitespace-padded values before tmux', async () => {
    const calls = [];
    const anyCanonicalUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const tmux = createWorkspaceTmux({
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'new-session') return '$1|@1|%1|0\n';
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
        if (args[0] === 'new-session') return '$10|@20|%30|0\n';
        return '';
      },
      randomUUID: () => 'abcdef12-0000-4000-8000-000000000000',
    });
    const temp = await tmux.createTemporarySession({ cwd: '/work', sessionLogicalId: IDS.sessionA });
    await tmux.linkWindow('@90', temp.sessionId, 0, { existing: true });
    await tmux.selectWindowInSession(temp.sessionId, 0);
    await tmux.killCreatedWindow(temp.windowId);

    expect(calls).toContainEqual(['set-option', '-t', '$10', '@handmux_session_id', IDS.sessionA]);
    expect(calls).not.toContainEqual(['set-option', '-w', '-t', '@20', '@handmux_window_id', expect.anything()]);
    expect(calls).not.toContainEqual(['set-option', '-p', '-t', '%30', '@handmux_pane_id', expect.anything()]);
    expect(calls).toContainEqual(['move-window', '-s', '@20', '-t', '$10:9999']);
    expect(calls).toContainEqual(['link-window', '-s', '@90', '-t', '$10:0']);
    expect(calls).toContainEqual(['select-window', '-t', '$10:0']);
    expect(calls).toContainEqual(['kill-window', '-t', '@20']);

    const before = calls.length;
    await expect(tmux.applyLayout(temp.windowId, 'layout')).rejects.toThrow(/was not created/);
    await expect(tmux.linkWindow('@90', '$91', 0, { existing: true })).rejects.toThrow(/was not created/);
    await expect(tmux.linkWindow('@91', '$10', 0)).rejects.toThrow(/was not created/);
    expect(calls).toHaveLength(before);
  });

  it.each([
    ['temporary session', 'set-option', 'kill-session'],
    ['window', 'set-option', 'kill-window'],
    ['pane', 'set-option', 'kill-pane'],
  ])('self-cleans a newly-created %s when logical-id assignment fails', async (kind, failingCommand, cleanupCommand) => {
    const calls = [];
    let setOptions = 0;
    let armed = kind === 'temporary session';
    const tmux = createWorkspaceTmux({
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'new-session') return '$10|@20|%30|0\n';
        if (args[0] === 'new-window') return '@21|%31\n';
        if (args[0] === 'split-window') return '%32\n';
        if (armed && args[0] === failingCommand && !args.includes('-u') && ++setOptions === (kind === 'temporary session' ? 2 : 1)) {
          throw new Error(`${kind} logical id failed`);
        }
        return '';
      },
      randomUUID: () => 'abcdef12-0000-4000-8000-000000000000',
    });

    if (kind === 'temporary session') {
      await expect(tmux.createTemporarySession({
        cwd: '/work', sessionLogicalId: IDS.sessionA, windowLogicalId: IDS.window,
        paneLogicalId: IDS.paneA, windowName: 'main', windowIndex: 0,
      })).rejects.toThrow(/temporary session logical id failed/i);
    } else {
      const temp = await tmux.createTemporarySession({
        cwd: '/work', sessionLogicalId: IDS.sessionA, windowLogicalId: IDS.window,
        paneLogicalId: IDS.paneA, windowName: 'main', windowIndex: 0,
      });
      setOptions = 0;
      armed = true;
      if (kind === 'window') {
        await expect(tmux.createWindow(temp.sessionId, {
          name: 'next', index: 1, cwd: '/work', windowLogicalId: IDS.sessionB, paneLogicalId: IDS.paneB,
        })).rejects.toThrow(/window logical id failed/i);
      } else {
        await expect(tmux.splitPane(temp.paneId, { cwd: '/work', paneLogicalId: IDS.paneB }))
          .rejects.toThrow(/pane logical id failed/i);
      }
    }
    expect(calls.some((args) => args[0] === cleanupCommand)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['malformed', '$10|@20\n'],
  ])('kills only the allowlisted temporary session name when new-session returns %s output', async (_label, output) => {
    const calls = [];
    const tmux = createWorkspaceTmux({
      run: async (args) => { calls.push(args); return args[0] === 'new-session' ? output : ''; },
      randomUUID: () => 'abcdef12-0000-4000-8000-000000000000',
    });

    await expect(tmux.createTemporarySession({
      cwd: '/work', sessionLogicalId: IDS.sessionA, windowLogicalId: IDS.window,
      paneLogicalId: IDS.paneA, windowName: 'main', windowIndex: 0,
    })).rejects.toThrow(/created session|format/i);
    expect(calls.filter((args) => args[0] === 'kill-session')).toEqual([
      ['kill-session', '-t', '=hm-r-abcdef12'],
    ]);
  });

  it('aggregates exact-name fallback cleanup failure after malformed successful new-session output', async () => {
    const calls = [];
    const tmux = createWorkspaceTmux({
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'new-session') return '$10|@20\n';
        if (args[0] === 'kill-session') throw new Error('fallback cleanup failed');
        return '';
      },
      randomUUID: () => 'abcdef12-0000-4000-8000-000000000000',
    });

    await expect(tmux.createTemporarySession({ cwd: '/work', sessionLogicalId: IDS.sessionA }))
      .rejects.toThrow(/format.*fallback cleanup failed/i);
    expect(calls).toContainEqual(['kill-session', '-t', '=hm-r-abcdef12']);
  });

  it('does not kill by temporary name when new-session itself rejects, including a name collision', async () => {
    const calls = [];
    const tmux = createWorkspaceTmux({
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'new-session') throw new Error('duplicate session: hm-r-abcdef12');
        return '';
      },
      randomUUID: () => 'abcdef12-0000-4000-8000-000000000000',
    });

    await expect(tmux.createTemporarySession({ cwd: '/work', sessionLogicalId: IDS.sessionA }))
      .rejects.toThrow(/duplicate session/i);
    expect(calls.some((args) => args[0] === 'kill-session')).toBe(false);
  });

  it('reports both the create follow-up failure and cleanup failure', async () => {
    const calls = [];
    const tmux = createWorkspaceTmux({
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'new-session') return '$10|@20|%30|0\n';
        if (args[0] === 'set-option' && args.includes('@handmux_window_id')) throw new Error('assign failed');
        if (args[0] === 'kill-session') throw new Error('cleanup failed');
        return '';
      },
      randomUUID: () => 'abcdef12-0000-4000-8000-000000000000',
    });

    await expect(tmux.createTemporarySession({
      cwd: '/work', sessionLogicalId: IDS.sessionA, windowLogicalId: IDS.window,
      paneLogicalId: IDS.paneA, windowName: 'main', windowIndex: 0,
    })).rejects.toThrow(/assign failed.*cleanup failed/i);
    expect(calls.some((args) => args[0] === 'kill-session')).toBe(true);
  });

  it('clears the session logical id before a best-effort topology cleanup kill', async () => {
    const calls = [];
    const tmux = createWorkspaceTmux({
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'new-session') return '$10|@20|%30|0\n';
        return '';
      },
      randomUUID: () => 'abcdef12-0000-4000-8000-000000000000',
    });
    await tmux.createTemporarySession({
      cwd: '/work', sessionLogicalId: IDS.sessionA, windowLogicalId: IDS.window,
      paneLogicalId: IDS.paneA, windowName: 'main', windowIndex: 0,
    });
    await tmux.killCreatedSession('$10');
    const clear = calls.findIndex((args) => args[0] === 'set-option' && args.includes('-u') && args.includes('@handmux_session_id'));
    const kill = calls.findIndex((args) => args[0] === 'kill-session');
    expect(clear).toBeGreaterThan(-1);
    expect(kill).toBeGreaterThan(clear);
    const before = calls.length;
    await expect(tmux.selectPane('%30')).rejects.toThrow(/was not created/);
    expect(calls).toHaveLength(before);
  });

  it('revokes every created-target capability after a restore batch so reused runtime ids are rejected', async () => {
    const calls = [];
    const tmux = createWorkspaceTmux({
      run: async (args) => { calls.push(args); return args[0] === 'new-session' ? '$10|@20|%30|0\n' : ''; },
      randomUUID: () => 'abcdef12-0000-4000-8000-000000000000',
    });
    await tmux.createTemporarySession({
      cwd: '/work', sessionLogicalId: IDS.sessionA, windowLogicalId: IDS.window,
      paneLogicalId: IDS.paneA, windowName: 'main', windowIndex: 0,
    });
    tmux.revokeCreatedTargets();

    const before = calls.length;
    await expect(tmux.applyLayout('@20', 'layout-after-runtime-id-reuse')).rejects.toThrow(/was not created/);
    await expect(tmux.selectPane('%30')).rejects.toThrow(/was not created/);
    await expect(tmux.renameCreatedSession('$10', 'reused')).rejects.toThrow(/was not created/);
    expect(calls).toHaveLength(before);
  });
});
