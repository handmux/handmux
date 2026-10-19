import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TerminalOverlays, { type TerminalOverlaysProps } from '../src/components/TerminalOverlays.js';

afterEach(cleanup);

const props = (overrides: Partial<TerminalOverlaysProps> = {}): TerminalOverlaysProps => ({
  ready: true, connectionInfo: null, configuredTransport: 'live', transportFallback: null,
  transportOpen: false, transportNow: 0, onTransportToggle: vi.fn(), connected: true,
  inputFailure: null, dbgVisible: false, dbg: '', scrollInfo: '', selInfo: '', onResume: vi.fn(),
  altScreen: true, onPageScroll: vi.fn(), onFitScreen: vi.fn(), locateOn: false,
  onToggleLocate: vi.fn(), selUI: null, onCopy: vi.fn(),
  selActionsRef: { current: null }, termRef: { current: null }, ...overrides,
});

describe('full-screen terminal pager', () => {
  it('starts collapsed and only exposes the four original actions when expanded', () => {
    const callbacks = props();
    const view = render(<TerminalOverlays {...callbacks} />);
    const toggle = view.getByRole('button', { name: '展开终端工具' });
    expect(view.container.querySelector('.term-pager button')).toBe(toggle);
    expect(toggle.querySelector('path')?.getAttribute('d')).toBe('M6 9.5l6 6 6-6');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByRole('button', { name: '上翻页' })).toBeNull();
    expect(view.container.querySelectorAll('.term-pager button')).toHaveLength(1);

    fireEvent.click(toggle);
    expect(view.container.querySelector('.term-pager button')).toBe(toggle);
    expect(toggle.querySelector('path')?.getAttribute('d')).toBe('M6 14.5l6-6 6 6');
    expect(view.getByRole('button', { name: '收起终端工具' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(view.getByRole('button', { name: '上翻页' }));
    fireEvent.click(view.getByRole('button', { name: '下翻页' }));
    fireEvent.click(view.getByRole('button', { name: '适配高度' }));
    fireEvent.click(view.getByRole('button', { name: '定位光标行' }));
    expect(callbacks.onPageScroll).toHaveBeenNthCalledWith(1, 'up');
    expect(callbacks.onPageScroll).toHaveBeenNthCalledWith(2, 'down');
    expect(callbacks.onFitScreen).toHaveBeenCalledTimes(1);
    expect(callbacks.onToggleLocate).toHaveBeenCalledTimes(1);

    view.rerender(<TerminalOverlays {...callbacks} locateOn />);
    expect(view.getByRole('button', { name: '定位光标行' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(view.getByRole('button', { name: '收起终端工具' }));
    expect(view.container.querySelectorAll('.term-pager button')).toHaveLength(1);
    expect(view.queryByRole('button', { name: '定位光标行' })).toBeNull();
    expect(callbacks.onToggleLocate).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole('button', { name: '展开终端工具' }));
    expect(view.getByRole('button', { name: '定位光标行' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('does not show controls outside a full-screen program', () => {
    const view = render(<TerminalOverlays {...props({ altScreen: false })} />);
    expect(view.queryByRole('group', { name: '翻页' })).toBeNull();
    expect(view.queryByRole('button', { name: '展开终端工具' })).toBeNull();
  });

  it('preserves the focused input when the toggle is pressed', () => {
    const view = render(<><textarea aria-label="命令输入" /><TerminalOverlays {...props()} /></>);
    const input = view.getByRole('textbox');
    input.focus();
    const toggle = view.getByRole('button', { name: '展开终端工具' });
    expect(fireEvent.pointerDown(toggle, { cancelable: true })).toBe(false);
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(input);
  });
});
