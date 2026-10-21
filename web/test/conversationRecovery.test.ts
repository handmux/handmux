import { afterEach, expect, it, vi } from 'vitest';
import { parseConversationDraft, readAgentConversationPage } from '../src/agentConversationApi.js';
import { requestJson } from '../src/apiRequest.js';
vi.mock('../src/apiRequest.js', () => ({ requestJson: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const notice = { kind: 'notice', level: 'warning', message: 'usage limit', recovery: { kind: 'usage_limit', retryAt: 1792543980000 } };
it('preserves the same recovery through draft and history API boundaries', async () => {
  expect(parseConversationDraft(notice)).toEqual(notice);
  vi.mocked(requestJson).mockResolvedValue({ status: 'ok', page: { sessionId: 'session', viewId: 'view', historyVersion: 'history', hasMore: false, items: [{ ...notice, id: 'limit', sessionId: 'session', status: 'complete' }] } });
  const result = await readAgentConversationPage({ agentId: 'new-agent', sessionId: 'session', runId: 'run', paneId: '%1' }, { limit: 20 });
  expect(result).toMatchObject({ page: { items: [expect.objectContaining({ recovery: notice.recovery })] } });
});
it('keeps warning text even when optional recovery data is unknown or invalid', () => {
  for (const retryAt of [NaN, Infinity, -1, 1.5, 'tomorrow', 8_640_000_000_000_001]) {
    expect(parseConversationDraft({ ...notice, recovery: { kind: 'usage_limit', retryAt } })).toEqual({ ...notice, recovery: { kind: 'usage_limit' } });
  }
  expect(parseConversationDraft({ ...notice, recovery: { kind: 'unknown' } })).toEqual({ kind: 'notice', level: 'warning', message: 'usage limit' });
});
