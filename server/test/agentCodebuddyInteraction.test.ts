import { describe, expect, it, vi } from 'vitest';
import { createCodeBuddyInteractionAdapter } from '../src/agents/codebuddyInteraction.js';
import { serializePaneInput } from '../src/paneInput.js';
import { sendCodeBuddyPaneChoice } from '../src/agents/codebuddyPaneInput.js';
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

// The real question menu with its cursor moved onto `row` — the machine's own shape, only the mark moved.
function questionScreenAt(row: number): string {
  const lines = realQuestionScreen.split('\n').map((line) => line.replace(/^[❯>] /, '  '));
  const target = lines.findIndex((line) => new RegExp(`^  ${row}\\. `).test(line));
  if (target >= 0) lines[target] = lines[target]!.replace(/^  /, '❯ ');
  return lines.join('\n');
}

// The same picker with the model's prose inserted above its question — the part a streaming turn retypes,
// and the shape %5's picker really had (the wording is that interaction's own record).
function withProse(screen: string, prose: readonly string[]): string {
  const lines = screen.split('\n');
  const question = lines.findIndex((line) => line.includes('？'));
  return [...lines.slice(0, question), ...prose, '', ...lines.slice(question)].join('\n');
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

// A fake pane whose capture follows the keys it is sent, so a step can be verified the way a real menu is.
function menuCommands(initial: string, { moves = true }: { moves?: boolean } = {}) {
  let row = 1;
  const keys: Array<[string, string]> = [];
  return {
    keys,
    capturePlain: async () => (row === 1 ? initial : questionScreenAt(row)),
    exitCopyModeIfActive: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    paneInfo: vi.fn(async () => ({ cursorX: 0, cursorY: 0 })), // not part of the menu path, but the type asks
    sendKey: vi.fn(async (pane: string, key: string) => {
      keys.push([pane, key]);
      if (!moves) return;
      if (key === 'Down') row += 1;
      if (key === 'Up') row = Math.max(1, row - 1);
    }),
  };
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

  // CodeBuddy's menus do NOT take the option digit. Measured on 2.156.0 against a live pane: `1` on the
  // AskUserQuestion picker does nothing (repeatedly, and as a literal too), `↓` moves the cursor, and Enter
  // selects; the digit works only on the review screen, which needs no navigation. So the answer is delivered
  // by stepping the cursor and pressing Enter — and the step is verified before anything is selected, because
  // an answer that lands nowhere must not report success.
  it.each([
    ['the question, cursor already on the answer', realQuestionScreen, '红色'],
    ['the review screen', realReviewScreen, 'Submit answers'],
    ['the permission gate', realPermissionScreen, 'Yes'],
  ])('answers %s by pressing Enter on it', async (_label, screen, first) => {
    const run = await lease();
    const commands = menuCommands(screen);
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: commands.capturePlain,
      sendChoice: (pane, choice) => sendCodeBuddyPaneChoice(commands, pane, choice),
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
      expect(commands.keys).toEqual([]); // waits for the shared pane critical section
      gate.resolve(); await preceding;
      expect(await response).toEqual({ status: 'accepted' });
      expect(commands.keys).toEqual([['%1', 'Enter']]);
      expect(commands.sendText).not.toHaveBeenCalled();
      expect(commands.sendEnter).not.toHaveBeenCalled();
    } finally { await handle.close(); }
  });

  it('steps the cursor to the chosen option instead of sending its digit', async () => {
    const run = await lease();
    // The real question menu with the cursor on row 1; the answer asked for is the second one.
    const commands = menuCommands(questionScreenAt(1));
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: commands.capturePlain,
      sendChoice: (pane, choice) => sendCodeBuddyPaneChoice(commands, pane, choice),
    }, 1_000);
    const handle = await adapter.observeNative(run, () => {});
    try {
      const pending = handle.checkpoint.pending[0]!;
      // The menu's own numbers: 3 is `Type something`, a meta row the card does not offer, so the deepest
      // real answer here is option 2 — one step down from the cursor's row.
      expect(pending.options?.map((option) => option.id)).toEqual(['choice:1', 'choice:2']);
      expect(await adapter.dispatchResponse(run, {
        interactionId: pending.id, value: { type: 'selection', optionIds: ['choice:2'] },
      })).toEqual({ status: 'accepted' });
      expect(commands.keys).toEqual([['%1', 'Down'], ['%1', 'Enter']]);
    } finally { await handle.close(); }
  });

  it('reports a failure rather than claiming success when the menu does not move', async () => {
    const run = await lease();
    // A menu that ignores the arrows: the sender must not press Enter on the WRONG row.
    const commands = menuCommands(questionScreenAt(1), { moves: false });
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: commands.capturePlain,
      sendChoice: (pane, choice) => sendCodeBuddyPaneChoice(commands, pane, choice),
    }, 1_000);
    const handle = await adapter.observeNative(run, () => {});
    try {
      const pending = handle.checkpoint.pending[0]!;
      expect(await adapter.dispatchResponse(run, {
        interactionId: pending.id, value: { type: 'selection', optionIds: ['choice:2'] },
      })).toEqual({ status: 'unknown', reason: 'temporarily_unavailable' });
      expect(commands.keys).not.toContainEqual(['%1', 'Enter']);
    } finally { await handle.close(); }
  });

  it('keeps one card while only the cursor and the streaming prose change', async () => {
    const run = await lease();
    let screen = realQuestionScreen;
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: async () => screen, sendChoice: vi.fn(async () => {}),
    }, 30);
    // The checkpoint is a snapshot taken when the stream opened, so the card's identity over time is read
    // from the events the adapter emits: a re-render that mints a new id retires the live card and announces
    // a new one.
    const events: string[] = [];
    const handle = await adapter.observeNative(run, (event) => {
      if (event.type === 'opened') events.push(`opened:${event.interaction.id}`);
      if (event.type === 'resolved') events.push(`resolved:${event.interactionId}`);
    });
    try {
      const first = handle.checkpoint.pending[0]!.id;
      // The cursor moves — anyone navigating the menu …
      screen = questionScreenAt(2);
      await settle();
      // … and the model's prose above the question is retyped, as it is while the turn streams. This is the
      // same question, with the preamble %5's picker really carried (from that interaction's own record).
      screen = withProse(realQuestionScreen, [
        'pulling 9/10 and earlier. Actually that is a good use.',
        '... 4 more lines (press Ctrl+O to expand)',
      ]);
      await settle();
      expect(events).toEqual([]); // one card, never retired, never re-announced
      // A genuinely different question IS a new card.
      screen = realQuestionScreen.replace('喜欢红色还是蓝色？', '换成绿色还是黄色？');
      await settle();
      expect(events).toHaveLength(2);
      expect(events[0]).toBe(`resolved:${first}`);
      expect(events[1]).not.toBe(`opened:${first}`);
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
