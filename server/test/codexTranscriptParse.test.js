import { describe, it, expect } from 'vitest';
import { createCodexTranscriptParser, parseCodexTranscript } from '../src/codexTranscriptParse.js';

const row = (payload) => JSON.stringify({ type: 'response_item', payload });

describe('Codex rollout transcript', () => {
  it('renders response_item once and ignores its duplicated event stream', () => {
    const parsed = parseCodexTranscript([
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '重复问题' } }),
      row({
        type: 'message', role: 'user', content: [{ type: 'input_text', text: '问题' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '重复回答' } }),
      row({
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回答' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
      }),
    ]);
    expect(parsed.map((message) => [message.role, message.text])).toEqual([
      ['user', '问题'], ['assistant', '回答'],
    ]);
    expect(parsed.map((message) => message.turnId)).toEqual(['turn-1', 'turn-1']);
  });

  it('omits Codex-injected AGENTS instructions without hiding normal user text', () => {
    const parsed = parseCodexTranscript([
      row({
        type: 'message', role: 'user', content: [
          { type: 'input_text', text: '# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>\ninternal rules\n</INSTRUCTIONS>' },
          { type: 'input_text', text: '<environment_context><cwd>/work</cwd></environment_context>' },
        ],
      }),
      row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '用户问：instructions 是什么？' }] }),
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ role: 'user', text: '用户问：instructions 是什么？' });
  });

  it('keeps ordinary user-authored HTML and XML messages', () => {
    const parsed = parseCodexTranscript([
      row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<div>修复这个布局</div>' }] }),
      row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<request>保留这个 XML</request>' }] }),
    ]);

    expect(parsed.map((message) => message.text)).toEqual([
      '<div>修复这个布局</div>',
      '<request>保留这个 XML</request>',
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
    expect(parsed[1].tool).toMatchObject({ input: { cmd: 'pwd' }, result: '/work', isError: false, outcome: 'success' });
    expect(parsed.at(-1)).toMatchObject({ role: 'assistant', text: '完成' });
  });

  it('renders persisted tool discovery calls and their results', () => {
    const parsed = parseCodexTranscript([
      row({
        type: 'tool_search_call', call_id: 'search-1', execution: 'client', status: 'completed',
        arguments: { query: 'calendar tools' },
      }),
      row({
        type: 'tool_search_output', call_id: 'search-1', execution: 'client', status: 'completed',
        tools: [{ type: 'tool', name: 'calendar.search', description: 'Search events' }],
      }),
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].tool).toMatchObject({
      name: 'tool_search', input: { query: 'calendar tools' }, isError: false, outcome: 'success',
    });
    expect(parsed[0].tool.result).toContain('calendar.search');
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
    expect(messages[0].tool.outcome).toBe('success');
  });

  it('restores a single persisted user-aborted tool as declined', () => {
    const parsed = parseCodexTranscript([
      row({ type: 'custom_tool_call', name: 'exec', call_id: 'aborted', input: 'await tools.exec_command({"cmd":"whoami"})' }),
      row({ type: 'custom_tool_call_output', call_id: 'aborted', output: 'aborted by user after 3.6s' }),
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tool).toMatchObject({
      name: 'exec_command', result: 'aborted by user after 3.6s', isError: false, outcome: 'declined',
    });
  });

  it('keeps an unstructured multi-tool abort neutral when the rejected call is not identified', () => {
    const parsed = parseCodexTranscript([
      row({
        type: 'custom_tool_call', name: 'exec', call_id: 'multi-abort',
        input: 'await tools.exec_command({"cmd":"first"}); await tools.exec_command({"cmd":"second"});',
      }),
      row({ type: 'custom_tool_call_output', call_id: 'multi-abort', output: 'aborted by user after 3.6s' }),
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((message) => message.tool.outcome)).toEqual(['completed', 'completed']);
  });

  it('keeps edited filenames, stats, and unnumbered hunks from apply_patch scripts', () => {
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
      diff: {
        added: 1,
        removed: 1,
        hunks: [{ oldStart: null, newStart: null, lines: ['-old', '+new', ' keep'] }],
      },
    });
  });

  it('splits bare apply_patch markers into separate unnumbered hunks', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/app.js',
      '@@ first',
      '-old one',
      '+new one',
      '@@ second',
      ' context',
      '+new two',
      '*** End Patch',
    ].join('\n');
    const parsed = parseCodexTranscript([
      row({
        type: 'custom_tool_call', name: 'exec', call_id: 'patch-hunks',
        input: `text(await tools.apply_patch(${JSON.stringify(patch)}));`,
      }),
    ]);
    expect(parsed[0].tool.diff).toEqual({
      added: 2,
      removed: 1,
      hunks: [
        { oldStart: null, newStart: null, lines: ['-old one', '+new one'] },
        { oldStart: null, newStart: null, lines: [' context', '+new two'] },
      ],
    });
  });

  it('projects Code Mode update_plan calls as plan state instead of tool cards', () => {
    const script = [
      'const result = await tools.update_plan({',
      '  explanation: "开始实现",',
      '  plan: [',
      '    { step: "确认协议", status: "completed" },',
      '    { step: "实现任务条", status: "in_progress" },',
      '    { step: "跑测试", status: "pending" },',
      '  ],',
      '});',
      'text(result);',
    ].join('\n');
    const parsed = parseCodexTranscript([
      row({
        type: 'custom_tool_call', name: 'exec', call_id: 'plan-1', input: script,
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-plan' },
      }),
      row({ type: 'custom_tool_call_output', call_id: 'plan-1', output: '{}' }),
    ]);
    expect(parsed).toEqual([expect.objectContaining({
      type: 'plan', turnId: 'turn-plan', explanation: '开始实现',
      plan: [
        { step: '确认协议', status: 'completed' },
        { step: '实现任务条', status: 'inProgress' },
        { step: '跑测试', status: 'pending' },
      ],
    })]);
    expect(parsed[0].tool).toBeUndefined();
  });
});
