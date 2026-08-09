import { useEffect, useState } from 'react';
import {
  loadFavs, addFavResult, removeFavByIdentity, moveFavBesideByIdentity,
  updateFavResult, transferFavResult,
  cmdScope, CMD_GLOBAL,
} from '../favStore.js';
import { buildChord } from '../keybarKeys.js';
import { mergeShortcuts, shortcutIdentity } from '../shortcutMerge.js';
import {
  applyShortcutLayout, hideShortcutInLayout, loadShortcutLayout, moveShortcutInLayout,
  removeShortcutFromLayout, replaceShortcutInLayout, saveShortcutLayout, showShortcutInLayout,
} from '../shortcutLayout.js';
import { XIcon, ChevronDownIcon, PlusIcon, CheckIcon } from './icons.jsx';
import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';
import type { ModifierId } from '../keybarKeys.js';
import type { StoredFav } from '../favStore.js';
import type { ShortcutItem, ShortcutPreset } from '../shortcutMerge.js';
import type { ShortcutLayout } from '../shortcutLayout.js';

type EditorVariant = 'command' | 'chat';
type ShortcutAccent = 'global' | 'win';
type MessageKind = 'cmd' | 'reply';

interface StickyOption {
  key: string;
  label?: string;
  mods: Partial<Record<ModifierId, boolean>>;
}

interface DropdownOption {
  value: string;
  label: string;
}

interface ShortcutScope {
  key: string;
  title: string;
  accent: ShortcutAccent;
}

interface CardConfig {
  msgLabel: string;
  placeholder: string;
  hasEnter: boolean;
  defaultEnter: boolean;
  msgKind: (text: string) => MessageKind;
}

interface EditorConfig {
  title: string;
  scopes: ShortcutScope[];
  card: CardConfig;
}

interface EditTarget {
  fav: ShortcutItem;
  scope: string;
}

interface EditorActionResult {
  ok: boolean;
  reason?: string;
}

interface EditorCardState {
  edit: EditTarget | null;
}

export interface CmdFavEditorProps {
  windowId?: string | null;
  inset?: number;
  variant?: EditorVariant;
  presets?: ShortcutPreset[];
  onChange?: () => void;
  onClose: () => void;
}

// Two list sections — GLOBAL (grey) then THIS WINDOW (green). Add / edit both happen in ONE centred card
// (opened by the header ＋, or by TAPPING a row to edit it), so the panel itself is just a clean, scannable
// list. The card lays its controls out vertically — no cramming onto one row.

// The sticky-key picker is a single-select of the common modifier combos (default: none). Each maps to the
// {ctrl,shift,alt} shape buildChord() wants.
const STICKY_OPTS: StickyOption[] = [
  { key: 'none', mods: {} },
  { key: 'ctrl', label: 'Ctrl', mods: { ctrl: true } },
  { key: 'shift', label: 'Shift', mods: { shift: true } },
  { key: 'alt', label: 'Alt', mods: { alt: true } },
  { key: 'ctrl-shift', label: 'Ctrl+Shift', mods: { ctrl: true, shift: true } },
  { key: 'ctrl-alt', label: 'Ctrl+Alt', mods: { ctrl: true, alt: true } },
];
const stickyByKey = (key: string): StickyOption => (
  STICKY_OPTS.find((option) => option.key === key) ?? STICKY_OPTS[0]
);

// The base key is PICKED, never typed (you shouldn't have to know to type "up"/"tab"). Special keys you
// can't type come first, then letters, then digits. Values are what buildChord() expects as its base.
const NAMED_BASE: [string, string][] = [
  ['Up', '↑ Up'], ['Down', '↓ Down'], ['Left', '← Left'], ['Right', '→ Right'],
  ['Tab', '⇥ Tab'], ['Enter', '⏎ Enter'], ['Escape', '⎋ Esc'], ['Space', '␣ Space'], ['BSpace', '⌫ Backspace'],
  ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PgUp'], ['PageDown', 'PgDn'],
];
const BASE_KEYS: DropdownOption[] = [
  ...NAMED_BASE.map(([value, label]) => ({ value, label })),
  ...'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => ({ value: c, label: c.toUpperCase() })),
  ...'0123456789'.split('').map((d) => ({ value: d, label: d })),
];

// Reverse a saved key fav back into { sticky, base } so it can be re-edited. Mirrors buildChord(): C-/M-/S-
// prefixes stack in that order; BTab is Shift+Tab; a lone uppercase letter is Shift+<char>. A single-char
// base is lower-cased so it matches the BASE_KEYS option values.
function parseKeyFav(fav: ShortcutItem): { sticky: string; base: string } {
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
interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}

function Dropdown({ value, options, onChange, placeholder }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.value === value);
  useBackButton(open, () => setOpen(false));
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
interface ListProps {
  title: string;
  accent: ShortcutAccent;
  items: ShortcutItem[];
  showTitle?: boolean;
  onMove: (item: ShortcutItem, direction: number) => void;
  onDel: (item: ShortcutItem) => void;
  onEdit: (item: ShortcutItem) => void;
}

function List({ title, accent, items, showTitle = true, onMove, onDel, onEdit }: ListProps) {
  return (
    <div className={`cmd-esection ${accent}`}>
      {showTitle && <div className={`cmd-section ${accent}`}><span className="cmd-section-name">{title}</span></div>}
      {items.length === 0 && <div className="cmd-empty">{t('cmd.empty')}</div>}
      {items.map((f, i) => (
        <div key={shortcutIdentity(f)} className="cmd-row">
          {f.source === 'config'
            ? <span className="cmd-text cmd-fav-text">
              {f.kind === 'key' ? (f.label || f.text) : f.text}
              {f.kind !== 'key' && f.enter && <span className="cmd-enter" aria-hidden="true">⏎</span>}
            </span>
            : <button type="button" className="cmd-text cmd-fav-text" onClick={() => onEdit(f)}>
              {f.kind === 'key' ? (f.label || f.text) : f.text}
              {f.kind !== 'key' && f.enter && <span className="cmd-enter" aria-hidden="true">⏎</span>}
            </button>}
          <button className="cmd-move up" disabled={i === 0} onClick={() => onMove(f, -1)}
            aria-label={t('cmd.moveUp')}><ChevronDownIcon /></button>
          <button className="cmd-move" disabled={i === items.length - 1} onClick={() => onMove(f, 1)}
            aria-label={t('cmd.moveDown')}><ChevronDownIcon /></button>
          <button className="cmd-del" onClick={() => onDel(f)}
            aria-label={t(f.source === 'config' ? 'cmd.removeDevice' : 'common.delete')}><XIcon /></button>
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
interface AddCardProps {
  scopes: ShortcutScope[];
  cfg: CardConfig;
  edit: EditTarget | null;
  inset: number;
  onAdd: (scope: string, fav: ShortcutItem) => EditorActionResult;
  onUpdate: (
    oldScope: string,
    oldFav: ShortcutItem,
    newScope: string,
    fav: ShortcutItem,
  ) => EditorActionResult;
  onClose: () => void;
}

function AddCard({ scopes, cfg, edit, inset, onAdd, onUpdate, onClose }: AddCardProps) {
  const seedKey = edit && edit.fav.kind === 'key' ? parseKeyFav(edit.fav) : null;
  const [tab, setTab] = useState<'key' | 'msg'>(
    edit ? (edit.fav.kind === 'key' ? 'key' : 'msg') : 'msg',
  );
  const [scopeKey, setScopeKey] = useState(edit ? edit.scope : scopes[0].key);
  const [text, setText] = useState(edit ? (seedKey ? seedKey.base : edit.fav.text) : '');
  const [enter, setEnter] = useState(edit && edit.fav.kind !== 'key' ? !!edit.fav.enter : !!cfg.defaultEnter);
  const [sticky, setSticky] = useState(seedKey ? seedKey.sticky : 'none');
  const [error, setError] = useState<string | null>(null);
  // NOT auto-focused on open: focusing pops the soft keyboard, which shoves the card up before you've even
  // chosen 消息/命令 vs 按键. The user taps the field when they're ready.
  // Switching mode clears the field: a text string and a picked base key don't carry over sensibly.
  const switchTab = (nextTab: 'key' | 'msg'): void => {
    if (nextTab !== tab) { setTab(nextTab); setText(''); setError(null); }
  };
  const stickyDD = STICKY_OPTS.map((o) => ({ value: o.key, label: o.label ?? t('cmd.stickyNone') }));

  const chord = tab === 'key' ? buildChord(stickyByKey(sticky).mods, text) : null;
  const targetScope = scopes.some((s) => s.key === scopeKey) ? scopeKey : scopes[0].key;
  const canSave = tab === 'key' ? !!chord : !!text.trim();

  const submit = (): void => {
    if (!canSave || (tab === 'key' && !chord)) return;
    const fav: ShortcutItem = tab === 'key'
      ? { kind: 'key', text: chord!.name, label: chord!.label }
      : { kind: cfg.msgKind(text.trim()), text: text.trim(), enter };
    const result = edit
      ? onUpdate(edit.scope, edit.fav, targetScope, fav)
      : onAdd(targetScope, fav);
    if (!result?.ok) { setError(t('cmd.itemConflict')); return; }
    setError(null);
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
                  onClick={() => { setScopeKey(s.key); setError(null); }}>{s.title}</button>
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
              <input className="cmd-add-input" value={text}
                placeholder={cfg.placeholder}
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
                onChange={(e) => { setText(e.target.value); setError(null); }}
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

        {error && <div className="cmd-add-error" role="status">{error}</div>}

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
function editorConfig(variant: EditorVariant, windowId?: string | null): EditorConfig {
  if (variant === 'chat') {
    return {
      title: t('chat.editTitle'),
      scopes: [{ key: 'agent', title: t('chat.favs'), accent: 'global' }],
      card: {
        msgLabel: t('chat.tabMsg'),
        placeholder: t('chat.addPlaceholder'),
        hasEnter: true,
        defaultEnter: true,
        msgKind: (text: string) => (text.startsWith('/') ? 'cmd' : 'reply'),
      },
    };
  }
  const winScope = windowId ? cmdScope(windowId) : null;
  const scopes: ShortcutScope[] = [
    { key: CMD_GLOBAL, title: t('cmd.global'), accent: 'global' },
    ...(winScope ? [{ key: winScope, title: t('cmd.window'), accent: 'win' as const }] : []),
  ];
  return {
    title: t('cmd.editTitle'),
    scopes,
    card: {
      msgLabel: t('cmd.tabCmd'),
      placeholder: t('cmd.addPlaceholder'),
      hasEnter: true,
      defaultEnter: false,
      msgKind: () => 'cmd' as const,
    },
  };
}

export default function CmdFavEditor({
  windowId, inset = 0, variant = 'command', presets = [], onChange, onClose,
}: CmdFavEditorProps) {
  const { title, scopes, card: cardCfg } = editorConfig(variant, windowId);
  const [items, setItems] = useState<Record<string, StoredFav[]>>(
    () => Object.fromEntries(scopes.map((scope) => [scope.key, loadFavs(scope.key)])),
  );
  const [card, setCard] = useState<EditorCardState | null>(null);
  const layoutMode = variant === 'chat' ? 'chat' : 'command';
  const globalScope = scopes[0].key;
  const [layout, setLayout] = useState(() => loadShortcutLayout(layoutMode));
  const [undo, setUndo] = useState<{ identity: string } | null>(null);
  const [addedNotice, setAddedNotice] = useState(0);
  const mergedGlobal = applyShortcutLayout(
    mergeShortcuts(presets, items[globalScope] || [], layoutMode), layout,
  );
  const visibleGlobalIds = new Set(mergedGlobal.map(shortcutIdentity));
  const conflictsWithEffectiveGlobal = (
    identity: string,
    oldScope: string | null = null,
    oldFav: ShortcutItem | null = null,
  ): boolean =>
    mergedGlobal.some((item) => shortcutIdentity(item) === identity
      && !(oldScope === globalScope && item.source === 'local'
        && oldFav !== null && shortcutIdentity(item) === shortcutIdentity(oldFav)));

  const reloadAll = (): void => setItems(
    Object.fromEntries(scopes.map((scope) => [scope.key, loadFavs(scope.key)])),
  );
  const persistLayout = (next: ShortcutLayout): ShortcutLayout => {
    const saved = saveShortcutLayout(layoutMode, next);
    setLayout(saved);
    onChange?.();
    return saved;
  };
  useEffect(() => {
    if (!undo) return undefined;
    const timer = setTimeout(() => setUndo(null), 4000);
    return () => clearTimeout(timer);
  }, [undo]);
  useEffect(() => {
    if (!addedNotice) return undefined;
    const timer = setTimeout(() => setAddedNotice(0), 2000);
    return () => clearTimeout(timer);
  }, [addedNotice]);
  useBackButton(!!card, () => setCard(null));
  const finishAdd = (): void => {
    reloadAll();
    setUndo(null);
    setCard(null);
    setAddedNotice((version) => version + 1);
  };
  const doMove = (
    scope: string,
    item: ShortcutItem,
    dir: number,
    visible: ShortcutItem[],
  ): void => {
    if (scope === globalScope) {
      persistLayout(moveShortcutInLayout(layout, mergedGlobal, shortcutIdentity(item), dir));
    } else {
      const i = visible.findIndex((fav) => shortcutIdentity(fav) === shortcutIdentity(item));
      const neighbour = visible[i + (dir < 0 ? -1 : 1)];
      if (!neighbour) return;
      moveFavBesideByIdentity(scope, shortcutIdentity(item), shortcutIdentity(neighbour));
      reloadAll();
      onChange?.();
    }
  };
  const doDel = (scope: string, item: ShortcutItem): void => {
    setAddedNotice(0);
    const identity = shortcutIdentity(item);
    if (item.source === 'config') {
      persistLayout(hideShortcutInLayout(layout, mergedGlobal, identity));
      setUndo({ identity });
      return;
    }
    removeFavByIdentity(scope, identity);
    if (scope === globalScope) persistLayout(removeShortcutFromLayout(layout, identity));
    else onChange?.();
    reloadAll();
  };
  const doUndo = (): void => {
    if (!undo) return;
    persistLayout(showShortcutInLayout(layout, undo.identity));
    setUndo(null);
  };
  const doAdd = (scope: string, fav: ShortcutItem): EditorActionResult => {
    const identity = shortcutIdentity(fav);
    if (conflictsWithEffectiveGlobal(identity)) return { ok: false, reason: 'conflict' };
    const exactPreset = mergeShortcuts(presets, [], layoutMode)
      .some((item) => shortcutIdentity(item) === identity);
    const exactLocal = (items[scope] || []).some((item) => shortcutIdentity(item) === identity);
    if (scope === globalScope && layout.hidden.includes(identity) && (exactPreset || exactLocal)) {
      persistLayout(showShortcutInLayout(layout, identity));
      finishAdd();
      return { ok: true };
    }
    const result = addFavResult(scope, fav);
    if (!result.ok) return result;
    if (scope === globalScope) persistLayout(showShortcutInLayout(layout, shortcutIdentity(fav)));
    else onChange?.();
    finishAdd();
    return { ok: true };
  };
  const doUpdate = (
    oldScope: string,
    oldFav: ShortcutItem,
    newScope: string,
    fav: ShortcutItem,
  ): EditorActionResult => {
    const oldIdentity = shortcutIdentity(oldFav);
    const newIdentity = shortcutIdentity(fav);
    if (conflictsWithEffectiveGlobal(newIdentity, oldScope, oldFav)) {
      return { ok: false, reason: 'conflict' };
    }
    const result = oldScope === newScope
      ? updateFavResult(oldScope, oldIdentity, fav)
      : transferFavResult(oldScope, oldIdentity, newScope, fav);
    if (!result.ok) return result;
    if (oldScope === globalScope && newScope === globalScope) {
      persistLayout(replaceShortcutInLayout(layout, oldIdentity, newIdentity));
    } else if (oldScope === globalScope) {
      persistLayout(removeShortcutFromLayout(layout, oldIdentity));
    } else if (newScope === globalScope) {
      persistLayout(showShortcutInLayout(layout, newIdentity));
    } else {
      onChange?.();
    }
    reloadAll();
    setCard(null);
    return result;
  };

  return (
    <>
      <div className="cmd-backdrop" onClick={onClose} />
      <div className="cmd-panel cmd-editor" role="dialog" aria-label={title}>
        <div className="cmd-head">
          <span className="cmd-title">{title}</span>
          <button className="cmd-add-open" onClick={() => { setAddedNotice(0); setCard({ edit: null }); }} aria-label={t('cmd.addTitle')}><PlusIcon /></button>
          <button className="cmd-close" onClick={onClose} aria-label={t('common.close')}><XIcon /></button>
        </div>
        <div className="cmd-list">
          {scopes.map((scope) => {
            const visible = scope.key === globalScope
              ? mergedGlobal
              : mergeShortcuts([], items[scope.key] || [], 'command')
                .filter((item) => !visibleGlobalIds.has(shortcutIdentity(item)));
            return <List key={scope.key} title={scope.title} accent={scope.accent} items={visible}
              showTitle={scopes.length > 1}
              onMove={(item, direction) => doMove(scope.key, item, direction, visible)}
              onDel={(item) => doDel(scope.key, item)}
              onEdit={(item) => { setAddedNotice(0); setCard({ edit: { fav: item, scope: scope.key } }); }} />;
          })}
        </div>
        {undo && <div className="cmd-undo-toast" role="status">
          <span>{t('cmd.removedDevice')}</span>
          <button type="button" className="cmd-undo" onClick={doUndo}>{t('common.undo')}</button>
        </div>}
        {!!addedNotice && <div className="cmd-undo-toast cmd-added-toast" role="status">
          {t('cmd.added')}
        </div>}
      </div>
      {card && <AddCard scopes={scopes} cfg={cardCfg} edit={card.edit} inset={inset}
        onAdd={doAdd} onUpdate={doUpdate} onClose={() => setCard(null)} />}
    </>
  );
}
