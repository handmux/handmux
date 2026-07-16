import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import LensSwitch from '../src/components/LensSwitch.jsx';

// This repo doesn't run vitest with `globals: true`, so testing-library's auto-cleanup (which hooks into
// a global afterEach) never registers — without this, DOM from one test leaks into the next.
afterEach(cleanup);

describe('LensSwitch', () => {
  it('trigger shows the current lens label', () => {
    render(<LensSwitch value="terminal" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '视图切换' }).textContent).toContain('终端模式');
  });

  it('opening the trigger reveals both options; picking one reports the chosen lens', () => {
    const onChange = vi.fn();
    render(<LensSwitch value="terminal" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '视图切换' }));
    expect(screen.getByRole('option', { name: '终端模式' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '对话模式' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: '对话模式' }));
    expect(onChange).toHaveBeenCalledWith('chat');
  });

  it('shows 对话模式 as current when value is chat', () => {
    render(<LensSwitch value="chat" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '视图切换' }).textContent).toContain('对话模式');
  });
});
