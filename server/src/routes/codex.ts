import express from 'express';
import { isPaneId } from '../tmux/commands.js';
import { getAgent } from '../agents/index.js';
import { codexExitSessionId } from '../agents/codex.js';
import { parseCodexStreamEvent } from '../codexStreamProtocol.js';
import type { Response } from 'express';
import type { CodexStreamEvent } from '../codexStreamProtocol.js';

export interface CodexRouteApp {
  discover(pane: string): Promise<{ managed: boolean; threadId?: string | null } | null>;
  status(pane: string, threadId: string): Promise<unknown>;
  subscribe(
    pane: string,
    threadId: string,
    listener: (event: CodexStreamEvent) => void,
    afterSequence?: number | null,
  ): Promise<() => void>;
  send(pane: string, threadId: string, text: string, requestId: string | null): Promise<unknown>;
  steerQueued(pane: string, threadId: string, id: string): Promise<unknown>;
  removeQueued(pane: string, threadId: string, id: string): Promise<unknown>;
  beginQueuedEdit(pane: string, threadId: string, id: string): Promise<unknown>;
  renewQueuedEdit(pane: string, threadId: string, id: string, token: string): Promise<unknown>;
  commitQueuedEdit(pane: string, threadId: string, id: string, token: string, text: string): Promise<unknown>;
  cancelQueuedEdit(pane: string, threadId: string, id: string, token: string): Promise<unknown>;
  compact(pane: string, threadId: string): Promise<unknown>;
  models(pane: string, threadId: string): Promise<unknown>;
  getGoal(pane: string, threadId: string): Promise<unknown>;
  updateGoal(pane: string, threadId: string, updates: Record<string, unknown>): Promise<unknown>;
  clearGoal(pane: string, threadId: string): Promise<unknown>;
  updateSettings(pane: string, threadId: string, updates: Record<string, unknown>): Promise<unknown>;
  interrupt(pane: string, threadId: string): Promise<unknown>;
  decide(pane: string, threadId: string, requestId: string | number, decision: string): Promise<unknown>;
  answerInput(
    pane: string,
    threadId: string,
    requestId: string | number,
    answers: Record<string, string[]>,
  ): Promise<unknown>;
}
export interface CodexRouteCommands {
  listLivePanes?(): Promise<unknown>;
  sendKey?(pane: string, key: string): Promise<unknown>;
  capturePlain?(pane: string): Promise<string>;
  runPaneCommand?(pane: string, command: string): Promise<unknown>;
  exitCopyModeIfActive?(pane: string): Promise<unknown>;
  sendText?(pane: string, text: string): Promise<unknown>;
  sendEnter?(pane: string): Promise<unknown>;
}
export interface CodexRouteClaudeEvents {
  identifyPaneAgents?(panes: unknown): Promise<Record<string, string>>;
}
type Wait = (ms: number) => Promise<unknown>;
type BindingResult =
  | { pane: string; threadId: string; error?: never; status?: never }
  | { error: string; status: number; pane?: never; threadId?: never };
interface CodexRoutesOptions {
  codexApp?: CodexRouteApp | null;
  commands: CodexRouteCommands;
  claudeEvents: CodexRouteClaudeEvents;
  wait?: Wait;
}
interface Takeover { threadId: string | null; startedAt: number }
const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
};

const TAKEOVER_TERMINAL_HINT_MS = 10_000;
const TAKEOVER_TIMEOUT_MS = 30_000;
const INPUT_SETTLE_MS = 100;
const EXIT_POLL_MS = 500;
const EXIT_ATTEMPTS = 10;
const RECOVERY_OUTPUT_ATTEMPTS = 20;
const CLEAR_SWITCH_ATTEMPTS = 60;
const STREAM_BATCH_MS = 60;
const STREAM_HEARTBEAT_MS = 15_000;
const PERMISSION_MODES = {
  default: {
    approvalPolicy: 'on-request', approvalsReviewer: 'user',
    sandboxPolicy: { type: 'workspaceWrite' },
  },
  'auto-review': {
    approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
    sandboxPolicy: { type: 'workspaceWrite' },
  },
  'full-access': {
    approvalPolicy: 'never', approvalsReviewer: 'user',
    sandboxPolicy: { type: 'dangerFullAccess' },
  },
};
const isPermissionMode = (value: unknown): value is keyof typeof PERMISSION_MODES => (
  typeof value === 'string' && Object.hasOwn(PERMISSION_MODES, value)
);

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function paneAgent(commands: CodexRouteCommands, claudeEvents: CodexRouteClaudeEvents, pane: string) {
  const panes = await commands?.listLivePanes?.();
  const live = Array.isArray(panes) ? panes.find((candidate) => candidate.id === pane) : null;
  if (!live) return { live: null, agent: null };
  const agents = await claudeEvents?.identifyPaneAgents?.(panes) || {};
  return { live, agent: agents[pane] || null };
}

async function exitCurrentCodex(
  commands: CodexRouteCommands,
  claudeEvents: CodexRouteClaudeEvents,
  pane: string,
) {
  if (!commands.sendKey) throw new Error('Codex terminal control is unavailable');
  // During an active turn Codex can spend several seconds writing interruption details, token usage and
  // its recovery command. Give each Ctrl+C a full five-second window; only send a second one if the pane
  // still proves Codex is the foreground process after that wait.
  for (let press = 0; press < 2; press += 1) {
    await commands.sendKey(pane, 'C-c');
    for (let attempt = 0; attempt < EXIT_ATTEMPTS; attempt += 1) {
      await pause(EXIT_POLL_MS);
      const current = await paneAgent(commands, claudeEvents, pane);
      if (!current.live || current.agent !== 'codex') return current.live;
    }
  }
  return null;
}

async function waitForRecoverySession(
  commands: CodexRouteCommands,
  pane: string,
  isId: (value: unknown) => boolean,
): Promise<string | null> {
  if (!commands.capturePlain) return null;
  // tmux can report pane_current_command=the shell before the last buffered Codex output has been painted.
  // Poll the visible pane briefly instead of treating the first incomplete frame as a permanent failure.
  for (let attempt = 0; attempt < RECOVERY_OUTPUT_ATTEMPTS; attempt += 1) {
    try {
      const sessionId = codexExitSessionId(await commands.capturePlain(pane));
      if (isId(sessionId)) return sessionId;
    } catch { return null; } // a direct-command pane may have closed with Codex
    await pause(INPUT_SETTLE_MS);
  }
  return null;
}

async function clearCurrentCodexThroughTui(
  codexApp: CodexRouteApp,
  commands: CodexRouteCommands,
  pane: string,
  previousThreadId: string,
  wait: Wait,
): Promise<{ threadId: string }> {
  if (typeof commands?.exitCopyModeIfActive !== 'function'
    || typeof commands?.sendKey !== 'function'
    || typeof commands?.sendText !== 'function'
    || typeof commands?.sendEnter !== 'function') {
    throw new Error('Codex terminal control is unavailable');
  }
  // /clear is not just thread/start: the remote TUI also replaces its active ChatWidget and redraws the
  // terminal. Drive that native action so terminal and chat remain one session. C-u makes the command exact
  // even if the hidden terminal composer retained a draft; if a modal owns input, confirmation below times
  // out instead of letting Handmux split onto a different thread.
  await commands.exitCopyModeIfActive(pane);
  await commands.sendKey(pane, 'C-u');
  await wait(INPUT_SETTLE_MS);
  await commands.sendText(pane, '/clear');
  await wait(INPUT_SETTLE_MS);
  await commands.sendEnter(pane);

  for (let attempt = 0; attempt < CLEAR_SWITCH_ATTEMPTS; attempt += 1) {
    const discovered = await codexApp.discover(pane);
    if (!discovered?.managed) throw new Error('Codex session is no longer managed by Handmux');
    if (discovered.threadId && discovered.threadId !== previousThreadId) {
      return { threadId: discovered.threadId };
    }
    await wait(INPUT_SETTLE_MS);
  }
  throw new Error('Codex terminal did not accept /clear; switch to the terminal, close any open panel, and try again');
}

async function binding(codexApp: CodexRouteApp, pane: unknown): Promise<BindingResult> {
  if (!isPaneId(pane)) return { error: 'bad pane id', status: 400 };
  try {
    const discovered = await codexApp?.discover?.(pane);
    if (!discovered?.managed) return { error: 'Codex session is not managed by Handmux', status: 409 };
    if (discovered.threadId) return { pane, threadId: discovered.threadId };
  } catch (error) {
    return { error: errorMessage(error), status: 503 };
  }
  return { error: 'Codex session is not bound yet', status: 409 };
}

function routeError(res: Response, result: BindingResult): result is Extract<BindingResult, { error: string }> {
  if (!result.error) return false;
  res.status(result.status).json({ error: result.error });
  return true;
}

function codexError(res: Response, error: unknown) {
  const message = errorMessage(error);
  const conflict = /not managed|session changed|no longer pending|already being sent|being edited|edit is no longer active|queue is full|decision is unavailable|bad user input response/i.test(message);
  return res.status(conflict ? 409 : 503).json({ error: message });
}

// Legacy/unsequenced App Server deltas may still be folded. Projected events keep every sequence intact:
// collapsing two cursor-addressable events would create an artificial gap on the next reconnect.
export function appendCodexStreamEvent(queue: CodexStreamEvent[], value: unknown): CodexStreamEvent[] {
  const event = parseCodexStreamEvent(value);
  if (!event) return queue;
  const last = queue.at(-1);
  if (event?.sequence == null && event?.type === 'delta' && last?.type === 'delta'
    && last.threadId === event.threadId && last.turnId === event.turnId && last.itemId === event.itemId) {
    last.delta = (last.delta || '') + (event.delta || '');
  } else if (event) queue.push({ ...event });
  return queue;
}

export function codexRoutes({ codexApp, commands, claudeEvents, wait = pause }: CodexRoutesOptions) {
  const r = express.Router();
  if (!codexApp) return r;
  // A takeover is pane-scoped and deliberately kept in server memory. Besides making repeated taps
  // idempotent, this gates discovery while the replacement process starts: App Server may briefly list
  // another historical thread, but the UI must not enter chat until the exact pre-takeover thread appears.
  const takeovers = new Map<string, Takeover>(); // pane -> { threadId, startedAt }
  const takeoverView = (takeover: Takeover) => {
    const elapsed = Date.now() - takeover.startedAt;
    return {
      state: elapsed >= TAKEOVER_TIMEOUT_MS ? 'timed-out' : 'starting',
      needsTerminal: elapsed >= TAKEOVER_TERMINAL_HINT_MS,
    };
  };

  r.get('/codex/session', async (req, res) => {
    const pane = req.query.pane;
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    const takeover = takeovers.get(pane);
    try {
      const discovered = await codexApp.discover(pane);
      if (takeover && (!takeover.threadId || discovered?.threadId !== takeover.threadId)) {
        return res.json({ managed: false, threadId: null, takeover: takeoverView(takeover) });
      }
      if (takeover) takeovers.delete(pane);
      if (!discovered?.managed || !discovered.threadId) {
        return res.json({ managed: !!discovered?.managed, threadId: discovered?.threadId || null });
      }
      return res.json(await codexApp.status(pane, discovered.threadId));
    } catch (error) {
      // A killed plain Codex and its replacement App Server have a normal short disconnect window. Keep
      // the takeover page stable through it instead of flashing a generic connection failure.
      if (takeover) return res.json({ managed: false, threadId: null, takeover: takeoverView(takeover) });
      return codexError(res, error);
    }
  });

  r.get('/codex/stream', async (req, res) => {
    const target = await binding(codexApp, req.query.pane);
    if (routeError(res, target)) return;
    const rawAfter = req.query.after;
    const afterSequence = rawAfter == null || rawAfter === '' ? null : Number(rawAfter);
    if (afterSequence != null && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
      return res.status(400).json({ error: 'bad Codex stream cursor' });
    }

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: 'ready', threadId: target.threadId })}\n\n`);

    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let flushTimer: NodeJS.Timeout | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    const pending: CodexStreamEvent[] = [];
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (closed || !pending.length) return;
      const events = pending.splice(0);
      res.write(`data: ${JSON.stringify({ type: 'events', events })}\n\n`);
      res.flush?.();
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (flushTimer) clearTimeout(flushTimer);
      if (heartbeat) clearInterval(heartbeat);
      flushTimer = null;
      heartbeat = null;
      unsubscribe?.();
      unsubscribe = null;
    };
    const enqueue = (event: CodexStreamEvent) => {
      if (closed) return;
      if (event?.type === 'disconnected') {
        appendCodexStreamEvent(pending, event);
        flush();
        cleanup();
        res.end();
        return;
      }
      appendCodexStreamEvent(pending, event);
      if (['completed', 'turnCompleted', 'goal', 'goalCleared'].includes(event?.type)) flush();
      else if (!flushTimer) {
        flushTimer = setTimeout(flush, STREAM_BATCH_MS);
        flushTimer.unref?.();
      }
    };

    req.once('aborted', cleanup);
    res.once('close', cleanup);
    try {
      unsubscribe = await codexApp.subscribe(target.pane, target.threadId, enqueue, afterSequence);
      if (closed) { unsubscribe(); unsubscribe = null; return; }
      heartbeat = setInterval(() => {
        if (!closed) res.write(`: keepalive ${Date.now()}\n\n`);
      }, STREAM_HEARTBEAT_MS);
      heartbeat.unref?.();
    } catch (error) {
      if (!closed) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: errorMessage(error) })}\n\n`);
        res.end();
      }
      cleanup();
    }
    return undefined;
  });

  r.post('/codex/takeover', async (req, res) => {
    const pane = req.body?.pane;
    if (!isPaneId(pane)) return res.status(400).json({ error: 'bad pane id' });
    const pending = takeovers.get(pane);
    if (pending) return res.json({ started: true, takeover: takeoverView(pending) });
    try {
      const discovered = await codexApp.discover(pane);
      if (discovered?.managed && discovered.threadId) {
        return res.json({ started: false, managed: true, threadId: discovered.threadId });
      }
      if (discovered?.managed) return res.status(409).json({ error: 'codex-session-starting' });

      // Re-check live process identity immediately before interacting with the pane. A stale client must
      // never send slash commands to a pane whose Codex has already exited or changed.
      const current = await paneAgent(commands, claudeEvents, pane);
      if (!current.live) return res.status(404).json({ error: 'codex-pane-gone' });
      if (current.agent !== 'codex') return res.status(409).json({ error: 'codex-pane-changed' });

      const driver = getAgent('codex');
      const takeover: Takeover = { threadId: null, startedAt: Date.now() };
      takeovers.set(pane, takeover);
      try {
        const exited = await exitCurrentCodex(commands, claudeEvents, pane);
        if (!exited) {
          takeovers.delete(pane);
          return res.status(409).json({ error: 'codex-exit-blocked' });
        }
        const sessionId = await waitForRecoverySession(commands, pane, driver.sessions.isId);
        if (!sessionId) {
          takeovers.delete(pane);
          return res.status(409).json({ error: 'codex-session-unconfirmed' });
        }
        takeover.threadId = sessionId;
        await pause(INPUT_SETTLE_MS); // let the restored shell finish drawing its prompt
        const managedResumeCmd = driver.sessions.managedResumeCmd;
        if (!managedResumeCmd || !commands.runPaneCommand) {
          throw new Error('Codex managed resume command is unavailable');
        }
        await commands.runPaneCommand(pane, managedResumeCmd(sessionId));
      } catch (error) {
        takeovers.delete(pane);
        throw error;
      }
      return res.json({ started: true, takeover: takeoverView(takeover) });
    } catch (error) { return codexError(res, error); }
  });

  r.post('/codex/send', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'message is empty' });
    const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
    if (requestId && (requestId.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(requestId))) {
      return res.status(400).json({ error: 'bad Codex request id' });
    }
    try { return res.json(await codexApp.send(target.pane, target.threadId, text, requestId || null)); }
    catch (error) { return codexError(res, error); }
  });

  const queueMethods: Array<[string, 'steerQueued' | 'removeQueued']> = [
    ['/codex/queue/steer', 'steerQueued'], ['/codex/queue/remove', 'removeQueued'],
  ];
  for (const [path, method] of queueMethods) {
    r.post(path, async (req, res) => {
      const target = await binding(codexApp, req.body?.pane);
      if (routeError(res, target)) return;
      const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
      if (!id || id.length > 128) return res.status(400).json({ error: 'bad queued message id' });
      try { return res.json(await codexApp[method](target.pane, target.threadId, id)); }
      catch (error) { return codexError(res, error); }
    });
  }

  r.post('/codex/queue/edit/begin', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
    if (!id || id.length > 128) return res.status(400).json({ error: 'bad queued message id' });
    try { return res.json(await codexApp.beginQueuedEdit(target.pane, target.threadId, id)); }
    catch (error) { return codexError(res, error); }
  });

  for (const action of ['renew', 'commit', 'cancel'] as const) {
    r.post(`/codex/queue/edit/${action}`, async (req, res) => {
      const target = await binding(codexApp, req.body?.pane);
      if (routeError(res, target)) return;
      const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
      const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      if (!id || id.length > 128) return res.status(400).json({ error: 'bad queued message id' });
      if (!token || token.length > 128) return res.status(400).json({ error: 'bad queued message edit token' });
      if (action === 'commit') {
        const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
        if (!text) return res.status(400).json({ error: 'message is empty' });
        try { return res.json(await codexApp.commitQueuedEdit(target.pane, target.threadId, id, token, text)); }
        catch (error) { return codexError(res, error); }
      }
      try {
        const result = action === 'renew'
          ? await codexApp.renewQueuedEdit(target.pane, target.threadId, id, token)
          : await codexApp.cancelQueuedEdit(target.pane, target.threadId, id, token);
        return res.json(result);
      }
      catch (error) { return codexError(res, error); }
    });
  }

  r.post('/codex/compact', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    try { res.json(await codexApp.compact(target.pane, target.threadId)); }
    catch (error) { codexError(res, error); }
  });

  r.post('/codex/clear', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    try {
      res.json(await clearCurrentCodexThroughTui(
        codexApp, commands, target.pane, target.threadId, wait,
      ));
    }
    catch (error) { codexError(res, error); }
  });

  r.get('/codex/models', async (req, res) => {
    const target = await binding(codexApp, req.query.pane);
    if (routeError(res, target)) return;
    try { res.json({ models: await codexApp.models(target.pane, target.threadId) }); }
    catch (error) { codexError(res, error); }
  });

  r.get('/codex/goal', async (req, res) => {
    const target = await binding(codexApp, req.query.pane);
    if (routeError(res, target)) return;
    try { res.json({ goal: await codexApp.getGoal(target.pane, target.threadId) }); }
    catch (error) { codexError(res, error); }
  });

  r.post('/codex/goal', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    const updates: { objective?: string; status?: 'active' | 'paused' } = {};
    if (Object.hasOwn(req.body || {}, 'objective')) {
      const objective = req.body.objective;
      const trimmed = typeof objective === 'string' ? objective.trim() : '';
      if (!trimmed || trimmed.length > 4_000) {
        return res.status(400).json({ error: 'bad goal objective' });
      }
      updates.objective = trimmed;
    }
    if (Object.hasOwn(req.body || {}, 'status')) {
      const status = req.body.status;
      if (status !== 'active' && status !== 'paused') return res.status(400).json({ error: 'bad goal status' });
      updates.status = status;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no goal update supplied' });
    try { return res.json({ goal: await codexApp.updateGoal(target.pane, target.threadId, updates) }); }
    catch (error) { return codexError(res, error); }
  });

  r.post('/codex/goal/clear', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    try { res.json(await codexApp.clearGoal(target.pane, target.threadId)); }
    catch (error) { codexError(res, error); }
  });

  r.post('/codex/settings', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    const updates: Record<string, unknown> = {};
    for (const key of ['model', 'effort']) {
      const value = req.body?.[key];
      if (value == null) continue;
      if (typeof value !== 'string' || !value.trim() || value.length > 128) {
        return res.status(400).json({ error: `bad ${key}` });
      }
      updates[key] = value.trim();
    }
    if (Object.hasOwn(req.body || {}, 'serviceTier')) {
      const value = req.body.serviceTier;
      if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 128)) {
        return res.status(400).json({ error: 'bad serviceTier' });
      }
      updates.serviceTier = value === null ? null : value.trim();
    }
    const approvalPolicy = req.body?.approvalPolicy;
    if (approvalPolicy != null) {
      if (!['untrusted', 'on-request', 'never'].includes(approvalPolicy)) {
        return res.status(400).json({ error: 'bad approvalPolicy' });
      }
      updates.approvalPolicy = approvalPolicy;
    }
    const permissionMode = req.body?.permissionMode;
    if (permissionMode != null) {
      if (!isPermissionMode(permissionMode)) {
        return res.status(400).json({ error: 'bad permissionMode' });
      }
      Object.assign(updates, PERMISSION_MODES[permissionMode]);
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no settings supplied' });
    try { return res.json({ settings: await codexApp.updateSettings(target.pane, target.threadId, updates) }); }
    catch (error) { return codexError(res, error); }
  });

  r.post('/codex/interrupt', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    try { res.json(await codexApp.interrupt(target.pane, target.threadId)); }
    catch (error) { codexError(res, error); }
  });

  r.post('/codex/approval', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    const requestId = req.body?.requestId;
    const decision = req.body?.decision;
    if ((typeof requestId !== 'string' && typeof requestId !== 'number') || typeof decision !== 'string') {
      return res.status(400).json({ error: 'bad approval response' });
    }
    try { return res.json(await codexApp.decide(target.pane, target.threadId, requestId, decision)); }
    catch (error) { return codexError(res, error); }
  });

  r.post('/codex/input', async (req, res) => {
    const target = await binding(codexApp, req.body?.pane);
    if (routeError(res, target)) return;
    const requestId = req.body?.requestId;
    const answers = req.body?.answers;
    const entries = answers && typeof answers === 'object' && !Array.isArray(answers)
      ? Object.entries(answers) : [];
    if ((typeof requestId !== 'string' && typeof requestId !== 'number') || !entries.length
      || entries.some(([questionId, value]) => !questionId || !Array.isArray(value) || !value.length
        || value.some((answer) => typeof answer !== 'string' || !answer.trim()))) {
      return res.status(400).json({ error: 'bad user input response' });
    }
    try { return res.json(await codexApp.answerInput(target.pane, target.threadId, requestId, answers)); }
    catch (error) { return codexError(res, error); }
  });

  return r;
}
