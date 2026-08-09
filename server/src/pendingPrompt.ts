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
const isDesc = (line: string): boolean => /^\s{3,}\S/.test(line) && !OPTION_RE.test(line);
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
const isTitleBoundary = (line: string): boolean =>
  ACTIVITY_RE.test(line) || RULE_RE.test(line) || TAB_BAR_RE.test(line) || FOOTER_RE.test(line) || PROMPT_ECHO_RE.test(line);

const stripRight = (value: unknown): string => String(value == null ? '' : value).replace(/\s+$/, '');
// Strip ANSI/OSC escapes so a capture taken WITH `-e` (SGR) still parses — belt-and-suspenders even though
// the endpoint captures plain.
const stripAnsi = (value: unknown): string => String(value || '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[[0-9;?]*[ -/]*[@-~]/g, '');

// The assistant text immediately PRECEDING the menu, scraped because the turn (text + AskUserQuestion) is NOT
// flushed to the session jsonl until AFTER the user answers (verified live: probe + out-of-order line
// timestamps) — so the 对话 lens's transcript view structurally can't show it while the gate is up. The title
// walk below stops at the first boundary (activity spinner / box rule / prompt echo), which is exactly where
// the lead-in text usually sits. Walk on upward: skip boundary chrome, take the nearest content block, keep
// its LAST lines (the freshest context, "问题的最后一行"). `fromIdx` = the first line NOT consumed by the
// title walk, so adjacent lead-in the title already absorbed is never duplicated here.
const LEADIN_MAX = 2;
const MSG_MARK_RE = /^\s*⏺/; // ⏺ opens an assistant message in the scrollback — include it, stop there
function extractLeadIn(lines: string[], fromIdx: number): string | null {
  const block: string[] = [];
  let i = fromIdx;
  // Skip the chrome between the menu and the preceding text (spinner / rules / tab bar / stale footer /
  // blanks) — but never past a ❯ prompt echo (above it is the PREVIOUS exchange, stale context) nor past a
  // ⏺ message head (it IS the text's first line — the collect loop includes it).
  while (i >= 0) {
    const line = lines[i] ?? '';
    if (line.trim() && (!isTitleBoundary(line) || PROMPT_ECHO_RE.test(line) || MSG_MARK_RE.test(line))) break;
    i--;
  }
  for (; i >= 0 && block.length < 12; i--) {
    const line = lines[i] ?? '';
    if (!line.trim()) break;                                               // blank = the block's top (last paragraph)
    if (MSG_MARK_RE.test(line)) { block.unshift(line.trim()); break; }     // the ⏺ message head: include & stop
    if (isTitleBoundary(line)) break;                                      // hard chrome (incl. ❯ echo): stop
    block.unshift(line.trim());
  }
  const tail = block.slice(-LEADIN_MAX).map((line) => line.replace(/^⏺\s*/, '').trim()).filter(Boolean);
  return tail.length ? tail.join(' ') : null;
}

// Parse the multi-question tab strip → [{ label, answered }]. ☒ = answered, ☐ = not. "✔ Submit" is excluded.
interface PromptTab {
  label: string;
  answered: boolean;
}

function parseTabs(line: string): PromptTab[] {
  const tabs: PromptTab[] = [];
  const re = /([☐☒])\s*(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    const mark = match[1];
    const label = match[2];
    if (mark && label) tabs.push({ label, answered: mark === '☒' });
  }
  return tabs;
}

export interface PendingPromptOption {
  n: number;
  label: string;
  description: string;
}

export interface PendingPrompt {
  kind: 'question' | 'permission';
  title: string;
  options: PendingPromptOption[];
  cursor: number | null;
  leadIn?: string;
  multi?: true;
  step?: number;
  total?: number;
  submit?: boolean;
}

// capture-pane text → a normalized pending prompt, or null when no interactive menu is on screen.
//   { kind:'question'|'permission', title, options:[{n,label,description}], cursor,
//     multi, step, total, submit }
// `n` is the digit to send to pick that option. For multi, `step`/`total` drive the "第 i/N 题" progress and
// `submit` marks the final review screen (options are Submit answers / Cancel).
export function parsePendingPrompt(text: unknown): PendingPrompt | null {
  const lines = stripAnsi(text).split('\n').map(stripRight);

  // Anchor on the cursor-selected option (present in every menu: question, permission, review). Take the
  // LAST one so stale menus higher in the scrollback are ignored — the live menu is at the bottom.
  let anchor = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CURSOR_RE.test(lines[i] ?? '')) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) return null;

  // The option block = the contiguous run of option / description / rule lines around the anchor.
  const inBlock = (line: string): boolean => OPTION_RE.test(line) || isDesc(line) || RULE_RE.test(line);
  let top = anchor;
  let bot = anchor;
  while (top - 1 >= 0 && inBlock(lines[top - 1] ?? '')) top--;
  while (bot + 1 < lines.length && inBlock(lines[bot + 1] ?? '')) bot++;

  const options: PendingPromptOption[] = [];
  let cursor: number | null = null;
  for (let i = top; i <= bot; i++) {
    const line = lines[i] ?? '';
    const match = line.match(OPTION_RE);
    const numberText = match?.[1];
    const labelText = match?.[2];
    if (!numberText || !labelText) continue;
    const n = Number(numberText);
    const label = labelText.trim();
    if (CURSOR_RE.test(line)) cursor = n;
    let description = '';
    for (let j = i + 1; j <= bot; j++) {
      const candidate = lines[j] ?? '';
      if (OPTION_RE.test(candidate)) break;
      if (!isDesc(candidate)) break;
      description += (description ? ' ' : '') + candidate.trim();
    }
    if (META_LABELS.has(label.toLowerCase())) continue; // drop Claude's built-in meta-options
    options.push({ n, label, description });
  }
  if (!options.length) return null;

  // Title = header/question text above the block, skipping in-card blanks, stopping at the card's top edge.
  const head: string[] = [];
  let headStop = top - 1;
  for (let i = top - 1; i >= 0 && head.length < 5; i--) {
    const line = lines[i] ?? '';
    if (!line.trim()) { headStop = i - 1; continue; }
    if (isTitleBoundary(line)) { headStop = i; break; }
    head.unshift(line);
    headStop = i - 1;
  }
  const title = head.map((line) => line.replace(HEADER_DECOR_RE, '').trim()).filter(Boolean).join(' — ') || '需要你选择';

  // Multi-question: the tab strip drives progress. `answered` ☒ tabs → current step is the next unanswered.
  const tabLine = lines.find((line) => TAB_BAR_RE.test(line));
  const tabs = tabLine ? parseTabs(tabLine) : [];
  const multi = tabs.length > 1;
  const answered = tabs.filter((t) => t.answered).length;
  const firstOption = options[0];
  if (!firstOption) return null;
  const submit = /^submit answers?$/i.test(firstOption.label) || (multi && answered >= tabs.length);

  const kind: PendingPrompt['kind'] = /do you want to proceed/i.test(title) || /^yes\b/i.test(firstOption.label)
    ? 'permission' : 'question';

  const out: PendingPrompt = { kind, title, options, cursor };
  // Lead-in context the title walk didn't absorb (it stopped at a boundary or its 5-line cap) — the
  // assistant's last line(s) before the question, shown above the gate so the phone isn't asked blind.
  const leadIn = extractLeadIn(lines, headStop);
  if (leadIn) out.leadIn = leadIn;
  if (multi) {
    out.multi = true;
    out.total = tabs.length;
    out.step = Math.min(answered + 1, tabs.length);
    out.submit = submit;
  }
  return out;
}
