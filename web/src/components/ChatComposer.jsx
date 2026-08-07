import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  sendText, sendCodexMessage, compactCodexSession, clearCodexSession, interruptCodexSession,
  getCodexModels, updateCodexSettings, UnauthorizedError,
} from '../api.js';
import { shouldHandOffSlash } from '../slashCommands.js';
import MicButton from './MicButton.jsx';
import CmdFavEditor from './CmdFavEditor.jsx';
import { loadFavs } from '../favStore.js';
import { getChatDraft, setChatDraft } from '../storage.js';
import { usePaneContext } from '../hooks/usePaneContext.js';
import { UPLOAD_ACCEPT } from '../uploadTypes.js';
import { ArrowUpIcon, StopIcon, PlusIcon, GearIcon, ChevronDownIcon, RefreshIcon } from './icons.jsx';
import { useUpload } from '../hooks/useUpload.js';
import { usePushToTalk } from '../voice/usePushToTalk.js';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock.js';
import { DEFAULT_SERVER_SHORTCUTS, mergeShortcuts, shortcutIdentity } from '../shortcutMerge.js';
import { applyShortcutLayout, loadShortcutLayout } from '../shortcutLayout.js';
import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';

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

// model/list is account-wide and effectively static for one app run. Share one successful request across
// composer remounts and pane switches; the dropdown's refresh action is the only automatic cache bypass.
let codexModelsCache = null;
let codexModelsRequest = null;

export function clearCodexModelsCache() {
  codexModelsCache = null;
  codexModelsRequest = null;
}

function loadCodexModels(pane, refresh = false) {
  if (refresh) clearCodexModelsCache();
  if (codexModelsCache) return Promise.resolve(codexModelsCache);
  if (!codexModelsRequest) {
    codexModelsRequest = getCodexModels(pane).then((result) => {
      codexModelsCache = Array.isArray(result?.models) ? result.models : [];
      return codexModelsCache;
    });
  }
  return codexModelsRequest;
}

function CodexConfigMenu({ open, pane, settings, busy, onChange, onClose, onAuthFail }) {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const requestSeqRef = useRef(0);
  useBackButton(open, onClose);

  const load = async (refresh = false) => {
    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    setError('');
    try {
      const next = await loadCodexModels(pane, refresh);
      if (requestSeq === requestSeqRef.current) setModels(next);
    } catch (err) {
      if (requestSeq !== requestSeqRef.current) return;
      if (err instanceof UnauthorizedError) onAuthFail?.();
      else setError(err?.serverError || err?.message || t('chat.config.loadFailed'));
    } finally {
      if (requestSeq === requestSeqRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !pane) return undefined;
    void load(false);
    return () => { requestSeqRef.current++; };
    // load reads the shared app-run cache; opening or switching the active pane is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane]);

  if (!open) return null;
  const selectedModel = models.find((model) => model.model === settings?.model || model.id === settings?.model);
  const efforts = selectedModel?.supportedReasoningEfforts || [];
  const disabled = busy || saving;
  const save = async (updates) => {
    if (disabled) return;
    setSaving(true);
    setError('');
    try {
      const result = await updateCodexSettings(pane, updates);
      onChange(result?.settings || { ...settings, ...updates });
    } catch (err) {
      if (err instanceof UnauthorizedError) onAuthFail?.();
      else setError(err?.serverError || err?.message || t('chat.config.saveFailed'));
    } finally { setSaving(false); }
  };
  const pickModel = (model) => {
    const supported = (model.supportedReasoningEfforts || []).map((item) => item.reasoningEffort);
    const updates = { model: model.model || model.id };
    if (supported.length && !supported.includes(settings?.effort)) {
      updates.effort = model.defaultReasoningEffort || supported[0];
    }
    void save(updates);
  };

  return (
    <>
      <div className="codex-config-backdrop" onClick={onClose} />
      <section className="codex-config-menu" role="dialog" aria-modal="true"
        aria-label={t('chat.config.title')}>
        <header className="codex-config-head">
          <strong>{t('chat.config.title')}</strong>
          <button type="button" className={loading ? 'is-refreshing' : ''}
            aria-label={t('chat.config.refresh')} disabled={loading || saving}
            onClick={() => void load(true)}><RefreshIcon /></button>
        </header>
        <div className="codex-config-body">
          <div className="codex-config-section">
            <div className="codex-config-label">{t('chat.config.model')}</div>
            {loading && <div className="codex-config-state">{t('chat.config.loading')}</div>}
            {!loading && models.length === 0 && !error
              && <div className="codex-config-state">{t('chat.config.empty')}</div>}
            <div className="codex-model-list">
              {models.map((model) => {
                const value = model.model || model.id;
                const selected = value === settings?.model || model.id === settings?.model;
                return (
                  <button type="button" key={model.id || value} disabled={disabled}
                    className={selected ? 'selected' : ''} aria-pressed={selected}
                    onClick={() => pickModel(model)}>
                    <span><strong>{model.displayName || value}</strong>
                      {model.description && <small>{model.description}</small>}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="codex-config-section">
            <div className="codex-config-label">{t('chat.config.effort')}</div>
            <div className="codex-effort-list">
              {efforts.map((item) => (
                <button type="button" key={item.reasoningEffort} disabled={disabled}
                  className={item.reasoningEffort === settings?.effort ? 'selected' : ''}
                  aria-pressed={item.reasoningEffort === settings?.effort}
                  title={item.description || ''}
                  onClick={() => void save({ effort: item.reasoningEffort })}>
                  {item.reasoningEffort}
                </button>
              ))}
              {!loading && efforts.length === 0
                && <div className="codex-config-state">{t('chat.config.chooseModel')}</div>}
            </div>
          </div>
          {error && <div className="codex-config-error" role="status">{error}</div>}
        </div>
      </section>
    </>
  );
}

export default function ChatComposer({
  pane, agent = 'claude', kind, cwd = null, onKey = () => {}, onAuthFail, onSent, onInteractiveSlash,
  shortcuts = null, micAvailable = false, desktop = false, codexSession = null,
}) {
  // Draft persists across an app exit / lens switch (shared store with the dock's chat page — switching
  // lenses carries your half-typed message either way). send/clear set '' → the stored draft clears too.
  const [value, setValue] = useState(() => getChatDraft());
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const submitInFlightRef = useRef(false);
  useEffect(() => { setChatDraft(value); }, [value]);
  const ref = useRef(null);          // the textarea
  const uploadRef = useRef(null);    // hidden <input type=file>
  const tapPt = useRef({ x: 0, y: 0, moved: false }); // for tap-to-focus on the card's blank areas
  useEffect(() => {
    if (desktop) ref.current?.focus({ preventScroll: true });
  }, [desktop, pane]);

  // Shared presets and phone-local additions use one device-local layout. App fetches the server half once;
  // editor changes reload both the local items and layout immediately, even while the sheet stays open.
  const serverShortcuts = shortcuts || DEFAULT_SERVER_SHORTCUTS;
  const [favs, setFavs] = useState(() => loadFavs('agent'));
  const [layout, setLayout] = useState(() => loadShortcutLayout('chat'));
  const [editOpen, setEditOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [localSettings, setLocalSettings] = useState(null);
  const refreshShortcuts = () => {
    setFavs(loadFavs('agent'));
    setLayout(loadShortcutLayout('chat'));
  };
  useEffect(() => { if (!editOpen) refreshShortcuts(); }, [editOpen]);
  useBackButton(editOpen, () => setEditOpen(false));
  const allQuickFavs = applyShortcutLayout(
    mergeShortcuts(serverShortcuts.chat, favs, 'chat'), layout,
  );

  // While the agent is working, the send button becomes a STOP that interrupts it (Escape). Any other
  // state (idle / needs-you / done) shows the normal send.
  const busy = kind === 'working';
  const managedCodex = agent === 'codex' && codexSession?.managed;
  const quickFavs = managedCodex ? allQuickFavs.filter((fav) => fav.kind !== 'key') : allQuickFavs;
  useEffect(() => { if (!busy) setStopping(false); }, [busy, pane]);
  useEffect(() => { setLocalSettings(codexSession?.settings || null); }, [pane, codexSession?.settings]);
  useEffect(() => { if (!managedCodex) setConfigOpen(false); }, [managedCodex]);
  useEffect(() => {
    if (managedCodex && pane) void loadCodexModels(pane).catch(() => {});
  }, [managedCodex, pane]);

  // Current context-window occupancy for this pane's session (model + used %), shown as a small chip in the
  // action row. Absent (null %) when the statusLine capturer isn't opted in → the chip simply doesn't render.
  const ctx = usePaneContext(pane, agent);
  const managedSettings = managedCodex ? localSettings : null;
  const rawModel = managedSettings?.model || ctx.model;
  const ctxModel = rawModel ? rawModel.replace(/\s*\(.*\)\s*$/, '').trim() : null; // drop "(1M context)" suffix
  const ctxPct = ctx.usedPercent;
  const ctxEffort = managedSettings?.effort || null;
  const showCtx = !managedCodex && (!!ctxModel || typeof ctxPct === 'number');
  const ctxWarn = showCtx && ctxPct >= 80; // near auto-compact → amber

  // Grow to fit content; CSS max-height caps it (~6 lines) then it scrolls. +2 for the border under
  // box-sizing: border-box. No multi/crowd measuring — the buttons are in a row below, never inline.
  const autoGrow = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  useLayoutEffect(() => { autoGrow(ref.current); }, [value]);

  const openConfig = () => {
    // Opening this picker must preserve the user's keyboard state. The composer's pointerdown guard keeps
    // an already-focused textarea focused, while a closed keyboard stays closed because the trigger never
    // focuses the textarea itself.
    setConfigOpen(true);
  };
  const applyConfigSlash = async (trimmed) => {
    if (!managedCodex) return false;
    const match = trimmed.match(/^\/(model|effort)(?:\s+(.+))?$/i);
    if (!match) return false;
    if (!match[2]) openConfig();
    else {
      const result = await updateCodexSettings(pane, { [match[1].toLowerCase()]: match[2].trim() });
      setLocalSettings(result?.settings || { ...managedSettings, [match[1].toLowerCase()]: match[2].trim() });
    }
    return true;
  };

  const dispatchManagedCodex = async (text) => {
    const trimmed = text.trim();
    if (await applyConfigSlash(trimmed)) return;
    if (/^\/compact$/i.test(trimmed)) { await compactCodexSession(pane); return; }
    if (/^\/clear$/i.test(trimmed)) { await clearCodexSession(pane); return; }
    if (trimmed.startsWith('/')) throw new Error(t('chat.slash.unsupported'));
    await sendCodexMessage(pane, text);
  };

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

  // Claude still submits through its terminal. Managed Codex sends structured App Server requests only.
  const send = async () => {
    if (!pane || !value.trim() || submitInFlightRef.current) return;
    const text = value;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setSubmitError('');
    stopVoiceIfRecording();
    try {
      if (managedCodex) await dispatchManagedCodex(text);
      else if (agent === 'codex') throw new Error(t('chat.session.notManaged'));
      else await sendText(pane, text, true);
      onSent?.(text);
      if (!managedCodex && agent !== 'codex' && shouldHandOffSlash(text)) {
        onInteractiveSlash?.(text.trim());
      }
      setValue('');
      requestAnimationFrame(() => autoGrow(ref.current));
    } catch (err) {
      if (err instanceof UnauthorizedError) onAuthFail?.();
      else setSubmitError(err?.serverError || err?.message || t('chat.sendFailed'));
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  // Interrupt the working agent — Escape is Claude Code's stop key (same path the terminal ESC uses).
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    setSubmitError('');
    try {
      if (managedCodex) await interruptCodexSession(pane);
      else await onKey('Escape');
    } catch (err) {
      setStopping(false);
      if (err instanceof UnauthorizedError) onAuthFail?.();
      else setSubmitError(err?.serverError || err?.message || t('chat.stopFailed'));
    }
  };
  const onComposerKeyDown = (event) => {
    if (!desktop || event.nativeEvent?.isComposing) return;
    if (event.key === 'Escape' && busy) {
      event.preventDefault();
      void stop();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!busy && value.trim()) void send();
    }
  };

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

  // Terminal keys remain Claude-only. Managed Codex text shortcuts either fill the draft or use the same
  // structured dispatch as the send button, so a shortcut can never write into the hidden TUI.
  const runFav = async (fav) => {
    if (fav.kind === 'key') { onKey(fav.text); return; }
    if (!pane) return;
    try {
      if (managedCodex && !fav.enter) {
        setValue(fav.text);
        requestAnimationFrame(() => ref.current?.focus());
        return;
      }
      if (managedCodex) await dispatchManagedCodex(fav.text);
      else if (agent === 'codex') throw new Error(t('chat.session.notManaged'));
      else await sendText(pane, fav.text, !!fav.enter);
      if (!fav.enter && !managedCodex) return;
      onSent?.(fav.text);
      if (!managedCodex && agent !== 'codex' && shouldHandOffSlash(fav.text)) {
        onInteractiveSlash?.(fav.text.trim());
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) onAuthFail?.();
      else setSubmitError(err?.serverError || err?.message || t('chat.sendFailed'));
    }
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
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          uploadFiles(files);
        }} />
      <div className={`cc-card${recording ? ' recording' : ''}`}
        onPointerDown={cardDown} onPointerMove={cardMove} onPointerUp={cardTapFocus}>
        <textarea
          ref={ref}
          className="cc-text"
          rows={1}
          value={value}
          aria-readonly={submitting}
          onBeforeInput={(e) => {
            if (submitInFlightRef.current) e.preventDefault();
          }}
          onChange={(e) => {
            if (submitInFlightRef.current) {
              e.target.value = value;
              return;
            }
            setValue(e.target.value);
            autoGrow(e.target);
          }}
          onKeyDown={onComposerKeyDown}
          placeholder={t('chat.composer.placeholder')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <div className="cc-actions">
          <div className="cc-actions-left">
            <button type="button" className="cc-attach" aria-label={t('dock.attach')}
              onClick={() => uploadRef.current?.click()}><PlusIcon /></button>
            {managedCodex && (
              <button type="button" className="cc-ctx cc-config-trigger" disabled={busy || submitting}
                aria-label={t('chat.config.open')} onClick={openConfig}>
                <span className="cc-ctx-model">{ctxModel || t('chat.config.model')}</span>
                <span className="cc-ctx-pct">{ctxEffort || t('chat.config.effort')}</span>
                <ChevronDownIcon />
              </button>
            )}
            <CodexConfigMenu open={configOpen} pane={pane} settings={managedSettings} busy={busy}
              onChange={setLocalSettings} onClose={() => setConfigOpen(false)} onAuthFail={onAuthFail} />
          </div>
          <div className="cc-actions-right">
            {/* Context-window chip — model + used %, right-aligned just left of mic/send. pointer-events:none
                so a tap here still focuses the field (tap-to-focus). Rendered only when the capturer supplied
                a % (else nothing); the model name ellipsizes so it can't shove the buttons. */}
            {showCtx && (
              <div className={`cc-ctx${ctxWarn ? ' warn' : ''}`} aria-hidden="true">
                {ctxModel && <span className="cc-ctx-model">{ctxModel}</span>}
                {ctxEffort && <span className="cc-ctx-pct">{ctxEffort}</span>}
                {!ctxEffort && typeof ctxPct === 'number' && <span className="cc-ctx-pct">{Math.round(ctxPct)}%</span>}
              </div>
            )}
            {micAvailable && <MicButton active={recording} disabled={voice.state === 'requesting'} onToggle={toggleMic} />}
            {busy ? (
              <button type="button" className="cc-send cc-stop" aria-label={t('chat.stop')}
                disabled={stopping} onClick={() => void stop()}>
                <StopIcon /></button>
            ) : (
              <button type="button" className="cc-send" aria-label={t('dock.send')}
                disabled={submitting || !value.trim()} onClick={send}>
                <ArrowUpIcon /></button>
            )}
          </div>
        </div>
      </div>
      {submitError && <div className="cc-error" role="status">{submitError}</div>}
      {editOpen && <CmdFavEditor variant="chat" presets={serverShortcuts.chat}
        onChange={refreshShortcuts} onClose={() => setEditOpen(false)} />}
    </div>
  );
}
