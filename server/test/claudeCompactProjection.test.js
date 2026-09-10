import { describe, expect, it } from 'vitest';
import { parseTranscript } from '../src/transcriptParse.js';
import { createClaudeConversationAdapter } from '../src/agents/claudeConversation.js';
import { projectConversationSubmissions } from '../../web/src/conversationSubmissionProjection.js';

describe('Claude compact canonical bubble handoff', () => {
  it.each(['', 'focus on the API'])('replaces the local bubble after delayed native history arrives (%s)', async (args) => {
    const session = { agentId: 'claude', sessionId: '4442e3d0-8d46-4cce-9822-b86558f69922' };
    const text = `/compact${args ? ` ${args}` : ''}`;
    const messages = parseTranscript([JSON.stringify({
      type: 'assistant', message: { role: 'assistant', content: 'ready' },
    })]);
    const adapter = createClaudeConversationAdapter({
      projectsRoot: '/tmp', findSessionFile: async () => '/tmp/native-fixture.jsonl',
      reader: { read: async () => messages, clear() {}, size: () => 1 },
    });
    const baseline = await adapter.readNativePage(session, { limit: 20 });
    const entries = (page) => page.items.map((item) => ({ key: `durable:${item.id}`, provisional: false, item }));
    const local = [{
      clientRequestId: 'compact-request', text, owner: 'timeline', status: 'accepted',
      createdAt: Date.parse('2026-09-10T12:59:40Z'),
      anchor: { viewId: baseline.sourceViewId }, baselineKeys: entries(baseline).map((entry) => entry.key),
    }];
    expect(projectConversationSubmissions(entries(baseline), local, []).timeline).toHaveLength(1);
    const appended = parseTranscript([
      JSON.stringify({ type: 'user', message: { role: 'user', content: text } }),
      JSON.stringify({ type: 'user', isCompactSummary: true, timestamp: '2026-09-10T12:59:48Z', message: { role: 'user', content: 'retained summary' } }),
      JSON.stringify({ type: 'user', timestamp: '2026-09-10T12:59:40Z', message: { role: 'user', content: `<command-name>/compact</command-name><command-args>${args}</command-args>` } }),
    ]);
    messages.push(...appended.map((message) => ({ ...message, i: message.i + 1 })));
    const page = await adapter.readNativePage(session, { limit: 20 });
    expect(page.sourceViewId).not.toBe(baseline.sourceViewId);
    expect(page.items.map((item) => item.kind)).toEqual(['message', 'message', 'compaction']);
    const canonical = entries(page);
    expect(canonical.filter((entry) => entry.item.kind === 'message' && entry.item.role === 'user')).toHaveLength(1);
    expect(page.items[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text }] });
    expect(projectConversationSubmissions(canonical, local, []).timeline).toEqual([]);
    expect(projectConversationSubmissions(canonical, local, []).queue).toEqual([]);
  });
});
