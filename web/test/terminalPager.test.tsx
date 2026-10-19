import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import TerminalOverlays, { type TerminalOverlaysProps } from '../src/components/TerminalOverlays.js';

const PREFERENCE_KEY = 'tw_terminal_pager';
beforeEach(() => localStorage.removeItem(PREFERENCE_KEY));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.removeItem(PREFERENCE_KEY);
});
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

const pointer = (target: HTMLElement, type: string, values: Record<string, unknown> = {}) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const fields = { pointerId: 1, isPrimary: true, button: 0, clientX: 100, clientY: 191.5, ...values };
  for (const [name, value] of Object.entries(fields)) Object.defineProperty(event, name, { value });
  fireEvent(target, event);
};
const draggable = () => {
  const view = render(<TerminalOverlays {...props()} />);
  const pager = view.getByRole('group', { name: '翻页' });
  const toggle = view.getByRole('button', { name: '展开终端工具' });
  const groups = pager.querySelectorAll('.term-pager-grp');
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 40, width: 40, x: 0, y: top, toJSON() {} });
  vi.spyOn(pager, 'getBoundingClientRect').mockReturnValue(rect(0, 600));
  vi.spyOn(groups[0]!, 'getBoundingClientRect').mockReturnValue(rect(191.5, 40));
  vi.spyOn(groups[2]!, 'getBoundingClientRect').mockReturnValue(rect(330, 78.5));
  let captured = false;
  Object.assign(toggle, {
    setPointerCapture: vi.fn(() => { captured = true; }),
    hasPointerCapture: vi.fn(() => captured),
    releasePointerCapture: vi.fn(() => { captured = false; }),
  });
  return { view, pager, toggle };
};

describe('full-screen terminal pager', () => {
  it('uses visibly smaller hit targets with translucent gray depth and a clear border on black', () => {
    const view = render(<TerminalOverlays {...props()} />);
    const toggle = view.getByRole('button', { name: '展开终端工具' });
    const group = toggle.parentElement!;
    const buttonStyle = getComputedStyle(toggle);
    const groupStyle = getComputedStyle(group);
    expect(buttonStyle.width).toBe('38px');
    expect(buttonStyle.height).toBe('38px');
    expect(buttonStyle.padding).toBe('0px');
    expect(['', 'none']).toContain(buttonStyle.transform);
    expect(groupStyle.borderLeftWidth).toBe('1px');
    expect(parseFloat(buttonStyle.width) + 2 * parseFloat(groupStyle.borderLeftWidth)).toBe(40);
    expect(getComputedStyle(toggle.querySelector('svg')!).width).toBe('18px');
    expect(getComputedStyle(toggle.querySelector('svg')!).height).toBe('18px');
    const background = groupStyle.backgroundColor.match(/[\d.]+/g)!.map(Number);
    const border = groupStyle.borderLeftColor.match(/[\d.]+/g)!.map(Number);
    expect(background[3]).toBeCloseTo(0.28);
    expect(border[3]).toBeCloseTo(0.38);
    const grayOnBlack = background.slice(0, 3).map((channel) => channel * background[3]!);
    expect(grayOnBlack[0]).toBeCloseTo(31.36);
    expect(grayOnBlack[1]).toBeCloseTo(35.84);
    expect(grayOnBlack[2]).toBeCloseTo(42.56);
    // The border remains perceptibly lighter than the translucent gray even over a black terminal.
    for (const [index, channel] of border.slice(0, 3).entries()) {
      const borderOnGray = channel * border[3]! + grayOnBlack[index]! * (1 - border[3]!);
      expect(borderOnGray - grayOnBlack[index]!).toBeGreaterThan(60);
    }
    expect(groupStyle.boxShadow).toContain('inset');
    expect(['', '1']).toContain(groupStyle.opacity);
    fireEvent.click(toggle);
    for (const button of view.getAllByRole('button')) {
      expect(getComputedStyle(button).width).toBe('38px');
      expect(getComputedStyle(button).height).toBe('38px');
    }
  });

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
    expect(pager.style.getPropertyValue('--pager-position')).toBe('0.5');
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

  it('moves only vertically from the handle, saves on release, and does not toggle after dragging', () => {
    const { view, pager, toggle } = draggable();
    expect(localStorage.getItem(PREFERENCE_KEY)).toBeNull();
    pointer(toggle, 'pointerdown');
    expect(toggle.setPointerCapture).toHaveBeenCalledWith(1);
    pointer(toggle, 'pointermove', { pointerId: 2, clientY: 28 });
    expect(pager.style.getPropertyValue('--pager-position')).toBe('0.5');
    pointer(toggle, 'pointermove', { clientX: 104, clientY: 355 });
    expect(pager.style.getPropertyValue('--pager-position')).toBe('1');
    expect(localStorage.getItem(PREFERENCE_KEY)).toBeNull();
    pointer(toggle, 'pointerup', { clientY: 355 });
    pointer(toggle, 'lostpointercapture');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem(PREFERENCE_KEY)!)).toEqual({ expanded: false, position: 1 });
    view.unmount();
    const restored = render(<TerminalOverlays {...props()} />);
    expect(restored.getByRole('group', { name: '翻页' }).style.getPropertyValue('--pager-position')).toBe('1');
    fireEvent.click(restored.getByRole('button', { name: '展开终端工具' }));
    expect(JSON.parse(localStorage.getItem(PREFERENCE_KEY)!)).toEqual({ expanded: true, position: 1 });
  });

  it.each(['pointercancel', 'lostpointercapture'])('rolls back an interrupted drag on %s without saving or toggling', (type) => {
    const { pager, toggle } = draggable();
    pointer(toggle, 'pointerdown');
    pointer(toggle, 'pointermove', { clientY: 28 });
    expect(pager.style.getPropertyValue('--pager-position')).toBe('0');
    pointer(toggle, type);
    expect(pager.style.getPropertyValue('--pager-position')).toBe('0.5');
    expect(localStorage.getItem(PREFERENCE_KEY)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('treats a short movement as a tap, ignores non-primary presses, and does not drag from action keys', () => {
    const { view, pager, toggle } = draggable();
    pointer(toggle, 'pointerdown', { isPrimary: false });
    pointer(toggle, 'pointermove', { clientY: 338 });
    pointer(toggle, 'pointerup');
    pointer(toggle, 'pointerdown', { button: 2 });
    expect(toggle.setPointerCapture).not.toHaveBeenCalled();
    pointer(toggle, 'pointerdown');
    pointer(toggle, 'pointermove', { clientY: 187 });
    pointer(toggle, 'pointerup');
    fireEvent.click(toggle);
    const action = view.getByRole('button', { name: '上翻页' });
    pointer(action, 'pointerdown');
    pointer(action, 'pointermove', { clientY: 338 });
    pointer(action, 'pointerup');
    expect(pager.style.getPropertyValue('--pager-position')).toBe('0.5');
    // jsdom has no touch-action implementation; inspect the loaded CSSOM contract, not fake touch behavior.
    const handleRule = Array.from(styles.sheet!.cssRules).find((rule) => (
      'selectorText' in rule && rule.selectorText === '.term-pager-handle'
    )) as CSSStyleRule;
    expect(handleRule.style.getPropertyValue('touch-action')).toBe('none');
  });

  it('restores expanded preferences on a fresh mount and leaves remembered position untouched by viewport changes', () => {
    localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ expanded: true, position: 0.8 }));
    const view = render(<TerminalOverlays {...props()} />);
    expect(view.getByRole('button', { name: '收起终端工具' })).not.toBeNull();
    const pager = view.getByRole('group', { name: '翻页' });
    const saved = localStorage.getItem(PREFERENCE_KEY);
    pager.style.setProperty('--vis-h', '140px');
    fireEvent(window, new Event('resize'));
    expect(pager.style.getPropertyValue('--pager-position')).toBe('0.8');
    expect(localStorage.getItem(PREFERENCE_KEY)).toBe(saved);
  });

  it.each(['broken', '{}', '{"expanded":true}', '{"expanded":true,"position":"0.8"}', '{"expanded":false,"position":-1}', '{"expanded":false,"position":2}'])('handles damaged preferences %s without breaking controls', (saved) => {
    localStorage.setItem(PREFERENCE_KEY, saved);
    const view = render(<TerminalOverlays {...props()} />);
    expect(view.getByRole('group', { name: '翻页' }).style.getPropertyValue('--pager-position')).toBe('0.5');
    expect(view.getByRole('group', { name: '翻页' }).querySelector('[aria-expanded]')).not.toBeNull();
  });

  it('keeps toggling if localStorage reads and writes throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    const view = render(<TerminalOverlays {...props()} />);
    fireEvent.click(view.getByRole('button', { name: '展开终端工具' }));
    expect(view.getByRole('button', { name: '收起终端工具' })).not.toBeNull();
  });

  it('keeps the remembered ratio during a drag when the visible slice cannot fit the full controls', () => {
    const { pager, toggle } = draggable();
    vi.mocked(pager.getBoundingClientRect).mockReturnValue({ top: 0, bottom: 140, height: 140 } as DOMRect);
    pointer(toggle, 'pointerdown');
    pointer(toggle, 'pointermove', { clientY: 28 });
    pointer(toggle, 'pointerup', { clientY: 28 });
    expect(pager.style.getPropertyValue('--pager-position')).toBe('0.5');
    expect(JSON.parse(localStorage.getItem(PREFERENCE_KEY)!)).toEqual({ expanded: false, position: 0.5 });
  });
});
