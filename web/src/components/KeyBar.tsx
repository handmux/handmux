import { useRef } from 'react';
import type {
  Dispatch,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
} from 'react';
import {
  COMMAND_ROWS, MODIFIERS, KEY_LABELS, REPEAT_KEYS, keyAction,
  MOD_OFF, MOD_ARMED, MOD_LOCKED, modActive, consumeMods, withMods,
} from '../keybarKeys.js';
import type {
  CommandKeyId,
  ModifierId,
  ModifierState,
  ModifierStateMap,
} from '../keybarKeys.js';
import { createRepeater } from '../repeat.js';
import type { Repeater } from '../repeat.js';

// Friendly screen-reader names for the symbol / arrow keys (their visible label is just a glyph like ▲ /).
const KEY_ARIA: Partial<Record<CommandKeyId, string>> = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  space: 'Space', slash: 'Slash', at: 'At', del: 'Backspace',
};

// In command mode the hidden capture <input> holds the system keyboard open. A <button> tap would move
// focus to itself → the capture blurs → the keyboard collapses (so you couldn't tap Ctrl then a letter
// on the system keyboard). preventDefault on pointer-down keeps focus on the capture; onClick still fires.
const keepFocus = (event: ReactPointerEvent<HTMLButtonElement>): void => {
  if (event.cancelable) event.preventDefault();
};

// How long a repeat key (arrow / ⌫) must be held STILL before it commits to auto-repeat. Long enough
// that brushing an arrow mid-swipe and pausing briefly doesn't fire it (which recalled shell history) —
// a real swipe moves past the 8px gate well inside this window and cancels the repeat.
const HOLD_MS = 500;

// The command keyboard: a fixed 2×7 grid (never scrolls). Row 1 puts Alt beside Esc/Tab, followed by
// /, ▲, @ and ⌫; row 2 has Ctrl/Shift/Space, then the inverted-T arrows (▲ over ◀ ▼ ▶) left of Enter.
// The ⌨ keyboard-toggle and the user's saved commands live in the quick-bar ABOVE this grid (BottomDock).
// Named keys go out via onKey (→ /keys), literals via onText (→ /send). `mods` is controlled (lifted to
// BottomDock so the hidden capture input can share it).
type SetModifiers = Dispatch<SetStateAction<ModifierStateMap>>;

export interface KeyBarProps {
  onKey: (key: string) => void;
  onText: (text: string) => void;
  mods: ModifierStateMap;
  setMods: SetModifiers;
  keyHeldRef?: MutableRefObject<boolean>;
}

function isModifier(id: CommandKeyId): id is ModifierId {
  return MODIFIERS.some((modifier) => modifier === id);
}

export default function KeyBar({ onKey, onText, mods, setMods, keyHeldRef }: KeyBarProps) {
  const modsRef = useRef(mods);
  modsRef.current = mods;

  const dispatch = (id: CommandKeyId): void => {
    const a = keyAction(id);
    if (!a) return;
    const active = MODIFIERS.some((m) => modActive(modsRef.current[m]));
    const act = active ? withMods(a, modsRef.current) : a;
    if (!act) return;
    if (act.kind === 'key') onKey(act.name); else onText(act.ch);
    if (active) setMods(consumeMods);
  };

  const cell = (id: CommandKeyId) => {
    if (isModifier(id)) return <ModKey key={id} id={id} state={mods[id]} setMods={setMods} />;
    return <Key key={id} id={id} dispatch={dispatch}
      {...(keyHeldRef ? { keyHeldRef } : {})} />;
  };

  // A 7-column grid: flattening the rows keeps every column aligned, so ▲ sits directly above ▼ (the
  // inverted-T reads cleanly) and the corners land where they should.
  return <div className="keybar-grid">{COMMAND_ROWS.flat().map(cell)}</div>;
}

// Sticky modifier key. A single CLICK toggles it off ↔ armed — a swipe never fires a click, so dragging
// across the key can't arm it. A DOUBLE-CLICK (two taps on THIS key) locks it on. Armed and locked both
// light up.
//
// We detect the double-tap ourselves instead of using native onDoubleClick: on touch the browser coalesces
// two quick taps on *different* keys into one dblclick (dispatched to their common ancestor / whichever key
// the second tap landed on), which latched the second key by accident. A per-key timestamp only counts two
// taps on the SAME key as a lock — tapping key A then key B fast just arms each once.
const DBL_MS = 300;
interface ModKeyProps {
  id: ModifierId;
  state: ModifierState;
  setMods: SetModifiers;
}

function ModKey({ id, state, setMods }: ModKeyProps) {
  const lastTapRef = useRef(-Infinity);                            // -Infinity so the very first tap is never a "double"
  const onTap = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const now = event.timeStamp || 0;
    if (now - lastTapRef.current < DBL_MS) {
      lastTapRef.current = -Infinity;                              // consume — a 3rd fast tap isn't a lock
      setMods((m) => ({ ...m, [id]: MOD_LOCKED }));
      return;
    }
    lastTapRef.current = now;
    setMods((m) => ({ ...m, [id]: modActive(m[id]) ? MOD_OFF : MOD_ARMED }));
  };
  const cls = state === MOD_LOCKED ? ' locked' : modActive(state) ? ' armed' : '';
  return (
    <button type="button" className={`keybar-key keybar-mod${cls}`} data-key={id} data-state={state}
      aria-pressed={modActive(state)} aria-label={KEY_LABELS[id]}
      onPointerDown={keepFocus} onClick={onTap}>{KEY_LABELS[id]}</button>
  );
}

interface KeyGesture {
  x: number;
  y: number;
  held: boolean;
  moved: boolean;
  guard: ReturnType<typeof setTimeout> | null;
}

interface KeyProps {
  id: CommandKeyId;
  dispatch: (id: CommandKeyId) => void;
  keyHeldRef?: MutableRefObject<boolean>;
}

function Key({ id, dispatch, keyHeldRef }: KeyProps) {
  const repRef = useRef<Repeater | null>(null);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch; // repeater must always call the latest dispatch (pane id changes)
  const gRef = useRef<KeyGesture | null>(null);      // in-flight gesture: { x, y, guard, held, moved }
  // Mark this touch as "owned by a held key" so the pager won't swipe out from under it (BottomDock reads
  // keyHeldRef). Released the moment we detect a swipe, so a deliberate swipe starting here still pages.
  const claim = (value: boolean): void => { if (keyHeldRef) keyHeldRef.current = value; };
  const label = KEY_LABELS[id];
  if (!REPEAT_KEYS.has(id)) {
    // Fires on CLICK (release), never on touch-down — a left/right page swipe that starts on the key
    // moves off and cancels the click, so dragging across never triggers it. keepFocus keeps the system
    // keyboard open (tapping this key mustn't blur the capture input).
    return <button type="button" className="keybar-key" data-key={id} aria-label={KEY_ARIA[id] || label}
      onPointerDown={keepFocus} onClick={() => dispatch(id)}>{label}</button>;
  }
  // Held arrow / ⌫ auto-repeats — but a page swipe can start on a key too, so we must NOT fire on
  // touch-down. A HOLD_MS guard disambiguates: hold still past it → the repeater kicks in (first press +
  // repeat); release before it → one press (a tap); move the finger (a swipe) → cancel, no press.
  const clearGuard = () => { const g = gRef.current; if (g?.guard) { clearTimeout(g.guard); g.guard = null; } };
  const down = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.cancelable) event.preventDefault();
    if (!repRef.current) repRef.current = createRepeater(() => dispatchRef.current(id));
    const g: KeyGesture = {
      x: event.clientX,
      y: event.clientY,
      held: false,
      moved: false,
      guard: null,
    };
    g.guard = setTimeout(() => { g.held = true; g.guard = null; repRef.current?.start(); }, HOLD_MS);
    gRef.current = g;
    claim(true); // this touch is a key press until proven a swipe
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const g = gRef.current;
    if (!g || g.held) return; // once repeating we've committed to a press; a later drift doesn't matter
    if (Math.abs(event.clientX - g.x) > 8 || Math.abs(event.clientY - g.y) > 8) { g.moved = true; clearGuard(); claim(false); } // it's a swipe → hand it to the pager
  };
  const up = () => {
    const g = gRef.current;
    claim(false);
    if (!g) return;
    clearGuard();
    if (g.held) repRef.current?.stop();          // was repeating → stop
    else if (!g.moved) dispatchRef.current(id); // quick tap, never moved → one press
    gRef.current = null;
  };
  const cancel = () => {
    claim(false);
    clearGuard();
    if (gRef.current?.held) repRef.current?.stop();
    gRef.current = null; // swipe / leave / cancel → no press
  };
  return (
    <button type="button" className="keybar-key" data-key={id} aria-label={KEY_ARIA[id] || label}
      onPointerDown={down} onPointerMove={move} onPointerUp={up}
      onPointerCancel={cancel} onPointerLeave={cancel}>{label}</button>
  );
}
