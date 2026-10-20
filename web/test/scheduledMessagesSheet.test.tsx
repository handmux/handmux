import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import ScheduledMessagesSheet from '../src/components/ScheduledMessagesSheet.js';
import { scheduledRequest } from '../src/scheduledMessagesApi.js';
vi.mock('../src/scheduledMessagesApi.js', () => ({ scheduledRequest: vi.fn() }));
vi.mock('../src/i18n', () => ({ t: (key: string) => key }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('uses one multistep sheet and server preview before saving', async () => {
  vi.mocked(scheduledRequest).mockImplementation(async (_session, _run, action) => action === 'snapshot' ? { serverNow: Date.now(), timeZone: 'UTC', tasks: [], exceptions: [] } : action === 'preview' ? { nextAt: Date.now() + 60000, timeZone: 'UTC' } : {});
  render(<ScheduledMessagesSheet tmuxSession="work" run={{ agentId: 'new-agent', paneId: '%1', runId: 'run', sessionId: 'session' }} onClose={() => {}} />);
  await screen.findByText('scheduled.empty');
  fireEvent.click(screen.getByText('scheduled.add'));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'hello' } });
  fireEvent.change(screen.getByLabelText('scheduled.date'), { target: { value: '2026-10-21' } });
  fireEvent.change(screen.getByLabelText('scheduled.time'), { target: { value: '10:00' } });
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.some((call) => call[2] === 'preview')).toBe(true));
  fireEvent.click(screen.getByText('scheduled.save'));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.some((call) => call[2] === 'create')).toBe(true));
});
it('keeps every API-created slot while editing and never silently truncates to UI defaults', async () => {
  const task = { id: 'task', revision: 2, text: 'multi', target: { agentId: 'test', sessionId: 'original', paneId: '%1', tmuxSession: 'work' }, timeZone: 'UTC', state: 'active', enabled: true, nextAt: Date.now() + 60000, rule: { frequency: 'daily', slots: [{ time: '09:00' }, { time: '18:00' }], endsAt: '2026-11-01T00:00:00Z' } };
  vi.mocked(scheduledRequest).mockImplementation(async (_session, _run, action) => action === 'snapshot' ? { serverNow: Date.now(), timeZone: 'UTC', tasks: [task], exceptions: [] } : action === 'preview' ? { nextAt: Date.now() + 60000, timeZone: 'UTC' } : {});
  render(<ScheduledMessagesSheet tmuxSession="work" run={null} onClose={() => {}} />);
  fireEvent.click(await screen.findByText('multi'));
  expect(screen.getAllByLabelText('scheduled.time')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'edited' } });
  await waitFor(() => expect((screen.getByText('scheduled.save') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByText('scheduled.save'));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.find((call) => call[2] === 'update')?.[3]).toMatchObject({ request: { slots: [{ time: '09:00' }, { time: '18:00' }] } }));
});
it('shows unknown exceptions with resend disabled and can discard with a revision', async () => {
  const exception = { id: 'exception', revision: 3, taskId: 'task', text: 'uncertain', target: { agentId: 'test', sessionId: 'original', paneId: '%1', tmuxSession: 'work' }, timeZone: 'UTC', scheduledAt: Date.now(), reason: 'delivery_unconfirmed', unknown: true };
  vi.mocked(scheduledRequest).mockResolvedValue({ serverNow: Date.now(), timeZone: 'UTC', tasks: [], exceptions: [exception] });
  render(<ScheduledMessagesSheet tmuxSession="work" run={null} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'scheduled.exceptions' }));
  await screen.findByText('uncertain');
  expect((screen.getByText('scheduled.reschedule') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText('scheduled.discard')); fireEvent.click(screen.getByText('scheduled.confirm'));
  await waitFor(() => expect(vi.mocked(scheduledRequest).mock.calls.find((call) => call[2] === 'exception')?.[3]).toEqual({ id: 'exception', revision: 3, request: { action: 'discard' } }));
});
it('keeps preview validation errors actionable', async () => {
  vi.mocked(scheduledRequest).mockImplementation(async (_session, _run, action) => { if (action === 'preview') throw Error('Cutoff must be after the next slot'); return { serverNow: Date.now(), timeZone: 'UTC', tasks: [], exceptions: [] }; });
  render(<ScheduledMessagesSheet tmuxSession="work" run={{ agentId: 'test', paneId: '%1', runId: 'run' }} onClose={() => {}} />);
  fireEvent.click(screen.getByText('scheduled.add'));
  await screen.findByText(/Cutoff must be after the next slot/);
});
