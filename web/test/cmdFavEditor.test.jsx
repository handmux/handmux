import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import CmdFavEditor from '../src/components/CmdFavEditor.jsx';
import { loadFavs, saveFavs, cmdScope, CMD_GLOBAL } from '../src/favStore.js';

let container, root;
beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const render = (props) => act(() => root.render(<CmdFavEditor open windowId="@3" onClose={vi.fn()} {...props} />));
const type = (input, value) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

describe('CmdFavEditor', () => {
  it('renders a global section always and a window section only when a windowId is given', () => {
    render({ windowId: null });
    expect(container.querySelectorAll('.cmd-esection')).toHaveLength(1); // global only
    render({ windowId: '@3' });
    expect(container.querySelectorAll('.cmd-esection')).toHaveLength(2); // global + window
  });

  it('adds a command to the window scope with the 带回车 flag, and shows the ⏎', () => {
    render();
    const winSection = container.querySelectorAll('.cmd-esection')[1];
    type(winSection.querySelector('.fav-add-input'), 'make build');
    act(() => winSection.querySelector('.cmd-enter-opt input').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => winSection.querySelector('.fav-add-btn').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const saved = loadFavs(cmdScope('@3'));
    expect(saved).toEqual([{ kind: 'cmd', text: 'make build', enter: true }]);
    expect(winSection.querySelector('.cmd-enter')).not.toBeNull(); // the ⏎ marker
    expect(loadFavs(CMD_GLOBAL)).toEqual([]); // window add never touched the global list
  });

  it('▲▼ reorder the list; the top item cannot move up', () => {
    saveFavs(CMD_GLOBAL, [{ kind: 'cmd', text: 'one' }, { kind: 'cmd', text: 'two' }]);
    render();
    const global = container.querySelectorAll('.cmd-esection')[0];
    const rows = () => [...global.querySelectorAll('.cmd-fav-text')].map((n) => n.textContent);
    expect(rows()).toEqual(['one', 'two']);
    expect(global.querySelector('.cmd-move.up').disabled).toBe(true); // first row: up disabled
    // move 'two' up
    const twoRow = [...global.querySelectorAll('.cmd-row')][1];
    act(() => twoRow.querySelector('.cmd-move.up').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(rows()).toEqual(['two', 'one']);
    expect(loadFavs(CMD_GLOBAL).map((f) => f.text)).toEqual(['two', 'one']);
  });
});
