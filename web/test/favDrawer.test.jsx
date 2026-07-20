import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import FavDrawer from '../src/components/FavDrawer.jsx';

let container, root;
beforeEach(() => { localStorage.clear(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = (props) => act(() => root.render(<FavDrawer open mode="agent" onSend={vi.fn()} onFill={vi.fn()} onClose={vi.fn()} {...props} />));
const fire = (node, type) => act(() => node.dispatchEvent(new MouseEvent(type, { bubbles: true })));

describe('FavDrawer', () => {
  it('agent mode shows phone-local reply chips and Claude commands', () => {
    localStorage.setItem('hm_favs7_agent', JSON.stringify([
      { kind: 'reply', text: 'mine', enter: true },
      { kind: 'cmd', text: '/review', enter: true },
    ]));
    render({ mode: 'agent' });
    expect([...container.querySelectorAll('.fav-chip')].map((n) => n.textContent)).toContain('mine');
    expect(container.textContent).toContain('/review');
  });
  it('command mode shows the (empty) commands list, no reply chips', () => {
    render({ mode: 'command' });
    expect(container.querySelector('.fav-chip')).toBeNull();
  });
  it('tapping a reply chip sends it directly', () => {
    const onSend = vi.fn();
    localStorage.setItem('hm_favs7_agent', JSON.stringify([{ kind: 'reply', text: 'mine', enter: true }]));
    render({ mode: 'agent', onSend });
    fire([...container.querySelectorAll('.fav-chip')].find((n) => n.textContent === 'mine'), 'click');
    expect(onSend).toHaveBeenCalledWith('mine');
  });
  it('adding a custom entry persists and shows it', () => {
    render({ mode: 'command' });
    const input = container.querySelector('.fav-add-input');
    act(() => { input.value = 'npm test'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    fire(container.querySelector('.fav-add-btn'), 'click');
    expect(container.textContent).toContain('npm test');
  });
});
