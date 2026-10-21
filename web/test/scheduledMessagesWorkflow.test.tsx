import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ScheduledMessagesSheet from '../src/components/ScheduledMessagesSheet.js';
import { scheduledRequest } from '../src/scheduledMessagesApi.js';
import { scheduledRelativeTime, scheduledRuleSummary } from '../src/scheduledMessagesPresentation.js';
import type { ScheduledTask } from '../src/scheduledMessagesApi.js';
import { t } from '../src/i18n';
vi.mock('../src/scheduledMessagesApi.js', () => ({ scheduledRequest: vi.fn() }));
const now = Date.parse('2026-10-20T00:00:00Z');
const scope = { tmuxSession: 'work', paneId: '%1' };
const task: ScheduledTask = { id: 'task', revision: 1, target: { ...scope, agentId: 'generic', sessionId: 'session' }, text: 'original', state: 'active', enabled: true, timeZone: 'UTC', nextAt: now + 60000, rule: { frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-21T00:00:00Z' } };
function setup(enabled = true) {
  let current: ScheduledTask = { ...task, enabled };
  vi.mocked(scheduledRequest).mockImplementation(async (_scope, _run, action, fields) => {
    if (action === 'snapshot') return { serverNow: now, timeZone: 'UTC', tasks: [current], exceptions: [] };
    if (action === 'preview') return { nextAt: now + 60000, timeZone: 'UTC' };
    if (action === 'update') { current = { ...current, ...(fields?.request as object), revision: current.revision + 1 }; return current; }
    if (action === 'terminate') { current = { ...current, state: 'ended', enabled: false, endedReason: 'terminated', endedAt: now, nextAt: null }; return current; }
    return {};
  });
  const onClose = vi.fn();
  return { ...render(<ScheduledMessagesSheet scope={scope} run={null} onClose={onClose} />), onClose };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('normalizes relative days/hours/minutes and includes all localized rule slots', () => {
  expect(scheduledRelativeTime(now + 59999, now)).toBe(t('scheduled.inDuration', { duration: t('scheduled.durationMinutes', { count: 1 }) }));
  expect(scheduledRelativeTime(now + 3599001, now)).toBe(t('scheduled.inDuration', { duration: t('scheduled.durationHours', { count: 1 }) }));
  expect(scheduledRelativeTime(now + 90000001, now)).toBe(t('scheduled.inDuration', { duration: [t('scheduled.durationDays', { count: 1 }), t('scheduled.durationHours', { count: 1 }), t('scheduled.durationMinutes', { count: 1 })].join(t('scheduled.durationSeparator')) }));
  expect(scheduledRelativeTime(now - 1, now)).toBe(t('scheduled.pending'));
  expect(scheduledRuleSummary({ frequency: 'hourly', slots: [{ minute: 5 }, { minute: 45 }] })).toContain(t('scheduled.hourlyMinute', { minute: '05' }));
  const weekly = scheduledRuleSummary({ frequency: 'weekly', slots: [{ weekday: 3, time: '10:00' }, { weekday: 1, time: '09:30' }] });
  expect(weekly).toContain(`${t('scheduled.day.1')} 09:30`); expect(weekly).toContain(`${t('scheduled.day.3')} 10:00`);
});
it('terminates after one confirmation and shows a distinct ended state without claiming submission', async () => {
  const view = setup(); fireEvent.click(await screen.findByRole('button', { name: t('scheduled.more') }));
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.terminate') }));
  expect(vi.mocked(scheduledRequest).mock.calls.some(call => call[2] === 'terminate')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.terminateConfirm') }));
  await waitFor(() => expect(screen.getByRole('tab', { name: t('scheduled.ended') }).getAttribute('aria-selected')).toBe('true'));
  expect(view.container.querySelector('.scheduled-status-terminated')).toBeTruthy();
  expect(view.container.querySelector('.scheduled-list-meta-copy')?.textContent).not.toContain(t('scheduled.result.submitted'));
});
it.each([true, false])('pauses before editing and restores the original enabled=%s on cancel and save', async enabled => {
  setup(enabled); fireEvent.click(await screen.findByRole('button', { name: t('scheduled.editAction') }));
  await screen.findByLabelText(t('scheduled.message'));
  if (enabled) expect(vi.mocked(scheduledRequest).mock.calls.find(call => call[2] === 'update')?.[3]).toMatchObject({ revision: 1, request: { enabled: false } });
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.back') }));
  await waitFor(() => expect(screen.queryByLabelText(t('scheduled.message'))).toBeNull());
  expect((vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'update').at(-1)?.[3]?.request as { enabled: boolean }).enabled).toBe(enabled);
  fireEvent.click(await screen.findByRole('button', { name: t('scheduled.editAction') })); await screen.findByLabelText(t('scheduled.message'));
  fireEvent.change(screen.getByLabelText(t('scheduled.message')), { target: { value: 'edited' } });
  await waitFor(() => expect((screen.getByRole('button', { name: t('scheduled.save') }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.save') }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'update').at(-1)?.[3]?.request).toMatchObject({ text: 'edited', enabled }));
});

it('requires pause acknowledgement, handles failure, and safely restores a normal close during that pause', async () => {
  const view = setup(); const edit = await screen.findByRole('button', { name: t('scheduled.editAction') });
  vi.mocked(scheduledRequest).mockRejectedValueOnce(Error('pause conflict'));
  fireEvent.click(edit);
  expect((await screen.findByRole('alert')).textContent).toContain('pause conflict');
  expect(screen.queryByLabelText(t('scheduled.message'))).toBeNull();
  const base = vi.mocked(scheduledRequest).getMockImplementation()!;
  let release!: (value: ScheduledTask) => void;
  vi.mocked(scheduledRequest).mockImplementationOnce(async () => await new Promise(resolve => { release = resolve; }));
  fireEvent.click(edit); fireEvent.click(screen.getByRole('button', { name: t('common.close') }));
  expect(view.onClose).not.toHaveBeenCalled();
  vi.mocked(scheduledRequest).mockImplementation(base);
  await act(async () => { release({ ...task, revision: 2, enabled: false }); });
  await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce());
  expect(vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'update').at(-1)?.[3]).toMatchObject({ revision: 2, request: { enabled: true } });
});
it('does not overwrite a remote revision when cancel restore fails, leaves an actionable list and permits close', async () => {
  const view = setup(); fireEvent.click(await screen.findByRole('button', { name: t('scheduled.editAction') })); await screen.findByLabelText(t('scheduled.message'));
  vi.mocked(scheduledRequest).mockRejectedValueOnce(Error('revision conflict'));
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.back') }));
  expect((await screen.findByRole('alert')).textContent).toContain(t('scheduled.restoreFailed'));
  expect(screen.queryByLabelText(t('scheduled.message'))).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: t('common.close') })); expect(view.onClose).toHaveBeenCalledOnce();
});
it('keeps the acknowledged pause if the editor unexpectedly unmounts', async () => {
  const view = setup(); fireEvent.click(await screen.findByRole('button', { name: t('scheduled.editAction') })); await screen.findByLabelText(t('scheduled.message'));
  view.unmount();
  expect(vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'update')).toHaveLength(1);
});
it('resizes wrapped text between three and eight rows, including width changes', async () => {
  let changed!: ResizeObserverCallback;
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { changed = callback; } observe() {} disconnect() {} });
  setup(); fireEvent.click(await screen.findByRole('button', { name: t('scheduled.editAction') }));
  const input = await screen.findByLabelText(t('scheduled.message')) as HTMLTextAreaElement;
  input.style.lineHeight = '24px'; input.style.padding = '14px 16px';
  let measured = 1000; Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => measured });
  fireEvent.change(input, { target: { value: 'a long wrapped paragraph' } });
  expect(input.style.height).toBe('220px'); expect(input.style.overflowY).toBe('auto');
  measured = 60; fireEvent.change(input, { target: { value: 'short' } });
  expect(input.style.height).toBe('100px'); expect(input.style.overflowY).toBe('hidden');
  measured = 180; changed([{ contentRect: { width: 120 } }] as ResizeObserverEntry[], {} as ResizeObserver);
  expect(input.style.height).toBe('180px');
});
