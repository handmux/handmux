// web/test/inboxBackButton.test.jsx
//
// Regression guard for the "detail Back ejects the whole inbox" bug. App.jsx's inbox (list + detail) used
// to arm TWO separate useBackButton() guards — one for the list, one for the detail. Both attach a global
// popstate listener while active, so with a detail open OVER the list, a single hardware Back / edge-swipe
// fired ONE popstate that triggered BOTH listeners: the detail closed AND the list closed in the same tick,
// ejecting the whole inbox instead of going detail→list.
//
// The fix is ONE combined useBackButton(notifInboxOpen, handler) where the handler branches on whether a
// detail is open (see App.jsx). This test mounts a minimal harness using the REAL useBackButton hook with
// that exact branching handler, and locks: first Back closes only the detail (page stays open), second Back
// closes the page.
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { useState } from 'react';
import { useBackButton } from '../src/hooks/useBackButton.js';

afterEach(cleanup);

function InboxHarness() {
  const [open, setOpen] = useState(true);       // inbox list page — starts open (as it would be to host a detail)
  const [detailId, setDetailId] = useState(null); // open message detail (null = list only)

  // Mirrors the combined guard added to App.jsx: ONE useBackButton for the whole inbox. Back from a detail
  // closes the detail and re-pushes a history entry (so the list stays backed); Back from the bare list
  // closes the page.
  useBackButton(open, () => {
    if (detailId) { setDetailId(null); window.history.pushState({ overlay: true }, ''); }
    else setOpen(false);
  });

  return (
    <div>
      <div data-testid="page-state">{open ? 'page:open' : 'page:closed'}</div>
      <div data-testid="detail-state">{detailId ? 'detail:open' : 'detail:closed'}</div>
      <button onClick={() => setDetailId('msg-1')}>open detail</button>
    </div>
  );
}

describe('inbox back-button nesting (list + detail as one overlay level)', () => {
  it('Back with a detail open closes only the detail; a second Back then closes the page', () => {
    const { getByTestId, getByText } = render(<InboxHarness />);

    expect(getByTestId('page-state').textContent).toBe('page:open');
    expect(getByTestId('detail-state').textContent).toBe('detail:closed');

    // Open a detail over the list (no separate history entry — matches App.jsx: opening a detail does NOT
    // call useBackButton itself).
    fireEvent.click(getByText('open detail'));
    expect(getByTestId('detail-state').textContent).toBe('detail:open');

    // ONE hardware Back / edge-swipe → ONE popstate.
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));

    // Bug would have closed BOTH (page:closed) in this single tick. Fixed behavior: detail→list only.
    expect(getByTestId('detail-state').textContent).toBe('detail:closed');
    expect(getByTestId('page-state').textContent).toBe('page:open');

    // Second Back (list is on top now) closes the page.
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(getByTestId('page-state').textContent).toBe('page:closed');
  });
});
