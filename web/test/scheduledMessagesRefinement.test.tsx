import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as presentation from '../src/scheduledMessagesPresentation.js';
import ScheduledMessagesSheet from '../src/components/ScheduledMessagesSheet.js';
import { scheduledRequest } from '../src/scheduledMessagesApi.js';
import type { ScheduledSnapshot, ScheduledTask } from '../src/scheduledMessagesApi.js';
vi.mock('../src/scheduledMessagesApi.js', () => ({ scheduledRequest: vi.fn() }));
const locale = vi.hoisted(() => ({ value: 'en' }));
vi.mock('../src/i18n', () => ({ getLangCode: () => locale.value, t: (key: string) => locale.value === 'en' ? key : `zh:${key}` }));
const now = Date.parse('2026-10-20T15:30:00Z');
const scope = { tmuxSession: 'work', paneId: '%1' };
const run = { agentId: 'generic', sessionId: 'session', runId: 'run', paneId: '%1' };
const task: ScheduledTask = { id: 'task', revision: 1, text: 'original text', target: { ...scope, agentId: 'generic', sessionId: 'session' }, timeZone: 'UTC', state: 'active', enabled: true, nextAt: now + 3600000, rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '09:00' }] } };
const empty: ScheduledSnapshot = { serverNow: now, timeZone: 'UTC', tasks: [], exceptions: [] };
function setup(snapshot = empty, refresh = vi.fn(async () => {})) {
  vi.mocked(scheduledRequest).mockImplementation(async (_scope, _run, action, fields) => action === 'preview' ? { nextAt: now + 3600000, timeZone: 'UTC' } : action === 'update' ? { ...snapshot.tasks.find(task => task.id === fields?.id), ...(fields?.request as object), revision: Number(fields?.revision) + 1 } : {});
  const props = { scope, run, onClose: vi.fn() };
  const view = render(<ScheduledMessagesSheet {...props} controller={{ snapshot, error: '', refresh }} />);
  return { ...view, refresh, rerenderSnapshot: (next: ScheduledSnapshot) => view.rerender(<ScheduledMessagesSheet {...props} controller={{ snapshot: next, error: '', refresh }} />) };
}
afterEach(async () => { cleanup(); await new Promise(resolve => setTimeout(resolve, 20)); vi.clearAllMocks(); vi.restoreAllMocks(); locale.value = 'en'; });
async function newDraft() { fireEvent.click(screen.getByRole('button', { name: 'scheduled.add' })); fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'draft' } }); await waitFor(() => expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(false)); }
it('retains confirmed preview and enabled save while only the body changes', async () => {
  const view = setup(); await newDraft();
  const pageNode = view.container.querySelector('.scheduled-page');
  expect(vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'preview')).toHaveLength(1);
  const preview = screen.getByRole('status').textContent;
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'new body' } });
  expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole('status').textContent).toBe(preview);
  expect(view.container.querySelector('.scheduled-page')).toBe(pageNode);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
  expect(vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'preview')).toHaveLength(1);
});
it('ends acknowledged creation before refresh, offers refresh retry and cannot resubmit that draft', async () => {
  const refresh = vi.fn(async () => {}); refresh.mockRejectedValueOnce(Error('refresh offline'));
  setup(empty, refresh); await newDraft(); fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' }));
  await waitFor(() => expect(screen.queryByLabelText('scheduled.message')).toBeNull());
  expect(screen.getByRole('tab', { name: /scheduled.active/ }).getAttribute('aria-selected')).toBe('true');
  expect((await screen.findByRole('alert')).textContent).toContain('refresh offline');
  fireEvent.click(screen.getByRole('button', { name: 'common.retry' })); await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'create')).toHaveLength(1);
});
it('derives detail and open menu from the latest snapshot and leaves removed records', async () => {
  const view = setup({ ...empty, tasks: [task] });
  fireEvent.click(view.container.querySelector('.scheduled-list-main')!);
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.more' }));
  view.rerenderSnapshot({ ...empty, tasks: [{ ...task, revision: 9, enabled: false, text: 'latest body' }] });
  expect(view.container.querySelector('.scheduled-detail-text')?.textContent).toBe('latest body');
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.resume' }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.find(call => call[2] === 'update')?.[3]).toMatchObject({ revision: 9 }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.more' }));
  view.rerenderSnapshot(empty);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'scheduled.actions' })).toBeNull());
  expect(view.container.querySelector('.scheduled-detail-text')).toBeNull(); expect(screen.getByRole('tab', { name: /scheduled.active/ })).toBeTruthy();
});
it('keeps draft contents and its original revision across live updates', async () => {
  const view = setup({ ...empty, tasks: [task] }); fireEvent.click(screen.getByRole('button', { name: 'scheduled.editAction' })); await screen.findByLabelText('scheduled.message');
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'my draft' } });
  view.rerenderSnapshot({ ...empty, tasks: [{ ...task, revision: 9, text: 'remote edit' }] });
  expect((screen.getByLabelText('scheduled.message') as HTMLTextAreaElement).value).toBe('my draft');
  await waitFor(() => expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'update').at(-1)?.[3]).toMatchObject({ revision: 2, request: { text: 'my draft', enabled: true } }));
});
it('starts new pages at top and restores each tab position without resetting on polls', async () => {
  const view = setup({ ...empty, tasks: [task, { ...task, id: 'ended', state: 'ended' }] });
  const body = view.container.querySelector('.scheduled-body') as HTMLElement;
  body.scrollTop = 1800; fireEvent.scroll(body);
  fireEvent.click(view.container.querySelector('.scheduled-list-main')!); expect(body.scrollTop).toBe(0);
  body.scrollTop = 300; fireEvent.click(screen.getByRole('button', { name: 'scheduled.back' })); expect(body.scrollTop).toBe(1800);
  fireEvent.click(screen.getByRole('tab', { name: 'scheduled.ended' })); expect(body.scrollTop).toBe(0);
  body.scrollTop = 400; fireEvent.click(screen.getByRole('tab', { name: /scheduled.active/ })); expect(body.scrollTop).toBe(1800);
  view.rerenderSnapshot({ ...empty, tasks: [task] }); expect(body.scrollTop).toBe(1800);
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.editAction' })); await screen.findByLabelText('scheduled.message'); expect(body.scrollTop).toBe(0);
});
it('announces pending save and per-record trigger while leaving close available', async () => {
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const view = setup({ ...empty, tasks: [task] });
  vi.mocked(scheduledRequest).mockImplementation(async (_scope, _run, action) => action === 'trigger' ? await pending : { nextAt: now + 3600000, timeZone: 'UTC' });
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.more' })); fireEvent.click(screen.getByRole('button', { name: 'scheduled.sendNow' }));
  expect(view.container.querySelector('.scheduled-list-row[aria-busy="true"]')).toBeTruthy();
  expect(screen.getByText('scheduled.submitting')).toBeTruthy(); expect((screen.getByRole('button', { name: 'common.close' }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { release(); await pending; });
});

it('marks the save action busy without blocking close and completes before the following read', async () => {
  setup(); await newDraft(); let release!: () => void;
  vi.mocked(scheduledRequest).mockImplementation(async () => await new Promise<void>(resolve => { release = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' }));
  expect(screen.getByRole('button', { name: 'scheduled.saving' }).getAttribute('aria-busy')).toBe('true');
  expect((document.querySelector('.scheduled-editor-fields') as HTMLFieldSetElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'common.close' }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { release(); await Promise.resolve(); });
  await waitFor(() => expect(screen.queryByLabelText('scheduled.message')).toBeNull());
});

it('clears a refresh failure only after a newer authoritative successful snapshot', async () => {
  const refresh = vi.fn(async () => { throw Error('read failed'); });
  const view = setup(empty, refresh); await newDraft(); fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' }));
  await screen.findByText('read failed');
  view.rerenderSnapshot(empty); expect(screen.getByRole('alert').textContent).toContain('read failed');
  view.rerenderSnapshot({ ...empty, serverNow: now + 3000, tasks: [task] });
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});
it('places brief save acknowledgement beside server time and clears it without navigating', async () => {
  const view = setup(); await newDraft(); vi.useFakeTimers();
  try {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' })); await Promise.resolve(); });
    const message = screen.getByText('scheduled.saved');
    expect(message.parentElement?.classList.contains('scheduled-subtitle')).toBe(true);
    const page = view.container.querySelector('.scheduled-page');
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    expect(screen.queryByText('scheduled.saved')).toBeNull(); expect(view.container.querySelector('.scheduled-page')).toBe(page);
  } finally { vi.useRealTimers(); }
});

it('reuses unchanged row presentation on new snapshot objects without losing same-revision state updates or language changes', () => {
  const summary = vi.spyOn(presentation, 'scheduledSummary');
  const view = setup({ ...empty, tasks: [task] });
  const calls = summary.mock.calls.length;
  view.rerenderSnapshot({ ...empty, serverNow: now + 3000, tasks: [structuredClone(task)] });
  expect(summary).toHaveBeenCalledTimes(calls);
  view.rerenderSnapshot({ ...empty, tasks: [{ ...task, blocked: true, enabled: false }] });
  expect(view.container.querySelector('.scheduled-status-exception')?.textContent).toBe('scheduled.exception');
  locale.value = 'zh'; view.rerenderSnapshot({ ...empty, tasks: [{ ...task, blocked: true, enabled: false }] });
  expect(view.container.querySelector('.scheduled-status-exception')?.textContent).toBe('zh:scheduled.exception');
});
it('uses the latest clock for rescheduling after a memoized poll and the latest revision for menu actions', async () => {
  const exception = { id: 'exception', revision: 1, taskId: 'gone', text: 'reschedule', target: task.target, timeZone: 'UTC', scheduledAt: now, reason: 'missed', unknown: false };
  const view = setup({ ...empty, tasks: [task], exceptions: [exception] });
  fireEvent.click(screen.getByRole('tab', { name: /scheduled.exceptions/ }));
  view.rerenderSnapshot({ ...empty, serverNow: now + 86400000, tasks: [structuredClone(task)], exceptions: [structuredClone(exception)] });
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.reschedule' }));
  expect(screen.getByRole('button', { name: /scheduled.sendTime/ }).textContent).toContain('10/21 16:30');
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.back' }));
  fireEvent.click(screen.getByRole('tab', { name: /scheduled.active/ }));
  view.rerenderSnapshot({ ...empty, tasks: [{ ...task, revision: 9, enabled: false }] });
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.more' }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.resume' }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.find(call => call[2] === 'update')?.[3]).toMatchObject({ revision: 9 }));
});

it('disables a confirmed preview after shared server time reaches it without scheduling a fresh preview poll', async () => {
  const view = setup(); await newDraft();
  view.rerenderSnapshot({ ...empty, serverNow: now + 3600000 });
  expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toBe('scheduled.chooseFuture');
  expect(vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'preview')).toHaveLength(1);
});

it('updates date years at the server year boundary without consulting the browser clock', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2000-01-01T00:00:00Z'));
  const yearEnd = { ...empty, timeZone: 'Asia/Shanghai', serverNow: Date.parse('2026-12-31T15:59:59Z'), tasks: [{ ...task, state: 'ended' as const, endedAt: Date.parse('2026-12-31T15:50:00Z') }] };
  const view = setup(yearEnd);
  fireEvent.click(screen.getByRole('tab', { name: 'scheduled.ended' }));
  expect(view.container.querySelector('.scheduled-list-meta-copy')?.textContent).toContain('12/31 15:50');
  expect(view.container.querySelector('.scheduled-list-meta-copy')?.textContent).not.toContain('2026/');
  view.rerenderSnapshot({ ...yearEnd, serverNow: Date.parse('2026-12-31T16:00:01Z') });
  expect(view.container.querySelector('.scheduled-list-meta-copy')?.textContent).toContain('2026/12/31 15:50');
});

it('closes the active-list menu when its task finishes instead of exposing ended-record deletion', async () => {
  const view = setup({ ...empty, tasks: [task] });
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.more' }));
  expect(screen.getByRole('dialog', { name: 'scheduled.actions' })).toBeTruthy();
  view.rerenderSnapshot({ ...empty, tasks: [{ ...task, state: 'ended', endedAt: now, nextAt: null }] });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'scheduled.actions' })).toBeNull());
  expect(screen.queryByRole('button', { name: 'scheduled.delete' })).toBeNull();
});
