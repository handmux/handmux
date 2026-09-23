import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

// These tests exercise the drawer shell, not the asynchronous topology loader. Keep the loader
// pending so it cannot publish state after a test has already unmounted the component.
vi.mock('../api.js', () => ({
  getSessions: vi.fn(() => new Promise(() => {})),
  getWindowsForSessions: vi.fn(() => new Promise(() => {})),
}));

import Drawer from './Drawer.jsx';

const base = {
  open: true,
  currentSessionName: 'main',
  bound: ['main'],
  onSelectSession: () => {},
  onUnbind: () => {},
  onBind: () => {},
  onClose: () => {},
  onLogout: () => {},
};

const recoveryPlan = {
  checkpointId: 'checkpoint-a',
  capturedAt: '2026-07-20T01:42:00.000Z',
  changeReason: 'boot-changed',
  summary: { sessions: 3 },
};

afterEach(cleanup);

describe('Drawer workspace recovery card', () => {
  it('places the lightweight card at the end of the scrolling list, before the fixed footer', () => {
    const { container } = render(<Drawer {...base} recoveryPlan={recoveryPlan} onOpenRecovery={() => {}} />);
    const list = container.querySelector('.drawer-scroll');
    const card = container.querySelector('.workspace-recovery-card');
    const footer = container.querySelector('.drawer-footer');
    if (!list || !card || !footer) throw new Error('expected drawer recovery elements');
    expect(card.parentElement).toBe(list);
    expect(list.lastElementChild).toBe(card);
    expect(footer.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('opens the dialog from the card and hides the entry without an eligible plan', () => {
    const onOpenRecovery = vi.fn();
    const { container, rerender } = render(<Drawer {...base} recoveryPlan={recoveryPlan} onOpenRecovery={onOpenRecovery} />);
    const card = container.querySelector('.workspace-recovery-card');
    if (!card) throw new Error('expected drawer recovery card');
    fireEvent.click(card);
    expect(onOpenRecovery).toHaveBeenCalledTimes(1);

    rerender(<Drawer {...base} recoveryPlan={null} onOpenRecovery={onOpenRecovery} />);
    expect(container.querySelector('.workspace-recovery-card')).toBeNull();
  });
});
