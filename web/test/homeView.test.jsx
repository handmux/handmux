// web/test/homeView.test.jsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../src/storage.js', () => ({
  getRecentDocs: vi.fn(() => [{ path: '/home/u/r.md', name: 'r.md', type: 'markdown', ts: 1 }]),
  removeRecentDoc: vi.fn(),
}));

import HomeView from '../src/components/HomeView.jsx';
import { getRecentDocs } from '../src/storage.js';

let container, root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });
const render = (props) => act(() => root.render(<HomeView {...props} />));
const click = (node) => act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('HomeView', () => {
  it('lists only recents (the directory browser is a separate segment)', async () => {
    await render({ onOpenDoc: vi.fn() });
    expect(container.textContent).toContain('r.md');
    expect(container.querySelector('.browse-view')).toBeNull();
  });

  it('opens a recent entry via onOpenDoc', async () => {
    const onOpenDoc = vi.fn();
    await render({ onOpenDoc });
    await click([...container.querySelectorAll('.home-recent')].find((b) => b.textContent.includes('r.md')));
    expect(onOpenDoc).toHaveBeenCalledWith('/home/u/r.md');
  });

  it('shows an empty hint pointing at 新增 when there are no recents', async () => {
    getRecentDocs.mockReturnValueOnce([]);
    await render({ onOpenDoc: vi.fn() });
    expect(container.querySelector('.home-empty')?.textContent).toContain('新增');
  });

  it('drops malformed recent entries from the localStorage boundary', async () => {
    getRecentDocs.mockReturnValueOnce([{ path: 7, name: 'bad' }, null, { path: '/home/u/good.md', name: 'good.md' }]);
    await render({ onOpenDoc: vi.fn() });
    expect([...container.querySelectorAll('.home-name')].map((node) => node.textContent)).toEqual(['good.md']);
  });
});
