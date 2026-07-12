import { useEffect, useRef } from 'react';

// Guard the ROOT of the app (the main page, nothing else trapping Back) against an accidental exit: the
// first Back is caught and shows a "press again to exit" hint; only a SECOND Back within `windowMs` actually
// leaves. Mobile Back would otherwise close the PWA on a single mis-tap.
//
// How it works with the history stack (bottom→top): while enabled we keep ONE guard entry above root —
// [root, guard]. The first Back pops the guard → popstate fires (we're now at root): we ARM (notify + a
// timer) but do NOT re-push, so a second Back now falls off root and the browser exits naturally. If the
// window lapses with no second press, we DISARM and re-push the guard (in the timer — never inside popstate,
// which some Android WebViews mishandle) so a later Back is trapped again.
//
// Overlays (Settings, sheets, …) push their OWN entries ABOVE our guard, so Back closes them first; our
// popstate only reaches the guard once they're all gone. We tell the two apart by the state we LAND on:
// landing back on `{exitGuard:true}` means an overlay above us closed (do nothing); landing past it (guard
// consumed) is the real root Back → arm.
//
// notify is held in a ref so an unstable inline callback doesn't re-run the effect (which would pile up
// guard entries); the effect depends only on `enabled`.
export function useExitConfirm(enabled, notify, windowMs = 2000) {
  const cbRef = useRef(notify);
  cbRef.current = notify;
  useEffect(() => {
    if (!enabled) return undefined;
    let armed = false;
    let timer = null;
    let pushed = false;
    const pushGuard = () => {
      if (pushed || window.history.state?.exitGuard) return; // never stack two guards
      window.history.pushState({ exitGuard: true }, '');
      pushed = true;
    };
    const disarm = () => { armed = false; if (timer) { clearTimeout(timer); timer = null; } };
    pushGuard();
    const onPop = () => {
      if (window.history.state?.exitGuard) { pushed = true; disarm(); return; } // back onto our guard: an overlay above closed
      pushed = false;                       // our guard was consumed → we're at root
      if (armed) return;                    // (a fast 2nd press usually exits before this fires; be safe)
      armed = true;
      cbRef.current?.();                    // show "press again to exit"
      timer = setTimeout(() => { armed = false; timer = null; pushGuard(); }, windowMs); // lapsed → re-trap
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (timer) clearTimeout(timer);
      // Closed by other means (unbind / navigation) while our guard is still on top → reclaim it so history
      // stays balanced. If Back already consumed it, the state is no longer ours and we leave history alone.
      if (pushed && window.history.state?.exitGuard) window.history.back();
    };
  }, [enabled, windowMs]);
}
