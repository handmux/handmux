// The 对话 lens's FALLBACK gate. The real gate reads the pane's on-screen menu (usePendingPrompt + PromptGate)
// and renders its actual options. This fallback is only used when Claude is blocked on a permission
// (kind==='permission') but the menu couldn't be scraped/parsed yet (a transient capture, or an unfamiliar
// prompt shape) — so the user is never left with no way to act. It degrades to the old generic 允许/拒绝,
// which drive the menu's default Yes (Enter) / cancel (Escape).
//
// NOTE: options are NOT read from the transcript here — a pending prompt's options aren't written to the
// .jsonl until AFTER it's answered (verified live), which is exactly why the old transcript-based gate could
// only ever show 允许/拒绝. See server/src/pendingPrompt.js.
export interface FallbackGate {
  prompt: string;
  options: Array<{ label: string; keys: string[] }>;
}

export function fallbackGate(): FallbackGate {
  return {
    prompt: '需要你确认',
    options: [
      { label: '允许', keys: ['Enter'] },
      { label: '拒绝', keys: ['Escape'] },
    ],
  };
}
