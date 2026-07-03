import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { sendText, uploadFile, UnauthorizedError } from '../api.js';
import { createRepeater } from '../repeat.js';
import KeyBar from './KeyBar.jsx';
import CommandPanel from './CommandPanel.jsx';
import MicButton from './MicButton.jsx';
import { ArrowUpIcon, PlusIcon, CommandIcon } from './icons.jsx';
import { usePushToTalk } from '../voice/usePushToTalk.js';
import { useAsrAvailable } from '../voice/useAsrAvailable.js';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock.js';
import { useBackButton } from '../hooks/useBackButton.js';
import { t } from '../i18n';

// The bottom dock. Key area (row 1): the scrolling KeyBar with ⌫ and an Enter key pinned at its right
// end. Enter sends a Return KEY via /keys (y/n, menu confirm, advancing Claude), NOT the composed text.
// Input row (row 2) runs to the far right: ▤ command panel at the left (only on an empty box), the
// textarea, and ALWAYS the inline tap-toggle mic + a persistent blue send ↑ at the right (tap = type+
// Enter, long-press = 填入). ▤ shows only on an empty box; the send ↑ is always present but DISABLED
// when the box is empty.
function BottomDock({
  pane, onAuthFail, onKey, onText, cwd = null, agent = null,
  recent = [], favorites = [], onSent, onToggleFav, onRemoveRecent,
}, fwdRef) {
  const [value, setValue] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  // Input mode. 'command' = a single-line field whose Return runs the line in the shell (that rhythm);
  // 'agent' = the multi-line composer for prose prompts (voice/upload/phrases). The default follows
  // whether a coding agent is live in this pane (states.agent, passed in), and sticks per-pane once the
  // user flips the toggle. The keyboard's context (shell symbols vs agent menu/slash keys) tracks it.
  const [modeOverride, setModeOverride] = useState({}); // pane → 'command' | 'agent'
  const mode = modeOverride[pane] || (agent ? 'agent' : 'command');
  const toggleMode = () =>
    setModeOverride((m) => ({ ...m, [pane]: mode === 'command' ? 'agent' : 'command' }));
  // Hardware Back closes the command panel instead of exiting the app.
  useBackButton(panelOpen, () => setPanelOpen(false));
  const [upload, setUpload] = useState(null); // { label, pct, error } during/after an upload, else null
  const ref = useRef(null);
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

  // ⌫ auto-repeats while held (like the keybar arrows). The repeater is created once but always
  // calls the LATEST onKey via a ref — onKey is rebuilt with the new pane id on every pane switch,
  // so without this a held ⌫ would keep deleting in the stale (first) pane. Pointer events only,
  // so a tap fires exactly one BSpace (see KeyBar for the touch+mouse double-fire we avoid).
  const delRepRef = useRef(null);
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  const delStart = (e) => {
    if (e.cancelable) e.preventDefault();
    if (!delRepRef.current) delRepRef.current = createRepeater(() => onKeyRef.current('BSpace'));
    delRepRef.current.start();
  };
  const delStop = () => delRepRef.current?.stop();

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
  // rather than a newline). An empty box sends a bare Enter — this absorbs the old keybar Enter.
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

  // Command mode: the soft-keyboard Return runs the line immediately (type + Enter), the shell rhythm.
  // Skipped while an IME is composing (isComposing — else committing a pinyin/kana word would submit)
  // and with Shift held (an escape hatch for a literal newline). Agent mode keeps the native newline.
  const onInputKeyDown = (e) => {
    if (mode !== 'command') return;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) {
      e.preventDefault();
      send();
    }
  };

  // Pick a command from the panel: fill the box (never send), close the panel, refocus so the user
  // can edit before submitting with the rail's Enter.
  const pick = (cmd) => {
    setValue(cmd);
    setPanelOpen(false);
    requestAnimationFrame(() => { ref.current?.focus(); autoGrow(ref.current); });
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
        {/* 按键区:键条横滚占满,右端竖着叠两行 ⌫(上)/ Enter(下),与键条同高。
            Enter 发 /keys Enter——应答 y/n、菜单确认、推进 Claude,不发组合文本。 */}
        <div className="keyrow">
          <KeyBar onKey={onKey} onText={onText} context={mode === 'command' ? 'shell' : 'agent'} />
          <div className="keyrow-stack">
            <button type="button" className="keyrow-del" aria-label={t('common.delete')}
              onPointerDown={delStart} onPointerUp={delStop} onPointerCancel={delStop} onPointerLeave={delStop}>⌫</button>
            <button type="button" className="keyrow-enter" onClick={() => onKey('Enter')}>Enter</button>
          </div>
        </div>
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
        <div className="dock-input-row">
          {/* flex 行:＋(左)· textarea(中,占满)· ▤/麦克风/发送(右),全是 flex 兄弟、不重叠文字框,
              所以选词/移光标碰不到按键。录音时整条变绿 + 呼吸;▤常用语仅空框时出现在麦克风左边(打字即隐)。 */}
          <div className={`input-wrap ${mode}${recording ? ' recording' : ''}`}>
            {/* Mode toggle (command ⇄ agent): the pill shows the CURRENT mode and its accent colours the
                whole bar, so you always know which way a keystroke goes. Persistent left slot = stable. */}
            <button type="button" className="input-mode" data-mode={mode} aria-pressed={mode === 'command'}
              aria-label={t('dock.mode.toggle')} title={t('dock.mode.toggle')} onClick={toggleMode}>
              {t(mode === 'command' ? 'dock.mode.command' : 'dock.mode.agent')}
            </button>
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
              onKeyDown={onInputKeyDown}
              enterKeyHint={mode === 'command' ? 'go' : 'enter'}
              placeholder={t(mode === 'command' ? 'dock.command.placeholder' : 'dock.input.placeholder')}
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
      <CommandPanel
        open={panelOpen}
        recent={recent}
        favorites={favorites}
        onPick={pick}
        onToggleFav={onToggleFav}
        onRemoveRecent={onRemoveRecent}
        onClose={() => setPanelOpen(false)}
      />
    </div>
  );
}

export default forwardRef(BottomDock);
