import { describe, it, expect } from 'vitest';
import { createCodexTranscriptParser, parseCodexTranscript } from '../src/codexTranscriptParse.js';

const line = (value) => JSON.stringify(value);
const response = (payload, timestamp) => line({ type: 'response_item', payload, ...(timestamp ? { timestamp } : {}) });
const message = (role, text) => response({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
const call = (payload) => response(payload);

describe('parseCodexTranscript', () => {
  it('keeps real user/assistant messages and drops synthetic duplicate streams', () => {
    expect(parseCodexTranscript([
      line({ type: 'session_meta', payload: { cwd: '/x' } }),
      message('developer', '<permissions instructions>secret'),
      message('user', '<environment_context><cwd>/x</cwd></environment_context>'),
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'duplicate' } }),
      message('user', '问题'),
      message('assistant', '回答'),
    ])).toEqual([
      { i: 4, role: 'user', type: 'text', text: '问题', ts: undefined },
      { i: 5, role: 'assistant', type: 'text', text: '回答', ts: undefined },
    ]);
  });

  it('projects slash, compact, interrupt, reasoning and timestamps', () => {
    const ts = '2026-08-04T01:02:03.000Z';
    expect(parseCodexTranscript([
      message('user', '/model gpt-5.6'),
      line({ type: 'compacted', timestamp: ts, payload: { replacement_history: ['never render'] } }),
      message('user', '<turn_aborted>interrupted'),
      response({ type: 'reasoning', summary: [{ type: 'summary_text', text: '思考' }] }),
    ])).toEqual([
      { i: 0, type: 'slash', name: '/model', args: 'gpt-5.6', ts: undefined },
      { i: 1, type: 'compact', ts },
      { i: 2, type: 'interrupt', ts: undefined },
      { i: 3, role: 'assistant', type: 'thinking', text: '思考', ts: undefined },
    ]);
  });

  it('folds classic function calls and detects non-zero command exits', () => {
    const messages = parseCodexTranscript([
      call({ type: 'function_call', name: 'exec_command', call_id: 'a', arguments: '{"cmd":"exit 3"}' }),
      call({ type: 'function_call_output', call_id: 'a', output: 'Chunk ID: x\nWall time: 0.1 seconds\nProcess exited with code 3\nOutput:\nboom' }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].tool).toEqual({ name: 'exec_command', input: { cmd: 'exit 3' }, result: 'boom', isError: true });
  });

  it('splits current custom exec orchestration and zips array text-block results in declaration order', () => {
    const script = [
      'const a = await tools.exec_command({"cmd":"pwd"});',
      'const b = await tools.apply_patch("*** Begin Patch\\n*** End Patch");',
      'text(JSON.stringify({a,b}));',
    ].join('\n');
    const output = [
      { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'input_text', text: JSON.stringify({ a: { exit_code: 0, output: '/x' }, b: {} }) },
    ];
    const messages = parseCodexTranscript([
      call({ type: 'custom_tool_call', name: 'exec', call_id: 'b', input: script }),
      call({ type: 'custom_tool_call_output', call_id: 'b', output }),
    ]);
    expect(messages.map((item) => item.tool.name)).toEqual(['exec_command', 'apply_patch']);
    expect(messages[0].tool).toMatchObject({ input: { cmd: 'pwd' }, result: '/x', isError: false });
    expect(messages[1].tool.input.patch).toContain('Begin Patch');
    expect(messages[1].tool.result).toBe('');
  });

  it('keeps newly seen custom tools as an honest named card', () => {
    const messages = parseCodexTranscript([
      call({ type: 'custom_tool_call', name: 'exec', call_id: 'c', input: 'await tools.unknown(1)' }),
      call({ type: 'custom_tool_call_output', call_id: 'c', output: 'aborted by user' }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].tool).toMatchObject({ name: 'unknown', input: { value: 1 }, result: 'aborted by user' });
  });

  it('pairs a tool result appended in a later reader batch', () => {
    const parser = createCodexTranscriptParser();
    const first = parser.push([call({ type: 'function_call', name: 'wait', call_id: 'later', arguments: '{"timeout_ms":1000}' })]);
    expect(first[0].tool.result).toBeNull();
    const second = parser.push([call({ type: 'function_call_output', call_id: 'later', output: [{ type: 'input_text', text: 'done' }] })]);
    expect(second).toBe(first);
    expect(second[0].tool.result).toBe('done');
  });

  it('skips malformed and orphan rows without throwing', () => {
    expect(parseCodexTranscript(['', 'bad json', call({ type: 'function_call_output', call_id: 'missing', output: 'late' })])).toEqual([]);
  });
});
