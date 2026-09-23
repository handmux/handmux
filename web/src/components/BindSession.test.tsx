import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getSessions: vi.fn(),
  createSession: vi.fn(),
  onBound: vi.fn(),
}));

vi.mock('../api.js', () => ({
  getSessions: mocks.getSessions,
  createSession: mocks.createSession,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('../storage.js', () => ({ getLastStartupCmd: () => '', setLastStartupCmd: vi.fn() }));
vi.mock('../hooks/useBackButton.js', () => ({ useBackButton: () => {} }));
vi.mock('./DirPicker.jsx', () => ({ default: () => null }));
vi.mock('./StartupCmdPicker.jsx', () => ({ default: () => null }));

import BindSession from './BindSession.jsx';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BindSession bottom sheet', () => {
  it('lists unbound sessions and binds one directly from the picker', async () => {
    mocks.getSessions.mockResolvedValue([
      { id: 'main-id', name: 'main' },
      { id: 'dev-id', name: 'dev' },
    ]);
    render(<BindSession open onClose={vi.fn()} onBound={mocks.onBound} bound={['main']} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'dev' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'main' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'dev' }));
    await waitFor(() => expect(mocks.onBound).toHaveBeenCalledWith('dev'));
  });

  it('opens the existing create flow from its own list action', async () => {
    mocks.getSessions.mockResolvedValue([]);
    render(<BindSession open onClose={vi.fn()} onBound={mocks.onBound} bound={[]} />);

    await waitFor(() => expect(screen.getByRole('button', { name: '新建会话' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    expect(screen.getByLabelText('会话名称')).toBeTruthy();
    expect(screen.getByRole('button', { name: '返回' })).toBeTruthy();
  });

  it('shows a friendly empty state and animates between picker and create pages', async () => {
    mocks.getSessions.mockResolvedValue([]);
    render(<BindSession open onClose={vi.fn()} onBound={mocks.onBound} bound={[]} />);

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.getByRole('status').querySelector('svg')).toBeTruthy();
    expect(screen.getByText('暂无可绑定的会话')).toBeTruthy();
    expect(screen.getByText('已绑定到此设备的会话不会重复显示。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    expect(document.querySelector('.bind-sheet-page-new')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(document.querySelector('.bind-sheet-page-picker')).toBeTruthy();
  });
});
