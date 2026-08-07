import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import CodexManagedGuide from '../src/components/CodexManagedGuide.jsx';

afterEach(cleanup);

describe('CodexManagedGuide', () => {
  it('keeps unmanaged Codex safe and sends the user to the terminal to resume it', () => {
    const onTerminal = vi.fn();
    render(<CodexManagedGuide onTerminal={onTerminal} />);

    expect(screen.getByText('handmux codex resume')).toBeTruthy();
    expect(screen.getByText(/Hook 信任/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '一键接管' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回终端' }));
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });
});
