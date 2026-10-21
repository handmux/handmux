import { expect, it, vi } from 'vitest';
import { requestJson } from '../src/apiRequest.js';
import { scheduledRequest } from '../src/scheduledMessagesApi.js';
vi.mock('../src/apiRequest.js', () => ({ requestJson: vi.fn(async () => ({})) }));
it('lets an explicit trigger outlast the bounded server delivery without lengthening ordinary requests', async () => {
  const scope = { tmuxSession: 'work', paneId: '%1' };
  await scheduledRequest(scope, null, 'trigger', { id: 'task', revision: 2 });
  expect(vi.mocked(requestJson).mock.calls[0]).toMatchObject(['/api/agents/scheduled-messages', { timeoutMs: 35000 }]);
  expect(JSON.parse(vi.mocked(requestJson).mock.calls[0]![1]!.body as string)).toMatchObject({ ...scope, action: 'trigger', id: 'task', revision: 2 });
  await scheduledRequest(scope, null, 'snapshot');
  expect(vi.mocked(requestJson).mock.calls[1]![1]!.timeoutMs).toBe(12000);
});
