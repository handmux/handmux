import { expect, it, vi } from 'vitest';
import { claudeSingleLineDraft, sendClaudePanePrompt } from '../src/agents/claudePaneInput.js';

const screen = (draft: string) => `history\n────────────\n❯ ${draft}\n────────────\nfooter\n`;
const cursor = (cursorX: number) => ({ cursorX, cursorY: 2 });
function fixture(initial: string) {
  let draft = initial;
  const commands = {
    exitCopyModeIfActive: vi.fn(async () => {}),
    sendKey: vi.fn(async (_pane: string, key: string) => { if (key === 'C-u') draft = ''; }),
    sendText: vi.fn(async (_pane: string, value: string) => { draft += value; }),
    sendEnter: vi.fn(async () => {}),
    capturePlain: vi.fn(async () => screen(draft || 'Try "write a test"')),
    paneInfo: vi.fn(async () => cursor(draft.length + 2)),
  };
  return { commands, draft: () => draft };
}

it.each(['old draft', '请只回复一个字：好'])('replaces only the exact recovered prompt (%s)', async (draft) => {
  const h = fixture(draft);
  expect(await sendClaudePanePrompt(h.commands, '%1', 'next', () => draft)).toEqual({ nativeMutation: true });
  expect(h.draft()).toBe('next');
  expect(h.commands.sendEnter).toHaveBeenCalledOnce();
});

it('accepts a genuinely empty editor containing a native placeholder', async () => {
  const h = fixture('');
  expect(await sendClaudePanePrompt(h.commands, '%1', 'next', () => null)).toEqual({ nativeMutation: true });
  expect(h.commands.sendKey.mock.calls).toEqual([['%1', 'End']]);
});

it('reads the empty editor whether the capture kept the blank after the prompt or trimmed it', () => {
  // Claude paints a non-breaking space, which a capture keeps …
  expect(claudeSingleLineDraft(screen(''), cursor(2))).toBe('');
  // … while a provider painting a plain one reaches us as the bare prompt, since the capture trims that
  // blank. Same empty editor, and the reader is shared, so both spellings must answer the same way.
  expect(claudeSingleLineDraft('history\n────────────\n❯\n────────────\nfooter\n', cursor(2))).toBe('');
  // Trailing blanks only: content after the prompt is read exactly as before.
  expect(claudeSingleLineDraft('history\n────────────\n❯ old draft   \n────────────\nfooter\n', cursor(11)))
    .toBe('old draft');
});

// Reported from the field (issue #7): Claude Code paints the session title INSIDE the composer's top rule,
// which the pure-dash requirement rejected — so a session with a title could never be sent to from the
// phone, while untitled sessions in the same tmux server were fine. These screens are that report's own
// captures (`──── 会话标题 ─` above the prompt, a bare rule below).
// (the excerpt starts one row above so the prompt sits where the shared fixture's cursor already is)
const titledScreen = (draft: string) => ['history', '──── 会话标题 ─', `❯ ${draft}`, '─'.repeat(60), ''].join('\n');

it('reads a titled session, whose top rule carries its title', () => {
  expect(claudeSingleLineDraft(titledScreen(''), { cursorY: 2, cursorX: 2 })).toBe('');
  expect(claudeSingleLineDraft(titledScreen('hello'), { cursorY: 2, cursorX: 7 })).toBe('hello');
});

it('sends into a titled session instead of reporting a draft conflict', async () => {
  const h = fixture('');
  h.commands.capturePlain.mockImplementation(async () => titledScreen(''));
  expect(await sendClaudePanePrompt(h.commands, '%1', 'next', () => null)).toEqual({ nativeMutation: true });
  expect(h.commands.sendEnter).toHaveBeenCalledOnce();
});

it('still requires the rule BELOW the editor to be bare', () => {
  // The same captures show the bottom rule carrying nothing, and keeping it strict is what stops an
  // unrelated decorated line from pairing with a prompt into a false editor box.
  expect(claudeSingleLineDraft(['─'.repeat(60), '❯ hello', '──── 会话标题 ─'].join('\n'),
    { cursorY: 1, cursorX: 7 })).toBeNull();
});

it.each(['handwritten draft', 'old draft edited'])('preserves %s and returns a recoverable rejection', async (draft) => {
  const h = fixture(draft);
  expect(await sendClaudePanePrompt(h.commands, '%1', 'next', () => 'old draft'))
    .toEqual({ nativeMutation: false, reason: 'terminal_draft_conflict' });
  expect(h.draft()).toBe(draft);
  expect(h.commands.sendText).not.toHaveBeenCalled();
  expect(h.commands.sendEnter).not.toHaveBeenCalled();
});

it('rejects a wrapped or unrecognized editor instead of deleting unseen content', () => {
  expect(claudeSingleLineDraft(screen('line one\n  line two'), cursor(10))).toBeNull();
  expect(claudeSingleLineDraft('❯ draft', { cursorX: 7, cursorY: 0 })).toBeNull();
});

it('does not send if a remapped clear key did not clear the exact recovered draft', async () => {
  const h = fixture('old draft');
  h.commands.sendKey.mockImplementation(async () => {});
  expect(await sendClaudePanePrompt(h.commands, '%1', 'next', () => 'old draft'))
    .toEqual({ nativeMutation: false, reason: 'terminal_draft_conflict' });
  expect(h.commands.sendText).not.toHaveBeenCalled();
  expect(h.draft()).toBe('old draft');
});

it('ignores a native AI suggested follow-up when End still leaves the real input cursor at column two', () => {
  expect(claudeSingleLineDraft(screen('继续写出剩下的内容'), cursor(2))).toBe('');
});
