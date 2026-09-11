import { normalizeShortcuts, shortcutIdentity } from '../shortcutConfig.js';
import { t } from './i18n/index.js';
import * as prompts from './prompt.js';
import { acquireLifecycleLock, isAlive, readState } from './state.js';
import { PrivateStateStore } from '../privateStateStore.js';
import type { KeyShortcut, Shortcut, ShortcutConfig } from '../shortcutConfig.js';

const MODIFIERS = {
  none: { prefixes: [], labels: [] },
  ctrl: { prefixes: ['C-'], labels: ['Ctrl'] },
  shift: { prefixes: ['S-'], labels: ['Shift'] },
  alt: { prefixes: ['M-'], labels: ['Alt'] },
  'ctrl-shift': { prefixes: ['C-', 'S-'], labels: ['Ctrl', 'Shift'] },
  'ctrl-alt': { prefixes: ['C-', 'M-'], labels: ['Ctrl', 'Alt'] },
} as const;
const NAMED_BASES: readonly string[] = ['Up', 'Down', 'Left', 'Right', 'Tab', 'Enter', 'Escape', 'Space', 'BSpace', 'Home', 'End', 'PageUp', 'PageDown'];
const CHAR_BASES: readonly string[] = [...'abcdefghijklmnopqrstuvwxyz', ...'0123456789'];
const DISPLAY: Readonly<Record<string, string>> = { Escape: 'Esc', BSpace: '⌫', PageUp: 'PgUp', PageDown: 'PgDn' };

type ShortcutMode = keyof ShortcutConfig;
type Modifier = keyof typeof MODIFIERS;
type PromptValue = string | number;
interface PromptOption { value: PromptValue; label: string; hint?: string }
interface SelectPrompt { message: string; initialValue?: PromptValue; options: PromptOption[] }
interface TextPrompt { message: string; initialValue?: string; validate?: (value: unknown) => string | undefined }
interface ConfirmPrompt { message: string; initialValue?: boolean }
interface ShortcutUi {
  intro(message: string): unknown;
  outro(message: string): unknown;
  cancel(message: string): unknown;
  select(options: SelectPrompt): unknown;
  text(options: TextPrompt): unknown;
  confirm(options: ConfirmPrompt): unknown;
  ask(prompt: unknown): Promise<unknown>;
}
export interface SavedConfig extends Record<string, unknown> { shortcuts: ShortcutConfig }
export interface ShortcutEditorResult { cfg: SavedConfig }
interface ShortcutLog { error(message: string): unknown }
interface ShortcutEditorOptions<TResult extends ShortcutEditorResult = ShortcutEditorResult> {
  target: string;
  log?: ShortcutLog;
  isTTY?: boolean;
  ui?: ShortcutUi;
  commit?: (file: string, shortcuts: ShortcutConfig) => Promise<TResult>;
  running?: unknown;
}
interface FetchResponse { ok: boolean; status: number; json?(): Promise<unknown> }
type FetchImpl = (url: string, options: RequestInit) => Promise<FetchResponse>;
interface ShortcutServerState { localUrl: string; token: string }
export interface ShortcutCommitResult extends ShortcutEditorResult {
  cfg: SavedConfig;
  running: boolean;
  applied: boolean;
  error?: unknown;
}
interface ReportOutput { log(message: string): unknown; error(message: string): unknown }

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const requireString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`invalid ${label}`);
  return value;
};
const requireBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`invalid ${label}`);
  return value;
};
const requirePosition = (value: unknown, length: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= length) {
    throw new Error('invalid shortcut position');
  }
  return value;
};

export function buildShortcutKey(modifierInput: unknown, baseInput: unknown): KeyShortcut {
  const modifier = requireString(modifierInput, 'shortcut modifier') as Modifier;
  const base = requireString(baseInput, 'shortcut base');
  const mod = MODIFIERS[modifier];
  if (!mod) throw new Error(`unknown modifier: ${modifier}`);
  if (!NAMED_BASES.includes(base) && !CHAR_BASES.includes(base)) throw new Error(`unsupported base key: ${base}`);
  if (CHAR_BASES.includes(base) && modifier === 'none') throw new Error('a character key needs a modifier');
  if (CHAR_BASES.includes(base) && mod.prefixes.some((prefix) => prefix === 'S-')) {
    throw new Error('Shift + character is not a distinct tmux key');
  }
  const key = base === 'Tab' && modifier === 'shift'
    ? 'BTab'
    : `${mod.prefixes.join('')}${CHAR_BASES.includes(base) ? base.toLowerCase() : base}`;
  const shownBase = CHAR_BASES.includes(base) ? base.toUpperCase() : (DISPLAY[base] || base);
  return { type: 'key', key, label: [...mod.labels, shownBase].join('+') };
}

export function moveShortcut<T>(items: readonly T[], index: number, target: number): T[] {
  if (!Number.isInteger(index) || !Number.isInteger(target)
    || index < 0 || target < 0 || index >= items.length || target >= items.length || target === index) {
    return items.slice();
  }
  const next = items.slice();
  const [item] = next.splice(index, 1);
  if (item === undefined) return items.slice();
  next.splice(target, 0, item);
  return next;
}

function readExisting(target: string): Record<string, unknown> {
  const value = new PrivateStateStore<unknown>(target).readStrict();
  return recordOf(value) ?? {};
}

export function saveShortcutConfig(target: string, shortcuts: unknown): SavedConfig {
  const existing = readExisting(target);
  const cfg = { ...existing, shortcuts: normalizeShortcuts(shortcuts) };
  new PrivateStateStore<SavedConfig>(target).write(cfg);
  return cfg;
}

const defaultUi = {
  intro: prompts.intro,
  outro: prompts.outro,
  cancel: prompts.cancel,
  select: prompts.select,
  text: prompts.text,
  confirm: prompts.confirm,
  ask: (prompt: unknown) => prompts.ask(prompt as Promise<unknown | symbol>),
} as unknown as ShortcutUi;

const modeLabel = (mode: ShortcutMode): string => t(mode === 'command' ? 'shortcuts.command' : 'shortcuts.chat');
const itemLabel = (item: Shortcut): string => item.type === 'key' ? item.label : item.text;
const itemHint = (item: Shortcut): string => item.type === 'key'
  ? t('shortcuts.key')
  : t(item.enter ? 'shortcuts.textEnter' : 'shortcuts.textOnly');
const positionOptions = (items: readonly Shortcut[], index: number | null = null): PromptOption[] => {
  const remaining = index === null ? items : items.filter((_item, i) => i !== index);
  const count = remaining.length + 1;
  if (remaining.length === 0) return [{ value: 0, label: t('shortcuts.positionLast', { n: 1 }) }];
  return Array.from({ length: count }, (_item, target) => {
    if (target === 0) return { value: target, label: t('shortcuts.positionFirst') };
    if (target === count - 1) return { value: target, label: t('shortcuts.positionLast', { n: count }) };
    const previous = remaining[target - 1];
    if (!previous) throw new Error('invalid shortcut position');
    return {
      value: target,
      label: t('shortcuts.positionAfter', { n: target + 1, item: itemLabel(previous) }),
    };
  });
};
const validateText = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.length || /[\r\n\x00-\x1f\x7f]/.test(value)) return t('shortcuts.badText');
  return undefined;
};

function parseShortcutKey(item: Shortcut | null): { modifier: Modifier; base: string } {
  if (!item || item.type !== 'key') return { modifier: 'none', base: 'Escape' };
  if (item.key === 'BTab') return { modifier: 'shift', base: 'Tab' };
  let key = item.key;
  const ctrl = key.startsWith('C-'); if (ctrl) key = key.slice(2);
  const alt = key.startsWith('M-'); if (alt) key = key.slice(2);
  const shift = key.startsWith('S-'); if (shift) key = key.slice(2);
  const modifier: Modifier = ctrl && alt ? 'ctrl-alt' : ctrl && shift ? 'ctrl-shift'
    : ctrl ? 'ctrl' : alt ? 'alt' : shift ? 'shift' : 'none';
  return { modifier, base: key };
}

const modifierOptions = (): PromptOption[] => Object.entries(MODIFIERS).map(([value, item]) => ({
  value, label: item.labels.length ? item.labels.join('+') : t('shortcuts.noModifier'),
}));
const baseOptions = (modifier: Modifier): PromptOption[] => {
  const allowChars = modifier !== 'none'
    && !MODIFIERS[modifier].prefixes.some((prefix) => prefix === 'S-');
  return [...NAMED_BASES, ...(allowChars ? CHAR_BASES : [])].map((value) => ({
    value, label: DISPLAY[value] || value.toUpperCase?.() || value,
  }));
};

async function editItem(
  mode: ShortcutMode,
  seed: Shortcut | null,
  ui: ShortcutUi,
  forcedType: Shortcut['type'] | null = null,
): Promise<Shortcut> {
  const type = forcedType || requireString(await ui.ask(ui.select({
    message: t('shortcuts.type'), initialValue: seed?.type || 'text',
    options: [
      { value: 'text', label: t('shortcuts.text') },
      { value: 'key', label: t('shortcuts.key') },
    ],
  })), 'shortcut type');
  if (type !== 'text' && type !== 'key') throw new Error('invalid shortcut type');
  if (type === 'text') {
    const text = requireString(await ui.ask(ui.text({
      message: t('shortcuts.textPrompt'), initialValue: seed?.type === 'text' ? seed.text : '', validate: validateText,
    })), 'shortcut text');
    if (validateText(text)) throw new Error('invalid shortcut text');
    const enter = requireBoolean(await ui.ask(ui.confirm({
      message: t('shortcuts.enter'), initialValue: seed?.type === 'text' ? seed.enter : mode === 'chat',
    })), 'shortcut enter value');
    return { type: 'text', text, enter };
  }
  const parsed = parseShortcutKey(seed);
  const modifier = requireString(await ui.ask(ui.select({
    message: t('shortcuts.modifier'), initialValue: parsed.modifier, options: modifierOptions(),
  })), 'shortcut modifier') as Modifier;
  if (!(modifier in MODIFIERS)) throw new Error('invalid shortcut modifier');
  const available = baseOptions(modifier);
  const base = requireString(await ui.ask(ui.select({
    message: t('shortcuts.base'),
    initialValue: available.some((option) => option.value === parsed.base)
      ? parsed.base : (available[0]?.value ?? 'Escape'),
    options: available,
  })), 'shortcut base');
  return buildShortcutKey(modifier, base);
}

async function editMode(mode: ShortcutMode, initial: readonly Shortcut[], ui: ShortcutUi): Promise<Shortcut[]> {
  let items = initial.slice();
  for (;;) {
    const choice = requireString(await ui.ask(ui.select({
      message: modeLabel(mode),
      options: [
        ...items.map((item, index) => ({ value: `item:${index}`, label: itemLabel(item), hint: itemHint(item) })),
        { value: 'add-key', label: t('shortcuts.addKey') },
        { value: 'add-text', label: t('shortcuts.addText') },
        { value: 'back', label: t('shortcuts.back') },
      ],
    })), 'shortcut menu choice');
    if (choice === 'back') return items;
    if (choice === 'add-key' || choice === 'add-text') {
      const item = await editItem(mode, null, ui, choice === 'add-key' ? 'key' : 'text');
      if (!items.some((existing) => shortcutIdentity(existing) === shortcutIdentity(item))) {
        const target = requirePosition(await ui.ask(ui.select({
          message: t('shortcuts.addPositionPrompt'), options: positionOptions(items),
        })), items.length + 1);
        items = moveShortcut([...items, item], items.length, target);
      }
      continue;
    }
    const itemMatch = /^item:(\d+)$/.exec(choice);
    if (!itemMatch) throw new Error('invalid shortcut menu choice');
    const index = Number(itemMatch[1]);
    if (!Number.isInteger(index) || index < 0 || index >= items.length) throw new Error('invalid shortcut item');
    const selectedItem = items[index];
    if (!selectedItem) throw new Error('invalid shortcut item');
    const action = requireString(await ui.ask(ui.select({
      message: itemLabel(selectedItem),
      options: [
        { value: 'edit', label: t('shortcuts.edit') },
        ...(items.length > 1 ? [{ value: 'move', label: t('shortcuts.move') }] : []),
        { value: 'delete', label: t('shortcuts.delete') },
        { value: 'back', label: t('shortcuts.back') },
      ],
    })), 'shortcut action');
    if (!['edit', 'move', 'delete', 'back'].includes(action)) throw new Error('invalid shortcut action');
    if (action === 'edit') {
      const edited = await editItem(mode, selectedItem, ui);
      if (!items.some((item, i) => i !== index && shortcutIdentity(item) === shortcutIdentity(edited))) {
        items = items.map((item, i) => i === index ? edited : item);
      }
    } else if (action === 'move') {
      const target = requirePosition(await ui.ask(ui.select({
        message: t('shortcuts.movePrompt', { n: index + 1 }), options: positionOptions(items, index),
      })), items.length);
      items = moveShortcut(items, index, target);
    } else if (action === 'delete') items = items.filter((_item, i) => i !== index);
  }
}

export function runShortcutEditor(
  options: ShortcutEditorOptions<ShortcutCommitResult> & {
    commit: (file: string, shortcuts: ShortcutConfig) => Promise<ShortcutCommitResult>;
  },
): Promise<ShortcutCommitResult | { error: 'non-tty' } | null>;
export function runShortcutEditor(
  options: ShortcutEditorOptions,
): Promise<ShortcutEditorResult | { error: 'non-tty' } | null>;
export async function runShortcutEditor({
  target, log = console, isTTY = process.stdin.isTTY, ui = defaultUi,
  commit,
}: ShortcutEditorOptions): Promise<ShortcutEditorResult | { error: 'non-tty' } | null> {
  if (!isTTY) { log.error(t('shortcuts.needTty')); return { error: 'non-tty' }; }
  const existing = readExisting(target);
  let shortcuts = normalizeShortcuts(existing.shortcuts);
  ui.intro('handmux shortcuts');
  try {
    for (;;) {
      const choice = requireString(await ui.ask(ui.select({
        message: t('shortcuts.title'),
        options: [
          { value: 'command', label: modeLabel('command'), hint: t('shortcuts.count', { n: shortcuts.command.length }) },
          { value: 'chat', label: modeLabel('chat'), hint: t('shortcuts.count', { n: shortcuts.chat.length }) },
          { value: 'save', label: t('shortcuts.save') },
          { value: 'exit', label: t('shortcuts.exit') },
        ],
      })), 'shortcut mode');
      if (choice === 'exit') { ui.cancel(t('shortcuts.exited')); return null; }
      if (choice === 'command' || choice === 'chat') {
        shortcuts = { ...shortcuts, [choice]: await editMode(choice, shortcuts[choice], ui) };
        continue;
      }
      if (choice !== 'save') throw new Error('invalid shortcut mode');
      const result = commit
        ? await commit(target, shortcuts)
        : { cfg: saveShortcutConfig(target, shortcuts) };
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
}: {
  state: unknown;
  shortcuts: ShortcutConfig;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}): Promise<void> {
  const stateRecord = recordOf(state);
  if (typeof stateRecord?.localUrl !== 'string' || !stateRecord.localUrl
    || typeof stateRecord.token !== 'string' || !stateRecord.token) {
    throw new Error('running server state is incomplete');
  }
  const validState: ShortcutServerState = { localUrl: stateRecord.localUrl, token: stateRecord.token };
  const base = validState.localUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/api/config/shortcuts`, {
      method: 'PUT',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${validState.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortcuts }),
    });
    if (!response.ok) throw new Error(`server returned HTTP ${response.status}`);
    let acknowledgment: unknown;
    try { acknowledgment = await response.json?.(); } catch { /* validated below */ }
    if (recordOf(acknowledgment)?.ok !== true) throw new Error('invalid server response');
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
}: {
  home: string;
  target: string;
  shortcuts: unknown;
  acquireLock?: (home: string) => () => void;
  readStateImpl?: (home: string) => unknown;
  isAliveImpl?: (pid: unknown) => boolean;
  saveImpl?: (target: string, shortcuts: unknown) => SavedConfig;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}): Promise<ShortcutCommitResult> {
  const release = acquireLock(home);
  try {
    const cfg = saveImpl(target, shortcuts);
    const state = recordOf(readStateImpl(home));
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

export function reportShortcutCommit(
  result: Pick<ShortcutCommitResult, 'running' | 'applied' | 'error'>,
  output: ReportOutput = console,
): number {
  if (!result.running) return 0;
  if (result.applied) {
    output.log(t('shortcuts.applied'));
    return 0;
  }
  output.error(t('shortcuts.applyFailed', { msg: result.error ? errorMessage(result.error) : 'unknown error' }));
  return 1;
}
