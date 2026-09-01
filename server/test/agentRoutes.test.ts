import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ConversationContractError } from '../src/agent-runtime/conversation.js';
import { ConversationActivationError } from '../src/agent-runtime/conversationActivation.js';
import { ConversationControlError } from '../src/agent-runtime/conversationControls.js';
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
    expect(activate).toHaveBeenCalledWith(h.lease, expect.any(AbortSignal));

    await request(app(supported)).post('/agents/conversation-activation').send({
      run: { ...h.lease.ref, runId: 'stale' },
    }).expect(409, { error: 'stale agent run', code: 'stale_run' });
    activate.mockRejectedValueOnce(new ConversationActivationError(
      'Conversation activation could not finish; continue in the terminal or try again', 'unavailable',
    ));
    const failure = await request(app(supported)).post('/agents/conversation-activation')
      .send({ run: h.lease.ref }).expect(503);
    expect(failure.body).toEqual({
      error: 'Conversation activation could not finish; continue in the terminal or try again',
      code: 'unavailable',
    });
    expect(JSON.stringify(failure.body)).not.toContain('/Users/private');
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
      checkpoint: { revision: 0, pending: [] },
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
