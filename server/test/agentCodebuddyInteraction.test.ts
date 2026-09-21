import { describe, expect, it, vi } from 'vitest';
import { createCodeBuddyInteractionAdapter } from '../src/agents/codebuddyInteraction.js';
import { serializePaneInput } from '../src/paneInput.js';
import { sendPaneMenuChoice } from '../src/paneInput.js';
import { InteractionService } from '../src/agent-runtime/interaction.js';
import type { InteractionEvent } from '../src/agent-runtime/interactionTypes.js';
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
function questionScreenAt(screen: string, row: number): string {
  const lines = screen.split('\n').map((line) => line.replace(/^[❯>] /, '  '));
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
    capturePlain: async () => (row === 1 ? initial : questionScreenAt(initial, row)),
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

  // Which key answers a CodeBuddy menu depends on the screen — measured against live panes on 2.156.0, each
  // shape on its own so one screen's success can never be credited to another:
  //
  //   AskUserQuestion picker  the digit is IGNORED (sent repeatedly, and as a literal), `↓` moves the cursor,
  //                           Enter selects
  //   review screen           the digit works AND `↓`/`↑` + Enter work
  //   permission gate         the digit works (`1` approved the command and it really ran)
  it.each([
    ['the question, cursor already on the answer', realQuestionScreen, '红色'],
    ['the review screen, cursor already on Submit', realReviewScreen, 'Submit answers'],
  ])('answers %s by pressing Enter on it', async (_label, screen, first) => {
    const run = await lease();
    const commands = menuCommands(screen);
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: commands.capturePlain,
      sendChoice: (pane, choice) => sendPaneMenuChoice(commands, pane, choice),
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

  it('answers the permission gate with its digit, the key that names the row', async () => {
    const run = await lease();
    const commands = menuCommands(realPermissionScreen);
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: commands.capturePlain,
      sendChoice: (pane, choice) => sendPaneMenuChoice(commands, pane, choice),
    }, 1_000);
    const handle = await adapter.observeNative(run, () => {});
    try {
      const pending = handle.checkpoint.pending[0]!;
      expect(pending.type).toBe('select');
      expect(await adapter.dispatchResponse(run, {
        interactionId: pending.id, value: { type: 'selection', optionIds: ['choice:1'] },
      })).toEqual({ status: 'accepted' });
      // The gate takes the digit, and the digit is what it should get: it names the row instead of walking
      // to it, so on a gate — where the wrong row means approving something else — a misread cursor can
      // never change which answer is committed.
      expect(commands.keys).toEqual([['%1', '1']]);
    } finally { await handle.close(); }
  });

  it.each([
    ['the question menu', realQuestionScreen],
    ['the review screen', realReviewScreen],
  ])('walks the cursor to the chosen option on %s, whose digit it ignores', async (_label, screen) => {
    const run = await lease();
    // The real screen with the cursor on row 1; the answer asked for is the second row.
    const commands = menuCommands(questionScreenAt(screen, 1));
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: commands.capturePlain,
      sendChoice: (pane, choice) => sendPaneMenuChoice(commands, pane, choice),
    }, 1_000);
    const handle = await adapter.observeNative(run, () => {});
    try {
      const pending = handle.checkpoint.pending[0]!;
      expect(await adapter.dispatchResponse(run, {
        interactionId: pending.id, value: { type: 'selection', optionIds: ['choice:2'] },
      })).toEqual({ status: 'accepted' });
      expect(commands.keys).toEqual([['%1', 'Down'], ['%1', 'Enter']]);
    } finally { await handle.close(); }
  });

  it('reports a failure rather than claiming success when the menu does not move', async () => {
    const run = await lease();
    // A menu that ignores the arrows: the sender must not press Enter on the WRONG row.
    const commands = menuCommands(questionScreenAt(realQuestionScreen, 1), { moves: false });
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: commands.capturePlain,
      sendChoice: (pane, choice) => sendPaneMenuChoice(commands, pane, choice),
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

  // The live sequence that left pane %5 stuck on its review screen (2026-09-21): the review card was up, the
  // phone left, and by the time it reconnected the pane was back on the question menu — which retired the
  // review card as "already answered, off screen". Answering that question advanced the pane to the SAME
  // review screen, and because that screen's shape is identical every time it carried the id of the card the
  // service had just retired. The service refused the re-opened id and failed the whole observation closed, so
  // the phone was left with no card at all while the pane waited for a Submit nobody could press.
  it('surfaces the review screen again after answering, though its shape was just retired', async () => {
    const runtime = new AgentRunRuntime({ newRunId: () => 'run-codebuddy' });
    const run = await runtime.controller('codebuddy', async () => true).attach({
      paneId: '%5', attachmentId: 'codebuddy-hooks', sessionId: 'session-1', process: { pid: 401 },
    });
    let screen = realReviewScreen;
    const adapter = createCodeBuddyInteractionAdapter({
      capturePlain: async () => screen, sendChoice: async () => {},
    }, 20);
    const service = new InteractionService({ runs: runtime, adapters: { codebuddy: adapter } });

    const first = await service.open(run, () => {});
    expect(first.pending.map((item) => item.prompt)).toEqual([
      expect.stringContaining('Ready to submit your answers?'),
    ]);
    await first.close();

    screen = realQuestionScreen;
    const events: InteractionEvent[] = [];
    const second = await service.open(run, (event) => { events.push(event); });
    const question = second.pending[0]!;
    expect(question.prompt).toContain('喜欢红色还是蓝色？');

    // Answering the question is what advances this pane to its review screen.
    expect(await service.respond(run, {
      interactionId: question.id, resolutionToken: question.resolutionToken,
      value: { type: 'selection', optionIds: ['choice:1'] },
    })).toEqual({ status: 'accepted' });
    screen = realReviewScreen;

    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: 'opened',
      interaction: expect.objectContaining({
        prompt: expect.stringContaining('Ready to submit your answers?'),
      }),
    })), { timeout: 2_000 });
    await second.close();
  });
});
