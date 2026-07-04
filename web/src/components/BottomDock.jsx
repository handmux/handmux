import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { sendText, uploadFile, UnauthorizedError } from '../api.js';
import KeyBar from './KeyBar.jsx';
import FavDrawer from './FavDrawer.jsx';
import MicButton from './MicButton.jsx';
import { ArrowUpIcon, PlusIcon, CommandIcon } from './icons.jsx';
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
function BottomDock({
  pane, onAuthFail, onKey, onText, cwd = null, agent = null,
  recent = [], onSent,
}, fwdRef) {
  const [value, setValue] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
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
  const firstSnapRef = useRef(true);
  // The track's horizontal position is driven imperatively — a 60fps finger drag can't go through React
  // state without fighting re-renders. setX writes an absolute translate; settleTo snaps to a PAGE-ALIGNED
  // rest. Everything that ends a gesture calls settleTo, so the track can never come to rest between pages.
  const TRACK_EASE = 'transform .3s cubic-bezier(.22,.61,.36,1)';
  const trackW = () => pagerRef.current?.clientWidth || 0;
  const setX = (px, animate) => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = animate ? TRACK_EASE : 'none';
    track.style.transform = `translate3d(${px}px, 0, 0)`;
  };
  const settleTo = (index, animate) => setX(-index * trackW(), animate);
  // Snap to the current page whenever it changes (animated after the first render).
  useEffect(() => { settleTo(pageIndex, !firstSnapRef.current); firstSnapRef.current = false; }, [pageIndex]);
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
      d = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, decided: false, horiz: false } : null;
    };
    const onMove = (e) => {
      if (!d || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - d.x, dy = e.touches[0].clientY - d.y;
      if (!d.decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        d.decided = true;
        d.horiz = Math.abs(dx) > Math.abs(dy);
      }
      if (!d.horiz) return; // a vertical drag → leave it to native scroll/selection
      e.preventDefault();
      d.dx = dx;
      const w = trackW() || 1;
      let vx = dx; // follow the finger, but resist dragging past the ends (only two pages)
      if (pageIndexRef.current === 0) vx = Math.min(0, Math.max(-w, vx));
      else vx = Math.max(0, Math.min(w, vx));
      setX(-pageIndexRef.current * w + vx, false);
    };
    const onEnd = () => {
      if (!d || !d.horiz) { d = null; return; }
      const cur = pageIndexRef.current, dx = d.dx;
      d = null;
      let target = cur;
      if (cur === 0 && dx < -50) target = 1;      // dragged far left off command → chat
      else if (cur === 1 && dx > 50) target = 0;  // dragged far right off chat → command
      // Settle to a page-aligned rest RIGHT NOW, imperatively — never wait on a React re-render (that
      // timing gap is exactly what left the track stuck at half). Then sync React state if the page
      // changed; its pageIndex effect re-runs settleTo to the same target, which is idempotent.
      settleTo(target, true);
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
        {/* Two-dot page indicator (command · chat); the filled dot marks the current page. */}
        <div className="dock-dots" aria-hidden="true">
          <i className={`dock-dot${mode === 'command' ? ' on' : ''}`} data-page="command" />
          <i className={`dock-dot${mode === 'agent' ? ' on' : ''}`} data-page="agent" />
        </div>
        <div className="dock-pager" ref={pagerRef}>
          <div className="dock-track" ref={trackRef}>
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
              {/* flex 行:＋(左)· textarea(中,占满)· ▤/麦克风/发送(右),全是 flex 兄弟、不重叠文字框,
                  所以选词/移光标碰不到按键。录音时整条变绿 + 呼吸;▤常用语仅空框时出现在麦克风左边(打字即隐)。 */}
              <div className={`input-wrap${recording ? ' recording' : ''}`}>
                <button type="button" className="input-upload" aria-label={t('dock.upload.aria')} title={t('dock.upload.title')}
                  disabled={!!upload && !upload.error} onClick={() => uploadRef.current?.click()}>
                  <PlusIcon />
                </button>
                {/* 离屏(非 display:none)以便程序化 .click() 在 iOS Safari 可靠唤起原生选择器,见 .browse-file-input。 */}
                <input ref={uploadRef} className="browse-file-input" type="file" multiple
                  onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
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
                {!value && (
                  <button type="button" className="input-cmd" aria-label={t('dock.phrases')} title={t('dock.phrases')}
                    onClick={() => setPanelOpen((o) => !o)}><CommandIcon /></button>
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
      <FavDrawer open={panelOpen} mode={mode} recent={recent}
        onSend={(text) => { setPanelOpen(false); sendFav(text); }}
        onFill={(text) => { setPanelOpen(false); fillFav(text); }}
        onClose={() => setPanelOpen(false)} />
    </div>
  );
}

export default forwardRef(BottomDock);
