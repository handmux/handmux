// The pending-interaction adapter shared by the Hook-driven Agents (Claude, CodeBuddy). Their TUIs are the
// same one-line-editor lineage, so the prompts they put on screen have the same shape — a cursor-marked
// numbered option list with a description row under an option — and picking one is the same keystroke: the
// option's own DIGIT.
//
// Verified live against CodeBuddy 2.156.0 (2026-09-21), where all three screens parse with the SAME
// `parsePendingPrompt` Claude uses and the digit really drives them:
//
//   question   ❯ 1. 红色 / 2. 蓝色 / 3. Type something      → sending 1 selects AND advances
//   review     ❯ 1. Submit answers / 2. Cancel              → sending 1 submits the answers
//   permission  > 1. Yes / 2. Yes, and don't ask again…      → sending 1 ran the tool (file created)
//               3. No, and tell CodeBuddy what to do…
//
// A provider supplies its own naming (the ids the phone stores and the fallback wording a user reads);
// everything else is the shared contract. Where a provider's wording is NOT verifiable — a permission gate
// whose screen shows no options — the adapter emits a `local_only` prompt with no options rather than
// guessing what the buttons mean.
import { createHash } from 'node:crypto';
import type { AgentRunLease } from '../agent-runtime/run.js';
import type {
  AgentInteractionAdapterV1,
  InteractionAdapterEventSink,
  InteractionAdapterPending,
  InteractionReceipt,
} from '../agent-runtime/interactionTypes.js';
import { parsePendingPrompt } from '../pendingPrompt.js';

export interface HookInteractionControl {
  capturePlain(paneId: string): Promise<string>;
  sendChoice(paneId: string, choice: string): Promise<unknown>;
  pendingKind?(paneId: string): string | null;
}

export interface HookInteractionProvider {
  /** Names the ids and cursors this adapter emits, e.g. 'claude' → `claude-prompt:…`. */
  id: string;
  /** Names the provider in a generated fallback line, e.g. 'Claude'. */
  label: string;
}

function normalizedPrompt(
  text: string,
  provider: HookInteractionProvider,
  pendingKind?: string | null,
): InteractionAdapterPending | null {
  const prompt = parsePendingPrompt(text);
  if (!prompt) {
    if (pendingKind !== 'permission') return null;
    const tail = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-3).join('\n');
    const promptText = tail.slice(0, 2_000) || `${provider.label} is waiting for permission in the terminal.`;
    const id = `${provider.id}-permission:${createHash('sha256').update(promptText).digest('hex').slice(0, 24)}`;
    return {
      id, type: 'local_only', prompt: promptText,
    };
  }
  const signature = JSON.stringify(prompt);
  const id = `${provider.id}-prompt:${createHash('sha256').update(signature).digest('hex').slice(0, 24)}`;
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

export function createHookInteractionAdapter(
  control: HookInteractionControl,
  provider: HookInteractionProvider,
  pollMs = 750,
  reportHealth: (availability: 'ready' | 'degraded', message?: string) => void = () => {},
): AgentInteractionAdapterV1 {
  if (!control || typeof control.capturePlain !== 'function'
    || typeof control.sendChoice !== 'function' || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new TypeError('Interaction adapter requires pane capture and choice control');
  }
  const active = new Map<string, { run: AgentRunLease; pending: InteractionAdapterPending | null }>();
  return {
    apiVersion: 1,
    async observeNative(run, sink: InteractionAdapterEventSink) {
      let closed = false;
      let cursor = 0;
      let pending = normalizedPrompt(
        await control.capturePlain(run.ref.paneId), provider, control.pendingKind?.(run.ref.paneId),
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
              await control.capturePlain(run.ref.paneId), provider, control.pendingKind?.(run.ref.paneId),
            );
            if (failures > 0) reportHealth('ready');
            failures = 0;
            if (pending?.id === next?.id) return;
            if (pending) await sink({
              type: 'resolved', sourceCursor: `${provider.id}-interaction:${++cursor}`,
              interactionId: pending.id,
            });
            pending = next;
            binding.pending = next;
            if (next) await sink({
              type: 'opened', sourceCursor: `${provider.id}-interaction:${++cursor}`, interaction: next,
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
                  type: 'cancelled', sourceCursor: `${provider.id}-interaction:${++cursor}`,
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
          sourceCursor: `${provider.id}-interaction:${cursor}`,
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
