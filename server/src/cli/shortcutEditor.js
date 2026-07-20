import fs from 'node:fs';
import path from 'node:path';
import { normalizeShortcuts, shortcutIdentity } from '../shortcutConfig.js';
import { t } from './i18n/index.js';
import * as prompts from './prompt.js';
import { acquireLifecycleLock, isAlive, readState } from './state.js';

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

export function moveShortcut(items, index, target) {
  if (index < 0 || target < 0 || index >= items.length || target >= items.length || target === index) return items;
  const next = items.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
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
const moveOptions = (items, index) => {
  const remaining = items.filter((_item, i) => i !== index);
  return items.flatMap((_item, target) => {
    if (target === index) return [];
    if (target === 0) return [{ value: target, label: t('shortcuts.moveFirst') }];
    if (target === items.length - 1) return [{ value: target, label: t('shortcuts.moveLast', { n: items.length }) }];
    return [{ value: target, label: t('shortcuts.moveAfter', { n: target + 1, item: itemLabel(remaining[target - 1]) }) }];
  });
};
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

async function editItem(mode, seed, ui, forcedType = null) {
  const type = forcedType || await ui.ask(ui.select({
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
        { value: 'add-key', label: t('shortcuts.addKey') },
        { value: 'add-text', label: t('shortcuts.addText') },
        { value: 'back', label: t('shortcuts.back') },
      ],
    }));
    if (choice === 'back') return items;
    if (choice === 'add-key' || choice === 'add-text') {
      const item = await editItem(mode, null, ui, choice === 'add-key' ? 'key' : 'text');
      if (!items.some((existing) => shortcutIdentity(existing) === shortcutIdentity(item))) items = [...items, item];
      continue;
    }
    const index = Number(choice.slice(5));
    const action = await ui.ask(ui.select({
      message: itemLabel(items[index]),
      options: [
        { value: 'edit', label: t('shortcuts.edit') },
        ...(items.length > 1 ? [{ value: 'move', label: t('shortcuts.move') }] : []),
        { value: 'delete', label: t('shortcuts.delete') },
        { value: 'back', label: t('shortcuts.back') },
      ],
    }));
    if (action === 'edit') {
      const edited = await editItem(mode, items[index], ui);
      if (!items.some((item, i) => i !== index && shortcutIdentity(item) === shortcutIdentity(edited))) {
        items = items.map((item, i) => i === index ? edited : item);
      }
    } else if (action === 'move') {
      const target = await ui.ask(ui.select({
        message: t('shortcuts.movePrompt'), options: moveOptions(items, index),
      }));
      items = moveShortcut(items, index, target);
    } else if (action === 'delete') items = items.filter((_item, i) => i !== index);
  }
}

export async function runShortcutEditor({
  target, log = console, isTTY = process.stdin.isTTY, ui = defaultUi,
  commit = async (file, shortcuts) => ({ cfg: saveShortcutConfig(file, shortcuts) }),
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
      const result = await commit(target, shortcuts);
      ui.outro(t('shortcuts.wrote', { path: target }));
      return result;
    }
  } catch (error) {
    if (error === prompts.CANCELLED) { ui.cancel(t('shortcuts.exited')); return null; }
    throw error;
  }
}

export async function applyShortcutsLive({
  state, shortcuts, fetchImpl = globalThis.fetch, timeoutMs = 8000,
}) {
  if (!state?.localUrl || !state?.token) throw new Error('running server state is incomplete');
  const base = state.localUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/api/config/shortcuts`, {
      method: 'PUT',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortcuts }),
    });
    if (!response.ok) throw new Error(`server returned HTTP ${response.status}`);
    let acknowledgment;
    try { acknowledgment = await response.json(); } catch { /* validated below */ }
    if (acknowledgment?.ok !== true) throw new Error('invalid server response');
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`server request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Keep the durable write and the runtime replacement in one short cross-process critical section.
// Otherwise two editors can interleave their save/PUT calls and leave disk and memory disagreeing.
export async function commitShortcuts({
  home, target, shortcuts,
  acquireLock = acquireLifecycleLock,
  readStateImpl = readState,
  isAliveImpl = isAlive,
  saveImpl = saveShortcutConfig,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
}) {
  const release = acquireLock(home);
  try {
    const cfg = saveImpl(target, shortcuts);
    const state = readStateImpl(home);
    if (!state || !isAliveImpl(state.supervisorPid)) return { cfg, running: false, applied: false };
    try {
      await applyShortcutsLive({ state, shortcuts: cfg.shortcuts, fetchImpl, timeoutMs });
      return { cfg, running: true, applied: true };
    } catch (error) {
      return { cfg, running: true, applied: false, error };
    }
  } finally {
    release();
  }
}

export function reportShortcutCommit(result, output = console) {
  if (!result.running) return 0;
  if (result.applied) {
    output.log(t('shortcuts.applied'));
    return 0;
  }
  output.error(t('shortcuts.applyFailed', { msg: result.error?.message || 'unknown error' }));
  return 1;
}
