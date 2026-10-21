import { ScheduledMessagesService, MemoryScheduledStore } from '../src/agent-runtime/scheduledMessages.js';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ConversationContractError } from '../src/agent-runtime/conversation.js';
import { ConversationActivationError } from '../src/agent-runtime/conversationActivation.js';
import { ConversationControlError } from '../src/agent-runtime/conversationControls.js';
import { ConversationRestartError } from '../src/agent-runtime/conversationRestart.js';
import {
  ConversationLiveHub,
  type ConversationLiveSubscription,
} from '../src/agent-runtime/conversationLiveHub.js';
import {
  InteractionLiveHub,
  type InteractionLiveSubscription,
} from '../src/agent-runtime/interactionLiveHub.js';
import { AgentResourceService } from '../src/agent-runtime/resources.js';
import { SubscriptionUsageService } from '../src/agent-runtime/subscriptionUsage.js';
import { agentRoutes } from '../src/routes/agents.js';

function app(runtime: Parameters<typeof agentRoutes>[0]['runtime']) {
  const value = express();
  value.use(express.json());
  value.use(agentRoutes({ runtime }));
  return value;
}

function runtime() {
  const abort = new AbortController();
  const lease = {
    ref: { agentId: 'pi', paneId: '%1', runId: 'run-1', sessionId: 'session-1' },
    signal: abort.signal,
  };
  return {
    abort,
    lease,
    value: {
      capabilities: vi.fn(() => [{
        id: 'pi', label: 'Pi',
        capabilities: { inbox: true, conversation: true, interaction: false },
      }]),
      health: vi.fn(() => [{ adapterId: 'pi', availability: 'ready' }]),
      activeRuns: vi.fn(() => [lease.ref]),
      inbox: {
        read: vi.fn(() => ({ serviceEpoch: 'epoch', revision: 1, records: [] })),
        markTerminalRead: vi.fn(async (ids: string[]) => ({
          serviceEpoch: 'epoch', revision: 2, markedIds: ids, readAt: 2_000,
        })),
      },
      runs: { resolve: vi.fn((ref) => ref.runId === 'run-1' ? lease : null) },
      resources: {
        read: vi.fn(async () => null),
      },
      conversation: {
        discover: vi.fn(async () => ({ session: { agentId: 'pi', sessionId: 'session-1' } })),
        readPage: vi.fn(async () => ({ status: 'ok', page: { items: [] } })),
        open: vi.fn(),
        send: vi.fn(async () => ({ status: 'accepted' })),
        queueSnapshot: vi.fn(async () => ({
          activity: 'working', canSteer: true, canEdit: true, canRemove: true,
          items: [], submissions: [{
            id: 'request-1', text: 'hello', state: 'unknown', revision: 2,
            dispatchOrigin: 'steer', createdAt: 1, updatedAt: 2,
          }],
        })),
        queueAction: vi.fn(async () => ({ ok: true })),
        querySubmission: vi.fn(() => ({
          status: 'unknown', submission: {
            id: 'request-1', text: 'hello', state: 'unknown', revision: 2,
            dispatchOrigin: 'steer', createdAt: 1, updatedAt: 2,
          },
        })),
        interrupt: vi.fn(async () => ({ status: 'accepted' })),
      },
      interaction: null as unknown as Parameters<typeof agentRoutes>[0]['runtime']['interaction'],
      conversationActivation: null,
      sessionControl: null,
      subscriptionUsage: null,
    } as unknown as Parameters<typeof agentRoutes>[0]['runtime'],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function expectClosedPendingLiveRequest({
  runtime: value,
  path,
  subscribed,
  release,
  close,
}: {
  runtime: Parameters<typeof agentRoutes>[0]['runtime'];
  path: string;
  subscribed: () => boolean;
  release: () => void;
  close: ReturnType<typeof vi.fn>;
}): Promise<void> {
  const application = express();
  let response: Response | undefined;
  let connectionClosed = false;
  application.use((_req, res, next) => {
    response = res;
    res.once('close', () => { connectionClosed = true; });
    next();
  });
  application.use(agentRoutes({ runtime: value }));
  const server = http.createServer(application);
  let client: http.ClientRequest | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;
    client = http.get({ host: '127.0.0.1', port, path });
    client.on('error', () => {});
    await vi.waitFor(() => expect(subscribed()).toBe(true));
    expect(response).toBeDefined();
    const setHeader = vi.spyOn(response!, 'setHeader');
    const flushHeaders = vi.spyOn(response!, 'flushHeaders');
    const write = vi.spyOn(response!, 'write');

    client.destroy();
    await vi.waitFor(() => expect(connectionClosed).toBe(true));
    release();

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(setHeader).not.toHaveBeenCalled();
    expect(flushHeaders).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(response!.headersSent).toBe(false);
  } finally {
    client?.destroy();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
      });
    }
  }
}

describe('Agent app facade routes', () => {
  it('describes and starts Conversation activation through a current run with stable errors', async () => {
    const h = runtime();
    const describe = vi.fn(async () => ({ effect: 'replace-process-preserve-session' as const }));
    const activate = vi.fn(async () => {});
    const supported = {
      ...h.value, conversationActivation: { describe, activate },
    } as unknown as typeof h.value;
    await request(app(supported)).get('/agents/conversation-activation').query(h.lease.ref)
      .expect(200, { descriptor: { effect: 'replace-process-preserve-session' } });
    await request(app(supported)).post('/agents/conversation-activation').send({ run: h.lease.ref })
      .expect(202, { accepted: true });
    expect(describe).toHaveBeenCalledWith(h.lease);
    expect(activate).toHaveBeenCalledWith(h.lease);

    await request(app(supported)).post('/agents/conversation-activation').send({
      run: { ...h.lease.ref, runId: 'stale' },
    }).expect(409, { error: 'stale agent run', code: 'stale_run' });
    activate.mockRejectedValueOnce(new ConversationActivationError(
      'Conversation activation could not finish; continue in the terminal or try again', 'unavailable',
      {
        kind: 'codex_resume',
        sessionId: '12345678-1234-1234-1234-123456789abc',
        command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
      },
    ));
    const failure = await request(app(supported)).post('/agents/conversation-activation')
      .send({ run: h.lease.ref }).expect(503);
    expect(failure.body).toEqual({
      error: 'Conversation activation could not finish; continue in the terminal or try again',
      code: 'unavailable',
      recovery: {
        kind: 'codex_resume',
        sessionId: '12345678-1234-1234-1234-123456789abc',
        command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
      },
    });
    expect(JSON.stringify(failure.body)).not.toContain('/Users/private');
  });

  it('finishes a confirmed Conversation activation after the HTTP client disconnects', async () => {
    const h = runtime();
    const started = deferred<void>();
    const release = deferred<void>();
    let activationSignal: AbortSignal | undefined;
    let completed = false;
    const supported = {
      ...h.value,
      conversationActivation: {
        describe: vi.fn(async () => ({ effect: 'replace-process-preserve-session' as const })),
        activate: vi.fn(async (_lease, signal?: AbortSignal) => {
          activationSignal = signal;
          started.resolve();
          await release.promise;
          completed = true;
        }),
      },
    } as unknown as typeof h.value;
    const application = express();
    let responseClosed = false;
    application.use(express.json());
    application.use((_req, res, next) => {
      res.once('close', () => { responseClosed = true; });
      next();
    });
    application.use(agentRoutes({ runtime: supported }));
    const server = http.createServer(application);
    let client: http.ClientRequest | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const port = (server.address() as AddressInfo).port;
      client = http.request({
        host: '127.0.0.1', port, path: '/agents/conversation-activation', method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      client.on('error', () => {});
      client.end(JSON.stringify({ run: h.lease.ref }));
      await started.promise;

      client.destroy();
      await vi.waitFor(() => expect(responseClosed).toBe(true));
      expect(activationSignal).toBeUndefined();
      release.resolve();
      await vi.waitFor(() => expect(completed).toBe(true));
    } finally {
      client?.destroy();
      release.resolve();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error) reject(error); else resolve(); });
        });
      }
    }
  });

  it('returns verified recovery metadata when activation succeeds before discovery catches up', async () => {
    const h = runtime();
    const recovery = {
      kind: 'codex_resume' as const,
      sessionId: '12345678-1234-1234-1234-123456789abc',
      command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
    };
    const supported = {
      ...h.value,
      conversationActivation: {
        describe: vi.fn(),
        activate: vi.fn(async () => ({ recovery })),
      },
    } as unknown as typeof h.value;
    await request(app(supported)).post('/agents/conversation-activation').send({ run: h.lease.ref })
      .expect(202, { accepted: true, recovery });
  });

  it('routes any current run to the restart capability and leaves support decisions to the service', async () => {
    const h = runtime();
    const receipt = {
      agentId: 'codex', paneId: '%1',
      operationId: 'a'.repeat(64),
      recovery: {
        kind: 'codex_resume' as const,
        sessionId: '12345678-1234-1234-1234-123456789abc',
        command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
      },
      phase: 'ready' as const,
      state: 'current' as const,
      canResume: false,
    };
    const restart = vi.fn(async (lease) => {
      if (lease.ref.agentId !== 'codex') {
        throw new ConversationRestartError('Conversation restart is not supported for this Agent', 'unsupported');
      }
      return receipt;
    });
    const recovery = vi.fn(async () => receipt);
    const recover = vi.fn(async () => receipt);
    const codexRun = { ...h.lease.ref, agentId: 'codex', runId: 'codex-run' };
    const codexLease = { ...h.lease, ref: codexRun };
    const supported = {
      ...h.value,
      runs: { resolve: vi.fn((ref) => ref.runId === 'stale' ? null
        : ref.agentId === 'codex' ? codexLease : h.lease) },
      conversationRestart: { restart, recovery, recover },
    } as unknown as typeof h.value;

    await request(app(supported)).post('/agents/conversation-restart')
      .send({ run: { agentId: 'codex', paneId: '%1', runId: 'codex-run' } })
      .expect(400, { error: 'invalid agent run' });
    await request(app(supported)).post('/agents/conversation-restart')
      .send({ run: { ...codexRun, runId: 'stale' } })
      .expect(409, { error: 'stale agent run', code: 'stale_run' });
    await request(app(supported)).post('/agents/conversation-restart')
      .send({ run: h.lease.ref })
      .expect(409, { error: 'Conversation restart is not supported for this Agent', code: 'unsupported' });
    await request(app(supported)).post('/agents/conversation-restart')
      .send({ run: codexRun })
      .expect(200, { receipt });
    expect(restart).toHaveBeenCalledTimes(2);
    expect(restart.mock.calls[0]?.[0]).toBe(h.lease);
    expect(restart.mock.calls[1]?.[0]).toBe(codexLease);

    await request(app(supported)).get('/agents/conversation-restart-recovery')
      .query({ paneId: '1' }).expect(400, { error: 'invalid conversation recovery pane' });
    await request(app(supported)).get('/agents/conversation-restart-recovery')
      .query({ paneId: '%1' }).expect(200, { receipt });
    await request(app(supported)).post('/agents/conversation-restart-recovery')
      .send({ paneId: '%1', operationId: 'bad' })
      .expect(400, { error: 'invalid conversation recovery request' });
    await request(app(supported)).post('/agents/conversation-restart-recovery')
      .send({ paneId: '%1', operationId: receipt.operationId })
      .expect(200, { receipt });
    expect(recovery).toHaveBeenCalledWith('%1');
    expect(recover).toHaveBeenCalledWith('%1', receipt.operationId);
  });

  it('returns a pre-stop restart rejection without inventing recovery', async () => {
    const h = runtime();
    const codexRun = { ...h.lease.ref, agentId: 'codex' };
    const supported = {
      ...h.value,
      runs: { resolve: vi.fn(() => ({ ...h.lease, ref: codexRun })) },
      conversationRestart: {
        restart: vi.fn(async () => { throw new ConversationRestartError('Codex process not verified', 'not_started'); }),
        recovery: vi.fn(async () => null),
        recover: vi.fn(async () => null),
      },
    } as unknown as typeof h.value;

    await request(app(supported)).post('/agents/conversation-restart')
      .send({ run: codexRun })
      .expect(409, { error: 'Codex process not verified', code: 'not_started' });
  });

  it('continues an accepted Conversation restart after the HTTP client disconnects', async () => {
    const h = runtime();
    const started = deferred<void>();
    const release = deferred<void>();
    let completed = false;
    const codexRun = { ...h.lease.ref, agentId: 'codex' };
    const codexLease = { ...h.lease, ref: codexRun };
    const supported = {
      ...h.value,
      runs: { resolve: vi.fn(() => codexLease) },
      conversationRestart: {
        restart: vi.fn(async () => {
          started.resolve();
          await release.promise;
          completed = true;
          return null;
        }),
        recovery: vi.fn(async () => null),
        recover: vi.fn(async () => null),
      },
    } as unknown as typeof h.value;
    const application = express();
    let responseClosed = false;
    application.use(express.json());
    application.use((_req, res, next) => {
      res.once('close', () => { responseClosed = true; });
      next();
    });
    application.use(agentRoutes({ runtime: supported }));
    const server = http.createServer(application);
    let client: http.ClientRequest | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const port = (server.address() as AddressInfo).port;
      client = http.request({
        host: '127.0.0.1', port, path: '/agents/conversation-restart', method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      client.on('error', () => {});
      client.end(JSON.stringify({ run: codexRun }));
      await started.promise;

      client.destroy();
      await vi.waitFor(() => expect(responseClosed).toBe(true));
      release.resolve();
      await vi.waitFor(() => expect(completed).toBe(true));
    } finally {
      client?.destroy();
      release.resolve();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error) reject(error); else resolve(); });
        });
      }
    }
  });

  it('serves durable Conversation recovery with strict HTTP contracts', async () => {
    const h = runtime();
    const recovery = {
      kind: 'codex_resume' as const,
      sessionId: '12345678-1234-1234-1234-123456789abc',
      command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
    };
    const current = {
      operationId: 'a'.repeat(64), recovery, phase: 'interrupted' as const,
      state: 'current' as const, canResume: true,
    };
    const stale = {
      operationId: 'b'.repeat(64), recovery, phase: 'prepared' as const,
      state: 'stale' as const, canResume: false,
    };
    const readRecovery = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(stale)
      .mockRejectedValueOnce(new ConversationActivationError(
        'Conversation recovery is temporarily unavailable', 'unavailable',
      ));
    const recover = vi.fn(async () => ({ recovery }));
    const supported = {
      ...h.value,
      conversationActivation: {
        describe: vi.fn(), activate: vi.fn(), recovery: readRecovery, recover,
      },
    } as unknown as typeof h.value;

    await request(app(supported)).get('/agents/conversation-activation-recovery')
      .query({ paneId: '1' }).expect(400, { error: 'invalid conversation recovery pane' });
    await request(app(supported)).post('/agents/conversation-activation-recovery')
      .send({ paneId: '%1', operationId: 'bad' })
      .expect(400, { error: 'invalid conversation recovery request' });
    await request(app(supported)).get('/agents/conversation-activation-recovery')
      .query({ paneId: '%1' }).expect(200, { receipt: null });
    await request(app(supported)).get('/agents/conversation-activation-recovery')
      .query({ paneId: '%1' }).expect(200, { receipt: current });
    await request(app(supported)).get('/agents/conversation-activation-recovery')
      .query({ paneId: '%1' }).expect(200, { receipt: stale });
    await request(app(supported)).get('/agents/conversation-activation-recovery')
      .query({ paneId: '%1' }).expect(503, {
        error: 'Conversation recovery is temporarily unavailable', code: 'unavailable',
      });
    await request(app(supported)).post('/agents/conversation-activation-recovery')
      .send({ paneId: '%1', operationId: current.operationId })
      .expect(202, { accepted: true, recovery });
    expect(recover).toHaveBeenCalledWith('%1', current.operationId);
  });

  it('reads and updates model control only through a current run lease', async () => {
    const h = runtime();
    const control = {
      models: [{ id: 'provider/model', label: 'Model', efforts: [{ id: 'high' }] }],
      selected: { model: 'provider/model', effort: 'high' },
    };
    const readModelControl = vi.fn(async () => control);
    const updateModelControl = vi.fn(async () => control);
    const supported = {
      ...h.value,
      sessionControl: { readModelControl, updateModelControl },
    } as unknown as typeof h.value;
    await request(app(supported)).get('/agents/session-control/model').query({
      ...h.lease.ref, refresh: 'true',
    }).expect(200, { control });
    expect(readModelControl).toHaveBeenCalledWith(h.lease, { refresh: true });
    await request(app(supported)).patch('/agents/session-control/model').send({
      run: h.lease.ref, patch: { effort: 'high' },
    }).expect(200, { control });
    expect(updateModelControl).toHaveBeenCalledWith(h.lease, { effort: 'high' });

    await request(app(supported)).get('/agents/session-control/model').query({
      ...h.lease.ref, runId: 'stale',
    }).expect(409, { error: 'stale agent run' });
    await request(app(h.value)).get('/agents/session-control/model').query(h.lease.ref)
      .expect(503, { error: 'session control unsupported', code: 'unsupported' });
  });

  it('serves the normalized subscription Usage envelope and rejects unsupported runtimes', async () => {
    const h = runtime();
    await request(app(h.value)).get('/agents/usage').expect(503, {
      error: 'subscription usage unsupported', code: 'unsupported',
    });
    const snapshot = vi.fn()
      .mockResolvedValueOnce({
        groups: [{ kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 3 }] }],
        updatedAt: 1_000, status: 'ready',
      })
      .mockResolvedValueOnce({
        groups: [{ kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 4 }] }],
        updatedAt: 1_001, status: 'ready',
      })
      .mockRejectedValueOnce(new Error('provider offline'));
    const subscriptionUsage = new SubscriptionUsageService({
      adapters: { pi: { apiVersion: 1, snapshot } },
      descriptors: { pi: { label: 'Pi' } },
      ttlMs: 60_000,
      now: () => 2_000,
    });
    const supported = { ...h.value, subscriptionUsage } as unknown as typeof h.value;
    await request(app(supported)).get('/agents/usage').expect(200, {
      agents: [{
        agentId: 'pi', label: 'Pi', status: 'ready', updatedAt: 1_000,
        groups: [{ kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 3 }] }],
      }],
    });
    expect(snapshot).toHaveBeenLastCalledWith({ refresh: false });
    await request(app(supported)).get('/agents/usage').query({ refresh: 'true' }).expect(200, {
      agents: [{
        agentId: 'pi', label: 'Pi', status: 'ready', updatedAt: 1_001, refreshStatus: 'fresh',
        groups: [{ kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 4 }] }],
      }],
    });
    expect(snapshot).toHaveBeenLastCalledWith({ refresh: true });
    await request(app(supported)).get('/agents/usage').query({ refresh: 'true', target: 'pi' }).expect(200, {
      agents: [{
        agentId: 'pi', label: 'Pi', status: 'ready', updatedAt: 1_001, refreshStatus: 'stale',
        groups: [{ kind: 'account', id: 'account', windows: [{ id: 'primary', usedPercent: 4 }] }],
      }],
    });
    await request(app(supported)).get('/agents/usage').query({ refresh: 'now' }).expect(400, {
      error: 'invalid subscription usage refresh',
    });
    await request(app(supported)).get('/agents/usage').query({ target: 'pi' }).expect(400, {
      error: 'invalid subscription usage target',
    });
    await request(app(supported)).get('/agents/usage').query({ refresh: 'true', target: '../pi' }).expect(400, {
      error: 'invalid subscription usage target',
    });
    await request(app(supported)).get('/agents/usage').query({ refresh: 'true', target: 'unknown' }).expect(400, {
      error: 'invalid subscription usage target',
    });
  });

  it('exposes normalized discovery and Inbox state without Bridge internals', async () => {
    const h = runtime();
    const capabilities = await request(app(h.value)).get('/agents/capabilities').expect(200);
    expect(capabilities.body).toMatchObject({
      adapters: [{ id: 'pi', capabilities: { conversation: true } }],
      health: [{ adapterId: 'pi', availability: 'ready' }],
      runs: [h.lease.ref],
    });
    expect(JSON.stringify(capabilities.body)).not.toMatch(/socket|credential|authToken/);
    await request(app(h.value)).get('/agents/inbox').expect(200, {
      serviceEpoch: 'epoch', revision: 1, records: [],
    });
  });

  it('serves public Queue controls when an Agent has no optional Conversation controls', async () => {
    const h = runtime();
    const read = vi.fn(async () => {
      throw new ConversationControlError('Conversation controls unsupported', 'unsupported');
    });
    vi.mocked(h.value.conversation!.queueSnapshot).mockResolvedValueOnce({
      activity: 'working', canSteer: false, canEdit: true, canRemove: true,
      items: [{
        id: 'queued-1', requestId: 'queued-1', text: 'queued', state: 'queued',
        revision: 1, createdAt: 1, updatedAt: 1,
      }], submissions: [], settled: [],
    });
    const mixed = {
      ...h.value, conversationControls: { read },
    } as unknown as typeof h.value;

    const response = await request(app(mixed)).get('/agents/conversation-controls')
      .query(h.lease.ref).expect(200);
    expect(response.body).toMatchObject({
      controls: {
        activity: 'working',
        queue: {
          canSteer: false, canEdit: true, canRemove: true,
          items: [{ id: 'queued-1', requestId: 'queued-1', state: 'queued' }],
          settled: [],
        },
        submissions: [],
      },
    });
    expect(read).toHaveBeenCalledWith(h.lease);
    expect(h.value.conversation!.queueSnapshot).toHaveBeenCalledWith(h.lease);
  });

  it.each(['idle', 'working', 'waiting', 'compacting', 'unknown'] as const)(
    'forwards Runtime activity %s even when legacy context disagrees', async (activity) => {
      const h = runtime();
      const queue = { activity, canSteer: false, canEdit: true, canRemove: true,
        items: [], submissions: [], settled: [] };
      vi.mocked(h.value.conversation!.queueSnapshot).mockResolvedValueOnce(queue);
      const mixed = { ...h.value, conversationControls: {
        read: vi.fn(async () => ({ context: { activity: 'working', cwd: '/work' } })),
      } } as unknown as typeof h.value;
      const response = await request(app(mixed)).get('/agents/conversation-controls')
        .query(h.lease.ref).expect(200);
      expect(response.body.controls).toEqual({
        activity, queue, submissions: [], context: { activity: 'working', cwd: '/work' },
      });
      expect(h.value.conversation!.queueSnapshot).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves optional controls when no public Queue snapshot is available', async () => {
    const h = runtime();
    const controls = { context: { activity: 'idle', cwd: '/work' } };
    const legacy = { ...h.value, conversation: null,
      conversationControls: { read: vi.fn(async () => controls) },
    } as unknown as typeof h.value;
    await request(app(legacy)).get('/agents/conversation-controls').query(h.lease.ref)
      .expect(200, { controls });
  });

  it('keeps controls unsupported when neither optional controls nor public Queue is available', async () => {
    const h = runtime();
    const read = vi.fn(async () => {
      throw new ConversationControlError('Conversation controls unsupported', 'unsupported');
    });
    const unsupported = {
      ...h.value, conversation: null, conversationControls: { read },
    } as unknown as typeof h.value;

    await request(app(unsupported)).get('/agents/conversation-controls').query(h.lease.ref)
      .expect(409, { error: 'Conversation controls unsupported', code: 'unsupported' });
  });

  it('does not hide a real optional-control failure behind the public Queue snapshot', async () => {
    const h = runtime();
    const read = vi.fn(async () => {
      throw new ConversationControlError('Conversation control contract failed', 'contract_violation');
    });
    const broken = {
      ...h.value, conversationControls: { read },
    } as unknown as typeof h.value;

    await request(app(broken)).get('/agents/conversation-controls').query(h.lease.ref)
      .expect(502, { error: 'Conversation control contract failed', code: 'contract_violation' });
    expect(h.value.conversation!.queueSnapshot).not.toHaveBeenCalled();
  });

  it('reads durable pages and gates control operations on a current full run reference', async () => {
    const h = runtime();
    await request(app(h.value)).post('/agents/conversation/page').send({
      run: h.lease.ref, request: { limit: 20 },
    }).expect(200, { status: 'ok', page: { items: [] } });
    expect(h.value.conversation!.readPage).toHaveBeenCalledWith(h.lease.ref, { limit: 20 });
    await request(app(h.value)).post('/agents/conversation/page').send({
      run: { ...h.lease.ref, runId: 'stale' }, request: { limit: 20 },
    }).expect(409, { error: 'stale agent run' });
    await request(app(h.value)).post('/agents/conversation/send').send({
      run: h.lease.ref,
      request: { clientRequestId: 'request-1', text: 'hello', delivery: 'prompt' },
    }).expect(200, { status: 'accepted' });
    await request(app(h.value)).post('/agents/conversation/interrupt').send({
      run: { ...h.lease.ref, runId: 'stale' },
    }).expect(409, { error: 'stale agent run' });
    await request(app(h.value)).post('/agents/conversation/submission/query').send({
      run: h.lease.ref, submissionId: 'request-1', actionId: 'steer-1',
    }).expect(200, {
      status: 'unknown', submission: {
        id: 'request-1', text: 'hello', state: 'unknown', revision: 2,
        dispatchOrigin: 'steer', createdAt: 1, updatedAt: 2,
      },
    });
    expect(h.value.conversation!.querySubmission)
      .toHaveBeenCalledWith(h.lease, 'request-1', 'steer-1');
  });

  it('classifies only page epochs as stale and preserves other page failure semantics', async () => {
    const h = runtime();
    const readPage = vi.mocked(h.value.conversation!.readPage);
    const body = { run: h.lease.ref, request: { limit: 20 } };

    readPage.mockRejectedValueOnce(new ConversationContractError(
      'Invalid Conversation page request', 'invalid_request',
    ));
    await request(app(h.value)).post('/agents/conversation/page').send(body)
      .expect(400, { error: 'invalid conversation page request' });

    readPage.mockRejectedValueOnce(new ConversationContractError(
      'Conversation cursor is invalid or expired', 'page_stale',
    ));
    await request(app(h.value)).post('/agents/conversation/page').send(body)
      .expect(409, { error: 'conversation page stale' });

    readPage.mockRejectedValueOnce(new ConversationContractError(
      'Conversation session is unavailable', 'session_unavailable',
    ));
    const unavailable = await request(app(h.value)).post('/agents/conversation/page').send(body)
      .expect(503, {
        error: 'conversation session unavailable',
        code: 'conversation_session_unavailable',
      });
    expect(unavailable.headers['retry-after']).toBe('1');

    const adapterFailure = new ConversationContractError(
      'Conversation adapter returned an invalid page', 'contract_violation',
    );
    readPage.mockRejectedValueOnce(adapterFailure);
    const forwarded: unknown[] = [];
    const application = app(h.value);
    application.use((error: unknown, _req: express.Request, res: express.Response,
      _next: express.NextFunction) => {
      forwarded.push(error);
      res.status(500).json({ error: 'internal' });
    });
    await request(application).post('/agents/conversation/page').send(body)
      .expect(500, { error: 'internal' });
    expect(forwarded).toEqual([adapterFailure]);
  });

  it('downloads only an owner-scoped opaque Conversation resource with safe headers', async () => {
    const h = runtime();
    const resources = new AgentResourceService({
      newResourceId: () => 'opaque-resource-id-0001',
    });
    await resources.forAdapter('pi').register(
      { agentId: 'pi', sessionId: 'session-1' },
      {
        kind: 'bytes', data: new Uint8Array([1, 2, 3]),
        name: 'result.svg', mediaType: 'image/svg+xml',
      },
    );
    const value = { ...h.value, resources };
    const response = await request(app(value)).get('/agents/conversation/resource').query({
      agentId: 'pi', sessionId: 'session-1', resourceId: 'opaque-resource-id-0001',
    }).expect(200);
    expect([...response.body]).toEqual([1, 2, 3]);
    expect(response.headers).toMatchObject({
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-type': 'image/svg+xml',
      'content-length': '3',
    });
    expect(response.headers['content-disposition']).toContain('attachment;');

    await request(app(value)).get('/agents/conversation/resource').query({
      agentId: 'pi', sessionId: 'another-session', resourceId: 'opaque-resource-id-0001',
    }).expect(404, { error: 'conversation resource unavailable' });
    await request(app(value)).get('/agents/conversation/resource').query({
      agentId: 'pi', sessionId: 'session-1', resourceId: '../etc/passwd',
    }).expect(400, { error: 'invalid conversation resource request' });
  });

  it('marks canonical terminal notifications read through the app facade', async () => {
    const h = runtime();
    await request(app(h.value)).post('/agents/inbox/notifications/read').send({
      notificationIds: ['notification-1'],
    }).expect(200, {
      serviceEpoch: 'epoch', revision: 2,
      markedIds: ['notification-1'], readAt: 2_000,
    });
    expect(h.value.inbox.markTerminalRead).toHaveBeenCalledWith(['notification-1']);
    await request(app(h.value)).post('/agents/inbox/notifications/read').send({
      notificationIds: [],
    }).expect(400, { error: 'invalid terminal notification ids' });
  });

  it('streams shared normalized Conversation events through the app SSE facade', async () => {
    const h = runtime();
    const close = vi.fn();
    h.value.conversation!.open = vi.fn(async (_lease, _request, sink) => {
      setTimeout(() => {
        void sink({ type: 'stream.gap', sequence: 1, afterSequence: 0 });
      }, 0);
      return {
        checkpoint: { viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0 },
        close,
      };
    });
    const response = await request(app(h.value)).get('/agents/conversation/live').query(h.lease.ref)
      .expect(200).expect('Content-Type', /text\/event-stream/);
    expect(response.text).toContain('"type":"ready"');
    expect(response.text).toContain('"type":"stream.gap"');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes a Conversation subscription created after the HTTP client disconnects', async () => {
    const h = runtime();
    h.value.conversation!.open = vi.fn();
    const pending = deferred<ConversationLiveSubscription>();
    const close = vi.fn();
    let subscribed = false;
    const subscribe = vi.spyOn(ConversationLiveHub.prototype, 'subscribe').mockImplementation(() => {
      subscribed = true;
      return pending.promise;
    });
    const subscription: ConversationLiveSubscription = {
      checkpoint: { viewId: 'view-1', historyVersion: 'history-1', streamSequence: 0 },
      close,
      async *[Symbol.asyncIterator]() {},
    };
    try {
      const query = new URLSearchParams(h.lease.ref).toString();
      await expectClosedPendingLiveRequest({
        runtime: h.value,
        path: `/agents/conversation/live?${query}`,
        subscribed: () => subscribed,
        release: () => pending.resolve(subscription),
        close,
      });
    } finally {
      subscribe.mockRestore();
    }
  });

  it('gates Interaction responses on the current run and forwards only normalized Core data', async () => {
    const h = runtime();
    const interaction = {
      respond: vi.fn(async () => ({ status: 'accepted' })),
    } as unknown as Parameters<typeof agentRoutes>[0]['runtime']['interaction'];
    const value = { ...h.value, interaction };
    const requestBody = {
      run: h.lease.ref,
      request: {
        interactionId: 'interaction-1', resolutionToken: 'resolution-1',
        value: { type: 'approval', optionId: 'allow' },
      },
    };
    await request(app(value)).post('/agents/interaction/respond').send(requestBody)
      .expect(200, { status: 'accepted' });
    expect(interaction!.respond).toHaveBeenCalledWith(h.lease, requestBody.request);
    await request(app(value)).post('/agents/interaction/respond').send({
      ...requestBody, run: { ...h.lease.ref, runId: 'stale' },
    }).expect(409, { error: 'stale agent run' });

    interaction!.respond = vi.fn(async () => ({ status: 'stale_run' as const }));
    await request(app(value)).post('/agents/interaction/respond').send(requestBody)
      .expect(409, { status: 'stale_run' });
  });

  it('streams an Interaction revision and pending baseline through one app subscription', async () => {
    const h = runtime();
    const close = vi.fn();
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const interaction = {
      open: vi.fn(async (_lease, sink) => {
        setTimeout(() => {
          void Promise.resolve(sink({
            type: 'cancelled', revision: 1,
            interactionId: 'interaction-1', reason: 'stale_run',
          })).then(() => {
            h.abort.abort();
            resolveClosed();
          });
        }, 0);
        return {
          revision: 0,
          pending: [{
            id: 'interaction-1', runId: 'run-1', type: 'approval', prompt: 'Allow?',
            options: [{ id: 'allow', label: 'Allow' }], resolutionToken: 'resolution-1',
          }],
          closed,
          close,
        };
      }),
    } as unknown as Parameters<typeof agentRoutes>[0]['runtime']['interaction'];
    const response = await request(app({ ...h.value, interaction }))
      .get('/agents/interaction/live').query(h.lease.ref)
      .expect(200).expect('Content-Type', /text\/event-stream/);
    expect(response.text).toContain('"type":"ready"');
    expect(response.text).toContain('"resolutionToken":"resolution-1"');
    expect(response.text).toContain('"type":"cancelled"');
    expect(response.text).not.toContain('native');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes an Interaction subscription created after the HTTP client disconnects', async () => {
    const h = runtime();
    const pending = deferred<InteractionLiveSubscription>();
    const close = vi.fn();
    let subscribed = false;
    const subscribe = vi.spyOn(InteractionLiveHub.prototype, 'subscribe').mockImplementation(() => {
      subscribed = true;
      return pending.promise;
    });
    const subscription: InteractionLiveSubscription = {
      checkpoint: { epoch: 'epoch-1', revision: 0, pending: [] },
      close,
      async *[Symbol.asyncIterator]() {},
    };
    try {
      const query = new URLSearchParams(h.lease.ref).toString();
      await expectClosedPendingLiveRequest({
        runtime: {
          ...h.value,
          interaction: { open: vi.fn(), respond: vi.fn() },
        } as unknown as typeof h.value,
        path: `/agents/interaction/live?${query}`,
        subscribed: () => subscribed,
        release: () => pending.resolve(subscription),
        close,
      });
    } finally {
      subscribe.mockRestore();
    }
  });
});


describe('scheduled message facade vertical slice', () => {
  it('persists shared API tasks and submits after all clients disconnect', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z');
    const h = runtime();
    const store = new MemoryScheduledStore();
    const delivered: string[] = [];
    const scheduler = new ScheduledMessagesService({ store, timeZone: 'UTC', now: () => now, deliver: async (_target, text) => { delivered.push(text); return { status: 'queued' }; } });
    Object.assign(h.value, { scheduledMessages: scheduler });
    h.value.scheduledTarget = async () => ({ agentId: 'pi', sessionId: 'session-1', paneId: '%1', tmuxSession: 'work' });
    const client = app(h.value);
    const created = await request(client).post('/agents/scheduled-messages').send({ action: 'create', tmuxSession: 'work', paneId: '%1', run: h.lease.ref, request: { text: 'offline hello', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }] } });
    expect(created.status).toBe(200);
    now += 60000;
    await scheduler.tick(); // no SSE, browser or HTTP request drives this execution
    expect(delivered).toEqual(['offline hello']);
    const otherClient = await request(client).post('/agents/scheduled-messages').send({ action: 'snapshot', tmuxSession: 'work', paneId: '%1' });
    expect(otherClient.body.tasks[0]).toMatchObject({ state: 'ended', lastResult: 'submitted' });
    const stale = await request(client).post('/agents/scheduled-messages').send({ action: 'delete', tmuxSession: 'work', paneId: '%1', id: created.body.id, revision: created.body.revision });
    expect(stale.status).toBe(409);
    h.value.scheduledTarget = async () => { throw Error('target gone'); };
    const withoutRun = await request(client).post('/agents/scheduled-messages').send({ action: 'snapshot', tmuxSession: 'work', paneId: '%1' });
    expect(withoutRun.status).toBe(200);
    expect((await request(client).post('/agents/scheduled-messages').send({ action: 'delete', tmuxSession: 'work', paneId: '%1', id: created.body.id, revision: withoutRun.body.tasks[0].revision })).status).toBe(200);
  });
});

describe('scheduled facade pane scope', () => {
  it('requires an explicit pane, rejects create target mismatch, and denies cross-pane management without a live run', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z'); const h = runtime();
    const service = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now, deliver: async () => ({ status: 'queued' }) });
    Object.assign(h.value, { scheduledMessages: service });
    h.value.scheduledTarget = async () => ({ agentId: 'pi', sessionId: 'session-1', paneId: '%1', tmuxSession: 'work' });
    const client = app(h.value); const scope = { tmuxSession: 'work', paneId: '%1' }; const other = { ...scope, paneId: '%2' };
    const rule = { text: 'scoped', frequency: 'hourly', slots: [{ minute: 1 }], endsAt: '2026-10-21T00:00:00Z' };
    for (const action of ['snapshot', 'create', 'update', 'delete', 'exception']) expect((await request(client).post('/agents/scheduled-messages').send({ action, tmuxSession: 'work', run: h.lease.ref, request: rule })).status).toBe(400);
    expect((await request(client).post('/agents/scheduled-messages').send({ action: 'preview', request: rule })).status).toBe(200);
    expect((await request(client).post('/agents/scheduled-messages').send({ action: 'create', ...other, run: h.lease.ref, request: rule })).status).toBe(409);
    const created = await request(client).post('/agents/scheduled-messages').send({ action: 'create', ...scope, run: h.lease.ref, request: rule }); expect(created.status).toBe(200);
    expect((await request(client).post('/agents/scheduled-messages').send({ action: 'snapshot', ...other })).body.tasks).toEqual([]);
    for (const action of ['update', 'delete']) {
      const result = await request(client).post('/agents/scheduled-messages').send({ action, ...other, id: created.body.id, revision: created.body.revision, request: { enabled: false } });
      expect(result.status).toBe(404);
    }
    now += 12 * 60000; await service.tick();
    const snapshot = await request(client).post('/agents/scheduled-messages').send({ action: 'snapshot', ...scope }); const exception = snapshot.body.exceptions[0];
    expect((await request(client).post('/agents/scheduled-messages').send({ action: 'snapshot', ...other })).body.exceptions).toEqual([]);
    for (const action of ['discard', 'reschedule']) expect((await request(client).post('/agents/scheduled-messages').send({ action: 'exception', ...other, id: exception.id, revision: exception.revision, request: { action, rule: { frequency: 'once', slots: [{ date: '2026-10-21', time: '00:01' }] } } })).status).toBe(409);
    h.value.scheduledTarget = async () => { throw Error('no live run'); };
    expect((await request(client).post('/agents/scheduled-messages').send({ action: 'update', ...scope, id: snapshot.body.tasks[0].id, revision: snapshot.body.tasks[0].revision, request: { enabled: false } })).status).toBe(200);
  });
});

describe('scheduled manual trigger facade', () => {
  it('submits the existing scoped task, uses revision protection and reports delivery rejection', async () => {
    const h = runtime(); const scope = { tmuxSession: 'work', paneId: '%1' }; let outcome = 'queued'; let sends = 0;
    const scheduler = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => Date.parse('2026-10-20T00:00:00Z'), deliver: async () => { sends++; return outcome === 'queued' ? { status: outcome } : { status: 'rejected', reason: 'queue_full' }; } });
    Object.assign(h.value, { scheduledMessages: scheduler }); h.value.scheduledTarget = async () => { throw Error('must use persisted target'); };
    const target = { ...scope, agentId: 'pi', sessionId: 'original' };
    const task = scheduler.create(target, { text: 'manual', frequency: 'once', slots: [{ date: '2026-10-21', time: '09:00' }] });
    const client = app(h.value);
    const cross = await request(client).post('/agents/scheduled-messages').send({ ...scope, paneId: '%2', action: 'trigger', id: task.id, revision: task.revision }); expect(cross.status).toBe(404); expect(sends).toBe(0);
    const sent = await request(client).post('/agents/scheduled-messages').send({ ...scope, action: 'trigger', id: task.id, revision: task.revision }); expect(sent.status).toBe(200); expect(sent.body.status).toBe('submitted'); expect(scheduler.snapshot(scope).tasks[0]!.state).toBe('ended');
    expect((await request(client).post('/agents/scheduled-messages').send({ ...scope, action: 'trigger', id: task.id, revision: task.revision })).status).toBe(409); expect(sends).toBe(1);
    const other = scheduler.create(target, { text: 'failed', frequency: 'once', slots: [{ date: '2026-10-21', time: '09:00' }] }); outcome = 'full';
    const rejected = await request(client).post('/agents/scheduled-messages').send({ ...scope, action: 'trigger', id: other.id, revision: other.revision }); expect(rejected.status).toBe(409); expect(rejected.body.error).toMatch(/Queue is full/);
    expect(scheduler.snapshot(scope).tasks.find(task => task.id === other.id)!.state).toBe('active'); await scheduler.close();
  });
});

it('terminates a persisted scoped task without a live run, shares its ended reason and rejects stale or cross-pane mutation', async () => {
  const h = runtime(); const scope = { tmuxSession: 'work', paneId: '%1' };
  const scheduler = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => Date.parse('2026-10-20T00:00:00Z'), deliver: async () => ({ status: 'queued' }) });
  Object.assign(h.value, { scheduledMessages: scheduler }); h.value.scheduledTarget = async () => { throw Error('must not need a run'); };
  const task = scheduler.create({ ...scope, agentId: 'pi', sessionId: 'original' }, { text: 'stop', frequency: 'hourly', slots: [{ minute: 5 }], endsAt: '2026-10-21T00:00:00Z' });
  const client = app(h.value);
  expect((await request(client).post('/agents/scheduled-messages').send({ action: 'terminate', ...scope, paneId: '%2', id: task.id, revision: task.revision })).status).toBe(404);
  expect((await request(client).post('/agents/scheduled-messages').send({ action: 'terminate', ...scope, id: task.id, revision: task.revision + 1 })).status).toBe(409);
  const result = await request(client).post('/agents/scheduled-messages').send({ action: 'terminate', ...scope, id: task.id, revision: task.revision });
  expect(result.status).toBe(200); expect(result.body).toMatchObject({ state: 'ended', endedReason: 'terminated', enabled: false, nextAt: null });
  const otherClient = await request(client).post('/agents/scheduled-messages').send({ action: 'snapshot', ...scope });
  expect(otherClient.body.tasks[0]).toMatchObject(result.body);
  for (const action of ['trigger', 'update']) expect((await request(client).post('/agents/scheduled-messages').send({ action, ...scope, id: task.id, revision: result.body.revision, request: { enabled: true } })).status).toBe(409);
  await scheduler.close();
});

it('rejects resume for expired paused once tasks while preserving explicit send-now', async () => {
  const h = runtime(); const scope = { tmuxSession: 'work', paneId: '%1' }; let now = Date.parse('2026-10-20T00:00:00Z'); let sends = 0;
  const scheduler = new ScheduledMessagesService({ store: new MemoryScheduledStore(), timeZone: 'UTC', now: () => now, deliver: async () => { sends++; return { status: 'queued' }; } });
  Object.assign(h.value, { scheduledMessages: scheduler }); h.value.scheduledTarget = async () => { throw Error('uses stored target'); };
  const task = scheduler.create({ ...scope, agentId: 'pi', sessionId: 'original' }, { text: 'paused', frequency: 'once', slots: [{ date: '2026-10-20', time: '00:01' }] });
  const paused = scheduler.update(scope, task.id, task.revision, { enabled: false }); now += 120000;
  const client = app(h.value);
  const resumed = await request(client).post('/agents/scheduled-messages').send({ action: 'update', ...scope, id: task.id, revision: paused.revision, request: { enabled: true } });
  expect(resumed.status).toBe(409); expect(resumed.body.error).toMatch(/expired.*future/i);
  const snapshot = await request(client).post('/agents/scheduled-messages').send({ action: 'snapshot', ...scope });
  expect(snapshot.body.tasks[0]).toMatchObject({ state: 'active', enabled: false, expired: true, revision: paused.revision });
  expect(snapshot.body.tasks[0].endedAt).toBeUndefined(); expect(snapshot.body.tasks[0].lastResult).toBeUndefined();
  const sent = await request(client).post('/agents/scheduled-messages').send({ action: 'trigger', ...scope, id: task.id, revision: paused.revision });
  expect(sent.status).toBe(200); expect(sends).toBe(1); await scheduler.close();
});
