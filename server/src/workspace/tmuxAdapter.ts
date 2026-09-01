import crypto from 'node:crypto';
import { createAgentRunner } from './agentRunner.js';
import { parseTmuxRows, tmuxFormat } from '../tmux/format.js';
import type { CapturedTopology } from './capture.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SERVER_RE = /^(?:no server running on(?: .+)?|no sessions|error connecting to .+ \(no such file or directory\))$/i;
const MISSING_OPTION_RE = /invalid option|unknown option|not set/i;
const SESSION_FORMAT = tmuxFormat(['session_id', 'session_name', 'session_last_attached', '@handmux_session_id']);
const WINDOW_FORMAT = tmuxFormat(['session_id', 'window_id', 'window_index', 'window_name', 'window_active', 'window_layout', '@handmux_window_id']);
const PANE_FORMAT = tmuxFormat(['window_id', 'pane_id', 'pane_index', 'pane_active', 'pane_current_path', '@handmux_pane_id']);
const ACTIVE_FORMAT = tmuxFormat(['session_id', 'window_id', 'pane_id']);

type RunTmux = (args: string[]) => unknown | Promise<unknown>;
type WorkspaceAgentRunner = ReturnType<typeof createAgentRunner>;
interface LogicalItem { runtimeId: string; optionId: string; id?: string }
interface SessionItem extends LogicalItem {
  name: string;
  lastAttached: number;
  windowLinks: Array<{ windowId: string; index: number }>;
  activeWindowId: string | null;
}
interface WindowLinkItem {
  sessionRuntimeId: string;
  runtimeId: string;
  index: number;
  name: string;
  active: boolean;
  layout: string;
  optionId: string;
}
interface WindowItem extends LogicalItem { links: WindowLinkItem[] }
interface PaneItem extends LogicalItem {
  windowRuntimeId: string;
  index: number;
  active: boolean;
  cwd: string;
  agent: null;
}
interface ErrorFields { code?: unknown; stderr?: unknown; message?: unknown }

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);
const text = (value: unknown): string => String(recordOf(value)?.stdout ?? value ?? '');
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const byId = (a: { id?: string }, b: { id?: string }): number => compare(a.id ?? '', b.id ?? '');
const byRuntime = (a: { runtimeId: string }, b: { runtimeId: string }): number => compare(a.runtimeId, b.runtimeId);

function errorFields(error: unknown): ErrorFields {
  return error && typeof error === 'object' ? error as ErrorFields : {};
}
function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID_RE.test(value); }
function isNoServer(error: unknown): boolean {
  const fields = errorFields(error);
  if (fields.code === 'ENOENT') return true;
  return NO_SERVER_RE.test(String(fields.stderr || fields.message || error || '').trim());
}
function isMissingOption(error: unknown): boolean {
  const fields = errorFields(error);
  return MISSING_OPTION_RE.test(String(fields.stderr || fields.message || error || ''));
}

function rows(output: unknown, columns: number, label: string): string[][] {
  return parseTmuxRows(text(output), columns, label) as string[][];
}

function field(values: readonly string[], offset: number, label: string): string {
  const value = values[offset];
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function index(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${label}`);
  return Number(value);
}

function active(value: string, label: string): boolean {
  if (value !== '0' && value !== '1') throw new Error(`invalid ${label}`);
  return value === '1';
}

function runtime(value: string, prefix: string, label: string): string {
  if (!new RegExp(`^\\${prefix}\\d+$`).test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function logicalAllocator(randomUUID: () => string) {
  const used = new Set<string>();
  return {
    accept(candidate: unknown): string | null {
      const id = candidate;
      if (!isUuid(id) || used.has(id)) return null;
      used.add(id);
      return id;
    },
    fresh(): string {
      for (let tries = 0; tries < 100; tries++) {
        const id = randomUUID();
        if (isUuid(id) && !used.has(id)) { used.add(id); return id; }
      }
      throw new Error('could not allocate a unique workspace logical id');
    },
  };
}

function requireLogicalId(value: unknown, label: string): string {
  if (!isUuid(value)) throw new Error(`${label} must be a UUID`);
  return value;
}

function logicalId(item: { id?: string }, label: string): string {
  return requireLogicalId(item.id, label);
}

function ephemeralLogicalId(option: string, runtimeId: string): string {
  const hash = crypto.createHash('sha256').update(`${option}\0${runtimeId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function requireCreatedRuntime(value: string, prefix: string, label: string): string {
  return runtime(value, prefix, label);
}

function isTmuxLayout(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return false;
  if (!/^[0-9a-f]{4},\d+x\d+,\d+,\d+(?:,\d+|[\[{])/i.test(value)) return false;
  if (!/^[0-9a-fx,{}\[\]]+$/i.test(value)) return false;
  const stack = [];
  for (const char of value) {
    if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack.pop() !== expected) return false;
    }
  }
  return stack.length === 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withCleanupError(error: unknown, cleanupError: unknown): unknown {
  if (!cleanupError) return error;
  const combined = new Error(`${errorText(error)}; cleanup failed: ${errorText(cleanupError)}`);
  combined.cause = error;
  return combined;
}

export function createdTargetGuard(created: ReadonlySet<string>): (target: string) => string {
  return (target: string): string => {
    if (!created.has(target)) throw new Error(`workspace target was not created by this restore: ${target}`);
    return target;
  };
}

export function createWorkspaceTmux({
  run: inputRun,
  randomUUID = crypto.randomUUID,
  agentRunner = createAgentRunner(),
  readOnly = false,
}: {
  run?: RunTmux;
  randomUUID?: () => string;
  agentRunner?: WorkspaceAgentRunner;
  readOnly?: boolean;
} = {}) {
  if (typeof inputRun !== 'function') throw new Error('workspace tmux run is required');
  const run = inputRun;
  const created = new Set<string>();
  const guard = createdTargetGuard(created);
  const sessionWindows = new Map<string, Set<string>>();
  const windowSession = new Map<string, string>();
  const windowPanes = new Map<string, Set<string>>();
  const paneWindow = new Map<string, string>();

  function ensureWritable(): void {
    if (readOnly) throw new Error('workspace tmux adapter is read-only');
  }

  function trackWindow(sessionId: string, windowId: string, paneId: string): void {
    const windows = sessionWindows.get(sessionId) || new Set();
    windows.add(windowId);
    sessionWindows.set(sessionId, windows);
    windowSession.set(windowId, sessionId);
    windowPanes.set(windowId, new Set([paneId]));
    paneWindow.set(paneId, windowId);
  }

  function trackPane(targetPaneId: string, paneId: string): void {
    const windowId = paneWindow.get(targetPaneId);
    if (!windowId) throw new Error(`workspace pane owner is unavailable: ${targetPaneId}`);
    windowPanes.get(windowId)?.add(paneId);
    paneWindow.set(paneId, windowId);
  }

  function forgetWindow(windowId: string): void {
    for (const paneId of windowPanes.get(windowId) || []) {
      created.delete(paneId);
      paneWindow.delete(paneId);
    }
    windowPanes.delete(windowId);
    const sessionId = windowSession.get(windowId);
    if (sessionId) sessionWindows.get(sessionId)?.delete(windowId);
    windowSession.delete(windowId);
    created.delete(windowId);
  }

  function forgetSession(sessionId: string): void {
    for (const windowId of sessionWindows.get(sessionId) || []) forgetWindow(windowId);
    sessionWindows.delete(sessionId);
    created.delete(sessionId);
  }

  function revokeCreatedTargets(): void {
    created.clear();
    sessionWindows.clear();
    windowSession.clear();
    windowPanes.clear();
    paneWindow.clear();
  }

  async function cleanupSteps(steps: Array<() => unknown | Promise<unknown>>): Promise<void> {
    const failures: string[] = [];
    for (const step of steps) {
      try { await step(); } catch (error) { failures.push(errorText(error)); }
    }
    if (failures.length) throw new Error(failures.join('; '));
  }

  async function cleanupSession(sessionId: string, windowId: string, paneId: string): Promise<void> {
    let killed = false;
    try {
      await cleanupSteps([
        () => run(['set-option', '-u', '-p', '-t', paneId, '@handmux_pane_id']),
        () => run(['set-option', '-u', '-w', '-t', windowId, '@handmux_window_id']),
        () => run(['set-option', '-u', '-t', sessionId, '@handmux_session_id']),
        async () => { await run(['kill-session', '-t', sessionId]); killed = true; },
      ]);
    } finally {
      if (killed) forgetSession(sessionId);
    }
  }

  async function cleanupWindow(windowId: string, paneId: string): Promise<void> {
    let killed = false;
    try {
      await cleanupSteps([
        () => run(['set-option', '-u', '-p', '-t', paneId, '@handmux_pane_id']),
        () => run(['set-option', '-u', '-w', '-t', windowId, '@handmux_window_id']),
        async () => { await run(['kill-window', '-t', windowId]); killed = true; },
      ]);
    } finally {
      if (killed) forgetWindow(windowId);
    }
  }

  async function cleanupPane(paneId: string): Promise<void> {
    let killed = false;
    try {
      await cleanupSteps([
        () => run(['set-option', '-u', '-p', '-t', paneId, '@handmux_pane_id']),
        async () => { await run(['kill-pane', '-t', paneId]); killed = true; },
      ]);
    } finally {
      if (killed) {
        created.delete(paneId);
        const owner = paneWindow.get(paneId);
        if (owner) windowPanes.get(owner)?.delete(paneId);
        paneWindow.delete(paneId);
      }
    }
  }

  async function observeEnvironment({
    readOnly: observeReadOnly = readOnly,
  }: { readOnly?: boolean } = {}): Promise<
    { status: 'present'; tmuxServerId: string }
    | { status: 'absent'; tmuxServerId: null }
    | { status: 'unknown' }
  > {
    let current: string;
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
    if (observeReadOnly) return { status: 'present', tmuxServerId };
    try {
      await run(['set-option', '-g', '@handmux_server_id', tmuxServerId]);
      return { status: 'present', tmuxServerId };
    } catch (error) {
      return isNoServer(error) ? { status: 'absent', tmuxServerId: null } : { status: 'unknown' };
    }
  }

  async function assignLogicalIds<T extends LogicalItem>(
    items: T[],
    option: string,
    scopeArgs: string[],
    { readOnly: assignReadOnly = readOnly }: { readOnly?: boolean } = {},
  ): Promise<void> {
    const allocator = logicalAllocator(randomUUID);
    for (const item of [...items].sort(byRuntime)) {
      const accepted = allocator.accept(item.optionId);
      const generated = accepted ? null : assignReadOnly
        ? allocator.accept(ephemeralLogicalId(option, item.runtimeId))
        : allocator.fresh();
      const allocated = accepted ?? generated;
      if (!allocated) throw new Error(`could not allocate a read-only logical id for ${item.runtimeId}`);
      item.id = allocated;
      if (!accepted && !assignReadOnly) await run(['set-option', ...scopeArgs, '-t', item.runtimeId, option, item.id]);
    }
  }

  async function captureTopology({
    readOnly: captureReadOnly = readOnly,
  }: { readOnly?: boolean } = {}): Promise<CapturedTopology | { status: 'unknown'; error: string }> {
    try {
      const environment = await observeEnvironment({ readOnly: captureReadOnly });
      if (environment.status === 'absent') return { status: 'empty', tmuxVersion: 'unknown', active: null, sessions: [], windows: [] };
      if (environment.status !== 'present') return { status: 'unknown', error: 'tmux environment unavailable' };

      const tmuxVersion = text(await run(['-V'])).trim().replace(/^tmux\s+/, '');
      if (!tmuxVersion) throw new Error('invalid tmux version');
      let sessionFields: string[][];
      try { sessionFields = rows(await run(['list-sessions', '-F', SESSION_FORMAT]), 4, 'session'); }
      catch (error) {
        if (isNoServer(error)) return { status: 'empty', tmuxVersion: 'unknown', active: null, sessions: [], windows: [] };
        throw error;
      }
      if (sessionFields.length === 0) return { status: 'empty', tmuxVersion: 'unknown', active: null, sessions: [], windows: [] };

      const sessions: SessionItem[] = sessionFields.map((values): SessionItem => {
        const runtimeId = field(values, 0, 'session runtime id');
        const name = field(values, 1, 'session name');
        const lastAttached = field(values, 2, 'session last attached');
        const optionId = field(values, 3, 'session logical id option');
        return {
          runtimeId: runtime(runtimeId, '$', 'session runtime id'),
          name,
          lastAttached: index(lastAttached === '' ? '0' : lastAttached, 'session last attached'),
          optionId,
          windowLinks: [],
          activeWindowId: null,
        };
      });
      if (new Set(sessions.map((item) => item.runtimeId)).size !== sessions.length) throw new Error('duplicate session runtime id');
      await assignLogicalIds(sessions, '@handmux_session_id', [], { readOnly: captureReadOnly });
      const sessionByRuntime = new Map(sessions.map((item) => [item.runtimeId, item]));

      const windowFields = rows(await run(['list-windows', '-a', '-F', WINDOW_FORMAT]), 7, 'window');
      const windowLinks: WindowLinkItem[] = windowFields.map((values) => {
        const sessionRuntimeId = field(values, 0, 'window session runtime id');
        const runtimeId = field(values, 1, 'window runtime id');
        const windowIndex = field(values, 2, 'window index');
        const name = field(values, 3, 'window name');
        const isActive = field(values, 4, 'window active');
        const layout = field(values, 5, 'window layout');
        const optionId = field(values, 6, 'window logical id option');
        if (!sessionByRuntime.has(sessionRuntimeId)) throw new Error('window references unknown session');
        return {
          sessionRuntimeId, runtimeId: runtime(runtimeId, '@', 'window runtime id'), index: index(windowIndex, 'window index'),
          name, active: active(isActive, 'window active'), layout, optionId,
        };
      });
      const groupedWindows = new Map<string, WindowLinkItem[]>();
      for (const link of windowLinks) {
        const group = groupedWindows.get(link.runtimeId) || [];
        group.push(link);
        groupedWindows.set(link.runtimeId, group);
      }
      const windows: WindowItem[] = [...groupedWindows].map(([runtimeId, links]): WindowItem => {
        const optionIds = new Set(links.map((item) => item.optionId).filter(Boolean));
        if (optionIds.size > 1) throw new Error('linked window has conflicting logical ids');
        return { runtimeId, optionId: optionIds.values().next().value || '', links };
      });
      await assignLogicalIds(windows, '@handmux_window_id', ['-w'], { readOnly: captureReadOnly });
      const windowByRuntime = new Map(windows.map((item) => [item.runtimeId, item]));

      for (const window of windows) {
        for (const link of window.links) {
          const session = sessionByRuntime.get(link.sessionRuntimeId);
          if (!session) throw new Error('window references unknown session');
          const windowId = logicalId(window, 'window logical id');
          session.windowLinks.push({ windowId, index: link.index });
          if (link.active) session.activeWindowId = windowId;
        }
      }
      for (const session of sessions) {
        session.windowLinks.sort((a, b) => a.index - b.index || compare(a.windowId, b.windowId));
        if (!session.windowLinks.length || !session.activeWindowId) throw new Error('session has no active linked window');
      }

      const paneFields = rows(await run(['list-panes', '-a', '-F', PANE_FORMAT]), 6, 'pane');
      const paneByRuntime = new Map<string, PaneItem>();
      for (const values of paneFields) {
        const windowRuntimeId = field(values, 0, 'pane window runtime id');
        const runtimeId = field(values, 1, 'pane runtime id');
        const paneIndex = field(values, 2, 'pane index');
        const isActive = field(values, 3, 'pane active');
        const cwd = field(values, 4, 'pane current path');
        const optionId = field(values, 5, 'pane logical id option');
        if (!windowByRuntime.has(windowRuntimeId)) throw new Error('pane references unknown window');
        const pane: PaneItem = {
          windowRuntimeId, runtimeId: runtime(runtimeId, '%', 'pane runtime id'), index: index(paneIndex, 'pane index'),
          active: active(isActive, 'pane active'), cwd, optionId, agent: null,
        };
        const existing = paneByRuntime.get(pane.runtimeId);
        if (existing) {
          const fields = (item: PaneItem): unknown[] => [item.windowRuntimeId, item.index, item.active, item.cwd, item.optionId];
          if (JSON.stringify(fields(existing)) !== JSON.stringify(fields(pane))) {
            throw new Error('duplicate pane runtime id has conflicting fields');
          }
        } else {
          paneByRuntime.set(pane.runtimeId, pane);
        }
      }
      const panes = [...paneByRuntime.values()];
      await assignLogicalIds(panes, '@handmux_pane_id', ['-p'], { readOnly: captureReadOnly });

      const canonicalSessions = sessions.sort(byId);
      const canonicalWindows = windows.map((window) => {
        const owner = [...window.links].sort((a, b) => compare(
          logicalId(sessionByRuntime.get(a.sessionRuntimeId) ?? {}, 'owner session logical id'),
          logicalId(sessionByRuntime.get(b.sessionRuntimeId) ?? {}, 'owner session logical id'),
        ))[0];
        if (!owner) throw new Error('window has no owner session');
        const windowPanes = panes.filter((pane) => pane.windowRuntimeId === window.runtimeId).sort(byId);
        const activePane = windowPanes.find((pane) => pane.active);
        if (!activePane) throw new Error('window has no active pane');
        return {
          id: logicalId(window, 'window logical id'), runtimeId: window.runtimeId, name: owner.name, index: owner.index, layout: owner.layout,
          activePaneId: logicalId(activePane, 'active pane logical id'),
          panes: windowPanes.map((pane) => ({
            id: logicalId(pane, 'pane logical id'), runtimeId: pane.runtimeId, index: pane.index, cwd: pane.cwd, agent: pane.agent,
          })),
        };
      }).sort(byId);

      const maxAttached = Math.max(...canonicalSessions.map((session) => session.lastAttached));
      const selected = canonicalSessions.find((session) => session.lastAttached === maxAttached);
      if (!selected) throw new Error('tmux has no selected session');
      const activeFields = rows(
        await run(['display-message', '-p', '-t', selected.runtimeId, ACTIVE_FORMAT]), 3, 'active path',
      )[0];
      if (!activeFields) throw new Error('tmux has no active path');
      const activeSessionRuntime = field(activeFields, 0, 'active session runtime id');
      const activeWindowRuntime = field(activeFields, 1, 'active window runtime id');
      const activePaneRuntime = field(activeFields, 2, 'active pane runtime id');
      const activeSession = sessionByRuntime.get(activeSessionRuntime);
      const activeWindow = windowByRuntime.get(activeWindowRuntime);
      const activePane = panes.find((pane) => pane.runtimeId === activePaneRuntime);
      if (!activeSession || !activeWindow || !activePane || activePane.windowRuntimeId !== activeWindowRuntime) throw new Error('invalid active path');

      return {
        status: 'ok', tmuxVersion,
        active: {
          sessionId: logicalId(activeSession, 'active session logical id'),
          windowId: logicalId(activeWindow, 'active window logical id'),
          paneId: logicalId(activePane, 'active pane logical id'),
        },
        sessions: canonicalSessions.map((session) => ({
          id: logicalId(session, 'session logical id'), runtimeId: session.runtimeId, name: session.name,
          windowLinks: session.windowLinks, activeWindowId: requireLogicalId(session.activeWindowId, 'active window logical id'),
        })),
        windows: canonicalWindows,
      };
    } catch (error) {
      return { status: 'unknown', error: errorText(error) };
    }
  }

  async function createTemporarySession({
    cwd,
    sessionLogicalId,
    windowLogicalId,
    paneLogicalId,
    windowName,
    windowIndex,
  }: {
    cwd: string;
    sessionLogicalId: string;
    windowLogicalId?: string;
    paneLogicalId?: string;
    windowName?: string;
    windowIndex?: number;
  }): Promise<{ sessionId: string; windowId: string; paneId: string; name: string }> {
    ensureWritable();
    requireLogicalId(sessionLogicalId, 'sessionLogicalId');
    const hasSeed = [windowLogicalId, paneLogicalId, windowName, windowIndex].some((value) => value !== undefined);
    if (hasSeed) {
      requireLogicalId(windowLogicalId, 'windowLogicalId');
      requireLogicalId(paneLogicalId, 'paneLogicalId');
      if (typeof windowName !== 'string' || !windowName) throw new Error('windowName must be a non-empty string');
      if (typeof windowIndex !== 'number' || !Number.isInteger(windowIndex) || windowIndex < 0) {
        throw new Error('windowIndex must be a non-negative integer');
      }
    }
    const name = `hm-r-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    if (!/^hm-r-[0-9a-f]{8}$/i.test(name)) throw new Error('could not allocate temporary session name');
    const args = ['new-session', '-d', '-P', '-F', tmuxFormat(['session_id', 'window_id', 'pane_id', 'window_index']), '-s', name];
    if (hasSeed) args.push('-n', windowName as string);
    args.push('-c', cwd);
    const output = await run(args);
    let sessionId: string;
    let windowId: string;
    let paneId: string;
    let seedIndex: number;
    try {
      const parsed = rows(output, 4, 'created session')[0];
      if (!parsed) throw new Error('tmux did not return created session ids');
      sessionId = field(parsed, 0, 'created session id');
      windowId = field(parsed, 1, 'created window id');
      paneId = field(parsed, 2, 'created pane id');
      requireCreatedRuntime(sessionId, '$', 'created session id');
      requireCreatedRuntime(windowId, '@', 'created window id');
      requireCreatedRuntime(paneId, '%', 'created pane id');
      seedIndex = index(field(parsed, 3, 'created window index'), 'created window index');
    } catch (error) {
      let cleanupError;
      try { await run(['kill-session', '-t', `=${name}`]); } catch (failure) { cleanupError = failure; }
      throw withCleanupError(error, cleanupError);
    }
    created.add(sessionId); created.add(windowId); created.add(paneId);
    trackWindow(sessionId, windowId, paneId);
    try {
      const targetIndex = hasSeed ? windowIndex as number : 9999;
      if (seedIndex !== targetIndex) await run(['move-window', '-s', guard(windowId), '-t', `${guard(sessionId)}:${targetIndex}`]);
      if (hasSeed) {
        await run(['set-option', '-p', '-t', guard(paneId), '@handmux_pane_id', paneLogicalId as string]);
        await run(['set-option', '-w', '-t', guard(windowId), '@handmux_window_id', windowLogicalId as string]);
      }
      // Set the session id last: after this succeeds the helper has no remaining fallible setup step.
      await run(['set-option', '-t', guard(sessionId), '@handmux_session_id', sessionLogicalId]);
    } catch (error) {
      let cleanupError;
      try { await cleanupSession(sessionId, windowId, paneId); } catch (failure) { cleanupError = failure; }
      throw withCleanupError(error, cleanupError);
    }
    return { sessionId, windowId, paneId, name };
  }

  async function createWindow(sessionId: string, {
    name,
    index: windowIndex,
    cwd,
    windowLogicalId,
    paneLogicalId,
  }: {
    name: string;
    index: number;
    cwd: string;
    windowLogicalId: string;
    paneLogicalId: string;
  }): Promise<{ windowId: string; paneId: string }> {
    ensureWritable();
    guard(sessionId);
    if (!Number.isInteger(windowIndex) || windowIndex < 0) throw new Error('window index must be a non-negative integer');
    requireLogicalId(windowLogicalId, 'windowLogicalId');
    requireLogicalId(paneLogicalId, 'paneLogicalId');
    const parsed = rows(await run(['new-window', '-d', '-P', '-F', tmuxFormat(['window_id', 'pane_id']), '-t', `${sessionId}:${windowIndex}`, '-n', name, '-c', cwd]), 2, 'created window')[0];
    if (!parsed) throw new Error('tmux did not return created window ids');
    const windowId = field(parsed, 0, 'created window id');
    const paneId = field(parsed, 1, 'created pane id');
    requireCreatedRuntime(windowId, '@', 'created window id');
    requireCreatedRuntime(paneId, '%', 'created pane id');
    created.add(windowId); created.add(paneId);
    trackWindow(sessionId, windowId, paneId);
    try {
      await run(['set-option', '-p', '-t', guard(paneId), '@handmux_pane_id', paneLogicalId]);
      await run(['set-option', '-w', '-t', guard(windowId), '@handmux_window_id', windowLogicalId]);
    } catch (error) {
      let cleanupError;
      try { await cleanupWindow(windowId, paneId); } catch (failure) { cleanupError = failure; }
      throw withCleanupError(error, cleanupError);
    }
    return { windowId, paneId };
  }

  async function splitPane(
    targetPaneId: string,
    { cwd, paneLogicalId }: { cwd: string; paneLogicalId: string },
  ): Promise<string> {
    ensureWritable();
    guard(targetPaneId);
    requireLogicalId(paneLogicalId, 'paneLogicalId');
    const paneId = text(await run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', targetPaneId, '-c', cwd])).trim();
    requireCreatedRuntime(paneId, '%', 'created pane id');
    created.add(paneId);
    trackPane(targetPaneId, paneId);
    try {
      await run(['set-option', '-p', '-t', guard(paneId), '@handmux_pane_id', paneLogicalId]);
    } catch (error) {
      let cleanupError;
      try { await cleanupPane(paneId); } catch (failure) { cleanupError = failure; }
      throw withCleanupError(error, cleanupError);
    }
    return paneId;
  }

  async function linkWindow(
    windowId: string,
    sessionId: string,
    windowIndex: number,
    { existing = false }: { existing?: boolean } = {},
  ): Promise<void> {
    ensureWritable();
    if (existing) runtime(windowId, '@', 'existing window id');
    else guard(windowId);
    guard(sessionId);
    if (!Number.isInteger(windowIndex) || windowIndex < 0) throw new Error('window index must be a non-negative integer');
    await run(['link-window', '-s', windowId, '-t', `${sessionId}:${windowIndex}`]);
  }
  async function applyLayout(windowId: string, layout: string): Promise<void> {
    ensureWritable();
    const target = guard(windowId);
    if (!isTmuxLayout(layout)) throw new Error('invalid workspace layout');
    await run(['select-layout', '-t', target, layout]);
  }
  async function selectPane(paneId: string): Promise<void> { ensureWritable(); await run(['select-pane', '-t', guard(paneId)]); }
  async function selectWindow(windowId: string): Promise<void> { ensureWritable(); await run(['select-window', '-t', guard(windowId)]); }
  async function selectWindowInSession(sessionId: string, windowIndex: number): Promise<void> {
    ensureWritable();
    guard(sessionId);
    if (!Number.isInteger(windowIndex) || windowIndex < 0) throw new Error('window index must be a non-negative integer');
    await run(['select-window', '-t', `${sessionId}:${windowIndex}`]);
  }
  async function renameCreatedSession(sessionId: string, name: string): Promise<void> {
    ensureWritable(); await run(['rename-session', '-t', guard(sessionId), name]);
  }
  async function killCreatedSession(sessionId: string): Promise<void> {
    ensureWritable();
    guard(sessionId);
    let killed = false;
    try {
      await cleanupSteps([
        () => run(['set-option', '-u', '-t', sessionId, '@handmux_session_id']),
        async () => { await run(['kill-session', '-t', sessionId]); killed = true; },
      ]);
    } finally {
      if (killed) forgetSession(sessionId);
    }
  }
  async function killCreatedWindow(windowId: string): Promise<void> {
    ensureWritable();
    await run(['kill-window', '-t', guard(windowId)]);
    forgetWindow(windowId);
  }

  async function startAgent(paneId: string, cmd: string, args: string[] = []): Promise<void> {
    ensureWritable();
    guard(paneId);
    const valid = cmd === 'claude'
      ? args.length === 2 && args[0] === '--resume' && isUuid(args[1])
      : cmd === 'codex' && args.length === 2 && args[0] === 'resume' && isUuid(args[1]);
    if (!valid) throw new Error('unsafe agent command token');
    await agentRunner.prepare({ paneId, cmd, args });
    let foregroundStarted = false;
    try {
      await run(['send-keys', '-t', paneId, '-l', '--', agentRunner.command]);
      await run(['send-keys', '-t', paneId, 'Enter']);
      foregroundStarted = true;
      const ready = await agentRunner.waitReady(paneId);
      if (ready?.status !== 'ready') throw new Error(ready?.error || 'agent failed before readiness');
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (foregroundStarted) {
        try { await run(['send-keys', '-t', paneId, 'C-c']); } catch (failure) { cleanupFailures.push(failure); }
      }
      if (typeof agentRunner.cancel === 'function') {
        try { await agentRunner.cancel(paneId); } catch (failure) { cleanupFailures.push(failure); }
      }
      const cleanupError = cleanupFailures.length
        ? new Error(cleanupFailures.map(errorText).join('; '))
        : null;
      throw withCleanupError(error, cleanupError);
    }
  }

  function waitForAgents(commands: string[]): ReadonlyMap<string, Promise<import('./agentRunner.js').AgentReadiness>> {
    const waits = new Map<string, Promise<import('./agentRunner.js').AgentReadiness>>();
    for (const command of new Set(commands)) {
      if (command !== 'claude' && command !== 'codex') throw new Error('unsafe agent command token');
      waits.set(command, agentRunner.waitForExecutable(command));
    }
    return waits;
  }

  async function topologyFingerprint(): Promise<string | { status: 'unknown'; error: string }> {
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
    waitForAgents,
    topologyFingerprint,
    revokeCreatedTargets,
  };
}
