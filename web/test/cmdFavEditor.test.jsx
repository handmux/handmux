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

const render = (props) => act(() => root.render(<CmdFavEditor windowId="@3" onClose={vi.fn()} {...props} />));
const click = (node) => act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const setInput = (input, value) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
// Add / edit all happen in a centred card; open it via the header ＋ (add) or by tapping a row (edit).
const openAdd = () => click(container.querySelector('.cmd-add-open'));
const card = () => container.querySelector('.cmd-addcard');
const addInput = () => card().querySelector('.cmd-add-input');
const saveBtn = () => card().querySelector('.cmd-submit');
const seg = (name) => [...card().querySelectorAll('.cmd-seg-btn')].find((n) => n.textContent === name);
const modeTab = (name) => [...card().querySelectorAll('.cmd-modetab')].find((n) => n.textContent === name);
// In 按键 mode there are two dropdowns: [0] = sticky key, [1] = base key. Pick option `label` from the i-th.
const dd = (i) => card().querySelectorAll('.cmd-dd')[i];
const pickFromDD = (i, label) => {
  click(dd(i).querySelector('.cmd-dd-btn'));
  click([...dd(i).querySelectorAll('.cmd-dd-opt')].find((n) => n.textContent === label));
};

describe('CmdFavEditor', () => {
  it('renders a global section always and a window section only when a windowId is given', () => {
    render({ windowId: null });
    expect(container.querySelectorAll('.cmd-esection')).toHaveLength(1);
    render({ windowId: '@3' });
    expect(container.querySelectorAll('.cmd-esection')).toHaveLength(2);
  });

  it('adds a command; the 带回车 switch stores enter and shows a ⏎', () => {
    render();
    openAdd();
    setInput(addInput(), 'npm test');
    click(card().querySelector('.cmd-switch input')); // flip 带回车
    click(saveBtn());
    expect(loadFavs(CMD_GLOBAL)).toEqual([{ kind: 'cmd', text: 'npm test', enter: true }]);
    expect(container.querySelector('.cmd-esection .cmd-enter')).not.toBeNull();
  });

  it('the 全局/窗口 segmented switch sends the add to the window list', () => {
    render();
    openAdd();
    click(seg('当前窗口')); // scope global → window
    setInput(addInput(), 'make');
    click(saveBtn());
    expect(loadFavs(cmdScope('@3')).map((f) => f.text)).toEqual(['make']);
    expect(loadFavs(CMD_GLOBAL)).toEqual([]);
  });

  it('the 按键 tab picks a sticky key + base key to build a fav (Ctrl+C) — no ⏎, shows the Ctrl+C label', () => {
    render();
    openAdd();
    click(modeTab('按键')); // mode → key
    pickFromDD(0, 'Ctrl');  // sticky-key dropdown → Ctrl
    pickFromDD(1, 'C');     // base-key dropdown → C
    click(saveBtn());
    expect(loadFavs(CMD_GLOBAL)).toEqual([{ kind: 'key', text: 'C-c', label: 'Ctrl+C' }]);
    expect([...container.querySelectorAll('.cmd-fav-text')].some((n) => n.textContent.includes('Ctrl+C'))).toBe(true);
  });

  it('the base-key picker can bind a named key (Ctrl + ↑) without typing', () => {
    render();
    openAdd();
    click(modeTab('按键'));
    pickFromDD(0, 'Ctrl');   // sticky → Ctrl
    pickFromDD(1, '↑ Up');   // base → the Up arrow, selected not typed
    click(saveBtn());
    expect(loadFavs(CMD_GLOBAL)).toEqual([{ kind: 'key', text: 'C-Up', label: 'Ctrl+Up' }]);
  });

  it('tapping a command row re-opens the card to edit it in place', () => {
    saveFavs(CMD_GLOBAL, [{ kind: 'cmd', text: 'old', enter: false }]);
    render();
    click(container.querySelector('.cmd-esection .cmd-fav-text')); // tap row → edit
    setInput(addInput(), 'new cmd');
    click(saveBtn());
    expect(loadFavs(CMD_GLOBAL)).toEqual([{ kind: 'cmd', text: 'new cmd', enter: false }]);
  });

  it('editing a key fav seeds the sticky-key + base back from the chord', () => {
    saveFavs(CMD_GLOBAL, [{ kind: 'key', text: 'C-c', label: 'Ctrl+C' }]);
    render();
    click(container.querySelector('.cmd-esection .cmd-fav-text')); // tap row → edit (Ctrl + 'c' pre-filled)
    pickFromDD(1, 'D');                                            // re-pick just the base key
    click(saveBtn());
    expect(loadFavs(CMD_GLOBAL)).toEqual([{ kind: 'key', text: 'C-d', label: 'Ctrl+D' }]);
  });

  it('chat variant: one global section, no scope picker; a message saves to the agent list', () => {
    localStorage.setItem('hm_favs6_agent', JSON.stringify([])); // start empty
    act(() => root.render(<CmdFavEditor variant="chat" onClose={vi.fn()} />));
    expect(container.querySelectorAll('.cmd-esection')).toHaveLength(1); // single list, no per-window
    openAdd();
    expect(card().querySelector('.cmd-seg')).toBeNull();                 // no 全局/窗口 segmented
    expect(card().querySelector('.cmd-toggle-row')).not.toBeNull();      // chat also configures Enter explicitly
    expect(card().querySelector('.cmd-switch input').checked).toBe(true); // default keeps historical tap-to-send
    setInput(addInput(), '用中文回答');
    click(saveBtn());
    expect(loadFavs('agent')).toEqual([{ kind: 'reply', text: '用中文回答', enter: true }]);
  });

  it('shows config presets in a locked section without edit/delete/reorder controls', () => {
    const presets = [
      { type: 'key', key: 'Escape', label: 'Esc' },
      { type: 'text', text: 'ok', enter: true },
    ];
    render({ presets });
    const locked = container.querySelector('.cmd-config-section');
    expect(locked.textContent).toContain('配置预置');
    expect(locked.textContent).toContain('Esc');
    expect(locked.textContent).toContain('ok');
    expect(locked.querySelectorAll('.cmd-del, .cmd-move')).toHaveLength(0);
    expect(locked.querySelectorAll('button')).toHaveLength(0);
  });

  it('chat variant: a slash message is stored as a cmd, and 按键 tab saves a bare key fav (Esc)', () => {
    localStorage.setItem('hm_favs6_agent', JSON.stringify([]));
    act(() => root.render(<CmdFavEditor variant="chat" onClose={vi.fn()} />));
    openAdd();
    setInput(addInput(), '/compact');
    click(saveBtn());
    openAdd();
    click(modeTab('按键'));
    pickFromDD(1, '⎋ Esc'); // no modifier — a named key is sendable on its own
    click(saveBtn());
    expect(loadFavs('agent')).toEqual([
      { kind: 'cmd', text: '/compact', enter: true },
      { kind: 'key', text: 'Escape', label: 'Esc' },
    ]);
  });

  it('▲▼ reorder the list; the top item cannot move up', () => {
    saveFavs(CMD_GLOBAL, [{ kind: 'cmd', text: 'one' }, { kind: 'cmd', text: 'two' }]);
    render();
    const global = container.querySelectorAll('.cmd-esection')[0];
    const rows = () => [...global.querySelectorAll('.cmd-fav-text')].map((n) => n.textContent);
    expect(rows()).toEqual(['one', 'two']);
    expect(global.querySelector('.cmd-move.up').disabled).toBe(true);
    const twoRow = [...global.querySelectorAll('.cmd-row')][1];
    click(twoRow.querySelector('.cmd-move.up'));
    expect(rows()).toEqual(['two', 'one']);
    expect(loadFavs(CMD_GLOBAL).map((f) => f.text)).toEqual(['two', 'one']);
  });
});
