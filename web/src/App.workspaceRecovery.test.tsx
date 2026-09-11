import { StrictMode, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalProps } from './components/Terminal.jsx';
import type { WindowBarProps, WorkspaceWindow } from './components/WindowBar.jsx';
import type { WorkspaceRecoveryPlan, WorkspacePlanSession } from './workspaceRecovery.js';
import type { AgentConversationController } from './hooks/useAgentConversation.js';
import { parseConversationControls } from './agentConversationControlsApi.js';

type MockWindowBarProps = Omit<WindowBarProps,
  'onSelectWindow' | 'onManageWindow' | 'onManagePane' | 'onPaneMapOpenChange'> & {
  onSelectWindow: (window: WorkspaceWindow) => Promise<void>;
  onManageWindow: (window: WorkspaceWindow) => Promise<void>;
  onManagePane: (paneId: string) => Promise<void>;
  onPaneMapOpenChange: (open: boolean) => void;
};
type MockTerminalProps = TerminalProps & {
  onTap: () => void;
  onRequestDraft: () => void;
  onInputFocusChange: (focused: boolean) => void;
};

const api = vi.hoisted(() => ({
  getSessions: vi.fn(),
  getWindows: vi.fn(),
  getPanes: vi.fn(),
  getStates: vi.fn(),
  getAgentDiscovery: vi.fn(),
  getOrphans: vi.fn(),
  getServerVersion: vi.fn(),
  getWorkspaceProtectionStatus: vi.fn(),
  getWorkspaceRestorePlan: vi.fn(),
  startWorkspaceRestore: vi.fn(),
  getWorkspaceRestoreOperation: vi.fn(),
  resizeWindow: vi.fn(),
  resizePane: vi.fn(),
  getWindowLayout: vi.fn(),
  applyWindowLayout: vi.fn(),
  restoreWindowSize: vi.fn(),
  markAgentTerminalNotificationsRead: vi.fn(),
  fetchDoc: vi.fn(),
}));
const storage = vi.hoisted(() => ({ applyWorkspaceRestoreMapping: vi.fn() }));
const conversationApi = vi.hoisted(() => ({
  discoverAgentConversation: vi.fn(), readAgentConversationPage: vi.fn(),
  sendAgentConversationMessage: vi.fn(),
}));
const conversation = vi.hoisted(() => ({ controller: null as AgentConversationController | null }));
const controlsInput = vi.hoisted(() => ({ run: null as unknown, enabled: false }));
const controlsApi = vi.hoisted(() => ({ readConversationControls: vi.fn() }));
const controlRequestProbe = vi.hoisted(() => ({
  holdConsumption: false,
  model: null as { id: number; consume: ((id: number) => void) | undefined } | null,
  goal: null as { id: number; consume: ((id: number) => void) | undefined } | null,
}));
vi.mock('./components/AgentModelControl.jsx', async (importOriginal) => {
  const original = await importOriginal<typeof import('./components/AgentModelControl.js')>();
  return { ...original, default: (props: ComponentProps<typeof original.default>) => {
    controlRequestProbe.model = { id: props.openRequest ?? 0, consume: props.onOpenRequestConsumed };
    return <original.default {...props} onOpenRequestConsumed={(id) => {
      if (!controlRequestProbe.holdConsumption) props.onOpenRequestConsumed?.(id);
    }} />;
  } };
});
vi.mock('./components/AgentConversationCapabilityControls.jsx', async (importOriginal) => {
  const original = await importOriginal<typeof import('./components/AgentConversationCapabilityControls.js')>();
  return { ...original, AgentConversationMilestoneControls: (
    props: ComponentProps<typeof original.AgentConversationMilestoneControls>,
  ) => {
    controlRequestProbe.goal = { id: props.goalOpenRequest ?? 0, consume: props.onGoalOpenRequestConsumed };
    return <original.AgentConversationMilestoneControls {...props} onGoalOpenRequestConsumed={(id) => {
      if (!controlRequestProbe.holdConsumption) props.onGoalOpenRequestConsumed?.(id);
    }} />;
  } };
});
vi.mock('./agentSessionControlApi.js', () => ({
  readAgentModelControl: vi.fn(async () => ({ models: [], selected: { model: null, effort: null }, canUpdate: true })),
  updateAgentModelControl: vi.fn(),
}));
const recoveryApi = vi.hoisted(() => ({ getConversationActivationRecovery: vi.fn() }));
vi.mock('./hooks/useAgentConversationControls.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./hooks/useAgentConversationControls.js')>();
  return { ...original, useAgentConversationControls: (...args: Parameters<typeof original.useAgentConversationControls>) => {
    controlsInput.run = args[0];
    controlsInput.enabled = args[1];
    return original.useAgentConversationControls(...args);
  } };
});
vi.mock('./agentConversationControlsApi.js', async (importOriginal) => ({
  ...(await importOriginal()), ...controlsApi,
}));
vi.mock('./hooks/useAgentConversation.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./hooks/useAgentConversation.js')>();
  return { ...original, useAgentConversation: (...args: Parameters<typeof original.useAgentConversation>) => {
    conversation.controller = original.useAgentConversation(...args);
    return conversation.controller;
  } };
});
vi.mock('./agentConversationApi.js', async (importOriginal) => ({
  ...(await importOriginal()), ...conversationApi,
}));
vi.mock('./agentConversationActivationApi.js', async (importOriginal) => ({
  ...(await importOriginal()), ...recoveryApi,
}));
const push = vi.hoisted(() => ({ getNotifications: vi.fn(), clearPaneNotification: vi.fn() }));
const windowBar = vi.hoisted((): { props: WindowBarProps | null } => ({ props: null }));
const terminal = vi.hoisted(() => ({
  props: null as TerminalProps | null,
  focusInput: vi.fn(),
  blurInput: vi.fn(),
  forwardPageKey: vi.fn(),
}));
const bottomDock = vi.hoisted(() => ({ focusComposer: vi.fn() }));
const backButtons = vi.hoisted(() => ({ active: [] as Array<() => void> }));
const overlayActivity = vi.hoisted(() => {
  const state = {
    active: false,
    listeners: new Set<() => void>(),
    set(active: boolean) {
      state.active = active;
      for (const listener of [...state.listeners]) listener();
    },
  };
  return state;
});

vi.mock('./api.js', async (importOriginal) => ({ ...(await importOriginal()), ...api }));
vi.mock('./storage.js', async (importOriginal) => ({
  ...(await importOriginal()),
  applyWorkspaceRestoreMapping: storage.applyWorkspaceRestoreMapping,
}));
vi.mock('./push.js', async (importOriginal) => ({
  ...(await importOriginal()),
  reportBound: vi.fn(),
  clearPaneNotification: push.clearPaneNotification,
  getNotifications: push.getNotifications,
  deleteNotification: vi.fn(async () => {}),
  notifyEnabled: () => false,
  enableNotifications: vi.fn(),
  disableNotifications: vi.fn(),
  pushSupported: () => false,
  getScriptPushKey: vi.fn(async () => null),
}));
vi.mock('./hooks/usePreviews.js', () => ({
  usePreviews: () => ({
    error: null,
    selected: false,
    deactivate: vi.fn(),
    shownPreview: null,
    tabs: [],
    activeName: null,
    startPreview: vi.fn(),
    retryPreview: vi.fn(),
    switchTab: vi.fn(),
    closeTab: vi.fn(),
  }),
}));
vi.mock('./useClaudeHooks.js', () => ({ useClaudeHooks: () => ({ status: 'installed', enable: vi.fn() }) }));
vi.mock('./hooks/useBackButton.js', () => ({
  useBackButton: (active: boolean, onClose: () => void) => { if (active) backButtons.active.push(onClose); },
  useHistoryLayer: () => {},
  unwindHistory: () => {},
}));
vi.mock('./hooks/useExitConfirm.js', () => ({ useExitConfirm: () => {} }));
vi.mock('./hooks/useKeyboardInset.js', () => ({ useKeyboardInset: () => 0 }));
vi.mock('./hooks/useOverlayActivity.js', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useOverlayActivity: () => useSyncExternalStore(
      (listener) => {
        overlayActivity.listeners.add(listener);
        return () => overlayActivity.listeners.delete(listener);
      },
      () => overlayActivity.active,
      () => overlayActivity.active,
    ),
  };
});
vi.mock('./hooks/usePageScrollLock.js', () => ({ usePageScrollLock: () => {} }));
vi.mock('./hooks/useLongPress.js', () => ({ useLongPress: () => ({}) }));
vi.mock('./desktopInput.js', () => ({
  desktopInputEnvironment: () => true,
  getKeyboardMode: () => 'auto',
  setKeyboardMode: vi.fn(),
  keyboardModeUsesDesktop: () => true,
}));

vi.mock('./components/WindowBar.jsx', () => ({
  default: (props: WindowBarProps) => { windowBar.props = props; return null; },
}));
vi.mock('./components/BottomDock.jsx', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    default: forwardRef((_props, ref) => {
      useImperativeHandle(ref, () => ({
        focusComposer: bottomDock.focusComposer,
        composerFocused: () => false,
      }), []);
      return null;
    }),
  };
});
vi.mock('./components/Terminal.jsx', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    default: forwardRef((props: TerminalProps, ref) => {
      terminal.props = props;
      useImperativeHandle(ref, () => ({
        focusInput: () => {
          terminal.focusInput();
          props.onInputFocusChange?.(true);
        },
        blurInput: () => {
          terminal.blurInput();
          props.onInputFocusChange?.(false);
        },
        forwardPageKey: terminal.forwardPageKey,
      }), [props.onInputFocusChange]);
      return <div data-testid="terminal-pane">{props.pane}</div>;
    }),
  };
});

import App from './App.jsx';
import { ApiError, UnauthorizedError } from './api.js';
import { buildDeepLink } from './hashRoute.js';
import { getBoundSessions, getWorkspacePromptState } from './storage.js';

const ACTIVE_SESSION = '10000000-0000-4000-8000-000000000001';
const ACTIVE_WINDOW = '20000000-0000-4000-8000-000000000001';
const ACTIVE_PANE = '30000000-0000-4000-8000-000000000001';

interface RecoverySessionFixture extends WorkspacePlanSession {
  activeWindowId?: string;
  windowLinks?: Array<{ windowId: string; index: number }>;
}

interface RecoveryPlanFixture extends Omit<WorkspaceRecoveryPlan, 'sessions'> {
  sessions?: RecoverySessionFixture[];
  active?: { sessionId: string; windowId: string; paneId: string };
}

const activePlan = (overrides: Partial<RecoveryPlanFixture> = {}): RecoveryPlanFixture => ({
  checkpointId: 'checkpoint-a',
  capturedAt: '2026-07-20T01:42:00.000Z',
  changeReason: 'boot-changed',
  promptEligible: true,
  resolved: false,
  pendingCount: 1,
  summary: { sessions: 1, windows: 1, panes: 2, agents: 0 },
  planSummary: { create: 1, renamed: 0, alreadyPresent: 0, unsupported: 0 },
  sessions: [{
    logicalId: ACTIVE_SESSION,
    sourceName: 'project',
    targetName: 'project-restored',
    action: 'create-renamed',
    activeWindowId: ACTIVE_WINDOW,
    windowLinks: [{ windowId: ACTIVE_WINDOW, index: 0 }],
  }],
  active: { sessionId: ACTIVE_SESSION, windowId: ACTIVE_WINDOW, paneId: ACTIVE_PANE },
  mapping: null,
  ...overrides,
});
const resolvedPlan = (overrides: Partial<RecoveryPlanFixture> = {}): RecoveryPlanFixture => activePlan({
  promptEligible: false,
  resolved: true,
  pendingCount: 0,
  planSummary: { create: 0, renamed: 0, alreadyPresent: 0, unsupported: 0 },
  sessions: [],
  ...overrides,
});

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await Promise.resolve();
  });
};

const deferred = <T = unknown>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const windowBarProps = (): MockWindowBarProps => {
  if (!windowBar.props) throw new Error('expected WindowBar props');
  return windowBar.props as MockWindowBarProps;
};

const terminalProps = (): MockTerminalProps => {
  if (!terminal.props) throw new Error('expected Terminal props');
  return terminal.props as MockTerminalProps;
};

const requiredElement = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`expected element: ${selector}`);
  return element;
};

async function renderApp() {
  const view = render(<App />);
  await flush();
  await flush();
  return view;
}

beforeEach(() => {
  controlRequestProbe.holdConsumption = false;
  controlRequestProbe.model = null;
  controlRequestProbe.goal = null;
  vi.useFakeTimers();
  Object.values(conversationApi).forEach((mock) => mock.mockReset());
  controlsApi.readConversationControls.mockReset().mockResolvedValue({});
  recoveryApi.getConversationActivationRecovery.mockReset().mockResolvedValue(null);
  Object.values(api).forEach((mock) => mock.mockReset());
  storage.applyWorkspaceRestoreMapping.mockReset();
  push.getNotifications.mockReset();
  push.clearPaneNotification.mockReset();
  windowBar.props = null;
  terminal.props = null;
  terminal.focusInput.mockReset();
  terminal.blurInput.mockReset();
  terminal.forwardPageKey.mockReset();
  bottomDock.focusComposer.mockReset();
  backButtons.active = [];
  overlayActivity.active = false;
  overlayActivity.listeners.clear();
  localStorage.clear();
  localStorage.setItem('tw_lang', 'zh');
  localStorage.setItem('tw_token', 'good');
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network access is forbidden in Task11 tests'); }));

  api.getSessions.mockResolvedValue([]);
  api.getWindows.mockResolvedValue([]);
  api.getPanes.mockResolvedValue([]);
  api.getStates.mockResolvedValue({});
  api.getAgentDiscovery.mockResolvedValue({ descriptors: [], runs: [], health: [] });
  api.getOrphans.mockResolvedValue([]);
  api.getServerVersion.mockResolvedValue({ current: '0.0.0', latest: '0.0.0', updateAvailable: false });
  api.getWorkspaceProtectionStatus.mockResolvedValue({ status: 'protected', errorCode: null });
  api.getWorkspaceRestorePlan.mockResolvedValue(null);
  api.startWorkspaceRestore.mockResolvedValue({ operationId: 'operation-a', status: 'pending' });
  api.getWorkspaceRestoreOperation.mockResolvedValue({ id: 'operation-a', status: 'pending', progress: { completed: 0, total: 1 }, results: [] });
  api.resizeWindow.mockResolvedValue({ ok: true });
  api.resizePane.mockResolvedValue({ ok: true });
  api.getWindowLayout.mockResolvedValue({ layout: '80x24,0,0{40x24,0,0,1,39x24,41,0,2}' });
  api.applyWindowLayout.mockResolvedValue({ ok: true });
  api.restoreWindowSize.mockResolvedValue({ ok: true });
  api.markAgentTerminalNotificationsRead.mockResolvedValue({ ok: true });
  api.fetchDoc.mockResolvedValue({ type: 'markdown', name: '数据现状.md', content: '# 数据现状' });
  push.getNotifications.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  history.replaceState(history.state, '', '#');
});

describe('App hidden Project Task beta', () => {
  it('marks a detected desktop so conversation text keeps native selection', async () => {
    const view = await renderApp();
    expect(view.container.querySelector('.app')?.getAttribute('data-desktop-input')).toBe('true');
  });

  it('ignores an old development flag and keeps the unfinished surface unreachable', async () => {
    localStorage.setItem('hm_project_task_beta', '1');
    localStorage.setItem('hm_root_view', 'project');
    const view = await renderApp();
    expect(view.container.querySelector('.project-root')).toBeNull();
    expect(view.container.querySelector('.topbar')).toBeTruthy();
  });
});

describe.each(['claude', 'codex', 'pi'])('App %s conversation activity', (agentId) => {
  it.each([
    { activity: 'working', legacy: null, queued: false },
    { activity: 'compacting', legacy: null, queued: false },
    { activity: 'idle', legacy: 'working', queued: false },
    { activity: 'idle', legacy: null, queued: true },
    { activity: 'unknown', legacy: 'working', queued: true },
    { activity: 'waiting', legacy: 'working', queued: true },
  ])('renders authoritative activity $activity over legacy $legacy with queued=$queued', async ({ activity, legacy, queued }) => {
    const pane = { id: '%73', active: true, width: 80, height: 24, command: agentId, cwd: '/work', agent: agentId };
    const run = { agentId, paneId: pane.id, runId: 'activity-run', sessionId: 'activity-session' };
    localStorage.setItem('tw_bound', JSON.stringify(['project']));
    localStorage.setItem(`tw_lens_${pane.id}`, 'chat');
    api.getSessions.mockResolvedValue([{ id: '$71', name: 'project' }]);
    api.getWindows.mockResolvedValue([{ id: '@71', name: 'main', active: true, panes: 1 }]);
    api.getPanes.mockResolvedValue([pane]);
    api.getStates.mockResolvedValue(legacy ? {
      [pane.id]: { agent: agentId, kind: legacy, session: 'project', window: '@71' },
    } : {});
    api.getAgentDiscovery.mockResolvedValue({
      descriptors: [{ id: agentId, label: agentId, capabilities: { conversation: true } }],
      runs: [run], health: [],
    });
    conversationApi.discoverAgentConversation.mockResolvedValue({
      session: { agentId: run.agentId, sessionId: run.sessionId }, run,
      viewId: run.sessionId, historyVersion: '1', capabilities: { history: true, live: 'poll', send: ['prompt'] },
    });
    conversationApi.readAgentConversationPage.mockResolvedValue({
      status: 'ok', page: { sessionId: run.sessionId, viewId: run.sessionId,
        historyVersion: '1', hasMore: false, items: [{ id: 'answer', kind: 'message',
          role: 'assistant', content: [{ type: 'text', text: 'Previous Claude answer' }] }] },
    });
    controlsApi.readConversationControls.mockImplementation(async () => parseConversationControls({
      activity,
      ...(agentId === 'claude' ? {} : { context: { activity: 'working' } }),
      queue: {
        activity,
        items: queued ? [{ id: 'queued', text: 'Next task', createdAt: 1, state: 'queued' }] : [],
        canSteer: false, canEdit: true, canRemove: true,
      },
      submissions: [],
    }));
    const view = await renderApp();
    expect(screen.getByText('Previous Claude answer')).toBeTruthy();
    expect(controlsInput.enabled).toBe(true);
    expect(controlsApi.readConversationControls).toHaveBeenCalled();
    expect(view.container.querySelector('.chat-typing') !== null).toBe(activity === 'working');
    expect(view.container.querySelector('.chat-compacting') !== null).toBe(activity === 'compacting');
    if (activity === 'compacting') expect(view.container.querySelector('.chat-compacting .chat-typing-dots')).toBeTruthy();
  });
});

describe('App established conversation during server restart', () => {
  const pane = { id: '%73', active: true, width: 80, height: 24, command: 'codex', cwd: '/work', agent: 'codex' };
  const run = { agentId: 'codex', paneId: pane.id, runId: 'before-restart', sessionId: 'session-1' };
  const descriptors = [{ id: 'codex', label: 'Codex', capabilities: { conversation: true } }];
  async function openConversation() {
    localStorage.setItem('tw_bound', JSON.stringify(['project']));
    localStorage.setItem(`tw_lens_${pane.id}`, 'chat');
    api.getSessions.mockResolvedValue([{ id: '$71', name: 'project' }]);
    api.getWindows.mockResolvedValue([{ id: '@71', name: 'main', active: true, panes: 1 }]);
    api.getPanes.mockResolvedValue([pane]);
    api.getAgentDiscovery.mockResolvedValue({ descriptors, runs: [run], health: [] });
    conversationApi.discoverAgentConversation.mockImplementation(async (activeRun) => ({
      session: { agentId: activeRun.agentId, sessionId: activeRun.sessionId }, run: activeRun,
      viewId: activeRun.sessionId, historyVersion: '1', capabilities: { history: true, live: 'poll', send: ['prompt'] },
    }));
    conversationApi.readAgentConversationPage.mockImplementation(async (activeRun) => ({
      status: 'ok', page: { sessionId: activeRun.sessionId, viewId: activeRun.sessionId,
        historyVersion: '1', hasMore: false, items: [{ id: 'message-1', kind: 'message',
          role: 'assistant', content: [{ type: 'text', text: `Saved answer ${activeRun.sessionId}` }] }] },
    }));
    await renderApp();
    expect(screen.getByText('Saved answer session-1')).toBeTruthy();
    expect(controlsInput.enabled).toBe(true);
  }

  it('discards a temporary unknown on actual window navigation and return while retaining formal history', async () => {
    await openConversation();
    conversationApi.sendAgentConversationMessage.mockResolvedValue({ status: 'unknown' });
    await act(async () => { await conversation.controller!.send('temporary unknown').catch(() => {}); });
    expect(screen.getByText('temporary unknown')).toBeTruthy();
    const first = { id: '@71', name: 'main', active: true, panes: 1, activePaneId: pane.id };
    const second = { id: '@72', name: 'other', active: false, panes: 1, activePaneId: '%74' };
    api.getWindows.mockResolvedValue([first, second]);
    api.getPanes.mockResolvedValue([{ ...pane, id: '%74', agent: null, command: 'zsh' }]);
    await act(async () => { await windowBarProps().onSelectWindow(second); });
    expect(screen.queryByText('temporary unknown')).toBeNull();
    api.getPanes.mockResolvedValue([pane]);
    await act(async () => { await windowBarProps().onSelectWindow(first); });
    await flush();
    expect(screen.getByText('Saved answer session-1')).toBeTruthy();
    expect(screen.queryByText('temporary unknown')).toBeNull();
    expect(conversation.controller?.localSubmissions).toEqual([]);
  });

  it('keeps nonempty settled controls idempotent through real App renders and accepted expiry', async () => {
    controlsApi.readConversationControls.mockResolvedValue({
      activity: 'idle', submissions: [],
      queue: { items: [], settled: [{ id: 'historical', nativeId: 'historical-item' }],
        canSteer: false, canEdit: true, canRemove: true },
    });
    await openConversation();
    conversationApi.sendAgentConversationMessage.mockResolvedValue({ status: 'accepted' });
    await act(async () => { await conversation.controller!.send('temporary accepted'); });
    expect(screen.getByText('temporary accepted')).toBeTruthy();
    await flush(10_000);
    expect(screen.getByText('temporary accepted')).toBeTruthy();
    expect(controlsApi.readConversationControls.mock.calls.length).toBeLessThan(30);
    await flush(110_000);
    expect(screen.queryByText('temporary accepted')).toBeNull();
    expect(screen.getByText('Saved answer session-1')).toBeTruthy();
    expect(conversation.controller?.submissionReceipts).toEqual(expect.arrayContaining([
      { id: 'historical', nativeId: 'historical-item' },
    ]));
    // Normal 750ms polling across two minutes stays bounded despite settled-state rerenders.
    expect(controlsApi.readConversationControls.mock.calls.length).toBeLessThan(180);
  });

  it.each(['request failure', 'empty discovery', 'missing descriptor', 'canonical null', 'null before discovery', 'sessionless run'])(
    'retains content and chat selection through %s and resumes the same session', async (gap) => {
      await openConversation();
      const readPage = conversationApi.readAgentConversationPage.getMockImplementation()!;
      if (gap === 'request failure') {
        api.getAgentDiscovery.mockRejectedValue(new Error('server restarting'));
        api.getPanes.mockRejectedValue(new Error('server restarting'));
        conversationApi.readAgentConversationPage.mockRejectedValue(new Error('server restarting'));
      } else {
        api.getAgentDiscovery.mockResolvedValue({
          descriptors: ['empty discovery', 'missing descriptor'].includes(gap) ? [] : descriptors,
          runs: ['missing descriptor', 'null before discovery'].includes(gap) ? [run]
            : gap === 'sessionless run' ? [{ agentId: 'codex', paneId: pane.id, runId: 'starting' }] : [],
          health: [],
        });
        if (['canonical null', 'null before discovery'].includes(gap)) api.getPanes.mockResolvedValue([{ ...pane, agent: null }]);
      }
      await flush(5_000);
      expect(screen.getByText('Saved answer session-1')).toBeTruthy();
      expect(screen.queryByTestId('terminal-pane')).toBeNull();
      expect(localStorage.getItem(`tw_lens_${pane.id}`)).toBe('chat');
      if (gap !== 'request failure') {
        expect(conversation.controller?.status).toBe('reconnecting');
        await expect(conversation.controller!.send('must not reach an unverified process')).rejects.toThrow();
        expect(conversationApi.sendAgentConversationMessage).not.toHaveBeenCalled();
        expect(controlsInput.run).toBeNull();
        expect(controlsInput.enabled).toBe(false);
      }
      api.getPanes.mockResolvedValue([pane]);
      conversationApi.readAgentConversationPage.mockImplementation(readPage);
      api.getAgentDiscovery.mockResolvedValue({ descriptors, runs: [{ ...run, runId: 'after-restart' }], health: [] });
      await flush(10_000);
      expect(conversationApi.discoverAgentConversation).toHaveBeenCalledWith(expect.objectContaining({ runId: 'after-restart' }));
      expect(screen.getByText('Saved answer session-1')).toBeTruthy();
      expect(conversation.controller?.status).toBe('ready');
    },
  );

  it.each(['codex', 'pi'])('clears old content when discovery verifies a replacement %s session', async (agentId) => {
    await openConversation();
    api.getPanes.mockResolvedValue([{ ...pane, agent: agentId }]);
    api.getAgentDiscovery.mockResolvedValue({
      descriptors: [{ id: agentId, label: agentId, capabilities: { conversation: true } }],
      runs: [{ ...run, agentId, runId: 'replacement', sessionId: 'session-2' }], health: [],
    });
    await flush(5_000);
    expect(screen.queryByText('Saved answer session-1')).toBeNull();
    expect(screen.getByText('Saved answer session-2')).toBeTruthy();
    expect(localStorage.getItem(`tw_lens_${pane.id}`)).toBe('chat');
  });

  it('revokes the old lease when /panes identifies a different Agent before discovery catches up', async () => {
    await openConversation();
    api.getPanes.mockResolvedValue([{ ...pane, agent: 'pi' }]);
    await flush(5_000);
    expect(screen.queryByText('Saved answer session-1')).toBeNull();
    await expect(conversation.controller!.send('must not reach Codex')).rejects.toThrow();
    expect(conversation.controller?.items).toEqual([]);
    expect(localStorage.getItem(`tw_lens_${pane.id}`)).toBe('chat');
  });

  it('does not replace established history with a durable takeover receipt during a discovery gap', async () => {
    recoveryApi.getConversationActivationRecovery.mockResolvedValue({
      operationId: 'a'.repeat(64), phase: 'interrupted', state: 'current', canResume: true,
      recovery: { kind: 'codex_resume', sessionId: 'session-1', command: 'handmux codex resume session-1' },
    });
    await openConversation();
    api.getPanes.mockResolvedValue([{ ...pane, agent: null }]);
    api.getAgentDiscovery.mockResolvedValue({ descriptors, runs: [], health: [] });
    await flush(5_000);
    expect(screen.getByText('Saved answer session-1')).toBeTruthy();
    expect(conversation.controller?.status).toBe('reconnecting');
    expect(controlsInput.run).toBeNull();
  });

  it('does not resurrect remembered history after explicitly leaving chat for a shell', async () => {
    await openConversation();
    act(() => windowBarProps().onLensChange?.('terminal'));
    api.getPanes.mockResolvedValue([{ ...pane, agent: null }]);
    api.getAgentDiscovery.mockResolvedValue({ descriptors, runs: [], health: [] });
    await flush(5_000);
    expect(screen.getByTestId('terminal-pane')).toBeTruthy();
    expect(localStorage.getItem(`tw_chat_agent_${pane.id}`)).toBeNull();
    expect(conversation.controller?.items).toEqual([]);
  });
});

describe('App live tmux topology recovery', () => {
  const oldSession = { id: '$71', name: 'project' };
  const oldWindow = { id: '@71', name: 'main', active: true, panes: 1 };
  const oldPane = { id: '%73', active: true, width: 80, height: 24, command: 'zsh', cwd: '/work' };
  const newSession = { id: '$1', name: 'project' };
  const newWindow = { id: '@3', name: 'main', active: true, panes: 1 };
  const newPane = { id: '%4', active: true, width: 80, height: 24, command: 'zsh', cwd: '/work' };

  it('switches to a surviving pane when the remembered pane is closed externally', async () => {
    const refreshed = deferred<typeof oldPane[]>();
    localStorage.setItem('tw_bound', JSON.stringify([oldSession.name]));
    api.getSessions.mockResolvedValue([oldSession]);
    api.getWindows.mockResolvedValue([oldWindow]);
    api.getPanes
      .mockResolvedValueOnce([oldPane])
      .mockReturnValueOnce(refreshed.promise)
      .mockResolvedValue([newPane]);

    await renderApp();
    expect(screen.getByTestId('terminal-pane').textContent).toBe(oldPane.id);

    refreshed.resolve([newPane]);
    await flush();
    expect(screen.getByTestId('terminal-pane').textContent).toBe(newPane.id);
  });

  it('reopens the same session by name after tmux recreates every topology id', async () => {
    const missing = deferred<typeof oldPane[]>();
    localStorage.setItem('tw_bound', JSON.stringify([oldSession.name]));
    api.getSessions.mockResolvedValueOnce([oldSession]).mockResolvedValue([newSession]);
    api.getWindows.mockResolvedValueOnce([oldWindow]).mockResolvedValue([newWindow]);
    api.getPanes
      .mockResolvedValueOnce([oldPane])
      .mockReturnValueOnce(missing.promise)
      .mockResolvedValue([newPane]);

    await renderApp();
    expect(screen.getByTestId('terminal-pane').textContent).toBe(oldPane.id);

    missing.reject(new ApiError('window not found', 404, 'window not found'));
    await flush();
    await flush();

    expect(api.getSessions.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.getWindows).toHaveBeenLastCalledWith(newSession.id);
    expect(screen.getByTestId('terminal-pane').textContent).toBe(newPane.id);
  });
});

describe('App document-link transition', () => {
  async function renderDocumentSession() {
    const session = { id: '$docs', name: 'docs' };
    const workspaceWindow = { id: '@docs', name: 'main', active: true, panes: 1 };
    const pane = {
      id: '%docs', active: true, width: 80, height: 24, command: 'codex', cwd: '/work',
      left: 0, top: 0,
    };
    localStorage.setItem('tw_bound', JSON.stringify([session.name]));
    api.getSessions.mockResolvedValue([session]);
    api.getWindows.mockResolvedValue([workspaceWindow]);
    api.getPanes.mockResolvedValue([pane]);
    return renderApp();
  }

  const finishConfirmationPop = () => {
    // useBackButton owns the real popstate listener; this focused App test mocks it and invokes the
    // active confirmation layer callback to model that pop completing.
    const closeConfirmation = backButtons.active.at(-1);
    expect(closeConfirmation).toBeTruthy();
    act(() => closeConfirmation?.());
  };

  it('finishes closing the confirmation history layer before opening a Chinese document', async () => {
    const view = await renderDocumentSession();

    act(() => terminalProps().onDocLinkTap?.(
      { kind: 'doc', path: '/work/数据现状.md' }, 20, 30,
    ));
    const open = requiredElement<HTMLButtonElement>(document, '.doclink-open');
    fireEvent.click(open);
    expect(api.fetchDoc).not.toHaveBeenCalled();

    finishConfirmationPop();
    await flush();
    await flush();

    expect(api.fetchDoc).toHaveBeenCalledWith('/work/数据现状.md');
    expect(document.querySelector('.file-sheet.open')).toBeTruthy();
    expect(view.baseElement.textContent).toContain('数据现状.md');
  });

  it('keeps the directory picker open when a relative Chinese document is not under the pane cwd', async () => {
    api.fetchDoc.mockRejectedValueOnce(new Error('/api/file -> 404'));
    await renderDocumentSession();

    act(() => terminalProps().onDocLinkTap?.(
      { kind: 'doc', path: './数据现状.md' }, 20, 30,
    ));
    fireEvent.click(requiredElement<HTMLButtonElement>(document, '.doclink-open'));
    finishConfirmationPop();
    await flush();
    await flush();

    expect(api.fetchDoc).toHaveBeenCalledWith('/work/数据现状.md');
    expect(document.querySelector('.dirpick-card')).toBeTruthy();
    expect(document.body.textContent).toContain('./数据现状.md');
  });
});

describe('App visible-pane acknowledgement', () => {
  it('keeps a pane unread while a full-screen tool obscures the Session workspace', async () => {
    const session = { id: '$visible', name: 'visible' };
    const workspaceWindow = { id: '@visible', name: 'main', active: true, panes: 1 };
    const pane = {
      id: '%visible', active: true, width: 80, height: 24, command: 'codex', cwd: '/repo',
      left: 0, top: 0,
    };
    localStorage.setItem('tw_bound', JSON.stringify([session.name]));
    api.getSessions.mockResolvedValue([session]);
    api.getWindows.mockResolvedValue([workspaceWindow]);
    api.getPanes.mockResolvedValue([pane]);
    api.getStates.mockResolvedValue({});
    await renderApp();
    push.clearPaneNotification.mockReset();
    api.markAgentTerminalNotificationsRead.mockClear();

    act(() => overlayActivity.set(true));
    api.getStates.mockResolvedValue({
      [pane.id]: {
        session: session.name, window: workspaceWindow.id, windowName: workspaceWindow.name,
        kind: 'done', msg: 'finished behind settings', ts: 10,
        terminalUnread: true, terminalNotificationId: 'notification-visible',
      },
    });
    await flush(5_000);

    expect(push.clearPaneNotification).not.toHaveBeenCalledWith(pane.id);
    expect(api.markAgentTerminalNotificationsRead).not.toHaveBeenCalled();

    act(() => overlayActivity.set(false));
    await flush();
    expect(push.clearPaneNotification).toHaveBeenCalledWith(pane.id);
    expect(api.markAgentTerminalNotificationsRead)
      .toHaveBeenCalledWith(['notification-visible']);
  });
});

describe('App management dimensions', () => {
  const session = { id: '$7', name: 'current' };
  const staleWindow = { id: '@1', name: 'work', active: true, panes: 2, width: 80, height: 24 };
  const stalePanes = [
    { id: '%1', active: true, width: 39, height: 24, command: 'zsh', cwd: '/work', left: 0, top: 0 },
    { id: '%2', active: false, width: 40, height: 24, command: 'node', cwd: '/work', left: 40, top: 0 },
  ];

  async function renderManagedSession() {
    localStorage.setItem('tw_bound', JSON.stringify([session.name]));
    api.getSessions.mockResolvedValue([session]);
    api.getWindows.mockResolvedValue([staleWindow]);
    api.getPanes.mockResolvedValue(stalePanes);
    const view = await renderApp();
    expect(windowBar.props).toBeTruthy();
    return view;
  }

  it('refreshes the window dimensions from tmux before opening window management', async () => {
    await renderManagedSession();
    api.getWindows.mockResolvedValueOnce([{ ...staleWindow, width: 160, height: 48 }]);

    await act(async () => { await windowBarProps().onManageWindow(staleWindow); });

    expect(screen.getByRole('dialog', { name: '窗口管理，work · 160×48' })).toBeTruthy();
    expect(api.getWindows).toHaveBeenCalledTimes(2);
  });

  it('resizes a lone-pane window from Window Management', async () => {
    const loneWindow = { ...staleWindow, panes: 1 };
    const lonePane = [{ ...stalePanes[0], width: 80 }];
    localStorage.setItem('tw_bound', JSON.stringify([session.name]));
    api.getSessions.mockResolvedValue([session]);
    api.getWindows.mockResolvedValue([loneWindow]);
    api.getPanes.mockResolvedValue(lonePane);
    await renderApp();

    await act(async () => { await windowBarProps().onManageWindow(loneWindow); });
    expect(screen.getByRole('button', { name: /左右分屏/ }).closest('.sheet-row'))
      .toBe(screen.getByRole('button', { name: /上下分屏/ }).closest('.sheet-row'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '窗口宽度 +1' }));
      await Promise.resolve();
    });

    expect(api.resizeWindow).toHaveBeenCalledWith('@1', 81);
    expect(screen.getByText('81 列')).toBeTruthy();
  });

  it('does not expose whole-window width for a multi-pane window', async () => {
    const view = await renderManagedSession();
    await act(async () => { await windowBarProps().onManageWindow(staleWindow); });
    expect(view.container.querySelector('.sheet-size-control')).toBeNull();
  });

  it('refreshes the pane dimensions from tmux before opening split management', async () => {
    await renderManagedSession();
    const callsBeforeOpen = api.getPanes.mock.calls.length;
    api.getPanes.mockResolvedValueOnce(stalePanes.map((pane) => (
      pane.id === '%1' ? { ...pane, width: 59, height: 30 } : { ...pane, width: 60, height: 30, left: 60 }
    )));

    await act(async () => { await windowBarProps().onManagePane('%1'); });

    expect(screen.getByRole('dialog', { name: '分屏管理，① zsh · 59×30' })).toBeTruthy();
    expect(api.getPanes).toHaveBeenCalledTimes(callsBeforeOpen + 1);
  });

  it('resizes the selected side-by-side pane and restores only its saved split ratio', async () => {
    await renderManagedSession();
    await act(async () => { await windowBarProps().onManagePane('%1'); });
    expect(screen.getByRole('button', { name: /左右分屏/ }).closest('.sheet-row')).toBeNull();
    expect(screen.getByRole('button', { name: /上下分屏/ }).closest('.sheet-row')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '窗格宽度 +1' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getWindowLayout).toHaveBeenCalledWith('@1');
    expect(api.resizePane).toHaveBeenCalledWith('%1', 40);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '窗格宽度 +1' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getWindowLayout).toHaveBeenCalledOnce();
    expect(api.resizePane).toHaveBeenLastCalledWith('%1', 41);
    expect(screen.getByText('41 列')).toBeTruthy();

    const restore = screen.getByRole('button', { name: /恢复分屏比例/ });
    if (!(restore instanceof HTMLButtonElement)) throw new Error('expected restore button');
    expect(restore.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(restore);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.applyWindowLayout).toHaveBeenCalledWith('@1', '80x24,0,0{40x24,0,0,1,39x24,41,0,2}');
    expect(api.restoreWindowSize).not.toHaveBeenCalled();
  });

  it('does not show a pane-width control for a pure top/bottom split', async () => {
    const stack = [
      { ...stalePanes[0], width: 80, height: 12, left: 0, top: 0 },
      { ...stalePanes[1], width: 80, height: 11, left: 0, top: 13 },
    ];
    localStorage.setItem('tw_bound', JSON.stringify([session.name]));
    api.getSessions.mockResolvedValue([session]);
    api.getWindows.mockResolvedValue([staleWindow]);
    api.getPanes.mockResolvedValue(stack);
    const view = await renderApp();

    await act(async () => { await windowBarProps().onManagePane('%1'); });
    expect(view.container.querySelector('.sheet-size-control')).toBeNull();
  });

  it('refreshes pane geometry from tmux before opening the pane map', async () => {
    await renderManagedSession();
    const callsBeforeOpen = api.getPanes.mock.calls.length;
    api.getPanes.mockResolvedValueOnce(stalePanes.map((pane) => (
      pane.id === '%1' ? { ...pane, width: 59, height: 30 } : { ...pane, width: 60, height: 30, left: 60 }
    )));

    await act(async () => { await windowBarProps().onBeforePaneMapOpen?.('@1'); });

    expect(windowBarProps().panes.find((pane) => pane.id === '%1')).toMatchObject({ width: 59, height: 30 });
    expect(api.getPanes).toHaveBeenCalledTimes(callsBeforeOpen + 1);
  });

  it('keeps a pane switched under the pane map unfocused and restores the prior terminal owner on close', async () => {
    await renderManagedSession();
    act(() => terminalProps().onInputFocusChange(true));

    act(() => {
      windowBarProps().onPaneMapOpenChange(true);
      overlayActivity.set(true);
    });
    await flush();
    expect(terminal.blurInput).toHaveBeenCalled();
    expect(terminalProps().autoFocusInput).toBe(false);

    act(() => windowBarProps().onSelectPane('%2'));
    await flush();
    expect(terminalProps().pane).toBe('%2');
    expect(terminalProps().autoFocusInput).toBe(false);
    expect(terminal.focusInput).not.toHaveBeenCalled();

    act(() => {
      windowBarProps().onPaneMapOpenChange(false);
      overlayActivity.set(false);
    });
    await flush(20);
    expect(terminal.focusInput).toHaveBeenCalledOnce();
  });

  it('returns desktop keyboard ownership to the terminal when the terminal is tapped', async () => {
    await renderManagedSession();

    act(() => terminalProps().onTap());

    expect(terminal.focusInput).toHaveBeenCalledOnce();
  });

  it('moves desktop keyboard ownership into the draft on Shift+Enter', async () => {
    await renderManagedSession();

    act(() => terminalProps().onRequestDraft());

    expect(terminal.blurInput).toHaveBeenCalledOnce();
    expect(bottomDock.focusComposer).toHaveBeenCalledOnce();
  });

  it('keeps page-level physical keys connected to the terminal after toolbar focus', async () => {
    const view = await renderManagedSession();
    terminal.forwardPageKey.mockReturnValue(true);
    const toolbarButton = document.createElement('button');
    view.container.append(toolbarButton);
    toolbarButton.focus();

    fireEvent.keyDown(toolbarButton, { key: 'a', code: 'KeyA', keyCode: 65 });

    expect(terminal.forwardPageKey).toHaveBeenCalledOnce();
    expect(terminal.forwardPageKey.mock.calls[0]?.[0]).toMatchObject({ key: 'a', code: 'KeyA' });
  });

  it('opens the draft page-wide while leaving editors, F5, and F12 alone', async () => {
    const view = await renderManagedSession();
    const toolbarButton = document.createElement('button');
    const editor = document.createElement('textarea');
    view.container.append(toolbarButton, editor);

    fireEvent.keyDown(toolbarButton, { key: 'Enter', shiftKey: true });
    expect(bottomDock.focusComposer).toHaveBeenCalledOnce();
    expect(terminal.forwardPageKey).not.toHaveBeenCalled();

    fireEvent.keyDown(toolbarButton, { key: 'F5' });
    fireEvent.keyDown(toolbarButton, { key: 'F12' });
    fireEvent.keyDown(editor, { key: 'x', code: 'KeyX', keyCode: 88 });
    expect(terminal.forwardPageKey).not.toHaveBeenCalled();
  });

  it('focuses the chat composer page-wide on Shift+Enter but leaves focused Shift+Enter local', async () => {
    localStorage.setItem('tw_bound', JSON.stringify([session.name]));
    api.getSessions.mockResolvedValue([session]);
    api.getWindows.mockResolvedValue([staleWindow]);
    api.getPanes.mockResolvedValue([{ ...stalePanes[0], agent: 'pi', command: 'pi' }, stalePanes[1]]);
    api.getAgentDiscovery.mockResolvedValue({
      descriptors: [{ id: 'pi', label: 'Pi', capabilities: {
        inbox: true, conversation: true, interaction: false, subscriptionUsage: false,
      } }],
      runs: [{ agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' }],
      health: [],
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      const body = path.includes('/api/agents/conversation/discover') ? {
        descriptor: {
          session: { agentId: 'pi', sessionId: 'session-1' },
          run: { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' },
          viewId: 'view-1', historyVersion: 'history-1',
          capabilities: { history: true, live: 'poll', sendable: true },
        },
      } : path.includes('/api/agents/conversation/page') ? {
        status: 'ok', page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
          items: [], hasMore: false,
        },
      } : path.includes('/api/agents/conversation-controls') ? {
        controls: {
          activity: 'idle', submissions: [],
          queue: { items: [], canSteer: false, canEdit: true, canRemove: true },
        },
      } : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }));
    const view = await renderApp();
    await flush();
    act(() => windowBarProps().onLensChange?.('chat'));
    await flush();

    const input = requiredElement<HTMLTextAreaElement>(view.container, '.chat-composer textarea.cc-text');
    const toolbarButton = document.createElement('button');
    view.container.append(toolbarButton);
    toolbarButton.focus();

    fireEvent.keyDown(toolbarButton, { key: 'Enter', shiftKey: true });
    expect(document.activeElement).toBe(input);
    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('keeps the composer mounted while the new session history is still loading', async () => {
    localStorage.setItem('tw_bound', JSON.stringify([session.name]));
    api.getSessions.mockResolvedValue([session]);
    api.getWindows.mockResolvedValue([staleWindow]);
    api.getPanes.mockResolvedValue([{ ...stalePanes[0], agent: 'pi', command: 'pi' }, stalePanes[1]]);
    api.getAgentDiscovery.mockResolvedValue({
      descriptors: [{ id: 'pi', label: 'Pi', capabilities: {
        inbox: true, conversation: true, interaction: false, subscriptionUsage: false,
      } }],
      runs: [{ agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' }],
      health: [],
    });
    const pageResponse = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const path = String(input);
      const body = path.includes('/api/agents/conversation/discover') ? {
        descriptor: {
          session: { agentId: 'pi', sessionId: 'session-1' },
          run: { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' },
          viewId: 'view-1', historyVersion: 'history-1',
          capabilities: { history: true, live: 'poll', sendable: true },
        },
      } : path.includes('/api/agents/conversation-controls') ? {
        controls: {
          activity: 'idle', submissions: [],
          queue: { items: [], settled: [], canSteer: false, canEdit: true, canRemove: true },
        },
      } : null;
      if (path.includes('/api/agents/conversation/page')) return pageResponse.promise;
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
    }));
    const view = await renderApp();
    act(() => windowBarProps().onLensChange?.('chat'));
    await flush();

    expect(view.container.querySelector('.agent-conversation-state')).toBeTruthy();
    const composer = requiredElement<HTMLTextAreaElement>(
      view.container, '.chat-composer textarea.cc-text',
    );
    fireEvent.change(composer, { target: { value: 'loading 期间也能编辑' } });
    expect(composer.value).toBe('loading 期间也能编辑');

    pageResponse.resolve({
      ok: true, status: 200, json: async () => ({
        status: 'ok', page: {
          sessionId: 'session-1', viewId: 'view-1', historyVersion: 'history-1',
          items: [], hasMore: false,
        },
      }),
    } as Response);
    await flush();
  });
});

describe('App window switching', () => {
  it('opens the target terminal immediately and ignores a slower stale pane response', async () => {
    const session = { id: '$7', name: 'current' };
    const first = { id: '@1', name: 'one', active: true, panes: 1, activePaneId: '%1' };
    const second = { id: '@2', name: 'two', active: false, panes: 1, activePaneId: '%2' };
    const third = { id: '@3', name: 'three', active: false, panes: 1, activePaneId: '%3' };
    const secondPanes = deferred();
    const thirdPanes = deferred();
    localStorage.setItem('tw_bound', JSON.stringify([session.name]));
    api.getSessions.mockResolvedValue([session]);
    api.getWindows.mockResolvedValue([first, second, third]);
    api.getPanes
      .mockResolvedValueOnce([{ id: '%1', active: true, width: 80 }])
      .mockReturnValueOnce(secondPanes.promise)
      .mockReturnValueOnce(thirdPanes.promise);
    await renderApp();

    let secondSwitch: Promise<void> | undefined;
    act(() => { secondSwitch = windowBarProps().onSelectWindow(second); });
    expect(windowBarProps().currentWindowId).toBe('@2');
    expect(screen.getByTestId('terminal-pane').textContent).toBe('%2');

    let thirdSwitch: Promise<void> | undefined;
    act(() => { thirdSwitch = windowBarProps().onSelectWindow(third); });
    expect(windowBarProps().currentWindowId).toBe('@3');
    expect(screen.getByTestId('terminal-pane').textContent).toBe('%3');

    await act(async () => {
      thirdPanes.resolve([{ id: '%3', active: true, width: 120 }]);
      await thirdSwitch;
    });
    await act(async () => {
      secondPanes.resolve([{ id: '%2', active: true, width: 90 }]);
      await secondSwitch;
    });

    expect(windowBarProps().currentWindowId).toBe('@3');
    expect(screen.getByTestId('terminal-pane').textContent).toBe('%3');
  });
});

describe('App workspace recovery', () => {
  it('shows only a Drawer card when tmux already has a live session', async () => {
    api.getSessions.mockResolvedValue([{ id: '$7', name: 'current' }]);
    api.getWorkspaceRestorePlan.mockResolvedValue(activePlan());
    const { container } = await renderApp();

    expect(container.querySelector('.workspace-recovery-card')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '恢复上次工作区' })).toBeNull();
    expect(getWorkspacePromptState('checkpoint-a')).toEqual({});
  });

  it('swaps the Drawer for the recovery dialog and restores focus to the visible menu button', async () => {
    api.getSessions.mockResolvedValue([{ id: '$7', name: 'current' }]);
    api.getWorkspaceRestorePlan.mockResolvedValue(activePlan());
    const { container } = await renderApp();
    const menu = requiredElement<HTMLButtonElement>(container, '.hamburger');
    fireEvent.click(menu);
    await flush();
    const card = requiredElement<HTMLElement>(container, '.workspace-recovery-card');
    card.focus();
    fireEvent.click(card);
    await flush();

    expect(requiredElement(container, '.drawer').classList.contains('open')).toBe(false);
    expect(screen.getByRole('dialog', { name: '恢复上次工作区' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await flush();
    expect(document.activeElement).toBe(menu);
  });

  it('closes an already-open Drawer when a slow new checkpoint auto-opens the dialog', async () => {
    const nextPlan = deferred();
    api.getWorkspaceRestorePlan.mockResolvedValueOnce(null).mockReturnValueOnce(nextPlan.promise);
    const { container } = await renderApp();
    const menu = requiredElement<HTMLButtonElement>(container, '.hamburger');

    await flush(15_000);
    fireEvent.click(menu);
    await flush();
    expect(requiredElement(container, '.drawer').classList.contains('open')).toBe(true);
    const hiddenFocusTarget = requiredElement<HTMLElement>(container, '.drawer-logout');
    hiddenFocusTarget.focus();

    nextPlan.resolve(activePlan({ checkpointId: 'checkpoint-b' }));
    await flush();
    expect(requiredElement(container, '.drawer').classList.contains('open')).toBe(false);
    expect(screen.getByRole('dialog', { name: '恢复上次工作区' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await flush();
    expect(document.activeElement).toBe(menu);
  });

  it('auto-opens once for an empty tmux; close only marks autoShown and explicit ignore hides the card', async () => {
    api.getWorkspaceRestorePlan.mockResolvedValue(activePlan());
    const { container } = await renderApp();

    expect(screen.getByRole('dialog', { name: '恢复上次工作区' })).toBeTruthy();
    expect(getWorkspacePromptState('checkpoint-a')).toEqual({ autoShown: true });
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await flush();
    expect(screen.queryByRole('dialog', { name: '恢复上次工作区' })).toBeNull();
    expect(container.querySelector('.workspace-recovery-card')).toBeTruthy();
    expect(getWorkspacePromptState('checkpoint-a').ignored).toBeUndefined();

    await flush(15_000);
    expect(screen.queryByRole('dialog', { name: '恢复上次工作区' })).toBeNull();
    fireEvent.click(requiredElement(container, '.workspace-recovery-card'));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '忽略此备份' }));
    await flush();
    expect(getWorkspacePromptState('checkpoint-a')).toEqual({ autoShown: true, ignored: true });
    expect(container.querySelector('.workspace-recovery-card')).toBeNull();
  });

  it('applies a mapping even when an expired/resolved plan is hidden', async () => {
    const mapping = { id: 'mapping-from-another-device', runtime: { sessions: { '$1': '$9' } } };
    api.getSessions.mockResolvedValue([{ id: '$9', name: 'project-restored' }]);
    api.getWorkspaceRestorePlan.mockResolvedValue(resolvedPlan({ mapping }));
    const { container } = await renderApp();

    expect(storage.applyWorkspaceRestoreMapping).toHaveBeenCalledWith(mapping);
    expect(container.querySelector('.workspace-recovery-card')).toBeNull();
    expect(screen.queryByRole('dialog', { name: '恢复上次工作区' })).toBeNull();
  });

  it('posts once, retries with the same operationId, applies mapping, and keeps restored sessions closed and unbound', async () => {
    const mapping = {
      id: 'mapping-success',
      names: { project: 'project-restored' },
      runtime: { sessions: { '$1': '$10' }, windows: { '@1': '@10' }, panes: { '%1': '%12' } },
      logical: {
        sessions: { [ACTIVE_SESSION]: '$10' },
        windows: { [ACTIVE_WINDOW]: '@10' },
        panes: { [ACTIVE_PANE]: '%12' },
      },
    };
    api.getWorkspaceRestorePlan
      .mockResolvedValueOnce(activePlan())
      // The refresh may race server plan resolution and briefly return the same
      // eligible checkpoint. A completed operation must still stay dismissed.
      .mockResolvedValueOnce(activePlan());
    api.getSessions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: '$10', name: 'project-restored' }]);
    api.getWindows.mockResolvedValue([{ id: '@10', name: 'main' }]);
    api.getPanes.mockResolvedValue([{ id: '%11', width: 80 }, { id: '%12', width: 80 }]);
    api.getWorkspaceRestoreOperation
      .mockResolvedValueOnce({ id: 'operation-a', status: 'pending', progress: { completed: 0, total: 3 }, results: [] })
      .mockRejectedValueOnce(new ApiError('/private/server failure', 503, 'workspace unavailable'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ id: 'operation-a', status: 'running', progress: { completed: 2, total: 3 }, results: [] })
      .mockResolvedValueOnce({
        id: 'operation-a', status: 'succeeded', progress: { completed: 3, total: 3 },
        summary: { sessions: 1, windows: 1, panes: 2 },
        results: [{ logicalId: ACTIVE_SESSION, sourceName: 'project', targetName: 'project-restored', status: 'restored' }],
        mapping,
      });

    const { container } = await renderApp();
    localStorage.setItem('tw_bound', JSON.stringify(['project']));
    const restore = screen.getByRole('button', { name: '恢复' });
    fireEvent.click(restore);
    fireEvent.click(restore);
    await flush();
    expect(api.startWorkspaceRestore).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await flush();
    expect(screen.queryByRole('dialog', { name: '恢复上次工作区' })).toBeNull();

    await flush(1_000); // 503 poll; operationId must be retained
    await flush(1_000); // disconnected transport poll; operationId must still be retained
    await flush(1_000); // running 2 / 3
    fireEvent.click(requiredElement(container, '.workspace-recovery-card'));
    await flush();
    expect(screen.getByText('正在恢复 2 / 3…')).toBeTruthy();
    await flush(1_000); // succeeded

    expect(api.getWorkspaceRestoreOperation).toHaveBeenCalledTimes(5);
    expect(api.getWorkspaceRestoreOperation.mock.calls.every(([id]) => id === 'operation-a')).toBe(true);
    expect(storage.applyWorkspaceRestoreMapping).toHaveBeenCalledWith(mapping);
    expect(storage.applyWorkspaceRestoreMapping.mock.invocationCallOrder[0] ?? 0)
      .toBeGreaterThan(api.getSessions.mock.invocationCallOrder[0] ?? 0);
    expect(api.getSessions).toHaveBeenCalledTimes(1);
    expect(api.getWindows).not.toHaveBeenCalled();
    expect(api.getPanes).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-pane')).toBeNull();
    expect(getBoundSessions()).toEqual(['project']);
    expect(screen.getByRole('dialog', { name: '恢复上次工作区' })).toBeTruthy();
    expect(screen.getByText('本次恢复：1 个会话 · 1 个窗口 · 2 个窗格')).toBeTruthy();
    expect(screen.getByText(/恢复的会话不会自动显示/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '重新绑定会话' }));
    await flush(300);
    expect(screen.queryByRole('dialog', { name: '恢复上次工作区' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '绑定会话' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'project-restored' })).toBeTruthy();
  });

  it('keeps a succeeded operation visible when safe server warnings need attention', async () => {
    const mapping = {
      id: 'mapping-warning', names: { project: 'project-restored' },
      runtime: { sessions: {}, windows: {}, panes: {} },
      logical: { sessions: { [ACTIVE_SESSION]: '$30' }, windows: {}, panes: {} },
    };
    api.getWorkspaceRestorePlan.mockResolvedValue(activePlan());
    api.getSessions.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: '$30', name: 'project-restored' }]);
    api.getWindows.mockResolvedValue([{ id: '@30', name: 'main' }]);
    api.getPanes.mockResolvedValue([{ id: '%30', width: 80 }]);
    api.getWorkspaceRestoreOperation.mockResolvedValueOnce({
      id: 'operation-a', status: 'succeeded', progress: { completed: 1, total: 1 }, mapping,
      warningCodes: ['live-reconcile-failed'],
      results: [{
        logicalId: ACTIVE_SESSION, sourceName: 'project', targetName: 'project-restored', status: 'restored',
        warningCodes: ['agent-warning'], warningMessage: '/private/agent-secret',
      }],
    });

    const { container } = await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    await flush();

    expect(screen.getByRole('dialog', { name: '恢复上次工作区' })).toBeTruthy();
    expect(container.querySelector('.workspace-recovery-card')).toBeTruthy();
    expect(screen.getByText(/实时工作区状态核对失败/)).toBeTruthy();
    expect(screen.getByText(/project：Agent 未能自动续接/)).toBeTruthy();
    expect(screen.queryByText(/private\/agent-secret/)).toBeNull();
    expect(api.getWorkspaceRestoreOperation).toHaveBeenCalledTimes(1);
  });

  it('keeps a warned success through a resolved poll until the user dismisses it', async () => {
    api.getWorkspaceRestorePlan
      .mockResolvedValueOnce(activePlan())
      .mockResolvedValue(resolvedPlan());
    api.getWorkspaceRestoreOperation.mockResolvedValueOnce({
      id: 'operation-a', status: 'succeeded', progress: { completed: 1, total: 1 }, mapping: null,
      warningCodes: ['live-reconcile-failed'],
      results: [{ logicalId: ACTIVE_SESSION, sourceName: 'project', status: 'already-present' }],
    });

    const { container } = await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    expect(screen.getByText(/实时工作区状态核对失败/)).toBeTruthy();

    await flush(15_000);
    expect(screen.getByRole('dialog', { name: '恢复上次工作区' })).toBeTruthy();
    expect(container.querySelector('.workspace-recovery-card')).toBeTruthy();
    expect(screen.getByText(/实时工作区状态核对失败/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await flush();
    await flush(15_000);
    expect(screen.queryByRole('dialog', { name: '恢复上次工作区' })).toBeNull();
    expect(container.querySelector('.workspace-recovery-card')).toBeNull();
  });

  it('keeps the completion result without attempting to open the restored session', async () => {
    const mapping = {
      id: 'mapping-retry', names: { project: 'project-restored' },
      runtime: { sessions: {}, windows: {}, panes: {} },
      logical: { sessions: { [ACTIVE_SESSION]: '$40' }, windows: {}, panes: {} },
    };
    const terminal = {
      id: 'operation-a', status: 'succeeded', progress: { completed: 1, total: 1 }, mapping,
      warningCodes: [],
      results: [{ logicalId: ACTIVE_SESSION, sourceName: 'project', targetName: 'project-restored', status: 'restored', warningCodes: [] }],
    };
    api.getWorkspaceRestorePlan.mockResolvedValueOnce(activePlan()).mockResolvedValueOnce(resolvedPlan());
    api.getSessions
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('/private/session refresh failed'))
      .mockResolvedValue([{ id: '$40', name: 'project-restored' }]);
    api.getWindows
      .mockRejectedValueOnce(new Error('/private/window refresh failed'))
      .mockResolvedValue([{ id: '@40', name: 'main' }]);
    api.getPanes.mockResolvedValue([{ id: '%40', width: 80 }]);
    api.getWorkspaceRestoreOperation.mockResolvedValue(terminal);

    const { container } = await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    await flush();
    expect(screen.getByRole('dialog', { name: '恢复上次工作区' })).toBeTruthy();
    expect(screen.getByText('本次恢复：1 个会话 · 0 个窗口 · 0 个窗格')).toBeTruthy();
    expect(container.querySelector('.workspace-recovery-card')).toBeTruthy();
    expect(api.getSessions).toHaveBeenCalledTimes(1);
    expect(api.getWindows).not.toHaveBeenCalled();
    expect(api.getPanes).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-pane')).toBeNull();
  });

  it('clears a warned completion result when the dialog is closed', async () => {
    const mapping = {
      id: 'mapping-warning-retry', names: { project: 'project-restored' },
      runtime: { sessions: {}, windows: {}, panes: {} },
      logical: { sessions: { [ACTIVE_SESSION]: '$45' }, windows: {}, panes: {} },
    };
    const terminal = {
      id: 'operation-a', status: 'succeeded', progress: { completed: 1, total: 1 }, mapping,
      warningCodes: ['live-reconcile-failed'],
      results: [{
        logicalId: ACTIVE_SESSION, sourceName: 'project', targetName: 'project-restored', status: 'restored',
        warningCodes: ['agent-warning'],
      }],
    };
    api.getWorkspaceRestorePlan.mockResolvedValue(activePlan());
    api.getSessions
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('/private/first navigation failed'))
      .mockResolvedValueOnce([{ id: '$45', name: 'project-restored' }]);
    api.getWindows.mockResolvedValue([{ id: '@45', name: 'main' }]);
    api.getPanes.mockResolvedValue([{ id: '%45', width: 80 }]);
    api.getWorkspaceRestoreOperation.mockResolvedValue(terminal);

    const { container } = await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    await flush();
    expect(screen.getByText(/实时工作区状态核对失败/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await flush();
    expect(screen.queryByRole('dialog', { name: '恢复上次工作区' })).toBeNull();
    expect(container.querySelector('.workspace-recovery-card')).toBeNull();
    expect(api.getWorkspaceRestoreOperation).toHaveBeenCalledTimes(1);
    expect(api.getWindows).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-pane')).toBeNull();
  });

  it('stops operation polling immediately after an auth failure', async () => {
    api.getWorkspaceRestorePlan.mockResolvedValue(activePlan());
    api.getWorkspaceRestoreOperation.mockRejectedValue(new UnauthorizedError());
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    await flush();
    expect(api.getWorkspaceRestoreOperation).toHaveBeenCalledTimes(1);

    await flush(5_000);
    expect(api.getWorkspaceRestoreOperation).toHaveBeenCalledTimes(1);
  });

  it('does not let a late start response revive an operation after logout', async () => {
    const start = deferred();
    api.getWorkspaceRestorePlan.mockResolvedValue(activePlan());
    api.startWorkspaceRestore.mockReturnValueOnce(start.promise);
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();

    fireEvent.click(requiredElement(document, '.drawer-logout'));
    await flush();
    start.resolve({ operationId: 'operation-stale', status: 'pending' });
    await flush();
    fireEvent.change(screen.getByPlaceholderText('粘贴 HANDMUX_TOKEN'), { target: { value: 'new-token' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(api.getWorkspaceRestoreOperation).not.toHaveBeenCalled();
  });

  it('keeps monitoring the active operation when a newer checkpoint plan poll arrives', async () => {
    const operation = deferred();
    const nextPlan = activePlan({ checkpointId: 'checkpoint-b', capturedAt: '2026-07-20T02:42:00.000Z' });
    api.getWorkspaceRestorePlan
      .mockResolvedValueOnce(activePlan())
      .mockResolvedValueOnce(activePlan())
      .mockResolvedValue(nextPlan);
    api.getWorkspaceRestoreOperation
      .mockReturnValueOnce(operation.promise)
      .mockResolvedValue({ id: 'operation-a', status: 'pending', progress: { completed: 0, total: 1 }, results: [] });
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    expect(api.getWorkspaceRestoreOperation).toHaveBeenCalledTimes(1);

    await flush(15_000);
    const restoring = screen.getByRole('button', { name: /正在恢复/ });
    if (!(restoring instanceof HTMLButtonElement)) throw new Error('expected restoring button');
    expect(restoring.disabled).toBe(true);
    operation.resolve({ id: 'operation-a', status: 'pending', progress: { completed: 0, total: 1 }, results: [] });
    await flush();
    await flush(1_000);

    expect(api.getWorkspaceRestoreOperation).toHaveBeenCalledTimes(2);
    expect(api.getWorkspaceRestoreOperation.mock.calls.every(([id]) => id === 'operation-a')).toBe(true);
  });

  it('stops on operation 404 and renders only the safe operation-not-found copy', async () => {
    api.getWorkspaceRestorePlan.mockResolvedValue(activePlan());
    api.getWorkspaceRestoreOperation.mockRejectedValue(new ApiError('/private/missing operation', 404, 'operation not found'));
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    await flush();
    expect(screen.getByText(/此恢复任务已不可用/)).toBeTruthy();
    expect(screen.queryByText(/private\/missing/)).toBeNull();

    await flush(5_000);
    expect(api.getWorkspaceRestoreOperation).toHaveBeenCalledTimes(1);
  });

  it('stops other non-auth 4xx polls with a safe generic error', async () => {
    api.getWorkspaceRestorePlan.mockResolvedValue(activePlan());
    api.getWorkspaceRestoreOperation.mockRejectedValue(new ApiError('/private/conflict', 409, 'secret conflict'));
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    await flush();
    expect(screen.getByText(/会话未恢复；请检查 handmux 日志后重试/)).toBeTruthy();
    expect(screen.queryByText(/private|secret conflict/)).toBeNull();

    await flush(5_000);
    expect(api.getWorkspaceRestoreOperation).toHaveBeenCalledTimes(1);
  });

  it('cancels an unresolved operation poll on logout without applying its late response', async () => {
    const pending = deferred();
    api.getWorkspaceRestorePlan.mockResolvedValue(activePlan());
    api.getWorkspaceRestoreOperation.mockReturnValueOnce(pending.promise);
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    expect(api.getWorkspaceRestoreOperation).toHaveBeenCalledTimes(1);

    fireEvent.click(requiredElement(document, '.drawer-logout'));
    await flush();
    pending.resolve({
      id: 'operation-a', status: 'succeeded', progress: { completed: 1, total: 1 },
      mapping: { id: 'late-mapping' }, results: [], warningCodes: [],
    });
    await flush();
    await flush(5_000);
    expect(storage.applyWorkspaceRestoreMapping).not.toHaveBeenCalled();
    expect(api.getWorkspaceRestoreOperation).toHaveBeenCalledTimes(1);
  });

  it('does not refresh restored session topology after completion', async () => {
    api.getWorkspaceRestorePlan.mockResolvedValueOnce(activePlan());
    api.getSessions.mockResolvedValueOnce([]);
    api.getWorkspaceRestoreOperation.mockResolvedValueOnce({
      id: 'operation-a', status: 'succeeded', progress: { completed: 1, total: 1 }, warningCodes: [],
      mapping: { id: 'mapping-cancelled' },
      results: [{ logicalId: ACTIVE_SESSION, sourceName: 'project', targetName: 'project-restored', status: 'restored', warningCodes: [] }],
    });
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    expect(api.getSessions).toHaveBeenCalledTimes(1);
    expect(api.getWindows).not.toHaveBeenCalled();
    expect(api.getWorkspaceRestorePlan).toHaveBeenCalledTimes(2);
    expect(api.getWorkspaceProtectionStatus).toHaveBeenCalledTimes(2);
  });

  it.each(['windows', 'panes'])('does not request restored-session %s topology', async (stage) => {
    const mapping = {
      id: `mapping-cancelled-${stage}`, names: { project: 'project-restored' },
      runtime: { sessions: {}, windows: {}, panes: {} },
      logical: { sessions: { [ACTIVE_SESSION]: '$60' }, windows: {}, panes: {} },
    };
    api.getWorkspaceRestorePlan.mockResolvedValueOnce(activePlan());
    api.getSessions.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: '$60', name: 'project-restored' }]);
    api.getWorkspaceRestoreOperation.mockResolvedValueOnce({
      id: 'operation-a', status: 'succeeded', progress: { completed: 1, total: 1 }, warningCodes: [], mapping,
      results: [{ logicalId: ACTIVE_SESSION, sourceName: 'project', targetName: 'project-restored', status: 'restored', warningCodes: [] }],
    });
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    expect(api.getWindows).not.toHaveBeenCalled();
    expect(api.getPanes).not.toHaveBeenCalled();
    expect(api.getWorkspaceRestorePlan).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('terminal-pane')).toBeNull();
  });

  it('ignores late plan/protection results after logout cancels terminal finalization', async () => {
    const planStatus = deferred();
    const protectionStatus = deferred();
    api.getWorkspaceRestorePlan.mockResolvedValueOnce(activePlan()).mockReturnValueOnce(planStatus.promise);
    api.getWorkspaceProtectionStatus.mockResolvedValueOnce({ status: 'protected' }).mockReturnValueOnce(protectionStatus.promise);
    api.getWorkspaceRestoreOperation.mockResolvedValueOnce({
      id: 'operation-a', status: 'succeeded', progress: { completed: 1, total: 1 }, warningCodes: [], mapping: null,
      results: [{ logicalId: ACTIVE_SESSION, sourceName: 'project', status: 'already-present', warningCodes: [] }],
    });
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    expect(api.getWorkspaceRestorePlan).toHaveBeenCalledTimes(2);
    fireEvent.click(requiredElement(document, '.drawer-logout'));
    await flush();
    planStatus.resolve(resolvedPlan({ mapping: { id: 'late-plan-mapping' } }));
    protectionStatus.resolve({ status: 'degraded', errorCode: 'live-corrupt' });
    await flush();
    expect(storage.applyWorkspaceRestoreMapping).not.toHaveBeenCalled();
  });

  it('shows partial session errors and the restored topology without navigating', async () => {
    const successId = '10000000-0000-4000-8000-000000000002';
    const failedId = ACTIVE_SESSION;
    const partialPlan = activePlan({
      pendingCount: 2,
      planSummary: { create: 2, renamed: 0, alreadyPresent: 0, unsupported: 0 },
      sessions: [
        { logicalId: successId, sourceName: 'docs', targetName: 'docs', action: 'create', activeWindowId: 'w-docs', windowLinks: [] },
        { logicalId: failedId, sourceName: 'web', targetName: 'web', action: 'create', activeWindowId: ACTIVE_WINDOW, windowLinks: [] },
      ],
      active: { sessionId: failedId, windowId: ACTIVE_WINDOW, paneId: ACTIVE_PANE },
    });
    const mapping = {
      id: 'mapping-partial',
      names: { docs: 'docs' },
      runtime: { sessions: {}, windows: {}, panes: {} },
      logical: { sessions: { [successId]: '$20' }, windows: {}, panes: {} },
    };
    api.getWorkspaceRestorePlan.mockResolvedValueOnce(partialPlan).mockResolvedValueOnce(partialPlan);
    api.getSessions
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('/private/navigation-secret'))
      .mockResolvedValueOnce([{ id: '$20', name: 'docs' }]);
    api.getWindows.mockResolvedValue([{ id: '@20', name: 'docs' }]);
    api.getPanes.mockResolvedValue([{ id: '%20', width: 80 }]);
    api.getWorkspaceRestoreOperation.mockResolvedValue({
      id: 'operation-a', status: 'partial', progress: { completed: 2, total: 2 }, mapping,
      results: [
        { logicalId: successId, sourceName: 'docs', targetName: 'docs', status: 'restored' },
        { logicalId: failedId, sourceName: 'web', status: 'failed', errorCode: 'tmux-unavailable', errorMessage: '/private/secret' },
      ],
    });

    const { container } = await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    await flush();

    expect(container.querySelector('.workspace-recovery-card')).toBeTruthy();
    expect(screen.getByText('本次恢复：1 个会话 · 0 个窗口 · 0 个窗格')).toBeTruthy();
    expect(screen.getByText(/web：tmux 不可用；请确认 tmux 已运行后重试/)).toBeTruthy();
    expect(screen.queryByText(/private\/(secret|navigation-secret)/)).toBeNull();
    expect(api.getWorkspaceRestoreOperation).toHaveBeenCalledTimes(1);
    expect(api.getWindows).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-pane')).toBeNull();
  });

  it('shows an idempotent all-already-present result without a rebind action', async () => {
    api.getWorkspaceRestorePlan.mockResolvedValueOnce(activePlan()).mockResolvedValueOnce(resolvedPlan());
    api.getSessions.mockResolvedValue([]);
    api.getWorkspaceRestoreOperation.mockResolvedValueOnce({
      id: 'operation-a', status: 'succeeded', progress: { completed: 1, total: 1 }, mapping: null,
      results: [{ logicalId: ACTIVE_SESSION, sourceName: 'project', status: 'already-present' }],
    });
    const { container } = await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    await flush();
    expect(container.querySelector('.workspace-recovery-card')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '恢复上次工作区' })).toBeTruthy();
    expect(screen.getByText('本次恢复：0 个会话 · 0 个窗口 · 0 个窗格')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新绑定会话' })).toBeNull();
    expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
    expect(api.getWindows).not.toHaveBeenCalled();
  });

  it('does not carry a terminal result into a newer checkpoint prompt', async () => {
    const nextPlan = activePlan({ checkpointId: 'checkpoint-b', capturedAt: '2026-07-20T02:42:00.000Z' });
    api.getWorkspaceRestorePlan
      .mockResolvedValueOnce(activePlan())
      .mockResolvedValueOnce(resolvedPlan())
      .mockResolvedValueOnce(nextPlan);
    api.getSessions.mockResolvedValue([]);
    api.getWorkspaceRestoreOperation.mockResolvedValueOnce({
      id: 'operation-a', status: 'succeeded', progress: { completed: 1, total: 1 }, mapping: null,
      results: [{ logicalId: ACTIVE_SESSION, sourceName: 'project', status: 'already-present' }],
    });
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    await flush();

    await flush(15_000);
    expect(screen.getByRole('dialog', { name: '恢复上次工作区' })).toBeTruthy();
    expect(screen.queryByText('工作区已恢复。')).toBeNull();
  });

  it('clears terminal operation state on ignore before accepting a newer checkpoint', async () => {
    const nextPlan = activePlan({ checkpointId: 'checkpoint-b', capturedAt: '2026-07-20T02:42:00.000Z' });
    api.getWorkspaceRestorePlan
      .mockResolvedValueOnce(activePlan())
      .mockResolvedValueOnce(activePlan())
      .mockResolvedValue(nextPlan);
    api.getWorkspaceRestoreOperation.mockResolvedValueOnce({
      id: 'operation-a', status: 'failed', errorCode: 'tmux-unavailable',
      progress: { completed: 1, total: 1 }, results: [], warningCodes: [], mapping: null,
    });
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    expect(screen.getByText(/tmux 不可用/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '忽略此备份' }));
    await flush();

    await flush(15_000);
    expect(screen.getByRole('dialog', { name: '恢复上次工作区' })).toBeTruthy();
    expect(screen.queryByText(/tmux 不可用/)).toBeNull();
  });

  it('clears terminal operation state when mode none resolves a checkpoint before the next one', async () => {
    const nextPlan = activePlan({ checkpointId: 'checkpoint-b', capturedAt: '2026-07-20T02:42:00.000Z' });
    api.getWorkspaceRestorePlan
      .mockResolvedValueOnce(activePlan())
      .mockResolvedValueOnce(activePlan())
      .mockResolvedValueOnce(resolvedPlan())
      .mockResolvedValue(nextPlan);
    api.getWorkspaceRestoreOperation.mockResolvedValueOnce({
      id: 'operation-a', status: 'failed', errorCode: 'tmux-unavailable',
      progress: { completed: 1, total: 1 }, results: [], warningCodes: [], mapping: null,
    });
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await flush();
    expect(screen.getByText(/tmux 不可用/)).toBeTruthy();

    await flush(15_000);
    expect(screen.queryByRole('dialog', { name: '恢复上次工作区' })).toBeNull();
    await flush(15_000);
    expect(screen.getByRole('dialog', { name: '恢复上次工作区' })).toBeTruthy();
    expect(screen.queryByText(/tmux 不可用/)).toBeNull();
  });

  it('shows a sanitized degraded protection warning in Settings and removes it after protection recovers', async () => {
    api.getWorkspaceRestorePlan.mockRejectedValue(new Error('no checkpoint'));
    api.getWorkspaceProtectionStatus
      .mockResolvedValueOnce({ status: 'degraded', lastSuccessfulCaptureAt: null, errorCode: 'live-corrupt' })
      .mockResolvedValueOnce({ status: 'protected', lastSuccessfulCaptureAt: '2026-07-20T02:00:00.000Z', errorCode: null });
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    await flush();
    expect(screen.getByText('工作区未受保护')).toBeTruthy();
    expect(screen.getByText(/工作区状态副本已损坏/)).toBeTruthy();

    await flush(15_000);
    expect(screen.queryByText('工作区未受保护')).toBeNull();
  });
});


describe('App consumes conversation control commands', () => {
  async function openControls() {
    const pane = { id: '%73', active: true, width: 80, height: 24, command: 'codex', cwd: '/work', agent: 'codex' };
    const otherPane = { ...pane, id: '%74', active: false };
    const run = { agentId: 'codex', paneId: pane.id, runId: 'control-run', sessionId: 'control-session' };
    const otherRun = { ...run, paneId: otherPane.id, runId: 'other-run', sessionId: 'other-session' };
    localStorage.setItem(`tw_lens_${otherPane.id}`, 'chat');
    localStorage.setItem('tw_bound', JSON.stringify(['project']));
    localStorage.setItem(`tw_lens_${pane.id}`, 'chat');
    api.getSessions.mockResolvedValue([{ id: '$71', name: 'project' }]);
    api.getWindows.mockResolvedValue([{ id: '@71', name: 'main', active: true, panes: 2 }]);
    api.getPanes.mockResolvedValue([pane, otherPane]);
    api.getAgentDiscovery.mockResolvedValue({
      descriptors: [{ id: 'codex', label: 'Codex', capabilities: {
        conversation: true, sessionControl: true, conversationGoal: true,
      } }], runs: [run, otherRun], health: [],
    });
    conversationApi.discoverAgentConversation.mockImplementation(async (run) => ({
      session: { agentId: run.agentId, sessionId: run.sessionId }, run,
      viewId: run.sessionId, historyVersion: '1', capabilities: { history: true, live: 'poll', send: ['prompt'] },
    }));
    conversationApi.readAgentConversationPage.mockImplementation(async (run) => ({
      status: 'ok', page: { sessionId: run.sessionId, viewId: run.sessionId,
        historyVersion: '1', hasMore: false, items: [] },
    }));
    const view = render(<StrictMode><App /></StrictMode>);
    await flush(); await flush();
    return view;
  }
  async function sendCommand(command: string) {
    const input = requiredElement(document, '.cc-text');
    fireEvent.change(input, { target: { value: command } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
  }
  it.each(['/model', '/effort', '/goal', '/goal edit'])('does not replay %s after closing or remounting, but accepts a new command', async (command) => {
    await openControls();
    const model = !command.startsWith('/goal');
    const selector = model ? '.agent-model-menu' : '.conversation-goal-menu';
    const close = () => fireEvent.click(requiredElement(document,
      model ? '.agent-model-backdrop' : '.conversation-goal-sheet-x'));
    await sendCommand(command);
    expect(document.querySelector(selector)).toBeTruthy();
    close(); await flush();
    expect(document.querySelector(selector)).toBeNull();
    act(() => windowBarProps().onLensChange?.('terminal')); await flush();
    act(() => windowBarProps().onLensChange?.('chat')); await flush();
    expect(document.querySelector(selector)).toBeNull();
    await sendCommand(command);
    expect(document.querySelector(selector)).toBeTruthy();
    close(); await flush();
    if (model) {
      fireEvent.click(screen.getByRole('button', { name: '设置模型、服务等级和思考强度' }));
      expect(document.querySelector(selector)).toBeTruthy();
    }
  });

  it.each(['model', 'goal'] as const)('isolates pending %s requests across sessions and ignores old consumption', async (kind) => {
    controlRequestProbe.holdConsumption = true;
    await openControls();
    await sendCommand(`/${kind}`);
    const old = controlRequestProbe[kind]!;
    expect(old.id).toBeGreaterThan(0);
    await act(async () => { await windowBarProps().onSelectPane('%74'); });
    await flush();
    expect(controlRequestProbe.model?.id).toBe(0);
    expect(controlRequestProbe.goal?.id).toBe(0);
    const other = kind === 'model' ? 'goal' : 'model';
    await sendCommand(`/${other}`);
    expect(controlRequestProbe[kind]?.id).toBe(0);
    const otherPending = controlRequestProbe[other]!;
    expect(otherPending.id).toBeGreaterThan(old.id);
    await sendCommand(`/${kind}`);
    const current = controlRequestProbe[kind]!;
    expect(current.id).toBeGreaterThan(otherPending.id);
    act(() => old.consume?.(old.id));
    expect(controlRequestProbe[kind]?.id).toBe(current.id);
    // Both command types may be pending; acknowledging one must preserve the other.
    act(() => otherPending.consume?.(otherPending.id));
    expect(controlRequestProbe[other]?.id).toBe(0);
    expect(controlRequestProbe[kind]?.id).toBe(current.id);
    await sendCommand(`/${kind}`);
    const newer = controlRequestProbe[kind]!;
    expect(newer.id).toBeGreaterThan(current.id);
    act(() => current.consume?.(current.id));
    expect(controlRequestProbe[kind]?.id).toBe(newer.id);
    act(() => newer.consume?.(newer.id));
    expect(controlRequestProbe[kind]?.id).toBe(0);
  });
});
