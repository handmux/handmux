import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { sendText, uploadFile, UnauthorizedError, UploadAbort } from '../api.js';
import { startUpload, updateUpload, finishUpload } from '../uploadJob.js';
import KeyBar from './KeyBar.jsx';
import FavDrawer from './FavDrawer.jsx';
import CmdFavEditor from './CmdFavEditor.jsx';
import MicButton from './MicButton.jsx';
import { loadFavs, cmdScope } from '../favStore.js';
import { UPLOAD_ACCEPT, splitUploadable } from '../uploadTypes.js';
import { ArrowUpIcon, UploadIcon, ClockIcon, KeyboardIcon, GearIcon } from './icons.jsx';
import { usePushToTalk } from '../voice/usePushToTalk.js';
import { useAsrAvailable } from '../voice/useAsrAvailable.js';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock.js';
import { useBackButton } from '../hooks/useBackButton.js';
import { t } from '../i18n';
import { MODIFIERS, modActive, consumeMods, withMods } from '../keybarKeys.js';

// The bottom dock is a two-page pager (swipe the non-key chrome to switch, or TAP the page-dots above;
// two dots show which page is current):
//   • COMMAND page — a fixed 2-row keyboard (KeyBar, inverted-T arrows) plus a quick-bar above it whose
//     展开/收起键盘 text button pops / dismisses the system keyboard and whose right side is the user's own
//     saved-command strip; a hidden capture <input> receives the keystrokes and streams each one straight
//     into the pane (the terminal is the display, there is no visible box). Touches that start on a key
//     never page (so hold-repeating ▲/◀ can't get mistaken for a swipe).
//   • CHAT page — the composer (＋ upload, textarea, ▤/常用, mic, send ↑ — tap = type+Enter, long-press =
//     填入). The mode defaults from whether a coding agent is live in the pane, and sticks per-pane.
// Quick-bar labels that are terminal KEYS, not text: tapping them fires onKey (e.g. ESC → interrupt)
// instead of typing the letters + Enter. Keyed by the item's label so a user can add/remove them freely.
const KEY_FAVS = { ESC: 'Escape', Esc: 'Escape', Tab: 'Tab', '⌫': 'BSpace' };

// Command mode keeps the system keyboard open via the hidden capture. A quick-bar <button> tap would
// steal focus → the capture blurs → the keyboard collapses. preventDefault on pointer-down keeps focus
// on the capture; onClick still fires. (Same trick the KeyBar keys use.)
const keepFocus = (e) => { if (e.cancelable) e.preventDefault(); };

// One handler on the whole dock: tapping ANYWHERE inside it (keys, chips, buttons, gaps, the composer's
// padding) must NOT blur the focused field and drop the phone keyboard — only a tap on a real text field
// should take focus / move the caret. preventDefault on pointer-down keeps focus where it is; onClick
// still fires so every button works. Skipping inputs/textarea lets the composer be focused + caret-placed.
const keepDockFocus = (e) => {
  if (e.target.closest?.('input, textarea, [contenteditable]')) return;
  if (e.cancelable) e.preventDefault();
};

// How far (px) a horizontal drag must travel before releasing commits a page switch. Higher = harder to
// trigger a swap by accident (was 50).
const SWIPE_COMMIT_PX = 80;

// Chat chips are tinted by CATEGORY (three styles, not a per-label rainbow): a slash-command (/compact …)
// = blue, everything else (ok/go on/1/2/3 …) = green. Key favs (kind 'key') are tinted grey directly at
// the call site (they bypass this); the KEY_FAVS branch here only still catches a LEGACY text fav named
// ESC/Tab/⌫ from an older saved list. → .qc-esc / .qc-cmd / .qc-reply.
const chipTint = (text) => {
  if (KEY_FAVS[text]) return 'esc';
  if (text.startsWith('/')) return 'cmd';
  return 'reply';
};

// A quick-command chip that carries TWO actions on one press (pointer events only, no onClick — so it never
// clashes with the pager's tap-vs-swipe gesture): a clean tap fires onTap, holding past CHIP_HOLD_MS fires
// onHold with a haptic tick. A drag past the 8px gate (the strip scrolling under the finger) cancels both,
// so a horizontal scroll never triggers the chip. pointerdown preventDefault keeps the focused field (system
// keyboard / composer) from blurring — the same keepFocus trick the keybar uses. onHold omitted → tap only.
const CHIP_HOLD_MS = 450;
function HoldButton({ className, onTap, onHold, children, ...rest }) {
  const st = useRef({ timer: null, long: false, moved: false, x: 0, y: 0 });
  const down = (e) => {
    if (e.cancelable) e.preventDefault();
    const s = st.current; s.long = false; s.moved = false; s.x = e.clientX; s.y = e.clientY;
    if (!onHold) return;
    s.timer = setTimeout(() => { s.long = true; navigator.vibrate?.(12); onHold(); }, CHIP_HOLD_MS);
  };
  const move = (e) => {
    const s = st.current;
    if (s.moved) return;
    if (Math.abs(e.clientX - s.x) > 8 || Math.abs(e.clientY - s.y) > 8) { s.moved = true; clearTimeout(s.timer); }
  };
  const up = () => {
    const s = st.current;
    clearTimeout(s.timer); s.timer = null;
    if (s.moved) { s.moved = false; return; } // was a scroll/drag → no tap
    if (s.long) { s.long = false; return; }   // hold already fired
    onTap();
  };
  const cancel = () => { const s = st.current; clearTimeout(s.timer); s.timer = null; s.long = false; s.moved = false; };
  return (
    <button type="button" className={className} {...rest}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onPointerLeave={cancel}>
      {children}</button>
  );
}

function BottomDock({
  pane, onAuthFail, onKey, onText, cwd = null, agent = null, windowId = null,
  recent = [], onSent, onRemoveRecent, inset = 0,
}, fwdRef) {
  const [value, setValue] = useState('');
  const [multi, setMulti] = useState(false); // composer grew past one line → full-width text, mic/send overlay bottom-right
  const [crowd, setCrowd] = useState(false); // last text line would run under the overlaid buttons → reserve a bottom strip
  const [panelOpen, setPanelOpen] = useState(false);
  // The chat page's horizontal quick-command bar reads the agent 常用 list; re-load it whenever the
  // FavDrawer closes so add/delete there flow straight into the bar (single source of truth: favStore).
  const [favs, setFavs] = useState(() => loadFavs('agent'));
  // `chatEditOpen` is the chat page's ⚙ editor sheet (mirrors the command page's ⚙). Reload the agent list
  // whenever either it or the history panel closes so add/edit/delete/reorder flow straight into the bar.
  const [chatEditOpen, setChatEditOpen] = useState(false);
  useEffect(() => { if (!panelOpen && !chatEditOpen) setFavs(loadFavs('agent')); }, [panelOpen, chatEditOpen]);
  // Command mode has its OWN saved commands (separate from the agent list), split into a GLOBAL list
  // (shown first, grey) and a PER-WINDOW list (shown after, green) — both in the command page's quick-bar.
  // `cmdEditOpen` is the ⚙ editor sheet; reload BOTH lists whenever it closes (or the window changes) so
  // add/delete/reorder flow straight into the bar.
  const [cmdFavs, setCmdFavs] = useState(() => loadFavs('command'));
  const [winFavs, setWinFavs] = useState(() => (windowId ? loadFavs(cmdScope(windowId)) : []));
  const [cmdEditOpen, setCmdEditOpen] = useState(false);
  useEffect(() => {
    if (cmdEditOpen) return;
    setCmdFavs(loadFavs('command'));
    setWinFavs(windowId ? loadFavs(cmdScope(windowId)) : []);
  }, [cmdEditOpen, windowId]);
  const [modeOverride, setModeOverride] = useState({}); // pane → 'command' | 'agent'
  const mode = modeOverride[pane] || (agent ? 'agent' : 'command');
  const setMode = (next) => setModeOverride((m) => ({ ...m, [pane]: next }));
  // Live modifier state, lifted here so the KeyBar and the command-mode capture input can share it.
  const [mods, setMods] = useState({ ctrl: 'off', shift: 'off', alt: 'off' });
  // Whether the system keyboard is up (the capture input is focused) — lights the ⌨ toggle. Kept in
  // sync by the capture's onFocus/onBlur, so tapping the terminal (which blurs it) also drops the flag.
  const [keyboardUp, setKeyboardUp] = useState(false);

  // ── Swipe carousel ──────────────────────────────────────────────────────────────────────────
  // The dock is a two-page track (command | chat) that follows the finger and snaps with an ease
  // animation on release — both pages stay mounted so you see them slide. pageIndex 0 = command, 1 = chat.
  const pagerRef = useRef(null);
  const trackRef = useRef(null);
  const pageIndex = mode === 'command' ? 0 : 1;
  const pageIndexRef = useRef(pageIndex);
  pageIndexRef.current = pageIndex;
  const setModeRef = useRef(setMode); // latest setMode (closes over the current pane)
  setModeRef.current = setMode;
  const draggingRef = useRef(false); // a finger drag owns the transform right now
  // True while a repeat key (arrow / ⌫) is being pressed or auto-repeating — the pager reads it to refuse
  // starting a page swipe out from under a held key. Set/cleared by the KeyBar (see Key in KeyBar.jsx).
  const keyHeldRef = useRef(false);
  const trackW = () => pagerRef.current?.clientWidth || 0;
  // The track's RESTING position is owned by React/CSS: the `.dock-track` gets an `at-chat` class for
  // page 1, which a CSS rule maps to translateX(-50%) with a transition (page 0 = no class = 0). Because
  // rest is class-driven it is ALWAYS exactly page-aligned — the track can NEVER get stuck between pages.
  // A 60fps finger drag can't go through React, so during a drag we override with an imperative inline
  // transform (transition off); on release we CLEAR the inline transform so the class owns rest again and
  // animates the snap. This is the root fix for the old "stuck at half" state, which happened because the
  // rest position used to be imperative too and only re-asserted on a React render (rare in command mode).
  const setDragX = (px) => {
    const t = trackRef.current;
    if (!t) return;
    t.style.transition = 'none';
    t.style.transform = `translate3d(${px}px, 0, 0)`;
  };
  const releaseTrack = () => {
    const t = trackRef.current;
    if (!t || !t.style.transform) return;
    t.style.transition = ''; // fall back to the CSS transition
    t.style.transform = '';  // fall back to the CSS class → page-aligned rest (animated)
  };
  // Safety net: on any AT-REST render, drop a lingering inline transform so the class snaps the track to
  // its page. Covers a gesture interrupted so badly that onEnd never fired (browser-hijacked touch,
  // missed touchend) — plus onStart clears it on the next touch, so a stuck track always self-corrects.
  useLayoutEffect(() => { if (!draggingRef.current) releaseTrack(); });
  // Size the pager to the ACTIVE page's natural height. This is genuinely variable: the chat composer
  // grows with its text and can be taller OR shorter than the keyboard. Set it INSTANTLY — the CSS height
  // transition is gone (styles.css): the terminal above is a poll-and-repaint surface, so animating the
  // dock height would resize+repaint it every frame for 280ms → the flicker and the transient blank gap.
  // One instant resize per change = one clean repaint. No React renders fire during a finger drag, so the
  // height holds steady through the whole swipe — the terminal doesn't move until the page actually commits.
  const syncPagerHeight = () => {
    const pager = pagerRef.current;
    if (!pager) return;
    const active = pager.querySelector(mode === 'command' ? '.dock-page.command' : '.dock-page.chat');
    if (active) pager.style.height = `${active.offsetHeight}px`;
  };
  useLayoutEffect(() => {
    if (mode === 'agent') autoGrow(ref.current); // measure multi-line text before sizing (never clipped)
    syncPagerHeight();
  });
  // Keep the LATEST syncPagerHeight reachable from the long-lived ResizeObserver below (it closes over the
  // current `mode`, so the observer must call through a ref, never a stale capture).
  const syncRef = useRef(syncPagerHeight);
  syncRef.current = syncPagerHeight;
  // The invariant the pager height must hold: it always equals the ACTIVE page's real content height. The
  // React-render + single-rAF syncs above can miss an async settle (the composer restoring multi-line text,
  // a web-font/quick-bar reflow, the upload row appearing) — and a dock left too tall strands hidden terminal
  // rows, because the terminal only re-fits when its area GREW (Terminal.jsx). So observe both pages directly
  // and re-sync on ANY content-height change: the dock can never go stale, so the terminal area shrinks/grows
  // to the truth and re-fits. Skipped while a finger drag owns the height (it must hold steady through a swipe).
  useEffect(() => {
    const pager = pagerRef.current;
    if (!pager || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { if (!draggingRef.current) syncRef.current(); });
    pager.querySelectorAll('.dock-page').forEach((p) => ro.observe(p));
    return () => ro.disconnect();
  }, []);
  // Entering CHAT restores the composer's grown height for preserved multi-line text — then RE-syncs the
  // pager. The sync above runs BEFORE that async grow settles, so without this the dock (and the terminal
  // sized to fit above it) can be left at a stale height until the next render: the "swiped to chat and the
  // terminal lost its bottom rows, fixed by nudging the composer" bug. The terminal only re-fits when its
  // container GREW (Terminal.jsx), so a too-tall stale dock never self-corrected.
  useEffect(() => {
    if (mode !== 'agent') return undefined;
    const raf = requestAnimationFrame(() => { autoGrow(ref.current); syncPagerHeight(); });
    return () => cancelAnimationFrame(raf);
  }, [mode]);
  // Leaving CHAT for command: the composer's textarea may still hold DOM focus (you were just typing in it).
  // Once the track slides it off-screen (the right half), the browser will scroll-reveal that still-focused
  // field by setting pager.scrollLeft — which drags the chat page back into view and parks the dock "half
  // way" the instant you press ANY command key. Blur it so nothing off-screen keeps focus, and reset any
  // scroll the browser already applied. (The pager is a transform carousel — see the scroll-pin below.)
  useEffect(() => {
    if (mode === 'agent') return;
    if (document.activeElement === ref.current) ref.current?.blur();
    const pager = pagerRef.current;
    if (pager) { pager.scrollLeft = 0; pager.scrollTop = 0; }
  }, [mode]);
  // Native (non-passive) touch handlers so a horizontal drag can preventDefault the page's own scroll.
  useEffect(() => {
    const pager = pagerRef.current;
    if (!pager) return;
    let d = null;
    const onStart = (e) => {
      releaseTrack(); // drop any inline transform a previous (interrupted) gesture may have left behind
      // Remember if the drag began on the horizontally-scrolling quick-command strip: that gesture is
      // normally the strip's own native scroll, but at an EDGE a further drag in the same direction should
      // carry over into a page swipe (decided in onMove once we know the direction). Both pages have a
      // strip: chat's carries LEFT-edge→right-drag to command; command's carries RIGHT-edge→left-drag to chat.
      const strip = e.target?.closest?.('.quick-scroll') || null;
      d = e.touches.length === 1
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, decided: false, horiz: false, strip }
        : null;
    };
    const onMove = (e) => {
      if (!d || e.touches.length !== 1) return;
      // A held / auto-repeating keybar key (▲◀▼▶ ⌫) OWNS the touch — never let its finger-drift, esp. with
      // the system keyboard up, get mistaken for a page swipe (which used to park the track between pages).
      // The key releases this the instant IT decides the gesture is a swipe (moved past its own 8px gate),
      // so a deliberate swipe that happens to start on a key still pages. Only blocks BEFORE we commit.
      if (keyHeldRef.current && !d.horiz) return;
      const dx = e.touches[0].clientX - d.x, dy = e.touches[0].clientY - d.y;
      if (!d.decided) {
        // Need real travel before deciding, and only lock to a swipe when the drag is CLEARLY horizontal
        // (dominates the vertical by 1.4×). This keeps a press-and-hold on a key — e.g. auto-repeating the
        // ◀ arrow, whose finger jitters a few px — from being mistaken for a page swipe and dragging the
        // track. (A key press stays under the 16px gate; a deliberate swipe blows past it.)
        if (Math.abs(dx) < 16 && Math.abs(dy) < 16) return;
        d.decided = true;
        d.horiz = Math.abs(dx) > Math.abs(dy) * 1.4;
        // Drag started on the strip: only steal it as a page swipe when the strip can't scroll further
        // in that direction, so a further drag "falls off" toward the neighbouring page. Two symmetric cases:
        //   • chat page (1), strip at LEFT edge, dragging RIGHT → reveal the command page (dx > 0)
        //   • command page (0), strip at RIGHT edge, dragging LEFT → reveal the chat page (dx < 0)
        // Otherwise hand the whole gesture to the strip's native scroll.
        if (d.horiz && d.strip) {
          const s = d.strip, pg = pageIndexRef.current;
          const atLeft = s.scrollLeft <= 0;
          const atRight = s.scrollLeft >= s.scrollWidth - s.clientWidth - 1;
          const toCommand = dx > 0 && atLeft && pg === 1;
          const toChat = dx < 0 && atRight && pg === 0;
          if (!(toCommand || toChat)) d.horiz = false;
        }
      }
      if (!d.horiz) return; // a vertical drag (or a strip-scroll we handed off) → leave it to native
      e.preventDefault();
      draggingRef.current = true; // the finger owns the transform now
      d.dx = dx;
      const w = trackW() || 1;
      let vx = dx; // follow the finger, but resist dragging past the ends (only two pages)
      if (pageIndexRef.current === 0) vx = Math.min(0, Math.max(-w, vx));
      else vx = Math.max(0, Math.min(w, vx));
      setDragX(-pageIndexRef.current * w + vx);
    };
    const onEnd = () => {
      draggingRef.current = false; // finger's gone
      if (!d || !d.horiz) { d = null; releaseTrack(); return; }
      const cur = pageIndexRef.current, dx = d.dx;
      d = null;
      let target = cur;
      if (cur === 0 && dx < -SWIPE_COMMIT_PX) target = 1;      // dragged far left off command → chat
      else if (cur === 1 && dx > SWIPE_COMMIT_PX) target = 0;  // dragged far right off chat → command
      // Hand the rest position back to the CSS class: clearing the inline transform lets the class snap
      // the track to a page (animated). If the page changed, flip React state — the class follows it. The
      // track is now ALWAYS class-aligned at rest, so it can't stay stuck between pages.
      releaseTrack();
      if (target !== cur) setModeRef.current(target === 1 ? 'agent' : 'command');
    };
    // The pager is a transform carousel: it must NEVER scroll. But an overflow:hidden box will still be
    // scrolled by the browser to reveal a focused off-screen child (the chat composer, once command mode
    // slides it into the right half). Snap any such scroll straight back to 0 — the hard guarantee that a
    // keypress can't drag the other page into view / park the dock half-way.
    const onScroll = () => { if (pager.scrollLeft || pager.scrollTop) { pager.scrollLeft = 0; pager.scrollTop = 0; } };
    pager.addEventListener('scroll', onScroll, { passive: true });
    pager.addEventListener('touchstart', onStart, { passive: true });
    pager.addEventListener('touchmove', onMove, { passive: false });
    pager.addEventListener('touchend', onEnd, { passive: true });
    pager.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      pager.removeEventListener('scroll', onScroll);
      pager.removeEventListener('touchstart', onStart);
      pager.removeEventListener('touchmove', onMove);
      pager.removeEventListener('touchend', onEnd);
      pager.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  // Hardware Back closes the command panel instead of exiting the app.
  useBackButton(panelOpen, () => setPanelOpen(false));
  const [upload, setUpload] = useState(null); // { label, pct, error } during/after an upload, else null
  const ref = useRef(null);      // agent-mode composer textarea
  const cmdRef = useRef(null);   // command-mode single-line capture (streams to the pane)
  const uploadRef = useRef(null);
  const upTimerRef = useRef(null);

  const anchorRef = useRef({ head: '', tail: '' }); // 起录时的光标两侧文本
  const caretRef = useRef(null);                    // 程序化改 value 后要落的光标位置
  const suppressVoiceRef = useRef(false);           // 录音中点了发送/填入 → 抑制后续 partial/定稿回写

  // 定稿:把整段识别文字插在起录锚点处。录音中已发送过(suppress)则丢弃这次定稿,不再回写。
  const commitVoice = (text) => {
    if (suppressVoiceRef.current) { suppressVoiceRef.current = false; return; }
    const { head, tail } = anchorRef.current;
    setValue(head + text + tail);
    caretRef.current = head.length + text.length;
  };
  const voice = usePushToTalk({ onText: commitVoice });
  const micAvailable = useAsrAvailable(); // hide the mic when no ASR engine is configured (keyless install)
  const recording = voice.state === 'recording' || voice.state === 'finalizing';
  useScreenWakeLock(recording); // 语音激活时屏幕常亮,别中途变暗/锁屏
  useEffect(() => () => clearTimeout(upTimerRef.current), []); // 卸载时清掉上传提示自动消失的定时器

  // 录音中:partial 实时写进框、插在锚点处,光标跟到插入末尾。已 suppress(发送过)则不再回写。
  useEffect(() => {
    if (voice.state !== 'recording' && voice.state !== 'finalizing') return;
    if (suppressVoiceRef.current) return;
    const { head, tail } = anchorRef.current;
    setValue(head + voice.partial + tail);
    caretRef.current = head.length + voice.partial.length;
  }, [voice.partial, voice.state]);

  // 程序化更新 value 后,把光标落到 caretRef、并把高度撑开。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let caretAtEnd = false;
    if (caretRef.current != null) {
      const pos = caretRef.current; caretRef.current = null;
      // iOS 陷阱:对「未聚焦」的 textarea 调 setSelectionRange,会让它变成 document.activeElement 却不弹
      // 键盘 → 之后点它都被当成「已聚焦」无反应,必须点别处失焦再点回来才弹。语音回写时框是未聚焦的
      // (录音中 readOnly、且用户没点过),所以只在框真的聚焦(用户在编辑)时才恢复光标,绝不主动夺焦。
      if (document.activeElement === el) {
        try { el.setSelectionRange(pos, pos); } catch {}
      }
      caretAtEnd = pos >= value.length; // 程序化插入(语音)且光标在末尾
    }
    autoGrow(el);
    // 内容超过最大高度时,程序化插入(语音)不会触发原生滚动 → 光标在末尾就滚到最新行。
    if (caretAtEnd) el.scrollTop = el.scrollHeight;
  }, [value]);

  // 点按切换:起录(锚定当前光标)或停止。
  const toggleMic = () => {
    if (recording) { voice.stop(); return; }
    const el = ref.current;
    const sel = el ? el.selectionStart : value.length;
    anchorRef.current = { head: value.slice(0, sel), tail: value.slice(sel) };
    voice.start();
  };

  // Grow to fit content; CSS max-height caps it at 3 lines, after which it scrolls. +2 accounts
  // for the border under box-sizing: border-box.
  // Also drives the `multi` layout: past one line the textarea takes the full width and the mic/send
  // become an overlay in the box's bottom-right corner (styles.css .input-wrap.multi).
  //
  // A textarea can't report its own soft-wrap points, so both decisions are measured on a hidden
  // mirror <div> that replicates the textarea's font/padding/wrapping at any width we ask (the
  // standard caret-position technique; verified pixel-identical against a real textarea in Chrome):
  //   • `multi`  — would the text fit ONE line at the SINGLE-LINE width (pill minus the inline
  //     buttons)? Enter and exit are the same predicate measured at the same fixed width — the pill's,
  //     which no layout choice feeds back into — so the buttons return inline the moment the text fits
  //     beside them again, and the two layouts can never disagree into a render loop (measuring at the
  //     textarea's CURRENT width is what caused the black-screen crash).
  //   • `crowd` — does the LAST line (marker <span>'s offsetLeft at full width) run into the button
  //     corner? Then the textarea reserves a bottom strip via padding. The strip is EXACTLY one line:
  //     29px = line 22 + normal bottom padding 7, so "n lines + strip" ≡ "n+1 lines" in height —
  //     reaching the buttons jumps straight to the post-wrap height, the wrap itself doesn't move the
  //     box, and the strip releases blip-free once the short new line clears the zone. The buttons keep
  //     their 34px size — their top edge may graze the previous line's descenders (user-approved).
  // The zone slack is deliberately TIGHT (8px ≈ caret + breathing room): the mirror is pixel-exact
  // (verified against a real textarea at multiple widths, CJK + fullwidth punctuation), and a fat
  // slack made the text yield to the buttons a full character early — visibly "wrapping when it
  // clearly still fits".
  const ONE_LINE = 40; // px: 22px line + 14px padding, with slack
  const mirrorRef = useRef(null);
  // Text metrics at an arbitrary rendered width (the mirror's padding matches the textarea's, so
  // `width` means "textarea offsetWidth"): total height + where the last line ends.
  const measureAt = (text, width) => {
    const m = mirrorRef.current;
    if (!m) return null;
    m.style.width = `${width}px`;
    m.textContent = text;
    const marker = document.createElement('span');
    m.appendChild(marker);
    return { h: m.offsetHeight, endX: marker.offsetLeft };
  };
  const autoGrow = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    // Inline the zone/button widths that are ACTUALLY rendered: a keyless install has no mic, so its
    // text runs up to the send button, not a phantom mic earlier.
    const inline = micAvailable ? 76 : 38; // single-line row: gap 4 + mic 34 (+ gap 4 + send 34)
    const zone = micAvailable ? 86 : 48;   // overlay corner: mic 34 + gap 4 + send 34 + inset 6 + 8 slack
    const inner = el.parentElement.clientWidth - 11; // pill content width (clientWidth minus 5+6 padding)
    const narrow = el.value ? measureAt(el.value, inner - inline) : null;
    const isMulti = narrow ? narrow.h > ONE_LINE : false; // no mirror/empty → single-line layout
    setMulti(isMulti);
    const full = isMulti ? measureAt(el.value, inner) : null;
    setCrowd(!!full && inner - full.endX < zone);
    el.style.height = `${el.scrollHeight + 2}px`;
  };

  // 录音中点发送/填入:先停掉语音并抑制后续回写——不再接着录,定稿也不往框里补字。
  const stopVoiceIfRecording = () => {
    if (recording) { suppressVoiceRef.current = true; voice.stop(); }
  };

  // Type the text then Enter (the server pauses between them so a TUI registers Enter as "send"
  // rather than a newline).
  const send = async () => {
    if (!pane) return;
    stopVoiceIfRecording();
    try {
      await sendText(pane, value, true);
      onSent?.(value); // record the sent command (App pushes it into the session's recent list)
      setValue('');
      requestAnimationFrame(() => autoGrow(ref.current)); // shrink back to one line once cleared
    } catch (err) {
      if (err instanceof UnauthorizedError) onAuthFail?.();
    }
  };

  // Command mode types STRAIGHT into the terminal: every keystroke is streamed to tmux as it's typed
  // (onText → send-keys + wake), and the field is wiped back to empty — so your text appears in the
  // pane like a real shell, not staged in the box the way agent (compose) mode does. The system
  // keyboard still drives it (so IMEs work): while an IME composes we hold, then flush the committed
  // word on compositionend. Agent mode keeps the box as a normal composer.
  const composingRef = useRef(false);
  const streamInput = (el) => {
    const text = el.value;
    el.value = ''; // keep the capture field empty — the terminal is the display
    if (!text) return;
    // An armed Ctrl/Alt (from the keybar) composes the system keyboard's next single letter/digit into
    // the tmux combo (C-<x> / M-<x>) instead of streaming the raw char; then the one-shot modifier resets.
    const active = MODIFIERS.some((m) => modActive(mods[m]));
    if (active && text.length === 1) {
      const composed = withMods({ kind: 'text', ch: text }, mods);
      if (composed.kind === 'key') { onKey(composed.name); setMods(consumeMods); return; }
    }
    onText(text); // straight to the pane
    if (active) setMods(consumeMods);
  };
  const onCommandInput = (e) => {
    if (e.nativeEvent?.isComposing || composingRef.current) return; // mid-IME — wait for the commit
    streamInput(e.target);
  };
  const onCompositionStart = () => { if (mode === 'command') composingRef.current = true; };
  const onCompositionEnd = (e) => {
    if (mode !== 'command') return;
    composingRef.current = false;
    streamInput(e.target); // the committed IME word (e.g. a Chinese character) goes to the pane now
  };
  // Command-mode Enter/Backspace are terminal keys (the text already streamed): Return runs the line,
  // Backspace deletes in the shell (the capture field is empty, so there's nothing local to erase).
  const onInputKeyDown = (e) => {
    if (mode !== 'command' || e.nativeEvent?.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onKey('Enter'); return; }
    if (e.key === 'Backspace') { e.preventDefault(); onKey('BSpace'); }
  };

  // ⌨ toggle: focus the hidden capture (pops the system keyboard) or blur it (dismisses it). onFocus/
  // onBlur keep `keyboardUp` in sync, so tapping the terminal — which blurs the capture — also hides it.
  const toggleKeyboard = () => {
    const el = cmdRef.current;
    if (!el) return;
    if (document.activeElement === el) el.blur(); else el.focus();
  };

  // Pick a command from the panel: fill the box (never send), close the panel, refocus so the user
  // can edit before submitting.
  const pick = (cmd) => {
    setValue(cmd);
    setPanelOpen(false);
    requestAnimationFrame(() => { ref.current?.focus(); autoGrow(ref.current); });
  };

  // Tap a fav → send it (type + Enter, reusing the send path). Long-press (double-tap for now) → fill.
  const sendFav = async (text) => {
    if (!pane) return;
    try { await sendText(pane, text, true); onSent?.(text); }
    catch (err) { if (err instanceof UnauthorizedError) onAuthFail?.(); }
  };
  const fillFav = (text) => pick(text);

  // Chat quick-bar / drawer tap = send immediately. A KEY_FAVS label fires the terminal key (ESC →
  // interrupt); everything else is typed + Enter via sendFav.
  const runFav = (text) => {
    if (KEY_FAVS[text]) { onKey(KEY_FAVS[text]); return; }
    sendFav(text);
  };
  // Chat chip tap by FAV OBJECT — a key fav (kind 'key', e.g. Escape/BSpace/C-c) fires the terminal key;
  // a legacy KEY_FAVS label (ESC/Tab/⌫ stored as text) still fires its key; anything else is sent as text.
  const runChatFav = (f) => {
    if (f.kind === 'key') { onKey(f.text); return; }
    runFav(f.text);
  };
  // COMMAND quick-bar tap. A key fav (kind 'key', e.g. C-c) or a legacy KEY_FAVS label (ESC/Tab) fires
  // the terminal key. Otherwise: a with-Enter fav TYPES + runs it (sendFav = type + Enter, server-paced);
  // a plain fav just types into the shell (the shell is the display — you press Enter yourself).
  const runCmdFav = (f) => {
    if (f.kind === 'key') { onKey(f.text); return; }
    if (KEY_FAVS[f.text]) { onKey(KEY_FAVS[f.text]); return; }
    if (f.enter) { sendFav(f.text); return; }
    onText(f.text);
  };
  // A command chip's label: a key fav shows its pretty ⌃C label, a command shows its text.
  const favLabel = (f) => (f.kind === 'key' ? (f.label || f.text) : f.text);
  // Long-press action for a command chip: only a ⏎ (with-Enter) command gets one — HOLD types it WITHOUT
  // the Enter, so you can edit/append in the shell before running it yourself. Keys and plain (type-only)
  // commands already do exactly that on a tap, so they have no distinct hold (returns undefined = tap only).
  const holdTypeOnly = (f) =>
    (f.kind === 'key' || KEY_FAVS[f.text] || !f.enter ? undefined : () => onText(f.text));

  // Let the topbar idea panel drop a picked idea into the box (fill, never send) — same path as pick.
  useImperativeHandle(fwdRef, () => ({ fill: pick }), []);

  // After an upload, append the uploaded files' absolute paths to the box (then focus to keep typing).
  // One file → the full path. Multiple → write the shared dir prefix ONCE and brace-expand the names
  // (`/…/.upload/{a.png,b.png}`); if they somehow don't share a dir, fall back to space-joined paths.
  const insertPaths = (paths) => {
    if (!paths.length) return;
    let text;
    if (paths.length === 1) {
      text = paths[0];
    } else {
      const dir = paths[0].slice(0, paths[0].lastIndexOf('/') + 1);
      text = paths.every((p) => p.startsWith(dir))
        ? `${dir}{${paths.map((p) => p.slice(dir.length)).join(',')}}`
        : paths.join(' ');
    }
    setValue((v) => (v && !/\s$/.test(v) ? `${v} ${text}` : v + text));
    requestAnimationFrame(() => { ref.current?.focus(); autoGrow(ref.current); });
  };

  // ＋ upload: native multi-select → upload each file sequentially into this cwd's space under
  // ~/.handmux/uploads (server creates it; kept out of the project tree so nothing gets committed).
  // Progress shows per-file with an (n/total) counter; a partial failure leaves a red note that
  // self-clears. Succeeded paths (absolute) get pasted into the box.
  const uploadFiles = async (files) => {
    const { allowed: list, rejected } = splitUploadable(files);
    if (!list.length) {
      if (rejected.length) {
        clearTimeout(upTimerRef.current);
        setUpload({ label: t('dock.upload.rejected', { names: rejected.join('、') }), error: true });
        upTimerRef.current = setTimeout(() => setUpload(null), 3500);
      }
      return;
    }
    clearTimeout(upTimerRef.current);
    setUpload(null);                                  // the inline note is only for post-run errors now
    const total = list.length;
    const paths = [];
    const failed = [];
    // One AbortController for the whole batch → the overlay's Cancel aborts the in-flight file and we
    // break out of the loop. Active-transfer feedback lives in the app-wide overlay (uploadJob store).
    const ac = new AbortController();
    startUpload(ac, t('dock.upload.progress', { name: list[0].name, tag: total > 1 ? `（1/${total}）` : '' }));
    try {
      for (let i = 0; i < total; i++) {
        if (ac.signal.aborted) break;
        const f = list[i];
        const tag = total > 1 ? `（${i + 1}/${total}）` : '';
        updateUpload({ label: t('dock.upload.progress', { name: f.name, tag }), phase: 'sending', pct: 0 });
        try {
          const res = await uploadFile(cwd || '', f, (pct, phase) => updateUpload({ pct, phase }), true, { signal: ac.signal });
          if (res?.path) paths.push(res.path);
        } catch (err) {
          if (err instanceof UploadAbort) break;      // user canceled → stop the batch, keep done files
          if (err instanceof UnauthorizedError) { onAuthFail?.(); finishUpload(); setUpload(null); return; }
          // Keep the SPECIFIC reason (uploadFile maps it: too large / bad type / …) so the note explains why.
          failed.push({ name: f.name, reason: err?.message || t('api.uploadFailed') });
        }
      }
    } finally {
      finishUpload();
    }
    if (paths.length) insertPaths(paths);
    if (failed.length || rejected.length) {
      // Each failure carries its own reason (name：why); rejected types keep their one-line note.
      const parts = failed.map((x) => `${x.name}：${x.reason}`);
      if (rejected.length) parts.push(t('dock.upload.rejected', { names: rejected.join('、') }));
      setUpload({ label: parts.join('；'), error: true });
      upTimerRef.current = setTimeout(() => setUpload(null), 5000);
    } else {
      setUpload(null);
    }
  };

  // 填入: type the box text into the pane WITHOUT Enter (no submit), then clear — the secondary to
  // 发送 (which types + Enter). Mirrors send() with enter=false; a filled command is still recorded.
  const fill = async () => {
    if (!pane || !value) return;
    stopVoiceIfRecording();
    try {
      await sendText(pane, value, false);
      onSent?.(value);
      setValue('');
      requestAnimationFrame(() => autoGrow(ref.current));
    } catch (err) {
      if (err instanceof UnauthorizedError) onAuthFail?.();
    }
  };

  // 发送 carries both submit actions on one button via pointer (tap vs hold), so they never collide:
  //   tap        → send() (type + Enter)
  //   long-press → fill() (type WITHOUT Enter) — armed only when there's text to fill
  // Pointer events only (no onClick), matching the keybar/⌫ pattern.
  // Movement gate (10px, same as HoldButton/MicButton): in multi the button hovers OVER the text, so a
  // caret-handle drag can start on it — pointer capture routes the eventual up back here even after the
  // finger left, and firing send() on that up meant "drag the caret near the corner" = message sent +
  // keyboard gone. A moved pointer is a drag, not a tap: cancel both tap and long-press.
  const sendTimer = useRef(null);
  const sendLongRef = useRef(false);
  const sendPtRef = useRef({ x: 0, y: 0, moved: false });
  const sendDown = (e) => {
    if (e.cancelable) e.preventDefault();
    sendLongRef.current = false;
    sendPtRef.current = { x: e.clientX, y: e.clientY, moved: false };
    if (!value) return; // empty box → no long-press; releasing just sends a bare Enter
    sendTimer.current = setTimeout(() => {
      sendLongRef.current = true;
      navigator.vibrate?.(12);
      fill();
    }, 450);
  };
  const sendMove = (e) => {
    const p = sendPtRef.current;
    if (p.moved || Math.hypot(e.clientX - p.x, e.clientY - p.y) <= 10) return;
    p.moved = true;
    clearTimeout(sendTimer.current); // a drag disarms the long-press too
    sendTimer.current = null;
  };
  const sendUp = () => {
    clearTimeout(sendTimer.current);
    sendTimer.current = null;
    if (sendLongRef.current) { sendLongRef.current = false; return; } // long-press already filled
    if (sendPtRef.current.moved) return; // drag, not a tap
    send();
  };
  const sendCancel = () => {
    clearTimeout(sendTimer.current);
    sendTimer.current = null;
    sendLongRef.current = false;
  };

  // —— multi 态按钮的「幽灵命中」(pointer-events:none + 容器手动命中) ——
  // 真机 #hud 实测:多行拖光标收键盘时,页面从头到尾收不到任何 pointer 事件、也没有 focusout——
  // 那是 Chrome 原生选择手柄拖拽(浏览器内部),结束时 Chrome 对落点做【原生命中测试】,命中
  // 非可编辑元素(悬浮的麦克风/发送)就直接藏输入法(vv 429→810,textarea 仍聚焦)。事件层
  // (preventDefault/位移门槛/keepDockFocus)对一个不产生页面事件的手势无从拦截。
  // 唯一能改变原生命中测试结果的开关是 pointer-events:none:多行态按钮退出命中测试
  // (styles.css .multi),任何落点都穿透到 textarea(可编辑)→ 键盘不藏。按钮点按改由药丸容
  // 器在 capture 阶段手动命中按钮矩形,复用原手势逻辑(发送 tap/长按、位移门槛全保留)。
  const ghostRef = useRef(null);                 // 'send' | 'mic' —— 当前被幽灵按下的按钮
  const micPtRef = useRef({ x: 0, y: 0, moved: false });
  const ghostHit = (e) => {
    if (!multi) return null;
    for (const [name, sel] of [['send', '.input-send'], ['mic', '.input-mic']]) {
      const b = e.currentTarget.querySelector(sel);
      if (!b) continue;
      const r = b.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return name;
    }
    return null;
  };
  const ghostDown = (e) => {
    const hit = ghostHit(e);
    if (!hit) return;
    e.stopPropagation();                  // 这一下属于按钮:别让 textarea 的录音接管/聚焦逻辑吃到
    if (e.cancelable) e.preventDefault(); // 也不移光标、不改焦点(textarea 聚焦态原样保留)
    ghostRef.current = hit;
    if (hit === 'send') sendDown(e);
    else micPtRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const ghostMove = (e) => {
    const g = ghostRef.current;
    if (!g) return;
    if (g === 'send') { sendMove(e); return; }
    const p = micPtRef.current;
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) p.moved = true;
  };
  const ghostUp = () => {
    const g = ghostRef.current;
    ghostRef.current = null;
    if (!g) return;
    if (g === 'send') { if (value) sendUp(); else sendCancel(); return; } // 原按钮空框时 disabled,对齐
    if (!micPtRef.current.moved && voice.state !== 'requesting') toggleMic();
  };
  const ghostCancel = () => {
    const g = ghostRef.current;
    ghostRef.current = null;
    if (g === 'send') sendCancel();
  };

  return (
    <div className="bottom-dock">
      <div className="dock-left" onPointerDown={keepDockFocus}>
        {/* Two-dot page indicator (command · chat); the filled dot marks the current page. A tiny label
            sits at the top-left, absolutely positioned so it adds no height (stays in the dots' row).
            It's also the reliable mode switch: TAP it to flip command ⇄ chat (swiping still works, but the
            key-dense command page has little room to start one — a tap always does it). It sits OUTSIDE
            the pager, so this tap never collides with the swipe handlers. */}
        <button type="button" className="dock-dots" aria-label={t('dock.mode.toggle')}
          onClick={() => setMode(mode === 'command' ? 'agent' : 'command')}>
          <span className="dock-mode-label">{mode === 'command' ? t('dock.mode.command') : t('dock.mode.chat')}</span>
          <i className={`dock-dot${mode === 'command' ? ' on' : ''}`} data-page="command" aria-hidden="true" />
          <i className={`dock-dot${mode === 'agent' ? ' on' : ''}`} data-page="agent" aria-hidden="true" />
        </button>
        <div className="dock-pager" ref={pagerRef}>
          <div className={`dock-track${pageIndex === 1 ? ' at-chat' : ''}`} ref={trackRef}>
            <div className={`dock-page command${mode === 'command' ? ' on' : ''}`}>
              {/* Hidden capture: the ⌨ key focuses it to pop the system keyboard; each keystroke then
                  streams straight into the pane and the field wipes to empty (the terminal is the
                  display). onFocus/onBlur track whether the keyboard is up. */}
              <input
                ref={cmdRef}
                className="cmd-capture"
                type="text"
                onInput={onCommandInput}
                onKeyDown={onInputKeyDown}
                onCompositionStart={onCompositionStart}
                onCompositionEnd={onCompositionEnd}
                onFocus={() => setKeyboardUp(true)}
                onBlur={() => setKeyboardUp(false)}
                enterKeyHint="send"
                aria-label={t('dock.command.placeholder')}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
              {/* 命令模式快捷栏(键盘上方,和聊天模式那条同构):左=固定的「展开/收起键盘」文字按钮(切系统键盘,
                  文字随状态变);右=一排可横滑的、你自己的命令(命令模式独立一份),点=输入终端+回车,末尾 ＋ 增删。 */}
              <div className="quick-bar">
                <div className="quick-fixed">
                  <button type="button" className="quick-fix"
                    aria-pressed={keyboardUp} aria-label={keyboardUp ? t('dock.kbdHide') : t('dock.kbdShow')}
                    onPointerDown={keepFocus} onClick={toggleKeyboard}>
                    <KeyboardIcon down={keyboardUp} /><span>{keyboardUp ? t('dock.kbdHide') : t('dock.kbdShow')}</span></button>
                </div>
                <div className="quick-scroll">
                  {/* Global commands first (grey), then this window's (green). A with-Enter fav shows a
                      trailing ⏎ so you know a tap will RUN it; HOLD a ⏎ command to type it WITHOUT Enter
                      (drop it in the shell and edit/append before you run it yourself). */}
                  {cmdFavs.map((f) => (
                    <HoldButton key={`g:${f.text}`} className="quick-cmd quick-cmd-plain"
                      onTap={() => runCmdFav(f)} onHold={holdTypeOnly(f)}>
                      {favLabel(f)}{f.kind !== 'key' && f.enter && <span className="qc-enter" aria-hidden="true">⏎</span>}</HoldButton>
                  ))}
                  {winFavs.map((f) => (
                    <HoldButton key={`w:${f.text}`} className="quick-cmd quick-cmd-win"
                      onTap={() => runCmdFav(f)} onHold={holdTypeOnly(f)}>
                      {favLabel(f)}{f.kind !== 'key' && f.enter && <span className="qc-enter" aria-hidden="true">⏎</span>}</HoldButton>
                  ))}
                  <button type="button" className="quick-cmd quick-cmd-add" aria-label={t('cmd.editTitle')}
                    onPointerDown={keepFocus} onClick={() => setCmdEditOpen(true)}><GearIcon /></button>
                </div>
              </div>
              <KeyBar onKey={onKey} onText={onText} mods={mods} setMods={setMods} keyHeldRef={keyHeldRef} />
            </div>
            <div className={`dock-page chat${mode === 'agent' ? ' on' : ''}`}>
              {/* Inline note = post-run errors / rejected types only; active-transfer progress + cancel
                  now live in the app-wide <UploadOverlay/>. */}
              {upload && (
                <div className="dock-upload error">
                  <span className="dock-upload-label">{upload.label}</span>
                </div>
              )}
              {/* 快捷栏(药丸上方):左侧两个固定文字项(添加附件·历史记录,纯文字、样式独立)+ 右侧一排可横滑
                  的自定义 vibe 命令(点即发送;ESC 发按键、其余打字+回车)。固定项与命令 chip 样式刻意区分。 */}
              <div className="quick-bar">
                <div className="quick-fixed">
                  <button type="button" className="quick-fix" aria-label={t('dock.attach')}
                    disabled={!!upload && !upload.error} onClick={() => uploadRef.current?.click()}>
                    <UploadIcon /><span>{t('dock.attach')}</span></button>
                </div>
                <div className="quick-scroll">
                  {/* Tap a chip to send it; HOLD a message chip to FILL it into the composer to edit before
                      sending (a key fav has nothing to edit, so it has no hold). */}
                  {favs.map((f) => (
                    <HoldButton key={f.text}
                      className={`quick-cmd qc-${f.kind === 'key' ? 'esc' : chipTint(f.text)}`}
                      onTap={() => runChatFav(f)} onHold={f.kind === 'key' ? undefined : () => pick(f.text)}>
                      {favLabel(f)}</HoldButton>
                  ))}
                  <button type="button" className="quick-cmd quick-cmd-add" aria-label={t('chat.editTitle')}
                    onClick={() => setChatEditOpen(true)}><GearIcon /></button>
                </div>
              </div>
              {/* 离屏(非 display:none)以便程序化 .click() 在 iOS Safari 可靠唤起原生选择器,见 .browse-file-input。 */}
              <input ref={uploadRef} className="browse-file-input" type="file" multiple
                accept={UPLOAD_ACCEPT}
                onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
              {/* flex 行:textarea(占满)· 麦克风 · 发送,全是 flex 兄弟、不重叠文字框,所以选词/移光标碰不到
                  按键。录音时整条变绿 + 呼吸。＋上传与▤常用已上移到快捷栏。 */}
              <div className={`input-wrap${recording ? ' recording' : ''}${multi ? ' multi' : ''}${crowd ? ' crowd' : ''}`}
                onPointerDownCapture={ghostDown} onPointerMoveCapture={ghostMove}
                onPointerUpCapture={ghostUp} onPointerCancelCapture={ghostCancel}>
                <textarea
                  ref={ref}
                  className="input-text"
                  rows={1}
                  value={value}
                  // 录音中点输入框 = 立刻接管编辑:停语音 + 抑制回写(保留已识别文字,不让定稿覆盖你接着打
                  // 的字),并在手势内同步 focus —— 你点这块就是要改字,这一下必须直接弹键盘、不用再点第二次。
                  // iOS 只认「用户手势里同步调用的 focus」才立刻弹键盘;且 stop() 的重渲染可能打断原生那次聚
                  // 焦,所以这里显式夺焦兜底。也绝不能用 readOnly:iOS 点 readOnly 的 textarea 根本不给焦点。
                  onPointerDown={(e) => {
                    if (!recording) return; // 未录音:交给原生点击聚焦即可
                    stopVoiceIfRecording();
                    e.currentTarget.focus(); // 同步夺焦,确保这一下就弹出键盘
                  }}
                  onChange={(e) => { setValue(e.target.value); autoGrow(e.target); }}
                  placeholder={t('dock.input.placeholder')}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {/* 末行位置测量镜像(隐藏):同宽同字体同换行,marker 的 offsetLeft = 文字末端 x,见 lastLineEndX。 */}
                <div ref={mirrorRef} className="input-mirror" aria-hidden="true" />
                {/* 历史:麦克风左侧,只在空框时出现(仅一个图标);一打字就整个隐藏,给文字腾地方。 */}
                {!value && (
                  <button type="button" className="input-history" aria-label={t('dock.history')} title={t('dock.history')}
                    onClick={() => setPanelOpen((o) => !o)}><ClockIcon /></button>
                )}
                {micAvailable && <MicButton active={recording} disabled={voice.state === 'requesting'} onToggle={toggleMic} />}
                {/* 发送 ↑ 常驻,空框禁用:点 = 发送组合文本,长按 = 填入。 */}
                <button type="button" className="input-send" aria-label={t('dock.send')} title={t('dock.send.hint')}
                  disabled={!value}
                  onPointerDown={sendDown} onPointerMove={sendMove} onPointerUp={sendUp} onPointerCancel={sendCancel} onPointerLeave={sendCancel}>
                  <ArrowUpIcon />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <FavDrawer open={panelOpen} mode={mode} recent={recent} historyOnly onDelete={onRemoveRecent}
        onSend={(text) => { setPanelOpen(false); runFav(text); }}
        onFill={(text) => { setPanelOpen(false); fillFav(text); }}
        onClose={() => setPanelOpen(false)} />
      {/* Command-mode saved-command editor (opened by the ⚙ in the command quick-bar): two list sections
          (global + this window) over one add row whose 命令/按键 tab picks what you add. Mounted only while
          open so it seeds fresh each time. Never touches the agent list. */}
      {cmdEditOpen && <CmdFavEditor windowId={windowId} inset={inset} onClose={() => setCmdEditOpen(false)} />}
      {/* Chat-mode saved-message editor (opened by the ⚙ in the chat quick-bar): one global list whose
          消息/按键 tab picks what you add. Same card as command mode, chat variant. */}
      {chatEditOpen && <CmdFavEditor variant="chat" inset={inset} onClose={() => setChatEditOpen(false)} />}
    </div>
  );
}

export default forwardRef(BottomDock);
