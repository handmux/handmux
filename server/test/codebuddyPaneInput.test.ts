import { expect, it, vi } from 'vitest';
import {
  codebuddySingleLineDraft,
  sendCodeBuddyPanePrompt,
} from '../src/agents/codebuddyPaneInput.js';

// CodeBuddy 2.155.0 draws the same one-line editor as Claude, with `>` as the prompt and a right-aligned
// `↵ send` footer painted inside that same line:
//     ────────────────────────────────────────
//     > 检查文件是否创建成功                    ↵ send
//     ────────────────────────────────────────
const screen = (draft: string) => [
  'history',
  '────────────────────────────────────────',
  draft
    ? `> ${draft}${' '.repeat(20)}↵ send`
    : '> Press / to use commands, @ to mention files.',
  '────────────────────────────────────────',
  '? for shortcuts  ← for agents',
  '',
].join('\n');
const cursor = (cursorX: number) => ({ cursorX, cursorY: 2 });

function fixture(initial: string) {
  let draft = initial;
  const commands = {
    exitCopyModeIfActive: vi.fn(async () => {}),
    sendKey: vi.fn(async (_pane: string, key: string) => { if (key === 'C-u') draft = ''; }),
    sendText: vi.fn(async (_pane: string, value: string) => { draft += value; }),
    sendEnter: vi.fn(async () => {}),
    capturePlain: vi.fn(async () => screen(draft)),
    paneInfo: vi.fn(async () => cursor(draft ? draft.length + 2 : 2)),
  };
  return { commands, draft: () => draft };
}

it('reads the draft and ignores the editor footer the app paints inside that line', () => {
  expect(codebuddySingleLineDraft(screen('检查文件是否创建成功'), cursor(12)))
    .toBe('检查文件是否创建成功');
  // An empty editor shows its placeholder after the cursor: nothing was typed.
  expect(codebuddySingleLineDraft(screen(''), cursor(2))).toBe('');
});

it('refuses an editor it cannot recognize instead of deleting unseen text', () => {
  expect(codebuddySingleLineDraft(screen('line one\n  line two'), cursor(10))).toBeNull();
  expect(codebuddySingleLineDraft('> draft', cursor(7))).toBeNull();
  // A rule-less box, an attachment line, or a control character: all fail closed.
  expect(codebuddySingleLineDraft('history\n> draft\nfooter', cursor(7))).toBeNull();
  expect(codebuddySingleLineDraft(screen('bad\x1b[1m'), cursor(9))).toBeNull();
});

it.each(['历史草稿', '请只回复一个字：好'])('replaces only the exact prompt this pane submitted (%s)', async (draft) => {
  const h = fixture(draft);
  expect(await sendCodeBuddyPanePrompt(h.commands, '%1', 'next', () => draft))
    .toEqual({ nativeMutation: true });
  expect(h.draft()).toBe('next');
  expect(h.commands.sendKey.mock.calls).toEqual([['%1', 'End'], ['%1', 'C-u']]);
  expect(h.commands.sendEnter).toHaveBeenCalledOnce();
});

it.each(['handwritten draft', '历史草稿 edited'])('preserves %s and reports a recoverable rejection', async (draft) => {
  const h = fixture(draft);
  expect(await sendCodeBuddyPanePrompt(h.commands, '%1', 'next', () => '历史草稿'))
    .toEqual({ nativeMutation: false, reason: 'terminal_draft_conflict' });
  expect(h.draft()).toBe(draft);
  expect(h.commands.sendText).not.toHaveBeenCalled();
  expect(h.commands.sendEnter).not.toHaveBeenCalled();
});

it('sends into a genuinely empty editor without clearing anything', async () => {
  const h = fixture('');
  expect(await sendCodeBuddyPanePrompt(h.commands, '%1', 'next', () => null))
    .toEqual({ nativeMutation: true });
  expect(h.commands.sendKey.mock.calls).toEqual([['%1', 'End']]);
  expect(h.draft()).toBe('next');
});

it('does not send when the clear key failed to clear the restored prompt', async () => {
  const h = fixture('历史草稿');
  h.commands.sendKey.mockImplementation(async () => {}); // a binding that does not clear
  expect(await sendCodeBuddyPanePrompt(h.commands, '%1', 'next', () => '历史草稿'))
    .toEqual({ nativeMutation: false, reason: 'terminal_draft_conflict' });
  expect(h.commands.sendText).not.toHaveBeenCalled();
  expect(h.draft()).toBe('历史草稿');
});
