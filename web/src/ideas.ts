// Pure helpers for the per-window idea list. No DOM, no storage — persistence lives in storage.js
// (tw_ideas, keyed by session name + window name) and the UI in components/IdeaPanel.jsx.

// A monotonic-ish id for a new idea: a stable React key + drag handle. Date.now() is fine in the
// browser; the short random tail avoids collisions when two are added inside the same millisecond.
export interface Idea {
  id: string;
  text: string;
}

const genId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function parseIdeas(value: unknown): Idea[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): Idea[] => {
    const idea = candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
      ? candidate as Record<string, unknown> : null;
    return typeof idea?.id === 'string' && idea.id
      && typeof idea.text === 'string' && idea.text.trim()
      ? [{ id: idea.id, text: idea.text }] : [];
  });
}

// Build an idea from raw input; trims and rejects empty (caller ignores a null).
export function newIdea(text: unknown): Idea | null {
  const t = typeof text === 'string' ? text.trim() : '';
  return t ? { id: genId(), text: t } : null;
}

// Move the item at `from` to `to`, returning a NEW array (never mutates). Out-of-range or a no-op
// move returns a shallow copy unchanged, so callers can always treat the result as the new order.
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
