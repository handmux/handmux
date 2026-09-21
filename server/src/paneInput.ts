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
//
// Trailing blanks are removed before the line is judged, because how the EMPTY editor looks is not stable:
// Claude writes a non-breaking space after its prompt (which a capture keeps), CodeBuddy a plain one (which
// a capture trims as a trailing blank), so a genuinely empty editor arrives as the bare prompt. Reading
// that as unrecognizable — rather than as empty — refused every send to an idle CodeBuddy pane, and even
// refused the step that verifies our own stale prompt had been cleared, since clearing it produces exactly
// that line. Nothing is lost by trimming: a line that carries only the prompt cannot be hiding text, and
// the rules above and below are what prove this line is the editor rather than a prompt character that
// happens to sit somewhere in the transcript.
//
// The rule ABOVE the editor is not always bare either: Claude Code paints the session title inside it
// (`──── my session title ─`), so a pure run of dashes rejected every send in a titled session — reported
// from the field with per-pane captures, all of them empty editors waiting for input. It therefore accepts
// a dash run that opens the line and closes it with the title painted between; the line BELOW stays bare,
// which is what the same captures show (and what keeps an unrelated decorated line from pairing with the
// prompt into a false editor box).
const RULE_RE = /^\u2500{3,}$/;
const TITLED_RULE_RE = /^\u2500{3,}(?:\s*\S.*\s*\u2500{1,})?$/;

// Why a send was refused has to be diagnosable from the log alone. The editor is judged by exact geometry,
// and when a TUI changes its decoration the reader fails closed: the phone tells the user to "handle the
// draft in the terminal" while they look at an empty composer they cannot do anything about. That happened
// twice in one day (an empty CodeBuddy editor arriving as the bare prompt, a Claude composer whose top rule
// carries the session title), and both times the shape had to come from the reporter's own screen capture.
//
// So when — and ONLY when — the editor could not be read at all, the rows around the cursor are recorded.
// A draft we CAN read is somebody's text and is never logged: a readable-but-foreign draft is a normal
// refusal with a known cause and no diagnostic value.
const DETAIL_ROWS = 3;
const DETAIL_ROW_MAX = 120;
const DETAIL_MAX = 600;

export function describeEditorArea(
  screen: string,
  cursor: { cursorX: number; cursorY: number; },
  rows = DETAIL_ROWS,
): string {
  const lines = screen.split('\n');
  const from = Math.max(0, cursor.cursorY - rows);
  const to = Math.min(lines.length - 1, cursor.cursorY + rows);
  const parts = [`cursor=(${cursor.cursorX},${cursor.cursorY})`];
  for (let i = from; i <= to; i++) {
    const line = lines[i] ?? '';
    const clamped = line.length > DETAIL_ROW_MAX ? `${line.slice(0, DETAIL_ROW_MAX)}…` : line;
    // JSON so escapes of control characters cannot break the surrounding log line.
    parts.push(`${i}${i === cursor.cursorY ? '*' : ''}=${JSON.stringify(clamped)}`);
  }
  const detail = parts.join(' ');
  return detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail;
}

export function singleLineDraft(
  screen: string,
  cursor: { cursorX: number; cursorY: number },
  prompt = '\u276f',
  hint?: RegExp,
): string | null {
  const lines = screen.split('\n');
  const line = lines[cursor.cursorY];
  if (!line || !TITLED_RULE_RE.test(lines[cursor.cursorY - 1]?.trim() ?? '')
    || !RULE_RE.test(lines[cursor.cursorY + 1]?.trim() ?? '')) return null;
  const body = line.trimEnd();
  if (!body.startsWith(prompt)) return null;
  const rest = body.slice(prompt.length);
  if (!rest) return ''; // The prompt and nothing else: the editor is empty.
  if (rest[0] !== ' ' && rest[0] !== '\u00a0') return null;
  const start = prompt.length + 1;
  let value = hint ? rest.slice(1).replace(hint, '') : rest.slice(1);
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
