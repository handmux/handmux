import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConversationActivationRecovery, recoverConversationActivation } from '../agentConversationActivationApi.js';
import { useConversationActivationRecovery } from '../hooks/useConversationActivationRecovery.js';
import type { ConversationActivationRecoveryController } from '../hooks/useConversationActivationRecovery.js';
import CodexActivationRecoveryGuide from './CodexActivationRecoveryGuide.js';

vi.mock('../agentConversationActivationApi.js', () => ({
  getConversationActivationRecovery: vi.fn(), recoverConversationActivation: vi.fn(),
}));
vi.mock('../i18n', () => ({ t: (key: string) => key }));

const recovery = {
  kind: 'codex_resume' as const,
  sessionId: '12345678-1234-1234-1234-123456789abc',
  command: 'handmux codex resume 12345678-1234-1234-1234-123456789abc',
};
const receipt = {
  operationId: 'a'.repeat(64), recovery, phase: 'interrupted' as const,
  state: 'current' as const, canResume: true,
};
const controller = (status: ConversationActivationRecoveryController['status'] = 'recovering'):
ConversationActivationRecoveryController => ({ status, receipt, recover: vi.fn(async () => {}), retry: vi.fn() });
const hint = () => screen.queryByText('chat.managedGuide.terminalHint');
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

describe('Codex recovery terminal reminder', () => {
  it('reminds at 30s during slow discovery without ending recovery or posting again', async () => {
    vi.mocked(getConversationActivationRecovery).mockResolvedValue(receipt);
    vi.mocked(recoverConversationActivation).mockResolvedValue(recovery);
    const discover = vi.fn(() => new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)));
    const onTerminal = vi.fn();
    let current!: ConversationActivationRecoveryController;
    function Recovery() {
      current = useConversationActivationRecovery('%1', true, discover);
      return <CodexActivationRecoveryGuide controller={current} onTerminal={onTerminal} />;
    }
    render(<Recovery />);
    await act(async () => {});
    fireEvent.click(screen.getByText('chat.managedGuide.retryRecovery'));
    expect(screen.getByText('chat.session.openTerminal')).toBeTruthy();
    await tick(29_999);
    expect(hint()).toBeNull();
    await tick(1);
    expect(hint()).toBeTruthy();
    expect(current.status).toBe('waiting');
    expect(recoverConversationActivation).toHaveBeenCalledTimes(1);
    expect(onTerminal).not.toHaveBeenCalled();
    await tick(30_000);
    expect(hint()).toBeTruthy();
    expect(current.status).toBe('waiting');
    expect(recoverConversationActivation).toHaveBeenCalledTimes(1);
  });

  it('does not restart the timer for rerenders, receipt refreshes or recovering to waiting', async () => {
    const value = controller();
    const { rerender } = render(<CodexActivationRecoveryGuide controller={value} onTerminal={() => {}} />);
    await tick(15_000);
    rerender(<CodexActivationRecoveryGuide controller={{ ...value, status: 'waiting',
      receipt: { ...receipt, phase: 'resuming', canResume: false } }} onTerminal={() => {}} />);
    await tick(14_999);
    expect(hint()).toBeNull();
    await tick(1);
    expect(hint()).toBeTruthy();
  });

  it('resets the deadline when the recovery operation changes', async () => {
    const value = controller();
    const { rerender } = render(<CodexActivationRecoveryGuide controller={value} onTerminal={() => {}} />);
    await tick(20_000);
    rerender(<CodexActivationRecoveryGuide controller={{ ...value,
      receipt: { ...receipt, operationId: 'b'.repeat(64) } }} onTerminal={() => {}} />);
    await tick(10_000);
    expect(hint()).toBeNull();
    await tick(20_000);
    expect(hint()).toBeTruthy();
  });

  it.each(['error', 'no receipt'] as const)('clears the timer on %s and starts a fresh pending visit', async (end) => {
    const value = controller();
    const { rerender } = render(<CodexActivationRecoveryGuide controller={value} onTerminal={() => {}} />);
    await tick(20_000);
    rerender(<CodexActivationRecoveryGuide controller={end === 'error'
      ? { ...value, status: 'error' } : { ...value, receipt: null }} onTerminal={() => {}} />);
    expect(vi.getTimerCount()).toBe(0);
    await tick(20_000);
    expect(hint()).toBeNull();
    rerender(<CodexActivationRecoveryGuide controller={value} onTerminal={() => {}} />);
    await tick(29_999);
    expect(hint()).toBeNull();
    await tick(1);
    expect(hint()).toBeTruthy();
  });

  it('clears its timer when unmounted', () => {
    const { unmount } = render(<CodexActivationRecoveryGuide controller={controller()} onTerminal={() => {}} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
