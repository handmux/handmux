// The pending-interaction adapter shared by the Hook-driven Agents (Claude, CodeBuddy). Their TUIs are the
// same one-line-editor lineage, so the prompts they put on screen have the same shape — a cursor-marked
// numbered option list with a description row under an option — and they parse with the SAME
// `parsePendingPrompt`. What differs is the KEYSTROKE that picks an option, so it belongs to the provider's
// control (each sender documents its own measurement):
//
//   Claude     its menus take the option's own digit.
//   CodeBuddy  it depends on the screen. Measured on 2.156.0, one screen at a time: the AskUserQuestion
//              picker IGNORES the digit while `↓` moves the cursor and Enter selects; the review screen and
//              the permission gate DO take the digit (on the gate, `1` approved a command and it really ran).
//              Its control therefore uses the digit where it names the row and walks the cursor where it
//              cannot — see sendCodeBuddyPaneChoice.
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
  // The card must survive a re-render. The parse carries two volatile pieces: `cursor`, which moves whenever
  // anyone navigates the menu, and the lead-in prose above the question, which the turn retypes as it streams.
  // Hashing the whole parse therefore minted a NEW card whenever either changed, retiring the live one as
  // "resolved" while its gate was still on screen — so an answer could be swallowed AND its card taken away
  // (measured: a user's answer to a live question was accepted by the server and never reached the pane).
  // Identify the gate by what IS the gate: the menu kind, its own question line, and the options offered.
  const signature = JSON.stringify({
    kind: prompt.kind,
    question: prompt.title.split(' — ').at(-1) ?? prompt.title,
    options: prompt.options.map((option) => option.label),
    submit: prompt.submit === true,
  });
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
