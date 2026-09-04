import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getIdeas as loadIdeas, setIdeas as saveIdeas } from '../storage.js';
import { newIdea, moveItem } from '../ideas.js';
import { usePushToTalk } from '../voice/usePushToTalk.js';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock.js';
import MicButton from './MicButton.jsx';
import { PlusIcon, CheckIcon } from './icons.jsx';
import { t } from '../i18n';
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react';
import { parseIdeas } from '../ideas.js';
import type { Idea } from '../ideas.js';
import type { AsrMode } from '../voice/usePushToTalk.js';

interface IdeaPanelProps {
  open: boolean;
  session: string;
  window: string;
  onClose: () => void;
  onSend?: (text: string) => void;
  onCountChange?: (count: number) => void;
  micAvailable?: boolean;
  voiceMode?: AsrMode;
}

type DragState = { active: false } | { active: true; pointerId: number; id: string };

// Per-window idea list (a lightweight todo). A bottom sheet like CommandPanel — it rides above the
// soft keyboard via the .app transform, so no inset prop. One compose box at the top doubles as add
// AND edit (tapping a row's text loads it in, button flips 添加→保存); rows drag-reorder by their
// ≡ handle (pointer events only, see the project's KeyBar note on touch+mouse double-fire). 发送 fills
// the bottom input box (never sends); ✕ deletes. The compose box supports the app's push-to-talk mic.
export default function IdeaPanel({
  open, session, window: win, onClose, onSend, onCountChange, micAvailable = false,
  voiceMode = 'streaming',
}: IdeaPanelProps) {
  const [list, setList] = useState<Idea[]>([]);
  const [value, setValue] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Voice: anchor at the caret on start, write partial/final there, with the iOS focus guard.
  const anchorRef = useRef({ head: '', tail: '' });
  const caretRef = useRef<number | null>(null);
  const suppressVoiceRef = useRef(false);
  const dragRef = useRef<DragState>({ active: false });

  const persist = (next: Idea[]): void => {
    saveIdeas(session, win, next); setList(next); onCountChange?.(next.length);
  };

  // Grow the compose box to fit content (CSS max-height caps it, then it scrolls) — so multi-line
  // ideas show as you type/dictate. +2 for the border under box-sizing: border-box.
  const autoGrow = (element: HTMLTextAreaElement | null): void => {
    if (element) { element.style.height = 'auto'; element.style.height = `${element.scrollHeight + 2}px`; }
  };

  // (Re)load this window's ideas each time the sheet opens or the window changes; reset the compose box.
  useEffect(() => {
    if (!open) return undefined;
    const loaded = parseIdeas(loadIdeas(session, win));
    setList(loaded);
    onCountChange?.(loaded.length);
    setValue('');
    setEditingId(null);
  }, [open, session, win]);

  const commitVoice = (text: string): void => {
    if (suppressVoiceRef.current) { suppressVoiceRef.current = false; return; }
    const { head, tail } = anchorRef.current;
    setValue(head + text + tail);
    caretRef.current = head.length + text.length;
  };
  const voice = usePushToTalk({ onText: commitVoice, mode: voiceMode });
  const recording = voice.state === 'recording' || voice.state === 'finalizing';
  const capturing = voice.state === 'recording';
  const recognizing = voice.state === 'finalizing';
  useScreenWakeLock(recording);

  // Live partial → write at the anchor while recording (unless a send already suppressed write-back).
  useEffect(() => {
    if (voice.state !== 'recording' && voice.state !== 'finalizing') return;
    if (suppressVoiceRef.current) return;
    const { head, tail } = anchorRef.current;
    setValue(head + voice.partial + tail);
    caretRef.current = head.length + voice.partial.length;
  }, [voice.partial, voice.state]);

  // Restore the caret after a programmatic value change — but ONLY when the box is truly focused
  // (setSelectionRange on an unfocused input traps it as activeElement without a keyboard; see BottomDock).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    autoGrow(el); // resize for the new content (typing, voice, or loading a row to edit)
    if (caretRef.current == null) return;
    const pos = caretRef.current; caretRef.current = null;
    if (document.activeElement === el) { try { el.setSelectionRange(pos, pos); } catch {} }
  }, [value]);

  const toggleMic = (): void => {
    if (recording) { void voice.stop(); return; }
    const el = inputRef.current;
    const sel = el ? el.selectionStart : value.length;
    anchorRef.current = { head: value.slice(0, sel), tail: value.slice(sel) };
    void voice.start();
  };
  const stopVoiceIfRecording = (): void => {
    if (recording) { suppressVoiceRef.current = true; void voice.stop(); }
  };

  // Add (or save an edit). Empty text is ignored; voice mid-record is stopped + suppressed first.
  const submit = (): void => {
    stopVoiceIfRecording();
    const text = value.trim();
    if (!text) return;
    if (editingId) {
      persist(list.map((it) => (it.id === editingId ? { ...it, text } : it)));
    } else {
      const idea = newIdea(text);
      if (idea) persist([...list, idea]);
    }
    setValue('');
    setEditingId(null);
  };

  const startEdit = (idea: Idea): void => {
    setEditingId(idea.id);
    setValue(idea.text);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const cancelEdit = (): void => { setEditingId(null); setValue(''); };

  const remove = (id: string): void => {
    persist(list.filter((it) => it.id !== id));
    if (id === editingId) cancelEdit();
  };

  // Drag-reorder by the ≡ handle. setPointerCapture redirects move/up to the handle, so the pointer
  // can roam over other rows; we compute the target slot from each row's mid-line and reorder live.
  const onHandleDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string): void => {
    if (event.cancelable) event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { active: true, pointerId: event.pointerId, id };
    setDragId(id);
  };
  const onHandleMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = dragRef.current;
    if (!d.active || event.pointerId !== d.pointerId) return;
    const rows = event.currentTarget.closest('.idea-list')?.querySelectorAll<HTMLElement>('[data-idea]');
    if (!rows || !rows.length) return;
    const y = event.clientY;
    let to = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const row = rows.item(i);
      if (!row) continue;
      const r = row.getBoundingClientRect();
      if (y < r.top + r.height / 2) { to = i; break; }
    }
    setList((cur) => {
      const from = cur.findIndex((it) => it.id === d.id);
      if (from < 0 || from === to) return cur; // same ref → React bails, no churn
      return moveItem(cur, from, to);
    });
  };
  const onHandleUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = dragRef.current;
    if (!d.active || event.pointerId !== d.pointerId) return;
    dragRef.current = { active: false };
    setDragId(null);
    setList((cur) => { saveIdeas(session, win, cur); return cur; });
  };

  if (!open) return null;
  const editing = editingId != null;
  return (
    <>
      <div className="cmd-backdrop" onClick={onClose} />
      <div className="idea-panel" role="dialog" aria-label={t('idea.title')}>
        <div className="cmd-head">
          <span className="cmd-title">{t('idea.title')}{win ? ` · ${win}` : ''}{list.length > 0 && <span className="idea-head-count">{list.length}</span>}</span>
          <button className="cmd-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>

        <div className={`idea-compose${capturing ? ' recording' : ''}${recognizing ? ' recognizing' : ''}`}>
          <textarea
            ref={inputRef}
            className="idea-input"
            rows={1}
            placeholder={editing ? t('idea.editPlaceholder') : t('idea.addPlaceholder')}
            value={value}
            readOnly={recording}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setValue(event.target.value)}
          />
          {editing && <button className="idea-cancel" onClick={cancelEdit}>{t('common.cancel')}</button>}
          {micAvailable && <MicButton active={capturing} recognizing={recognizing}
            waveform={voiceMode === 'sentence'} level={voice.level}
            disabled={voice.state === 'requesting'} onToggle={toggleMic} />}
          <button className="idea-act" onClick={submit} disabled={!value.trim()} aria-label={editing ? t('common.save') : t('idea.add')}>
            {editing ? <CheckIcon /> : <PlusIcon />}
          </button>
        </div>

        <div className="idea-list">
          {list.length === 0 ? (
            <div className="cmd-empty">{t('idea.empty')}</div>
          ) : list.map((idea) => (
            <div
              key={idea.id}
              data-idea={idea.id}
              className={`idea-row${idea.id === dragId ? ' dragging' : ''}${idea.id === editingId ? ' editing' : ''}`}
            >
              <button
                type="button"
                className="idea-handle"
                aria-label={t('idea.dragSort')}
                onPointerDown={(e) => onHandleDown(e, idea.id)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
              >≡</button>
              <span className="idea-text" onClick={() => startEdit(idea)}>{idea.text}</span>
              <button className="idea-send" onClick={() => onSend?.(idea.text)} aria-label={t('idea.fillInput')}>{t('idea.send')}</button>
              <button className="idea-del" onClick={() => remove(idea.id)} aria-label={t('common.delete')}>✕</button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
