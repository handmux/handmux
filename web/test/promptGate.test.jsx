import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';

vi.mock('../src/api.js', () => ({
  sendText: vi.fn(async () => ({ ok: true })),
  sendKeys: vi.fn(async () => ({ ok: true })),
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import PromptGate from '../src/components/PromptGate.jsx';
import { sendText, sendKeys } from '../src/api.js';

const styles = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const askPrompt = {
  kind: 'question',
  title: '你喜欢哪个?',
  options: [
    { n: 1, label: '红色', description: '热情' },
    { n: 2, label: '蓝色', description: '沉稳' },
  ],
  cursor: 1,
};

describe('PromptGate', () => {
  it('renders the scraped options with descriptions and defaults the selection to the cursor', () => {
    render(<PromptGate pane="%1" prompt={askPrompt} />);
    expect(screen.getByText('你喜欢哪个?')).toBeTruthy();
    expect(screen.getByText('热情')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /红色/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /蓝色/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('limits long option copy to at most two label lines and one description line', () => {
    const { container } = render(<PromptGate pane="%1" prompt={{
      ...askPrompt,
      options: [{ n: 1, label: '很长的选项标题'.repeat(20), description: '很长的选项说明'.repeat(20) }],
    }} />);
    expect(container.querySelector('.chat-gate-opt-label')).toBeTruthy();
    expect(container.querySelector('.chat-gate-opt-desc')).toBeTruthy();
    expect(styles).toMatch(/\.chat-gate-opt-label\s*\{[^}]*-webkit-line-clamp:\s*2/s);
    expect(styles).toMatch(/\.chat-gate-opt-desc\s*\{[^}]*white-space:\s*nowrap/s);
  });

  it('limits stacked decision button labels to three lines', () => {
    expect(styles).toMatch(/\.chat-gate-btn-label\s*\{[^}]*-webkit-line-clamp:\s*3/s);
  });

  it('确认 sends the SELECTED option digit (no Enter) — the menu hotkey', async () => {
    const onAct = vi.fn();
    render(<PromptGate pane="%1" prompt={askPrompt} onAct={onAct} />);
    fireEvent.click(screen.getByRole('radio', { name: /蓝色/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await Promise.resolve();
    expect(sendText).toHaveBeenCalledWith('%1', '2', false); // digit 2, no Enter
    expect(onAct).toHaveBeenCalled();
  });

  it('puts 取消 on the left and 确认 on the right', () => {
    const { container } = render(<PromptGate pane="%1" prompt={askPrompt} />);
    const labels = [...container.querySelectorAll('.chat-gate-actions button')].map((button) => button.textContent);
    expect(labels).toEqual(['取消', '确认']);
  });

  it('取消 needs two taps so one stray tap cannot send Escape', async () => {
    render(<PromptGate pane="%1" prompt={askPrompt} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(sendKeys).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '再点一次取消' }));
    await Promise.resolve();
    expect(sendKeys).toHaveBeenCalledWith('%1', ['Escape']);
  });

  it('取消的二次确认会自动失效', () => {
    vi.useFakeTimers();
    try {
      render(<PromptGate pane="%1" prompt={askPrompt} />);
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      act(() => vi.advanceTimersByTime(2500));
      expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
      expect(sendKeys).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows "第 i/N 题" progress for a multi-question step', () => {
    render(<PromptGate pane="%1" prompt={{ ...askPrompt, multi: true, step: 2, total: 3 }} />);
    expect(screen.getByText('第 2/3 题')).toBeTruthy();
  });

  it('renders the scraped lead-in context above the question when present; omits it when absent', () => {
    const { container, unmount } = render(<PromptGate pane="%1" prompt={{ ...askPrompt, leadIn: '探完了骨架,推荐方案A' }} />);
    const leadin = container.querySelector('.chat-gate-leadin');
    expect(leadin).toBeTruthy();
    expect(leadin.textContent).toBe('探完了骨架,推荐方案A');
    unmount();
    const { container: c2 } = render(<PromptGate pane="%1" prompt={askPrompt} />);
    expect(c2.querySelector('.chat-gate-leadin')).toBeNull();
  });

  it('the review screen renders left 取消 / right 提交 and 提交 sends the "Submit answers" digit', async () => {
    const review = {
      kind: 'question', title: 'review', submit: true, multi: true, step: 2, total: 2,
      options: [{ n: 1, label: 'Submit answers', description: '' }, { n: 2, label: 'Cancel', description: '' }],
    };
    const { container } = render(<PromptGate pane="%1" prompt={review} />);
    expect(screen.queryByRole('radio')).toBeNull(); // not a radio list — a plain confirm
    const labels = [...container.querySelectorAll('.chat-gate-actions button')].map((button) => button.textContent);
    expect(labels).toEqual(['取消', '提交']);
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await Promise.resolve();
    expect(sendText).toHaveBeenCalledWith('%1', '1', false);
  });
});
