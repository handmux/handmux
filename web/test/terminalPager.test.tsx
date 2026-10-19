import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import TerminalOverlays, { type TerminalOverlaysProps } from '../src/components/TerminalOverlays.js';

afterEach(cleanup);
const styles = document.createElement('style');
beforeAll(() => {
  styles.textContent = readFileSync('src/styles.css', 'utf8');
  document.head.appendChild(styles);
});
afterAll(() => styles.remove());

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
    expect(toggle.querySelectorAll('circle')).toHaveLength(3);
    expect(toggle.querySelector('path')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByRole('button', { name: '上翻页' })).toBeNull();
    expect(view.getAllByRole('button')).toHaveLength(1);

    fireEvent.click(toggle);
    expect(view.container.querySelector('.term-pager button')).toBe(toggle);
    expect(toggle.querySelectorAll('circle')).toHaveLength(0);
    const closePath = toggle.querySelector('path')?.getAttribute('d');
    expect(closePath).toBe('M7 7l10 10M17 7L7 17');
    for (const label of ['上翻页', '下翻页']) {
      expect(closePath).not.toBe(view.getByRole('button', { name: label }).querySelector('path')?.getAttribute('d'));
    }
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
    expect(view.getAllByRole('button')).toHaveLength(1);
    expect(view.queryByRole('button', { name: '定位光标行' })).toBeNull();
    expect(callbacks.onToggleLocate).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole('button', { name: '展开终端工具' }));
    expect(view.getByRole('button', { name: '定位光标行' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('preserves the same layout space on collapse without hidden hit targets or tab stops', () => {
    const view = render(<TerminalOverlays {...props()} />);
    const pager = view.getByRole('group', { name: '翻页' });
    const toggle = view.getByRole('button', { name: '展开终端工具' });
    const groups = Array.from(pager.querySelectorAll<HTMLElement>('.term-pager-grp'));
    // visibility keeps the same flex layout in both states; jsdom cannot measure screen coordinates.
    expect(groups).toHaveLength(3);
    // Safe centering falls back to the visible top when the controls cannot fit; targets never shrink.
    expect(getComputedStyle(pager).justifyContent).toBe('safe center');
    expect(getComputedStyle(pager).paddingBlock).toBe('28px');
    expect(getComputedStyle(pager).boxSizing).toBe('border-box');
    expect(getComputedStyle(pager).pointerEvents).toBe('none');
    expect(getComputedStyle(groups[0]!).pointerEvents).toBe('auto');
    for (const group of groups.slice(1)) {
      expect(getComputedStyle(group).display).toBe('flex');
      expect(getComputedStyle(group).flexShrink).toBe('0');
      expect(getComputedStyle(group).visibility).toBe('hidden');
      expect(getComputedStyle(group).pointerEvents).toBe('none');
      expect(group.getAttribute('aria-hidden')).toBe('true');
      for (const button of group.querySelectorAll('button')) expect(button.tabIndex).toBe(-1);
    }
    fireEvent.click(toggle);
    for (const [index, group] of groups.entries()) {
      expect(pager.children[index]).toBe(group);
      expect(getComputedStyle(group).display).toBe('flex');
      expect(getComputedStyle(group).visibility).toBe('visible');
      expect(getComputedStyle(group).pointerEvents).toBe('auto');
      for (const button of group.querySelectorAll('button')) expect(button.tabIndex).toBe(0);
    }
    fireEvent.click(toggle);
    for (const [index, group] of groups.entries()) expect(pager.children[index]).toBe(group);
    expect(view.getAllByRole('button')).toEqual([toggle]);
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
