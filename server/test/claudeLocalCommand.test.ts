import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeEvents } from '../src/claudeEvents.js';
import { createClaudeConversationActivityReader } from '../src/agent-runtime/builtinRuntime.js';
import { ConversationService } from '../src/agent-runtime/conversation.js';
import { createClaudeConversationAdapter } from '../src/agents/claudeConversation.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const SESSION = '4442e3d0-8d46-4cce-9822-b86558f69922';
const COMMAND = '4442e3d0-8d46-4cce-9822-b86558f69923';
const OUTPUT = '4442e3d0-8d46-4cce-9822-b86558f69924';
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-local-command-'));
  directories.push(dir);
  const transcript = path.join(dir, `${SESSION}.jsonl`);
  const state = path.join(dir, 'state.json');
  const payload = { session_id: SESSION, transcript_path: transcript, trigger: 'manual' };
  const writeHook = (src = 'compact', ts = 1000) => fs.writeFileSync(state, JSON.stringify({ '%1': { src, ts, payload } }));
  const command = { type: 'user', sessionId: SESSION, uuid: COMMAND, timestamp: new Date(2000).toISOString(),
    message: { role: 'user', content: '<command-name>/model</command-name><command-message>model</command-message><command-args></command-args>' } };
  const output = { type: 'user', sessionId: SESSION, uuid: OUTPUT, parentUuid: COMMAND, timestamp: new Date(2000).toISOString(),
    message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' } };
  const write = (rows: unknown[], suffix = '\n') => fs.writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join('\n') + suffix);
  writeHook(); write([]);
  const events = createClaudeEvents({ commands: {}, push: null, file: state, now: () => 10000 });
  return { dir, transcript, state, command, output, write, writeHook, events };
}

describe('Claude native local-command completion', () => {
  it('updates an idle activity completion token only after a complete native picker result', async () => {
    const h = fixture();
    const runs = new AgentRunRuntime();
    const lease = await runs.controller('claude', async () => true).attach({
      paneId: '%1', attachmentId: 'claude-hooks', sessionId: SESSION, process: { pid: 101 },
    });
    const activity = createClaudeConversationActivityReader(h.events);
    expect(await activity.read(lease)).toMatchObject({ activity: 'idle', completionToken: 'claude-completed:1000' });
    h.write([h.command]);
    expect(await activity.read(lease)).not.toHaveProperty('completionToken');
    h.write([h.command, h.output, { type: 'last-prompt', sessionId: SESSION }, { type: 'mode' }]);
    const completed = await activity.read(lease);
    expect(completed).toMatchObject({ activity: 'idle', completionToken: `claude-local-command:${SESSION}:${OUTPUT}` });
    expect(await activity.read(lease)).toEqual(completed);
    h.writeHook('prompt', 3000);
    expect(await activity.read(lease)).toMatchObject({ activity: 'working' });
    expect(await activity.read(lease)).not.toHaveProperty('completionToken');
    h.writeHook('permreq', 4000);
    expect(await activity.read(lease)).toMatchObject({ activity: 'waiting' });
    expect(await activity.read(lease)).not.toHaveProperty('completionToken');
    await runs.shutdown();
  });

  it('releases the existing model cycle once and does not reuse its completion for the next send', async () => {
    const h = fixture();
    const runtime = new AgentRunRuntime();
    const lease = await runtime.controller('claude', async () => true).attach({
      paneId: '%1', attachmentId: 'claude-hooks', sessionId: SESSION, process: { pid: 101 },
    });
    const activity = createClaudeConversationActivityReader(h.events);
    const sendPrompt = vi.fn(async (_pane: string, _text: string) => {});
    const adapter = createClaudeConversationAdapter({
      projectsRoot: h.dir, sessions: h.events, findSessionFile: async () => h.transcript,
      control: { sendPrompt, interrupt: async () => {} },
    });
    const service = new ConversationService({
      runs: runtime, adapters: { claude: adapter },
      activitySource: { read: async () => {
        const current = await activity.read(lease);
        return { ...current, activeTurn: current.activeTurn ?? { state: 'unknown' }, revision: 1, epoch: lease.ref.runId };
      } },
    });
    await service.send(lease, { clientRequestId: 'model', text: '/model', delivery: 'prompt' });
    h.write([h.command]);
    expect(await service.send(lease, { clientRequestId: 'next', text: 'next task', delivery: 'prompt' }))
      .toMatchObject({ status: 'queued' });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    h.write([h.command, h.output]);
    await service.queueSnapshot(lease);
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    expect(sendPrompt.mock.calls.map((call) => call[1])).toEqual(['/model', 'next task']);
    expect(await service.send(lease, { clientRequestId: 'third', text: 'third task', delivery: 'prompt' }))
      .toMatchObject({ status: 'queued' });
    h.write([h.command]);
    await service.queueSnapshot(lease);
    h.write([h.command, h.output]);
    await service.queueSnapshot(lease);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendPrompt).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
  });

  it('does not lend another session completion to the attached run', async () => {
    const h = fixture(); h.write([h.command, h.output]);
    const runs = new AgentRunRuntime();
    const lease = await runs.controller('claude', async () => true).attach({
      paneId: '%1', attachmentId: 'claude-hooks', sessionId: COMMAND, process: { pid: 101 },
    });
    expect(await createClaudeConversationActivityReader(h.events).read(lease))
      .toEqual({ activity: 'unknown', activeTurn: { state: 'unknown' } });
    await runs.shutdown();
  });

  it('retains PostCompact completion when the command predates its Hook and stdout follows it', () => {
    const h = fixture();
    h.writeHook('compact', 2500);
    h.write([{ ...h.command, message: { role: 'user', content: '<command-name>/compact</command-name>' } },
      { ...h.output, timestamp: new Date(2600).toISOString() }]);
    expect(h.events.paneCompletionToken('%1')).toBe('claude-completed:2500');
  });

  it.each([
    ['wrong session', { sessionId: COMMAND }],
    ['wrong parent', { parentUuid: OUTPUT }],
    ['no UUID', { uuid: undefined }],
    ['assistant quote', { type: 'assistant', message: { role: 'assistant', content: '<local-command-stdout>Set model</local-command-stdout>' } }],
    ['user prose', { message: { role: 'user', content: 'Here is <local-command-stdout>Set model</local-command-stdout>' } }],
    ['older completion', { timestamp: new Date(999).toISOString() }],
    ['future completion', { timestamp: new Date(10001).toISOString() }],
  ])('does not manufacture completion from %s', (_label, changes) => {
    const h = fixture(); h.write([h.command, { ...h.output, ...changes }]);
    expect(h.events.paneCompletionToken('%1')).not.toBe(`claude-local-command:${SESSION}:${OUTPUT}`);
  });

  it('does not fall back to an older token when a new turn is appended or a record is incomplete', () => {
    const h = fixture(); h.write([h.command, h.output]);
    expect(h.events.paneCompletionToken('%1')).toBe(`claude-local-command:${SESSION}:${OUTPUT}`);
    h.write([h.command, h.output, { type: 'user', timestamp: new Date(3000).toISOString(), message: { role: 'user', content: 'next task' } }]);
    expect(h.events.paneCompletionToken('%1')).toBeNull();
    h.write([h.command, h.output], '');
    expect(h.events.paneCompletionToken('%1')).toBeNull();
    h.writeHook('stop', 4000);
    h.write([h.command, h.output]);
    expect(h.events.paneCompletionToken('%1')).toBe('claude-completed:4000');
  });
});
