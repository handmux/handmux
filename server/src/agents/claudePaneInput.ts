import { describeEditorArea, serializePaneInput, singleLineDraft } from '../paneInput.js';
import type { PaneInputCommands, PaneInputGuard, PanePromptResult } from '../paneInput.js';

const SUBMIT_GAP_MS = 120;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ClaudePaneInputCommands extends PaneInputCommands {
  capturePlain(paneId: string): Promise<string>;
  paneInfo(paneId: string): Promise<{ cursorX: number; cursorY: number }>;
}

// Claude's editor is the shared one-line shape, with `❯` as its prompt.
export function claudeSingleLineDraft(screen: string, cursor: { cursorX: number; cursorY: number }): string | null {
  return singleLineDraft(screen, cursor);
}

export function sendClaudePanePrompt(
  commands: ClaudePaneInputCommands,
  paneId: string,
  text: string,
  restoredPrompt: () => string | null,
  guard?: PaneInputGuard,
  reportUnreadable?: (detail: string) => void,
): Promise<PanePromptResult & { reason?: 'terminal_draft_conflict' }> {
  return serializePaneInput(paneId, async () => {
    if (guard && !await guard.validate()) return { nativeMutation: false };
    await commands.exitCopyModeIfActive(paneId);
    await commands.sendKey(paneId, 'End');
    await delay(SUBMIT_GAP_MS);
    const readEditor = async () => {
      const screen = await commands.capturePlain(paneId);
      const cursor = await commands.paneInfo(paneId);
      return { screen, cursor, draft: claudeSingleLineDraft(screen, cursor) };
    };
    const draft = await readEditor();
    if (draft.draft === null) {
      // Unreadable is NOT a conflict with a draft: the screen is simply not an editor right now — an
      // approval menu is the usual reason — so nothing is wrong with the message. Return a plain refusal
      // with no reason, which the Conversation layer reads as "busy": the message stays queued and the next
      // attempt goes through once the pane is showing its editor again. Recording the shape never records
      // text we could not read (see describeEditorArea).
      reportUnreadable?.(describeEditorArea(draft.screen, draft.cursor));
      return { nativeMutation: false };
    }
    if (draft.draft !== '' && draft.draft !== restoredPrompt()) {
      // A draft this pane cannot call its own. Refusing is the point — the alternative is deleting text a
      // human typed — and it needs the user, so it carries the reason the caller blocks on.
      return { nativeMutation: false, reason: 'terminal_draft_conflict' };
    }
    if (guard && !await guard.validate()) return { nativeMutation: false };
    if (draft.draft) {
      await commands.sendKey(paneId, 'C-u');
      await delay(SUBMIT_GAP_MS);
      const cleared = await readEditor();
      if (cleared.draft === null) {
        reportUnreadable?.(describeEditorArea(cleared.screen, cleared.cursor));
        return { nativeMutation: false };
      }
      if (cleared.draft !== '') {
        // The clear did not take: what is in there now is not ours to overwrite.
        return { nativeMutation: false, reason: 'terminal_draft_conflict' };
      }
    }
    await commands.sendText(paneId, text);
    if (text) await delay(SUBMIT_GAP_MS);
    await commands.sendEnter(paneId);
    return { nativeMutation: true };
  });
}
