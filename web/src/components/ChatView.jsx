// web/src/components/ChatView.jsx
// The 对话 lens: a read-projection of the pane's Claude session as IM bubbles + two-type gate cards
// (permission / AskUserQuestion). NO input of its own — text is typed in the existing BottomDock composer
// (which stays mounted below in chat lens). Gate buttons write via the SAME send-keys the terminal uses.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useTranscript } from '../hooks/useTranscript.js';
import { usePendingPrompt } from '../hooks/usePendingPrompt.js';
import { fallbackGate } from '../chatGate.js';
import PromptGate from './PromptGate.jsx';
import { sendKeys } from '../api.js';
import { t } from '../i18n';
import {
  CommandIcon, FileIcon, FilePenIcon, SearchIcon, GlobeIcon, ListChecksIcon, PuzzleIcon, BotIcon, WrenchIcon,
  CheckIcon, XIcon,
} from './icons.jsx';

// One-line summary for a collapsed tool chip. We show what Claude actually DID — run a command, call a
// tool, activate a skill, dispatch an Agent — honestly (no laundering into vague phrases); the raw command/
// path/args stays and the full result opens on tap. The leading glyph is a real app icon (toolIcon), NOT an
// emoji, so a tool call reads in the app's own icon language. Cover the high-frequency tools; generic else.
function toolSummary(tool) {
  const n = tool.name || '工具';
  const inp = tool.input || {};
  if (n === 'Bash') return `运行 ${inp.command || ''}`.trim();
  if (n === 'Edit' || n === 'MultiEdit' || n === 'Write') return `${n === 'Write' ? '写入' : '编辑'} ${inp.file_path || ''}`.trim();
  if (n === 'Read') return `读取 ${inp.file_path || inp.notebook_path || ''}`.trim();
  if (n === 'NotebookEdit') return `编辑 ${inp.notebook_path || ''}`.trim();
  if (n === 'Grep') return `搜索 ${inp.pattern || ''}`.trim();
  if (n === 'Glob') return `查找文件 ${inp.pattern || ''}`.trim();
  if (n === 'WebSearch') return `联网搜索 ${inp.query || ''}`.trim();
  if (n === 'WebFetch') return `读取网页 ${inp.url || ''}`.trim();
  if (n === 'TodoWrite') return '更新待办';
  if (n === 'Skill') return `激活技能 ${inp.command || inp.skill || ''}`.trim();
  if (n === 'Task' || n === 'Agent') return `调用 Agent${inp.subagent_type ? `(${inp.subagent_type})` : ''}: ${inp.description || ''}`.trim();
  // Any other tool (AskUserQuestion / TaskUpdate / ToolSearch / Artifact / Workflow / MCP tools / …): a
  // generic "调用工具" verb + the tool's own name as the identifier, so it never reads as a bare, verbless
  // name. (Skills already say 激活技能; commands 运行; Agents 调用 Agent — this covers the long tail.)
  return `调用工具 ${n}`;
}

// The app-consistent icon (Lucide, currentColor) for a tool family — mirrors toolSummary's branches.
function toolIcon(name) {
  if (name === 'Bash') return <CommandIcon />;
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') return <FilePenIcon />;
  if (name === 'Read') return <FileIcon />;
  if (name === 'Grep' || name === 'Glob') return <SearchIcon />;
  if (name === 'WebSearch' || name === 'WebFetch') return <GlobeIcon />;
  if (name === 'TodoWrite') return <ListChecksIcon />;
  if (name === 'Skill') return <PuzzleIcon />;
  if (name === 'Task' || name === 'Agent') return <BotIcon />;
  return <WrenchIcon />;
}

// Three-dot pulse, reused by both the typing bubble and the running-tool head's trailing indicator.
function TypingDots() {
  return (
    <span className="chat-typing-dots">
      <span className="chat-typing-dot" />
      <span className="chat-typing-dot" />
      <span className="chat-typing-dot" />
    </span>
  );
}

// +A/−B badge for an edited file, right-aligned in the chip head (like the CLI / other AI coding tools).
// Omits a zero side. Green add / red del; tabular-nums so the digits don't jitter.
function DiffStat({ diff }) {
  if (!diff || (!diff.added && !diff.removed)) return null;
  return (
    <span className="chat-tool-stat" aria-label={`增 ${diff.added} 行，删 ${diff.removed} 行`}>
      {diff.added > 0 && <span className="cts-add">+{diff.added}</span>}
      {diff.removed > 0 && <span className="cts-del">−{diff.removed}</span>}
    </span>
  );
}

// The expandable detail. For a real edit we render the coloured hunks (the actual before/after lines);
// for a create there are no hunks → fall back to the raw tool result string (e.g. "created successfully").
function ToolBody({ tool }) {
  if (tool.diff && tool.diff.hunks && tool.diff.hunks.length) {
    return (
      <div className="chat-diff">
        {tool.diff.hunks.map((h, hi) => (
          <div className="chat-diff-hunk" key={hi}>
            {h.lines.map((ln, li) => {
              const c = ln[0] === '+' ? 'add' : ln[0] === '-' ? 'del' : 'ctx';
              return <div className={'chat-diff-line cd-' + c} key={li}>{ln || ' '}</div>;
            })}
          </div>
        ))}
      </div>
    );
  }
  if (tool.result != null) return <pre className="chat-tool-body">{tool.result}</pre>;
  return null;
}

// Outcome marker at the end of a finished chip: a red cross on failure. A green check on success — EXCEPT
// when a +A/−B diff stat is already shown (a file edit), where the stat itself says it succeeded, so a check
// would be redundant. Nothing while running (the wave shows that) or when there's no result yet.
function ToolStatus({ tool }) {
  if (tool.isError) return <span className="chat-tool-status err" aria-label="失败"><XIcon /></span>;
  const hasDiffStat = tool.diff && (tool.diff.added || tool.diff.removed);
  if (tool.result != null && !hasDiffStat) return <span className="chat-tool-status ok" aria-label="成功"><CheckIcon /></span>;
  return null;
}

// The collapsed chip is now a pure trigger — tapping it opens the detail SHEET (no in-page expand). The
// chip stays one clean line; all detail (mode / command / output) lives in the bottom sheet.
function ToolChip({ tool, running, onOpen }) {
  return (
    <div className={'chat-tool' + (tool.isError ? ' chat-tool-err' : '') + (running ? ' chat-tool-running' : '')}>
      <button type="button" className="chat-tool-head" onClick={onOpen}>
        <span className="chat-tool-ic">{toolIcon(tool.name)}</span>
        <span className="chat-tool-head-text">{toolSummary(tool)}</span>
        <DiffStat diff={tool.diff} />
        {/* Running: the wave (the pulse already says in-progress). Done: a ✓/✗ outcome mark. */}
        {running ? <span className="chat-tool-head-running"><TypingDots /></span> : <ToolStatus tool={tool} />}
      </button>
    </div>
  );
}

// Human "执行模式" label per tool family — the verb in words, complementing the raw tool name shown in the
// sheet header. Mirrors toolSummary's branches; generic 调用工具 for the long tail.
function toolMode(name) {
  const map = {
    Bash: '运行命令', Edit: '编辑文件', MultiEdit: '编辑文件', Write: '写入文件', Read: '读取文件',
    NotebookEdit: '编辑笔记本', Grep: '搜索', Glob: '查找文件', WebSearch: '联网搜索', WebFetch: '读取网页',
    TodoWrite: '更新待办', Skill: '激活技能', Task: '调用 Agent', Agent: '调用 Agent',
  };
  return map[name] || '调用工具';
}

// The "执行的命令" text — the tool's most meaningful input field, else its whole input pretty-printed. Kept
// raw (no laundering) so the sheet shows exactly what ran. Empty string → the command section is omitted.
function toolCommandText(tool) {
  const n = tool.name;
  const inp = tool.input || {};
  if (n === 'Bash') return inp.command || '';
  if (n === 'Read' || n === 'Edit' || n === 'MultiEdit' || n === 'Write') return inp.file_path || '';
  if (n === 'NotebookEdit') return inp.notebook_path || '';
  if (n === 'Grep' || n === 'Glob') return inp.pattern || '';
  if (n === 'WebSearch') return inp.query || '';
  if (n === 'WebFetch') return inp.url || '';
  if (n === 'Skill') return inp.command || inp.skill || '';
  if (n === 'Task' || n === 'Agent') return inp.prompt || inp.description || '';
  const keys = Object.keys(inp);
  if (!keys.length) return '';
  return JSON.stringify(inp, null, 2);
}

// Split an absolute path into its directory (with trailing /) and the filename.
function fileParts(p) {
  if (!p) return { dir: '', name: '' };
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? { dir: p.slice(0, idx + 1), name: p.slice(idx + 1) } : { dir: '', name: p };
}

// A purpose-built code-diff viewer for the edit sheet. Each row: a sticky single line-number gutter (the new
// file's number for add/context, the old for a deletion), a +/−/· sign column, then the code kept pre-
// formatted (long lines scroll horizontally without the gutter/sign leaving). Add/del rows are tinted and
// carry a coloured left bar; hunks are separated by a faint gap. Line numbers are tabular so they stay aligned.
function DiffView({ hunks }) {
  return (
    <div className="dv">
      {hunks.map((h, hi) => {
        let o = h.oldStart || 0;
        let n = h.newStart || 0;
        return (
          <div className="dv-hunk" key={hi}>
            {hi > 0 && <div className="dv-gap"><span>⋯</span></div>}
            {(h.lines || []).map((ln, li) => {
              const sign = typeof ln === 'string' ? ln[0] : ' ';
              const text = typeof ln === 'string' ? ln.slice(1) : '';
              let num;
              let cls;
              if (sign === '+') { num = n++; cls = 'add'; }
              else if (sign === '-') { num = o++; cls = 'del'; }
              else { num = n++; o++; cls = 'ctx'; }
              return (
                <div className={'dv-row dv-' + cls} key={li}>
                  <span className="dv-ln">{num}</span>
                  <span className="dv-sign">{sign === '+' ? '+' : sign === '-' ? '−' : ''}</span>
                  <span className="dv-code">{text || ' '}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// The execution state pill shared by both sheet layouts.
function toolState(tool, running) {
  if (running) return { txt: '执行中', cls: 'run' };
  if (tool.isError) return { txt: '失败', cls: 'err' };
  if (tool.result != null) return { txt: '成功', cls: 'ok' };
  return { txt: '未返回', cls: 'idle' };
}

// Dedicated file-edit layout: the sheet becomes a code-review surface. Header is the FILE (name bold, dir
// muted), a compact meta strip (mode · state · +A/−B), then the diff fills the sheet as the main content.
// A file CREATE has no per-line patch (only a line count) → a friendly note stands in for the diff.
function EditSheetBody({ tool, running }) {
  const { dir, name } = fileParts((tool.input && tool.input.file_path) || '');
  const st = toolState(tool, running);
  const created = tool.diff && tool.diff.created;
  const hunks = tool.diff && tool.diff.hunks;
  return (
    <>
      <div className="tool-sheet-head es-head">
        <span className="tool-sheet-ic"><FilePenIcon /></span>
        <div className="es-file">
          <span className="es-name">{name || tool.name}</span>
          {dir && <span className="es-dir">{dir}</span>}
        </div>
      </div>
      <div className="tool-sheet-body es-body">
        <div className="es-meta">
          <span className="tool-sheet-mode-val">{toolMode(tool.name)}</span>
          <span className={'tool-sheet-state ' + st.cls}>{st.txt}</span>
          <DiffStat diff={tool.diff} />
        </div>
        {hunks && hunks.length
          ? <div className="es-diff"><DiffView hunks={hunks} /></div>
          : created
            ? <div className="es-note">新建文件{tool.diff.added ? ` · 新增 ${tool.diff.added} 行` : ''}</div>
            : running
              ? <div className="tool-sheet-empty">执行中…</div>
              : <div className="tool-sheet-empty">没有可显示的改动</div>}
      </div>
    </>
  );
}

// Bottom sheet (~half screen) with the full tool detail. FILE EDITS get a dedicated code-review layout
// (EditSheetBody); every other tool gets the generic 执行模式 / 执行的命令 / 输出结果 sections. Both reuse
// the same shell (backdrop / grip / close / Esc) and the warm-dusk tokens so they match the lens.
function ToolSheet({ tool, running, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!tool) return null;
  const isEdit = !!(tool.diff && ((tool.diff.hunks && tool.diff.hunks.length) || tool.diff.created));
  const cmd = toolCommandText(tool);
  const hasOutput = tool.result != null;
  const st = toolState(tool, running);
  return (
    <>
      <div className="tool-sheet-backdrop" onClick={onClose} />
      <div className={'tool-sheet' + (isEdit ? ' tool-sheet-edit' : '')} role="dialog" aria-modal="true">
        <div className="tool-sheet-grip" />
        <button type="button" className="cmd-close tool-sheet-x" aria-label="关闭" onClick={onClose}><XIcon /></button>
        {isEdit ? (
          <EditSheetBody tool={tool} running={running} />
        ) : (
          <>
            <div className="tool-sheet-head">
              <span className="tool-sheet-ic">{toolIcon(tool.name)}</span>
              <span className="tool-sheet-title">{tool.name || '工具'}</span>
            </div>
            <div className="tool-sheet-body">
              <section className="tool-sheet-sec">
                <div className="tool-sheet-label">执行模式</div>
                <div className="tool-sheet-mode-row">
                  <span className="tool-sheet-mode-val">{toolMode(tool.name)}</span>
                  <span className={'tool-sheet-state ' + st.cls}>{st.txt}</span>
                </div>
              </section>
              {cmd && (
                <section className="tool-sheet-sec">
                  <div className="tool-sheet-label">执行的命令</div>
                  <pre className="tool-sheet-cmd">{cmd}</pre>
                </section>
              )}
              <section className="tool-sheet-sec tool-sheet-out">
                <div className="tool-sheet-label"><span>输出结果</span></div>
                {hasOutput
                  ? <ToolBody tool={tool} />
                  : <div className="tool-sheet-empty">{running ? '执行中…' : '无输出'}</div>}
              </section>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Bubble({ m, running, onOpenTool }) {
  if (m.type === 'tool') return <ToolChip tool={m.tool} running={running} onOpen={() => onOpenTool(m)} />;
  // ESC-interrupt marker — a quiet, centered grey hint that the user stopped the turn, NOT a user bubble
  // (Claude Code writes it as a user line, but the user didn't type it).
  if (m.type === 'interrupt') return <div className="chat-interrupt">{t('chat.interrupted')}</div>;
  // Compaction divider — a centered hairline marking where the context was compacted (see transcriptParse).
  if (m.type === 'compact') return <div className="chat-compact-divider">{t('chat.compacted')}</div>;
  // Slash command — input and output are SEPARATE, following the lens's normal left/right split: the command
  // the user ran is their action (a right-aligned monospace pill), its stdout echo is the system's response
  // (a left-aligned system line). Not every command has a result (the hand-off for a still-open interactive
  // picker happens at SEND time in the composer, since the transcript is silent until the user picks).
  if (m.type === 'slash') {
    return (
      <>
        <div className="chat-slash-cmd">{m.name}{m.args ? ' ' + m.args : ''}</div>
        {m.result && <div className="chat-slash-result">{m.result}</div>}
      </>
    );
  }
  // Thinking (Claude's extended reasoning) is NOT surfaced as text — the live typing animation already
  // stands in for "Claude is thinking". Rendering the raw reasoning here would be noise, not conversation.
  if (m.type === 'thinking') return null;
  // Assistant text gets markdown (tables/code/etc render properly); user text stays plain — it's what the
  // user typed, not content to be re-interpreted. Same marked→DOMPurify pipeline as DocView.jsx.
  if (m.role !== 'user') {
    const html = DOMPurify.sanitize(marked.parse(m.text || ''));
    return <div className="chat-bubble chat-them chat-md" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <div className="chat-bubble chat-me">{m.text}</div>;
}

const NEAR_BOTTOM_PX = 40;
const NEAR_TOP_PX = 80;

// Time is shown at just two spots per exchange — under YOUR input, and under the AI's LAST reply of each
// turn (its concluding message). Intermediate assistant lines and tool chips carry none. This builds the set
// of message indices that should show a time: every user text, plus the last assistant-text before each user
// message (and the final turn's last reply). Tools/thinking never qualify and don't reset the running "last
// assistant text" pointer (a reply after a tool is still that turn's concluding line).
function timeStampedIndices(messages) {
  const set = new Set();
  let lastAiText = -1;
  messages.forEach((m, idx) => {
    if (m.type === 'text' && m.role === 'user') {
      set.add(idx);
      if (lastAiText >= 0) { set.add(lastAiText); lastAiText = -1; }
    } else if (m.type === 'text') {
      lastAiText = idx;
    }
  });
  if (lastAiText >= 0) set.add(lastAiText);
  return set;
}

// Format a message's jsonl ISO timestamp as a label: today → "14:32"; an earlier day →
// "7月16日 14:32". Returns null for a missing/unparseable stamp so the caller shows nothing (never a fake time).
function fmtTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

// Resolve the block a long-press landed on, innermost-first: a code block copies just its code; a tool's
// expanded body / diff copies that; otherwise the whole message bubble. Returns { el, text } or null.
function resolveCopyBlock(target) {
  const pre = target.closest?.('.chat-md pre');
  if (pre) return { el: pre, text: pre.innerText };
  const body = target.closest?.('.chat-tool-body, .chat-diff');
  if (body) return { el: body, text: body.innerText };
  const bubble = target.closest?.('.chat-bubble');
  if (bubble) return { el: bubble, text: bubble.innerText };
  const tool = target.closest?.('.chat-tool');
  if (tool) return { el: tool, text: tool.innerText };
  return null;
}

const COPY_CALLOUT_W = 72; // estimated callout width (px) for the right-edge clamp (single 拷贝 button)

export default function ChatView({ pane, kind, msg, onAuthFail, slashEcho, onSlashEchoDone }) {
  const { messages, hasMoreOlder, loadOlder, loadingOlder, session } = useTranscript(pane, true);
  const tsIdx = useMemo(() => timeStampedIndices(messages), [messages]);
  // The gate's options are scraped from the pane's on-screen menu (they're not in the transcript). Poll only
  // while Claude is blocked (kind==='permission'). If a menu is up → the rich PromptGate; if permission but
  // the menu couldn't be parsed → the generic 允许/拒绝 fallback so there's always a way to act.
  const busy = kind === 'permission';
  const { prompt, refetch } = usePendingPrompt(pane, busy);
  // After the user answers, the menu vanishes from the screen instantly but `kind` stays 'permission'
  // until the slower /states poll catches up — so !prompt && busy would flash the 允许/拒绝 fallback
  // for ~1s after every 确认 (and between multi-question steps). Latch "a scraped menu WAS up this
  // episode": once one was shown, a null re-read means resolving/advancing, never "unparseable menu →
  // show the generic gate". The latch resets when the episode ends (busy → false).
  const hadPromptRef = useRef(false);
  useEffect(() => { if (prompt) hadPromptRef.current = true; }, [prompt]);
  useEffect(() => { if (!busy) hadPromptRef.current = false; }, [busy]);
  const fb = !prompt && busy && !hadPromptRef.current ? fallbackGate() : null;

  // "Working" indicators (Task 13): state cues, not token streaming — data is polled every 1.5s.
  const last = messages.length ? messages[messages.length - 1] : null;
  const lastIsRunningTool = last?.type === 'tool' && last.tool.result === null && kind === 'working';
  const toolRunning = lastIsRunningTool;
  // Compaction (压缩中) gets its own labeled indicator; a turn that died on an API error (error) shows a note
  // instead. Both suppress the plain typing wave — neither is "Claude generating a reply".
  const showCompacting = kind === 'compacting';
  const showError = kind === 'error';
  // The optimistic slash-command echo (App sets it at send time — the jsonl scaffold only lands when the
  // command COMPLETES, minutes for /compact). It's dropped once the REAL marker takes over: a marker with
  // the same name and a k beyond what was on screen when the echo appeared (so a same-named marker from an
  // EARLIER run in the window can't kill a fresh echo), or a session switch (e.g. /clear — the new
  // session's own /clear marker owns the screen now; only when both ids are known, so the very first
  // transcript load can't spuriously clear it).
  const echoMarkRef = useRef(null); // { k, session } captured when the echo first renders
  if (slashEcho && !echoMarkRef.current) {
    echoMarkRef.current = { k: messages.reduce((mx, m) => Math.max(mx, m.k ?? -1), -1), session };
  }
  if (!slashEcho && echoMarkRef.current) echoMarkRef.current = null;
  const echoCovered = !!(slashEcho && echoMarkRef.current && (
    (echoMarkRef.current.session && session && echoMarkRef.current.session !== session)
    || messages.some((m) => m.type === 'slash' && m.name === slashEcho.name && (m.k ?? -1) > echoMarkRef.current.k)
  ));
  useEffect(() => { if (echoCovered) onSlashEchoDone?.(); }, [echoCovered, onSlashEchoDone]);
  // kind is a slow (5s) poll while messages is fast (1.5s) — right after a send, kind can still read stale
  // 'done'. A trailing USER message means "reply is coming" regardless of that staleness (bridges the gap);
  // a trailing assistant/tool message only shows typing while actively 'working'. A running tool wins either way.
  const showTyping = !lastIsRunningTool && !showCompacting && !showError && (
    last?.role === 'user' ? kind !== 'permission'
      : kind === 'working'
  );

  const scrollRef = useRef(null);
  const viewRef = useRef(null); // .chat-view — positioning context for the copy callout
  const stickBottomRef = useRef(true); // was the user near the bottom just before this render's messages changed?
  const prevScrollHeightRef = useRef(null); // captured just before a loadOlder() prepend, to preserve scroll position
  const pendingPrependRef = useRef(false); // true only while a loadOlder() round-trip is in flight, so a
  // recent-window poll landing mid-flight doesn't consume the stale prevScrollHeight and jump the view.
  const lastMaxKRef = useRef(null); // largest message.k seen as of the previous messages-effect run
  const [atBottom, setAtBottom] = useState(true);

  // ── Long-press copy. Native selection is disabled on .chat-scroll (CSS) so the browser's ugly system copy
  // menu never appears; instead a still ~480ms hold surfaces OUR callout (拷贝 / 复制全部) over the pressed
  // block. Touch-only (mouse/right-click keep native behaviour on desktop). The pressed block's text is
  // captured into state up front, so a background poll re-render can't strip the copy even if it drops the
  // highlight. Any new touch, a scroll, or a move past the slop cancels/dismisses.
  const [copyUI, setCopyUI] = useState(null); // { top, left, text } in .chat-view px, or null
  const hlRef = useRef(null);                  // the DOM node currently ring-highlighted (imperative class)
  const lpRef = useRef({ timer: null, x: 0, y: 0, fired: false });

  // Tool detail sheet: store the tool message's key (not the object) so the sheet stays LIVE as polls update
  // the tool (a running tool gains its result). Resolve the current message each render; if it scrolls out of
  // the loaded window it's gone → the sheet self-closes.
  const [sheetKey, setSheetKey] = useState(null);
  const sheetMsg = sheetKey != null ? messages.find((m) => m.type === 'tool' && (m.k ?? m.i) === sheetKey) : null;
  useEffect(() => { if (sheetKey != null && !sheetMsg) setSheetKey(null); }, [sheetKey, sheetMsg]);

  const clearHighlight = () => { if (hlRef.current) { hlRef.current.classList.remove('chat-copy-hl'); hlRef.current = null; } };
  const dismissCopy = () => { clearHighlight(); setCopyUI(null); };
  const cancelLongPress = () => { const lp = lpRef.current; if (lp.timer) { clearTimeout(lp.timer); lp.timer = null; } };

  const fireLongPress = (x, y, target) => {
    lpRef.current.timer = null;
    const block = resolveCopyBlock(target);
    const view = viewRef.current;
    if (!block || !block.text.trim() || !view) return;
    lpRef.current.fired = true; // swallow the click that follows this hold (so a tool doesn't also open its sheet)
    navigator.vibrate?.(12);
    block.el.classList.add('chat-copy-hl');
    hlRef.current = block.el;
    const vr = view.getBoundingClientRect();
    const br = block.el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x - vr.left - COPY_CALLOUT_W / 2, vr.width - COPY_CALLOUT_W - 8));
    const above = br.top - vr.top - 44;
    const top = above < 4 ? Math.min(br.bottom - vr.top + 8, vr.height - 52) : above;
    setCopyUI({ top, left, text: block.text });
  };

  const onCopyDown = (e) => {
    dismissCopy(); // a fresh touch always clears a showing callout
    lpRef.current.fired = false;
    if (e.pointerType === 'mouse') return; // desktop keeps native selection/right-click
    const lp = lpRef.current;
    lp.x = e.clientX; lp.y = e.clientY;
    const { target } = e;
    cancelLongPress();
    lp.timer = setTimeout(() => fireLongPress(lp.x, lp.y, target), 480);
  };
  // A long-press fired → swallow the synthetic click it would spawn (capture phase, before the tool head's
  // onClick), so the copy callout stays up instead of the tap also opening the tool sheet.
  const onCopyClickCapture = (e) => {
    if (lpRef.current.fired) { lpRef.current.fired = false; e.stopPropagation(); e.preventDefault(); }
  };
  const onCopyMove = (e) => {
    const lp = lpRef.current;
    if (lp.timer && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) cancelLongPress(); // moved → scroll, not a hold
  };

  const doCopy = async (text) => {
    try { await navigator.clipboard.writeText(text); navigator.vibrate?.(8); }
    catch { /* clipboard blocked (insecure ctx / denied) — nothing else we can do */ }
    dismissCopy();
  };

  useEffect(() => cancelLongPress, []); // clear a pending hold on unmount
  useEffect(() => { dismissCopy(); setSheetKey(null); }, [pane]); // pane switch drops any callout / sheet

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    cancelLongPress();
    if (copyUI) dismissCopy(); // scrolling dismisses the callout (its anchor is moving)
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stickBottomRef.current = near;
    setAtBottom(near);
    if (el.scrollTop < NEAR_TOP_PX && hasMoreOlder && !loadingOlder) {
      prevScrollHeightRef.current = el.scrollHeight;
      pendingPrependRef.current = true;
      loadOlder();
    }
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickBottomRef.current = true;
    setAtBottom(true);
  };

  // Default view is pinned to the bottom (newest), like a normal chat. Priority on each messages change:
  //   1. a loadOlder() prepend just landed (pendingPrependRef set) → restore the visual position (scroll
  //      delta) so the view doesn't jump — this must win over everything else, it's mid-flight state.
  //   2. the newest message is a NEWLY-ARRIVED user message (bigger k than last seen, role==='user') — the
  //      user just sent it via the composer below (ChatView can't see the send itself) → force bottom
  //      regardless of where the view was scrolled.
  //   3. otherwise, if the view was already near the bottom → keep it stuck there.
  //   4. otherwise leave the scroll position alone.
  useEffect(() => {
    const el = scrollRef.current;
    const newest = messages.length ? messages[messages.length - 1] : null;
    const newestK = newest ? (newest.k ?? newest.i) : null;
    const isNewTrailingUser = newest && newest.role === 'user'
      && lastMaxKRef.current != null && newestK != null && newestK > lastMaxKRef.current;

    if (!el) return;
    if (pendingPrependRef.current) {
      // Do NOT advance lastMaxKRef here: this run is preempted by the in-flight prepend restore, so it
      // never evaluates isNewTrailingUser for real. Leaving lastMaxKRef stale means the very next
      // (non-prepend) run still sees a trailing new user message as new and force-scrolls to bottom —
      // otherwise a message sent while scrolled up (mid-prepend) would be silently marked "already seen"
      // and permanently strand the user off-screen after their own send.
      el.scrollTop += el.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = null;
      pendingPrependRef.current = false;
      return;
    }
    if (newestK != null) lastMaxKRef.current = lastMaxKRef.current == null ? newestK : Math.max(lastMaxKRef.current, newestK);
    if (isNewTrailingUser) {
      el.scrollTop = el.scrollHeight;
      stickBottomRef.current = true;
      setAtBottom(true);
      return;
    }
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, showTyping]);

  // First mount / pane switch: land at the bottom immediately (no animation to fight).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickBottomRef.current = true;
    setAtBottom(true);
    lastMaxKRef.current = null;
  }, [pane]);

  return (
    <div className="chat-view" ref={viewRef}>
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}
        onPointerDown={onCopyDown} onPointerMove={onCopyMove}
        onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress}
        onClickCapture={onCopyClickCapture}>
        {messages.length === 0 && <div className="chat-empty">还没有对话内容</div>}
        {messages.map((m, idx) => {
          if (m.type === 'thinking') return null; // dropped (see Bubble) — no bubble, no time
          const label = tsIdx.has(idx) ? fmtTime(m.ts) : null;
          return (
            <Fragment key={(m.k ?? m.i) + ':' + idx}>
              <Bubble m={m} running={toolRunning && idx === messages.length - 1}
                onOpenTool={(msg) => setSheetKey(msg.k ?? msg.i)} />
              {label && <div className={'chat-ts ' + (m.role === 'user' ? 'ts-me' : 'ts-them')}>{label}</div>}
            </Fragment>
          );
        })}
        {slashEcho && !echoCovered && (
          <div className="chat-slash-cmd">{slashEcho.name}{slashEcho.args ? ' ' + slashEcho.args : ''}</div>
        )}
        {showCompacting && (
          <div className="chat-compacting" aria-live="polite">
            <TypingDots />
            <span className="chat-compacting-label">正在压缩上下文…</span>
          </div>
        )}
        {showError && (
          <div className="chat-turn-error" role="status">
            本轮出错{msg ? `：${msg}` : ''}
          </div>
        )}
        {showTyping && (
          <div className="chat-typing" aria-hidden="true">
            <TypingDots />
          </div>
        )}
      </div>

      {copyUI && (
        <div className="sel-callout chat-copy-callout" style={{ top: copyUI.top, left: copyUI.left }}
          onPointerDown={(e) => e.preventDefault() /* keep the callout from stealing/dismissing before click */}>
          <button type="button" onClick={() => doCopy(copyUI.text)}>拷贝</button>
        </div>
      )}

      {!atBottom && (
        <button type="button" className="new-output" aria-label="回到最新" onClick={scrollToBottom}>
          ↓ 回到底部
        </button>
      )}

      {sheetMsg && (
        <ToolSheet
          tool={sheetMsg.tool}
          running={toolRunning && sheetMsg === messages[messages.length - 1]}
          onClose={() => setSheetKey(null)}
        />
      )}

      {/* The gate (rich or fallback) is a modal bottom sheet: the backdrop dims the rest of the screen and,
         critically, covers the composer — a SHORT gate (e.g. the 提交/取消 review card) would otherwise leave
         the composer's quick-reply chips peeking out AND tappable above the card. */}
      {(prompt || fb) && <div className="chat-gate-backdrop" />}
      {prompt && <PromptGate pane={pane} prompt={prompt} onAuthFail={onAuthFail} onAct={refetch} />}
      {fb && (
        <div className="chat-gate">
          <div className="chat-gate-prompt">{fb.prompt}</div>
          <div className="chat-gate-actions">
            {fb.options.map((o, i) => (
              <button key={i} type="button" className="chat-gate-btn" onClick={() => sendKeys(pane, o.keys)}>{o.label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
// 输入不在此处：chat 镜头下底部照常是 BottomDock composer（Task 7 保证其常驻），门卡片悬在气泡流末尾、composer 之上。
