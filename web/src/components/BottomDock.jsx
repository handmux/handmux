import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { sendText, uploadFile, UnauthorizedError } from '../api.js';
import KeyBar from './KeyBar.jsx';
import FavDrawer from './FavDrawer.jsx';
import MicButton from './MicButton.jsx';
import { loadFavs } from '../favStore.js';
import { ArrowUpIcon, UploadIcon, ClockIcon } from './icons.jsx';
import { usePushToTalk } from '../voice/usePushToTalk.js';
import { useAsrAvailable } from '../voice/useAsrAvailable.js';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock.js';
import { useBackButton } from '../hooks/useBackButton.js';
import { t } from '../i18n';
import { MODIFIERS, modActive, consumeMods, withMods } from '../keybarKeys.js';

// The bottom dock is a two-page pager (swipe the whole area left/right to switch; two dots above show
// which page is current):
//   • COMMAND page — a fixed 3-row keyboard (KeyBar, inverted-T arrows) whose ⌨ key pops / dismisses the
//     system keyboard; a hidden capture <input> receives the keystrokes and streams each one straight
//     into the pane (the terminal is the display, there is no visible box).
//   • CHAT page — the composer (＋ upload, textarea, ▤/常用, mic, send ↑ — tap = type+Enter, long-press =
//     填入). The mode defaults from whether a coding agent is live in the pane, and sticks per-pane.
// Quick-bar labels that are terminal KEYS, not text: tapping them fires onKey (e.g. ESC → interrupt)
// instead of typing the letters + Enter. Keyed by the item's label so a user can add/remove them freely.
const KEY_FAVS = { ESC: 'Escape', Esc: 'Escape', Tab: 'Tab' };

// How far (px) a horizontal drag must travel before releasing commits a page switch. Higher = harder to
// trigger a swap by accident (was 50).
const SWIPE_COMMIT_PX = 80;

// Quick-command chips are tinted by CATEGORY (three styles, not a per-label rainbow): a KEY (ESC/Tab) =
// grey, a slash-command (/compact …) = blue, everything else (ok/go on/1/2/3 …) = green.
// → .qc-esc / .qc-cmd / .qc-reply.
const chipTint = (text) => {
  if (KEY_FAVS[text]) return 'esc';
  if (text.startsWith('/')) return 'cmd';
  return 'reply';
};

function BottomDock({
  pane, onAuthFail, onKey, onText, cwd = null, agent = null,
  recent = [], onSent, onRemoveRecent,
}, fwdRef) {
  const [value, setValue] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  // The chat page's horizontal quick-command bar reads the agent 常用 list; re-load it whenever the
  // FavDrawer closes so add/delete there flow straight into the bar (single source of truth: favStore).
  const [favs, setFavs] = useState(() => loadFavs('agent'));
  useEffect(() => { if (!panelOpen) setFavs(loadFavs('agent')); }, [panelOpen]);
  const [modeOverride, setModeOverride] = useState({}); // pane → 'command' | 'agent'
  const mode = modeOverride[pane] || (agent ? 'agent' : 'command');
  const setMode = (next) => setModeOverride((m) => ({ ...m, [pane]: next }));
  // Live modifier state, lifted here so the KeyBar and the command-mode capture input can share it.
  const [mods, setMods] = useState({ ctrl: 'off', shift: 'off', alt: 'off' });
  // Whether the system keyboard is up (the capture input is focused) — lights the ⌨ toggle. Kept in
  // sync by the capture's onFocus/onBlur, so tapping the terminal (which blurs it) also drops the flag.
  const [keyboardUp, setKeyboardUp] = useState(false);
  // Entering CHAT mode restores the composer's grown height for any preserved multi-line text.
  useEffect(() => {
    if (mode === 'agent') requestAnimationFrame(() => autoGrow(ref.current));
  }, [mode]);

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
  // One instant resize per change = one clean repaint. autoGrow first so multi-line text is fully measured
  // (never clipped at the top). No React renders fire during a finger drag, so the height holds steady
  // through the whole swipe — the terminal doesn't move until the page actually commits.
  useLayoutEffect(() => {
    const pager = pagerRef.current;
    if (!pager) return;
    if (mode === 'agent') autoGrow(ref.current);
    const active = pager.querySelector(mode === 'command' ? '.dock-page.command' : '.dock-page.chat');
    if (active) pager.style.height = `${active.offsetHeight}px`;
  });
  // Native (non-passive) touch handlers so a horizontal drag can preventDefault the page's own scroll.
  useEffect(() => {
    const pager = pagerRef.current;
    if (!pager) return;
    let d = null;
    const onStart = (e) => {
      releaseTrack(); // drop any inline transform a previous (interrupted) gesture may have left behind
      // Remember if the drag began on the horizontally-scrolling quick-command strip: that gesture is
      // normally the strip's own native scroll, but at its LEFT edge a further right-drag should carry
      // over into a page swipe to command mode (decided in onMove once we know the direction).
      const strip = e.target?.closest?.('.quick-scroll') || null;
      d = e.touches.length === 1
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, decided: false, horiz: false, strip }
        : null;
    };
    const onMove = (e) => {
      if (!d || e.touches.length !== 1) return;
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
        // in that direction toward another page — i.e. it's at its LEFT edge and you're dragging RIGHT
        // (which reveals the command page). Otherwise hand the whole gesture to the strip's native scroll.
        if (d.horiz && d.strip) {
          const atLeft = d.strip.scrollLeft <= 0;
          if (!(dx > 0 && atLeft && pageIndexRef.current === 1)) d.horiz = false;
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
    pager.addEventListener('touchstart', onStart, { passive: true });
    pager.addEventListener('touchmove', onMove, { passive: false });
    pager.addEventListener('touchend', onEnd, { passive: true });
    pager.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
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
  const autoGrow = (el) => {
    if (!el) return;
    el.style.height = 'auto';
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

  // Quick-bar / drawer tap = send immediately. A KEY_FAVS label fires the terminal key (ESC → interrupt);
  // everything else is typed + Enter via sendFav.
  const runFav = (text) => {
    if (KEY_FAVS[text]) { onKey(KEY_FAVS[text]); return; }
    sendFav(text);
  };

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
    const list = Array.from(files || []);
    if (!list.length) return;
    clearTimeout(upTimerRef.current);
    const total = list.length;
    const paths = [];
    const failed = [];
    for (let i = 0; i < total; i++) {
      const f = list[i];
      const tag = total > 1 ? `（${i + 1}/${total}）` : '';
      setUpload({ label: t('dock.upload.progress', { name: f.name, tag }), pct: 0 });
      try {
        const res = await uploadFile(cwd || '', f, (pct) => setUpload({ label: t('dock.upload.progress', { name: f.name, tag }), pct }), true);
        if (res?.path) paths.push(res.path);
      } catch (err) {
        if (err instanceof UnauthorizedError) { onAuthFail?.(); setUpload(null); return; }
        failed.push(f.name);
      }
    }
    if (paths.length) insertPaths(paths);
    if (failed.length) {
      setUpload({ label: t('dock.upload.failed', { names: failed.join('、') }), error: true });
      upTimerRef.current = setTimeout(() => setUpload(null), 3500);
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
  const sendTimer = useRef(null);
  const sendLongRef = useRef(false);
  const sendDown = (e) => {
    if (e.cancelable) e.preventDefault();
    sendLongRef.current = false;
    if (!value) return; // empty box → no long-press; releasing just sends a bare Enter
    sendTimer.current = setTimeout(() => {
      sendLongRef.current = true;
      navigator.vibrate?.(12);
      fill();
    }, 450);
  };
  const sendUp = () => {
    clearTimeout(sendTimer.current);
    sendTimer.current = null;
    if (sendLongRef.current) { sendLongRef.current = false; return; } // long-press already filled
    send();
  };
  const sendCancel = () => {
    clearTimeout(sendTimer.current);
    sendTimer.current = null;
    sendLongRef.current = false;
  };

  return (
    <div className="bottom-dock">
      <div className="dock-left">
        {/* Two-dot page indicator (command · chat); the filled dot marks the current page. A tiny label
            sits at the top-left, absolutely positioned so it adds no height (stays in the dots' row). */}
        <div className="dock-dots">
          <span className="dock-mode-label">{mode === 'command' ? t('dock.mode.command') : t('dock.mode.chat')}</span>
          <i className={`dock-dot${mode === 'command' ? ' on' : ''}`} data-page="command" aria-hidden="true" />
          <i className={`dock-dot${mode === 'agent' ? ' on' : ''}`} data-page="agent" aria-hidden="true" />
        </div>
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
              <KeyBar onKey={onKey} onText={onText} mods={mods} setMods={setMods}
                onOpenFav={() => setPanelOpen((o) => !o)} onToggleKeyboard={toggleKeyboard} keyboardUp={keyboardUp} />
            </div>
            <div className={`dock-page chat${mode === 'agent' ? ' on' : ''}`}>
              {upload && (
                <div className={`dock-upload${upload.error ? ' error' : ''}`}>
                  <span className="dock-upload-label">
                    {upload.label}{!upload.error && ` ${Math.round(upload.pct * 100)}%`}
                  </span>
                  {!upload.error && (
                    <span className="dock-upload-track">
                      <span className="dock-upload-fill" style={{ width: `${Math.round(upload.pct * 100)}%` }} />
                    </span>
                  )}
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
                  {favs.map((f) => (
                    <button key={f.text} type="button" className={`quick-cmd qc-${chipTint(f.text)}`}
                      onClick={() => runFav(f.text)}>{f.text}</button>
                  ))}
                </div>
              </div>
              {/* 离屏(非 display:none)以便程序化 .click() 在 iOS Safari 可靠唤起原生选择器,见 .browse-file-input。 */}
              <input ref={uploadRef} className="browse-file-input" type="file" multiple
                onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
              {/* flex 行:textarea(占满)· 麦克风 · 发送,全是 flex 兄弟、不重叠文字框,所以选词/移光标碰不到
                  按键。录音时整条变绿 + 呼吸。＋上传与▤常用已上移到快捷栏。 */}
              <div className={`input-wrap${recording ? ' recording' : ''}`}>
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
                {/* 历史:麦克风左侧,只在空框时出现(仅一个图标);一打字就整个隐藏,给文字腾地方。 */}
                {!value && (
                  <button type="button" className="input-history" aria-label={t('dock.history')} title={t('dock.history')}
                    onClick={() => setPanelOpen((o) => !o)}><ClockIcon /></button>
                )}
                {micAvailable && <MicButton active={recording} disabled={voice.state === 'requesting'} onToggle={toggleMic} />}
                {/* 发送 ↑ 常驻,空框禁用:点 = 发送组合文本,长按 = 填入。 */}
                <button type="button" className="input-send" aria-label={t('dock.send')} title={t('dock.send.hint')}
                  disabled={!value}
                  onPointerDown={sendDown} onPointerUp={sendUp} onPointerCancel={sendCancel} onPointerLeave={sendCancel}>
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
    </div>
  );
}

export default forwardRef(BottomDock);
