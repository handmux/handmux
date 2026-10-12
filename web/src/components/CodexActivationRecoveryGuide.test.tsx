import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConversationActivationRecovery, recoverConversationActivation } from '../agentConversationActivationApi.js';
import { useConversationActivationRecovery } from '../hooks/useConversationActivationRecovery.js';
import type { ConversationActivationRecoveryController } from '../hooks/useConversationActivationRecovery.js';
import ConversationRecoveryGuide from './ConversationRecoveryGuide.js';

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
  it('keeps the manual restart recovery deadline across a failed POST with a resuming receipt', async () => {
    const value = { ...controller(), receipt: { ...receipt, phase: 'resuming' as const, canResume: false } };
    const { rerender, unmount } = render(<ConversationRecoveryGuide controller={value} operation="restart" onTerminal={() => {}} />);
    await tick(12_000);
    rerender(<ConversationRecoveryGuide controller={{ ...value, status: 'error' }} operation="restart" onTerminal={() => {}} />);
    await tick(17_999);
    expect(hint()).toBeNull();
    await tick(1);
    expect(hint()).toBeTruthy();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts an independent deadline for another restart receipt', async () => {
    const value = { ...controller('error'), receipt: { ...receipt, phase: 'resuming' as const, canResume: false } };
    const { rerender } = render(<ConversationRecoveryGuide controller={value} operation="restart" onTerminal={() => {}} />);
    await tick(20_000);
    rerender(<ConversationRecoveryGuide controller={{ ...value, receipt: { ...value.receipt, operationId: 'next' } }} operation="restart" onTerminal={() => {}} />);
    await tick(10_000);
    expect(hint()).toBeNull();
    await tick(20_000);
    expect(hint()).toBeTruthy();
  });

  it('starts a new deadline for an explicit retry even if the receipt identity is unchanged', async () => {
    const value = { ...controller('error'), receipt: { ...receipt, phase: 'resuming' as const, canResume: false } };
    const { rerender } = render(<ConversationRecoveryGuide controller={value} operation="restart" onTerminal={() => {}} />);
    await tick(30_000);
    expect(hint()).toBeTruthy();
    rerender(<ConversationRecoveryGuide controller={{ ...value, status: 'recovering' }} operation="restart" onTerminal={() => {}} />);
    expect(hint()).toBeNull();
    await tick(29_999);
    expect(hint()).toBeNull();
    await tick(1);
    expect(hint()).toBeTruthy();
  });
  it('shows an animated restart guide immediately and offers the terminal after 30 seconds without a receipt', async () => {
    const onTerminal = vi.fn();
    const { container } = render(<ConversationRecoveryGuide controller={{
      status: 'restarting', receipt: null, recover: vi.fn(async () => {}),
    }} operation="restart" onTerminal={onTerminal} />);

    expect(screen.getByText('chat.restart.inProgressTitle')).toBeTruthy();
    expect(container.querySelector('.codex-managed-guide-icon.starting')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'chat.session.openTerminal' })).toBeNull();
    await tick(29_999);
    expect(screen.queryByRole('button', { name: 'chat.session.openTerminal' })).toBeNull();
    await tick(1);
    expect(screen.getByText('chat.managedGuide.terminalHint')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'chat.session.openTerminal' }));
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('reminds at 30s during slow discovery without ending recovery or posting again', async () => {
    vi.mocked(getConversationActivationRecovery).mockResolvedValue(receipt);
    vi.mocked(recoverConversationActivation).mockResolvedValue(recovery);
    const discover = vi.fn(() => new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)));
    const onTerminal = vi.fn();
    let current!: ConversationActivationRecoveryController;
    function Recovery() {
      current = useConversationActivationRecovery('%1', true, discover);
      return <ConversationRecoveryGuide controller={current} operation="activation" onTerminal={onTerminal} />;
    }
    render(<Recovery />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByText('chat.managedGuide.retryRecovery'));
      await Promise.resolve();
    });
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
    const { rerender } = render(<ConversationRecoveryGuide controller={value} operation="activation" onTerminal={() => {}} />);
    await tick(15_000);
    rerender(<ConversationRecoveryGuide controller={{ ...value, status: 'waiting',
      receipt: { ...receipt, phase: 'resuming', canResume: false } }} operation="activation" onTerminal={() => {}} />);
    await tick(14_999);
    expect(hint()).toBeNull();
    await tick(1);
    expect(hint()).toBeTruthy();
  });

  it('resets the deadline when the recovery operation changes', async () => {
    const value = controller();
    const { rerender } = render(<ConversationRecoveryGuide controller={value} operation="activation" onTerminal={() => {}} />);
    await tick(20_000);
    rerender(<ConversationRecoveryGuide controller={{ ...value,
      receipt: { ...receipt, operationId: 'b'.repeat(64) } }} operation="activation" onTerminal={() => {}} />);
    await tick(10_000);
    expect(hint()).toBeNull();
    await tick(20_000);
    expect(hint()).toBeTruthy();
  });

  it.each(['error', 'no receipt'] as const)('clears the timer on %s and starts a fresh pending visit', async (end) => {
    const value = controller();
    const { rerender } = render(<ConversationRecoveryGuide controller={value} operation="activation" onTerminal={() => {}} />);
    await tick(20_000);
    rerender(<ConversationRecoveryGuide controller={end === 'error'
      ? { ...value, status: 'error' } : { ...value, receipt: null }} operation="activation" onTerminal={() => {}} />);
    expect(vi.getTimerCount()).toBe(0);
    await tick(20_000);
    expect(hint()).toBeNull();
    rerender(<ConversationRecoveryGuide controller={value} operation="activation" onTerminal={() => {}} />);
    await tick(29_999);
    expect(hint()).toBeNull();
    await tick(1);
    expect(hint()).toBeTruthy();
  });

  it('clears its timer when unmounted', () => {
    const { unmount } = render(<ConversationRecoveryGuide controller={controller()} operation="activation" onTerminal={() => {}} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the existing copy-only recovery guide for an unverified conversation restart', () => {
    const restartReceipt = {
      recovery,
      phase: 'prepared' as const,
      state: 'unknown' as const,
      canResume: false,
    };
    render(<ConversationRecoveryGuide controller={{
      status: 'error', receipt: restartReceipt, recover: vi.fn(async () => {}),
    }} operation="restart" onTerminal={() => {}} />);

    expect(screen.getByText('chat.managedGuide.recoveryUnknownTitle')).toBeTruthy();
    expect(screen.getByText('chat.managedGuide.recoveryUnknownHint')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat.managedGuide.copyRecovery' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'chat.managedGuide.retryRecovery' })).toBeNull();
  });

  it('keeps a resuming restart in progress until ready and offers terminal after 30 seconds', async () => {
    const resumingReceipt = {
      operationId: 'b'.repeat(64), recovery: { command: 'resume original session' },
      phase: 'resuming' as const, state: 'current' as const, canResume: false,
    };
    const onTerminal = vi.fn();
    const { container } = render(<ConversationRecoveryGuide controller={{
      status: 'error', receipt: resumingReceipt, recover: vi.fn(async () => {}),
    }} operation="restart" onTerminal={onTerminal} />);

    expect(screen.getByText('chat.restart.inProgressTitle')).toBeTruthy();
    expect(screen.getByText('chat.restart.inProgressHint')).toBeTruthy();
    expect(screen.getByText('chat.restart.manualPromptHint')).toBeTruthy();
    expect(container.querySelector('.codex-managed-guide-icon.starting')).toBeTruthy();
    expect(screen.queryByText('chat.managedGuide.recoveryTitle')).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.managedGuide.retryRecovery' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.managedGuide.copyRecovery' })).toBeNull();

    await tick(30_000);
    expect(screen.getByText('chat.managedGuide.terminalHint')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'chat.session.openTerminal' }));
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('does not treat an activation receipt phase as a conversation restart', () => {
    const activationReceipt = {
      ...receipt, phase: 'resuming' as const, canResume: false,
    };
    render(<ConversationRecoveryGuide controller={{
      status: 'error', receipt: activationReceipt, recover: vi.fn(async () => {}),
    }} operation="activation" onTerminal={() => {}} />);

    expect(screen.getByText('chat.managedGuide.recoveryTitle')).toBeTruthy();
    expect(screen.getByText('chat.managedGuide.recoveryManualHint')).toBeTruthy();
    expect(screen.queryByText('chat.restart.inProgressTitle')).toBeNull();
    expect(screen.queryByText('chat.restart.manualPromptHint')).toBeNull();
    expect(screen.getByRole('button', { name: 'chat.managedGuide.copyRecovery' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat.session.openTerminal' })).toBeTruthy();
  });

  it('does not restart the 30-second reminder when the restart response supplies its resuming receipt', async () => {
    const onTerminal = vi.fn();
    const { rerender } = render(<ConversationRecoveryGuide controller={{
      status: 'restarting', receipt: null, recover: vi.fn(async () => {}),
    }} operation="restart" onTerminal={onTerminal} />);
    await tick(20_000);

    rerender(<ConversationRecoveryGuide controller={{
      status: 'error', receipt: {
        operationId: 'c'.repeat(64), recovery: { command: 'resume original session' },
        phase: 'resuming', state: 'current', canResume: false,
      }, recover: vi.fn(async () => {}),
    }} operation="restart" onTerminal={onTerminal} />);
    await tick(9_999);
    expect(hint()).toBeNull();
    await tick(1);
    expect(hint()).toBeTruthy();
    expect(onTerminal).not.toHaveBeenCalled();
  });
});
