import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import ScheduledMessagesSheet from '../src/components/ScheduledMessagesSheet.js';
import { scheduledRequest } from '../src/scheduledMessagesApi.js';
import type { ScheduledSnapshot, ScheduledTask } from '../src/scheduledMessagesApi.js';
vi.mock('../src/scheduledMessagesApi.js', () => ({ scheduledRequest: vi.fn() }));
vi.mock('../src/i18n', () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key} ${Object.values(values).join(' ')}` : key }));
const run = { agentId: 'new-agent', paneId: '%1', runId: 'run', sessionId: 'hidden-session-uuid' };
const target = { agentId: 'test', sessionId: 'hidden-session-uuid', paneId: '%1', tmuxSession: 'work' };
const serverNow = Date.parse('2026-10-20T15:30:00Z');
const snapshot: ScheduledSnapshot = { serverNow, timeZone: 'Asia/Shanghai', tasks: [], exceptions: [] };
function mockApi(value = snapshot) {
  vi.mocked(scheduledRequest).mockImplementation(async (_session, _run, action) => action === 'snapshot' ? value : action === 'preview' ? { nextAt: serverNow + 3600000, timeZone: value.timeZone } : {});
}
async function openNew() {
  await screen.findByText('scheduled.empty');
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.add' }));
}
afterEach(async () => { cleanup(); await new Promise((resolve) => setTimeout(resolve, 20)); vi.clearAllMocks(); vi.restoreAllMocks(); });
it('uses the existing drawer and grouped rows; new once is server now plus an hour across midnight despite client clock skew', async () => {
  mockApi(); vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2000-01-01T00:00:00Z'));
  const { container } = render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />);
  await openNew();
  expect(container.querySelector('.tool-sheet .tool-sheet-head')).toBeTruthy();
  expect(container.querySelector('.file-sheet')).toBeNull();
  expect(container.querySelector('.tool-sheet-grip')).toBeTruthy();
  expect(container.querySelector('.tool-sheet-body')).toBeTruthy();
  expect(container.querySelector('.tool-sheet-backdrop')).toBeTruthy();
  expect(container.querySelector('.cmd-panel')).toBeNull();
  expect(container.querySelector('.settings-page-list .settings-page-row')).toBeTruthy();
  expect(screen.queryByLabelText('scheduled.date')).toBeNull();
  expect(screen.queryByLabelText('scheduled.time')).toBeNull();
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'hello' } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.find((call) => call[2] === 'create')?.[3]).toMatchObject({ request: { text: 'hello', frequency: 'once', slots: [{ date: '2026-10-21', time: '00:30' }] } }));
});
it('waits for a server snapshot before enabling add', async () => {
  let resolve!: (value: ScheduledSnapshot) => void;
  vi.mocked(scheduledRequest).mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />);
  expect((screen.getByRole('button', { name: 'scheduled.add' }) as HTMLButtonElement).disabled).toBe(true);
  resolve(snapshot);
  await waitFor(() => expect((screen.getByRole('button', { name: 'scheduled.add' }) as HTMLButtonElement).disabled).toBe(false));
});
it('expands selectors inline, preserves the message, and resets switching back to once from server time', async () => {
  mockApi(); render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />); await openNew();
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'keep me' } });
  fireEvent.click(screen.getByRole('button', { name: /scheduled.repeat/ }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.daily' }));
  expect((screen.getByLabelText('scheduled.message') as HTMLTextAreaElement).value).toBe('keep me');
  expect(screen.getByRole('button', { name: /scheduled.cutoff/ })).toBeTruthy();
  expect(screen.queryByLabelText('scheduled.cutoff')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /scheduled.repeat/ }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.once' }));
  fireEvent.click(screen.getByRole('button', { name: /scheduled.sendTime/ }));
  expect((screen.getByLabelText('scheduled.date') as HTMLInputElement).value).toBe('2026-10-21');
  expect((screen.getByLabelText('scheduled.time') as HTMLInputElement).value).toBe('00:30');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect((screen.getByLabelText('scheduled.message') as HTMLTextAreaElement).value).toBe('keep me');
});
it('uses two-line compact list rows in all tabs with explicit trailing actions and hides full text and raw session IDs', async () => {
  const text = `A summary ${'long message body '.repeat(60)}`;
  const active: ScheduledTask = { id: 'task', revision: 2, text, target, timeZone: 'UTC', state: 'active', enabled: true, nextAt: serverNow + 60000, rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '09:00' }] } };
  mockApi({ ...snapshot, tasks: [active, { ...active, id: 'ended', state: 'ended', endedAt: serverNow }], exceptions: [{ id: 'exception', revision: 3, taskId: 'task', text, target, timeZone: 'UTC', scheduledAt: serverNow, reason: 'delivery_unconfirmed', unknown: true }] });
  const { container } = render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />);
  await screen.findByRole('button', { name: 'scheduled.editAction' });
  for (const tab of ['active', 'ended', 'exceptions']) {
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^scheduled\\.${tab}(?: |$)`) }));
    const row = screen.getByRole('listitem');
    expect(row.querySelector('.scheduled-list-copy')?.children).toHaveLength(2);
    expect(within(row).getByRole('button', { name: `scheduled.${tab === 'active' ? 'editAction' : tab === 'ended' ? 'more' : 'reschedule'}` })).toBeTruthy();
    expect(container.textContent).not.toContain(text);
    expect(container.textContent).not.toContain('hidden-session-uuid');
  }
  expect((screen.getByRole('button', { name: 'scheduled.reschedule' }) as HTMLButtonElement).disabled).toBe(true);
  const css = fs.readFileSync('src/components/scheduledMessages.css', 'utf8');
  expect(css).toMatch(/\.scheduled-list-line\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/s);
});
it('keeps every API-created slot when reopening inline time and repeat dropdowns', async () => {
  const task: ScheduledTask = { id: 'task', revision: 2, text: 'multi', target, timeZone: 'UTC', state: 'active', enabled: true, nextAt: serverNow + 60000, rule: { frequency: 'daily', slots: [{ time: '09:00' }, { time: '18:00' }], endsAt: '2026-11-01T00:00:00Z' } };
  mockApi({ ...snapshot, tasks: [task] });
  render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={null} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'scheduled.editAction' }));
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'edited' } });
  fireEvent.click(screen.getByRole('button', { name: /scheduled.sendTime/ }));
  expect(screen.getAllByLabelText('scheduled.time')).toHaveLength(2);
  expect((screen.getAllByLabelText('scheduled.time')[1] as HTMLInputElement).value).toBe('18:00');
  fireEvent.click(screen.getByRole('button', { name: /scheduled.repeat/ }));
  expect(screen.queryByLabelText('scheduled.time')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.daily' }));
  fireEvent.click(screen.getByRole('button', { name: /scheduled.sendTime/ }));
  expect(screen.getAllByLabelText('scheduled.time')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: /scheduled.cutoff/ }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.cutoffDays 7' }));
  expect((screen.getByLabelText('scheduled.cutoff') as HTMLInputElement).value).toBe('2026-10-27T15:30');

  await waitFor(() => expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.find((call) => call[2] === 'update')?.[3]).toMatchObject({ request: { slots: [{ time: '09:00' }, { time: '18:00' }] } }));
});
it('reschedules an exception with server plus one-hour defaults and uses ActionSheet revision-aware discard', async () => {
  const exception = { id: 'exception', revision: 3, taskId: 'task', text: 'reschedule me', target, timeZone: 'Asia/Shanghai', scheduledAt: serverNow - 6000000, reason: 'missed', unknown: false };
  mockApi({ ...snapshot, exceptions: [exception] });
  render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={null} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: /^scheduled\.exceptions(?: |$)/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'scheduled.reschedule' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.find((call) => call[2] === 'exception')?.[3]).toMatchObject({ id: 'exception', revision: 3, request: { action: 'reschedule', rule: { slots: [{ date: '2026-10-21', time: '00:30' }] } } }));
  fireEvent.click(await screen.findByRole('button', { name: 'scheduled.more' }));
  expect(screen.getByRole('dialog', { name: 'scheduled.actions' }).classList.contains('settings-card')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.discard' }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.discardException' }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.filter((call) => call[2] === 'exception').at(-1)?.[3]).toEqual({ id: 'exception', revision: 3, request: { action: 'discard' } }));
});
it('inline dropdowns add no history: hardware Back returns editor to list, then closes', async () => {
  mockApi(); const closed = vi.fn();
  render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={closed} />); await openNew();
  fireEvent.click(screen.getByRole('button', { name: /scheduled.sendTime/ }));
  window.history.back(); await waitFor(() => expect(screen.queryByLabelText('scheduled.message')).toBeNull());
  expect(closed).not.toHaveBeenCalled();
  window.history.back(); await waitFor(() => expect(closed).toHaveBeenCalledOnce());
});
it('hardware Back dirty confirmation cancellation retains the editor history level', async () => {
  mockApi(); const closed = vi.fn();
  render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={closed} />); await openNew();
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'keep me' } });
  window.history.back(); await screen.findByRole('alertdialog');
  window.history.back(); await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect((screen.getByLabelText('scheduled.message') as HTMLTextAreaElement).value).toBe('keep me');
  expect(closed).not.toHaveBeenCalled();
  window.history.back(); await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.confirm' }));
  await waitFor(() => expect(screen.queryByLabelText('scheduled.message')).toBeNull());
  await waitFor(() => expect(window.history.state?.depth).toBe(1));
  window.history.back(); await waitFor(() => expect(closed).toHaveBeenCalledOnce());
});
it('uses one armed menu confirmation to delete an ended record from its trailing more action', async () => {
  const task: ScheduledTask = { id: 'ended', revision: 7, text: 'done', target, timeZone: 'UTC', state: 'ended', enabled: true, nextAt: null, endedAt: serverNow, rule: { frequency: 'once', slots: [{ date: '2026-10-20', time: '09:00' }] } };
  mockApi({ ...snapshot, tasks: [task] });
  render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'scheduled.ended' }));
  fireEvent.click(await screen.findByRole('button', { name: 'scheduled.more' }));
  expect(screen.getByRole('button', { name: 'scheduled.copy' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.delete' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.clearRecordConfirm' }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.find(call => call[2] === 'delete')?.[3]).toEqual({ id: 'ended', revision: 7 }));
});
it('chooses weekly times independently and requires an explicit cutoff through grouped setting rows', async () => {
  mockApi(); render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />); await openNew();
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'weekly' } });
  fireEvent.click(screen.getByRole('button', { name: /scheduled.repeat/ }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.weekly' }));
  fireEvent.click(screen.getByRole('button', { name: /scheduled.sendTime/ }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.day.1' }));
  fireEvent.change(screen.getByLabelText('scheduled.day.1 scheduled.time'), { target: { value: '09:00' } });
  fireEvent.change(screen.getByLabelText('scheduled.day.3 scheduled.time'), { target: { value: '18:30' } });
  expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /scheduled.cutoff/ }));
  expect((screen.getByLabelText('scheduled.cutoff') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('scheduled.cutoff'), { target: { value: '2026-11-01T23:00' } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.find((call) => call[2] === 'create')?.[3]).toMatchObject({ request: { frequency: 'weekly', slots: [{ weekday: 3, time: '18:30' }, { weekday: 1, time: '09:00' }], endsAtLocal: '2026-11-01T23:00' } }));
});
it('retains edits and shows a revision conflict after another client changes a task', async () => {
  const task: ScheduledTask = { id: 'task', revision: 2, text: 'original', target: { ...target, paneId: '%9' }, timeZone: 'UTC', state: 'active', enabled: true, nextAt: serverNow + 60000, rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '09:00' }] } };
  mockApi({ ...snapshot, tasks: [task] });
  vi.mocked(scheduledRequest).mockImplementation(async (_session, _run, action) => {
    if (action === 'update') throw Error('Changed on another client. Reload the list.');
    return action === 'snapshot' ? { ...snapshot, tasks: [task] } : { nextAt: serverNow + 3600000, timeZone: 'UTC' };
  });
  render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'scheduled.editAction' }));
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'my unsaved message' } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Changed on another client');
  expect((screen.getByLabelText('scheduled.message') as HTMLTextAreaElement).value).toBe('my unsaved message');
  const subtitle = document.querySelector('.scheduled-subtitle')!;
  expect(subtitle.textContent).toBe('scheduled.serverTime: 10/20 23:30');
  expect(document.querySelector('.scheduled-zone-hint')?.textContent).toContain('scheduled.taskTimeZone UTC');
  expect(document.body.textContent).not.toContain('scheduled.pane');
  expect(document.body.textContent).not.toContain('hidden-session-uuid');
});
it('shows full content only in detail and hardware Back dismisses an action menu before the drawer', async () => {
  const text = 'First line\n' + 'Full content '.repeat(30);
  const task: ScheduledTask = { id: 'task', revision: 2, text, target, timeZone: 'UTC', state: 'active', enabled: true, nextAt: serverNow + 60000, rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '09:00' }] } };
  mockApi({ ...snapshot, tasks: [task] }); const closed = vi.fn();
  const { container } = render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={closed} />);
  await screen.findByRole('listitem');
  fireEvent.click(container.querySelector('.scheduled-list-main')!);
  expect(container.querySelector('.scheduled-detail-text')?.textContent).toBe(text);
  expect(container.textContent).not.toContain('hidden-session-uuid');
  window.history.back(); await screen.findByRole('listitem');
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.more' }));
  await screen.findByRole('dialog', { name: 'scheduled.actions' });
  window.history.back(); await waitFor(() => expect(screen.queryByRole('dialog', { name: 'scheduled.actions' })).toBeNull());
  expect(closed).not.toHaveBeenCalled();
  window.history.back(); await waitFor(() => expect(closed).toHaveBeenCalledOnce());
});
it.each(['create', 'refresh'] as const)('does not navigate again when a pending %s finishes after closing the drawer', async (stage) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let snapshots = 0;
  let waiting = false;
  vi.mocked(scheduledRequest).mockImplementation(async (_session, _run, action) => {
    if (action === 'snapshot') {
      snapshots++;
      if (stage === 'refresh' && snapshots > 1) { waiting = true; await pending; }
      return snapshot;
    }
    if (action === 'preview') return { nextAt: serverNow + 3600000, timeZone: snapshot.timeZone };
    if (action === 'create' && stage === 'create') { waiting = true; await pending; }
    return {};
  });
  const unwind = vi.spyOn(window.history, 'go');
  const closed = vi.fn();
  const view = render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => { closed(); view.unmount(); }} />);
  await openNew();
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'save before closing' } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' }));
  await waitFor(() => expect(waiting).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'scheduled.confirm' }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(closed).toHaveBeenCalledOnce();
  const ownedUnwinds = unwind.mock.calls.length;
  await act(async () => { release(); await pending; });
  expect(unwind).toHaveBeenCalledTimes(ownedUnwinds);
});

it('shows server time once beneath the title on every tab and subpage without target or pane metadata', async () => {
  mockApi(); const { container } = render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />);
  await screen.findByText('scheduled.empty');
  const assertSubtitle = () => {
    const header = container.querySelector('.scheduled-head')!;
    const main = header.querySelector('.scheduled-head-main')!;
    const subtitle = header.querySelector('.scheduled-subtitle')!;
    expect(main).toBeTruthy(); expect(main.nextElementSibling).toBe(subtitle);
    expect(subtitle.textContent).toContain('scheduled.serverTime');
    expect(subtitle.textContent).toBe('scheduled.serverTime: 10/20 23:30');
    expect(container.textContent?.match(/scheduled.serverTime/g)).toHaveLength(1);
    expect(container.textContent).not.toContain('scheduled.pane');
    expect(container.textContent).not.toContain('hidden-session-uuid');
    expect(container.querySelector('.scheduled-footer')).toBeNull();
  };
  for (const tab of ['active', 'ended', 'exceptions']) { fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^scheduled\\.${tab}(?: |$)`) })); assertSubtitle(); }
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.add' })); assertSubtitle();
  fireEvent.click(screen.getByRole('button', { name: /scheduled.sendTime/ })); assertSubtitle();
  expect(screen.getByRole('button', { name: 'scheduled.back' }).querySelector('svg')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /scheduled.repeat/ })); assertSubtitle();
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.daily' }));
  fireEvent.click(screen.getByRole('button', { name: /scheduled.cutoff/ })); assertSubtitle();
});
it.each(['active', 'ended'] as const)('uses the correct %s delete explanation from the detail action sheet', async (state) => {
  const item: ScheduledTask = { id: 'task', revision: 2, text: 'message', target, timeZone: 'UTC', state, enabled: true, nextAt: serverNow + 60000, endedAt: serverNow, rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '09:00' }] } };
  mockApi({ ...snapshot, tasks: [item] });
  const { container } = render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^scheduled\\.${state}(?: |$)`) })); await screen.findByRole('listitem');
  fireEvent.click(container.querySelector('.scheduled-list-main')!);
  expect(container.textContent).not.toContain('scheduled.pane');
  expect(container.textContent).not.toContain('hidden-session-uuid');
  expect(container.querySelector('.scheduled-subtitle')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.more' }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.delete' }));
  expect(screen.getByRole('button', { name: state === 'ended' ? 'scheduled.clearRecordConfirm' : 'scheduled.deleteConfirm' })).toBeTruthy();
});

it('offers server-clock cutoff presets inline and blocks custom cutoffs beyond 365 days', async () => {
  mockApi(); vi.spyOn(Date, 'now').mockReturnValue(0);
  render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />); await openNew();
  const depth = window.history.state.depth;
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'preset' } });
  fireEvent.click(screen.getByRole('button', { name: /scheduled.repeat/ }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.daily' }));
  expect(screen.queryByRole('button', { name: 'scheduled.weekly' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /scheduled.cutoff/ }));
  expect(window.history.state.depth).toBe(depth);
  const cutoff = screen.getByLabelText('scheduled.cutoff') as HTMLInputElement;
  expect(cutoff.value).toBe(''); expect(cutoff.min).toBe('2026-10-20T23:30'); expect(cutoff.max).toBe('2027-10-20T23:30');
  for (const [days, local] of [[7, '2026-10-27T23:30'], [30, '2026-11-19T23:30'], [90, '2027-01-18T23:30']] as const) {
    fireEvent.click(screen.getByRole('button', { name: `scheduled.cutoffDays ${days}` })); expect(cutoff.value).toBe(local);
  }
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.filter(call => call[2] === 'preview').at(-1)?.[3]).toMatchObject({ request: { endsAtLocal: '2027-01-18T23:30' }, timeZone: 'Asia/Shanghai' }));
  fireEvent.change(cutoff, { target: { value: '2027-10-21T23:30' } });
  expect(screen.getByRole('status').textContent).toBe('scheduled.cutoffLimit');
  expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(true);
});

it('shows actionable feedback after a completed preview has no executable occurrence', async () => {
  mockApi(); vi.mocked(scheduledRequest).mockImplementation(async (_session, _run, action) => action === 'snapshot' ? snapshot : { nextAt: null, timeZone: snapshot.timeZone });
  render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />); await openNew();
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'no occurrence' } });
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.some(call => call[2] === 'preview')).toBe(true));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('scheduled.chooseFuture'));
  expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(true);
});

it('shows an accessible add icon and year-qualified schedule dates while native pickers retain ISO values', async () => {
  mockApi(); const { container } = render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />);
  await screen.findByText('scheduled.empty');
  const add = screen.getByRole('button', { name: 'scheduled.add' });
  expect(add.textContent).toBe(''); expect(add.querySelector('svg')).toBeTruthy();
  fireEvent.click(add);
  expect(screen.getByRole('button', { name: /scheduled.sendTime/ }).textContent).toContain('2026/10/21 00:30');
  fireEvent.click(screen.getByRole('button', { name: /scheduled.sendTime/ }));
  const date = screen.getByLabelText('scheduled.date') as HTMLInputElement;
  expect(date.type).toBe('date'); expect(date.value).toBe('2026-10-21');
  const time = screen.getByLabelText('scheduled.time') as HTMLInputElement;
  expect(time.type).toBe('time'); expect(time.closest('.scheduled-calendar-input')).toBeNull();
  expect(date.parentElement?.querySelector('.scheduled-picker-display')?.textContent).toBe('2026/10/21');
  fireEvent.change(date, { target: { value: '2027-01-02' } });
  expect(screen.getByRole('button', { name: /scheduled.sendTime/ }).textContent).toContain('2027/01/02 00:30');
  fireEvent.click(screen.getByRole('button', { name: /scheduled.repeat/ }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.daily' }));
  fireEvent.click(screen.getByRole('button', { name: /scheduled.cutoff/ }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.cutoffDays 90' }));
  const cutoff = screen.getByLabelText('scheduled.cutoff') as HTMLInputElement;
  expect(cutoff.type).toBe('datetime-local'); expect(cutoff.value).toBe('2027-01-18T23:30');
  expect(cutoff.min).toBe('2026-10-20T23:30'); expect(cutoff.max).toBe('2027-10-20T23:30');
  expect(cutoff.parentElement?.querySelector('.scheduled-picker-display')?.textContent).toBe('2027/01/18 23:30');
  expect(screen.getByRole('button', { name: /^scheduled.cutoff / }).textContent).toContain('2027/01/18 23:30');
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('scheduled.next: 2026/10/21 00:30'));
  expect(container.textContent).not.toContain('2027-01-18');
});

it('marks ended rows and populated exception tabs with semantic subdued state colors', async () => {
  const task: ScheduledTask = { id: 'ended', revision: 1, text: 'completed', target, timeZone: 'UTC', state: 'ended', enabled: false, nextAt: null, endedAt: Date.parse('2027-01-02T00:05:00Z'), rule: { frequency: 'daily', slots: [{ time: '09:00' }], endsAt: '2027-01-02T00:05:00Z' } };
  mockApi({ ...snapshot, tasks: [task], exceptions: [{ id: 'ex', revision: 1, taskId: 'ended', text: 'retry', target, timeZone: 'UTC', scheduledAt: serverNow, reason: 'missed', unknown: false }] });
  const { container } = render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />);
  await screen.findByText('scheduled.empty');
  expect(screen.getByRole('tab', { name: /^scheduled\.exceptions(?: |$)/ }).classList.contains('scheduled-state-exception')).toBe(true);
  fireEvent.click(screen.getByRole('tab', { name: 'scheduled.ended' }));
  expect(screen.getByRole('listitem').classList.contains('scheduled-state-ended')).toBe(true);
  expect(screen.getByRole('listitem').textContent).toContain('2027/01/02 00:05');
  fireEvent.click(container.querySelector('.scheduled-list-main')!);
  expect(container.querySelector('.scheduled-page')?.textContent).toContain('2027/01/02 00:05');
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.back' }));
  fireEvent.click(screen.getByRole('tab', { name: /^scheduled\.exceptions(?: |$)/ }));
  expect(screen.getByRole('listitem').classList.contains('scheduled-state-exception')).toBe(true);
});

it.each([
  { enabled: true, blocked: false, state: 'active', status: 'pending', label: 'scheduled.pending' },
  { enabled: false, blocked: false, state: 'active', status: 'paused', label: 'scheduled.paused' },
  { enabled: false, blocked: true, state: 'active', status: 'exception', label: 'scheduled.exception' },
  { enabled: false, blocked: false, state: 'ended', status: 'ended', label: 'scheduled.ended' },
  { enabled: false, blocked: true, state: 'ended', status: 'ended', label: 'scheduled.ended' },
] as const)('shows a distinct $status badge in the second list line and detail', async ({ enabled, blocked, state, status, label }) => {
  const task: ScheduledTask = { id: 'status', revision: 1, text: 'status message', target, timeZone: 'UTC', state, enabled, blocked, nextAt: serverNow + 60000, endedAt: serverNow, rule: { frequency: 'daily', slots: [{ time: '09:00' }], endsAt: '2026-11-20T00:00:00Z' } };
  mockApi({ ...snapshot, tasks: [task] });
  const { container } = render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />);
  if (state === 'ended') fireEvent.click(screen.getByRole('tab', { name: 'scheduled.ended' }));
  const row = await screen.findByRole('listitem');
  if (state === 'ended') { expect(row.classList.contains('scheduled-state-ended')).toBe(true); expect(row.classList.contains('scheduled-state-exception')).toBe(false); }
  const copy = row.querySelector('.scheduled-list-copy')!;
  expect(copy.children).toHaveLength(2);
  const badge = copy.children[1]!.querySelector('.scheduled-status-badge')!;
  expect(badge.textContent).toBe(label); expect(badge.classList.contains(`scheduled-status-${status}`)).toBe(true);
  if (state === 'active') expect(copy.children[1]!.querySelector('.scheduled-list-meta-copy')?.textContent).toContain('scheduled.daily');
  fireEvent.click(container.querySelector('.scheduled-list-main')!);
  const detailBadge = container.querySelector('.scheduled-page .scheduled-status-badge')!;
  expect(detailBadge.textContent).toBe(label); expect(detailBadge.classList.contains(`scheduled-status-${status}`)).toBe(true);
});

it('labels exception records explicitly without moving the long reason into the badge', async () => {
  mockApi({ ...snapshot, exceptions: [{ id: 'status-ex', revision: 1, taskId: 'gone', text: 'exception status', target, timeZone: 'UTC', scheduledAt: serverNow, reason: 'delivery_unconfirmed', unknown: true }] });
  const { container } = render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: /^scheduled\.exceptions(?: |$)/ }));
  const row = await screen.findByRole('listitem');
  expect(row.querySelector('.scheduled-status-exception')?.textContent).toBe('scheduled.exception');
  expect(row.querySelector('.scheduled-list-meta-copy')?.textContent).toContain('scheduled.result.failed');
  fireEvent.click(container.querySelector('.scheduled-list-main')!);
  expect(container.querySelector('.scheduled-page .scheduled-status-exception')?.textContent).toBe('scheduled.exception');
});

it('counts active tasks including paused and blocked tasks and updates exceptions from the shared pane snapshot', () => {
  const task: ScheduledTask = { id: 'active', revision: 1, text: 'message', target, timeZone: 'UTC', state: 'active', enabled: true, nextAt: serverNow + 60000, rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '09:00' }] } };
  const exception = { id: 'exception', revision: 1, taskId: 'active', text: 'message', target, timeZone: 'UTC', scheduledAt: serverNow, reason: 'missed', unknown: false };
  const controller = { snapshot: null as ScheduledSnapshot | null, error: '', refresh: vi.fn(async () => {}) };
  const props = { scope: { tmuxSession: 'work', paneId: '%1' }, run, onClose: () => {} };
  const { rerender } = render(<ScheduledMessagesSheet {...props} controller={controller} />);
  expect(screen.getByRole('tab', { name: 'scheduled.active' }).textContent).toBe('scheduled.active');
  controller.snapshot = { ...snapshot, tasks: [task, { ...task, id: 'paused', enabled: false }, { ...task, id: 'blocked', enabled: false, blocked: true }, { ...task, id: 'ended', state: 'ended' }], exceptions: [exception] };
  rerender(<ScheduledMessagesSheet {...props} controller={controller} />);
  expect(screen.getByRole('tab', { name: 'scheduled.active 3' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'scheduled.exceptions 1' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'scheduled.ended' }).textContent).toBe('scheduled.ended');
  controller.snapshot = { ...snapshot, tasks: [task], exceptions: [] };
  rerender(<ScheduledMessagesSheet {...props} controller={controller} />);
  expect(screen.getByRole('tab', { name: 'scheduled.active 1' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'scheduled.exceptions 0' })).toBeTruthy();
  expect(vi.mocked(scheduledRequest)).not.toHaveBeenCalled();
});

it.each(['once', 'daily'] as const)('offers the right %s manual action and submits the existing record without create/delete', async frequency => {
  const task: ScheduledTask = { id: 'manual', revision: 3, text: 'trigger me', target, timeZone: 'UTC', state: 'active', enabled: true, nextAt: serverNow + 60000, rule: { frequency, slots: frequency === 'once' ? [{ date: '2026-10-21', time: '09:00' }] : [{ time: '09:00' }], endsAt: '2026-11-01T00:00:00Z' } };
  mockApi({ ...snapshot, tasks: [task] });
  render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'scheduled.more' }));
  fireEvent.click(screen.getByRole('button', { name: frequency === 'once' ? 'scheduled.sendNow' : 'scheduled.triggerOnce' }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.find(call => call[2] === 'trigger')?.[3]).toEqual({ id: task.id, revision: task.revision }));
  expect(vi.mocked(scheduledRequest).mock.calls.some(call => ['create', 'delete'].includes(call[2]))).toBe(false);
});
it.each([false, true])('copies only an ended message body into a fresh once editor from detail=%s', async detail => {
  const task: ScheduledTask = { id: 'copy-source', revision: 4, text: 'copy just this text', target: { ...target, sessionId: 'old' }, timeZone: 'UTC', state: 'ended', enabled: false, nextAt: null, endedAt: serverNow, rule: { frequency: 'daily', slots: [{ time: '09:00' }, { time: '18:00' }], endsAt: '2026-11-01T00:00:00Z' } };
  mockApi({ ...snapshot, tasks: [task] });
  const { container } = render(<ScheduledMessagesSheet scope={{ tmuxSession: 'work', paneId: '%1' }} run={run} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'scheduled.ended' })); await screen.findByRole('listitem');
  if (detail) fireEvent.click(container.querySelector('.scheduled-list-main')!);
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.more' }));
  expect(screen.queryByRole('button', { name: 'scheduled.sendNow' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.copy' }));
  expect((screen.getByLabelText('scheduled.message') as HTMLTextAreaElement).value).toBe(task.text);
  expect(vi.mocked(scheduledRequest).mock.calls.some(call => call[2] === 'create')).toBe(false);
  await waitFor(() => expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.find(call => call[2] === 'create')).toMatchObject([{ tmuxSession: 'work', paneId: '%1' }, run, 'create', { request: { text: task.text, frequency: 'once', slots: [{ date: '2026-10-21', time: '00:30' }] } }]));
  expect(task.rule.frequency).toBe('daily');
});
