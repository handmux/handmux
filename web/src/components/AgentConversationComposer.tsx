import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpIcon, GearIcon, PlusIcon, StopIcon } from './icons.jsx';
import { t } from '../i18n';
import {
  ConversationSendError,
  canSendConversation,
  isConversationDeliveryUnknown,
  type AgentConversationController,
} from '../hooks/useAgentConversation.js';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { ServerShortcuts } from '../shortcutMerge.js';
import type { ConversationActivity } from '../agentConversationControlsApi.js';
import { DEFAULT_SERVER_SHORTCUTS, mergeShortcuts, shortcutIdentity } from '../shortcutMerge.js';
import { applyShortcutLayout, loadShortcutLayout } from '../shortcutLayout.js';
import { loadFavs } from '../favStore.js';
import CmdFavEditor from './CmdFavEditor.jsx';
import MicButton from './MicButton.jsx';
import { usePushToTalk } from '../voice/usePushToTalk.js';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock.js';
import { useUpload } from '../hooks/useUpload.js';
import { UPLOAD_ACCEPT } from '../uploadTypes.js';
import { OverlayPortal } from '../overlays/OverlayHost.js';
import { isConversationComposerCardPointerTarget } from '../conversationOverlayBoundary.js';
import { softKeyboardUp } from '../hooks/useKeyboardInset.js';
import {
  getConversationDraft,
  appendConversationDraft,
  mergeConversationDraftAfterFailure,
  saveConversationDraft,
} from '../conversationDraftStore.js';
import type { AsrMode } from '../voice/usePushToTalk.js';

function autoGrow(element: HTMLTextAreaElement | null): void {
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${Math.min(element.scrollHeight, 144)}px`;
}

export default function AgentConversationComposer({
  agentId,
  sessionId,
  busy,
  activity,
  desktop = false,
  conversation,
  onSendStart,
  cwd = null,
  shortcuts = null,
  micAvailable = false,
  voiceMode = 'streaming',
  onAuthFail,
  sessionControl,
  headerContent,
  queueContent,
  actionContent,
  onSlashCommand,
  chatTone = 'dusk',
  keyboardInset = 0,
}: {
  agentId: string;
  sessionId: string;
  busy: boolean;
  activity?: ConversationActivity;
  desktop?: boolean;
  conversation: AgentConversationController;
  onSendStart?: () => void;
  cwd?: string | null;
  shortcuts?: ServerShortcuts | null;
  micAvailable?: boolean;
  voiceMode?: AsrMode;
  onAuthFail?: () => void;
  sessionControl?: ReactNode;
  headerContent?: ReactNode;
  queueContent?: ReactNode;
  actionContent?: ReactNode;
  onSlashCommand?: (text: string) => Promise<boolean>;
  chatTone?: string;
  keyboardInset?: number;
}) {
  const key = `${agentId}\0${sessionId}`;
  const saveDraft = (next: string): void => saveConversationDraft(agentId, sessionId, next);
  const [value, setValue] = useState(() => getConversationDraft(agentId, sessionId));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [favs, setFavs] = useState(() => loadFavs('agent'));
  const [layout, setLayout] = useState(() => loadShortcutLayout('chat'));
  const ref = useRef<HTMLTextAreaElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const tapRef = useRef({ x: 0, y: 0, moved: false });
  // iOS can dismiss the soft keyboard without blurring the textarea. Focus alone therefore cannot decide
  // whether a control tap should preserve the composer: keeping that stale focus through a sheet close can
  // reopen the keyboard. Track the last keyboard-down viewport height and preserve focus only while the
  // keyboard is physically visible (desktop keeps its established keyboard-focus behavior).
  const initialViewport = window.visualViewport;
  const keyboardViewportRef = useRef({
    width: initialViewport?.width ?? window.innerWidth,
    fullHeight: Math.max(window.innerHeight, initialViewport?.height ?? 0),
  });
  const physicalKeyboardUp = (): boolean | null => {
    const viewport = window.visualViewport;
    if (!viewport) return null;
    const baseline = keyboardViewportRef.current;
    if (Math.abs(viewport.width - baseline.width) > 40) {
      baseline.width = viewport.width;
      baseline.fullHeight = Math.max(window.innerHeight, viewport.height);
    } else {
      baseline.fullHeight = Math.max(baseline.fullHeight, window.innerHeight, viewport.height);
    }
    return softKeyboardUp(baseline.fullHeight);
  };
  const keepComposerFocus = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.target instanceof Element
      && event.target.closest('input, textarea, [contenteditable]')) return;
    const keyboardUp = physicalKeyboardUp();
    if (desktop || keyboardUp !== false) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (document.activeElement === ref.current) ref.current?.blur();
  };
  const draftLocked = conversation.sending || submitting;
  const draftLockedRef = useRef(draftLocked);
  const deferredDraftRef = useRef('');
  const mountedRef = useRef(false);
  const identityRef = useRef(key);
  draftLockedRef.current = draftLocked;
  identityRef.current = key;
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Runtime discovery can briefly omit a live run. App must not cache that stale lease, so this component
  // unmounts; keep only its unsent text under the stable Agent session identity and restore it on remount.
  useEffect(() => {
    draftLockedRef.current = false;
    deferredDraftRef.current = '';
    setSubmitting(false);
    setValue(getConversationDraft(agentId, sessionId));
    setError(null);
    autoGrow(ref.current);
  }, [key]);
  const capabilities = conversation.descriptor?.capabilities;
  const canSend = canSendConversation(capabilities);
  const sendUnavailable = !canSend || conversation.descriptor === null
    || conversation.status === 'loading' || conversation.status === 'reconnecting'
    || conversation.status === 'error';
  const canInterrupt = capabilities?.interrupt === true;
  const currentActivity = activity ?? (busy ? 'working' : 'idle');

  const refreshShortcuts = (): void => {
    setFavs(loadFavs('agent'));
    setLayout(loadShortcutLayout('chat'));
  };
  useEffect(() => { if (!editOpen) refreshShortcuts(); }, [editOpen]);
  const quickReplies = applyShortcutLayout(mergeShortcuts(
    (shortcuts || DEFAULT_SERVER_SHORTCUTS).chat, favs, 'chat',
  ), layout).filter((item) => item.kind !== 'key');

  const insertPaths = (paths: string[]): void => {
    if (!paths.length) return;
    const first = paths[0]!;
    const dir = first.slice(0, first.lastIndexOf('/') + 1);
    const text = paths.length === 1 ? first : paths.every((path) => path.startsWith(dir))
      ? `${dir}{${paths.map((path) => path.slice(dir.length)).join(',')}}`
      : paths.join(' ');
    if (draftLockedRef.current) {
      deferredDraftRef.current = appendConversationDraft(deferredDraftRef.current, text);
      return;
    }
    setValue((current) => {
      const next = current && !/\s$/.test(current) ? `${current} ${text}` : current + text;
      saveDraft(next);
      return next;
    });
    requestAnimationFrame(() => ref.current?.focus());
  };
  const { uploadFiles } = useUpload({
    cwd, onPaths: insertPaths, ...(onAuthFail ? { onAuthFail } : {}),
  });

  const voiceAnchorRef = useRef({ head: '', tail: '' });
  const voice = usePushToTalk({
    mode: voiceMode,
    onText: (text) => {
      const { head, tail } = voiceAnchorRef.current;
      const next = head + text + tail;
      if (draftLockedRef.current) {
        deferredDraftRef.current = appendConversationDraft(deferredDraftRef.current, next);
        return;
      }
      setValue(next);
      saveDraft(next);
    },
  });
  const recording = voice.state === 'recording' || voice.state === 'finalizing';
  const capturing = voice.state === 'recording';
  const recognizing = voice.state === 'finalizing';
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  useScreenWakeLock(recording);
  useEffect(() => {
    if (!recording || draftLockedRef.current) return;
    const { head, tail } = voiceAnchorRef.current;
    const next = head + voice.partial + tail;
    setValue(next);
    saveDraft(next);
  }, [key, recording, voice.partial]);
  const toggleMic = (): void => {
    if (recording) { void voice.stop(); return; }
    if (draftLockedRef.current) return;
    const selection = ref.current?.selectionStart ?? value.length;
    voiceAnchorRef.current = { head: value.slice(0, selection), tail: value.slice(selection) };
    void voice.start();
  };

  const send = async (requestedText = value): Promise<void> => {
    const text = requestedText.trim();
    if (!text || draftLockedRef.current || recordingRef.current) return;
    const sentAgentId = agentId;
    const sentSessionId = sessionId;
    const sentKey = key;
    draftLockedRef.current = true;
    deferredDraftRef.current = '';
    setSubmitting(true);
    setError(null);
    let definitiveFailure = false;
    try {
      if (onSlashCommand && await onSlashCommand(text)) {
        saveDraft('');
        setValue('');
        autoGrow(ref.current);
        return;
      }
      if (!canSend) throw new Error(conversation.error || t('agentConversation.unavailable'));
      onSendStart?.();
      saveDraft('');
      setValue('');
      autoGrow(ref.current);
      await conversation.send(text, { queueHint: currentActivity !== 'idle' });
    } catch (cause) {
      definitiveFailure = !isConversationDeliveryUnknown(cause);
      if (mountedRef.current && identityRef.current === sentKey) {
        setError(cause instanceof ConversationSendError && cause.publicMessage
          ? t(cause.publicMessage === 'sendUnknown' ? 'chat.sendUnknown' : 'chat.sendFailed')
          : cause instanceof Error && cause.message ? cause.message : t('chat.sendFailed'));
      }
    } finally {
      const deferred = deferredDraftRef.current;
      deferredDraftRef.current = '';
      const persisted = getConversationDraft(sentAgentId, sentSessionId);
      const nextDraft = appendConversationDraft(persisted, deferred);
      const restored = definitiveFailure
        ? mergeConversationDraftAfterFailure(text, nextDraft) : nextDraft;
      saveConversationDraft(sentAgentId, sentSessionId, restored);
      if (mountedRef.current && identityRef.current === sentKey) {
        setValue(restored);
        draftLockedRef.current = false;
        setSubmitting(false);
      }
    }
  };
  const interrupt = async (): Promise<void> => {
    setError(null);
    try { await conversation.interrupt(); setStopConfirm(false); }
    catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('chat.stopFailed'));
    }
  };
  useLayoutEffect(() => autoGrow(ref.current), [value]);
  const cardPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!isConversationComposerCardPointerTarget(event.currentTarget, event.target)) return;
    tapRef.current = { x: event.clientX, y: event.clientY, moved: false };
  };
  const cardPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!isConversationComposerCardPointerTarget(event.currentTarget, event.target)) return;
    if (Math.hypot(event.clientX - tapRef.current.x, event.clientY - tapRef.current.y) > 6) {
      tapRef.current.moved = true;
    }
  };
  const cardPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!isConversationComposerCardPointerTarget(event.currentTarget, event.target)) return;
    if (tapRef.current.moved || (event.target instanceof Element
      && event.target.closest('button, input, textarea, [contenteditable]'))) return;
    ref.current?.focus({ preventScroll: true });
  };
  return (
    <div className="chat-composer agent-conversation-composer" onPointerDown={keepComposerFocus}>
      {headerContent}
      <div className="cc-quick quick-scroll">
        {quickReplies.map((item, index) => (
          <button type="button" className="quick-cmd qc-reply"
            key={`${shortcutIdentity(item)}:${index}`}
            disabled={draftLocked || recording || (item.enter === true && sendUnavailable)} onClick={() => {
              if (draftLockedRef.current || recordingRef.current
                || (item.enter === true && sendUnavailable)) return;
              if (item.enter) { void send(item.text); return; }
              setValue(item.text);
              saveDraft(item.text);
              requestAnimationFrame(() => ref.current?.focus());
            }}>{item.text}</button>
        ))}
        <button type="button" className="quick-cmd quick-cmd-add" aria-label={t('chat.editTitle')}
          onClick={() => setEditOpen(true)}><GearIcon /></button>
      </div>
      <input ref={uploadRef} className="browse-file-input" type="file" multiple accept={UPLOAD_ACCEPT}
        disabled={draftLocked}
        onChange={(event) => {
          if (draftLockedRef.current) return;
          const files = Array.from(event.target.files || []);
          event.target.value = '';
          void uploadFiles(files);
        }} />
      {(voice.error || error) && <div className="cc-notice" role="alert">{voice.error || error}</div>}
      <div className={`cc-card${capturing ? ' recording' : ''}${recognizing ? ' recognizing' : ''}`}
        onPointerDown={cardPointerDown} onPointerMove={cardPointerMove} onPointerUp={cardPointerUp}>
        {queueContent}
        <textarea ref={ref} className="cc-text" rows={2} value={value}
          aria-readonly={draftLocked}
          onBeforeInput={(event) => { if (draftLocked) event.preventDefault(); }}
          placeholder={t('chat.composer.placeholder')}
          onChange={(event) => {
            if (draftLockedRef.current) return;
            setValue(event.target.value);
            saveDraft(event.target.value);
            autoGrow(event.target);
          }}
          onKeyDown={(event) => {
            // On phones Enter belongs to the multiline keyboard. Desktop keeps the familiar
            // Enter-to-send / Shift+Enter-to-newline convention used by the mature Chat composer. Escape
            // only releases editor focus; stopping stays on the explicit button.
            if (!desktop || event.nativeEvent.isComposing) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              ref.current?.blur();
              return;
            }
            if (event.key !== 'Enter' || event.shiftKey) return;
            event.preventDefault();
            void send();
          }} />
        <div className="cc-actions">
          <div className="cc-actions-left">
            <button type="button" className="cc-attach" aria-label={t('dock.attach')}
              disabled={draftLocked}
              onClick={() => uploadRef.current?.click()}><PlusIcon /></button>
            {sessionControl}
          </div>
          <div className="cc-actions-right">
            {actionContent}
            {micAvailable && <MicButton active={capturing} recognizing={recognizing}
              waveform level={voice.level}
              disabled={voice.state === 'requesting' || (draftLocked && !recording)}
              onToggle={toggleMic} />}
            {currentActivity === 'working' && canInterrupt && (
              <button type="button" className="cc-send cc-stop" aria-label={t('chat.stop')}
                disabled={conversation.interrupting} onClick={() => setStopConfirm(true)}>
                <StopIcon />
              </button>
            )}
            <button type="button" className="cc-send" aria-label={t('dock.send')}
              disabled={sendUnavailable || draftLocked || recording || !value.trim()}
              onClick={() => { void send(); }}>
              <ArrowUpIcon />
            </button>
          </div>
        </div>
      </div>
      {stopConfirm && (
        <OverlayPortal chatTone={chatTone} keyboardInset={keyboardInset}>
          <div className="settings-confirm-backdrop cc-queue-dialog-backdrop"
            onClick={() => setStopConfirm(false)}>
            <div className="settings-confirm cc-confirm-dialog" role="alertdialog" aria-modal="true"
              aria-label={t('chat.stopTitle')} onClick={(event) => event.stopPropagation()}>
              <h2>{t('chat.stopTitle')}</h2>
              <p>{t('chat.stopBody')}</p>
              <div className="settings-confirm-actions">
                <button type="button" autoFocus disabled={conversation.interrupting}
                  onClick={() => setStopConfirm(false)}>{t('common.cancel')}</button>
                <button type="button" className="danger" disabled={conversation.interrupting}
                  onClick={() => { void interrupt(); }}>{t('chat.stop')}</button>
              </div>
            </div>
          </div>
        </OverlayPortal>
      )}
      {editOpen && <CmdFavEditor variant="chat" presets={(shortcuts || DEFAULT_SERVER_SHORTCUTS).chat}
        onChange={refreshShortcuts} onClose={() => setEditOpen(false)} />}
    </div>
  );
}
