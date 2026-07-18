// Slash commands known to run INLINE and finish inside the 对话 lens — they print a short result
// (`/cost`, `/status`) or run a normal turn (`/init`) and never open a blocking TUI picker. These STAY in
// chat. Everything else is handed off to the terminal lens on send: an interactive builtin (`/model`,
// `/effort`, `/plugin`, `/agents`, …) OR any command we don't recognize (a new builtin, a plugin command,
// a project's custom command). We deliberately allowlist the safe stay-in-chat commands rather than trying
// to enumerate every interactive one — that list can't be kept complete. Erring toward hand-off is the safe
// failure mode: if the command opens a picker the transcript stays silent and the phone would be stuck with
// no way to drive it; a wrongful hand-off merely lands on the SAME pane's terminal lens, one tap from chat.
export const ONESHOT_SLASH = new Set([
  'clear', 'compact', 'cost', 'status', 'usage', 'context',
  'help', 'init', 'exit', 'quit', 'vim', 'terminal-setup', 'release-notes',
]);

// True when SENDING `text` should hand off to the terminal lens. A BARE slash command that isn't a known
// inline one-shot hands off (it may open a picker only the terminal can show/drive). A command WITH args
// (`/model sonnet`, `/effort xhigh`) applies directly — no picker — so it stays; a non-slash message stays.
export function shouldHandOffSlash(text) {
  const m = /^\s*\/([a-z][\w-]*)\s*(.*)$/i.exec(typeof text === 'string' ? text : '');
  if (!m) return false;
  if (m[2].trim()) return false;             // has args → applies directly, stays in chat
  return !ONESHOT_SLASH.has(m[1].toLowerCase()); // bare + not a known one-shot → hand off to the terminal
}

// The optimistic echo for a chat-staying slash command, or null. Claude Code logs a slash command's
// canonical `<command-name>` scaffold only when the command COMPLETES (verified live — /compact's takes
// the whole 1-2min compaction), so the jsonl-driven 对话 lens shows NOTHING the moment you send it. Echo
// the command pill client-side at send time; the real marker replaces it when the transcript catches up
// (ChatView dedups by name). Handed-off commands return null — the lens switch is their feedback.
export function slashEchoFor(text) {
  const m = /^\s*\/([a-z][\w-]*)\s*(.*)$/i.exec(typeof text === 'string' ? text : '');
  if (!m || shouldHandOffSlash(text)) return null;
  const echo = { name: '/' + m[1] };
  const args = m[2].trim();
  if (args) echo.args = args;
  return echo;
}
