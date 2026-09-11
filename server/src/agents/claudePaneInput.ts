import { serializePaneInput } from '../paneInput.js';
import type { PaneInputCommands, PaneInputGuard, PanePromptResult } from '../paneInput.js';

const SUBMIT_GAP_MS = 120;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ClaudePaneInputCommands extends PaneInputCommands {
  capturePlain(paneId: string): Promise<string>;
  paneInfo(paneId: string): Promise<{ cursorX: number; cursorY: number }>;
}

// Read the entire one-line native editor, bounded by its two rules. Wrapped input, attachments,
// selection menus and unknown layouts fail closed. End is sent first: placeholder text is painted
// after the cursor but isn't part of the editor; actual text places the cursor at its end.
export function claudeSingleLineDraft(screen: string, cursor: { cursorX: number; cursorY: number }): string | null {
  const lines = screen.split('\n');
  const line = lines[cursor.cursorY];
  if (!line || !/^─{3,}$/.test(lines[cursor.cursorY - 1]?.trim() ?? '')
    || !/^─{3,}$/.test(lines[cursor.cursorY + 1]?.trim() ?? '')
    || !/^❯[ \u00a0]/.test(line)) return null;
  const value = line.slice(2).trimEnd();
  if (cursor.cursorX === 2) return ''; // Native suggestions are painted here but End does not enter them.
  if (!value || /[\x00-\x1f\x7f]/.test(value) || cursor.cursorX <= 2) return null;
  return value;
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
