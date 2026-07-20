import fs from 'node:fs';
import path from 'node:path';
import { normalizeShortcuts, shortcutIdentity } from '../shortcutConfig.js';
import { t } from './i18n/index.js';
import * as prompts from './prompt.js';

const MODIFIERS = {
  none: { prefixes: [], labels: [] },
  ctrl: { prefixes: ['C-'], labels: ['Ctrl'] },
  shift: { prefixes: ['S-'], labels: ['Shift'] },
  alt: { prefixes: ['M-'], labels: ['Alt'] },
  'ctrl-shift': { prefixes: ['C-', 'S-'], labels: ['Ctrl', 'Shift'] },
  'ctrl-alt': { prefixes: ['C-', 'M-'], labels: ['Ctrl', 'Alt'] },
};
const NAMED_BASES = ['Up', 'Down', 'Left', 'Right', 'Tab', 'Enter', 'Escape', 'Space', 'BSpace', 'Home', 'End', 'PageUp', 'PageDown'];
const CHAR_BASES = [...'abcdefghijklmnopqrstuvwxyz', ...'0123456789'];
const DISPLAY = { Escape: 'Esc', BSpace: '⌫', PageUp: 'PgUp', PageDown: 'PgDn' };

export function buildShortcutKey(modifier, base) {
  const mod = MODIFIERS[modifier];
  if (!mod) throw new Error(`unknown modifier: ${modifier}`);
  if (!NAMED_BASES.includes(base) && !CHAR_BASES.includes(base)) throw new Error(`unsupported base key: ${base}`);
  if (CHAR_BASES.includes(base) && modifier === 'none') throw new Error('a character key needs a modifier');
  if (CHAR_BASES.includes(base) && mod.prefixes.includes('S-')) throw new Error('Shift + character is not a distinct tmux key');
  const key = base === 'Tab' && modifier === 'shift'
    ? 'BTab'
    : `${mod.prefixes.join('')}${CHAR_BASES.includes(base) ? base.toLowerCase() : base}`;
  const shownBase = CHAR_BASES.includes(base) ? base.toUpperCase() : (DISPLAY[base] || base);
  return { type: 'key', key, label: [...mod.labels, shownBase].join('+') };
}

export function moveShortcut(items, index, direction) {
  const target = index + (direction < 0 ? -1 : 1);
  if (index < 0 || target < 0 || index >= items.length || target >= items.length) return items;
  const next = items.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function readExisting(target) {
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export function saveShortcutConfig(target, shortcuts) {
  const existing = readExisting(target);
  const cfg = { ...existing, shortcuts: normalizeShortcuts(shortcuts) };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
  return cfg;
}

const defaultUi = {
  intro: prompts.intro,
  outro: prompts.outro,
  cancel: prompts.cancel,
  select: prompts.select,
  text: prompts.text,
  confirm: prompts.confirm,
  ask: prompts.ask,
};

const modeLabel = (mode) => t(mode === 'command' ? 'shortcuts.command' : 'shortcuts.chat');
const itemLabel = (item) => item.type === 'key' ? item.label : item.text;
const itemHint = (item) => item.type === 'key'
  ? t('shortcuts.key')
  : t(item.enter ? 'shortcuts.textEnter' : 'shortcuts.textOnly');
const validateText = (value) => {
  if (typeof value !== 'string' || !value.length || /[\r\n\x00-\x1f\x7f]/.test(value)) return t('shortcuts.badText');
  return undefined;
};

function parseShortcutKey(item) {
  if (!item || item.type !== 'key') return { modifier: 'none', base: 'Escape' };
  if (item.key === 'BTab') return { modifier: 'shift', base: 'Tab' };
  let key = item.key;
  const ctrl = key.startsWith('C-'); if (ctrl) key = key.slice(2);
  const alt = key.startsWith('M-'); if (alt) key = key.slice(2);
  const shift = key.startsWith('S-'); if (shift) key = key.slice(2);
  const modifier = ctrl && alt ? 'ctrl-alt' : ctrl && shift ? 'ctrl-shift'
    : ctrl ? 'ctrl' : alt ? 'alt' : shift ? 'shift' : 'none';
  return { modifier, base: key };
}

const modifierOptions = () => Object.entries(MODIFIERS).map(([value, item]) => ({
  value, label: item.labels.length ? item.labels.join('+') : t('shortcuts.noModifier'),
}));
const baseOptions = (modifier) => {
  const allowChars = modifier !== 'none' && !MODIFIERS[modifier].prefixes.includes('S-');
  return [...NAMED_BASES, ...(allowChars ? CHAR_BASES : [])].map((value) => ({
    value, label: DISPLAY[value] || value.toUpperCase?.() || value,
  }));
};

async function editItem(mode, seed, ui) {
  const type = await ui.ask(ui.select({
    message: t('shortcuts.type'), initialValue: seed?.type || 'text',
    options: [
      { value: 'text', label: t('shortcuts.text') },
      { value: 'key', label: t('shortcuts.key') },
    ],
  }));
  if (type === 'text') {
    const text = await ui.ask(ui.text({
      message: t('shortcuts.textPrompt'), initialValue: seed?.type === 'text' ? seed.text : '', validate: validateText,
    }));
    const enter = await ui.ask(ui.confirm({
      message: t('shortcuts.enter'), initialValue: seed?.type === 'text' ? seed.enter : mode === 'chat',
    }));
    return { type: 'text', text, enter };
  }
  const parsed = parseShortcutKey(seed);
  const modifier = await ui.ask(ui.select({
    message: t('shortcuts.modifier'), initialValue: parsed.modifier, options: modifierOptions(),
  }));
  const available = baseOptions(modifier);
  const base = await ui.ask(ui.select({
    message: t('shortcuts.base'),
    initialValue: available.some((option) => option.value === parsed.base) ? parsed.base : available[0].value,
    options: available,
  }));
  return buildShortcutKey(modifier, base);
}

async function editMode(mode, initial, ui) {
  let items = initial.slice();
  for (;;) {
    const choice = await ui.ask(ui.select({
      message: modeLabel(mode),
      options: [
        ...items.map((item, index) => ({ value: `item:${index}`, label: itemLabel(item), hint: itemHint(item) })),
        { value: 'add', label: t('shortcuts.add') },
        { value: 'back', label: t('shortcuts.back') },
      ],
    }));
    if (choice === 'back') return items;
    if (choice === 'add') {
      const item = await editItem(mode, null, ui);
      if (!items.some((existing) => shortcutIdentity(existing) === shortcutIdentity(item))) items = [...items, item];
      continue;
    }
    const index = Number(choice.slice(5));
    const action = await ui.ask(ui.select({
      message: itemLabel(items[index]),
      options: [
        { value: 'edit', label: t('shortcuts.edit') },
        ...(index > 0 ? [{ value: 'up', label: t('shortcuts.up') }] : []),
        ...(index < items.length - 1 ? [{ value: 'down', label: t('shortcuts.down') }] : []),
        { value: 'delete', label: t('shortcuts.delete') },
        { value: 'back', label: t('shortcuts.back') },
      ],
    }));
    if (action === 'edit') {
      const edited = await editItem(mode, items[index], ui);
      if (!items.some((item, i) => i !== index && shortcutIdentity(item) === shortcutIdentity(edited))) {
        items = items.map((item, i) => i === index ? edited : item);
      }
    } else if (action === 'up') items = moveShortcut(items, index, -1);
    else if (action === 'down') items = moveShortcut(items, index, 1);
    else if (action === 'delete') items = items.filter((_item, i) => i !== index);
  }
}

export async function runShortcutEditor({
  target, running = false, log = console, isTTY = process.stdin.isTTY, ui = defaultUi,
} = {}) {
  if (!isTTY) { log.error(t('shortcuts.needTty')); return { error: 'non-tty' }; }
  const existing = readExisting(target);
  let shortcuts = normalizeShortcuts(existing.shortcuts);
  ui.intro('handmux shortcuts');
  try {
    for (;;) {
      const choice = await ui.ask(ui.select({
        message: t('shortcuts.title'),
        options: [
          { value: 'command', label: modeLabel('command'), hint: t('shortcuts.count', { n: shortcuts.command.length }) },
          { value: 'chat', label: modeLabel('chat'), hint: t('shortcuts.count', { n: shortcuts.chat.length }) },
          { value: 'save', label: t('shortcuts.save') },
          { value: 'exit', label: t('shortcuts.exit') },
        ],
      }));
      if (choice === 'exit') { ui.cancel(t('shortcuts.exited')); return null; }
      if (choice === 'command' || choice === 'chat') {
        shortcuts = { ...shortcuts, [choice]: await editMode(choice, shortcuts[choice], ui) };
        continue;
      }
      let restart = false;
      if (running) {
        try { restart = await ui.ask(ui.confirm({ message: t('shortcuts.restart'), initialValue: true })); }
        catch (error) { if (error !== prompts.CANCELLED) throw error; }
      }
      const cfg = saveShortcutConfig(target, shortcuts);
      ui.outro(t('shortcuts.wrote', { path: target }));
      return { cfg, restart };
    }
  } catch (error) {
    if (error === prompts.CANCELLED) { ui.cancel(t('shortcuts.exited')); return null; }
    throw error;
  }
}
