import { describe, expect, it } from 'vitest';
import { describeEditorArea } from '../src/paneInput.js';

// A refused send is the hardest report to act on: the reader judges the editor by exact geometry, so a TUI
// that changes its decoration fails closed, and the phone says「终端有未确认的草稿」over a composer the user
// cannot do anything about. Two field reports in one day (an empty CodeBuddy editor arriving as the bare
// prompt, Claude's composer carrying its session title in the top rule) both needed the reporter's own
// screen capture to see what the pane actually looked like. So the shape is recorded — and a draft the
// reader CAN read never is, because that is somebody's text.
describe('describeEditorArea', () => {
  it('records the rows around the cursor and marks it', () => {
    const screen = [
      'far above', 'above 1', 'above 2', 'above 3', '──── 会话标题 ─', '❯ ',
      '─'.repeat(60), 'below 1', 'below 2', 'far below',
    ].join('\n');
    const detail = describeEditorArea(screen, { cursorX: 2, cursorY: 5 });
    expect(detail).toContain('cursor=(2,5)');
    expect(detail).toContain('4="──── 会话标题 ─"');
    expect(detail).toContain('5*="❯ "'); // the cursor's own row, marked
    expect(detail).toContain('6="' + '─'.repeat(60) + '"');
    // Three rows either way: the far ends of the screen stay out of the log.
    expect(detail).not.toContain('far above');
    expect(detail).not.toContain('far below');
    expect(detail).not.toContain('above 1');
  });

  it('bounds a single row and the whole detail', () => {
    const long = '─'.repeat(5_000);
    const detail = describeEditorArea([long, '❯ x', long].join('\n'), { cursorX: 3, cursorY: 1 });
    expect(detail.length).toBeLessThan(700);
    expect(detail).toContain('…');
  });

  it('says something even when the cursor is past the end of the capture', () => {
    expect(describeEditorArea('one\ntwo', { cursorX: 0, cursorY: 9 })).toContain('cursor=(0,9)');
    expect(describeEditorArea('', { cursorX: 0, cursorY: 0 })).toContain('0*=""');
  });
});
