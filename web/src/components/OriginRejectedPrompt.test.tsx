import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OriginRejectedPrompt from './OriginRejectedPrompt.js';
import { t } from '../i18n';

describe('OriginRejectedPrompt', () => {
  it('explains the rejected address and offers a retry without a Token input', () => {
    const onRetry = vi.fn();
    const onAuthorize = vi.fn();
    render(<OriginRejectedPrompt onRetry={onRetry} onAuthorize={onAuthorize} />);
    expect(screen.getByRole('heading', { name: t('auth.originRejectedTitle') })).toBeTruthy();
    expect(screen.getByText(t('auth.originRejectedAddress', { origin: window.location.origin }))).toBeTruthy();
    expect(screen.getByText(t('auth.originRejectedOpenHint'))).toBeTruthy();
    expect(screen.getByText(t('auth.originRejectedAuthorizeHint'))).toBeTruthy();
    expect(document.querySelector('.auth-origin-command')).toBeNull();
    expect(screen.queryByLabelText('Token')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('auth.originRejectedAuthorizeButton') }));
    expect(onAuthorize).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: t('auth.originRejectedRetry') }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
