import { useEffect } from 'react';

interface ScrollableAxes {
  x: Element[];
  y: Element[];
}

type TouchMode = 'yscroll' | 'xonly' | 'block';

// Lock the PAGE against native touch scrolling/panning, everywhere except elements genuinely meant to
// scroll — and, for a horizontal-only scroller (the key strip), only along its own axis. This kills two
// linked bugs that both trace to the same cause: with the soft keyboard up, the browser natively scrolls
// the whole page to keep the focused input visible, and that scroll is draggable, so:
//   • dragging the dock pans the entire app up/down under your finger (measured appΔ==dockΔ, keyboard
//     itself never moves → it's a page scroll, not our transform);
//   • on iOS that scroll pushes visualViewport.offsetTop up until `innerHeight - vv.height - vv.offsetTop`
//     cancels to 0 — which is exactly why useKeyboardInset read 0 and our translateY(-inset) lift silently
//     no-oped on iOS. Locking the scroll keeps offsetTop at 0, so the inset measures right and the lift
//     works again.
//
// Per touch we look at where the finger landed:
//   canScrollY (terminal viewport, sheet bodies) → leave it to native only while the gesture's direction
//     still has scroll room. At a top/bottom edge we must block the remainder or it chains into page-pan.
//   canScrollX only (the horizontal key strip) → allow horizontal moves, block vertical (the page-pan leak
//     from key buttons, whose touch-action:manipulation would otherwise let a vertical drag pan the page).
//   neither (dock handle, composer, gaps) → block every direction.
function scrollableAxes(el: Element): ScrollableAxes {
  const x: Element[] = [];
  const y: Element[] = [];
  for (let node: Element | null = el;
    node && node !== document.body && node !== document.documentElement;
    node = node.parentElement) {
    const style = getComputedStyle(node);
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll')
      && node.scrollHeight > node.clientHeight) y.push(node);
    if ((style.overflowX === 'auto' || style.overflowX === 'scroll')
      && node.scrollWidth > node.clientWidth) x.push(node);
  }
  return { x, y };
}

function canConsumeVertical(owners: Element[], fingerDy: number): boolean {
  if (fingerDy === 0) return true;
  return owners.some((owner) => (
    fingerDy < 0
      ? owner.scrollTop + owner.clientHeight < owner.scrollHeight - 1
      : owner.scrollTop > 1
  ));
}

export function usePageScrollLock(): void {
  useEffect(() => {
    let mode: TouchMode = 'block';
    let owners: ScrollableAxes = { x: [], y: [] };
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      startX = touch ? touch.clientX : 0;
      startY = touch ? touch.clientY : 0;
      lastY = startY;
      if (!(event.target instanceof Element)) {
        mode = 'block';
        owners = { x: [], y: [] };
        return;
      }
      owners = scrollableAxes(event.target);
      mode = owners.y.length ? 'yscroll' : owners.x.length ? 'xonly' : 'block';
    };
    const onMove = (event: TouchEvent) => {
      if (!event.cancelable) return;
      const touch = event.touches[0];
      const dx = touch ? touch.clientX - startX : 0;
      const dy = touch ? touch.clientY - startY : 0;
      const stepDy = touch ? touch.clientY - lastY : 0;
      if (touch) lastY = touch.clientY;
      if (mode === 'yscroll') {
        if (Math.abs(dx) > Math.abs(dy) || canConsumeVertical(owners.y, stepDy)) return;
        event.preventDefault(); // the vertical owner hit its edge — do not hand the rest to the page
        return;
      }
      if (mode === 'xonly' && touch && Math.abs(dx) >= Math.abs(dy)) return;
      event.preventDefault(); // block the page pan (vertical on the strip, everything on a non-scroller)
    };
    document.addEventListener('touchstart', onStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onMove, { passive: false, capture: true });
    return () => {
      document.removeEventListener('touchstart', onStart, { capture: true });
      document.removeEventListener('touchmove', onMove, { capture: true });
    };
  }, []);
}
