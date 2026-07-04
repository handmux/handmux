import { useState } from 'react';
import { loadFavs, addFav, removeFav, moveFav, cmdScope, CMD_GLOBAL } from '../favStore.js';
import { XIcon, ChevronDownIcon } from './icons.jsx';
import { t } from '../i18n';

// The command-mode 常用命令 editor: a taller bottom sheet (opened by the ⚙ in the command quick-bar) with
// TWO sections — GLOBAL (grey, shown first everywhere) and THIS WINDOW (green, keyed by window id). Each
// section reorders with ▲▼ and adds via an input + a 「带回车」toggle: a with-Enter command TYPES + runs
// (shows a trailing ⏎), a without-Enter one just types into the shell. Reuses the .cmd-* sheet chrome.
function Section({ scope, title, accent }) {
  const [items, setItems] = useState(() => loadFavs(scope));
  const [text, setText] = useState('');
  const [enter, setEnter] = useState(false); // sticky across adds — a run of commands often shares it

  const add = () => {
    const v = text.trim();
    if (!v) return;
    setItems(addFav(scope, { kind: 'cmd', text: v, enter }));
    setText(''); // keep the enter choice for the next add
  };
  const del = (name) => setItems(removeFav(scope, name));
  const move = (name, dir) => setItems(moveFav(scope, name, dir));

  return (
    <div className={`cmd-esection ${accent}`}>
      <div className={`cmd-section ${accent}`}><span className="cmd-section-name">{title}</span></div>
      {items.length === 0 && <div className="cmd-empty">{t('cmd.empty')}</div>}
      {items.map((f, i) => (
        <div key={f.text} className="cmd-row">
          <span className="cmd-text cmd-fav-text">
            {f.text}{f.enter && <span className="cmd-enter" aria-hidden="true">⏎</span>}
          </span>
          <button className="cmd-move up" disabled={i === 0} onClick={() => move(f.text, -1)}
            aria-label={t('cmd.moveUp')}><ChevronDownIcon /></button>
          <button className="cmd-move" disabled={i === items.length - 1} onClick={() => move(f.text, 1)}
            aria-label={t('cmd.moveDown')}><ChevronDownIcon /></button>
          <button className="cmd-del" onClick={() => del(f.text)} aria-label={t('common.delete')}><XIcon /></button>
        </div>
      ))}
      <div className="cmd-add">
        <input className="fav-add-input" value={text} placeholder={t('cmd.addPlaceholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <label className="cmd-enter-opt">
          <input type="checkbox" checked={enter} onChange={(e) => setEnter(e.target.checked)} />
          {t('cmd.withEnter')}
        </label>
        <button className="fav-add-btn" onClick={add}>{t('fav.add')}</button>
      </div>
    </div>
  );
}

export default function CmdFavEditor({ open, windowId, onClose }) {
  if (!open) return null;
  return (
    <>
      <div className="cmd-backdrop" onClick={onClose} />
      <div className="cmd-panel cmd-editor" role="dialog" aria-label={t('cmd.editTitle')}>
        <div className="cmd-head">
          <span className="cmd-title">{t('cmd.editTitle')}</span>
          <button className="cmd-close" onClick={onClose} aria-label={t('common.close')}><XIcon /></button>
        </div>
        <div className="cmd-list">
          <Section scope={CMD_GLOBAL} title={t('cmd.global')} accent="global" />
          {windowId && <Section scope={cmdScope(windowId)} title={t('cmd.window')} accent="win" />}
        </div>
      </div>
    </>
  );
}
