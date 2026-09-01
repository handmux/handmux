import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../src/transcriptParse.js';

const line = (o) => JSON.stringify(o);

describe('parseTranscript', () => {
  it('user string content → one text bubble', () => {
    const msgs = parseTranscript([line({ type: 'user', message: { role: 'user', content: '你好' } })]);
    expect(msgs).toEqual([{ i: 0, role: 'user', type: 'text', text: '你好' }]);
  });

  it('carries the line timestamp onto each message (ts), undefined when absent', () => {
    const withTs = parseTranscript([line({ type: 'user', message: { role: 'user', content: '嗨' }, timestamp: '2026-07-17T06:00:00.000Z' })]);
    expect(withTs[0].ts).toBe('2026-07-17T06:00:00.000Z');
    const noTs = parseTranscript([line({ type: 'user', message: { role: 'user', content: '嗨' } })]);
    expect(noTs[0].ts).toBeUndefined();
  });

  it('an ESC-interrupt line becomes a quiet interrupt marker, never a user text bubble', () => {
    const byField = parseTranscript([line({
      type: 'user', interruptedMessageId: 'msg_1', timestamp: '2026-07-17T06:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
    })]);
    expect(byField).toEqual([{ i: 0, type: 'interrupt', ts: '2026-07-17T06:00:00.000Z' }]);
    // fallback: older logs without the field, matched by the marker text
    const byText = parseTranscript([line({ type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } })]);
    expect(byText).toEqual([{ i: 0, type: 'interrupt', ts: undefined }]);
  });

  it('assistant text + thinking split into two messages', () => {
    const msgs = parseTranscript([line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '想…' }, { type: 'text', text: '答' }] },
    })]);
    expect(msgs.length).toBe(2);
    expect(msgs[0].type).toBe('thinking');
    expect(msgs[1].type).toBe('text');
    expect(msgs[1].text).toBe('答');
  });

  it('tool_use pairs with its later tool_result by id', () => {
    const msgs = parseTranscript([
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb', is_error: false }] } }),
    ]);
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe('tool');
    expect(msgs[0].tool.name).toBe('Bash');
    expect(msgs[0].tool.result).toBe('a\nb');
    expect(msgs[0].tool.isError).toBe(false);
  });

  it('folds structuredPatch into tool.diff (added/removed counts + hunks)', () => {
    const msgs = parseTranscript([
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/a.js' } }] } }),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok', is_error: false }] },
        toolUseResult: { structuredPatch: [{ oldStart: 1, newStart: 1, lines: [' ctx', '-gone', '+new', '+more'] }] },
      }),
    ]);
    expect(msgs[0].tool.diff).toEqual({
      added: 2, removed: 1,
      hunks: [{ oldStart: 1, newStart: 1, lines: [' ctx', '-gone', '+new', '+more'] }],
    });
  });

  it('a create (empty patch) counts every content line as added', () => {
    const msgs = parseTranscript([
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/n.js' } }] } }),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'created', is_error: false }] },
        toolUseResult: { type: 'create', content: 'a\nb\nc', structuredPatch: [] },
      }),
    ]);
    expect(msgs[0].tool.diff).toEqual({ added: 3, removed: 0, hunks: null, created: true });
  });

  it('a non-edit tool (Bash) has no diff', () => {
    const msgs = parseTranscript([
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }] } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'out' }] }, toolUseResult: { stdout: 'out' } }),
    ]);
    expect(msgs[0].tool.diff).toBe(null);
  });

  it('internal types and blank/bad lines are skipped', () => {
    const msgs = parseTranscript([
      '', '  ', 'not json',
      line({ type: 'system', foo: 1 }),
      line({ type: 'ai-title', title: 'x' }),
      line({ type: 'user', message: { role: 'user', content: '留' } }),
    ]);
    expect(msgs.map((m) => m.text)).toEqual(['留']);
  });

  it('drops isMeta scaffolding and keeps a compact summary only as marker detail data', () => {
    const msgs = parseTranscript([
      line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: /x' } }),
      line({ type: 'user', isCompactSummary: true, timestamp: '2026-07-17T01:11:58.618Z', message: { role: 'user', content: 'This session is being continued…' } }),
      line({ type: 'user', message: { role: 'user', content: '真的问题' } }),
    ]);
    // isMeta is dropped; the compaction wall retains its exact summary for the on-demand detail sheet.
    expect(msgs.map((m) => m.type)).toEqual(['compact', 'text']);
    expect(msgs[0]).toMatchObject({
      type: 'compact', ts: '2026-07-17T01:11:58.618Z',
      summary: 'This session is being continued…',
    });
    expect(msgs[0].text).toBeUndefined(); // it is never projected as a normal chat bubble
    expect(msgs[1].text).toBe('真的问题');
  });

  it('turns a <command-name> scaffold into a slash marker and folds its stdout echo onto it as .result', () => {
    const msgs = parseTranscript([
      line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' } }),
      line({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Cleared conversation</local-command-stdout>' } }),
      line({ type: 'user', message: { role: 'user', content: '真的问题' } }),
    ]);
    expect(msgs.map((m) => m.type)).toEqual(['slash', 'text']);
    expect(msgs[0]).toMatchObject({ type: 'slash', name: '/clear', result: 'Cleared conversation' });
    expect(msgs[0].args).toBeUndefined();
    expect(msgs[1].text).toBe('真的问题');
  });

  it('captures slash-command args (so /model sonnet is distinguishable from a bare /model picker)', () => {
    const msgs = parseTranscript([
      line({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-args>sonnet</command-args>' } }),
    ]);
    expect(msgs[0]).toMatchObject({ type: 'slash', name: '/model', args: 'sonnet' });
  });

  it('strips ANSI from the stdout echo and caps a long result', () => {
    const long = 'x'.repeat(300);
    const msgs = parseTranscript([
      line({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
      line({ type: 'user', message: { role: 'user', content: `<local-command-stdout>Set model to \x1b[1mOpus 4.8\x1b[22m ${long}</local-command-stdout>` } }),
    ]);
    expect(msgs[0].result).not.toContain('\x1b');
    expect(msgs[0].result.startsWith('Set model to Opus 4.8')).toBe(true);
    expect(msgs[0].result.endsWith('…')).toBe(true);
    expect(msgs[0].result.length).toBeLessThan(160);
  });

  it('a bare interactive command with no stdout yet yields a marker with no .result (UI hand-off cue)', () => {
    const msgs = parseTranscript([
      line({ type: 'user', message: { role: 'user', content: '<command-name>/plugin</command-name>' } }),
    ]);
    expect(msgs[0]).toMatchObject({ type: 'slash', name: '/plugin' });
    expect(msgs[0].result).toBeUndefined();
    expect(msgs[0].args).toBeUndefined();
  });

  it('/compact is NOT special-cased: its scaffold is a slash marker AND the isCompactSummary wall is its own divider', () => {
    const msgs = parseTranscript([
      line({ type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>' } }),
      line({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' } }),
      line({ type: 'user', isCompactSummary: true, timestamp: '2026-07-18T01:00:00.000Z', message: { role: 'user', content: 'This session is being continued…' } }),
      line({ type: 'user', message: { role: 'user', content: '继续' } }),
    ]);
    expect(msgs.map((m) => m.type)).toEqual(['slash', 'compact', 'text']);
    expect(msgs[0]).toMatchObject({ type: 'slash', name: '/compact', result: 'Compacted (ctrl+o to see full summary)' });
    expect(msgs[2].text).toBe('继续');
  });

  it('drops a BARE slash-command user turn (Claude Code stores the raw "/compact" input, tag-less)', () => {
    // The literal the user typed is logged as a plain user turn with content "/compact" (no <command-name>
    // wrapper, no isMeta flag). After a /compact this is the LAST turn → it must not become a trailing user
    // bubble (which would light the "reply coming" typing wave forever). See the compact-lands regression.
    const msgs = parseTranscript([
      line({ type: 'user', message: { role: 'user', content: '上一条真的回复' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } }),
      line({ type: 'user', message: { role: 'user', content: '/compact' } }),
      line({ type: 'user', message: { role: 'user', content: '/model sonnet' } }),
    ]);
    expect(msgs.map((m) => m.text)).toEqual(['上一条真的回复', '好的']);
    expect(msgs[msgs.length - 1].role).toBe('assistant'); // trailing bubble is the real reply, not a command
  });

  it('does NOT mistake a path-like user message for a slash command (no space after the first segment)', () => {
    const msgs = parseTranscript([
      line({ type: 'user', message: { role: 'user', content: '/Users/demo/foo.js 看下这个文件' } }),
    ]);
    expect(msgs.map((m) => m.text)).toEqual(['/Users/demo/foo.js 看下这个文件']);
  });

  it('keeps an assistant reply that merely MENTIONS a command tag in prose (no false-positive)', () => {
    const msgs = parseTranscript([line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '脚手架消息(`<command-name>`/`<local-command-stdout>`)本该被隐藏' }] },
    })]);
    expect(msgs.length).toBe(1);
    expect(msgs[0].text).toContain('<command-name>');
  });

  it('tool_result with array content concatenates text parts', () => {
    const msgs = parseTranscript([
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'X' }, { type: 'text', text: 'Y' }] }] } }),
    ]);
    expect(msgs[0].tool.result).toBe('XY');
  });
});
