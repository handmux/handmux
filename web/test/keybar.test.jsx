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
  <Harness onKey={vi.fn()} onText={vi.fn()} {...props} />));
const btn = (id) => container.querySelector(`[data-key="${id}"]`);
const fire = (node, type, EventCtor = MouseEvent) => act(() => node.dispatchEvent(new EventCtor(type, { bubbles: true })));
// A click with an explicit timeStamp — the modifier double-tap-to-lock detection reads e.timeStamp, so
// tests must control it (MouseEvent's constructor ignores a timeStamp option).
const clickAt = (node, ts) => act(() => {
  const e = new MouseEvent('click', { bubbles: true });
  Object.defineProperty(e, 'timeStamp', { value: ts });
  node.dispatchEvent(e);
});

describe('KeyBar command grid', () => {
  it('renders Alt above Space in the 2×7 command grid', () => {
    render();
    for (const id of ['esc', 'tab', 'space', 'slash', 'at', 'del', 'enter',
      'up', 'down', 'left', 'right', 'ctrl', 'shift', 'alt']) {
      expect(btn(id)).not.toBeNull();
    }
    expect(btn('tilde')).toBeNull();
    const ids = [...container.querySelectorAll('.keybar-key')].map((node) => node.dataset.key);
    expect(ids.slice(0, 3)).toEqual(['esc', 'tab', 'alt']);
    expect(ids.slice(7, 10)).toEqual(['ctrl', 'shift', 'space']);
    expect(btn('space').textContent).toBe('␣');
    expect(btn('space').getAttribute('aria-label')).toBe('Space');
    // The ⌨ toggle, 常用 opener, and the buried shell symbols are gone from the grid.
    for (const id of ['kbd', 'fav', 'pipe', 'dash', 'under', 'bslash', 'gt', 'lt']) expect(btn(id)).toBeNull();
  });

  it('a named key calls onKey, a symbol calls onText, Space/enter/⌫ map correctly', () => {
    const onKey = vi.fn(), onText = vi.fn();
    render({ onKey, onText });
    fire(btn('esc'), 'click');
    fire(btn('slash'), 'click');
    fire(btn('at'), 'click');
    fire(btn('space'), 'click');
    fire(btn('enter'), 'click');
    fire(btn('del'), 'pointerdown'); fire(btn('del'), 'pointerup'); // ⌫ is a repeat key
    expect(onKey).toHaveBeenCalledWith('Escape');
    expect(onText).toHaveBeenCalledWith('/');
    expect(onText).toHaveBeenCalledWith('@');
    expect(onKey).toHaveBeenCalledWith('Space');
    expect(onKey).toHaveBeenCalledWith('Enter');
    expect(onKey).toHaveBeenCalledWith('BSpace');
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

  it('single-click arms/clears the modifier; two fast taps on the same key lock it', () => {
    render();
    clickAt(btn('ctrl'), 100);            // arm
    expect(btn('ctrl').classList.contains('armed')).toBe(true);
    clickAt(btn('ctrl'), 1000);           // >300ms later → a fresh single click → clears
    expect(btn('ctrl').classList.contains('armed')).toBe(false);
    clickAt(btn('ctrl'), 2000);           // arm again
    clickAt(btn('ctrl'), 2150);           // within 300ms → locked (fixed on)
    expect(btn('ctrl').classList.contains('locked')).toBe(true);
  });

  // Regression: two quick taps on DIFFERENT keys must NOT lock the second. Mobile browsers coalesce fast
  // taps on adjacent keys into a dblclick dispatched to the second key; per-key timestamps ignore that.
  it('quick taps on two different modifiers just arm each — the second is not locked', () => {
    render();
    clickAt(btn('ctrl'), 100);            // tap key A
    clickAt(btn('shift'), 150);           // tap key B 50ms later
    expect(btn('ctrl').classList.contains('armed')).toBe(true);
    expect(btn('shift').classList.contains('armed')).toBe(true);
    expect(btn('shift').classList.contains('locked')).toBe(false);
  });

  it('holding an arrow repeats after the swipe-guard, releasing stops', () => {
    vi.useFakeTimers();
    const onKey = vi.fn();
    render({ onKey });
    fire(btn('up'), 'pointerdown');
    // 500ms hold guard → first press; then 400ms repeat delay + two 120ms intervals → two more.
    act(() => vi.advanceTimersByTime(500 + 400 + 120 + 120));
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
    act(() => vi.advanceTimersByTime(60)); // still inside the 500ms hold guard
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
