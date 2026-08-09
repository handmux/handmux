export type ShortcutMode = 'command' | 'chat';

export interface ShortcutPresetKey {
  type: 'key';
  key: string;
  label?: string;
}

export interface ShortcutPresetText {
  type: 'text';
  text: string;
  enter?: boolean;
}

export type ShortcutPreset = ShortcutPresetKey | ShortcutPresetText;

export interface ShortcutItem {
  kind: 'key' | 'reply' | 'cmd';
  text: string;
  label?: string;
  enter?: boolean;
  source?: 'config' | 'local';
}

export interface ServerShortcuts {
  command: ShortcutPreset[];
  chat: ShortcutPreset[];
}

export type ShortcutIdentityInput = ShortcutPreset | ShortcutItem;

const CTRL_C: ShortcutPresetKey = { type: 'key', key: 'C-c', label: 'Ctrl+C' };

export const DEFAULT_SERVER_SHORTCUTS: ServerShortcuts = {
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

export function shortcutIdentity(item: ShortcutIdentityInput): string {
  if ('type' in item && item.type === 'key') return `key:${item.key}`;
  if ('kind' in item && item.kind === 'key') return `key:${item.text}`;
  return `text:${item.text}:${item.enter ? 'enter' : 'no-enter'}`;
}

function presetToFav(item: ShortcutPreset, mode: ShortcutMode): ShortcutItem {
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

export function mergeShortcuts(
  presets: readonly ShortcutPreset[],
  locals: readonly ShortcutItem[],
  mode: ShortcutMode,
): ShortcutItem[] {
  const configItems = presets.map((item) => presetToFav(item, mode));
  const configured = new Set(configItems.map(shortcutIdentity));
  const localItems: ShortcutItem[] = locals
    .filter((item) => !configured.has(shortcutIdentity(item)))
    .map((item) => ({ ...item, source: 'local' as const }));
  return [...configItems, ...localItems];
}
