import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ScheduledMessagesSheet from '../src/components/ScheduledMessagesSheet.js';
import { scheduledRequest } from '../src/scheduledMessagesApi.js';
import { scheduledRelativeTime, scheduledRuleSummary } from '../src/scheduledMessagesPresentation.js';
import type { ScheduledTask } from '../src/scheduledMessagesApi.js';
import { t } from '../src/i18n';
import { ApiError } from '../src/apiErrors.js';
vi.mock('../src/scheduledMessagesApi.js', () => ({ scheduledRequest: vi.fn() }));
const now = Date.parse('2026-10-20T00:00:00Z');
const scope = { tmuxSession: 'work', paneId: '%1' };
const task: ScheduledTask = { id: 'task', revision: 1, target: { ...scope, agentId: 'generic', sessionId: 'session' }, text: 'original', state: 'active', enabled: true, timeZone: 'UTC', nextAt: now + 60000, rule: { frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-21T00:00:00Z' } };
function setup(enabled = true, initial: ScheduledTask = task) {
  let current: ScheduledTask = { ...initial, enabled };
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
  expect(scheduledRelativeTime(now - 1, now)).toBe(t('scheduled.inDuration', { duration: t('scheduled.durationMinutes', { count: 0 }) }));
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

it('shows one once timestamp with relative time and separates recurring frequency badges from slot text', async () => {
  const once: ScheduledTask = { ...task, rule: { frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }] } };
  const view = setup(true, once); await screen.findByRole('listitem');
  const meta = view.container.querySelector('.scheduled-list-meta-copy')!.textContent!;
  expect(meta.match(/10\/20 00:01/g)).toHaveLength(1);
  expect(meta).toContain(`(${t('scheduled.nextExecution', { time: t('scheduled.inDuration', { duration: t('scheduled.durationMinutes', { count: 1 }) }) })})`);
  view.unmount();
  const cycle = setup(true); await screen.findByRole('listitem');
  expect(cycle.container.querySelector('.scheduled-frequency-badge')?.textContent).toBe(t('scheduled.hourly'));
  expect(cycle.container.querySelector('.scheduled-list-meta-copy')?.textContent).not.toContain('10/20 00:01');
  expect(cycle.container.querySelector('.scheduled-list-meta-copy')?.textContent).toBe('每小时 01 分 (下次执行：1分钟后)');
});
it('labels expired paused once schedules and disables resume while normal editing stays paused', async () => {
  const expired: ScheduledTask = { ...task, enabled: false, expired: true, nextAt: now - 60000, rule: { frequency: 'once', slots: [{ date: '2026-10-19', time: '23:59' }] } };
  const view = setup(false, expired); await screen.findByRole('listitem');
  expect(view.container.querySelector('.scheduled-status-paused')).toBeTruthy();
  expect(view.container.querySelector('.scheduled-list-meta-copy')?.textContent).toContain(`(${t('scheduled.expired')})`);
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.more') }));
  expect((screen.getByRole('button', { name: t('scheduled.resumeExpired') }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: t('scheduled.reschedule') })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.editAction') })); await screen.findByLabelText(t('scheduled.message'));
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.back') })); await waitFor(() => expect(screen.queryByLabelText(t('scheduled.message'))).toBeNull());
  expect(vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'update')).toHaveLength(1);
  expect(vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'update').at(-1)?.[3]).toMatchObject({ request: { enabled: false } });
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.editAction') })); await screen.findByLabelText(t('scheduled.message'));
  fireEvent.click(screen.getByRole('button', { name: `${t('scheduled.sendTime')} 1` }));
  fireEvent.change(screen.getByLabelText(t('scheduled.date')), { target: { value: '2026-10-20' } });
  fireEvent.change(screen.getByLabelText(t('scheduled.time')), { target: { value: '00:05' } });
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.confirm') }));
  await waitFor(() => expect((screen.getByRole('button', { name: t('scheduled.save') }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.save') }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'update').at(-1)?.[3]).toMatchObject({ request: { enabled: false, slots: [{ date: '2026-10-20', time: '00:05' }] } }));
});
it('marks a paused future reference as inactive without adding that label to active plans', async () => {
  const view = setup(false); await screen.findByRole('listitem');
  expect(view.container.querySelector('.scheduled-list-meta-copy')?.textContent).toContain(t('scheduled.pausedReference'));
  expect(view.container.querySelector('.scheduled-list-meta-copy')?.textContent).not.toContain(t('scheduled.inDuration', { duration: t('scheduled.durationMinutes', { count: 1 }) }));
  fireEvent.click(view.container.querySelector('.scheduled-list-main')!);
  expect(view.container.querySelector('.scheduled-detail-content')?.textContent).toContain(t('scheduled.pausedReference'));
  expect(view.container.querySelector('.scheduled-detail-content')?.textContent).not.toContain(t('scheduled.inDuration', { duration: t('scheduled.durationMinutes', { count: 1 }) }));
});

it.each(['daily', 'weekly'] as const)('keeps the full %s frequency alongside selected times', async frequency => {
  const view = setup(true, { ...task, rule: { frequency, slots: [{ time: '09:30', ...(frequency === 'weekly' ? { weekday: 1 } : {}) }], endsAt: '2026-10-21T00:00:00Z' } });
  await screen.findByRole('listitem');
  const meta = view.container.querySelector('.scheduled-list-meta-copy')!.textContent!;
  expect(meta).toContain(`${t(`scheduled.${frequency}`)} ${frequency === 'weekly' ? `${t('scheduled.day.1')} ` : ''}09:30`);
});

it.each([true, false])('puts the recurrence before the next-execution hint when enabled=%s', async enabled => {
  const view = setup(enabled, { ...task, rule: { frequency: 'daily', slots: [{ time: '09:30' }], endsAt: '2026-10-21T00:00:00Z' } });
  await screen.findByRole('listitem');
  const hint = enabled ? '下次执行：1分钟后' : '下次执行：--';
  expect(view.container.querySelector('.scheduled-list-meta-copy')?.textContent).toBe(`每天 09:30 (${hint})`);
  fireEvent.click(view.container.querySelector('.scheduled-list-main')!);
  expect(view.container.querySelector('.scheduled-detail-content')?.textContent).toContain(`(${hint})`);
});

it.each([false, true])('offers termination without deletion for active tasks in detail=%s', async detail => {
  const view = setup(); await screen.findByRole('listitem');
  if (detail) fireEvent.click(view.container.querySelector('.scheduled-list-main')!);
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.more') }));
  expect(screen.queryByRole('button', { name: t('scheduled.delete') })).toBeNull();
  expect(screen.getByRole('button', { name: t('scheduled.terminate') })).toBeTruthy();
});

it.each(['back', 'close'] as const)('restores pre-edit enabled state after a pending save fails following explicit %s', async exit => {
  const h = await pendingSave();
  h.exit(exit);
  expect(screen.queryByLabelText(t('scheduled.message'))).toBeNull();
  if (exit === 'close') expect(h.onClose).toHaveBeenCalledOnce();
  await act(async () => { h.rejectSave(Error('network offline')); });
  await waitFor(() => expect(h.current().enabled).toBe(true));
  expect(h.current().text).toBe('original');
  expect(h.restoreRequests()).toEqual([{ id: 'task', revision: 2, request: { enabled: true } }]);
});
it.each(['acknowledged', 'lost acknowledgement', 'remote edit'] as const)('does not overwrite %s after leaving a pending save', async outcome => {
  const h = await pendingSave(); h.exit('back');
  h.setCurrent({ ...h.current(), revision: 3, text: outcome === 'remote edit' ? 'remote' : 'edited', enabled: outcome !== 'remote edit' });
  await act(async () => { if (outcome === 'acknowledged') h.resolveSave(h.current()); else h.rejectSave(Error('network offline')); });
  await waitFor(() => expect(screen.getByRole('button', { name: t('scheduled.editAction') }).hasAttribute('disabled')).toBe(false));
  expect(h.current()).toMatchObject({ revision: 3, text: outcome === 'remote edit' ? 'remote' : 'edited', enabled: outcome !== 'remote edit' });
  if (outcome === 'acknowledged') expect(h.restoreRequests()).toHaveLength(0);
  else expect((await screen.findByRole('alert')).textContent).toContain(t('scheduled.restoreFailed'));
});
it('keeps a paused task and reports an unverifiable restore without retrying the save', async () => {
  const h = await pendingSave(true); h.exit('back');
  await act(async () => { h.rejectSave(Error('save timeout')); });
  expect((await screen.findByRole('alert')).textContent).toContain(t('scheduled.restoreFailed'));
  expect(h.current()).toMatchObject({ revision: 2, enabled: false, text: 'original' });
  expect(h.restoreRequests()).toHaveLength(1);
  expect(vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'update' && (call[3]?.request as { text?: string })?.text)).toHaveLength(1);
});
it('keeps the pause when a pending save fails after an unexpected unmount', async () => {
  const h = await pendingSave(); h.unmount();
  await act(async () => { h.rejectSave(Error('network offline')); });
  expect(h.current().enabled).toBe(false); expect(h.restoreRequests()).toHaveLength(0);
});
async function pendingSave(failRestore = false) {
  let current: ScheduledTask = { ...task };
  let resolveSave!: (value: ScheduledTask) => void; let rejectSave!: (cause: Error) => void;
  vi.mocked(scheduledRequest).mockImplementation(async (_scope, _run, action, fields) => {
    if (action === 'snapshot') return { serverNow: now, timeZone: 'UTC', tasks: [current], exceptions: [] };
    if (action === 'preview') return { nextAt: now + 60000, timeZone: 'UTC' };
    if (action === 'update') {
      const request = fields?.request as Partial<ScheduledTask>;
      if (request.text) return await new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
      if (fields?.revision !== current.revision) throw new ApiError('revision conflict', 409);
      if (request.enabled && failRestore) throw Error('restore timeout');
      current = { ...current, ...request, revision: current.revision + 1 }; return current;
    }
    return {};
  });
  const onClose = vi.fn();
  // Explicit close unmounts the drawer, like its real parent.
  const view = render(<ScheduledMessagesSheet scope={scope} run={null} onClose={() => { onClose(); view.unmount(); }} />);
  fireEvent.click(await screen.findByRole('button', { name: t('scheduled.editAction') }));
  fireEvent.change(await screen.findByLabelText(t('scheduled.message')), { target: { value: 'edited' } });
  await waitFor(() => expect((screen.getByRole('button', { name: t('scheduled.save') }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: t('scheduled.save') }));
  return {
    ...view, onClose, resolveSave, rejectSave, current: () => current, setCurrent: (next: ScheduledTask) => { current = next; },
    restoreRequests: () => vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'update' && (call[3]?.request as Partial<ScheduledTask>)?.enabled === true && !(call[3]?.request as Partial<ScheduledTask>)?.text).map(call => call[3]),
    exit: (kind: 'back' | 'close') => {
      fireEvent.click(screen.getByRole('button', { name: t(kind === 'back' ? 'scheduled.back' : 'common.close') }));
      fireEvent.click(screen.getByRole('button', { name: t('scheduled.confirm') }));
    },
  };
}

it.each(['once', 'daily'] as const)('puts the same paused badge at the lower left for %s schedules', async frequency => {
  const view = setup(false, { ...task, rule: { frequency, slots: frequency === 'once' ? [{ date: '2026-10-20', time: '00:01' }] : [{ time: '09:30' }], endsAt: '2026-10-21T00:00:00Z' } });
  const row = await screen.findByRole('listitem');
  const meta = row.querySelector('.scheduled-list-meta')!;
  expect(meta.firstElementChild?.textContent).toBe(t('scheduled.paused'));
  expect(row.querySelector('.scheduled-list-summary .scheduled-status-paused')).toBeNull();
  expect(view.container.querySelectorAll('.scheduled-status-paused')).toHaveLength(1);
});
