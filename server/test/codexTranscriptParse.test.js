import { describe, it, expect } from 'vitest';
import { createCodexTranscriptParser, parseCodexTranscript } from '../src/codexTranscriptParse.js';

const row = (payload) => JSON.stringify({ type: 'response_item', payload });

describe('Codex rollout transcript', () => {
  it('keeps only the public compacted message as detail data', () => {
    const parsed = parseCodexTranscript([JSON.stringify({
      type: 'compacted', timestamp: '2026-08-22T05:04:24.151Z',
      payload: {
        message: '## 保留摘要\n\n继续完成当前任务。',
        replacement_history: [{ role: 'developer', content: 'hidden control data' }],
      },
    })]);

    expect(parsed).toEqual([{
      i: 0, type: 'compact', ts: '2026-08-22T05:04:24.151Z',
      summary: '## 保留摘要\n\n继续完成当前任务。',
    }]);
    expect(JSON.stringify(parsed)).not.toContain('hidden control data');
  });

  it('replaces Codex compactor output with the compact marker across incremental reads', () => {
    const parser = createCodexTranscriptParser();
    const summary = '## 当前任务\n\n继续修复压缩展示。';
    const handoff = [
      'Another language model started to solve this problem and produced a summary of its thinking process.',
      'You also have access to the state of the tools that were used by that language model.',
      'Use this to build on the work that has already been done and avoid duplicating work.',
      'Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:',
    ].join(' ') + `\n${summary}`;

    parser.push([row({
      id: 'compactor-answer', type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: summary }],
      internal_chat_message_metadata_passthrough: { turn_id: 'compact-turn' },
    })]);
    expect(parser.messages).toEqual([expect.objectContaining({ type: 'text', text: summary })]);
    expect(parser.takeChangedFrom()).toBe(0);

    parser.push([
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
      JSON.stringify({
        type: 'compacted', timestamp: '2026-08-23T05:45:28.826Z',
        payload: { message: handoff, replacement_history: [{ role: 'developer', content: 'hidden' }] },
      }),
    ]);

    expect(parser.messages).toEqual([{
      i: 2, type: 'compact', ts: '2026-08-23T05:45:28.826Z', summary: handoff,
    }]);
    expect(parser.takeChangedFrom()).toBe(0);
    expect(JSON.stringify(parser.messages)).not.toContain('hidden');
  });

  it('renders response_item once and ignores its duplicated event stream', () => {
    const parsed = parseCodexTranscript([
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '重复问题' } }),
      row({
        id: 'user-1', type: 'message', role: 'user', content: [{ type: 'input_text', text: '问题' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '重复回答' } }),
      row({
        id: 'agent-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回答' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
      }),
    ]);
    expect(parsed.map((message) => [message.role, message.text])).toEqual([
      ['user', '问题'], ['assistant', '回答'],
    ]);
    expect(parsed.map((message) => message.turnId)).toEqual(['turn-1', 'turn-1']);
    expect(parsed.map((message) => message.itemId)).toEqual(['user-1', 'agent-1']);
    expect(parsed.map((message) => message.id)).toEqual([
      'codex:turn-1:user-1', 'codex:turn-1:agent-1',
    ]);
  });

  it('carries an adjacent native user_message client id onto only its durable user item', () => {
    const parsed = parseCodexTranscript([
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: '问题', client_id: 'request-1' },
      }),
      row({
        id: 'user-1', type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '问题' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
      }),
      row({
        id: 'agent-1', type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: '回答' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
      }),
    ]);

    expect(parsed[0]).toMatchObject({
      role: 'user', turnId: 'turn-1', itemId: 'user-1', correlationId: 'request-1',
    });
    expect(parsed[1]).toMatchObject({ role: 'assistant', turnId: 'turn-1', itemId: 'agent-1' });
    expect(parsed[1]).not.toHaveProperty('correlationId');
  });

  it('does not carry a client id across a non-adjacent rollout record', () => {
    const parsed = parseCodexTranscript([
      JSON.stringify({
        type: 'event_msg', payload: { type: 'user_message', client_id: 'request-stale' },
      }),
      JSON.stringify({ type: 'turn_context', payload: {} }),
      row({
        id: 'user-1', type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '问题' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
      }),
    ]);

    expect(parsed[0]).not.toHaveProperty('correlationId');
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

  it('projects Codex Goal context as one compact set event instead of exposing internal instructions', () => {
    const context = [
      '<codex_internal_context source="goal">',
      'Continue working toward the active thread goal.',
      '<objective>',
      'Finish the release',
      '</objective>',
      'Budget:',
      '- Tokens used: 1,234',
      '- Token budget: 40,000',
      '</codex_internal_context>',
    ].join('\n');
    const parsed = parseCodexTranscript([
      row({
        id: 'goal-context-1', type: 'message', role: 'user', content: [{ type: 'input_text', text: context }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-goal-1' },
      }),
      row({
        id: 'goal-context-duplicate', type: 'message', role: 'user', content: [{ type: 'input_text', text: context }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-goal-1' },
      }),
    ]);

    expect(parsed).toEqual([expect.objectContaining({
      id: 'codex:turn-goal-1:goal-context-1',
      type: 'goal', event: 'set', role: 'assistant',
      goal: { objective: 'Finish the release', status: 'active', tokensUsed: 1234, tokenBudget: 40000 },
    })]);
  });

  it('keeps a same-objective Goal when its durable usage resets for a new lifecycle', () => {
    const context = (tokens) => [
      '<codex_internal_context source="goal">',
      'Continue working toward the active thread goal.',
      '<objective>',
      'Finish the release',
      '</objective>',
      'Budget:',
      `- Tokens used: ${tokens}`,
      '- Token budget: 40,000',
      '</codex_internal_context>',
    ].join('\n');
    const parsed = parseCodexTranscript([
      row({
        id: 'goal-context-1', type: 'message', role: 'user',
        content: [{ type: 'input_text', text: context('1,234') }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-goal-1' },
      }),
      row({
        id: 'goal-context-2', type: 'message', role: 'user',
        content: [{ type: 'input_text', text: context('1,500') }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-goal-2' },
      }),
      row({
        id: 'goal-context-3', type: 'message', role: 'user',
        content: [{ type: 'input_text', text: context('0') }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-goal-3' },
      }),
    ]);

    expect(parsed.map((message) => message.id)).toEqual([
      'codex:turn-goal-1:goal-context-1',
      'codex:turn-goal-3:goal-context-3',
    ]);
    expect(parsed.map((message) => message.goal.tokensUsed)).toEqual([1234, 0]);
  });

  it('projects the native update_goal result as a terminal Goal event', () => {
    const goal = {
      threadId: 'thread-1', objective: 'Finish the release', status: 'complete',
      tokensUsed: 69602, timeUsedSeconds: 277, createdAt: 10, updatedAt: 20,
    };
    const parsed = parseCodexTranscript([
      row({
        type: 'custom_tool_call', name: 'exec', call_id: 'goal-complete',
        input: 'const result = await tools.update_goal({status:"complete"});\ntext(result);',
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-goal' },
      }),
      row({
        type: 'custom_tool_call_output', call_id: 'goal-complete',
        output: [{ type: 'input_text', text: JSON.stringify({ goal, completionBudgetReport: 'done' }) }],
      }),
    ]);

    expect(parsed).toEqual([expect.objectContaining({
      id: 'codex-goal:10:complete', type: 'goal', event: 'complete', turnId: 'turn-goal', goal,
    })]);
    expect(parsed[0].tool).toBeUndefined();
  });

  it('restores a terminal Goal when exec persists several results as separate blocks', () => {
    const goal = {
      threadId: 'thread-1',
      objective: 'Review every change since the previous public release and prepare an interim release',
      status: 'blocked', tokensUsed: 1007347, timeUsedSeconds: 8753,
      createdAt: 10, updatedAt: 20,
    };
    const parsed = parseCodexTranscript([
      row({
        type: 'custom_tool_call', name: 'exec', call_id: 'goal-blocked',
        input: [
          'const status = await tools.exec_command({cmd:"git status --short"});',
          'text(status);',
          'const result = await tools.update_goal({status:"blocked"});',
          'text(result);',
        ].join('\n'),
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-goal' },
      }),
      row({
        type: 'custom_tool_call_output', call_id: 'goal-blocked',
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
          { type: 'input_text', text: JSON.stringify({ exit_code: 0, output: '' }) },
          { type: 'input_text', text: JSON.stringify({ goal, remainingTokens: null }) },
        ],
      }),
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].tool).toMatchObject({ name: 'exec_command', outcome: 'success' });
    expect(parsed[1]).toMatchObject({
      id: 'codex-goal:10:blocked', type: 'goal', event: 'blocked', turnId: 'turn-goal', goal,
    });
    expect(parsed[1].tool).toBeUndefined();
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
