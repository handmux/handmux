import { describe, expect, it } from 'vitest';
import { createCodeBuddyTranscriptParser } from '../src/agents/codebuddyTranscriptParse.js';

// Fixtures are the shapes measured on CodeBuddy 2.155.0: a JSONL line per record, epoch-ms timestamps,
// `function_call.arguments` a JSON STRING, and no Claude-style content blocks on tool records.
const line = (record: Record<string, unknown>) => JSON.stringify(record);
const at = (ms: number) => new Date(ms).toISOString();

const userMessage = (id: string, ms: number, text: string, provider: Record<string, unknown> = {}) => line({
  id, timestamp: ms, type: 'message', role: 'user', sessionId: 's-1', cwd: '/x',
  content: [{ type: 'input_text', text }], providerData: provider,
});
const assistantMessage = (id: string, ms: number, text: string) => line({
  id, timestamp: ms, type: 'message', role: 'assistant', sessionId: 's-1', cwd: '/x',
  content: [{ type: 'output_text', text }], providerData: {},
});
const call = (id: string, ms: number, callId: string, name: string, args: unknown) => line({
  id, timestamp: ms, type: 'function_call', callId, name, sessionId: 's-1', cwd: '/x',
  arguments: typeof args === 'string' ? args : JSON.stringify(args), providerData: {},
});
const result = (
  id: string,
  ms: number,
  callId: string,
  name: string,
  output: unknown,
  { status = 'completed', toolResult }: { status?: string; toolResult?: unknown } = {},
) => line({
  id, timestamp: ms, type: 'function_call_result', callId, name, status, sessionId: 's-1', cwd: '/x',
  output: typeof output === 'string' ? { type: 'text', text: output } : output,
  ...(toolResult === undefined ? {} : { providerData: { toolResult } }),
});

describe('CodeBuddy transcript parse', () => {
  it('folds a call and its later result into one tool message, by callId', () => {
    const parser = createCodeBuddyTranscriptParser();
    // The call is emitted first (the phone must see 工具调用 immediately); the result then lands in a LATER
    // batch and must update that same message in place.
    parser.push([call('c1', 1_000, 'call_1', 'Read', { file_path: '/x/CLAUDE.md' })]);
    expect(parser.messages).toHaveLength(1);
    expect(parser.messages[0]).toMatchObject({
      type: 'tool', role: 'assistant', ts: at(1_000),
      tool: { name: 'Read', input: { file_path: '/x/CLAUDE.md' }, result: null, isError: false },
    });
    parser.push([result('r1', 1_100, 'call_1', 'Read', '   1→# handmux')]);
    expect(parser.messages).toHaveLength(1);
    expect(parser.messages[0]?.tool).toMatchObject({ result: '   1→# handmux', isError: false });
  });

  it('keeps an unmatched result out of the log entirely', () => {
    // A partial first read can start mid-file: its call is in an earlier, not-yet-loaded chunk.
    const parser = createCodeBuddyTranscriptParser();
    expect(parser.push([result('r1', 1_100, 'call_missing', 'Bash', 'output')])).toEqual([]);
  });

  it('marks a failed tool call and falls back to the provider tool result text', () => {
    const parser = createCodeBuddyTranscriptParser();
    parser.push([
      call('c1', 1_000, 'call_1', 'Bash', '{"command":"false"}'),
      result('r1', 1_100, 'call_1', 'Bash', '', { status: 'error', toolResult: { content: 'exit 1', error: 'x' } }),
    ]);
    expect(parser.messages[0]?.tool).toMatchObject({ result: 'exit 1', isError: true });
  });

  it('keeps the arguments when they are not parseable JSON', () => {
    const parser = createCodeBuddyTranscriptParser();
    parser.push([call('c1', 1_000, 'call_1', 'Bash', 'not json at all')]);
    expect(parser.messages[0]?.tool?.input).toBe('not json at all');
  });

  it('drops injected and synthetic turns but keeps the human ones', () => {
    const parser = createCodeBuddyTranscriptParser();
    parser.push([
      userMessage('m1', 1_000, '真实的用户消息'),
      userMessage('m2', 1_010, '<task-notification>…</task-notification>', { isMeta: true }),
      userMessage('m3', 1_020, '<system-reminder data-role="command-caveat">…', { skipRun: true }),
      userMessage('m4', 1_030, 'Please continue with the conversation based on the summarized context above.', {
        isCompactInternal: true,
      }),
      assistantMessage('m5', 1_040, '好的'),
      userMessage('m6', 1_050, '被中断的半截', { isPartialAborted: true }),
    ]);
    expect(parser.messages.map((message) => message.text)).toEqual(['真实的用户消息', '好的']);
    expect(parser.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('shows a compaction as one quiet marker, not as a wall of summary text', () => {
    const parser = createCodeBuddyTranscriptParser();
    parser.push([
      userMessage('m1', 1_000, '<cb_summary>\nSummary of the conversation so far:\nThe conversation is between…\n</cb_summary>', {
        isCompacted: true, compactType: 'pre-message-auto', isCompactInternal: true,
      }),
      userMessage('m2', 2_000, '<conversation_history_summary>\nSummary:\n1. **Primary Request**…', {
        isSummary: true, isCompacted: true, compactType: 'emergency-auto', isCompactInternal: true,
      }),
    ]);
    expect(parser.messages).toHaveLength(2);
    expect(parser.messages[0]).toMatchObject({ type: 'compact', ts: at(1_000) });
    // The wrapper and the "Summary of the conversation so far:" lead are scaffolding, not content.
    expect(parser.messages[0]?.summary).toBe('The conversation is between…');
    expect(parser.messages[1]?.summary).toBe('1. **Primary Request**…');
  });

  it('turns a slash command into a marker carrying its arguments', () => {
    const parser = createCodeBuddyTranscriptParser();
    parser.push([
      userMessage('m1', 1_000, '/compact'),
      userMessage('m2', 2_000, '/model deepseek-v4.1-flash'),
      // A path-like or capitalised message is not a command.
      userMessage('m3', 3_000, '/home/user/x/y.jsonl 看一下'),
      userMessage('m4', 4_000, '/usr/local/bin 里有什么'),
    ]);
    expect(parser.messages.map((message) => [message.type, message.name, message.args])).toEqual([
      ['slash', '/compact', undefined],
      ['slash', '/model', 'deepseek-v4.1-flash'],
      ['text', undefined, undefined],
      ['text', undefined, undefined],
    ]);
  });

  it('carries only the public reasoning projection, never the raw chain of thought', () => {
    const parser = createCodeBuddyTranscriptParser();
    parser.push([
      line({ id: 'r1', timestamp: 1_000, type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: 'RAW 私密推理' }] }),
      line({
        id: 'r2', timestamp: 1_100, type: 'reasoning',
        content: [{ type: 'input_text', text: '公开摘要' }],
        rawContent: [{ type: 'reasoning_text', text: 'RAW 私密推理' }],
      }),
    ]);
    expect(parser.messages).toHaveLength(1);
    expect(parser.messages[0]).toMatchObject({ type: 'thinking', text: '公开摘要' });
  });

  it('ignores the record types that are not conversation, and survives bad lines', () => {
    const parser = createCodeBuddyTranscriptParser();
    parser.push([
      line({ type: 'file-history-snapshot', timestamp: 1_000, snapshot: {} }),
      line({ type: 'turn-metrics', timestamp: 1_100, durationMs: 5 }),
      line({ type: 'ai-title', timestamp: 1_200, aiTitle: '标题' }),
      line({ type: 'summary', timestamp: 1_300, summary: 'a context rollup, not a turn' }),
      line({ type: 'brand-new-record-type', timestamp: 1_400 }),
      '{ not json',
      '',
      userMessage('m1', 2_000, '只有这条该出现'),
    ]);
    expect(parser.messages.map((message) => message.text)).toEqual(['只有这条该出现']);
  });
});
