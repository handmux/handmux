import { expect, it, vi } from 'vitest';
import {
  codebuddySingleLineDraft,
  sendCodeBuddyPanePrompt,
} from '../src/agents/codebuddyPaneInput.js';

// CodeBuddy draws the same one-line editor as Claude, with `>` as the prompt and a right-aligned `↵ send`
// footer painted inside that same line once there is draft text:
//     ────────────────────────────────────────
//     > 检查文件是否创建成功                    ↵ send
//     ────────────────────────────────────────
//
// An EMPTY editor is the prompt ALONE — captured from a live 2.156.0 pane, character for character. The
// plain space CodeBuddy paints after its prompt is trimmed by `capture-pane` as a trailing blank, so none
// of it reaches us (unlike Claude's non-breaking space, which survives). Modelling the empty editor as a
// placeholder line is what let this reader look correct while refusing every real send.
const screen = (draft: string) => [
  'history',
  '────────────────────────────────────────',
  draft ? `> ${draft}${' '.repeat(20)}↵ send` : '>',
  '────────────────────────────────────────',
  '? for shortcuts  ← for agents',
  '',
].join('\n');
// A native suggestion is painted after the prompt while the editor is still empty, which in code points is
// the placeholder an empty editor used to be modelled as. The cursor sits at the start, so it is not text.
const suggestionScreen = (text: string) => [
  'history',
  '────────────────────────────────────────',
  `> ${text}`,
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
  // The empty editor as the machine really draws it: the prompt and nothing after it, because the blank
  // CodeBuddy paints was trimmed by the capture. Reading this as unrecognizable (rather than as empty) is
  // what refused every send — and every post-clear verification — on an idle CodeBuddy pane.
  expect(codebuddySingleLineDraft(screen(''), cursor(2))).toBe('');
  expect(codebuddySingleLineDraft(screen(''), cursor(2))).not.toBeNull();
  // A native suggestion is painted after the cursor, not typed: still an empty editor.
  expect(codebuddySingleLineDraft(suggestionScreen('Press / to use commands'), cursor(2))).toBe('');
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

it('records the shape when the composer cannot be read, and never a draft it could read', async () => {
  // Unreadable: not an editor on screen right now, which says nothing about the message. No reason, so the
  // row stays queued for the next attempt rather than being blocked.
  const unreadable = fixture('');
  const report = vi.fn();
  unreadable.commands.capturePlain.mockImplementation(async () => 'history\n<<a layout the reader does not know>>\n');
  expect(await sendCodeBuddyPanePrompt(unreadable.commands, '%1', 'next', () => null, undefined, report))
    .toEqual({ nativeMutation: false });
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]?.[0]).toContain('cursor=(');
  expect(unreadable.commands.sendText).not.toHaveBeenCalled();

  // A draft it CAN read, belonging to somebody else: refusal that needs the user, so it carries the reason.
  const foreign = fixture('handwritten draft');
  const quiet = vi.fn();
  expect(await sendCodeBuddyPanePrompt(foreign.commands, '%1', 'next', () => '历史草稿', undefined, quiet))
    .toEqual({ nativeMutation: false, reason: 'terminal_draft_conflict' });
  expect(quiet).not.toHaveBeenCalled();
});
