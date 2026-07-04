import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import KeyBar from '../src/components/KeyBar.jsx';

let container, root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

// mods are controlled (lifted to BottomDock). Wrap KeyBar in a tiny stateful harness so the modifier
// arm/lock transitions actually take effect between fires.
function Harness(props) {
  const [mods, setMods] = useState({ ctrl: 'off', shift: 'off', alt: 'off' });
  return <KeyBar mods={mods} setMods={setMods} {...props} />;
}
const render = (props) => act(() => root.render(
  <Harness onKey={vi.fn()} onText={vi.fn()} onOpenFav={vi.fn()} onToggleKeyboard={vi.fn()} keyboardUp={false} {...props} />));
const btn = (id) => container.querySelector(`[data-key="${id}"]`);
const fire = (node, type, EventCtor = MouseEvent) => act(() => node.dispatchEvent(new EventCtor(type, { bubbles: true })));

describe('KeyBar command grid', () => {
  it('renders the full 3×7 grid (⌨/常用 controls, Esc/Tab/⌫/enter, arrows, modifiers, symbols)', () => {
    render();
    for (const id of ['kbd', 'fav', 'esc', 'tab', 'del', 'enter',
      'up', 'down', 'left', 'right', 'ctrl', 'shift', 'alt', 'pipe', 'slash', 'tilde', 'dash', 'under', 'bslash', 'gt', 'lt']) {
      expect(btn(id)).not.toBeNull();
    }
  });

  it('a named key calls onKey, a symbol calls onText, enter/⌫ map correctly', () => {
    const onKey = vi.fn(), onText = vi.fn();
    render({ onKey, onText });
    fire(btn('esc'), 'click');
    fire(btn('pipe'), 'click');
    fire(btn('enter'), 'click');
    fire(btn('del'), 'pointerdown'); fire(btn('del'), 'pointerup'); // ⌫ is a repeat key
    expect(onKey).toHaveBeenCalledWith('Escape');
    expect(onText).toHaveBeenCalledWith('|');
    expect(onKey).toHaveBeenCalledWith('Enter');
    expect(onKey).toHaveBeenCalledWith('BSpace');
  });

  it('⌨ calls onToggleKeyboard and lights up when the keyboard is up', () => {
    const onToggleKeyboard = vi.fn();
    render({ onToggleKeyboard, keyboardUp: true });
    expect(btn('kbd').classList.contains('on')).toBe(true);
    fire(btn('kbd'), 'click');
    expect(onToggleKeyboard).toHaveBeenCalled();
  });

  it('常用 calls onOpenFav', () => {
    const onOpenFav = vi.fn();
    render({ onOpenFav });
    fire(btn('fav'), 'click');
    expect(onOpenFav).toHaveBeenCalled();
  });

  it('armed Shift turns Tab into BTab and ▲ into S-Up, then resets', () => {
    const onKey = vi.fn();
    render({ onKey });
    fire(btn('shift'), 'click'); // arm
    fire(btn('tab'), 'click');
    expect(onKey).toHaveBeenCalledWith('BTab');
    fire(btn('shift'), 'click'); // arm again (the first one was consumed)
    fire(btn('up'), 'pointerdown'); fire(btn('up'), 'pointerup'); // ▲ is a repeat key
    expect(onKey).toHaveBeenCalledWith('S-Up');
  });

  it('single-click arms/clears the modifier; double-click locks it', () => {
    render();
    fire(btn('ctrl'), 'click');
    expect(btn('ctrl').classList.contains('armed')).toBe(true);
    fire(btn('ctrl'), 'click'); // single click again → clears
    expect(btn('ctrl').classList.contains('armed')).toBe(false);
    fire(btn('ctrl'), 'dblclick'); // double-click → locked (fixed on)
    expect(btn('ctrl').classList.contains('locked')).toBe(true);
  });

  it('holding an arrow repeats after the swipe-guard, releasing stops', () => {
    vi.useFakeTimers();
    const onKey = vi.fn();
    render({ onKey });
    fire(btn('up'), 'pointerdown');
    // 140ms guard → first press; then 400ms repeat delay + two 120ms intervals → two more.
    act(() => vi.advanceTimersByTime(140 + 400 + 120 + 120));
    fire(btn('up'), 'pointerup');
    act(() => vi.advanceTimersByTime(1000));
    expect(onKey).toHaveBeenCalledTimes(3);
    expect(onKey).toHaveBeenCalledWith('Up');
  });

  it('a quick tap (release before the guard) fires exactly one press', () => {
    vi.useFakeTimers();
    const onKey = vi.fn();
    render({ onKey });
    fire(btn('up'), 'pointerdown');
    act(() => vi.advanceTimersByTime(60)); // still inside the 140ms guard
    fire(btn('up'), 'pointerup');
    act(() => vi.advanceTimersByTime(1000));
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledWith('Up');
  });

  it('a swipe (finger moves past the threshold) never fires — no stray key while paging', () => {
    vi.useFakeTimers();
    const onKey = vi.fn();
    render({ onKey });
    fire(btn('up'), 'pointerdown');
    act(() => btn('up').dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 0 })));
    act(() => vi.advanceTimersByTime(1000)); // guard would have elapsed, but the move cancelled it
    fire(btn('up'), 'pointerup');
    expect(onKey).not.toHaveBeenCalled();
  });
});
