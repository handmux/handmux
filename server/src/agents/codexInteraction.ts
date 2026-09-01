import type {
  CodexInteractionSnapshot,
  NormalizedApproval,
  NormalizedUserInput,
} from '../codexAppServer.js';
import type {
  AgentInteractionAdapterV1,
  InteractionAdapterEvent,
  InteractionAdapterEventSink,
  InteractionAdapterPending,
  InteractionFormField,
  InteractionReceipt,
  InteractionValue,
} from '../agent-runtime/interactionTypes.js';
import type { AgentRunLease } from '../agent-runtime/run.js';

interface CodexInteractionApp {
  discover(pane: string): Promise<{ managed: boolean; threadId?: string | null } | null>;
  observeInteractions(
    pane: string,
    threadId: string,
    listener: (snapshot: CodexInteractionSnapshot) => void,
  ): Promise<CodexInteractionSnapshot & { close(): void }>;
  decide(pane: string, threadId: string, requestId: string, decision: string): Promise<unknown>;
  answerInput(
    pane: string,
    threadId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<unknown>;
}

interface NativeInputField {
  questionId: string;
  optionValues?: Map<string, string>;
  allowOther?: boolean;
}

interface NativeInteraction {
  sourceId: string;
  pending: InteractionAdapterPending;
  kind: 'approval' | 'input' | 'local_only';
  requestId: string;
  decisionIds?: Set<string>;
  inputFields?: Map<string, NativeInputField>;
}

interface RunBinding {
  run: AgentRunLease;
  interactions: Map<string, NativeInteraction>;
  detachAbort: () => void;
}

type InteractionEventBody =
  | { type: 'opened'; interaction: InteractionAdapterPending }
  | { type: 'resolved'; interactionId: string }
  | { type: 'cancelled'; interactionId: string; reason?: string };

function decisionId(value: NormalizedApproval['decisions'][number]): string {
  return typeof value === 'string' ? value : value.id;
}

function decisionLabel(value: NormalizedApproval['decisions'][number]): string {
  if (typeof value === 'string') {
    return ({
      accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Deny', cancel: 'Cancel',
    } as Record<string, string>)[value] ?? value;
  }
  if (value.type === 'networkPolicy') {
    return `${value.action === 'deny' ? 'Deny' : 'Allow'} network${value.host ? `: ${value.host}` : ''}`;
  }
  return `${value.action === 'deny' ? 'Deny' : 'Allow'} command policy`;
}

function approval(value: NormalizedApproval): NativeInteraction {
  const sourceId = `approval:${value.id}`;
  const intent = value.type === 'command' ? 'command_approval' as const
    : value.type === 'file' ? 'file_approval' as const : 'permission_approval' as const;
  const prompt = value.reason || value.command || value.type;
  const details = [
    ...(value.reason ? [{ kind: 'reason' as const, type: 'text' as const, text: value.reason }] : []),
    ...(value.command ? [{ kind: 'command' as const, type: 'code' as const, text: value.command }] : []),
    ...(value.cwd ? [{
      kind: 'working_directory' as const, type: 'path' as const, text: value.cwd,
    }] : []),
  ];
  const options = [...new Map(value.decisions.map((decision) => [
    decisionId(decision), { id: decisionId(decision), label: decisionLabel(decision) },
  ])).values()];
  if (!options.length) {
    return {
      sourceId,
      requestId: value.id,
      kind: 'local_only',
      pending: {
        id: sourceId, type: 'local_only', intent, prompt,
        ...(details.length ? { details } : {}),
        ...(value.correlationId || value.itemId || value.turnId
          ? { correlationId: value.correlationId || value.itemId || value.turnId } : {}),
      },
    };
  }
  return {
    sourceId,
    requestId: value.id,
    kind: 'approval',
    decisionIds: new Set(options.map((option) => option.id)),
    pending: {
      id: sourceId, type: 'approval', intent, prompt, options,
      ...(details.length ? { details } : {}),
      ...(value.correlationId || value.itemId || value.turnId
        ? { correlationId: value.correlationId || value.itemId || value.turnId } : {}),
    },
  };
}

function userInput(value: NormalizedUserInput): NativeInteraction {
  const sourceId = `input:${value.id}`;
  const correlationId = value.correlationId || value.itemId || value.turnId;
  if (!value.questions.length) {
    return {
      sourceId, requestId: value.id, kind: 'local_only',
      pending: {
        id: sourceId, type: 'local_only', intent: 'input_request', prompt: value.id,
        ...(correlationId ? { correlationId } : {}),
      },
    };
  }
  const inputFields = new Map<string, NativeInputField>();
  const fields: InteractionFormField[] = [];
  for (const [questionIndex, question] of value.questions.entries()) {
    const fieldId = `field:${questionIndex}`;
    if (question.options) {
      const usableOptions = question.options.filter((option) => option.label.length > 0);
      if (usableOptions.length !== question.options.length || !usableOptions.length) continue;
      const optionValues = new Map<string, string>();
      const options = usableOptions.map((option, optionIndex) => {
        const id = `option:${questionIndex}:${optionIndex}`;
        optionValues.set(id, option.label);
        return {
          id, label: option.label,
          ...(option.description ? { description: option.description } : {}),
        };
      });
      inputFields.set(fieldId, {
        questionId: question.id, optionValues,
        ...(question.isOther ? { allowOther: true } : {}),
      });
      fields.push({
        id: fieldId, type: 'select' as const, prompt: question.question, options,
        ...(question.header ? { label: question.header } : {}),
        ...(question.isOther ? { allowOther: true } : {}),
      });
      continue;
    }
    inputFields.set(fieldId, { questionId: question.id });
    fields.push({
      id: fieldId, type: question.isSecret ? 'secret' as const : 'text' as const,
      prompt: question.question,
      ...(question.header ? { label: question.header } : {}),
    });
  }
  if (fields.length !== value.questions.length) {
    return {
      sourceId, requestId: value.id, kind: 'local_only',
      pending: {
        id: sourceId, type: 'local_only', intent: 'input_request',
        prompt: value.questions.map((question) => question.question).join('\n'),
        ...(correlationId ? { correlationId } : {}),
      },
    };
  }
  return {
    sourceId, requestId: value.id, kind: 'input', inputFields,
    pending: {
      id: sourceId, type: 'form', intent: 'input_request',
      prompt: value.questions[0]!.question, fields,
      ...(correlationId ? { correlationId } : {}),
    },
  };
}

function normalizeSnapshot(snapshot: CodexInteractionSnapshot): Map<string, NativeInteraction> {
  const values = [
    ...snapshot.approvals.map(approval),
    ...snapshot.userInputs.map(userInput),
  ];
  return new Map(values.map((value) => [value.sourceId, value]));
}

function sourceCursor(cursor: number, ordinal: number): string {
  return `codex-interactions:${cursor}:${ordinal}`;
}

function errorReceipt(error: unknown): InteractionReceipt {
  const message = error instanceof Error ? error.message : String(error);
  if (/no longer pending/i.test(message)) return { status: 'already_resolved' };
  if (/session changed|not managed|stale/i.test(message)) return { status: 'stale_run' };
  if (/unavailable|bad user input|unsupported|decision/i.test(message)) {
    return { status: 'rejected', reason: 'provider_rejected' };
  }
  return { status: 'unknown', reason: 'temporarily_unavailable' };
}

export function createCodexInteractionAdapter(app: CodexInteractionApp): AgentInteractionAdapterV1 {
  if (!app || typeof app.discover !== 'function' || typeof app.observeInteractions !== 'function'
    || typeof app.decide !== 'function' || typeof app.answerInput !== 'function') {
    throw new TypeError('Codex Interaction adapter requires App Server interaction APIs');
  }
  const bindings = new Map<string, RunBinding>();

  return {
    apiVersion: 1,
    async observeNative(run, sink) {
      const threadId = run.ref.sessionId;
      if (!threadId) throw new Error('Codex Interaction run has no thread');
      const discovered = await app.discover(run.ref.paneId);
      if (!discovered?.managed || discovered.threadId !== threadId) {
        throw new Error('Codex Interaction run is not the pane-owned thread');
      }
      let phase: 'opening' | 'live' | 'closed' = 'opening';
      let current = new Map<string, NativeInteraction>();
      const buffered: CodexInteractionSnapshot[] = [];
      let tail = Promise.resolve();
      let reset = 0;
      const emitSnapshot = async (snapshot: CodexInteractionSnapshot): Promise<void> => {
        if (phase === 'closed' || !Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < 0) {
          throw new Error('Invalid Codex Interaction snapshot');
        }
        const next = normalizeSnapshot(snapshot);
        const events: InteractionEventBody[] = [];
        for (const [id] of current) {
          if (!next.has(id)) events.push(snapshot.disconnected
            ? { type: 'cancelled', interactionId: id, reason: 'stream_reset' }
            : { type: 'resolved', interactionId: id });
        }
        for (const [id, item] of next) {
          const previous = current.get(id);
          if (!previous || JSON.stringify(previous.pending) !== JSON.stringify(item.pending)) {
            events.push({ type: 'opened', interaction: item.pending });
          }
        }
        current = next;
        binding.interactions = next;
        for (const [index, event] of events.entries()) {
          const cursor = snapshot.disconnected
            ? `codex-interactions:reset:${++reset}:${index}`
            : sourceCursor(snapshot.cursor, index + 1);
          await sink({ ...event, sourceCursor: cursor } as InteractionAdapterEvent);
        }
      };
      const failClosed = async (): Promise<void> => {
        if (phase === 'closed') return;
        const pending = [...current.keys()];
        current.clear();
        binding.interactions.clear();
        for (const [index, interactionId] of pending.entries()) {
          try {
            await sink({
              type: 'cancelled', interactionId, reason: 'stream_reset',
              sourceCursor: `codex-interactions:reset:${++reset}:${index}`,
            });
          } catch { break; }
        }
        phase = 'closed';
        observed.close();
      };
      const observed = await app.observeInteractions(run.ref.paneId, threadId, (snapshot) => {
        if (phase === 'opening') { buffered.push(structuredClone(snapshot)); return; }
        tail = tail.then(async () => {
          await emitSnapshot(snapshot);
          if (snapshot.disconnected) { phase = 'closed'; observed.close(); }
        }).catch(failClosed);
      });
      current = normalizeSnapshot(observed);
      const previous = bindings.get(run.ref.runId);
      previous?.detachAbort();
      const binding: RunBinding = { run, interactions: current, detachAbort: () => {} };
      const onAbort = (): void => {
        phase = 'closed';
        observed.close();
        if (bindings.get(run.ref.runId) === binding) bindings.delete(run.ref.runId);
      };
      run.signal.addEventListener('abort', onAbort, { once: true });
      binding.detachAbort = () => run.signal.removeEventListener('abort', onAbort);
      bindings.set(run.ref.runId, binding);
      phase = 'live';
      for (const snapshot of buffered.splice(0)) {
        if (snapshot.cursor <= observed.cursor) continue;
        tail = tail.then(() => emitSnapshot(snapshot));
      }
      tail = tail.catch(failClosed);
      return {
        checkpoint: {
          sourceCursor: sourceCursor(observed.cursor, 0),
          pending: [...current.values()].map((item) => structuredClone(item.pending)),
        },
        close() {
          if (phase === 'closed') return;
          phase = 'closed';
          observed.close();
        },
      };
    },
    async dispatchResponse(run: AgentRunLease, request) {
      const threadId = run.ref.sessionId;
      const binding = bindings.get(run.ref.runId);
      if (!threadId || !binding || binding.run !== run || run.signal.aborted) {
        return { status: 'stale_run' };
      }
      const native = binding.interactions.get(request.interactionId);
      if (!native) return { status: 'already_resolved' };
      if (native.kind === 'local_only') return { status: 'rejected', reason: 'local_only' };
      try {
        if (native.kind === 'approval') {
          if (request.value.type !== 'approval' || !native.decisionIds?.has(request.value.optionId)) {
            return { status: 'rejected', reason: 'invalid_value' };
          }
          await app.decide(run.ref.paneId, threadId, native.requestId, request.value.optionId);
        } else {
          const answers = inputAnswers(native, request.value);
          if (answers === null) return { status: 'rejected', reason: 'invalid_value' };
          await app.answerInput(run.ref.paneId, threadId, native.requestId, answers);
        }
        binding.interactions.delete(request.interactionId);
        return { status: 'accepted' };
      } catch (error) { return errorReceipt(error); }
    },
  };
}

function inputAnswers(
  native: NativeInteraction,
  value: InteractionValue,
): Record<string, string[]> | null {
  if (value.type !== 'form' || native.pending.type !== 'form' || !native.inputFields) return null;
  if (Object.keys(value.answers).length !== native.inputFields.size) return null;
  const answers: Record<string, string[]> = {};
  for (const [fieldId, field] of native.inputFields) {
    const raw = value.answers[fieldId];
    if (typeof raw !== 'string' || !raw.length) return null;
    const answer = field.optionValues?.get(raw) ?? (field.allowOther ? raw : field.optionValues ? null : raw);
    if (answer === null) return null;
    answers[field.questionId] = [answer];
  }
  return answers;
}
