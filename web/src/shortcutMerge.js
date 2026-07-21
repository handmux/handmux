const CTRL_C = { type: 'key', key: 'C-c', label: 'Ctrl+C' };

export const DEFAULT_SERVER_SHORTCUTS = {
  command: [{ ...CTRL_C }],
  chat: [
    { ...CTRL_C },
    { type: 'key', key: 'Escape', label: 'Esc' },
    { type: 'key', key: 'Tab', label: 'Tab' },
    { type: 'key', key: 'BSpace', label: '⌫' },
    { type: 'text', text: 'ok', enter: true },
    { type: 'text', text: 'go on', enter: true },
    { type: 'text', text: '1', enter: true },
    { type: 'text', text: '2', enter: true },
    { type: 'text', text: '3', enter: true },
    { type: 'text', text: '/compact', enter: true },
    { type: 'text', text: '/clear', enter: true },
    { type: 'text', text: '/model', enter: true },
  ],
};

export function shortcutIdentity(item) {
  if (item.type === 'key' || item.kind === 'key') return `key:${item.key || item.text}`;
  return `text:${item.text}:${item.enter ? 'enter' : 'no-enter'}`;
}

function presetToFav(item, mode) {
  if (item.type === 'key') {
    return { kind: 'key', text: item.key, label: item.label || item.key, source: 'config' };
  }
  return {
    kind: mode === 'chat' && !item.text.startsWith('/') ? 'reply' : 'cmd',
    text: item.text,
    enter: !!item.enter,
    source: 'config',
  };
}

export function mergeShortcuts(presets, locals, mode) {
  const configItems = (Array.isArray(presets) ? presets : []).map((item) => presetToFav(item, mode));
  const configured = new Set(configItems.map(shortcutIdentity));
  const localItems = (Array.isArray(locals) ? locals : [])
    .filter((item) => !configured.has(shortcutIdentity(item)))
    .map((item) => ({ ...item, source: 'local' }));
  return [...configItems, ...localItems];
}
