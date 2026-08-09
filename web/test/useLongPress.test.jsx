import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useLongPress } from '../src/hooks/useLongPress.js';

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

// A probe button that spreads the hook's handlers, so we can fire pointer/click events at it.
function Probe({ onLong, onClick }) {
  const lp = useLongPress(onLong, { onClick });
  return <button data-testid="t" {...lp}>x</button>;
}
const render = (props) => act(() => root.render(<Probe {...props} />));
const btn = () => container.querySelector('[data-testid="t"]');
const fire = (type, init = {}) =>
  act(() => btn().dispatchEvent(new MouseEvent(type, { bubbles: true, ...init })));

describe('useLongPress', () => {
  it('a short tap fires onClick, never onLongPress', () => {
    vi.useFakeTimers();
    const onLong = vi.fn(); const onClick = vi.fn();
    render({ onLong, onClick });
    fire('pointerdown', { clientX: 0, clientY: 0 });
    fire('pointerup');
    fire('click');
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onLong).not.toHaveBeenCalled();
  });

  it('holding past the threshold fires onLongPress and suppresses the trailing click', () => {
    vi.useFakeTimers();
    const onLong = vi.fn(); const onClick = vi.fn();
    render({ onLong, onClick });
    fire('pointerdown', { clientX: 0, clientY: 0 });
    act(() => vi.advanceTimersByTime(500));
    expect(onLong).toHaveBeenCalledTimes(1);
    fire('pointerup');
    fire('click'); // the browser's post-longpress click must NOT select
    expect(onClick).not.toHaveBeenCalled();
  });

  it('a finger move past the threshold cancels the long-press (it was a scroll)', () => {
    vi.useFakeTimers();
    const onLong = vi.fn(); const onClick = vi.fn();
    render({ onLong, onClick });
    fire('pointerdown', { clientX: 0, clientY: 0 });
    fire('pointermove', { clientX: 40, clientY: 0 }); // > MOVE_PX
    act(() => vi.advanceTimersByTime(500));
    expect(onLong).not.toHaveBeenCalled();
    fire('pointerup');
    fire('click');
    expect(onClick).toHaveBeenCalledTimes(1); // a cancelled long-press still allows the tap
  });

  it('pointercancel/leave before the threshold aborts the long-press', () => {
    vi.useFakeTimers();
    const onLong = vi.fn();
    render({ onLong, onClick: vi.fn() });
    fire('pointerdown', { clientX: 0, clientY: 0 });
    fire('pointercancel');
    act(() => vi.advanceTimersByTime(500));
    expect(onLong).not.toHaveBeenCalled();
  });

  it('clears a pending hold timer when the owner unmounts', () => {
    vi.useFakeTimers();
    const onLong = vi.fn();
    render({ onLong, onClick: vi.fn() });
    fire('pointerdown', { clientX: 0, clientY: 0 });
    act(() => root.render(null));
    act(() => vi.advanceTimersByTime(500));
    expect(onLong).not.toHaveBeenCalled();
  });
});
