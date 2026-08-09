export type OverlayStackChannel = 'escape' | 'history';

export interface OverlayStackEntry {
  readonly id: number;
  readonly channel: OverlayStackChannel;
  readonly invoke: () => void;
}

let nextOverlayId = 1;
const overlayStack: OverlayStackEntry[] = [];

export function createOverlayStackEntry(
  channel: OverlayStackChannel,
  invoke: () => void,
  id = nextOverlayId++,
): OverlayStackEntry {
  return { id, channel, invoke };
}

export function removeOverlayStackEntry(entry: OverlayStackEntry): void {
  const index = overlayStack.lastIndexOf(entry);
  if (index >= 0) overlayStack.splice(index, 1);
}

export function registerOverlayStackEntry(entry: OverlayStackEntry): () => void {
  removeOverlayStackEntry(entry);
  overlayStack.push(entry);
  return () => removeOverlayStackEntry(entry);
}

export function topOverlayStackEntry(channel: OverlayStackChannel): OverlayStackEntry | null {
  for (let index = overlayStack.length - 1; index >= 0; index -= 1) {
    const entry = overlayStack[index];
    if (entry?.channel === channel) return entry;
  }
  return null;
}

export function overlayStackSize(channel: OverlayStackChannel): number {
  let count = 0;
  for (const entry of overlayStack) if (entry.channel === channel) count += 1;
  return count;
}
