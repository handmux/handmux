// web/test/errorBoundary.test.jsx — a crash must never leave a blank, unusable page.
//
// Real-device report: tapping a document sometimes blanked the whole screen (dark body background, no
// UI, Back did nothing) and only restarting the app recovered. Without a boundary React unmounts the
// entire tree on any render/effect throw, which is exactly that symptom.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ErrorBoundary from '../src/components/ErrorBoundary.jsx';

let container, root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

const Boom = () => { throw new Error('boom-from-the-doc'); };

describe('ErrorBoundary', () => {
  it('contains a crash and shows the message instead of a blank page', async () => {
    await act(() => root.render(<ErrorBoundary scope="panel"><Boom /></ErrorBoundary>));
    expect(container.querySelector('.crash-card')).not.toBeNull();
    expect(container.querySelector('.crash-detail').textContent).toContain('boom-from-the-doc');
    expect(container.textContent).toContain('返回'); // always a way out
  });

  it('calls onReset and rebuilds the children when the user goes back', async () => {
    const resets = [];
    let shouldThrow = true;
    const Maybe = () => (shouldThrow ? <Boom /> : <div className="fine">ok</div>);
    await act(() => root.render(
      <ErrorBoundary scope="panel" onReset={() => { resets.push(1); shouldThrow = false; }}>
        <Maybe />
      </ErrorBoundary>,
    ));
    expect(container.querySelector('.crash-card')).not.toBeNull();
    await act(() => container.querySelector('.crash-btn').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(resets).toHaveLength(1);
    expect(container.querySelector('.crash-card')).toBeNull();
    expect(container.querySelector('.fine')).not.toBeNull();
  });

  it('passes children straight through when nothing throws', async () => {
    await act(() => root.render(<ErrorBoundary scope="panel"><div className="fine">ok</div></ErrorBoundary>));
    expect(container.querySelector('.fine')).not.toBeNull();
    expect(container.querySelector('.crash-card')).toBeNull();
  });
});
