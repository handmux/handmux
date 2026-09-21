// CodeBuddy's pane input: the delivery and interrupt semantics for its TUI. The mechanics are shared
// (paneInput.ts owns the per-pane critical section, the text+submit gap and the one-line editor reader);
// what is CodeBuddy's is the editor's own shape and the keys its keybindings document.
//
// Measured on 2.156.0, its editor is the same one-line box Claude draws, with `>` as the prompt and a
// right-aligned `↵ send` footer painted inside the same line once there is draft text:
//
//     ────────────────────────────────────────────────
//     > 检查文件是否创建成功                            ↵ send
//     ────────────────────────────────────────────────
//     ? for shortcuts  ← for agents
//
// With no draft text the capture arrives as the bare `>`: the plain space CodeBuddy paints after its prompt
// is a trailing blank, which `capture-pane` drops (Claude's non-breaking space survives). The reader treats
// that as the empty editor it is — see `singleLineDraft`. The distinction matters downstream: the same line
// is what a cleared editor looks like, so reading it as unrecognizable refused both the send itself and the
// check that our own stale prompt had been cleared.
//
// Interrupt is `esc`: the pane's own footer says so (`✹ Buzzing… (esc to interrupt)`) and Escape really does
// stop it — measured, see `interruptAgentPane` in paneInput.ts. CodeBuddy's published keybindings list
// `ctrl+c → app:interrupt` (ctrl+d is exit); sending that one mid-tool did nothing at all.
import { describeEditorArea, serializePaneInput, singleLineDraft } from '../paneInput.js';
import type { PaneInputCommands, PaneInputGuard, PanePromptResult } from '../paneInput.js';

const SUBMIT_GAP_MS = 120;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The footer the editor paints at the right edge of the draft line. Stripped before the draft is judged,
// so `> draft  ↵ send` reads as `draft` while the footer itself can never be mistaken for typed text.
const EDITOR_HINT_RE = /[\s\u00a0]*↵\s*\S+[\s\u00a0]*$/;

interface CodeBuddyPaneInputCommands extends PaneInputCommands {
  capturePlain(paneId: string): Promise<string>;
  paneInfo(paneId: string): Promise<{ cursorX: number; cursorY: number }>;
}

export function codebuddySingleLineDraft(
  screen: string,
  cursor: { cursorX: number; cursorY: number },
): string | null {
  return singleLineDraft(screen, cursor, '>', EDITOR_HINT_RE);
}

// Send a prompt the way the composer means it: replace only a draft this pane is KNOWN to own (the prompt
// we restored from the run's own submission) and never a draft a human typed — that is a refusal the caller
// can surface, not a silent deletion. Anything the reader cannot recognize refuses too.
export function sendCodeBuddyPanePrompt(
  commands: CodeBuddyPaneInputCommands,
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
      return { screen, cursor, draft: codebuddySingleLineDraft(screen, cursor) };
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
      // Clear our own stale prompt. The key is unverified against a live CodeBuddy editor (its published
      // keybindings cover app-level keys only), so the result is verified before anything is sent — a
      // binding that does not clear leaves us refusing, never appending to unseen text.
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
