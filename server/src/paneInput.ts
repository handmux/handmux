import { assertRequestAuthority } from './requestAuthority.js';

export interface PaneInputCommands {
  exitCopyModeIfActive(paneId: string): Promise<unknown>;
  sendText(paneId: string, text: string): Promise<unknown>;
  sendEnter(paneId: string): Promise<unknown>;
  sendKey(paneId: string, key: string): Promise<unknown>;
}

export interface PaneInputGuard {
  validate(): boolean | Promise<boolean>;
}

export interface PanePromptResult {
  nativeMutation: boolean;
}

const SUBMIT_GAP_MS = 120;
const paneInputTails = new Map<string, Promise<void>>();
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Every product surface that writes to a tmux pane shares this one per-pane critical section. Keeping
// text + submit in the same operation prevents two clients from interleaving `paste-buffer` and Enter.
export async function serializePaneInput<T>(paneId: string, operation: () => Promise<T>): Promise<T> {
  const previous = paneInputTails.get(paneId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => { assertRequestAuthority(); return operation(); });
  const tail = current.then(() => {}, () => {});
  paneInputTails.set(paneId, tail);
  try {
    return await current;
  } finally {
    if (paneInputTails.get(paneId) === tail) paneInputTails.delete(paneId);
  }
}

// One-line native editor, as every Claude-lineage TUI draws it: `<prompt> value` on the cursor's line with
// a rule above and below. Wrapped input, attachments, selection menus and unknown layouts fail closed
// (null) — the caller must never delete content it could not read. Callers send End first: placeholder text
// is painted after the cursor but is not part of the editor, while real text leaves the cursor at its end.
// `hint` strips a right-aligned footer the editor paints inside that same line (e.g. CodeBuddy's "↵ send").
export function singleLineDraft(
  screen: string,
  cursor: { cursorX: number; cursorY: number },
  prompt = '\u276f',
  hint?: RegExp,
): string | null {
  const lines = screen.split('\n');
  const line = lines[cursor.cursorY];
  const start = prompt.length + 1;
  if (!line || !/^\u2500{3,}$/.test(lines[cursor.cursorY - 1]?.trim() ?? '')
    || !/^\u2500{3,}$/.test(lines[cursor.cursorY + 1]?.trim() ?? '')
    || !line.startsWith(`${prompt} `) && !line.startsWith(`${prompt}\u00a0`)) return null;
  let value = hint ? line.slice(start).replace(hint, '') : line.slice(start);
  value = value.trimEnd();
  if (cursor.cursorX === start) return ''; // Native suggestions are painted here but End does not enter them.
  if (!value || /[\x00-\x1f\x7f]/.test(value) || cursor.cursorX <= start) return null;
  return value;
}

export function sendPanePrompt(
  commands: PaneInputCommands,
  paneId: string,
  text: string,
  guard?: PaneInputGuard,
): Promise<PanePromptResult> {
  return serializePaneInput(paneId, async () => {
    if (guard && !await guard.validate()) return { nativeMutation: false };
    await commands.exitCopyModeIfActive(paneId);
    assertRequestAuthority();
    await commands.sendText(paneId, text);
    if (text) await delay(SUBMIT_GAP_MS);
    assertRequestAuthority();
    await commands.sendEnter(paneId);
    return { nativeMutation: true };
  });
}

export function interruptPane(commands: PaneInputCommands, paneId: string): Promise<void> {
  return serializePaneInput(paneId, async () => {
    await commands.exitCopyModeIfActive(paneId);
    assertRequestAuthority();
    await commands.sendKey(paneId, 'C-c');
  });
}

export function interruptClaudePane(commands: PaneInputCommands, paneId: string): Promise<void> {
  return serializePaneInput(paneId, async () => {
    await commands.exitCopyModeIfActive(paneId);
    await commands.sendKey(paneId, 'Escape');
  });
}

export function sendPaneChoice(
  commands: PaneInputCommands,
  paneId: string,
  choice: string,
): Promise<void> {
  if (!/^[1-9]$/.test(choice)) throw new TypeError('Pane choice requires a single option digit');
  return serializePaneInput(paneId, async () => {
    await commands.exitCopyModeIfActive(paneId);
    assertRequestAuthority();
    // Menu shortcuts are key events; bracketed paste is not handled by Claude's selector.
    await commands.sendKey(paneId, choice);
  });
}
