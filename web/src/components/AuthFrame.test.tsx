import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AuthFrame from './AuthFrame.js';
import TokenPrompt from './TokenPrompt.js';
import { t } from '../i18n';

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['token', 'trusted-device'] as const)('provides the same read-only switching help in %s mode', async mode => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  render(<AuthFrame title="Sign in" mode={mode}><p>Login content</p></AuthFrame>);
  const trigger = screen.getByRole('button', { name: t('auth.switchLink') });
  trigger.focus(); fireEvent.click(trigger);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByText(t('auth.switchWarning'))).toBeTruthy();
  expect(screen.getByText('handmux auth trusted-origin status')).toBeTruthy();
  expect(screen.getByText('handmux auth token enable')).toBeTruthy();
  const done = screen.getByRole('button', { name: t('common.done') });
  await waitFor(() => expect(document.activeElement).toBe(done));
  fireEvent.keyDown(done, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: t('auth.copySetup') }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(fetcher).not.toHaveBeenCalled();
});

it('copies exact setup/token-enable commands and allows manual copying on HTTP', async () => {
  render(<TokenPrompt onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: t('auth.switchLink') }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: t('common.done') })));
  fireEvent.click(screen.getByRole('button', { name: t('auth.copySetup') }));
  await screen.findByText(t('auth.manualCopy'));
  expect(window.getSelection()?.toString()).toBe('handmux auth trusted-origin status');
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  fireEvent.click(screen.getByRole('button', { name: t('auth.copySetup') }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('handmux auth trusted-origin status'));
  fireEvent.click(screen.getByRole('button', { name: t('auth.copyRestart') }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('handmux auth token enable'));
  expect(localStorage.getItem('tw_token')).toBeNull();
});

it('keeps token submission explicit and obscures its value', () => {
  const saved = vi.fn();
  render(<TokenPrompt onSaved={saved} />);
  const input = screen.getByLabelText('Token') as HTMLInputElement;
  const submit = screen.getByRole('button', { name: t('auth.login') }) as HTMLButtonElement;
  expect(input.type).toBe('password');
  expect(submit.disabled).toBe(true);
  fireEvent.change(input, { target: { value: '  test-token  ' } });
  fireEvent.click(screen.getByRole('button', { name: t('auth.switchLink') }));
  fireEvent.click(screen.getByRole('button', { name: t('common.done') }));
  expect(saved).not.toHaveBeenCalled();
  fireEvent.click(submit);
  expect(saved).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('tw_token')).toBe('test-token');
});
