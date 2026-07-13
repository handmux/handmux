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
// onHint(show) toggles the "press again to exit" hint. ONE timer drives both the hint's visibility and
// the re-trap, so the hint is shown for EXACTLY the arm window: the instant it hides, the guard is back on
// the stack and the next Back re-prompts instead of silently exiting. (A separate display timer would drift
// out of step with this window — hint gone but guard not yet re-pushed → a dead zone where Back falls
// straight through.) onHint is held in a ref so an unstable inline callback doesn't re-run the effect
// (which would pile up guard entries); the effect depends only on `enabled`.
export function useExitConfirm(enabled, onHint, windowMs = 2000) {
  const cbRef = useRef(onHint);
  cbRef.current = onHint;
  useEffect(() => {
    if (!enabled) return undefined;
    let armed = false;
    let timer = null;
    let pushed = false;
    // Stamp the entry we sit on as OUR root, so we can arm ONLY when a Back actually lands back HERE.
    // Crucial for the notification path: tapping a system notification navigate()s the client to a deep
    // link, and that same-document navigation fires a popstate landing on a FRESH, unmarked entry. That is
    // NOT a Back — without this marker the old code treated any non-guard popstate as a root Back and
    // spuriously popped the "press again to exit" hint the instant you arrived (no key pressed at all).
    const markRoot = () => {
      if (!window.history.state?.exitRoot) {
        window.history.replaceState({ ...window.history.state, exitRoot: true }, '');
      }
    };
    const pushGuard = () => {
      if (pushed || window.history.state?.exitGuard) return; // never stack two guards
      window.history.pushState({ exitGuard: true }, '');
      pushed = true;
    };
    const clearArm = () => {           // drop the armed state AND hide the hint together
      if (timer) { clearTimeout(timer); timer = null; }
      if (armed) { armed = false; cbRef.current?.(false); }
    };
    markRoot();
    pushGuard();
    const onPop = () => {
      if (window.history.state?.exitGuard) { pushed = true; clearArm(); return; } // back onto our guard: an overlay above closed
      if (!window.history.state?.exitRoot) return; // landed on some other/new entry (forward nav, not a Back) → ignore
      pushed = false;                       // our guard was consumed → we're back on our root
      if (armed) return;                    // (a fast 2nd press usually exits before this fires; be safe)
      armed = true;
      cbRef.current?.(true);                // show "press again to exit"
      timer = setTimeout(() => {            // window lapsed → hide hint AND re-trap, in one shot
        armed = false; timer = null;
        cbRef.current?.(false);
        pushGuard();
      }, windowMs);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (timer) clearTimeout(timer);
      if (armed) cbRef.current?.(false); // leaving while armed → don't strand the hint on screen
      // Closed by other means (unbind / navigation) while our guard is still on top → reclaim it so history
      // stays balanced. If Back already consumed it, the state is no longer ours and we leave history alone.
      if (pushed && window.history.state?.exitGuard) window.history.back();
    };
  }, [enabled, windowMs]);
}
