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
  const { container } = render(<ScheduledMessagesSheet tmuxSession="work" run={run} onClose={() => {}} />);
  await openNew();
  expect(container.querySelector('.file-sheet.open .file-tabs')).toBeTruthy();
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
  render(<ScheduledMessagesSheet tmuxSession="work" run={run} onClose={() => {}} />);
  expect((screen.getByRole('button', { name: 'scheduled.add' }) as HTMLButtonElement).disabled).toBe(true);
  resolve(snapshot);
  await waitFor(() => expect((screen.getByRole('button', { name: 'scheduled.add' }) as HTMLButtonElement).disabled).toBe(false));
});
it('keeps selectors in one drawer, preserves the message on Back, and resets switching back to once from server time', async () => {
  mockApi(); render(<ScheduledMessagesSheet tmuxSession="work" run={run} onClose={() => {}} />); await openNew();
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'keep me' } });
  fireEvent.click(screen.getByRole('button', { name: /scheduled.repeat/ }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.daily' }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.back' }));
  expect((screen.getByLabelText('scheduled.message') as HTMLTextAreaElement).value).toBe('keep me');
  expect(screen.getByRole('button', { name: /scheduled.cutoff/ })).toBeTruthy();
  expect(screen.queryByLabelText('scheduled.cutoff')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /scheduled.repeat/ }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.once' }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.back' }));
  fireEvent.click(screen.getByRole('button', { name: /scheduled.sendTime/ }));
  expect((screen.getByLabelText('scheduled.date') as HTMLInputElement).value).toBe('2026-10-21');
  expect((screen.getByLabelText('scheduled.time') as HTMLInputElement).value).toBe('00:30');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  window.history.back(); await screen.findByLabelText('scheduled.message');
  expect((screen.getByLabelText('scheduled.message') as HTMLTextAreaElement).value).toBe('keep me');
});
it('uses two-line compact list rows in all tabs with explicit trailing actions and hides full text and raw session IDs', async () => {
  const text = `A summary ${'long message body '.repeat(60)}`;
  const active: ScheduledTask = { id: 'task', revision: 2, text, target, timeZone: 'UTC', state: 'active', enabled: true, nextAt: serverNow + 60000, rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '09:00' }] } };
  mockApi({ ...snapshot, tasks: [active, { ...active, id: 'ended', state: 'ended', endedAt: serverNow }], exceptions: [{ id: 'exception', revision: 3, taskId: 'task', text, target, timeZone: 'UTC', scheduledAt: serverNow, reason: 'delivery_unconfirmed', unknown: true }] });
  const { container } = render(<ScheduledMessagesSheet tmuxSession="work" run={run} onClose={() => {}} />);
  await screen.findByRole('button', { name: 'scheduled.editAction' });
  for (const tab of ['active', 'ended', 'exceptions']) {
    fireEvent.click(screen.getByRole('tab', { name: `scheduled.${tab}` }));
    const row = screen.getByRole('listitem');
    expect(row.querySelector('.scheduled-list-copy')?.children).toHaveLength(2);
    expect(within(row).getByRole('button', { name: `scheduled.${tab === 'active' ? 'editAction' : tab === 'ended' ? 'delete' : 'reschedule'}` })).toBeTruthy();
    expect(container.textContent).not.toContain(text);
    expect(container.textContent).not.toContain('hidden-session-uuid');
  }
  expect((screen.getByRole('button', { name: 'scheduled.reschedule' }) as HTMLButtonElement).disabled).toBe(true);
  const css = fs.readFileSync('src/components/scheduledMessages.css', 'utf8');
  expect(css).toMatch(/\.scheduled-list-line\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/s);
});
it('keeps every API-created slot when editing through the time drilldown', async () => {
  const task: ScheduledTask = { id: 'task', revision: 2, text: 'multi', target, timeZone: 'UTC', state: 'active', enabled: true, nextAt: serverNow + 60000, rule: { frequency: 'daily', slots: [{ time: '09:00' }, { time: '18:00' }], endsAt: '2026-11-01T00:00:00Z' } };
  mockApi({ ...snapshot, tasks: [task] });
  render(<ScheduledMessagesSheet tmuxSession="work" run={null} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'scheduled.editAction' }));
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'edited' } });
  fireEvent.click(screen.getByRole('button', { name: /scheduled.sendTime/ }));
  expect(screen.getAllByLabelText('scheduled.time')).toHaveLength(2);
  expect((screen.getAllByLabelText('scheduled.time')[1] as HTMLInputElement).value).toBe('18:00');
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.back' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.find((call) => call[2] === 'update')?.[3]).toMatchObject({ request: { slots: [{ time: '09:00' }, { time: '18:00' }] } }));
});
it('reschedules an exception with server plus one-hour defaults and uses ActionSheet revision-aware discard', async () => {
  const exception = { id: 'exception', revision: 3, taskId: 'task', text: 'reschedule me', target, timeZone: 'Asia/Shanghai', scheduledAt: serverNow - 6000000, reason: 'missed', unknown: false };
  mockApi({ ...snapshot, exceptions: [exception] });
  render(<ScheduledMessagesSheet tmuxSession="work" run={null} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'scheduled.exceptions' }));
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
it('hardware Back returns time picker to editor, then list, then closes', async () => {
  mockApi(); const closed = vi.fn();
  render(<ScheduledMessagesSheet tmuxSession="work" run={run} onClose={closed} />); await openNew();
  fireEvent.click(screen.getByRole('button', { name: /scheduled.sendTime/ }));
  window.history.back(); await screen.findByLabelText('scheduled.message');
  window.history.back(); await waitFor(() => expect(screen.queryByLabelText('scheduled.message')).toBeNull());
  expect(closed).not.toHaveBeenCalled();
  window.history.back(); await waitFor(() => expect(closed).toHaveBeenCalledOnce());
});
it('hardware Back dirty confirmation cancellation retains the editor history level', async () => {
  mockApi(); const closed = vi.fn();
  render(<ScheduledMessagesSheet tmuxSession="work" run={run} onClose={closed} />); await openNew();
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
it('ends with a direct destructive confirmation rather than opening a second delete menu', async () => {
  const task: ScheduledTask = { id: 'ended', revision: 7, text: 'done', target, timeZone: 'UTC', state: 'ended', enabled: true, nextAt: null, endedAt: serverNow, rule: { frequency: 'once', slots: [{ date: '2026-10-20', time: '09:00' }] } };
  mockApi({ ...snapshot, tasks: [task] });
  render(<ScheduledMessagesSheet tmuxSession="work" run={run} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'scheduled.ended' }));
  fireEvent.click(await screen.findByRole('button', { name: 'scheduled.delete' }));
  const dialog = screen.getByRole('alertdialog');
  expect(screen.queryByRole('dialog', { name: 'scheduled.actions' })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'scheduled.delete' }));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.find((call) => call[2] === 'delete')?.[3]).toEqual({ id: 'ended', revision: 7 }));
});
it('chooses weekly times independently and requires an explicit cutoff through grouped setting rows', async () => {
  mockApi(); render(<ScheduledMessagesSheet tmuxSession="work" run={run} onClose={() => {}} />); await openNew();
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'weekly' } });
  fireEvent.click(screen.getByRole('button', { name: /scheduled.repeat/ }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.weekly' }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.back' }));
  fireEvent.click(screen.getByRole('button', { name: /scheduled.sendTime/ }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.day.1' }));
  fireEvent.change(screen.getByLabelText('scheduled.day.1 scheduled.time'), { target: { value: '09:00' } });
  fireEvent.change(screen.getByLabelText('scheduled.day.3 scheduled.time'), { target: { value: '18:30' } });
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.back' }));
  expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /scheduled.cutoff/ }));
  expect((screen.getByLabelText('scheduled.cutoff') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('scheduled.cutoff'), { target: { value: '2026-11-01T23:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.back' }));
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
  render(<ScheduledMessagesSheet tmuxSession="work" run={run} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'scheduled.editAction' }));
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'my unsaved message' } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'scheduled.save' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'scheduled.save' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Changed on another client');
  expect((screen.getByLabelText('scheduled.message') as HTMLTextAreaElement).value).toBe('my unsaved message');
  const footer = document.querySelector('.scheduled-page-content > .scheduled-footer')!;
  expect(footer.textContent).toContain('work / scheduled.pane 9');
  expect(footer.textContent).toContain('Asia/Shanghai');
  expect(footer.textContent).toContain('scheduled.taskTimeZone UTC');
  expect(footer.innerHTML).toContain('<br>');
});
it('shows full content only in detail and hardware Back dismisses an action menu before the drawer', async () => {
  const text = 'First line\n' + 'Full content '.repeat(30);
  const task: ScheduledTask = { id: 'task', revision: 2, text, target, timeZone: 'UTC', state: 'active', enabled: true, nextAt: serverNow + 60000, rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '09:00' }] } };
  mockApi({ ...snapshot, tasks: [task] }); const closed = vi.fn();
  const { container } = render(<ScheduledMessagesSheet tmuxSession="work" run={run} onClose={closed} />);
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
  const view = render(<ScheduledMessagesSheet tmuxSession="work" run={run} onClose={() => { closed(); view.unmount(); }} />);
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
