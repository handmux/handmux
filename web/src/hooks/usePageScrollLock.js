import { useEffect } from 'react';

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
function scrollableAxes(el) {
  const x = [], y = [];
  for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const s = getComputedStyle(n);
    if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && n.scrollHeight > n.clientHeight) y.push(n);
    if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && n.scrollWidth > n.clientWidth) x.push(n);
  }
  return { x, y };
}

function canConsumeVertical(owners, fingerDy) {
  if (fingerDy === 0) return true;
  return owners.some((owner) => (
    fingerDy < 0
      ? owner.scrollTop + owner.clientHeight < owner.scrollHeight - 1
      : owner.scrollTop > 1
  ));
}

export function usePageScrollLock() {
  useEffect(() => {
    let mode = 'block'; // 'yscroll' (boundary-aware) | 'xonly' (horizontal scroller) | 'block'
    let owners = { x: [], y: [] };
    let sx = 0, sy = 0, lastY = 0;
    const onStart = (e) => {
      const t = e.touches[0];
      sx = t ? t.clientX : 0;
      sy = t ? t.clientY : 0;
      lastY = sy;
      if (!(e.target instanceof Element)) { mode = 'block'; owners = { x: [], y: [] }; return; }
      owners = scrollableAxes(e.target);
      mode = owners.y.length ? 'yscroll' : owners.x.length ? 'xonly' : 'block';
    };
    const onMove = (e) => {
      if (!e.cancelable) return;
      const t = e.touches[0];
      const dx = t ? t.clientX - sx : 0;
      const dy = t ? t.clientY - sy : 0;
      const stepDy = t ? t.clientY - lastY : 0;
      if (t) lastY = t.clientY;
      if (mode === 'yscroll') {
        if (Math.abs(dx) > Math.abs(dy) || canConsumeVertical(owners.y, stepDy)) return;
        e.preventDefault(); // the vertical owner hit its edge — do not hand the rest to the page
        return;
      }
      if (mode === 'xonly') {
        if (t && Math.abs(dx) >= Math.abs(dy)) return; // horizontal → its own axis
      }
      e.preventDefault(); // block the page pan (vertical on the strip, everything on a non-scroller)
    };
    document.addEventListener('touchstart', onStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onMove, { passive: false, capture: true });
    return () => {
      document.removeEventListener('touchstart', onStart, { capture: true });
      document.removeEventListener('touchmove', onMove, { capture: true });
    };
  }, []);
}
