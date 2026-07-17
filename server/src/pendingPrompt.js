// Parse a pending interactive PROMPT (an AskUserQuestion menu — single OR multi-question — or a tool-
// permission menu) out of a Claude Code pane's `capture-pane` text. This is deliberately screen-scraping: a
// pending prompt's options exist ONLY in the rendered TUI — they are NOT written to the session .jsonl until
// AFTER the user answers (verified live), so the transcript can't be the source. Same approach amux/
// VibeTunnel/Conductor use for the "attach to a running TUI" model; there is no structured channel short of
// relaunching Claude via the SDK.
//
// Verified against a live Claude Code (2026-07-17):
//
//  SINGLE question / permission menu:            MULTI-question (tabbed):        REVIEW / submit screen:
//    ☐ 颜色         ← header (optional)             ←  ☒ 水果  ☐ 颜色  ✔ Submit  →   ←  ☒ 水果  ☒ 颜色 ✔ Submit →
//   你喜欢哪个?      ← question                      选个颜色?      ← current tab     Review your answers
//   ❯ 1. 红色       ← ❯ marks the cursor            ❯ 1. 红                          ❯ 1. Submit answers
//        热情、醒目   ← description (optional)          2. 蓝                            2. Cancel
//     2. 蓝色                                       Enter to select · Tab/… · Esc    (NO footer line)
//     4. Type something.  ← built-in meta (dropped)
//   Enter to select · ↑/↓ to navigate · Esc to cancel
//
// Driving (verified live): sending the literal DIGIT of an option selects it. For a SINGLE question it
// selects AND submits immediately; for MULTI it selects AND auto-advances to the next tab; on the review
// screen digit 1 = "Submit answers". So the caller drives the whole flow by sending `String(option.n)` and
// re-polling — each screen (Q1 → Q2 → review) is itself a parseable menu. Escape cancels.
//
// The parser ANCHORS on the ❯ cursor line, NOT a footer: the review screen has options but no footer.

// Cursor-selected option line: ❯ (or ›»>) then "N.".
const CURSOR_RE = /^\s*[❯›»>]\s*\d+\.\s/;
// Any option row: optional cursor, then "N. label".
const OPTION_RE = /^\s*[❯›»>]?\s*(\d+)\.\s+(.+?)\s*$/;
// A description row: indented, not itself an option.
const isDesc = (l) => /^\s{3,}\S/.test(l) && !OPTION_RE.test(l);
// A horizontal rule Claude draws inside/around the card (kept within an option block so meta rows past it
// are still seen and dropped).
const RULE_RE = /^[\s─━—–\-_=·⎯]{8,}$/;
// The multi-question tab strip: "←  ☒ 水果  ☐ 颜色  ✔ Submit  →".
const TAB_BAR_RE = /✔\s*Submit|[☐☒].*[☐☒]/;
// Claude's built-in trailing meta-options — not real answers.
const META_LABELS = new Set(['type something', 'type something.', 'chat about this', 'chat about this.']);
// Leading decoration on the header line.
const HEADER_DECOR_RE = /^[\s☐☑☒◯●○·•\-*]+/;
// A menu footer (single-question / permission), used only as a title boundary — NOT required to detect a menu.
const FOOTER_RE = /enter to select|esc to (cancel|reject)/i;
// A Claude activity/spinner line — the top edge of the card, above which is prior transcript.
const ACTIVITY_RE = /^\s*[✻✳✶✽⏺]\s|worked for|cogitated|crafting|cooked for|crunched for|esc to interrupt/i;
// The input cursor ❯ leading the user's echoed prompt (above the card).
const PROMPT_ECHO_RE = /^\s*[❯›»>]\s*\D/; // ❯ NOT followed by a digit (that would be an option)
const isTitleBoundary = (l) =>
  ACTIVITY_RE.test(l) || RULE_RE.test(l) || TAB_BAR_RE.test(l) || FOOTER_RE.test(l) || PROMPT_ECHO_RE.test(l);

const stripRight = (s) => String(s == null ? '' : s).replace(/\s+$/, '');
// Strip ANSI/OSC escapes so a capture taken WITH `-e` (SGR) still parses — belt-and-suspenders even though
// the endpoint captures plain.
const stripAnsi = (s) => String(s || '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[[0-9;?]*[ -/]*[@-~]/g, '');

// Parse the multi-question tab strip → [{ label, answered }]. ☒ = answered, ☐ = not. "✔ Submit" is excluded.
function parseTabs(line) {
  const tabs = [];
  const re = /([☐☒])\s*(\S+)/g;
  let m;
  while ((m = re.exec(line))) tabs.push({ label: m[2], answered: m[1] === '☒' });
  return tabs;
}

// capture-pane text → a normalized pending prompt, or null when no interactive menu is on screen.
//   { kind:'question'|'permission', title, options:[{n,label,description}], cursor,
//     multi, step, total, submit }
// `n` is the digit to send to pick that option. For multi, `step`/`total` drive the "第 i/N 题" progress and
// `submit` marks the final review screen (options are Submit answers / Cancel).
export function parsePendingPrompt(text) {
  const lines = stripAnsi(text).split('\n').map(stripRight);

  // Anchor on the cursor-selected option (present in every menu: question, permission, review). Take the
  // LAST one so stale menus higher in the scrollback are ignored — the live menu is at the bottom.
  const anchor = lines.findLastIndex((l) => CURSOR_RE.test(l));
  if (anchor < 0) return null;

  // The option block = the contiguous run of option / description / rule lines around the anchor.
  const inBlock = (l) => OPTION_RE.test(l) || isDesc(l) || RULE_RE.test(l);
  let top = anchor;
  let bot = anchor;
  while (top - 1 >= 0 && inBlock(lines[top - 1])) top--;
  while (bot + 1 < lines.length && inBlock(lines[bot + 1])) bot++;

  const options = [];
  let cursor = null;
  for (let i = top; i <= bot; i++) {
    const m = lines[i].match(OPTION_RE);
    if (!m) continue;
    const n = Number(m[1]);
    const label = m[2].trim();
    if (CURSOR_RE.test(lines[i])) cursor = n;
    let description = '';
    for (let j = i + 1; j <= bot; j++) {
      if (OPTION_RE.test(lines[j])) break;
      if (!isDesc(lines[j])) break;
      description += (description ? ' ' : '') + lines[j].trim();
    }
    if (META_LABELS.has(label.toLowerCase())) continue; // drop Claude's built-in meta-options
    options.push({ n, label, description });
  }
  if (!options.length) return null;

  // Title = header/question text above the block, skipping in-card blanks, stopping at the card's top edge.
  const head = [];
  for (let i = top - 1; i >= 0 && head.length < 5; i--) {
    if (!lines[i].trim()) continue;
    if (isTitleBoundary(lines[i])) break;
    head.unshift(lines[i]);
  }
  const title = head.map((l) => l.replace(HEADER_DECOR_RE, '').trim()).filter(Boolean).join(' — ') || '需要你选择';

  // Multi-question: the tab strip drives progress. `answered` ☒ tabs → current step is the next unanswered.
  const tabLine = lines.find((l) => TAB_BAR_RE.test(l));
  const tabs = tabLine ? parseTabs(tabLine) : [];
  const multi = tabs.length > 1;
  const answered = tabs.filter((t) => t.answered).length;
  const submit = /^submit answers?$/i.test(options[0].label) || (multi && answered >= tabs.length);

  const kind = /do you want to proceed/i.test(title) || /^yes\b/i.test(options[0].label)
    ? 'permission' : 'question';

  const out = { kind, title, options, cursor };
  if (multi) {
    out.multi = true;
    out.total = tabs.length;
    out.step = Math.min(answered + 1, tabs.length);
    out.submit = submit;
  }
  return out;
}
