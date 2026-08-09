import { isAllowedKey } from './keyNames.js';

export interface KeyShortcut {
  type: 'key';
  key: string;
  label: string;
}

export interface TextShortcut {
  type: 'text';
  text: string;
  enter: boolean;
}

export type Shortcut = KeyShortcut | TextShortcut;
export interface ShortcutConfig {
  command: Shortcut[];
  chat: Shortcut[];
}

const CTRL_C: Readonly<KeyShortcut> = Object.freeze({ type: 'key', key: 'C-c', label: 'Ctrl+C' });

export const DEFAULT_SHORTCUTS: Readonly<{ command: readonly Shortcut[]; chat: readonly Shortcut[] }> = Object.freeze({
  command: Object.freeze([CTRL_C]),
  chat: Object.freeze([
    CTRL_C,
    Object.freeze({ type: 'key', key: 'Escape', label: 'Esc' }),
    Object.freeze({ type: 'key', key: 'Tab', label: 'Tab' }),
    Object.freeze({ type: 'key', key: 'BSpace', label: '⌫' }),
    Object.freeze({ type: 'text', text: 'ok', enter: true }),
    Object.freeze({ type: 'text', text: 'go on', enter: true }),
    Object.freeze({ type: 'text', text: '1', enter: true }),
    Object.freeze({ type: 'text', text: '2', enter: true }),
    Object.freeze({ type: 'text', text: '3', enter: true }),
    Object.freeze({ type: 'text', text: '/compact', enter: true }),
    Object.freeze({ type: 'text', text: '/clear', enter: true }),
    Object.freeze({ type: 'text', text: '/model', enter: true }),
  ]),
});

const cloneItems = (items: readonly Shortcut[]): Shortcut[] => items.map((item) => ({ ...item }));
const fail = (path: string, message: string): never => { throw new Error(`${path}: ${message}`); };
const isSingleLine = (value: unknown, max: number): value is string => (
  typeof value === 'string' && value.length > 0 && value.length <= max
  && [...value].every((char) => {
    const code = char.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  })
);

export function shortcutIdentity(item: Shortcut): string {
  return item.type === 'key' ? `key:${item.key}` : `text:${item.enter ? 1 : 0}:${item.text}`;
}

function normalizeMode(raw: unknown, mode: 'command' | 'chat'): Shortcut[] {
  const path = `shortcuts.${mode}`;
  if (!Array.isArray(raw)) return fail(path, 'expected an array');
  const seen = new Set<string>();
  return raw.map((candidate, index): Shortcut => {
    const itemPath = `${path}[${index}]`;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return fail(itemPath, 'expected an object');
    const item = candidate as Record<string, unknown>;
    let normalized: Shortcut;
    if (item.type === 'key') {
      const key = item.key;
      const label = item.label;
      if (!isAllowedKey(key)) return fail(`${itemPath}.key`, `unsupported key ${JSON.stringify(key)}`);
      if (label !== undefined && !isSingleLine(label, 80)) {
        return fail(`${itemPath}.label`, 'expected non-empty single-line text');
      }
      if (item.enter !== undefined) return fail(`${itemPath}.enter`, 'not valid for a key shortcut');
      normalized = { type: 'key', key, label: label ?? key };
    } else if (item.type === 'text') {
      const text = item.text;
      const enter = item.enter;
      if (!isSingleLine(text, 500)) return fail(`${itemPath}.text`, 'expected non-empty single-line text');
      if (typeof enter !== 'boolean') return fail(`${itemPath}.enter`, 'expected a boolean');
      normalized = { type: 'text', text, enter };
    } else {
      return fail(`${itemPath}.type`, 'expected "key" or "text"');
    }
    const identity = shortcutIdentity(normalized);
    if (seen.has(identity)) fail(itemPath, 'duplicate shortcut');
    seen.add(identity);
    return normalized;
  });
}

export function normalizeShortcuts(raw: unknown): ShortcutConfig {
  if (raw === undefined) {
    return { command: cloneItems(DEFAULT_SHORTCUTS.command), chat: cloneItems(DEFAULT_SHORTCUTS.chat) };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('shortcuts', 'expected an object');
  const config = raw as Record<string, unknown>;
  return {
    command: config.command === undefined ? cloneItems(DEFAULT_SHORTCUTS.command) : normalizeMode(config.command, 'command'),
    chat: config.chat === undefined ? cloneItems(DEFAULT_SHORTCUTS.chat) : normalizeMode(config.chat, 'chat'),
  };
}
