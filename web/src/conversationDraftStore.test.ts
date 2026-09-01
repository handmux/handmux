import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('Conversation draft persistence', () => {
  it('restores a failed message without dropping a concurrently produced draft', async () => {
    const store = await import('./conversationDraftStore.js');
    expect(store.mergeConversationDraftAfterFailure('original message', 'new draft'))
      .toBe('original message\nnew draft');
    expect(store.mergeConversationDraftAfterFailure('original message', 'original message\nnew draft'))
      .toBe('original message\nnew draft');
    expect(store.appendConversationDraft('new draft', '/work/file.ts'))
      .toBe('new draft\n/work/file.ts');
  });

  it('survives a module reload while unsent and disappears permanently after send clear', async () => {
    const first = await import('./conversationDraftStore.js');
    first.saveConversationDraft('future-agent', 'session-1', 'unsent text');
    expect(first.getConversationDraft('future-agent', 'session-1')).toBe('unsent text');

    vi.resetModules();
    const reloaded = await import('./conversationDraftStore.js');
    expect(reloaded.getConversationDraft('future-agent', 'session-1')).toBe('unsent text');
    reloaded.saveConversationDraft('future-agent', 'session-1', '');
    expect(JSON.parse(localStorage.getItem('tw_agent_conversation_drafts_v1') || '[]')).toEqual([]);

    vi.resetModules();
    const afterSendReload = await import('./conversationDraftStore.js');
    expect(afterSendReload.getConversationDraft('future-agent', 'session-1')).toBe('');
  });
});
