import { createHash } from 'node:crypto';
import type { AgentRunLease } from '../agent-runtime/run.js';
import type {
  AgentInteractionAdapterV1,
  InteractionAdapterEventSink,
  InteractionAdapterPending,
  InteractionReceipt,
} from '../agent-runtime/interactionTypes.js';
import { parsePendingPrompt } from '../pendingPrompt.js';

export interface ClaudeInteractionControl {
  capturePlain(paneId: string): Promise<string>;
  sendChoice(paneId: string, choice: string): Promise<unknown>;
  pendingKind?(paneId: string): string | null;
}

function normalizedPrompt(text: string, pendingKind?: string | null): InteractionAdapterPending | null {
  const prompt = parsePendingPrompt(text);
  if (!prompt) {
    if (pendingKind !== 'permission') return null;
    const tail = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-3).join('\n');
    const promptText = tail.slice(0, 2_000) || 'Claude is waiting for permission in the terminal.';
    const id = `claude-permission:${createHash('sha256').update(promptText).digest('hex').slice(0, 24)}`;
    return {
      id, type: 'local_only', prompt: promptText,
    };
  }
  const signature = JSON.stringify(prompt);
  const id = `claude-prompt:${createHash('sha256').update(signature).digest('hex').slice(0, 24)}`;
  return {
    id,
    type: 'select',
    prompt: prompt.leadIn ? `${prompt.leadIn}\n${prompt.title}` : prompt.title,
    options: prompt.options.map((option) => ({
      id: `choice:${option.n}`,
      label: option.description ? `${option.label} — ${option.description}` : option.label,
    })),
  };
}

export function createClaudeInteractionAdapter(
  control: ClaudeInteractionControl,
  pollMs = 750,
  reportHealth: (availability: 'ready' | 'degraded', message?: string) => void = () => {},
): AgentInteractionAdapterV1 {
  if (!control || typeof control.capturePlain !== 'function'
    || typeof control.sendChoice !== 'function' || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new TypeError('Claude Interaction adapter requires pane capture and choice control');
  }
  const active = new Map<string, { run: AgentRunLease; pending: InteractionAdapterPending | null }>();
  return {
    apiVersion: 1,
    async observeNative(run, sink: InteractionAdapterEventSink) {
      let closed = false;
      let cursor = 0;
      let pending = normalizedPrompt(
        await control.capturePlain(run.ref.paneId), control.pendingKind?.(run.ref.paneId),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let tail = Promise.resolve();
      let failures = 0;
      const binding = { run, pending };
      active.set(run.ref.runId, binding);
      const close = (): void => {
        closed = true;
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (active.get(run.ref.runId) === binding) active.delete(run.ref.runId);
      };
      const schedule = (delay = pollMs): void => {
        if (closed || run.signal.aborted) return;
        timer = setTimeout(() => {
          tail = tail.then(async () => {
            if (closed || run.signal.aborted) return;
            const next = normalizedPrompt(
              await control.capturePlain(run.ref.paneId), control.pendingKind?.(run.ref.paneId),
            );
            if (failures > 0) reportHealth('ready');
            failures = 0;
            if (pending?.id === next?.id) return;
            if (pending) await sink({
              type: 'resolved', sourceCursor: `claude-interaction:${++cursor}`,
              interactionId: pending.id,
            });
            pending = next;
            binding.pending = next;
            if (next) await sink({
              type: 'opened', sourceCursor: `claude-interaction:${++cursor}`, interaction: next,
            });
          }).catch(async () => {
            failures += 1;
            if (failures >= 2) {
              reportHealth('degraded', 'Interaction polling is temporarily unavailable');
              if (pending) {
                const abandoned = pending;
                pending = null;
                binding.pending = null;
                await Promise.resolve(sink({
                  type: 'cancelled', sourceCursor: `claude-interaction:${++cursor}`,
                  interactionId: abandoned.id, reason: 'temporarily_unavailable',
                })).catch(close);
              }
            }
          }).finally(() => schedule(Math.min(10_000, pollMs * (2 ** Math.min(failures, 4)))));
        }, delay);
        timer.unref?.();
      };
      const onAbort = (): void => close();
      run.signal.addEventListener('abort', onAbort, { once: true });
      schedule();
      return {
        checkpoint: {
          sourceCursor: `claude-interaction:${cursor}`,
          pending: pending ? [pending] : [],
        },
        close() {
          run.signal.removeEventListener('abort', onAbort);
          close();
        },
      };
    },
    async dispatchResponse(run, request): Promise<InteractionReceipt> {
      const binding = active.get(run.ref.runId);
      if (!binding || binding.run !== run || run.signal.aborted) return { status: 'stale_run' };
      if (!binding.pending || binding.pending.id !== request.interactionId) {
        return { status: 'already_resolved' };
      }
      const optionIds = request.value.type === 'selection' ? request.value.optionIds
        : request.value.type === 'approval' ? [request.value.optionId] : [];
      if (optionIds.length !== 1) {
        return { status: 'rejected', reason: 'invalid_value' };
      }
      const optionId = optionIds[0]!;
      const match = optionId.match(/^choice:(\d+)$/);
      if (!match || !binding.pending.options?.some((option) => option.id === optionId)) {
        return { status: 'rejected', reason: 'invalid_value' };
      }
      try {
        await control.sendChoice(run.ref.paneId, match[1]!);
        return { status: 'accepted' };
      } catch {
        return { status: 'unknown', reason: 'temporarily_unavailable' };
      }
    },
  };
}
