import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { sendText, UnauthorizedError } from '../api.js';
import { shouldHandOffSlash } from '../slashCommands.js';
import MicButton from './MicButton.jsx';
import CmdFavEditor from './CmdFavEditor.jsx';
import { loadFavs } from '../favStore.js';
import { getChatDraft, setChatDraft } from '../storage.js';
import { usePaneContext } from '../hooks/usePaneContext.js';
import { UPLOAD_ACCEPT } from '../uploadTypes.js';
import { ArrowUpIcon, StopIcon, PlusIcon, GearIcon } from './icons.jsx';
import { useUpload } from '../hooks/useUpload.js';
import { usePushToTalk } from '../voice/usePushToTalk.js';
import { useAsrAvailable } from '../voice/useAsrAvailable.js';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock.js';
import { useServerShortcuts } from '../hooks/useServerShortcuts.js';
import { mergeShortcuts, shortcutIdentity } from '../shortcutMerge.js';
import { t } from '../i18n';

// The 对话-lens composer — a single modern AI-agent input CARD (textarea on top, an action row beneath),
// shown INSTEAD of the terminal BottomDock while the chat lens is active. It rides above the soft keyboard
// for free: the whole .app is lifted by translateY(-inset) (App.jsx), so this needs no inset math.
//
// Why a card with a separate action row (not the dock's inline pill): the buttons live in their OWN row
// UNDER the text, so they never overlay it — which erases the dock's nastiest trap (mic/send hovering over
// multi-line text, where a caret-drag onto a button silently dismissed the keyboard). No multi/crowd/
// ghost-hit machinery is needed here at all; the textarea is always full-width and simply grows.
//
// A tap anywhere on the card that ISN'T the textarea must NOT blur it and drop the keyboard — preventDefault
// on pointerdown keeps focus where it is; onClick still fires. (Same trick the dock uses.) So send/attach/
// mic/chips all keep the keyboard up, and you can keep chatting after sending.
const keepFocus = (e) => {
  if (e.target.closest?.('input, textarea, [contenteditable]')) return;
  if (e.cancelable) e.preventDefault();
};

// Quick-reply chip tint: a slash-command (/compact …) = blue, everything else (好的 / 继续 / 1 / 2 …) =
// green. Explicit terminal-key shortcuts use the grey key tint.
const chipTint = (text) => (text.startsWith('/') ? 'cmd' : 'reply');

export default function ChatComposer({
  pane, kind, cwd = null, onKey = () => {}, onAuthFail, onSent, onInteractiveSlash, shortcuts = null,
}) {
  // Draft persists across an app exit / lens switch (shared store with the dock's chat page — switching
  // lenses carries your half-typed message either way). send/clear set '' → the stored draft clears too.
  const [value, setValue] = useState(() => getChatDraft());
  useEffect(() => { setChatDraft(value); }, [value]);
  const ref = useRef(null);          // the textarea
  const uploadRef = useRef(null);    // hidden <input type=file>
  const tapPt = useRef({ x: 0, y: 0, moved: false }); // for tap-to-focus on the card's blank areas

  // Config presets stay first and locked; phone-local additions follow. Reload the local half whenever the
  // ⚙ editor closes, while the shared server hook refreshes presets after a service restart.
  const serverShortcuts = useServerShortcuts(shortcuts);
  const [favs, setFavs] = useState(() => loadFavs('agent'));
  const [editOpen, setEditOpen] = useState(false);
  useEffect(() => { if (!editOpen) setFavs(loadFavs('agent')); }, [editOpen]);
  const quickFavs = mergeShortcuts(serverShortcuts.chat, favs, 'chat');

  // While the agent is working, the send button becomes a STOP that interrupts it (Escape). Any other
  // state (idle / needs-you / done) shows the normal send.
  const busy = kind === 'working';

  // Current context-window occupancy for this pane's session (model + used %), shown as a small chip in the
  // action row. Absent (null %) when the statusLine capturer isn't opted in → the chip simply doesn't render.
  const ctx = usePaneContext(pane);
  const ctxModel = ctx.model ? ctx.model.replace(/\s*\(.*\)\s*$/, '').trim() : null; // drop "(1M context)" suffix
  const ctxPct = ctx.usedPercent;
  const showCtx = typeof ctxPct === 'number';
  const ctxWarn = showCtx && ctxPct >= 80; // near auto-compact → amber

  // Grow to fit content; CSS max-height caps it (~6 lines) then it scrolls. +2 for the border under
  // box-sizing: border-box. No multi/crowd measuring — the buttons are in a row below, never inline.
  const autoGrow = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  useLayoutEffect(() => { autoGrow(ref.current); }, [value]);

  // ── Voice dictation (single-column, simpler than the dock: no caret-restore, so it dodges the iOS
  // setSelectionRange-on-unfocused trap entirely). Recognised text is inserted at the caret anchor taken
  // when recording started; the live partial rewrites in place; a send mid-recording suppresses the commit.
  const anchorRef = useRef({ head: '', tail: '' });
  const suppressVoiceRef = useRef(false);
  const commitVoice = (text) => {
    if (suppressVoiceRef.current) { suppressVoiceRef.current = false; return; }
    const { head, tail } = anchorRef.current;
    setValue(head + text + tail);
  };
  const voice = usePushToTalk({ onText: commitVoice });
  const micAvailable = useAsrAvailable();
  const recording = voice.state === 'recording' || voice.state === 'finalizing';
  useScreenWakeLock(recording); // keep the screen awake while dictating
  useEffect(() => {
    if (voice.state !== 'recording' && voice.state !== 'finalizing') return;
    if (suppressVoiceRef.current) return;
    const { head, tail } = anchorRef.current;
    setValue(head + voice.partial + tail);
  }, [voice.partial, voice.state]);
  const toggleMic = () => {
    if (recording) { voice.stop(); return; }
    const el = ref.current;
    const sel = el ? el.selectionStart : value.length;
    anchorRef.current = { head: value.slice(0, sel), tail: value.slice(sel) };
    voice.start();
  };
  const stopVoiceIfRecording = () => { if (recording) { suppressVoiceRef.current = true; voice.stop(); } };

  // Type the text then Enter (the server paces the two so a TUI reads Enter as "submit", not a newline).
  const send = async () => {
    if (!pane || !value.trim()) return;
    stopVoiceIfRecording();
    try {
      await sendText(pane, value, true);
      onSent?.(value);
      // A bare, non-one-shot slash command may have opened a TUI picker that lives only in the terminal (and
      // the transcript stays silent until the user picks). Hand off to the terminal lens so they can see and
      // drive it — including unrecognized commands, since a missed picker leaves the phone stuck.
      if (shouldHandOffSlash(value)) onInteractiveSlash?.(value.trim());
      setValue('');
      requestAnimationFrame(() => autoGrow(ref.current));
    } catch (err) {
      if (err instanceof UnauthorizedError) onAuthFail?.();
    }
  };

  // Interrupt the working agent — Escape is Claude Code's stop key (same path the terminal ESC uses).
  const stop = () => onKey('Escape');

  // Tap the card's blank areas (chiefly the action row's empty middle) to focus the textarea — a bigger,
  // forgiving target than the thin textarea itself. A movement threshold (like MicButton) rejects a
  // scroll/lens-swipe that merely starts here, so it never mis-fires: only a stationary tap focuses. Taps
  // that land on a control or the textarea are left alone (their own handlers / native focus apply).
  const cardDown = (e) => { tapPt.current = { x: e.clientX, y: e.clientY, moved: false }; };
  const cardMove = (e) => {
    const p = tapPt.current;
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) p.moved = true;
  };
  const cardTapFocus = (e) => {
    const p = tapPt.current;
    // Reject if it moved during the press (a scroll/lens-swipe), OR if the up landed far from the down —
    // a second signal in case fast-swipe move events were throttled/missed. Only a stationary tap focuses.
    if (p.moved || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) return;
    if (e.target.closest?.('button, a, input, textarea, [contenteditable]')) return; // a control / the field
    ref.current?.focus();
  };

  // A quick item has the same explicit behavior here as in the terminal chat dock: key → send the terminal
  // key; text → type only or type + Enter according to its configured boolean.
  const runFav = async (fav) => {
    if (fav.kind === 'key') { onKey(fav.text); return; }
    if (!pane) return;
    try {
      await sendText(pane, fav.text, !!fav.enter);
      if (!fav.enter) return;
      onSent?.(fav.text);
      if (shouldHandOffSlash(fav.text)) onInteractiveSlash?.(fav.text.trim());
    } catch (err) { if (err instanceof UnauthorizedError) onAuthFail?.(); }
  };

  // After an upload, append the files' absolute paths to the draft (one → the path; many → the shared dir
  // prefix once + brace-expanded names), then focus to keep typing. Mirrors the dock's insertPaths.
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
  const { uploadFiles } = useUpload({ cwd, onAuthFail, onPaths: insertPaths });

  return (
    <div className="chat-composer" onPointerDown={keepFocus}>
      {/* Quick-reply chips — tap to send. Reuses the dock's chip styling (.quick-cmd/.qc-*). */}
      <div className="cc-quick quick-scroll">
        {quickFavs.map((f, i) => (
          <button key={`${shortcutIdentity(f)}:${i}`} type="button"
            className={`quick-cmd qc-${f.kind === 'key' ? 'esc' : chipTint(f.text)}`}
            onClick={() => runFav(f)}>
            {f.kind === 'key' ? (f.label || f.text) : f.text}</button>
        ))}
        <button type="button" className="quick-cmd quick-cmd-add" aria-label={t('chat.editTitle')}
          onClick={() => setEditOpen(true)}><GearIcon /></button>
      </div>
      {/* Offscreen (not display:none) so a programmatic .click() reliably opens the picker on iOS Safari. */}
      <input ref={uploadRef} className="browse-file-input" type="file" multiple accept={UPLOAD_ACCEPT}
        onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
      <div className={`cc-card${recording ? ' recording' : ''}`}
        onPointerDown={cardDown} onPointerMove={cardMove} onPointerUp={cardTapFocus}>
        <textarea
          ref={ref}
          className="cc-text"
          rows={1}
          value={value}
          onChange={(e) => { setValue(e.target.value); autoGrow(e.target); }}
          placeholder={t('chat.composer.placeholder')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <div className="cc-actions">
          <button type="button" className="cc-attach" aria-label={t('dock.attach')}
            onClick={() => uploadRef.current?.click()}><PlusIcon /></button>
          <div className="cc-actions-right">
            {/* Context-window chip — model + used %, right-aligned just left of mic/send. pointer-events:none
                so a tap here still focuses the field (tap-to-focus). Rendered only when the capturer supplied
                a % (else nothing); the model name ellipsizes so it can't shove the buttons. */}
            {showCtx && (
              <div className={`cc-ctx${ctxWarn ? ' warn' : ''}`} aria-hidden="true">
                {ctxModel && <span className="cc-ctx-model">{ctxModel}</span>}
                <span className="cc-ctx-pct">{Math.round(ctxPct)}%</span>
              </div>
            )}
            {micAvailable && <MicButton active={recording} disabled={voice.state === 'requesting'} onToggle={toggleMic} />}
            {busy ? (
              <button type="button" className="cc-send cc-stop" aria-label={t('chat.stop')} onClick={stop}>
                <StopIcon /></button>
            ) : (
              <button type="button" className="cc-send" aria-label={t('dock.send')} disabled={!value.trim()} onClick={send}>
                <ArrowUpIcon /></button>
            )}
          </div>
        </div>
      </div>
      {editOpen && <CmdFavEditor variant="chat" presets={serverShortcuts.chat} onClose={() => setEditOpen(false)} />}
    </div>
  );
}
