import { useRef, useState } from 'react';
import { loadFavs, addFav, removeFav } from '../favStore.js';
import { XIcon, CopyIcon } from './icons.jsx';
import { t } from '../i18n';

export interface FavDrawerProps {
  open: boolean;
  mode: 'command' | 'agent';
  recent?: string[];
  onSend: (text: string) => void;
  onFill: (text: string) => void;
  onClose: () => void;
  onDelete?: (text: string) => void;
  historyOnly?: boolean;
}

const copyText = (text: string): void => {
  try { void navigator.clipboard?.writeText(text); } catch { /* clipboard blocked */ }
};

// Bottom drawer. Two shapes:
//  • default — the 常用 editor for the current mode (reply chips + command rows + add/delete).
//  • historyOnly — REAL history: just the list of things sent through the composer (recent), tap to
//    re-send / double-tap to fill. No 常用 (those live in the chat page's quick-command strip now).
export default function FavDrawer({
  open,
  mode,
  recent = [],
  onSend,
  onFill,
  onClose,
  onDelete,
  historyOnly = false,
}: FavDrawerProps) {
  const [items, setItems] = useState(() => loadFavs(mode));
  // Uncontrolled adder: read the field via a ref so the value survives a raw programmatic set (React's
  // controlled value-tracker would otherwise swallow synthetic input events).
  const inputRef = useRef<HTMLInputElement>(null);
  // Reload when the mode changes (drawer is remounted per open in BottomDock, but guard anyway).
  const [seenMode, setSeenMode] = useState(mode);
  if (seenMode !== mode) { setSeenMode(mode); setItems(loadFavs(mode)); }
  if (!open) return null;

  const replies = historyOnly ? [] : items.filter((f) => f.kind === 'reply');
  const cmds = historyOnly ? [] : items.filter((f) => f.kind === 'cmd');
  const add = () => {
    const text = (inputRef.current?.value || '').trim();
    if (!text) return;
    const kind = mode === 'agent' && !text.startsWith('/') ? 'reply' : 'cmd';
    setItems(addFav(mode, { kind, text }));
    if (inputRef.current) inputRef.current.value = '';
  };
  const del = (text: string): void => setItems(removeFav(mode, text));

  return (
    <>
      <div className="cmd-backdrop" onClick={onClose} />
      <div className={`cmd-panel${historyOnly ? ' history' : ''}`} role="dialog" aria-label={t('fav.title')}>
        <div className="cmd-head">
          <span className="cmd-title">{historyOnly ? t('dock.history') : t('fav.title')}</span>
          <button className="cmd-close" onClick={onClose} aria-label={t('common.close')}><XIcon /></button>
        </div>
        <div className="cmd-list">
          {historyOnly && <div className="cmd-hint">{t('history.scope')}</div>}
          {replies.length > 0 && (
            <div className="fav-chips">
              {replies.map((f) => (
                <span key={f.text} className="fav-chip"
                  onClick={() => onSend(f.text)} onContextMenu={(e) => { e.preventDefault(); del(f.text); }}>{f.text}</span>
              ))}
            </div>
          )}
          {cmds.map((f) => (
            <div key={f.text} className="cmd-row">
              <span className="cmd-text" onClick={() => onSend(f.text)} onDoubleClick={() => onFill(f.text)}>{f.text}</span>
              <button className="cmd-del" onClick={() => del(f.text)} aria-label={t('common.delete')}><XIcon /></button>
            </div>
          ))}
          {recent.map((cmd) => (
            <div key={`r:${cmd}`} className="cmd-row">
              <span className="cmd-text" onClick={() => onSend(cmd)} onDoubleClick={() => onFill(cmd)}>{cmd}</span>
              <button className="cmd-copy" onClick={() => copyText(cmd)} aria-label={t('common.copy')}><CopyIcon /></button>
              {onDelete && (
                <button className="cmd-del" onClick={() => onDelete(cmd)} aria-label={t('common.delete')}><XIcon /></button>
              )}
            </div>
          ))}
          {historyOnly && recent.length === 0 && <div className="cmd-empty">{t('history.empty')}</div>}
          {!historyOnly && (
            <div className="fav-add">
              <input ref={inputRef} className="fav-add-input" placeholder={t('fav.addPlaceholder')}
                onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
              <button className="fav-add-btn" onClick={add}>{t('fav.add')}</button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
