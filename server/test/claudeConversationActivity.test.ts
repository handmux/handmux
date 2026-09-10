import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tmpHome } from './tmphome.js';
import { createClaudeEvents } from '../src/claudeEvents.js';
import { createClaudeConversationActivityReader } from '../src/agent-runtime/builtinRuntime.js';
import { RuntimeConversationActivitySource } from '../src/agent-runtime/conversationActivity.js';
import { ConversationService } from '../src/agent-runtime/conversation.js';
import { MemoryConversationStateStore } from '../src/agent-runtime/conversationStore.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';

async function harness() {
  const file = path.join(tmpHome('claude-activity-'), 'state.json');
  let ts = 1000;
  const write = (src: string, payload: Record<string, unknown> = {}) => {
    fs.writeFileSync(file, JSON.stringify({ '%1': {
      src, ts: ++ts, agent: 'claude', payload: { session_id: 'session-1', ...payload },
    } }));
  };
  const events = createClaudeEvents({ commands: {}, push: null, file });
  const activitySource = new RuntimeConversationActivitySource({ claude: createClaudeConversationActivityReader(events) });
  const runs = new AgentRunRuntime({ newRunId: () => 'run-1' });
  const lease = await runs.controller('claude', async () => true).attach({
    paneId: '%1', sessionId: 'session-1', attachmentId: 'attachment', process: { pid: 101 },
  });
  const dispatchPrompt = vi.fn(async () => ({ outcome: 'accepted' as const }));
  const service = new ConversationService({
    runs, activitySource, store: new MemoryConversationStateStore(),
    adapters: { claude: {
      apiVersion: 1,
      discoverNative: async (target) => ({
        session: { agentId: 'claude', sessionId: target.sessionId! },
        ...('runId' in target ? { run: target } : {}), sourceViewId: 'view',
        capabilities: { history: true, live: 'poll', sendable: true },
      }),
      readNativePage: async (session) => ({
        sessionId: session.sessionId, sourceViewId: 'view', sourceHistoryToken: 'history',
        items: [], hasMore: false,
      }),
      dispatchPrompt,
    } },
  });
  return { write, service, lease, dispatchPrompt, activitySource };
}

describe('Claude lifecycle state → conversation activity → queue', () => {
  it.each(['startup', 'resume', 'clear'])('releases the first %s send gate when polling misses the entire busy phase', async (source) => {
    const h = await harness();
    h.write('start', { source });
    expect(await h.service.send(h.lease, {
      clientRequestId: 'compact-command', text: '/compact', delivery: 'prompt',
    })).toEqual({ status: 'accepted' });
    expect(await h.service.send(h.lease, {
      clientRequestId: 'next-prompt', text: 'next task', delivery: 'prompt',
    })).toMatchObject({ status: 'queued' });
    // No poll sees UserPromptSubmit, PreCompact or SessionStart(compact).
    h.write('compact', { trigger: 'manual' });
    await h.service.queueSnapshot(h.lease);
    await vi.waitFor(() => expect(h.dispatchPrompt).toHaveBeenCalledTimes(2));
    await h.service.queueSnapshot(h.lease);
    expect(h.dispatchPrompt).toHaveBeenCalledTimes(2);
  });

  it('shows working and compacting, then drains one queued prompt after manual PostCompact', async () => {
    const h = await harness();
    h.write('prompt', { prompt: '/compact' });
    expect(await h.service.queueSnapshot(h.lease)).toMatchObject({ activity: 'working' });
    h.write('compacting', { trigger: 'manual' });
    expect(await h.service.queueSnapshot(h.lease)).toMatchObject({ activity: 'compacting' });
    expect(await h.service.send(h.lease, {
      clientRequestId: 'queued', text: 'next task', delivery: 'prompt',
    })).toMatchObject({ status: 'queued' });
    expect(h.dispatchPrompt).not.toHaveBeenCalled();
    h.write('compact', { trigger: 'manual' });
    expect(await h.activitySource.read(h.lease)).toMatchObject({ activity: 'idle', activeTurn: { state: 'none' } });
    await h.service.queueSnapshot(h.lease);
    await vi.waitFor(() => expect(h.dispatchPrompt).toHaveBeenCalledOnce());
    await h.service.queueSnapshot(h.lease);
    expect(h.dispatchPrompt).toHaveBeenCalledOnce();
  });

  it.each(['auto', undefined, 'future'])('keeps queued prompts blocked after PostCompact trigger %s', async (trigger) => {
    const h = await harness();
    h.write('compacting');
    await h.service.send(h.lease, { clientRequestId: 'queued', text: 'next task', delivery: 'prompt' });
    h.write('compact', trigger === undefined ? {} : { trigger });
    expect(await h.service.queueSnapshot(h.lease)).toMatchObject({
      activity: trigger === 'auto' ? 'working' : 'unknown', items: [{ id: 'queued', state: 'queued' }],
    });
    expect(h.dispatchPrompt).not.toHaveBeenCalled();
  });

  it('directly sends the first prompt from a fresh known session and after manual compaction', async () => {
    for (const [src, payload] of [
      ['start', { source: 'startup' }], ['compact', { trigger: 'manual' }],
    ] as const) {
      const h = await harness();
      h.write(src, payload);
      expect(await h.service.send(h.lease, {
        clientRequestId: 'first', text: 'next task', delivery: 'prompt',
      })).toEqual({ status: 'accepted' });
      expect(h.dispatchPrompt).toHaveBeenCalledOnce();
    }
  });
});
