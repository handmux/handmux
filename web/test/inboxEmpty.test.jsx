// The shared test setup pins the UI locale to Chinese; this suite asserts the English inbox strings, so it
// forces 'en' into localStorage BEFORE the i18n module loads (hoisted above the imports below). i18n reads
// the saved locale once at module evaluation, so the override must land before any component import.
import { vi } from 'vitest';
vi.hoisted(() => { try { localStorage.setItem('tw_lang', 'en'); } catch { /* no localStorage in this env */ } });

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import Inbox from '../src/components/Inbox.jsx';

// This repo doesn't run vitest with `globals: true`, so testing-library's auto-cleanup-after-each isn't
// wired up — unmount between cases explicitly, or stacked renders make getByText find duplicates.
afterEach(cleanup);

const base = {
  rows: [], top: null, open: true,
  onToggle: () => {}, onClose: () => {}, onSelectRow: () => {}, onMarkAllRead: () => {},
};

describe('Inbox empty state', () => {
  it('shows the normal empty text when hooks are installed', () => {
    render(<Inbox {...base} hooksStatus="installed" onEnableHooks={() => {}} />);
    expect(screen.getByText('No pane status yet')).toBeTruthy();
    expect(screen.queryByText('Enable')).toBeNull();
  });

  it('shows the normal empty text when status is unknown (back-compat)', () => {
    render(<Inbox {...base} hooksStatus={null} onEnableHooks={() => {}} />);
    expect(screen.getByText('No pane status yet')).toBeTruthy();
  });

  it('shows the shared reconnecting treatment instead of a false empty state', () => {
    render(<Inbox {...base} reconnecting hooksStatus="installed" onEnableHooks={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('Reconnecting to the inbox…');
    expect(screen.queryByText('No pane status yet')).toBeNull();
  });

  it('keeps existing rows visible while the inbox source reconnects', () => {
    const rows = [{ pane: '%1', session: 's', window: '0', view: 'working', ts: 1, msg: '' }];
    render(<Inbox {...base} rows={rows} reconnecting hooksStatus="installed" onEnableHooks={() => {}} />);
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Reconnecting to the inbox…');
  });

  it('hides the prompt entirely when Claude Code is absent', () => {
    render(<Inbox {...base} hooksStatus="no-claude" onEnableHooks={() => {}} />);
    expect(screen.getByText('No pane status yet')).toBeTruthy();
    expect(screen.queryByText('Enable')).toBeNull();
  });

  it('shows the enable prompt + button when hooks are absent, and calls onEnableHooks', async () => {
    const onEnableHooks = vi.fn().mockResolvedValue({ status: 'installed' });
    render(<Inbox {...base} hooksStatus="absent" onEnableHooks={onEnableHooks} />);
    expect(screen.getByText('Turn on Claude Code states and notifications')).toBeTruthy();
    fireEvent.click(screen.getByText('Enable'));
    await waitFor(() => expect(onEnableHooks).toHaveBeenCalled());
  });

  it('does not show the enable prompt when there are rows', () => {
    const rows = [{ pane: '%1', session: 's', window: '0', view: 'working', ts: 1, msg: '' }];
    render(<Inbox {...base} rows={rows} hooksStatus="absent" onEnableHooks={() => {}} />);
    expect(screen.queryByText('Turn on Claude Code states and notifications')).toBeNull();
  });
});
