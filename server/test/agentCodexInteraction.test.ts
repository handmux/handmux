import { describe, expect, it, vi } from 'vitest';
import type { CodexInteractionSnapshot } from '../src/codexAppServer.js';
import { InteractionService } from '../src/agent-runtime/interaction.js';
import type { InteractionEvent } from '../src/agent-runtime/interactionTypes.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';
import { createCodexInteractionAdapter } from '../src/agents/codexInteraction.js';

function appHarness(initial: Partial<CodexInteractionSnapshot> = {}) {
  let listener: ((snapshot: CodexInteractionSnapshot) => void) | undefined;
  const close = vi.fn();
  const snapshot: CodexInteractionSnapshot = {
    cursor: initial.cursor ?? 10,
    approvals: initial.approvals ?? [],
    userInputs: initial.userInputs ?? [],
  };
  const app = {
    discover: vi.fn(async () => ({ managed: true, threadId: 'thread-1' })),
    observeInteractions: vi.fn(async (
      _pane: string,
      _thread: string,
      next: (value: CodexInteractionSnapshot) => void,
    ) => {
      listener = next;
      return { ...structuredClone(snapshot), close };
    }),
    decide: vi.fn(async () => ({ ok: true })),
    answerInput: vi.fn(async () => ({ ok: true })),
  };
  return {
    app,
    close,
    emit(value: CodexInteractionSnapshot) {
      if (!listener) throw new Error('not observing');
      listener(structuredClone(value));
    },
  };
}

async function setup(initial: Partial<CodexInteractionSnapshot> = {}) {
  const runtime = new AgentRunRuntime({ newRunId: () => 'run-1' });
  const lease = await runtime.controller('codex', async () => true).attach({
    paneId: '%1', attachmentId: 'codex-app-server', sessionId: 'thread-1', process: { pid: 101 },
  });
  const harness = appHarness(initial);
  const adapter = createCodexInteractionAdapter(harness.app);
  const service = new InteractionService({
    runs: runtime, adapters: { codex: adapter },
    newToken: (() => { let id = 0; return () => `token-${++id}`; })(),
  });
  return { runtime, lease, harness, adapter, service };
}

describe('Codex Interaction adapter', () => {
  it('maps complete approval context and multi-field input without leaking provider ids', async () => {
    const h = await setup({
      approvals: [{
        id: '91', type: 'command', threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1',
        command: 'npm test', cwd: '/work', reason: 'Run the test suite before continuing.',
        decisions: ['accept', { id: 'structured:1', type: 'execpolicy', rule: ['npm', 'test'] }, 'decline'],
      }],
      userInputs: [
        {
          id: '92', threadId: 'thread-1', turnId: 'turn-1', autoResolutionMs: null,
          questions: [{
            id: 'color', header: 'Color', question: 'Choose', isOther: false, isSecret: false,
            options: [{ label: 'Blue', description: 'Calm' }],
          }, {
            id: 'secret', header: 'Secret', question: 'Password', isOther: false, isSecret: true,
            options: null,
          }, {
            id: 'style', header: 'Style', question: 'Pick or enter', isOther: true, isSecret: false,
            options: [{ label: 'Short', description: 'Concise' }],
          }],
        },
      ],
    });
    const handle = await h.service.open(h.lease, () => {});
    expect(handle.pending.map((item) => item.type)).toEqual(['approval', 'form']);
    expect(handle.pending[0]).toMatchObject({
      intent: 'command_approval', correlationId: 'cmd-1',
      details: [
        { kind: 'reason', type: 'text', text: 'Run the test suite before continuing.' },
        { kind: 'command', type: 'code', text: 'npm test' },
        { kind: 'working_directory', type: 'path', text: '/work' },
      ],
      options: [
        { id: 'accept', label: 'Allow once' },
        { id: 'structured:1', label: 'Allow command policy' },
        { id: 'decline', label: 'Deny' },
      ],
    });
    expect(handle.pending[1]).toMatchObject({
      intent: 'input_request',
      fields: [
        {
          id: 'field:0', type: 'select', label: 'Color', prompt: 'Choose',
          options: [{ id: 'option:0:0', label: 'Blue', description: 'Calm' }],
        },
        { id: 'field:1', type: 'secret', label: 'Secret', prompt: 'Password' },
        {
          id: 'field:2', type: 'select', label: 'Style', prompt: 'Pick or enter',
          allowOther: true,
        },
      ],
    });
    expect(JSON.stringify(handle.pending)).not.toContain('approval:91');
  });

  it('diffs atomic App Server snapshots into opened and resolved events', async () => {
    const h = await setup();
    const events: InteractionEvent[] = [];
    await h.service.open(h.lease, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.harness.emit({
      cursor: 11,
      approvals: [{
        id: '91', type: 'file', threadId: 'thread-1', command: null, cwd: '/work',
        reason: 'Write file?', decisions: ['accept', 'decline'],
      }],
      userInputs: [],
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'opened', interaction: { type: 'approval' } });
    h.harness.emit({ cursor: 12, approvals: [], userInputs: [] });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toMatchObject({ type: 'resolved', interactionId: events[0]?.type === 'opened'
      ? events[0].interaction.id : '' });
  });

  it('maps Core approval and selection responses back to exact App Server values', async () => {
    const h = await setup({
      approvals: [{
        id: '91', type: 'permissions', threadId: 'thread-1', command: null, cwd: null,
        reason: 'Network?', decisions: ['accept', 'acceptForSession', 'decline'],
      }],
      userInputs: [{
        id: '92', threadId: 'thread-1', autoResolutionMs: null,
        questions: [{
          id: 'color', header: 'Color', question: 'Choose', isOther: false, isSecret: false,
          options: [{ label: 'Blue', description: 'Calm' }, { label: 'Red', description: 'Bold' }],
        }],
      }],
    });
    const handle = await h.service.open(h.lease, () => {});
    const approval = handle.pending.find((item) => item.type === 'approval')!;
    expect(await h.service.respond(h.lease, {
      interactionId: approval.id, resolutionToken: approval.resolutionToken,
      value: { type: 'approval', optionId: 'acceptForSession' },
    })).toEqual({ status: 'accepted' });
    expect(h.harness.app.decide).toHaveBeenCalledWith('%1', 'thread-1', '91', 'acceptForSession');

    const input = handle.pending.find((item) => item.type === 'form')!;
    expect(await h.service.respond(h.lease, {
      interactionId: input.id, resolutionToken: input.resolutionToken,
      value: { type: 'form', answers: { 'field:0': 'option:0:1' } },
    })).toEqual({ status: 'accepted' });
    expect(h.harness.app.answerInput).toHaveBeenCalledWith('%1', 'thread-1', '92', { color: ['Red'] });
  });

  it('dispatches secret and allow-other answers only through the normalized form boundary', async () => {
    const h = await setup({
      userInputs: [{
        id: '92', threadId: 'thread-1', autoResolutionMs: null,
        questions: [{
          id: 'secret', header: 'Secret', question: 'Password', isOther: false, isSecret: true,
          options: null,
        }, {
          id: 'color', header: 'Color', question: 'Choose or enter', isOther: true, isSecret: false,
          options: [{ label: 'Blue', description: 'Calm' }],
        }],
      }],
    });
    const handle = await h.service.open(h.lease, () => {});
    const input = handle.pending[0]!;
    expect(await h.service.respond(h.lease, {
      interactionId: input.id, resolutionToken: input.resolutionToken,
      value: { type: 'form', answers: {
        'field:0': ' correct horse battery staple ',
        'field:1': 'Mauve',
      } },
    })).toEqual({ status: 'accepted' });
    expect(h.harness.app.answerInput).toHaveBeenCalledWith('%1', 'thread-1', '92', {
      secret: [' correct horse battery staple '], color: ['Mauve'],
    });
  });

  it('requires the pane-owned thread and maps native terminal races safely', async () => {
    const h = await setup({
      approvals: [{
        id: '91', type: 'command', threadId: 'thread-1', command: 'pwd', cwd: '/work',
        reason: null, decisions: ['accept', 'decline'],
      }],
    });
    h.harness.app.discover.mockResolvedValueOnce({ managed: true, threadId: 'other' });
    await expect(h.service.open(h.lease, () => {})).rejects.toThrow(/pane-owned/i);

    const second = await setup({
      approvals: [{
        id: '91', type: 'command', threadId: 'thread-1', command: 'pwd', cwd: '/work',
        reason: null, decisions: ['accept', 'decline'],
      }],
    });
    const handle = await second.service.open(second.lease, () => {});
    second.harness.app.decide.mockRejectedValueOnce(new Error('approval request is no longer pending'));
    const item = handle.pending[0]!;
    expect(await second.service.respond(second.lease, {
      interactionId: item.id, resolutionToken: item.resolutionToken,
      value: { type: 'approval', optionId: 'accept' },
    })).toEqual({ status: 'already_resolved' });
  });

  it('cancels pending cards when the App Server observer disconnects', async () => {
    const h = await setup({
      approvals: [{
        id: '91', type: 'command', threadId: 'thread-1', command: 'pwd', cwd: '/work',
        reason: null, decisions: ['accept', 'decline'],
      }],
    });
    const events: InteractionEvent[] = [];
    await h.service.open(h.lease, (event) => { events.push(event); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.harness.emit({ cursor: 10, approvals: [], userInputs: [], disconnected: true });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'cancelled', reason: 'stream_reset' });
    expect(h.harness.close).toHaveBeenCalledOnce();
  });
});
