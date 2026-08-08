import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { takeoverCodexSession } from '../src/api.js';
import CodexManagedGuide from '../src/components/CodexManagedGuide.jsx';

vi.mock('../src/api.js', () => ({
  takeoverCodexSession: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('CodexManagedGuide', () => {
  it('requires an explicit destructive confirmation before starting takeover', async () => {
    const onTakeoverChange = vi.fn();
    takeoverCodexSession.mockResolvedValue({
      started: true, takeover: { state: 'starting', needsTerminal: false },
    });
    render(<CodexManagedGuide pane="%1" session={{ managed: false }} onTerminal={() => {}}
      onTakeoverChange={onTakeoverChange} />);

    fireEvent.click(screen.getByRole('button', { name: '开始托管' }));
    expect(takeoverCodexSession).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.classList.contains('settings-confirm')).toBe(true);
    expect(dialog.parentElement.classList.contains('settings-confirm-backdrop')).toBe(true);
    expect(screen.getByText(/可能需要你前往终端/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '结束并开始托管' }));
    });
    expect(takeoverCodexSession).toHaveBeenCalledOnce();
    expect(takeoverCodexSession).toHaveBeenCalledWith('%1');
    expect(onTakeoverChange).toHaveBeenCalledWith('%1', true);
    expect(screen.getByText('正在启动托管')).toBeTruthy();
  });

  it('keeps the chat page pinned when Codex does not return a verifiable current session', async () => {
    const onTakeoverChange = vi.fn();
    takeoverCodexSession.mockRejectedValue({ serverError: 'codex-session-unconfirmed' });
    render(<CodexManagedGuide pane="%1" session={{ managed: false }} onTerminal={() => {}}
      onTakeoverChange={onTakeoverChange} />);
    fireEvent.click(screen.getByRole('button', { name: '开始托管' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '结束并开始托管' }));
    });
    expect(screen.getByText('需要从终端继续')).toBeTruthy();
    expect(screen.getByText(/没有正常退出或返回可确认的恢复信息/)).toBeTruthy();
    expect(onTakeoverChange.mock.calls).toEqual([['%1', true]]);
  });

  it('stays on the page and reveals a terminal action only after startup is delayed', () => {
    vi.useFakeTimers();
    const onTerminal = vi.fn();
    render(<CodexManagedGuide pane="%1" session={{
      managed: false, takeover: { state: 'starting', needsTerminal: false },
    }} onTerminal={onTerminal} />);
    expect(screen.queryByRole('button', { name: '前往终端' })).toBeNull();

    act(() => { vi.advanceTimersByTime(9_999); });
    expect(screen.queryByRole('button', { name: '前往终端' })).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByText(/可能正在终端等待信任或其他确认/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '前往终端' }));
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it('stays in chat after the 30-second cap and waits for an explicit terminal choice', () => {
    const onTerminal = vi.fn();
    const onTakeoverChange = vi.fn();
    render(<CodexManagedGuide pane="%1" session={{
      managed: false, takeover: { state: 'timed-out', needsTerminal: true },
    }} onTerminal={onTerminal} onTakeoverChange={onTakeoverChange} />);
    expect(screen.getByText('托管仍未就绪')).toBeTruthy();
    expect(screen.getByText(/当前页面不会自动切换/)).toBeTruthy();
    expect(onTerminal).not.toHaveBeenCalled();
    expect(onTakeoverChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '前往终端' }));
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it('ignores a late takeover response after the user switches panes', async () => {
    let resolveTakeover;
    takeoverCodexSession.mockReturnValue(new Promise((resolve) => { resolveTakeover = resolve; }));
    const { rerender } = render(
      <CodexManagedGuide pane="%1" session={{ managed: false }} onTerminal={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '开始托管' }));
    fireEvent.click(screen.getByRole('button', { name: '结束并开始托管' }));

    rerender(<CodexManagedGuide pane="%2" session={{ managed: false }} onTerminal={() => {}} />);
    await act(async () => {
      resolveTakeover({ started: true, takeover: { state: 'starting', needsTerminal: false } });
    });
    expect(screen.getByText('接入 Codex 对话')).toBeTruthy();
    expect(screen.queryByText('正在启动托管')).toBeNull();
  });
});
