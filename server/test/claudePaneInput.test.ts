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
