import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DeviceLogoutDialog from './DeviceLogoutDialog.js';
import { useBackButton } from '../hooks/useBackButton.js';
import { t } from '../i18n';

vi.mock('../hooks/useBackButton.js', () => ({ useBackButton: vi.fn() }));
vi.mock('../hooks/useModalFocusTrap.js', () => ({ useModalFocusTrap: vi.fn() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('DeviceLogoutDialog', () => {
  it('closes when the backdrop or hardware-back callback is used', () => {
    const onClose = vi.fn();
    render(<DeviceLogoutDialog busy={false} error="" onClose={onClose} onConfirm={vi.fn()} />);
    fireEvent.click(document.querySelector('.auth-logout-backdrop')!);
    expect(onClose).toHaveBeenCalledOnce();
    const callback = vi.mocked(useBackButton).mock.calls[0]?.[1] as (() => void) | undefined;
    callback?.();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps cancellation disabled while logout is in progress', () => {
    const onClose = vi.fn();
    render(<DeviceLogoutDialog busy error="" onClose={onClose} onConfirm={vi.fn()} />);
    fireEvent.click(document.querySelector('.auth-logout-backdrop')!);
    const callback = vi.mocked(useBackButton).mock.calls[0]?.[1] as (() => void) | undefined;
    callback?.();
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: t('common.cancel') }) as HTMLButtonElement).disabled).toBe(true);
  });
});
