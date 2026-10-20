import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AgentConversationComposer from '../src/components/AgentConversationComposer.js';
import type { AgentConversationController } from '../src/hooks/useAgentConversation.js';
import type { ScheduledSnapshot, ScheduledTask } from '../src/scheduledMessagesApi.js';
import { scheduledRequest } from '../src/scheduledMessagesApi.js';
import { t } from '../src/i18n';
import { useScheduledMessagesSnapshot } from '../src/hooks/useScheduledMessagesSnapshot.js';
vi.mock('../src/scheduledMessagesApi.js', () => ({ scheduledRequest: vi.fn() }));
vi.mock('../src/hooks/useUpload.js', () => ({ useUpload: () => ({ uploadFiles: vi.fn(async () => {}) }) }));
vi.mock('../src/voice/usePushToTalk.js', () => ({ usePushToTalk: () => ({ state: 'idle', partial: '', start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }) }));
const run = { agentId: 'new-agent', paneId: '%1', runId: 'run', sessionId: 'session' };
const now = Date.parse('2026-10-20T15:30:00Z');
const empty: ScheduledSnapshot = { serverNow: now, timeZone: 'UTC', tasks: [], exceptions: [] };
const task: ScheduledTask = { id: 'task', revision: 1, text: 'scheduled', target: { agentId: 'new-agent', sessionId: 'session', paneId: '%1', tmuxSession: 'work' }, timeZone: 'UTC', enabled: true, state: 'active', nextAt: now + 3600000, rule: { frequency: 'once', slots: [{ date: '2026-10-20', time: '16:30' }] } };
function conversation(sendable = true): AgentConversationController {
  return { status: 'ready', error: null, canonicalReady: true,
    descriptor: { session: { agentId: 'new-agent', sessionId: 'session' }, viewId: 'view', historyVersion: 'history', capabilities: { history: true, live: 'poll', ...(sendable ? { sendable: true } : {}) } },
    items: [], hasMore: false, loadingOlder: false, sending: false, interrupting: false,
    send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), loadOlder: vi.fn(async () => {}), downloadResource: vi.fn(async () => {}), retryOutgoing: vi.fn(async () => false),
  } as AgentConversationController;
}
function Composer({ scope = 'work', sendable = true, controller }: { scope?: string; sendable?: boolean; controller?: AgentConversationController }) {
  return <AgentConversationComposer agentId="new-agent" sessionId="session" tmuxSession={scope} scheduledRun={run}
    chatTone="light" keyboardInset={250} busy={false} conversation={controller ?? conversation(sendable)} />;
}
const shortcut = () => document.querySelector<HTMLButtonElement>('.scheduled-shortcut')!;
afterEach(async () => { cleanup(); vi.useRealTimers(); await new Promise((resolve) => setTimeout(resolve, 20)); vi.clearAllMocks(); });
it('keeps the shortcut visible from conversation loading through capability and count hydration', async () => {
  let resolve!: (value: ScheduledSnapshot) => void;
  vi.mocked(scheduledRequest).mockImplementation(async () => await new Promise<ScheduledSnapshot>((done) => { resolve = done; }));
  const view = render(<Composer controller={{ ...conversation(), status: 'loading', descriptor: null }} />);
  const button = screen.getByRole<HTMLButtonElement>('button', { name: t('scheduled.title') });
  expect(button.textContent).toBe(t('scheduled.title'));
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(screen.queryByRole('dialog', { name: t('scheduled.title') })).toBeNull();

  view.rerender(<Composer />);
  expect(shortcut()).toBe(button);
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe(t('scheduled.title'));
  await act(async () => { resolve({ ...empty, tasks: [task] }); });
  expect(shortcut()).toBe(button);
  expect(button.querySelector('.scheduled-shortcut-count')?.textContent).toBe('1');
  fireEvent.click(button);
  expect(await screen.findByRole('dialog', { name: t('scheduled.title') })).toBeTruthy();
});
it('starts neutral without invented counts and refreshes active and exception states while closed, including paused tasks', async () => {
  vi.useFakeTimers();
  let resolve!: (value: ScheduledSnapshot) => void;
  let value = empty;
  vi.mocked(scheduledRequest).mockImplementation(async (_scope, _run, action) => {
    if (action !== 'snapshot') return {};
    if (!resolve) return await new Promise<ScheduledSnapshot>((done) => { resolve = done; });
    return value;
  });
  render(<Composer />);
  expect(shortcut().classList.contains('quick-cmd-plain')).toBe(true);
  expect(shortcut().textContent).toBe(t('scheduled.title'));
  expect(shortcut().querySelector('.scheduled-shortcut-count')).toBeNull();
  await act(async () => { resolve({ ...empty, tasks: [task, { ...task, id: 'paused', enabled: false }, { ...task, id: 'ended', state: 'ended' }] }); });
  expect(shortcut().classList.contains('qc-cmd')).toBe(true);
  expect(shortcut().querySelector('.scheduled-shortcut-count')?.textContent).toBe('2');
  expect(shortcut().getAttribute('aria-label')).toContain('2');
  value = { ...empty, tasks: [task], exceptions: [{ id: 'missed', revision: 1, taskId: task.id, target: task.target, text: 'missed', timeZone: 'UTC', scheduledAt: now, reason: 'missed', unknown: false }] };
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(shortcut().classList.contains('scheduled-shortcut-alert')).toBe(true);
  expect(shortcut().classList.contains('qc-cmd')).toBe(false);
  expect(shortcut().querySelector('.scheduled-shortcut-count')?.textContent).toBe('1');
  expect(shortcut().getAttribute('aria-label')).toContain(t('scheduled.shortcutExceptions'));
  value = { ...value, tasks: [] };
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(shortcut().classList.contains('scheduled-shortcut-alert')).toBe(true);
  expect(shortcut().querySelector('.scheduled-shortcut-count')).toBeNull();
});
it('does not treat a failed status refresh as a task exception', async () => {
  vi.mocked(scheduledRequest).mockRejectedValue(Error('offline'));
  render(<Composer />); await act(async () => {});
  expect(shortcut().classList.contains('quick-cmd-plain')).toBe(true);
  expect(shortcut().classList.contains('scheduled-shortcut-alert')).toBe(false);
  expect(shortcut().querySelector('.scheduled-shortcut-count')).toBeNull();
});
it('isolates sessions and drops late responses from the previous session', async () => {
  const pending = new Map<string, (value: ScheduledSnapshot) => void>();
  vi.mocked(scheduledRequest).mockImplementation(async (scope) => await new Promise<ScheduledSnapshot>((resolve) => { pending.set(scope, resolve); }));
  const view = render(<Composer scope="A" />);
  await act(async () => { pending.get('A')!({ ...empty, tasks: [task, { ...task, id: 'second' }] }); });
  expect(shortcut().querySelector('.scheduled-shortcut-count')?.textContent).toBe('2');
  view.rerender(<Composer scope="B" />);
  expect(shortcut().querySelector('.scheduled-shortcut-count')).toBeNull();
  await act(async () => { pending.get('B')!({ ...empty, tasks: [task] }); });
  expect(shortcut().querySelector('.scheduled-shortcut-count')?.textContent).toBe('1');
  view.rerender(<Composer scope="C" />);
  view.rerender(<Composer scope="D" />);
  await act(async () => { pending.get('C')!({ ...empty, tasks: [task, { ...task, id: 'stale' }] }); });
  expect(shortcut().querySelector('.scheduled-shortcut-count')).toBeNull();
  await act(async () => { pending.get('D')!(empty); });
  expect(shortcut().classList.contains('quick-cmd-plain')).toBe(true);
});
it('shares one snapshot owner with the open half-sheet and updates the entry immediately after creating a task', async () => {
  let value = empty;
  vi.mocked(scheduledRequest).mockImplementation(async (_scope, _run, action) => {
    if (action === 'snapshot') return value;
    if (action === 'preview') return { nextAt: now + 3600000, timeZone: 'UTC' };
    if (action === 'create') value = { ...empty, tasks: [task] };
    return {};
  });
  render(<Composer />); await act(async () => {});
  fireEvent.click(shortcut());
  await screen.findByRole('dialog', { name: t('scheduled.title') });
  expect(vi.mocked(scheduledRequest).mock.calls.filter((call) => call[2] === 'snapshot')).toHaveLength(1);
  const portal = document.querySelector<HTMLElement>('.tool-sheet')!.closest<HTMLElement>('.overlay-layer')!;
  expect(portal.dataset.chatTone).toBe('light');
  expect(portal.style.getPropertyValue('--overlay-keyboard-inset')).toBe('250px');
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.add') }));
  fireEvent.change(screen.getByLabelText(t('scheduled.message')), { target: { value: 'created' } });
  await waitFor(() => expect((screen.getByRole('button', { name: t('scheduled.save') }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.save') }));
  await waitFor(() => expect(shortcut().querySelector('.scheduled-shortcut-count')?.textContent).toBe('1'));
  expect(vi.mocked(scheduledRequest).mock.calls.filter((call) => call[2] === 'snapshot')).toHaveLength(2);
});
it('does not poll or show a shortcut for an unsupported Agent', async () => {
  render(<Composer sendable={false} />); await act(async () => {});
  expect(document.querySelector('.scheduled-shortcut')).toBeNull();
  expect(scheduledRequest).not.toHaveBeenCalled();
});

it('serializes an explicit refresh after an in-flight snapshot so stale pre-mutation data cannot win', async () => {
  let release!: (value: ScheduledSnapshot) => void;
  let calls = 0;
  vi.mocked(scheduledRequest).mockImplementation(async () => {
    calls++;
    return calls === 1 ? await new Promise<ScheduledSnapshot>((resolve) => { release = resolve; }) : { ...empty, tasks: [task] };
  });
  const { result } = renderHook(() => useScheduledMessagesSnapshot('work'));
  const refresh = result.current.refresh();
  expect(calls).toBe(1);
  await act(async () => { release(empty); await refresh; });
  expect(calls).toBe(2);
  expect(result.current.snapshot?.tasks).toHaveLength(1);
});
