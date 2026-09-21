import { describe, expect, it, vi } from 'vitest';
import { createCodeBuddyInteractionAdapter } from '../src/agents/codebuddyInteraction.js';
import { sendPaneChoice, serializePaneInput } from '../src/paneInput.js';
import { AgentRunRuntime } from '../src/agent-runtime/run.js';

// CodeBuddy's gates are read with the SAME parser Claude's are (src/pendingPrompt.ts): the cursor-marked
// numbered option list is shared, and so is the keystroke that drives it — the option's own digit. These
// fixtures are the machine's own bytes, not a transcription, because that is what this reader got wrong
// before: an invented empty-editor shape let the pane reader look correct while refusing every real send.
// Only the naming differs between providers, and one test below pins that too.
//
// Captured verbatim from a live CodeBuddy 2.156.0 pane (2026-09-21), the AskUserQuestion menu.
const realQuestionScreen = [
  "←  ☐ 颜色偏好  ✔ Submit  →",
  "",
  "喜欢红色还是蓝色？",
  "",
  "❯ 1. 红色",
  "     喜欢红色",
  "  2. 蓝色",
  "     喜欢蓝色",
  "  3. Type something",
  "  Submit",
  "",
  "",
  "  Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join('\n');


// Same pane, the multi-question review screen the digit advanced to.
const realReviewScreen = [
  "Review your answers",
  "",
  "●  喜欢红色还是蓝色？",
  "  → 红色",
  "",
  "Ready to submit your answers?",
  "",
  "❯ 1. Submit answers",
  "  2. Cancel",
  "",
  "Enter to select · Tab/Arrow keys to navigate",
].join('\n');


// Same pane, the Bash permission gate (its cursor is `>`, not `❯`).
const realPermissionScreen = [
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   touch /private/tmp/perm-probe-2.txt",
  "   Create empty file in /private/tmp",
  "",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "",
  " Do you want to proceed?",
  "",
  " > 1. Yes",
  "   2. Yes, and don't ask again for session (shift + tab)",
  "   3. No, and tell CodeBuddy what to do differently (escape)",
].join('\n');

async function lease() {
  const runtime = new AgentRunRuntime({ newRunId: () => 'run-codebuddy' });
  return runtime.controller('codebuddy', async () => true).attach({
    paneId: '%1', attachmentId: 'codebuddy-hooks', sessionId: 'session-1', process: { pid: 401 },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

describe('CodeBuddy Interaction adapter', () => {
  it('reads the real question menu, with the answers the model actually offered', async () => {
    const run = await lease();
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: async () => realQuestionScreen, sendChoice: vi.fn(async () => {}),
    }, 1_000);
    const handle = await adapter.observeNative(run, () => {});
    const pending = handle.checkpoint.pending[0];
    expect(pending).toMatchObject({
      type: 'select',
      prompt: '喜欢红色还是蓝色？',
      options: [
        { id: 'choice:1', label: '红色 — 喜欢红色' },
        { id: 'choice:2', label: '蓝色 — 喜欢蓝色' },
      ],
    });
    // "Type something" / "Chat about this" / the Submit row are the TUI's own furniture, never answers,
    // and the interaction carries this provider's name so it cannot be mistaken for another Agent's gate.
    expect(pending?.options).toHaveLength(2);
    expect(pending?.id).toMatch(/^codebuddy-prompt:/);
    await handle.close();
  });

  it('reads the permission gate, whose cursor is `>` rather than `❯`', async () => {
    const run = await lease();
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: async () => realPermissionScreen, sendChoice: vi.fn(async () => {}),
    }, 1_000);
    const handle = await adapter.observeNative(run, () => {});
    const pending = handle.checkpoint.pending[0];
    expect(pending?.type).toBe('select');
    expect(pending?.prompt).toContain('Do you want to proceed?');
    expect(pending?.options?.map((option) => option.label)).toEqual([
      'Yes',
      "Yes, and don't ask again for session (shift + tab)",
      'No, and tell CodeBuddy what to do differently (escape)',
    ]);
    await handle.close();
  });

  it.each([
    ['the question', realQuestionScreen, '红色'],
    ['the review screen', realReviewScreen, 'Submit answers'],
    ['the permission gate', realPermissionScreen, 'Yes'],
  ])('drives %s with the option digit, not a paste or a trailing Enter', async (_label, screen, first) => {
    const run = await lease();
    const commands = {
      exitCopyModeIfActive: vi.fn(async () => {}), sendText: vi.fn(async () => {}),
      sendEnter: vi.fn(async () => {}), sendKey: vi.fn(async () => {}),
    };
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: async () => screen,
      sendChoice: (pane, choice) => sendPaneChoice(commands, pane, choice),
    }, 1_000);
    const handle = await adapter.observeNative(run, () => {});
    try {
      const pending = handle.checkpoint.pending[0]!;
      expect(pending.options?.[0]?.label).toContain(first);
      const gate = deferred<void>();
      const preceding = serializePaneInput('%1', () => gate.promise);
      const response = adapter.dispatchResponse(run, {
        interactionId: pending.id, value: { type: 'selection', optionIds: ['choice:1'] },
      });
      await Promise.resolve();
      expect(commands.sendKey).not.toHaveBeenCalled(); // waits for the shared pane critical section
      gate.resolve(); await preceding;
      expect(await response).toEqual({ status: 'accepted' });
      expect(commands.sendKey).toHaveBeenCalledWith('%1', '1');
      expect(commands.sendText).not.toHaveBeenCalled();
      expect(commands.sendEnter).not.toHaveBeenCalled();
    } finally { await handle.close(); }
  });

  it('refuses an option the gate is not offering', async () => {
    const run = await lease();
    const sendChoice = vi.fn(async () => {});
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: async () => realQuestionScreen, sendChoice,
    }, 1_000);
    const handle = await adapter.observeNative(run, () => {});
    const pending = handle.checkpoint.pending[0]!;
    await expect(adapter.dispatchResponse(run, {
      interactionId: pending.id, value: { type: 'selection', optionIds: ['choice:7'] },
    })).resolves.toEqual({ status: 'rejected', reason: 'invalid_value' });
    expect(sendChoice).not.toHaveBeenCalled();
    await handle.close();
  });

  it('names its own provider when a gate has no readable decisions', async () => {
    const run = await lease();
    const sendChoice = vi.fn(async () => {});
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: async () => '', pendingKind: () => 'permission', sendChoice,
    }, 1_000);
    const handle = await adapter.observeNative(run, () => {});
    const pending = handle.checkpoint.pending[0];
    // A gate whose screen yields nothing usable still surfaces, but only as a local notice: no buttons are
    // invented, so nothing can be answered by accident.
    expect(pending).toMatchObject({
      type: 'local_only', prompt: 'CodeBuddy is waiting for permission in the terminal.',
    });
    expect(pending?.options).toBeUndefined();
    await expect(adapter.dispatchResponse(run, {
      interactionId: pending!.id, value: { type: 'approval', optionId: 'choice:1' },
    })).resolves.toEqual({ status: 'rejected', reason: 'invalid_value' });
    expect(sendChoice).not.toHaveBeenCalled();
    await handle.close();
  });
});
