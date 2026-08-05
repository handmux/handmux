import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CodexTakeover from '../src/components/CodexTakeover.jsx';
import * as api from '../src/api.js';

afterEach(cleanup);
beforeEach(() => vi.restoreAllMocks());

describe('CodexTakeover', () => {
  it('takes over the current pane and enters managed chat', async () => {
    vi.spyOn(api, 'takeoverCodexSession').mockResolvedValue({ managed: true });
    const onTakenOver = vi.fn();
    render(<CodexTakeover pane="%7" onTakenOver={onTakenOver} />);

    expect(screen.getByRole('button', { name: '一键接管' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '一键接管' }));
    await waitFor(() => expect(api.takeoverCodexSession).toHaveBeenCalledWith('%7'));
    expect(onTakenOver).toHaveBeenCalledTimes(1);
  });

  it('explains how to establish an exact binding instead of guessing', async () => {
    vi.spyOn(api, 'takeoverCodexSession').mockRejectedValue(
      new api.ApiError('codex-session-unbound', 409, 'codex-session-unbound'),
    );
    render(<CodexTakeover pane="%7" />);
    fireEvent.click(screen.getByRole('button', { name: '一键接管' }));

    await screen.findByText('还无法确认当前会话。请返回终端发送一条消息，再重试接管。');
    expect(screen.getByRole('button', { name: '一键接管' }).disabled).toBe(false);
  });
});
