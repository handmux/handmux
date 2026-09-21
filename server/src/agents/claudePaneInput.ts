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
      // Unreadable: record the shape, never the text we could not read (see describeEditorArea).
      reportUnreadable?.(describeEditorArea(draft.screen, draft.cursor));
      return { nativeMutation: false, reason: 'terminal_draft_conflict' };
    }
    if (draft.draft !== '' && draft.draft !== restoredPrompt()) {
      return { nativeMutation: false, reason: 'terminal_draft_conflict' };
    }
    if (guard && !await guard.validate()) return { nativeMutation: false };
    if (draft.draft) {
      await commands.sendKey(paneId, 'C-u');
      await delay(SUBMIT_GAP_MS);
      const cleared = await readEditor();
      if (cleared.draft !== '') {
        if (cleared.draft === null) reportUnreadable?.(describeEditorArea(cleared.screen, cleared.cursor));
        return { nativeMutation: false, reason: 'terminal_draft_conflict' };
      }
    }
    await commands.sendText(paneId, text);
    if (text) await delay(SUBMIT_GAP_MS);
    await commands.sendEnter(paneId);
    return { nativeMutation: true };
  });
}
