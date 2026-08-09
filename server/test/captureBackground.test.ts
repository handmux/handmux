import { describe, expect, it, vi } from 'vitest';
import {
  ambiguousBackgroundRows,
  restoreCaptureBackgrounds,
} from '../src/captureBackground.js';

describe('capture background restoration', () => {
  it('finds only blank rows whose background is ambiguous in a combined capture', () => {
    expect(ambiguousBackgroundRows([
      '\x1b[48;5;237mtext',
      '        ',
      '        ',
      '\x1b[49mplain',
      '        ',
    ])).toEqual([1]);
  });

  it('keeps a Codex padding row when its isolated tmux row has a real background', async () => {
    const readRow = vi.fn(async (_row: number): Promise<string> => '\x1b[48;2;59;64;75m        \n');
    const restored = await restoreCaptureBackgrounds(
      '\x1b[48;2;59;64;75m        \ntext\n        \n\x1b[49mplain\n',
      4,
      readRow,
    );

    expect(readRow).toHaveBeenCalledWith(2);
    expect(restored.ansi.split('\n')[2]).toBe('\x1b[48;2;59;64;75m        ');
  });

  it('closes a Claude background before a blank row that tmux reports as default', async () => {
    const readRow = vi.fn(async (_row: number): Promise<string> => '        \n');
    const restored = await restoreCaptureBackgrounds(
      '\x1b[48;5;237m❯ hi   \n        \n\x1b[49mreply\n',
      3,
      readRow,
    );

    expect(readRow).toHaveBeenCalledWith(1);
    expect(restored.ansi.split('\n')[1]).toBe('\x1b[49m        ');
  });

  it('maps captured scrollback indexes back to tmux negative row coordinates', async () => {
    const readRow = vi.fn(async (_row: number): Promise<string> => '        \n');
    await restoreCaptureBackgrounds(
      'old\n\x1b[48;5;237m❯ hi\n        \n\x1b[49mreply\n',
      2,
      readRow,
    );

    expect(readRow).toHaveBeenCalledWith(0);
  });
});
