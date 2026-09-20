import { serializePaneInput, singleLineDraft } from '../paneInput.js';
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
): Promise<PanePromptResult & { reason?: 'terminal_draft_conflict' }> {
  return serializePaneInput(paneId, async () => {
    if (guard && !await guard.validate()) return { nativeMutation: false };
    await commands.exitCopyModeIfActive(paneId);
    await commands.sendKey(paneId, 'End');
    await delay(SUBMIT_GAP_MS);
    const readDraft = async () => claudeSingleLineDraft(await commands.capturePlain(paneId), await commands.paneInfo(paneId));
    const draft = await readDraft();
    if (draft === null || (draft !== '' && draft !== restoredPrompt())) {
      return { nativeMutation: false, reason: 'terminal_draft_conflict' };
    }
    if (guard && !await guard.validate()) return { nativeMutation: false };
    if (draft) {
      await commands.sendKey(paneId, 'C-u');
      await delay(SUBMIT_GAP_MS);
      if (await readDraft() !== '') return { nativeMutation: false, reason: 'terminal_draft_conflict' };
    }
    await commands.sendText(paneId, text);
    if (text) await delay(SUBMIT_GAP_MS);
    await commands.sendEnter(paneId);
    return { nativeMutation: true };
  });
}
