// The pending-interaction adapter shared by the Hook-driven Agents (Claude, CodeBuddy). Their TUIs are the
// same one-line-editor lineage, so the prompts they put on screen have the same shape — a cursor-marked
// numbered option list with a description row under an option — and they parse with the SAME
// `parsePendingPrompt`. What differs is the KEYSTROKE that picks an option, and that turns out to depend on
// the SCREEN rather than on the provider — so both bind one shared sender (paneInput.sendPaneMenuChoice):
//
//   question menu    a digit only MOVES the highlight. Measured live on CodeBuddy 2.156.0, whose picker
//                    ignores the digit outright (the highlight does not budge); and read out of Claude
//                    Code's own bundle (2.1.278), where `1`–`9` go through the same `nme` that ↑/↓ call
//                    while only the `return` branch commits. Answering therefore means walking to the
//                    option and pressing Enter — on both providers.
//   permission gate  the digit commits: measured on CodeBuddy, where a `1` approved a command that really
//                    ran. It is also the safer key there — it names the row instead of stepping to it, so a
//                    misread cursor cannot commit a different answer than the user tapped.
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

// A pane that is mid-turn says so on its own screen: both providers print the interrupt hint while the model
// or a tool is running — `✹ Buzzing… (esc to interrupt)`, measured on CodeBuddy 2.156.0, and Claude prints the
// same hint. A gate that is really up cannot be mid-turn; the pane is blocked ON the gate. So this is what
// keeps the no-options fallback quiet in the one window where its `permreq` row is stale by construction:
// CodeBuddy fires no Hook when a gate is answered, so an approved tool keeps its row (and the roster at 需要你)
// until the turn's next Hook — measured on pane %211, where an approved `sleep 90` said 需要你授权：Bash for the
// whole minute while the tool ran, and the fallback turned that into a 去终端 card nothing was waiting for.
const INTERRUPT_HINT_RE = /esc to interrupt/i;

function normalizedPrompt(
  text: string,
  provider: HookInteractionProvider,
  pendingKind?: string | null,
): InteractionAdapterPending | null {
  const prompt = parsePendingPrompt(text);
  if (!prompt) {
    if (pendingKind !== 'permission' || INTERRUPT_HINT_RE.test(text)) return null;
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
  //
  // The price of a shape-named id is that two DIFFERENT gates of the same shape carry the same id — every
  // review screen, for one. That is Core's problem to tell apart, and it does: a shape that comes back after
  // its card was settled is published as a new interaction with a new id and token, never silently dropped.
  // So this id must stay shape-stable within one occurrence and must NOT try to encode an instance number,
  // which this adapter cannot know (a fresh observation has no memory of what it saw before).
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
