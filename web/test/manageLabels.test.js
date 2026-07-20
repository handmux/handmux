import { describe, it, expect } from 'vitest';
import { windowManageSubtitle, paneManageSubtitle } from '../src/manageLabels.js';

describe('management sheet labels', () => {
  it('describes a window by name and its real dimensions', () => {
    expect(windowManageSubtitle({ id: '@2', name: 'work', width: 160, height: 48 }))
      .toBe('work · 160×48');
  });

  it('falls back to the window id and omits unavailable dimensions', () => {
    expect(windowManageSubtitle({ id: '@2', name: '' })).toBe('@2');
  });

  it('describes the managed pane by sequence, command, and dimensions', () => {
    const panes = [
      { id: '%1', command: 'zsh', width: 80, height: 24 },
      { id: '%2', command: 'node', width: 39, height: 24 },
    ];
    expect(paneManageSubtitle(panes, '%2')).toBe('② node · 39×24');
  });

  it('returns an empty pane subtitle when the managed pane disappeared', () => {
    expect(paneManageSubtitle([{ id: '%1', command: 'zsh' }], '%9')).toBe('');
  });
});
