import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OriginRejectedPrompt from './OriginRejectedPrompt.js';
import { t } from '../i18n';

describe('OriginRejectedPrompt', () => {
  it('explains the rejected address and offers a retry without a Token input', () => {
    const onRetry = vi.fn();
    render(<OriginRejectedPrompt onRetry={onRetry} />);
    expect(screen.getByRole('heading', { name: t('auth.originRejectedTitle') })).toBeTruthy();
    expect(screen.getByText(t('auth.originRejected'))).toBeTruthy();
    expect(document.querySelector('.auth-origin-command')?.textContent).toContain('handmux auth trusted-origin set');
    expect(screen.queryByLabelText('Token')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('auth.retry') }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
