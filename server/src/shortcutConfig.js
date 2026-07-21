import { isAllowedKey } from './keyNames.js';

const CTRL_C = Object.freeze({ type: 'key', key: 'C-c', label: 'Ctrl+C' });

export const DEFAULT_SHORTCUTS = Object.freeze({
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

const cloneItems = (items) => items.map((item) => ({ ...item }));
const fail = (path, message) => { throw new Error(`${path}: ${message}`); };
const isSingleLine = (value, max) => (
  typeof value === 'string' && value.length > 0 && value.length <= max
  && [...value].every((char) => {
    const code = char.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  })
);

export function shortcutIdentity(item) {
  return item.type === 'key' ? `key:${item.key}` : `text:${item.enter ? 1 : 0}:${item.text}`;
}

function normalizeMode(raw, mode) {
  const path = `shortcuts.${mode}`;
  if (!Array.isArray(raw)) fail(path, 'expected an array');
  const seen = new Set();
  return raw.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(itemPath, 'expected an object');
    let normalized;
    if (item.type === 'key') {
      if (!isAllowedKey(item.key)) fail(`${itemPath}.key`, `unsupported key ${JSON.stringify(item.key)}`);
      if (item.label !== undefined && !isSingleLine(item.label, 80)) {
        fail(`${itemPath}.label`, 'expected non-empty single-line text');
      }
      if (item.enter !== undefined) fail(`${itemPath}.enter`, 'not valid for a key shortcut');
      normalized = { type: 'key', key: item.key, label: item.label ?? item.key };
    } else if (item.type === 'text') {
      if (!isSingleLine(item.text, 500)) fail(`${itemPath}.text`, 'expected non-empty single-line text');
      if (typeof item.enter !== 'boolean') fail(`${itemPath}.enter`, 'expected a boolean');
      normalized = { type: 'text', text: item.text, enter: item.enter };
    } else {
      fail(`${itemPath}.type`, 'expected "key" or "text"');
    }
    const identity = shortcutIdentity(normalized);
    if (seen.has(identity)) fail(itemPath, 'duplicate shortcut');
    seen.add(identity);
    return normalized;
  });
}

export function normalizeShortcuts(raw) {
  if (raw === undefined) {
    return { command: cloneItems(DEFAULT_SHORTCUTS.command), chat: cloneItems(DEFAULT_SHORTCUTS.chat) };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('shortcuts', 'expected an object');
  return {
    command: raw.command === undefined ? cloneItems(DEFAULT_SHORTCUTS.command) : normalizeMode(raw.command, 'command'),
    chat: raw.chat === undefined ? cloneItems(DEFAULT_SHORTCUTS.chat) : normalizeMode(raw.chat, 'chat'),
  };
}
