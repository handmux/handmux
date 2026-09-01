import express from 'express';
import { ConversationContractError } from '../agent-runtime/conversation.js';
import { ConversationActivationError } from '../agent-runtime/conversationActivation.js';
import { ConversationControlError } from '../agent-runtime/conversationControls.js';
import {
  ConversationLiveHub,
  ConversationLiveHubError,
} from '../agent-runtime/conversationLiveHub.js';
import { InteractionContractError } from '../agent-runtime/interaction.js';
import {
  InteractionLiveHub,
  InteractionLiveHubError,
} from '../agent-runtime/interactionLiveHub.js';
import type { AgentRuntime } from '../agent-runtime/runtime.js';
import { AgentResourceError } from '../agent-runtime/resources.js';
import { SessionControlContractError } from '../agent-runtime/sessionControl.js';
import type { AgentRunRef, AgentSessionRef } from '../agent-runtime/run.js';
import type {
  ConversationPageRequest,
  ConversationSendRequest,
} from '../agent-runtime/conversationTypes.js';
import type { InteractionResponse } from '../agent-runtime/interactionTypes.js';

type AgentFacadeRuntime = Pick<
  AgentRuntime,
  'capabilities' | 'health' | 'activeRuns' | 'inbox' | 'conversation' | 'interaction'
  | 'conversationActivation' | 'conversationControls' | 'sessionControl' | 'subscriptionUsage'
  | 'resources' | 'runs'
>;

const RESOURCE_ID_RE = /^[a-zA-Z0-9_-]{16,256}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function notificationIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256
    || value.some((item) => !text(item, 256))) return null;
  return value as string[];
}

function session(value: unknown): AgentSessionRef | null {
  const item = record(value);
  return item && text(item.agentId, 64) && text(item.sessionId, 1024)
    ? { agentId: item.agentId, sessionId: item.sessionId } : null;
}

function run(value: unknown): AgentRunRef | null {
  const item = record(value);
  if (!item || !text(item.agentId, 64) || !text(item.paneId, 256) || !text(item.runId, 256)
    || (item.sessionId !== undefined && !text(item.sessionId, 1024))) return null;
  return {
    agentId: item.agentId,
    paneId: item.paneId,
    runId: item.runId,
    ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId as string }),
  };
}

// Auth is applied by the parent /api router. This is Handmux's own app facade, not a public Connector
// protocol: it exposes normalized Core objects and never socket paths, credentials, native payloads, or wire.
export function agentRoutes({ runtime }: { runtime: AgentFacadeRuntime }): express.Router {
  const router = express.Router();
  let conversationLive: ConversationLiveHub | undefined;
  let interactionLive: InteractionLiveHub | undefined;

  router.get('/agents/capabilities', (_req, res) => res.json({
    adapters: runtime.capabilities(),
    health: runtime.health(),
    runs: runtime.activeRuns(),
  }));

  router.get('/agents/inbox', (_req, res) => res.json(runtime.inbox.read()));

  router.get('/agents/usage', async (req, res, next) => {
    if (!runtime.subscriptionUsage) {
      return res.status(503).json({ error: 'subscription usage unsupported', code: 'unsupported' });
    }
    const refresh = req.query.refresh;
    if (refresh !== undefined && refresh !== 'true' && refresh !== 'false') {
      return res.status(400).json({ error: 'invalid subscription usage refresh' });
    }
    const target = req.query.target;
    if (target !== undefined && (typeof target !== 'string' || refresh !== 'true'
      || !/^[a-z][a-z0-9._-]{0,127}$/.test(target))) {
      return res.status(400).json({ error: 'invalid subscription usage target' });
    }
    try {
      return res.json({ agents: await runtime.subscriptionUsage.snapshots({
        refresh: refresh === 'true',
        ...(target === undefined ? {} : { targetAgentId: target }),
      }) });
    }
    catch (error) {
      if (error instanceof RangeError && target !== undefined) {
        return res.status(400).json({ error: 'invalid subscription usage target' });
      }
      return next(error);
    }
  });

  router.get('/agents/session-control/model', async (req, res, next) => {
    try {
      if (!runtime.sessionControl) {
        return res.status(503).json({ error: 'session control unsupported', code: 'unsupported' });
      }
      const ref = run(req.query);
      const lease = ref ? runtime.runs.resolve(ref) : null;
      if (!ref || !lease) return res.status(ref ? 409 : 400).json({
        error: ref ? 'stale agent run' : 'invalid agent run',
      });
      const refresh = req.query.refresh;
      if (refresh !== undefined && refresh !== 'true' && refresh !== 'false') {
        return res.status(400).json({ error: 'invalid session control refresh' });
      }
      const control = await runtime.sessionControl.readModelControl(lease, {
        refresh: refresh === 'true',
      });
      return res.json({ control });
    } catch (error) {
      if (error instanceof SessionControlContractError && error.code === 'unsupported') {
        return res.status(409).json({ error: 'session control unsupported', code: 'unsupported' });
      }
      return next(error);
    }
  });

  router.patch('/agents/session-control/model', async (req, res, next) => {
    try {
      if (!runtime.sessionControl) {
        return res.status(503).json({ error: 'session control unsupported', code: 'unsupported' });
      }
      const ref = run(req.body?.run);
      const lease = ref ? runtime.runs.resolve(ref) : null;
      const patch = record(req.body?.patch);
      if (!ref || !lease || !patch) return res.status(ref && patch ? 409 : 400).json({
        error: ref && patch ? 'stale agent run' : 'invalid session control update',
      });
      return res.json({
        control: await runtime.sessionControl.updateModelControl(lease, patch),
      });
    } catch (error) {
      if (error instanceof SessionControlContractError) {
        if (error.code === 'invalid_request') {
          return res.status(400).json({ error: 'invalid session control update' });
        }
        if (error.code === 'unsupported') {
          return res.status(409).json({ error: 'session control unsupported', code: 'unsupported' });
        }
      }
      return next(error);
    }
  });

  router.post('/agents/inbox/notifications/read', async (req, res, next) => {
    const ids = notificationIds(req.body?.notificationIds);
    if (!ids) return res.status(400).json({ error: 'invalid terminal notification ids' });
    try { return res.json(await runtime.inbox.markTerminalRead(ids)); }
    catch (error) { return next(error); }
  });

  const controlRun = (value: unknown) => {
    const ref = run(value);
    return { ref, lease: ref ? runtime.runs.resolve(ref) : null };
  };
  const controlError = (error: unknown, res: express.Response): boolean => {
    if (!(error instanceof ConversationControlError)) return false;
    const status = error.code === 'invalid_request' ? 400
      : error.code === 'unsupported' ? 409 : 502;
    res.status(status).json({ error: error.message, code: error.code });
    return true;
  };

  const activationError = (error: unknown, res: express.Response): boolean => {
    if (!(error instanceof ConversationActivationError)) return false;
    const status = error.code === 'unsupported' ? 409
      : error.code === 'in_progress' ? 409
        : error.code === 'contract_violation' ? 502 : 503;
    res.status(status).json({ error: error.message, code: error.code });
    return true;
  };

  router.get('/agents/conversation-activation', async (req, res, next) => {
    try {
      if (!runtime.conversationActivation) {
        return res.status(409).json({ error: 'conversation activation unsupported', code: 'unsupported' });
      }
      const { ref, lease } = controlRun(req.query);
      if (!ref || !lease) return res.status(ref ? 409 : 400).json({
        error: ref ? 'stale agent run' : 'invalid agent run',
        ...(ref ? { code: 'stale_run' } : {}),
      });
      return res.json({ descriptor: await runtime.conversationActivation.describe(lease) });
    } catch (error) {
      if (activationError(error, res)) return;
      return next(error);
    }
  });

  router.post('/agents/conversation-activation', async (req, res, next) => {
    try {
      if (!runtime.conversationActivation) {
        return res.status(409).json({ error: 'conversation activation unsupported', code: 'unsupported' });
      }
      const { ref, lease } = controlRun(req.body?.run);
      if (!ref || !lease) return res.status(ref ? 409 : 400).json({
        error: ref ? 'stale agent run' : 'invalid agent run',
        ...(ref ? { code: 'stale_run' } : {}),
      });
      const operation = new AbortController();
      const cancel = (): void => {
        if (!res.writableEnded) operation.abort(new Error('Activation request disconnected'));
      };
      req.once('aborted', cancel);
      res.once('close', cancel);
      try { await runtime.conversationActivation.activate(lease, operation.signal); }
      finally {
        req.removeListener('aborted', cancel);
        res.removeListener('close', cancel);
      }
      return res.status(202).json({ accepted: true });
    } catch (error) {
      if (activationError(error, res)) return;
      return next(error);
    }
  });

  router.get('/agents/conversation-controls', async (req, res, next) => {
    try {
      if (!runtime.conversationControls && !runtime.conversation) {
        return res.status(409).json({ error: 'conversation controls unsupported', code: 'unsupported' });
      }
      const { ref, lease } = controlRun(req.query);
      if (!ref || !lease) return res.status(ref ? 409 : 400).json({
        error: ref ? 'stale agent run' : 'invalid agent run',
      });
      let controls = {};
      if (runtime.conversationControls) {
        try { controls = await runtime.conversationControls.read(lease); }
        catch (error) {
          // Queue is a public Conversation capability. An Agent without optional Goal/Plan/Context
          // controls must still reach the shared Queue snapshot; every other control failure remains fatal.
          if (!(runtime.conversation && error instanceof ConversationControlError
            && error.code === 'unsupported')) throw error;
        }
      }
      const queue = runtime.conversation ? await runtime.conversation.queueSnapshot(lease) : undefined;
      return res.json({ controls: { ...controls, ...(queue ? { queue, submissions: queue.submissions } : {}) } });
    } catch (error) {
      if (controlError(error, res)) return;
      return next(error);
    }
  });

  router.post('/agents/conversation-queue/action', async (req, res, next) => {
    try {
      if (!runtime.conversation) throw new ConversationControlError(
        'Conversation queue unsupported', 'unsupported',
      );
      const { ref, lease } = controlRun(req.body?.run);
      const request = record(req.body?.request);
      if (!ref || !lease || !request) return res.status(ref && request ? 409 : 400).json({
        error: ref && request ? 'stale agent run' : 'invalid conversation queue action',
      });
      return res.json(await runtime.conversation.queueAction(lease, request));
    } catch (error) {
      if (controlError(error, res)) return;
      return next(error);
    }
  });

  router.post('/agents/conversation-goal/action', async (req, res, next) => {
    try {
      if (!runtime.conversationControls) throw new ConversationControlError(
        'Conversation goal unsupported', 'unsupported',
      );
      const { ref, lease } = controlRun(req.body?.run);
      const request = record(req.body?.request);
      if (!ref || !lease || !request) return res.status(ref && request ? 409 : 400).json({
        error: ref && request ? 'stale agent run' : 'invalid conversation goal action',
      });
      return res.json({ goal: await runtime.conversationControls.goalAction(lease, request) });
    } catch (error) {
      if (controlError(error, res)) return;
      return next(error);
    }
  });

  router.post('/agents/conversation-permission/action', async (req, res, next) => {
    try {
      if (!runtime.conversationControls) throw new ConversationControlError(
        'Conversation permission unsupported', 'unsupported',
      );
      const { ref, lease } = controlRun(req.body?.run);
      const request = record(req.body?.request);
      if (!ref || !lease || !request) return res.status(ref && request ? 409 : 400).json({
        error: ref && request ? 'stale agent run' : 'invalid conversation permission action',
      });
      return res.json({ permission: await runtime.conversationControls.permissionAction(lease, request) });
    } catch (error) {
      if (controlError(error, res)) return;
      return next(error);
    }
  });

  router.post('/agents/conversation-command', async (req, res, next) => {
    try {
      if (!runtime.conversationControls) throw new ConversationControlError(
        'Conversation command unsupported', 'unsupported',
      );
      const { ref, lease } = controlRun(req.body?.run);
      if (!ref || !lease) return res.status(ref ? 409 : 400).json({
        error: ref ? 'stale agent run' : 'invalid agent run',
      });
      await runtime.conversationControls.command(lease, req.body?.command);
      return res.json({ ok: true });
    } catch (error) {
      if (controlError(error, res)) return;
      return next(error);
    }
  });

  router.post('/agents/conversation/discover', async (req, res, next) => {
    try {
      if (!runtime.conversation) return res.status(409).json({ error: 'conversation unsupported' });
      const ref = run(req.body?.target);
      const lease = ref ? runtime.runs.resolve(ref) : null;
      if (ref && !lease) return res.status(409).json({ error: 'stale agent run' });
      const target = lease?.ref ?? session(req.body?.target);
      if (!target) return res.status(400).json({ error: 'invalid agent target' });
      return res.json({ descriptor: await runtime.conversation.discover(target) });
    } catch (error) { return next(error); }
  });

  router.post('/agents/conversation/page', async (req, res, next) => {
    try {
      if (!runtime.conversation) return res.status(409).json({ error: 'conversation unsupported' });
      const ref = run(req.body?.run);
      const lease = ref ? runtime.runs.resolve(ref) : null;
      if (ref && !lease) return res.status(409).json({ error: 'stale agent run' });
      const target = lease?.ref ?? session(req.body?.session);
      const request = record(req.body?.request);
      if (!target || !request) return res.status(400).json({ error: 'invalid conversation page request' });
      return res.json(await runtime.conversation.readPage(
        target,
        request as unknown as ConversationPageRequest,
      ));
    } catch (error) {
      if (error instanceof ConversationContractError) {
        if (error.code === 'invalid_request') {
          return res.status(400).json({ error: 'invalid conversation page request' });
        }
        // Page cursors and view epochs are intentionally process-local. A Server restart or a concurrent
        // history change is a recoverable rebase signal for the client, not an internal error/log storm.
        if (error.code === 'page_stale') {
          return res.status(409).json({ error: 'conversation page stale' });
        }
        if (error.code === 'session_unavailable') {
          res.set('Retry-After', '1');
          return res.status(503).json({
            error: 'conversation session unavailable',
            code: 'conversation_session_unavailable',
          });
        }
      }
      return next(error);
    }
  });

  router.get('/agents/conversation/resource', async (req, res, next) => {
    const owner = session(req.query);
    const resourceId = typeof req.query.resourceId === 'string' ? req.query.resourceId : '';
    if (!owner || !RESOURCE_ID_RE.test(resourceId)) {
      return res.status(400).json({ error: 'invalid conversation resource request' });
    }
    try {
      const content = await runtime.resources.read(owner, resourceId);
      // Owner mismatch, expiry, revocation, and an unknown opaque ID are deliberately indistinguishable.
      if (!content) return res.status(404).json({ error: 'conversation resource unavailable' });
      res.set({
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': String(content.size),
      });
      res.attachment(content.name ?? 'agent-resource');
      res.type(content.mediaType);
      return res.status(200).send(Buffer.from(content.data));
    } catch (error) {
      if (error instanceof AgentResourceError && error.code === 'resource-changed') {
        return res.status(404).json({ error: 'conversation resource unavailable' });
      }
      return next(error);
    }
  });

  router.post('/agents/conversation/send', async (req, res, next) => {
    try {
      if (!runtime.conversation) return res.status(409).json({ error: 'conversation unsupported' });
      const ref = run(req.body?.run);
      const lease = ref ? runtime.runs.resolve(ref) : null;
      const request = record(req.body?.request);
      if (!ref || !lease || !request) return res.status(ref && request ? 409 : 400).json({
        error: ref && request ? 'stale agent run' : 'invalid conversation send request',
      });
      return res.json(await runtime.conversation.send(
        lease,
        request as unknown as ConversationSendRequest,
      ));
    } catch (error) { return next(error); }
  });

  router.post('/agents/conversation/submission/query', (req, res, next) => {
    try {
      if (!runtime.conversation) return res.status(409).json({ error: 'conversation unsupported' });
      const ref = run(req.body?.run);
      const lease = ref ? runtime.runs.resolve(ref) : null;
      const submissionId = req.body?.submissionId;
      const actionId = req.body?.actionId;
      if (!ref || !lease || !text(submissionId, 256)
        || (actionId !== undefined && !text(actionId, 256))) {
        return res.status(ref && submissionId ? 409 : 400).json({
          error: ref && submissionId ? 'stale agent run' : 'invalid conversation submission query',
        });
      }
      return res.json(runtime.conversation.querySubmission(lease, submissionId, actionId));
    } catch (error) { return next(error); }
  });

  router.post('/agents/conversation/interrupt', async (req, res, next) => {
    try {
      if (!runtime.conversation) return res.status(409).json({ error: 'conversation unsupported' });
      const ref = run(req.body?.run);
      const lease = ref ? runtime.runs.resolve(ref) : null;
      if (!ref || !lease) return res.status(ref ? 409 : 400).json({
        error: ref ? 'stale agent run' : 'invalid agent run',
      });
      return res.json(await runtime.conversation.interrupt(lease));
    } catch (error) { return next(error); }
  });

  router.get('/agents/conversation/live', async (req, res, next) => {
    let subscription: Awaited<ReturnType<ConversationLiveHub['subscribe']>> | undefined;
    let keepalive: NodeJS.Timeout | undefined;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (keepalive) clearInterval(keepalive);
      subscription?.close();
    };
    req.once('aborted', close);
    res.once('close', close);
    try {
      if (!runtime.conversation) return res.status(409).json({ error: 'conversation unsupported' });
      conversationLive ??= new ConversationLiveHub({ conversation: runtime.conversation });
      const ref = run(req.query);
      const lease = ref ? runtime.runs.resolve(ref) : null;
      if (!ref || !lease) return res.status(ref ? 409 : 400).json({
        error: ref ? 'stale agent run' : 'invalid agent run',
      });
      const expectedViewId = typeof req.query.expectedViewId === 'string'
        ? req.query.expectedViewId : undefined;
      if (expectedViewId !== undefined && !text(expectedViewId, 1024)) {
        return res.status(400).json({ error: 'invalid conversation view' });
      }
      subscription = await conversationLive.subscribe(lease, {
        ...(expectedViewId === undefined ? {} : { expectedViewId }),
      });
      if (closed) {
        subscription.close();
        return;
      }
      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({ type: 'ready', checkpoint: subscription.checkpoint })}\n\n`);
      keepalive = setInterval(() => {
        if (!closed) res.write(`: keepalive ${Date.now()}\n\n`);
      }, 20_000);
      keepalive.unref?.();
      for await (const event of subscription) {
        if (closed) break;
        const writable = res.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`);
        if (!writable) {
          await new Promise<void>((resolve) => {
            const done = (): void => {
              res.off('drain', done);
              res.off('close', done);
              resolve();
            };
            res.once('drain', done);
            res.once('close', done);
          });
        }
      }
      close();
      return res.end();
    } catch (error) {
      close();
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'conversation live stream unavailable' })}\n\n`);
        return res.end();
      }
      if (error instanceof ConversationLiveHubError || error instanceof ConversationContractError) {
        return res.status(409).json({ error: 'conversation live stream unavailable' });
      }
      return next(error);
    }
  });

  router.post('/agents/interaction/respond', async (req, res, next) => {
    try {
      if (!runtime.interaction) return res.status(409).json({ error: 'interaction unsupported' });
      const ref = run(req.body?.run);
      const lease = ref ? runtime.runs.resolve(ref) : null;
      const request = record(req.body?.request);
      if (!ref || !lease || !request) return res.status(ref && request ? 409 : 400).json({
        error: ref && request ? 'stale agent run' : 'invalid interaction response',
      });
      const result = await runtime.interaction.respond(
        lease,
        request as unknown as InteractionResponse,
      );
      return res.status(result.status === 'stale_run' ? 409 : 200).json(result);
    } catch (error) {
      if (error instanceof InteractionContractError) {
        return res.status(409).json({
          error: 'interaction response unavailable', code: 'interaction_unavailable',
        });
      }
      return next(error);
    }
  });

  router.get('/agents/interaction/live', async (req, res, next) => {
    let subscription: Awaited<ReturnType<InteractionLiveHub['subscribe']>> | undefined;
    let keepalive: NodeJS.Timeout | undefined;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (keepalive) clearInterval(keepalive);
      subscription?.close();
    };
    req.once('aborted', close);
    res.once('close', close);
    try {
      if (!runtime.interaction) return res.status(409).json({ error: 'interaction unsupported' });
      interactionLive ??= new InteractionLiveHub({ interaction: runtime.interaction });
      const ref = run(req.query);
      const lease = ref ? runtime.runs.resolve(ref) : null;
      if (!ref || !lease) return res.status(ref ? 409 : 400).json({
        error: ref ? 'stale agent run' : 'invalid agent run',
      });
      subscription = await interactionLive.subscribe(lease);
      if (closed) {
        subscription.close();
        return;
      }
      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({ type: 'ready', checkpoint: subscription.checkpoint })}\n\n`);
      keepalive = setInterval(() => {
        if (!closed) res.write(`: keepalive ${Date.now()}\n\n`);
      }, 20_000);
      keepalive.unref?.();
      for await (const event of subscription) {
        if (closed) break;
        const writable = res.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`);
        if (!writable) {
          await new Promise<void>((resolve) => {
            const done = (): void => {
              res.off('drain', done);
              res.off('close', done);
              resolve();
            };
            res.once('drain', done);
            res.once('close', done);
          });
        }
      }
      close();
      return res.end();
    } catch (error) {
      close();
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'interaction live stream unavailable' })}\n\n`);
        return res.end();
      }
      if (error instanceof InteractionLiveHubError || error instanceof InteractionContractError) {
        return res.status(409).json({ error: 'interaction live stream unavailable' });
      }
      return next(error);
    }
  });

  return router;
}
