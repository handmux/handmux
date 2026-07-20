import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SERVER_RE = /^(?:no server running on(?: .+)?|no sessions)$/i;
const MISSING_OPTION_RE = /invalid option|unknown option|not set/i;
const SESSION_FORMAT = '#{session_id}\t#{session_name}\t#{session_last_attached}\t#{@handmux_session_id}';
const WINDOW_FORMAT = '#{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_layout}\t#{@handmux_window_id}';
const PANE_FORMAT = '#{window_id}\t#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_path}\t#{@handmux_pane_id}';
const ACTIVE_FORMAT = '#{session_id}\t#{window_id}\t#{pane_id}';

const text = (value) => String(value && typeof value === 'object' && 'stdout' in value ? value.stdout : value ?? '');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const byId = (a, b) => compare(a.id, b.id);
const byRuntime = (a, b) => compare(a.runtimeId, b.runtimeId);

function isUuid(value) { return typeof value === 'string' && UUID_RE.test(value); }
function isNoServer(error) {
  if (error?.code === 'ENOENT') return true;
  return NO_SERVER_RE.test(String(error?.stderr || error?.message || error || '').trim());
}
function isMissingOption(error) { return MISSING_OPTION_RE.test(String(error?.stderr || error?.message || error || '')); }

function rows(output, columns, label) {
  const value = text(output);
  if (!value.trim()) return [];
  return value.replace(/\n$/, '').split('\n').map((line) => {
    const fields = line.split('\t');
    if (fields.length !== columns) throw new Error(`invalid ${label} format`);
    return fields;
  });
}

function index(value, label) {
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${label}`);
  return Number(value);
}

function active(value, label) {
  if (value !== '0' && value !== '1') throw new Error(`invalid ${label}`);
  return value === '1';
}

function runtime(value, prefix, label) {
  if (!new RegExp(`^\\${prefix}\\d+$`).test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function logicalAllocator(randomUUID) {
  const used = new Set();
  return {
    accept(candidate) {
      const id = candidate;
      if (!isUuid(id) || used.has(id)) return null;
      used.add(id);
      return id;
    },
    fresh() {
      for (let tries = 0; tries < 100; tries++) {
        const id = randomUUID();
        if (isUuid(id) && !used.has(id)) { used.add(id); return id; }
      }
      throw new Error('could not allocate a unique workspace logical id');
    },
  };
}

function requireLogicalId(value, label) {
  if (!isUuid(value)) throw new Error(`${label} must be a UUID`);
  return value;
}

function requireCreatedRuntime(value, prefix, label) {
  return runtime(value, prefix, label);
}

export function createdTargetGuard(created) {
  return (target) => {
    if (!created.has(target)) throw new Error(`workspace target was not created by this restore: ${target}`);
    return target;
  };
}

export function createWorkspaceTmux({ run, randomUUID = crypto.randomUUID } = {}) {
  if (typeof run !== 'function') throw new Error('workspace tmux run is required');
  const created = new Set();
  const guard = createdTargetGuard(created);

  async function observeEnvironment() {
    let current;
    try {
      current = text(await run(['show-options', '-gv', '@handmux_server_id'])).replace(/\r?\n$/, '');
    } catch (error) {
      if (isNoServer(error)) return { status: 'absent', tmuxServerId: null };
      if (!isMissingOption(error)) return { status: 'unknown' };
      current = '';
    }
    if (isUuid(current)) return { status: 'present', tmuxServerId: current };
    const tmuxServerId = randomUUID();
    if (!isUuid(tmuxServerId)) return { status: 'unknown' };
    try {
      await run(['set-option', '-g', '@handmux_server_id', tmuxServerId]);
      return { status: 'present', tmuxServerId };
    } catch (error) {
      return isNoServer(error) ? { status: 'absent', tmuxServerId: null } : { status: 'unknown' };
    }
  }

  async function assignLogicalIds(items, option, scopeArgs) {
    const allocator = logicalAllocator(randomUUID);
    for (const item of [...items].sort(byRuntime)) {
      const accepted = allocator.accept(item.optionId);
      item.id = accepted || allocator.fresh();
      if (!accepted) await run(['set-option', ...scopeArgs, '-t', item.runtimeId, option, item.id]);
    }
  }

  async function captureTopology() {
    try {
      const environment = await observeEnvironment();
      if (environment.status === 'absent') return { status: 'empty', tmuxVersion: 'unknown', active: null, sessions: [], windows: [] };
      if (environment.status !== 'present') return { status: 'unknown', error: 'tmux environment unavailable' };

      const tmuxVersion = text(await run(['-V'])).trim().replace(/^tmux\s+/, '');
      if (!tmuxVersion) throw new Error('invalid tmux version');
      let sessionFields;
      try { sessionFields = rows(await run(['list-sessions', '-F', SESSION_FORMAT]), 4, 'session'); }
      catch (error) {
        if (isNoServer(error)) return { status: 'empty', tmuxVersion: 'unknown', active: null, sessions: [], windows: [] };
        throw error;
      }
      if (sessionFields.length === 0) return { status: 'empty', tmuxVersion: 'unknown', active: null, sessions: [], windows: [] };

      const sessions = sessionFields.map(([runtimeId, name, lastAttached, optionId]) => ({
        runtimeId: runtime(runtimeId, '$', 'session runtime id'), name, lastAttached: index(lastAttached, 'session last attached'), optionId,
        windowLinks: [], activeWindowId: null,
      }));
      if (new Set(sessions.map((item) => item.runtimeId)).size !== sessions.length) throw new Error('duplicate session runtime id');
      await assignLogicalIds(sessions, '@handmux_session_id', []);
      const sessionByRuntime = new Map(sessions.map((item) => [item.runtimeId, item]));

      const windowFields = rows(await run(['list-windows', '-a', '-F', WINDOW_FORMAT]), 7, 'window');
      const windowLinks = windowFields.map(([sessionRuntimeId, runtimeId, windowIndex, name, isActive, layout, optionId]) => {
        if (!sessionByRuntime.has(sessionRuntimeId)) throw new Error('window references unknown session');
        return {
          sessionRuntimeId, runtimeId: runtime(runtimeId, '@', 'window runtime id'), index: index(windowIndex, 'window index'),
          name, active: active(isActive, 'window active'), layout, optionId,
        };
      });
      const groupedWindows = new Map();
      for (const link of windowLinks) {
        const group = groupedWindows.get(link.runtimeId) || [];
        group.push(link);
        groupedWindows.set(link.runtimeId, group);
      }
      const windows = [...groupedWindows].map(([runtimeId, links]) => {
        const optionIds = new Set(links.map((item) => item.optionId).filter(Boolean));
        if (optionIds.size > 1) throw new Error('linked window has conflicting logical ids');
        return { runtimeId, optionId: optionIds.values().next().value || '', links };
      });
      await assignLogicalIds(windows, '@handmux_window_id', ['-w']);
      const windowByRuntime = new Map(windows.map((item) => [item.runtimeId, item]));

      for (const window of windows) {
        for (const link of window.links) {
          const session = sessionByRuntime.get(link.sessionRuntimeId);
          session.windowLinks.push({ windowId: window.id, index: link.index });
          if (link.active) session.activeWindowId = window.id;
        }
      }
      for (const session of sessions) {
        session.windowLinks.sort((a, b) => a.index - b.index || compare(a.windowId, b.windowId));
        if (!session.windowLinks.length || !session.activeWindowId) throw new Error('session has no active linked window');
      }

      const paneFields = rows(await run(['list-panes', '-a', '-F', PANE_FORMAT]), 6, 'pane');
      const panes = paneFields.map(([windowRuntimeId, runtimeId, paneIndex, isActive, cwd, optionId]) => {
        if (!windowByRuntime.has(windowRuntimeId)) throw new Error('pane references unknown window');
        return {
          windowRuntimeId, runtimeId: runtime(runtimeId, '%', 'pane runtime id'), index: index(paneIndex, 'pane index'),
          active: active(isActive, 'pane active'), cwd, optionId, agent: null,
        };
      });
      if (new Set(panes.map((item) => item.runtimeId)).size !== panes.length) throw new Error('duplicate pane runtime id');
      await assignLogicalIds(panes, '@handmux_pane_id', ['-p']);

      const canonicalSessions = sessions.sort(byId);
      const canonicalWindows = windows.map((window) => {
        const owner = [...window.links].sort((a, b) => compare(sessionByRuntime.get(a.sessionRuntimeId).id, sessionByRuntime.get(b.sessionRuntimeId).id))[0];
        const windowPanes = panes.filter((pane) => pane.windowRuntimeId === window.runtimeId).sort(byId);
        const activePane = windowPanes.find((pane) => pane.active);
        if (!activePane) throw new Error('window has no active pane');
        return {
          id: window.id, runtimeId: window.runtimeId, name: owner.name, index: owner.index, layout: owner.layout,
          activePaneId: activePane.id,
          panes: windowPanes.map(({ id, runtimeId, index: paneIndex, cwd, agent }) => ({ id, runtimeId, index: paneIndex, cwd, agent })),
        };
      }).sort(byId);

      const maxAttached = Math.max(...canonicalSessions.map((session) => session.lastAttached));
      const selected = canonicalSessions.find((session) => session.lastAttached === maxAttached);
      const [activeSessionRuntime, activeWindowRuntime, activePaneRuntime] = rows(
        await run(['display-message', '-p', '-t', selected.runtimeId, ACTIVE_FORMAT]), 3, 'active path',
      )[0] || [];
      const activeSession = sessionByRuntime.get(activeSessionRuntime);
      const activeWindow = windowByRuntime.get(activeWindowRuntime);
      const activePane = panes.find((pane) => pane.runtimeId === activePaneRuntime);
      if (!activeSession || !activeWindow || !activePane || activePane.windowRuntimeId !== activeWindowRuntime) throw new Error('invalid active path');

      return {
        status: 'ok', tmuxVersion,
        active: { sessionId: activeSession.id, windowId: activeWindow.id, paneId: activePane.id },
        sessions: canonicalSessions.map(({ id, runtimeId, name, windowLinks, activeWindowId }) => ({ id, runtimeId, name, windowLinks, activeWindowId })),
        windows: canonicalWindows,
      };
    } catch (error) {
      return { status: 'unknown', error: error?.message || String(error) };
    }
  }

  async function createTemporarySession({ cwd, sessionLogicalId, windowLogicalId, paneLogicalId, windowName, windowIndex }) {
    requireLogicalId(sessionLogicalId, 'sessionLogicalId');
    const hasSeed = [windowLogicalId, paneLogicalId, windowName, windowIndex].some((value) => value !== undefined);
    if (hasSeed) {
      requireLogicalId(windowLogicalId, 'windowLogicalId');
      requireLogicalId(paneLogicalId, 'paneLogicalId');
      if (typeof windowName !== 'string' || !windowName) throw new Error('windowName must be a non-empty string');
      if (!Number.isInteger(windowIndex) || windowIndex < 0) throw new Error('windowIndex must be a non-negative integer');
    }
    const name = `hm-r-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    if (!/^hm-r-[0-9a-f]{8}$/i.test(name)) throw new Error('could not allocate temporary session name');
    const args = ['new-session', '-d', '-P', '-F', '#{session_id}\t#{window_id}\t#{pane_id}\t#{window_index}', '-s', name];
    if (hasSeed) args.push('-n', windowName);
    args.push('-c', cwd);
    const parsed = rows(await run(args), 4, 'created session')[0];
    if (!parsed) throw new Error('tmux did not return created session ids');
    const [sessionId, windowId, paneId, seedIndexValue] = parsed;
    requireCreatedRuntime(sessionId, '$', 'created session id');
    requireCreatedRuntime(windowId, '@', 'created window id');
    requireCreatedRuntime(paneId, '%', 'created pane id');
    const seedIndex = index(seedIndexValue, 'created window index');
    created.add(sessionId); created.add(windowId); created.add(paneId);
    if (hasSeed && seedIndex !== windowIndex) await run(['move-window', '-s', guard(windowId), '-t', `${guard(sessionId)}:${windowIndex}`]);
    await run(['set-option', '-t', guard(sessionId), '@handmux_session_id', sessionLogicalId]);
    if (hasSeed) {
      await run(['set-option', '-w', '-t', guard(windowId), '@handmux_window_id', windowLogicalId]);
      await run(['set-option', '-p', '-t', guard(paneId), '@handmux_pane_id', paneLogicalId]);
    }
    return { sessionId, windowId, paneId, name };
  }

  async function createWindow(sessionId, { name, index: windowIndex, cwd, windowLogicalId, paneLogicalId }) {
    guard(sessionId);
    if (!Number.isInteger(windowIndex) || windowIndex < 0) throw new Error('window index must be a non-negative integer');
    requireLogicalId(windowLogicalId, 'windowLogicalId');
    requireLogicalId(paneLogicalId, 'paneLogicalId');
    const parsed = rows(await run(['new-window', '-d', '-P', '-F', '#{window_id}\t#{pane_id}', '-t', `${sessionId}:${windowIndex}`, '-n', name, '-c', cwd]), 2, 'created window')[0];
    if (!parsed) throw new Error('tmux did not return created window ids');
    const [windowId, paneId] = parsed;
    requireCreatedRuntime(windowId, '@', 'created window id');
    requireCreatedRuntime(paneId, '%', 'created pane id');
    created.add(windowId); created.add(paneId);
    await run(['set-option', '-w', '-t', guard(windowId), '@handmux_window_id', windowLogicalId]);
    await run(['set-option', '-p', '-t', guard(paneId), '@handmux_pane_id', paneLogicalId]);
    return { windowId, paneId };
  }

  async function splitPane(targetPaneId, { cwd, paneLogicalId }) {
    guard(targetPaneId);
    requireLogicalId(paneLogicalId, 'paneLogicalId');
    const paneId = text(await run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', targetPaneId, '-c', cwd])).trim();
    requireCreatedRuntime(paneId, '%', 'created pane id');
    created.add(paneId);
    await run(['set-option', '-p', '-t', guard(paneId), '@handmux_pane_id', paneLogicalId]);
    return paneId;
  }

  async function linkWindow(windowId, sessionId, windowIndex, { existing = false } = {}) {
    if (existing) runtime(windowId, '@', 'existing window id');
    else guard(windowId);
    guard(sessionId);
    if (!Number.isInteger(windowIndex) || windowIndex < 0) throw new Error('window index must be a non-negative integer');
    await run(['link-window', '-s', windowId, '-t', `${sessionId}:${windowIndex}`]);
  }
  async function applyLayout(windowId, layout) { await run(['select-layout', '-t', guard(windowId), layout]); }
  async function selectPane(paneId) { await run(['select-pane', '-t', guard(paneId)]); }
  async function selectWindow(windowId) { await run(['select-window', '-t', guard(windowId)]); }
  async function selectWindowInSession(sessionId, windowIndex) {
    guard(sessionId);
    if (!Number.isInteger(windowIndex) || windowIndex < 0) throw new Error('window index must be a non-negative integer');
    await run(['select-window', '-t', `${sessionId}:${windowIndex}`]);
  }
  async function renameCreatedSession(sessionId, name) { await run(['rename-session', '-t', guard(sessionId), name]); }
  async function killCreatedSession(sessionId) { await run(['kill-session', '-t', guard(sessionId)]); }
  async function killCreatedWindow(windowId) { await run(['kill-window', '-t', guard(windowId)]); }

  async function startAgent(paneId, cmd, args = []) {
    guard(paneId);
    const valid = cmd === 'claude'
      ? args.length === 2 && args[0] === '--resume' && isUuid(args[1])
      : cmd === 'codex' && args.length === 2 && args[0] === 'resume' && isUuid(args[1]);
    if (!valid) throw new Error('unsafe agent command token');
    await run(['send-keys', '-t', paneId, '-l', '--', [cmd, ...args].join(' ')]);
    await run(['send-keys', '-t', paneId, 'Enter']);
  }

  async function topologyFingerprint() {
    const topology = await captureTopology();
    if (topology.status === 'unknown') return topology;
    return crypto.createHash('sha256').update(JSON.stringify(topology)).digest('hex');
  }

  return {
    observeEnvironment,
    captureTopology,
    createTemporarySession,
    createWindow,
    splitPane,
    linkWindow,
    applyLayout,
    selectPane,
    selectWindow,
    selectWindowInSession,
    renameCreatedSession,
    killCreatedSession,
    killCreatedWindow,
    startAgent,
    topologyFingerprint,
  };
}
