import { describe, it, expect } from 'vitest';
import { createCodexTranscriptParser, parseCodexTranscript } from '../src/codexTranscriptParse.js';

const row = (payload) => JSON.stringify({ type: 'response_item', payload });

describe('Codex rollout transcript', () => {
  it('renders response_item once and ignores its duplicated event stream', () => {
    const parsed = parseCodexTranscript([
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '重复问题' } }),
      row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '问题' }] }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '重复回答' } }),
      row({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回答' }] }),
    ]);
    expect(parsed.map((message) => [message.role, message.text])).toEqual([
      ['user', '问题'], ['assistant', '回答'],
    ]);
  });

  it('keeps every tool in durable rollout order instead of the incomplete App Server snapshot', () => {
    const script = [
      'const first = await tools.exec_command({"cmd":"pwd"});',
      'const second = await tools.web__run({"search_query":[{"q":"Codex"}]});',
      'text(JSON.stringify({first,second}));',
    ].join('\n');
    const parsed = parseCodexTranscript([
      row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '检查' }] }),
      row({ type: 'custom_tool_call', name: 'exec', call_id: 'tools-1', input: script }),
      row({ type: 'custom_tool_call_output', call_id: 'tools-1', output: [
        { type: 'input_text', text: JSON.stringify({
          first: { exit_code: 0, output: '/work' },
          second: { content: [{ type: 'text', text: 'done' }] },
        }) },
      ] }),
      row({ type: 'function_call', name: 'wait', call_id: 'tools-2', arguments: '{"timeout_ms":1000}' }),
      row({ type: 'function_call_output', call_id: 'tools-2', output: 'done' }),
      row({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }),
    ]);

    expect(parsed.map((message) => message.type)).toEqual(['text', 'tool', 'tool', 'tool', 'text']);
    expect(parsed.filter((message) => message.type === 'tool').map((message) => message.tool.name))
      .toEqual(['exec_command', 'web__run', 'wait']);
    expect(parsed[1].tool).toMatchObject({ input: { cmd: 'pwd' }, result: '/work', isError: false });
    expect(parsed.at(-1)).toMatchObject({ role: 'assistant', text: '完成' });
  });

  it('reads command details from JavaScript object arguments emitted by orchestrated tool calls', () => {
    const script = [
      'const result = await tools.exec_command({',
      '  cmd: "npm test -- --run",',
      '  workdir: "/work",',
      '  yield_time_ms: 30000,',
      '  prefix_rule: ["npm", "test"],',
      '});',
      'text(result.output);',
    ].join('\n');
    const parsed = parseCodexTranscript([
      row({ type: 'custom_tool_call', name: 'exec', call_id: 'js-object', input: script }),
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].tool).toMatchObject({
      name: 'exec_command',
      input: {
        cmd: 'npm test -- --run',
        workdir: '/work',
        yield_time_ms: 30000,
        prefix_rule: ['npm', 'test'],
      },
    });
  });

  it('updates a pending tool when its result is appended in a later reader batch', () => {
    const parser = createCodexTranscriptParser();
    const messages = parser.push([
      row({ type: 'function_call', name: 'wait', call_id: 'later', arguments: '{"timeout_ms":1000}' }),
    ]);
    expect(messages[0].tool.result).toBeNull();
    expect(parser.push([
      row({ type: 'function_call_output', call_id: 'later', output: 'done' }),
    ])).toBe(messages);
    expect(messages[0].tool.result).toBe('done');
  });

  it('keeps edited filenames and diff stats from apply_patch scripts', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: web/src/App.jsx',
      '@@',
      '-old',
      '+new',
      ' keep',
      '*** End Patch',
    ].join('\n');
    const script = `const patch = ${JSON.stringify(patch)};\ntext(await tools.apply_patch(patch));`;
    const parsed = parseCodexTranscript([
      row({ type: 'custom_tool_call', name: 'exec', call_id: 'patch-1', input: script }),
      row({ type: 'custom_tool_call_output', call_id: 'patch-1', output: [] }),
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tool).toMatchObject({
      name: 'apply_patch',
      input: { file_path: 'web/src/App.jsx', patch },
      diff: { added: 1, removed: 1 },
    });
  });
});
