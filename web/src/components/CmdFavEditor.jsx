import { useState, useRef } from 'react';
import { loadFavs, addFav, removeFav, moveFav, updateFav, cmdScope, CMD_GLOBAL } from '../favStore.js';
import { buildChord } from '../keybarKeys.js';
import { XIcon, ChevronDownIcon, PlusIcon, CheckIcon } from './icons.jsx';
import { t } from '../i18n';

// Two list sections — GLOBAL (grey) then THIS WINDOW (green). Add / edit both happen in ONE centred card
// (opened by the header ＋, or by TAPPING a row to edit it), so the panel itself is just a clean, scannable
// list. The card lays its controls out vertically — no cramming onto one row.

// The sticky-key picker is a single-select of the common modifier combos (default: none). Each maps to the
// {ctrl,shift,alt} shape buildChord() wants.
const STICKY_OPTS = [
  { key: 'none', mods: {} },
  { key: 'ctrl', label: 'Ctrl', mods: { ctrl: true } },
  { key: 'shift', label: 'Shift', mods: { shift: true } },
  { key: 'alt', label: 'Alt', mods: { alt: true } },
  { key: 'ctrl-shift', label: 'Ctrl+Shift', mods: { ctrl: true, shift: true } },
  { key: 'ctrl-alt', label: 'Ctrl+Alt', mods: { ctrl: true, alt: true } },
];
const stickyByKey = (key) => STICKY_OPTS.find((o) => o.key === key) || STICKY_OPTS[0];

// The base key is PICKED, never typed (you shouldn't have to know to type "up"/"tab"). Special keys you
// can't type come first, then letters, then digits. Values are what buildChord() expects as its base.
const NAMED_BASE = [
  ['Up', '↑ Up'], ['Down', '↓ Down'], ['Left', '← Left'], ['Right', '→ Right'],
  ['Tab', '⇥ Tab'], ['Enter', '⏎ Enter'], ['Escape', '⎋ Esc'], ['Space', '␣ Space'], ['BSpace', '⌫ Backspace'],
  ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PgUp'], ['PageDown', 'PgDn'],
];
const BASE_KEYS = [
  ...NAMED_BASE.map(([value, label]) => ({ value, label })),
  ...'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => ({ value: c, label: c.toUpperCase() })),
  ...'0123456789'.split('').map((d) => ({ value: d, label: d })),
];

// Reverse a saved key fav back into { sticky, base } so it can be re-edited. Mirrors buildChord(): C-/M-/S-
// prefixes stack in that order; BTab is Shift+Tab; a lone uppercase letter is Shift+<char>. A single-char
// base is lower-cased so it matches the BASE_KEYS option values.
function parseKeyFav(fav) {
  let s = fav.text || '';
  if (s === 'BTab') return { sticky: 'shift', base: 'Tab' };
  let ctrl = false, alt = false, shift = false;
  if (s.startsWith('C-')) { ctrl = true; s = s.slice(2); }
  if (s.startsWith('M-')) { alt = true; s = s.slice(2); }
  if (s.startsWith('S-')) { shift = true; s = s.slice(2); }
  if (!ctrl && !alt && !shift && s.length === 1 && s >= 'A' && s <= 'Z') shift = true;
  const found = STICKY_OPTS.find((o) =>
    !!o.mods.ctrl === ctrl && !!o.mods.shift === shift && !!o.mods.alt === alt);
  return { sticky: found ? found.key : 'none', base: s.length === 1 ? s.toLowerCase() : s };
}

// A self-contained dropdown (no native <select>): a button showing the current option's label (or a
// placeholder), opening a floating option list closed by picking an option or tapping the scrim behind it.
function Dropdown({ value, options, onChange, placeholder }) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.value === value);
  return (
    <div className="cmd-dd">
      <button type="button" className={`cmd-dd-btn${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox" aria-expanded={open}>
        <span className={cur ? undefined : 'cmd-dd-ph'}>{cur ? cur.label : placeholder}</span><ChevronDownIcon />
      </button>
      {open && (
        <>
          <div className="cmd-dd-scrim" onClick={() => setOpen(false)} />
          <div className="cmd-dd-menu" role="listbox">
            {options.map((o) => (
              <button key={o.value} type="button" role="option" aria-selected={o.value === value}
                className={`cmd-dd-opt${o.value === value ? ' on' : ''}`}
                onClick={() => { onChange(o.value); setOpen(false); }}>
                <span>{o.label}</span>
                {o.value === value && <CheckIcon />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// `showTitle` is false for a lone list (chat variant) — a single sticky "常用" header is just redundant
// chrome; command mode keeps it because it distinguishes the 全局 vs 窗口 sections.
function List({ title, accent, items, showTitle = true, onMove, onDel, onEdit }) {
  return (
    <div className={`cmd-esection ${accent}`}>
      {showTitle && <div className={`cmd-section ${accent}`}><span className="cmd-section-name">{title}</span></div>}
      {items.length === 0 && <div className="cmd-empty">{t('cmd.empty')}</div>}
      {items.map((f, i) => (
        <div key={f.text} className="cmd-row">
          {/* Tap the row to re-open the card and edit this item (command or key). */}
          <button type="button" className="cmd-text cmd-fav-text" onClick={() => onEdit(f)}>
            {f.kind === 'key' ? (f.label || f.text) : f.text}
            {f.kind !== 'key' && f.enter && <span className="cmd-enter" aria-hidden="true">⏎</span>}
          </button>
          <button className="cmd-move up" disabled={i === 0} onClick={() => onMove(f.text, -1)}
            aria-label={t('cmd.moveUp')}><ChevronDownIcon /></button>
          <button className="cmd-move" disabled={i === items.length - 1} onClick={() => onMove(f.text, 1)}
            aria-label={t('cmd.moveDown')}><ChevronDownIcon /></button>
          <button className="cmd-del" onClick={() => onDel(f.text)} aria-label={t('common.delete')}><XIcon /></button>
        </div>
      ))}
    </div>
  );
}

function ConfigList({ items }) {
  if (!items.length) return null;
  return (
    <div className="cmd-esection global cmd-config-section">
      <div className="cmd-section global"><span className="cmd-section-name">{t('cmd.configPresets')}</span></div>
      {items.map((item, i) => (
        <div key={`${item.type}:${item.key || item.text}:${i}`} className="cmd-row cmd-config-row">
          <span className="cmd-text">
            {item.type === 'key' ? (item.label || item.key) : item.text}
            {item.type === 'text' && item.enter && <span className="cmd-enter" aria-hidden="true">⏎</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// The add / edit card — its own overlay, mounted only while open. `edit` (a { fav, scope } or null) seeds
// the fields; absent → a blank add form. `scopes` is the list of target lists (1 = no scope picker shown);
// `cfg` carries the per-variant bits (message-tab label/placeholder + whether the 直接发送 toggle applies).
// Lives inside the .app transform that slides up by `inset` when the keyboard opens, so it adds inset/2 back
// to re-centre in the visible area ABOVE the keyboard.
function AddCard({ scopes, cfg, edit, inset, onAdd, onUpdate, onClose }) {
  const seedKey = edit && edit.fav.kind === 'key' ? parseKeyFav(edit.fav) : null;
  const [tab, setTab] = useState(edit ? (edit.fav.kind === 'key' ? 'key' : 'msg') : 'msg');
  const [scopeKey, setScopeKey] = useState(edit ? edit.scope : scopes[0].key);
  const [text, setText] = useState(edit ? (seedKey ? seedKey.base : edit.fav.text) : '');
  const [enter, setEnter] = useState(edit && edit.fav.kind !== 'key' ? !!edit.fav.enter : !!cfg.defaultEnter);
  const [sticky, setSticky] = useState(seedKey ? seedKey.sticky : 'none');
  // NOT auto-focused on open: focusing pops the soft keyboard, which shoves the card up before you've even
  // chosen 消息/命令 vs 按键. The user taps the field when they're ready. (After an add we do refocus, below,
  // so rapid multi-add keeps typing.)
  const inputRef = useRef(null);
  // Switching mode clears the field: a text string and a picked base key don't carry over sensibly.
  const switchTab = (nt) => { if (nt !== tab) { setTab(nt); setText(''); } };
  const stickyDD = STICKY_OPTS.map((o) => ({ value: o.key, label: o.label ?? t('cmd.stickyNone') }));

  const chord = tab === 'key' ? buildChord(stickyByKey(sticky).mods, text) : null;
  const targetScope = scopes.some((s) => s.key === scopeKey) ? scopeKey : scopes[0].key;
  const canSave = tab === 'key' ? !!chord : !!text.trim();

  const submit = () => {
    if (!canSave) return;
    const fav = tab === 'key'
      ? { kind: 'key', text: chord.name, label: chord.label }
      : { kind: cfg.msgKind(text.trim()), text: text.trim(), enter };
    if (edit) { onUpdate(edit.scope, edit.fav.text, targetScope, fav); return; }
    onAdd(targetScope, fav);
    setText('');                                // keep the card open for rapid multi-add
    inputRef.current?.focus();
  };

  return (
    <>
      <div className="cmd-backdrop cmd-add-backdrop" onClick={onClose} />
      <div className="cmd-addcard" role="dialog" aria-label={edit ? t('cmd.editItem') : t('cmd.addTitle')}
        style={{ transform: `translate(-50%, calc(-50% + ${inset / 2}px))` }}>
        <div className="cmd-addcard-head">
          <span className="cmd-title">{edit ? t('cmd.editItem') : t('cmd.addTitle')}</span>
          <button className="cmd-close" onClick={onClose} aria-label={t('common.close')}><XIcon /></button>
        </div>

        {/* message/command vs key — underline text tabs (the card's primary mode switch, set apart from the
            pill segmented control used for scope below). */}
        <div className="cmd-modetabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'msg'}
            className={`cmd-modetab${tab === 'msg' ? ' on' : ''}`} onClick={() => switchTab('msg')}>{cfg.msgLabel}</button>
          <button type="button" role="tab" aria-selected={tab === 'key'}
            className={`cmd-modetab${tab === 'key' ? ' on' : ''}`} onClick={() => switchTab('key')}>{t('cmd.tabKey')}</button>
        </div>

        {/* which list — only when there's more than one target */}
        {scopes.length > 1 && (
          <div className="cmd-field">
            <label className="cmd-field-label">{t('cmd.addTo')}</label>
            <div className="cmd-seg" role="group">
              {scopes.map((s) => (
                <button key={s.key} type="button" aria-pressed={targetScope === s.key}
                  className={`cmd-seg-btn${s.accent === 'win' ? ' win' : ''}${targetScope === s.key ? ' on' : ''}`}
                  onClick={() => setScopeKey(s.key)}>{s.title}</button>
              ))}
            </div>
          </div>
        )}

        {tab === 'key' ? (
          <>
            {/* sticky key + base key — both PICKED from dropdowns, nothing to type */}
            <div className="cmd-field">
              <label className="cmd-field-label">{t('cmd.sticky')}</label>
              <Dropdown value={sticky} options={stickyDD} onChange={setSticky} />
            </div>
            <div className="cmd-field">
              <label className="cmd-field-label">{t('cmd.baseKey')}</label>
              <Dropdown value={text} options={BASE_KEYS} onChange={setText} placeholder={t('cmd.pickKey')} />
              {chord && <span className="cmd-chord-preview">{chord.label}</span>}
            </div>
          </>
        ) : (
          <>
            <div className="cmd-field">
              <label className="cmd-field-label">{cfg.msgLabel}</label>
              <input ref={inputRef} className="cmd-add-input" value={text}
                placeholder={cfg.placeholder}
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
            </div>
            {cfg.hasEnter && (
              <label className="cmd-toggle-row">
                <span>{t('cmd.withEnter')}</span>
                <span className="cmd-switch">
                  <input type="checkbox" checked={enter} onChange={(e) => setEnter(e.target.checked)} />
                  <span className="cmd-switch-track" aria-hidden="true" />
                  <span className="cmd-switch-knob" aria-hidden="true" />
                </span>
              </label>
            )}
          </>
        )}

        <button type="button" className="cmd-submit" disabled={!canSave} onClick={submit}>
          {edit ? t('common.save') : t('fav.add')}</button>
      </div>
    </>
  );
}

// Two variants share the whole editor:
//  • 'command' (default) — command mode: GLOBAL + per-window lists; the message tab saves shell COMMANDs
//    (kind 'cmd') and carries the 直接发送 toggle; the scope picker chooses which list.
//  • 'chat' — agent mode: a single global list; the message tab saves a MESSAGE to the agent (kind derived
//    from the '/' prefix, like the old FavDrawer — a slash-command is 'cmd', anything else a 'reply'); it
//    has an explicit Enter toggle (default on to preserve the old tap-to-send behavior) and no scope picker.
function editorConfig(variant, windowId) {
  if (variant === 'chat') {
    return {
      title: t('chat.editTitle'),
      scopes: [{ key: 'agent', title: t('chat.favs'), accent: 'global' }],
      card: {
        msgLabel: t('chat.tabMsg'),
        placeholder: t('chat.addPlaceholder'),
        hasEnter: true,
        defaultEnter: true,
        msgKind: (txt) => (txt.startsWith('/') ? 'cmd' : 'reply'),
      },
    };
  }
  const winScope = windowId ? cmdScope(windowId) : null;
  return {
    title: t('cmd.editTitle'),
    scopes: [
      { key: CMD_GLOBAL, title: t('cmd.global'), accent: 'global' },
      ...(winScope ? [{ key: winScope, title: t('cmd.window'), accent: 'win' }] : []),
    ],
    card: {
      msgLabel: t('cmd.tabCmd'),
      placeholder: t('cmd.addPlaceholder'),
      hasEnter: true,
      defaultEnter: false,
      msgKind: () => 'cmd',
    },
  };
}

export default function CmdFavEditor({ windowId, inset = 0, variant = 'command', presets = [], onClose }) {
  const { title, scopes, card: cardCfg } = editorConfig(variant, windowId);
  const [items, setItems] = useState(() => Object.fromEntries(scopes.map((s) => [s.key, loadFavs(s.key)])));
  const [card, setCard] = useState(null); // null | { edit: null } (add) | { edit: { fav, scope } }

  const reloadAll = () => setItems(Object.fromEntries(scopes.map((s) => [s.key, loadFavs(s.key)])));
  const doMove = (s, txt, dir) => { moveFav(s, txt, dir); reloadAll(); };
  const doDel = (s, txt) => { removeFav(s, txt); reloadAll(); };
  const doAdd = (s, fav) => { addFav(s, fav); reloadAll(); };
  const doUpdate = (oldScope, oldText, newScope, fav) => {
    if (oldScope === newScope) updateFav(oldScope, oldText, fav);
    else { removeFav(oldScope, oldText); addFav(newScope, fav); }
    reloadAll();
    setCard(null);
  };

  return (
    <>
      <div className="cmd-backdrop" onClick={onClose} />
      <div className="cmd-panel cmd-editor" role="dialog" aria-label={title}>
        <div className="cmd-head">
          <span className="cmd-title">{title}</span>
          <button className="cmd-add-open" onClick={() => setCard({ edit: null })} aria-label={t('cmd.addTitle')}><PlusIcon /></button>
          <button className="cmd-close" onClick={onClose} aria-label={t('common.close')}><XIcon /></button>
        </div>
        <div className="cmd-list">
          <ConfigList items={presets} />
          {scopes.map((s) => (
            <List key={s.key} title={s.title} accent={s.accent} items={items[s.key] || []}
              showTitle={scopes.length > 1 || presets.length > 0}
              onMove={(txt, d) => doMove(s.key, txt, d)} onDel={(txt) => doDel(s.key, txt)}
              onEdit={(f) => setCard({ edit: { fav: f, scope: s.key } })} />
          ))}
        </div>
      </div>
      {card && <AddCard scopes={scopes} cfg={cardCfg} edit={card.edit} inset={inset}
        onAdd={doAdd} onUpdate={doUpdate} onClose={() => setCard(null)} />}
    </>
  );
}
