// web/src/components/ChatView.tsx
// The 对话 lens: a read-projection of the pane's agent session as IM bubbles + gate cards. Claude gates
// still drive its TUI; managed Codex gates use App Server requests and never touch the terminal.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { messageIdentity, useTranscript } from '../hooks/useTranscript.js';
import { useCodexMessageStream } from '../hooks/useCodexMessageStream.js';
import { usePendingPrompt } from '../hooks/usePendingPrompt.js';
import { fallbackGate } from '../chatGate.js';
import PromptGate from './PromptGate.jsx';
import LensBoot from './LensBoot.jsx';
import { answerCodexApproval, answerCodexInput, sendKeys, UnauthorizedError } from '../api.js';
import { t } from '../i18n';
import { useBackButton, useHistoryLayer, unwindHistory } from '../hooks/useBackButton.js';
import { findOutputLinks } from '../docDecorations.js';
import {
  CommandIcon, FileIcon, FilePenIcon, SearchIcon, GlobeIcon, ListChecksIcon, PuzzleIcon, BotIcon, WrenchIcon,
  CheckIcon, XIcon,
} from './icons.jsx';
import { CodexPlanSheet, CodexPlanSummary, codexPlanSteps } from './CodexPlan.jsx';
import CodexGoalMenu, { CodexGoalCard } from './CodexGoalMenu.jsx';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import type { CodexGoal } from '../../../server/src/codexStreamProtocol.js';
import type {
  CodexDiff,
  CodexDiffHunk,
  CodexToolProjection,
} from '../../../server/src/codexToolProtocol.js';
import type { CodexOutgoingItem } from '../codexOutgoing.js';
import type { TranscriptMessage } from '../hooks/useTranscript.js';
import type {
  CodexApprovalDecision as ApprovalDecision,
  CodexApprovalRequest as CodexApproval,
  CodexApprovalSimpleDecision as ApprovalSimpleDecision,
  CodexInputRequest,
  CodexSessionSnapshot,
} from '../hooks/useCodexSession.js';
import type { CodexPlanView } from './CodexPlan.jsx';

type AgentKind = 'working' | 'permission' | 'compacting' | 'error' | null;
type AgentName = 'claude' | 'codex' | string;

type ChatMessage = TranscriptMessage;

interface SlashEcho {
  name: string;
  args?: string;
}

interface ChatActionError {
  id?: string;
  kind: 'send' | 'stop' | 'queue';
  detail?: string | null;
}

interface ChatOutputLink {
  kind: 'url' | 'doc';
  path?: string;
  protocol?: 'http' | 'https';
  port?: number;
  urlPath?: string;
  raw?: string;
}

interface ChatViewProps {
  pane: string;
  agent?: AgentName;
  kind?: AgentKind;
  msg?: string | null;
  onAuthFail?: () => void;
  slashEcho?: SlashEcho | null;
  onSlashEchoDone?: () => void;
  refreshToken?: unknown;
  codexSession?: CodexSessionSnapshot | null;
  optimisticMessages?: CodexOutgoingItem[];
  actionError?: ChatActionError | null;
  onOptimisticCovered?: (ids: string[]) => void;
  onDocLinkTap?: (link: ChatOutputLink, clientX: number, clientY: number) => void;
}

interface ErrorLike {
  message?: string;
  serverError?: string;
}

interface CopyBlock {
  el: HTMLElement;
  text: string;
}

interface CopyUI {
  top: number;
  left: number;
  text: string;
}

interface GateMask {
  top: number;
  height: number;
}

interface LongPressState {
  timer: ReturnType<typeof setTimeout> | null;
  x: number;
  y: number;
  fired: boolean;
}

const errorLike = (error: unknown): ErrorLike => (
  error !== null && typeof error === 'object' ? error as ErrorLike : {}
);

const toolInput = (tool: CodexToolProjection): Record<string, unknown> => (
  Array.isArray(tool.input) ? {} : tool.input
);

const inputText = (input: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) {
    if (typeof input[key] === 'string') return input[key];
  }
  return '';
};

// Codex App Server exposes the process-launch wrapper, while its terminal UI shows only the command passed
// to that shell. Keep the raw value in the transcript and remove only this known wrapper at render time.
function displayCommand(command: unknown): string {
  if (Array.isArray(command)) {
    if (command.length === 3 && command[0] === '/bin/zsh' && command[1] === '-lc') return String(command[2] || '');
    return command.map((part) => displayCommand(part)).filter(Boolean).join('\n');
  }
  const raw = String(command || '');
  const match = raw.match(/^\/bin\/zsh\s+-lc\s+([\s\S]+)$/);
  if (!match) return raw;
  const shellArg = match[1].trim();
  if (shellArg.length >= 2 && shellArg[0] === "'" && shellArg[shellArg.length - 1] === "'") {
    return shellArg.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (shellArg.length >= 2 && shellArg[0] === '"' && shellArg[shellArg.length - 1] === '"') {
    try { return JSON.parse(shellArg); } catch { return shellArg.slice(1, -1); }
  }
  return shellArg;
}

// One-line summary for a collapsed tool chip. We show what Claude actually DID — run a command, call a
// tool, activate a skill, dispatch an Agent — honestly (no laundering into vague phrases); meaningful command/
// path/args stays and the full result opens on tap. The leading glyph is a real app icon (toolIcon), NOT an
// emoji, so a tool call reads in the app's own icon language. Cover the high-frequency tools; generic else.
function toolSummary(tool: CodexToolProjection): string {
  const n = tool.name || '工具';
  const inp = toolInput(tool);
  if (n === 'Bash') {
    const command = displayCommand(inp.command);
    return command ? `运行 ${command}` : '运行命令';
  }
  if (n === 'exec_command') {
    const command = displayCommand(inp.cmd);
    return command ? `运行 ${command}` : '运行命令';
  }
  if (n === 'apply_patch') {
    const filename = String(inp.file_path || '').split(/[\\/]/).filter(Boolean).pop();
    return filename ? `编辑 ${filename}` : '编辑文件';
  }
  if (n === 'web__run') return '联网查询';
  if (n === 'view_image') return `查看图片 ${inp.path || ''}`.trim();
  if (n === 'wait') return '等待任务完成';
  if (n === 'write_stdin') return '继续运行任务';
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
function toolIcon(name: string): ReactNode {
  if (name === 'Bash' || name === 'exec_command' || name === 'write_stdin') return <CommandIcon />;
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit' || name === 'apply_patch') return <FilePenIcon />;
  if (name === 'Read') return <FileIcon />;
  if (name === 'Grep' || name === 'Glob') return <SearchIcon />;
  if (name === 'WebSearch' || name === 'WebFetch' || name === 'web__run') return <GlobeIcon />;
  if (name === 'view_image') return <FileIcon />;
  if (name === 'TodoWrite') return <ListChecksIcon />;
  if (name === 'Skill') return <PuzzleIcon />;
  if (name === 'Task' || name === 'Agent') return <BotIcon />;
  return <WrenchIcon />;
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch']);
const isFileEditTool = (tool: CodexToolProjection): boolean => FILE_EDIT_TOOLS.has(tool.name);

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
function DiffStat({ diff }: { diff?: CodexDiff }): ReactNode {
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
function ToolBody({ tool }: { tool: CodexToolProjection }): ReactNode {
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

// Final outcome comes only from fields persisted by App Server. In particular, a completed dynamic tool with
// no explicit success bit is neutral: its inner action may have been declined even though the wrapper itself
// returned normally. This keeps the live projection identical to a thread restored after restart.
function ToolStatus({ tool }: { tool: CodexToolProjection }): ReactNode {
  if (tool.outcome === 'declined') return <span className="chat-tool-status neutral" aria-label="已拒绝">已拒绝</span>;
  if (tool.outcome === 'completed' && isFileEditTool(tool)) return null;
  if (tool.outcome === 'completed') return <span className="chat-tool-status neutral" aria-label="已结束">已结束</span>;
  if (tool.isError) return <span className="chat-tool-status err" aria-label="失败"><XIcon /></span>;
  const hasDiffStat = tool.diff && (tool.diff.added || tool.diff.removed);
  const succeeded = tool.outcome === 'success' || (tool.outcome == null && tool.result != null);
  if (succeeded && !hasDiffStat) return <span className="chat-tool-status ok" aria-label="成功"><CheckIcon /></span>;
  return null;
}

// The collapsed chip is now a pure trigger — tapping it opens the detail SHEET (no in-page expand). The
// chip stays one clean line; all detail (mode / command / output) lives in the bottom sheet.
function ToolChip({
  tool, running, onOpen,
}: {
  tool: CodexToolProjection;
  running: boolean;
  onOpen: () => void;
}) {
  return (
    <div className={'chat-tool' + (tool.isError ? ' chat-tool-err' : '') + (running ? ' chat-tool-running' : '')}>
      <button type="button" className="chat-tool-head" onClick={onOpen}>
        <span className="chat-tool-ic">{toolIcon(tool.name)}</span>
        <span className="chat-tool-head-text">{toolSummary(tool)}</span>
        <DiffStat {...(tool.diff ? { diff: tool.diff } : {})} />
        {/* Running: the wave (the pulse already says in-progress). Done: a ✓/✗ outcome mark. */}
        {running ? <span className="chat-tool-head-running"><TypingDots /></span> : <ToolStatus tool={tool} />}
      </button>
    </div>
  );
}

// Human "执行模式" label per tool family — the verb in words, complementing the raw tool name shown in the
// sheet header. Mirrors toolSummary's branches; generic 调用工具 for the long tail.
function toolMode(name: string): string {
  const map: Record<string, string> = {
    Bash: '运行命令', Edit: '编辑文件', MultiEdit: '编辑文件', Write: '写入文件', Read: '读取文件',
    exec_command: '运行命令', apply_patch: '编辑文件', web__run: '联网查询', view_image: '查看图片',
    wait: '等待任务', write_stdin: '继续任务',
    NotebookEdit: '编辑笔记本', Grep: '搜索', Glob: '查找文件', WebSearch: '联网搜索', WebFetch: '读取网页',
    TodoWrite: '更新待办', Skill: '激活技能', Task: '调用 Agent', Agent: '调用 Agent',
  };
  return map[name] || '调用工具';
}

// The "执行的命令" text — the tool's most meaningful input field, else its whole input pretty-printed. Kept
// raw except for Codex's shell-launch wrapper, matching what its terminal UI shows. Empty string → the
// command section is omitted.
function toolCommandText(tool: CodexToolProjection): string {
  const n = tool.name;
  const inp = toolInput(tool);
  if (n === 'Bash') return displayCommand(inp.command);
  if (n === 'exec_command') return displayCommand(inp.cmd || inp.script);
  if (n === 'apply_patch') return inputText(inp, 'patch', 'script');
  if (n === 'view_image') return inputText(inp, 'path') || JSON.stringify(inp, null, 2);
  if (n === 'Read' || n === 'Edit' || n === 'MultiEdit' || n === 'Write') return inputText(inp, 'file_path');
  if (n === 'NotebookEdit') return inputText(inp, 'notebook_path');
  if (n === 'Grep' || n === 'Glob') return inputText(inp, 'pattern');
  if (n === 'WebSearch') return inputText(inp, 'query');
  if (n === 'WebFetch') return inputText(inp, 'url');
  if (n === 'Skill') return inputText(inp, 'command', 'skill');
  if (n === 'Task' || n === 'Agent') return inputText(inp, 'prompt', 'description');
  const keys = Object.keys(inp);
  if (!keys.length) return '';
  return JSON.stringify(inp, null, 2);
}

// Split an absolute path into its directory (with trailing /) and the filename.
function fileParts(p: string): { dir: string; name: string } {
  if (!p) return { dir: '', name: '' };
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? { dir: p.slice(0, idx + 1), name: p.slice(idx + 1) } : { dir: '', name: p };
}

// A purpose-built code-diff viewer for the edit sheet. Each row: a sticky single line-number gutter (the new
// file's number for add/context, the old for a deletion), a +/−/· sign column, then the code kept pre-
// formatted (long lines scroll horizontally without the gutter/sign leaving). Add/del rows are tinted and
// carry a coloured left bar; hunks are separated by a faint gap. Line numbers are tabular so they stay aligned.
function DiffView({ hunks }: { hunks: CodexDiffHunk[] }) {
  return (
    <div className="dv">
      {hunks.map((h, hi) => {
        const numbered = Number.isInteger(h.oldStart) && Number.isInteger(h.newStart);
        let o = Number.isInteger(h.oldStart) ? h.oldStart as number : null;
        let n = Number.isInteger(h.newStart) ? h.newStart as number : null;
        return (
          <div className="dv-hunk" key={hi}>
            {hi > 0 && <div className="dv-gap"><span>⋯</span></div>}
            {(h.lines || []).map((ln, li) => {
              const sign = typeof ln === 'string' ? ln[0] : ' ';
              const text = typeof ln === 'string' ? ln.slice(1) : '';
              let num;
              let cls;
              if (sign === '+') { num = numbered && n !== null ? n++ : null; cls = 'add'; }
              else if (sign === '-') { num = numbered && o !== null ? o++ : null; cls = 'del'; }
              else {
                num = numbered && n !== null ? n++ : null;
                if (numbered && o !== null) o++;
                cls = 'ctx';
              }
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
function toolState(tool: CodexToolProjection, running: boolean): { txt: string; cls: string } | null {
  if (running) return { txt: '执行中', cls: 'run' };
  if (tool.outcome === 'declined') return { txt: '已拒绝', cls: 'idle' };
  if (tool.outcome === 'completed' && isFileEditTool(tool)) return null;
  if (tool.outcome === 'completed') return { txt: '已结束', cls: 'idle' };
  if (tool.isError) return { txt: '失败', cls: 'err' };
  if (tool.outcome === 'success' || (tool.outcome == null && tool.result != null)) return { txt: '成功', cls: 'ok' };
  return { txt: '未返回', cls: 'idle' };
}

// Dedicated file-edit layout: the sheet becomes a code-review surface. Header is the FILE (name bold, dir
// muted), a compact meta strip (mode · state · +A/−B), then the diff fills the sheet as the main content.
// A file CREATE has no per-line patch (only a line count) → a friendly note stands in for the diff.
function EditSheetBody({
  tool, running,
}: { tool: CodexToolProjection; running: boolean }) {
  const input = toolInput(tool);
  const { dir, name } = fileParts(typeof input.file_path === 'string' ? input.file_path : '');
  const st = toolState(tool, running);
  const diff = tool.diff;
  const created = diff?.created;
  const hunks = diff?.hunks;
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
          {st && <span className={'tool-sheet-state ' + st.cls}>{st.txt}</span>}
          <DiffStat {...(tool.diff ? { diff: tool.diff } : {})} />
        </div>
        {hunks && hunks.length
          ? <div className="es-diff"><DiffView hunks={hunks} /></div>
          : created
            ? <div className="es-note">新建文件{diff?.added ? ` · 新增 ${diff.added} 行` : ''}</div>
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
function ToolSheet({
  tool, running, onClose,
}: {
  tool: CodexToolProjection | null;
  running: boolean;
  onClose: () => void;
}) {
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
                  {st && <span className={'tool-sheet-state ' + st.cls}>{st.txt}</span>}
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

function linkedAssistantHtml(text: string): string {
  const root = document.createElement('div');
  root.innerHTML = DOMPurify.sanitize(marked.parse(text || '') as string);
  // Markdown can create a native <a> for any target, including file types/protocols that the terminal's
  // shared detector deliberately does not expose. Never let those fall through to browser navigation:
  // recognized targets keep the app-owned link flow; everything else becomes ordinary rendered content.
  for (const anchor of root.querySelectorAll('a')) {
    if (!outputLinkFromAnchor(anchor)) anchor.replaceWith(...Array.from(anchor.childNodes));
  }
  const walker = document.createTreeWalker(root, 4); // NodeFilter.SHOW_TEXT
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest('a')) continue; // Markdown links are handled by the same delegated click.
    const links = findOutputLinks(node.data);
    if (!links.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const link of links) {
      fragment.append(node.data.slice(offset, link.start));
      const anchor = document.createElement('a');
      const value = link.kind === 'url' ? link.raw : link.path;
      anchor.href = value;
      anchor.dataset.handmuxOutputLink = link.kind;
      anchor.dataset.handmuxOutputValue = value;
      anchor.textContent = node.data.slice(link.start, link.end);
      fragment.append(anchor);
      offset = link.end;
    }
    fragment.append(node.data.slice(offset));
    node.replaceWith(fragment);
  }
  return root.innerHTML;
}

function AssistantMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => linkedAssistantHtml(text), [text]);
  return (
    <div className="chat-bubble chat-them chat-md"
      data-codex-stream={streaming ? 'active' : undefined}
      dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function outputLinkFromAnchor(anchor: HTMLAnchorElement): ChatOutputLink | null {
  const explicitKind = anchor.dataset.handmuxOutputLink;
  const raw = anchor.dataset.handmuxOutputValue || anchor.getAttribute('href') || '';
  const links = findOutputLinks(raw);
  const match = explicitKind ? links.find((link) => link.kind === explicitKind) : links[0];
  if (!match) return null;
  if (match.kind === 'url') {
    return {
      kind: 'url', protocol: match.protocol, port: match.port,
      urlPath: match.urlPath, raw: match.raw,
    };
  }
  return { kind: 'doc', path: match.path || raw.slice(match.start, match.end) };
}

function Bubble({
  m, running, onOpenTool, onOpenGoal,
}: {
  m: ChatMessage;
  running: boolean;
  onOpenTool: (message: ChatMessage) => void;
  onOpenGoal: (goal: CodexGoal) => void;
}): ReactNode {
  if (m.type === 'tool' && m.tool) {
    return <ToolChip tool={m.tool} running={running} onOpen={() => onOpenTool(m)} />;
  }
  if (m.type === 'goal' && m.goal) {
    return <CodexGoalCard goal={m.goal} event={m.event ?? null} onOpen={onOpenGoal} />;
  }
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
    return <AssistantMarkdown text={m.text || ''} streaming={!!m.streaming} />;
  }
  return <div className="chat-bubble chat-me">{m.text}</div>;
}

function optimisticMatches(message: ChatMessage, optimistic: CodexOutgoingItem): boolean {
  return message?.type === 'text' && message.role === 'user' && message.text === optimistic.text;
}

const NEAR_BOTTOM_PX = 40;
const NEAR_TOP_PX = 80;

// Time is shown at just two spots per exchange — under YOUR input, and under the AI's LAST reply of each
// turn (its concluding message). Intermediate assistant lines and tool chips carry none. This builds the set
// of message indices that should show a time: every user text, plus the last assistant-text before each user
// message (and the final turn's last reply). Tools/thinking never qualify and don't reset the running "last
// assistant text" pointer (a reply after a tool is still that turn's concluding line).
function timeStampedIndices(messages: ChatMessage[]): Set<number> {
  const set = new Set<number>();
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

// Format a message's ISO timestamp as a label: today → "14:32"; an earlier day →
// "7月16日 14:32". Returns null for a missing/unparseable stamp so the caller shows nothing (never a fake time).
function fmtTime(iso?: string): string | null {
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
function resolveCopyBlock(target: EventTarget | null): CopyBlock | null {
  if (!(target instanceof Element)) return null;
  const pre = target.closest<HTMLElement>('.chat-md pre');
  if (pre) return { el: pre, text: pre.innerText };
  const body = target.closest<HTMLElement>('.chat-tool-body, .chat-diff');
  if (body) return { el: body, text: body.innerText };
  const bubble = target.closest<HTMLElement>('.chat-bubble');
  if (bubble) return { el: bubble, text: bubble.innerText };
  const tool = target.closest<HTMLElement>('.chat-tool');
  if (tool) return { el: tool, text: tool.innerText };
  return null;
}

const COPY_CALLOUT_W = 72; // estimated callout width (px) for the right-edge clamp (single 拷贝 button)

function CodexApprovalGate({
  pane, approval, onAuthFail,
}: { pane: string; approval: CodexApproval; onAuthFail?: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const labels: Record<ApprovalSimpleDecision, string> = {
    accept: t('chat.approval.accept'),
    acceptForSession: t('chat.approval.acceptSession'),
    decline: t('chat.approval.decline'),
    cancel: t('chat.approval.cancel'),
  };
  const option = (decision: ApprovalDecision): { id: string; label: string; primary: boolean } | null => {
    if (typeof decision === 'string') return { id: decision, label: labels[decision] || decision, primary: decision === 'accept' };
    if (decision?.type === 'execpolicy') {
      return {
        id: decision.id,
        label: t('chat.approval.acceptRule', { rule: decision.rule?.join(' ') || '' }),
        primary: true,
      };
    }
    if (decision?.type === 'networkPolicy') {
      return {
        id: decision.id,
        label: t(decision.action === 'allow' ? 'chat.approval.allowHost' : 'chat.approval.denyHost', { host: decision.host }),
        primary: decision.action === 'allow',
      };
    }
    return null;
  };
  const decide = async (decision: string): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try { await answerCodexApproval(pane, approval.id, decision); }
    catch (err: unknown) {
      if (err instanceof UnauthorizedError) onAuthFail?.();
      else {
        const detail = errorLike(err);
        setError(detail.serverError || detail.message || t('chat.approval.failed'));
      }
      setSubmitting(false);
    }
  };
  const options = approval.decisions.map(option)
    .filter((decision): decision is NonNullable<ReturnType<typeof option>> => decision !== null);
  return (
    <div className="chat-gate codex-approval-gate" role="dialog" aria-modal="true">
      <div className="chat-gate-step">{t('chat.approval.request')}</div>
      <div className="chat-gate-prompt">{
        approval.type === 'file' ? t('chat.approval.file')
          : approval.type === 'permissions' ? t('chat.approval.permissions')
            : t('chat.approval.command')
      }</div>
      {approval.reason && <div className="chat-gate-hint">{approval.reason}</div>}
      {approval.command && <pre className="codex-approval-command">{approval.command}</pre>}
      {approval.cwd && <div className="codex-approval-cwd">{approval.cwd}</div>}
      {error && <div className="chat-turn-error">{error}</div>}
      <div className="chat-gate-actions chat-gate-decisions">
        {options.map((decision) => (
          <button key={decision.id} type="button"
            className={`chat-gate-btn${decision.primary ? ' primary' : ''}`}
            disabled={submitting} onClick={() => void decide(decision.id)}>
            <span className="chat-gate-btn-label">{decision.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function CodexInputGate({
  pane, input, onAuthFail,
}: { pane: string; input: CodexInputRequest; onAuthFail?: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const questions = input.questions || [];
  const answer = (id: string, value: string): void => {
    setAnswers((current) => ({ ...current, [id]: value }));
  };
  const complete = questions.length > 0 && questions.every((question) => answers[question.id]?.trim());
  const submit = async (): Promise<void> => {
    if (!complete || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await answerCodexInput(pane, input.id, Object.fromEntries(
        questions.map((question) => [question.id, [answers[question.id].trim()]]),
      ));
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) onAuthFail?.();
      else {
        const detail = errorLike(err);
        setError(detail.serverError || detail.message || t('chat.input.failed'));
      }
      setSubmitting(false);
    }
  };
  return (
    <div className="chat-gate codex-input-gate" role="dialog" aria-modal="true">
      <div className="chat-gate-step">{t('chat.input.request')}</div>
      {questions.map((question, index) => {
        const options = question.options || [];
        const selected = answers[question.id] || '';
        const isPreset = options.some((option) => option.label === selected);
        return (
          <section className="codex-input-question" key={question.id}>
            {(questions.length > 1 || question.header) && (
              <div className="chat-gate-step">
                {question.header || t('chat.input.step', { current: index + 1, total: questions.length })}
              </div>
            )}
            <div className="chat-gate-prompt">{question.question}</div>
            {options.length > 0 && (
              <div className="chat-gate-options" role="radiogroup">
                {options.map((option) => (
                  <button key={option.label} type="button" role="radio"
                    aria-checked={selected === option.label}
                    className={`chat-gate-opt${selected === option.label ? ' on' : ''}`}
                    onClick={() => answer(question.id, option.label)}>
                    <span className="chat-gate-opt-label">{option.label}</span>
                    {option.description && <span className="chat-gate-opt-desc">{option.description}</span>}
                  </button>
                ))}
              </div>
            )}
            {(question.isOther || options.length === 0) && (
              <input className="codex-input-text" type={question.isSecret ? 'password' : 'text'}
                value={isPreset ? '' : selected}
                placeholder={options.length ? t('chat.input.other') : t('chat.input.placeholder')}
                onChange={(event) => answer(question.id, event.target.value)} />
            )}
          </section>
        );
      })}
      {error && <div className="chat-turn-error">{error}</div>}
      <div className="chat-gate-actions">
        <button type="button" className="chat-gate-btn primary" disabled={!complete || submitting}
          onClick={() => void submit()}>{t('chat.input.submit')}</button>
      </div>
    </div>
  );
}

export default function ChatView({
  pane, agent = 'claude', kind, msg, onAuthFail, slashEcho, onSlashEchoDone,
  refreshToken = null, codexSession = null, optimisticMessages = [], actionError = null, onOptimisticCovered,
  onDocLinkTap,
}: ChatViewProps) {
  const [streamRefresh, setStreamRefresh] = useState(0);
  const transcriptRefresh = agent === 'codex'
    ? `${refreshToken ?? ''}:thread:${codexSession?.threadId ?? ''}:stream:${streamRefresh}`
    : refreshToken;
  const {
    messages, hasMoreOlder, loadOlder, loadingOlder,
    session, loaded, unavailable, unavailableDetail, applyCodexEvent,
  } = useTranscript(pane, true, agent, transcriptRefresh);
  useCodexMessageStream({
    pane,
    threadId: codexSession?.threadId ?? null,
    enabled: loaded && agent === 'codex' && !!codexSession?.managed,
    onEvent: applyCodexEvent,
    onSettled: () => setStreamRefresh((value) => value + 1),
    ...(onAuthFail ? { onAuthFail } : {}),
  });
  const historicalPlans = useMemo(() => {
    const latest = new Map<string, ChatMessage>();
    messages.forEach((message) => {
      if (message.type === 'plan' && message.turnId && codexPlanSteps(message).length) {
        latest.set(message.turnId, message);
      }
    });
    const byAnswerIndex = new Map<number, ChatMessage>();
    for (const [turnId, plan] of latest) {
      if (turnId === codexSession?.activeTurnId) continue;
      let answerIndex = -1;
      messages.forEach((message, index) => {
        if (message.turnId === turnId && message.role === 'assistant' && message.type === 'text') {
          answerIndex = index;
        }
      });
      if (answerIndex >= 0) byAnswerIndex.set(answerIndex, plan);
    }
    return byAnswerIndex;
  }, [messages, codexSession?.activeTurnId]);
  const activeStreamMessage = [...messages].reverse()
    .find((message) => message.streaming && message.text) || null;
  const tsIdx = useMemo(() => timeStampedIndices(messages), [messages]);
  // Each later compaction supersedes the previous context boundary. Keep the rollout untouched as the
  // authoritative history, but render only the newest boundary in the loaded conversation so two nearby
  // automatic compactions do not look like one duplicated UI event.
  const latestCompactIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'compact') return i;
    }
    return -1;
  }, [messages]);
  // Temporary outgoing bubbles are render-only. Capture matching durable transcript ids that already exist
  // when each bubble first appears, then let only a new rollout message cover it. This prevents an already
  // visible identical user message from swallowing a fresh send while keeping the transcript the sole history.
  const optimisticMarksRef = useRef<Map<string, Set<string>>>(new Map());
  const optimisticPaneRef = useRef(pane);
  if (optimisticPaneRef.current !== pane) {
    optimisticPaneRef.current = pane;
    optimisticMarksRef.current.clear();
  }
  const optimisticIds = new Set(optimisticMessages.map((item) => item.id));
  for (const item of optimisticMessages) {
    if (!optimisticMarksRef.current.has(item.id)) {
      optimisticMarksRef.current.set(item.id, new Set(
        messages.filter((message) => optimisticMatches(message, item)).map(messageIdentity),
      ));
    }
  }
  for (const id of optimisticMarksRef.current.keys()) {
    if (!optimisticIds.has(id)) optimisticMarksRef.current.delete(id);
  }
  // One canonical item may cover only one temporary bubble. Without this claim set, two identical sends
  // could both disappear when the first App Server message arrives.
  const claimedCanonicalIds = new Set<string>();
  const coveredOptimisticIds: string[] = [];
  const serverQueueIds = new Set((codexSession?.queue || []).map((item) => item.id));
  const serverQueueRequestIds = new Set((codexSession?.queue || []).map((item) => item.requestId)
    .filter((id): id is string => typeof id === 'string'));
  for (const item of optimisticMessages) {
    if ((item.queueId && serverQueueIds.has(item.queueId)) || serverQueueRequestIds.has(item.id)) {
      coveredOptimisticIds.push(item.id);
      continue;
    }
    const baseline = optimisticMarksRef.current.get(item.id);
    const match = messages.find((message) => {
      const identity = messageIdentity(message);
      return optimisticMatches(message, item) && !baseline?.has(identity)
        && !claimedCanonicalIds.has(identity);
    });
    if (!match) continue;
    claimedCanonicalIds.add(messageIdentity(match));
    coveredOptimisticIds.push(item.id);
  }
  const coveredOptimisticKey = coveredOptimisticIds.join('\0');
  const coveredOptimisticSet = new Set(coveredOptimisticIds);
  const visibleOptimistic = optimisticMessages.filter((item) => item.source !== 'queue'
    && !coveredOptimisticSet.has(item.id));
  useEffect(() => {
    if (coveredOptimisticIds.length) onOptimisticCovered?.(coveredOptimisticIds);
    // ids are the stable handoff contract; message array identity changes on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredOptimisticKey, onOptimisticCovered]);
  // The gate's options are scraped from the pane's on-screen menu (they're not in the transcript). Poll only
  // while Claude is blocked (kind==='permission'). If a menu is up → the rich PromptGate; if permission but
  // the menu couldn't be parsed → the generic 允许/拒绝 fallback so there's always a way to act.
  const busy = kind === 'permission';
  const claudeGate = busy && agent === 'claude';
  const sessionIssue = unavailable || (agent === 'codex' && codexSession?.error ? 'app-server-unavailable' : null);
  const sessionIssueDetail = unavailableDetail || codexSession?.error || null;
  const sessionGate = typeof sessionIssue === 'string'
    && ['session-unbound', 'session-unmanaged', 'app-server-unavailable'].includes(sessionIssue);
  const codexApproval = agent === 'codex' && codexSession?.managed ? codexSession.approvals?.[0] : null;
  const codexInput = agent === 'codex' && codexSession?.managed ? codexSession.userInputs?.[0] : null;
  const { prompt, refetch } = usePendingPrompt(pane, claudeGate, agent);
  // After the user answers, the menu vanishes from the screen instantly but `kind` stays 'permission'
  // until the slower /states poll catches up — so !prompt && busy would flash the 允许/拒绝 fallback
  // for ~1s after every 确认 (and between multi-question steps). Latch "a scraped menu WAS up this
  // episode": once one was shown, a null re-read means resolving/advancing, never "unparseable menu →
  // show the generic gate". The latch resets when the episode ends (busy → false).
  const hadPromptRef = useRef(false);
  useEffect(() => { if (prompt) hadPromptRef.current = true; }, [prompt]);
  useEffect(() => { if (!claudeGate) hadPromptRef.current = false; }, [claudeGate]);
  const fb = !prompt && claudeGate && !hadPromptRef.current ? fallbackGate() : null;

  // "Working" indicators (Task 13): state cues, not token streaming — data is polled every 1.5s.
  const last = messages.length ? messages[messages.length - 1] : null;
  const lastIsRunningTool = last?.type === 'tool' && last.tool?.result === null && kind === 'working';
  const toolRunning = lastIsRunningTool;
  // Compaction (压缩中) gets its own labeled indicator; a turn that died on an API error (error) shows a note
  // instead. Both suppress the plain typing wave — neither is "Claude generating a reply".
  const showCompacting = kind === 'compacting';
  const showError = kind === 'error';
  // Claude's optimistic slash-command echo (App sets it at send time — the jsonl scaffold only lands when the
  // command COMPLETES, minutes for /compact). It's dropped once the REAL marker takes over: a new stable
  // marker id not present when the echo appeared (so an earlier same-named marker can't kill a fresh echo),
  // or a session switch (e.g. /clear — the new
  // session's own /clear marker owns the screen now; only when both ids are known, so the very first
  // transcript load can't spuriously clear it).
  const echoMarkRef = useRef<{ ids: Set<string>; session: string | null } | null>(null);
  if (slashEcho && !echoMarkRef.current) {
    echoMarkRef.current = {
      ids: new Set(messages.filter((m) => m.type === 'slash' && m.name === slashEcho.name).map(messageIdentity)),
      session,
    };
  }
  if (!slashEcho && echoMarkRef.current) echoMarkRef.current = null;
  const echoMark = echoMarkRef.current;
  const echoCovered = !!(slashEcho && echoMark && (
    (echoMark.session && session && echoMark.session !== session)
    || messages.some((m) => m.type === 'slash' && m.name === slashEcho.name
      && !echoMark.ids.has(messageIdentity(m)))
  ));
  useEffect(() => { if (echoCovered) onSlashEchoDone?.(); }, [echoCovered, onSlashEchoDone]);
  // Managed Codex has an authoritative App Server thread status, so never infer work from a trailing user
  // bubble: only `active` (mapped to kind==='working') may show typing. Claude keeps its established bridge
  // because its Hook/state update can lag behind the transcript and has no equivalent live thread status.
  const inferredClaudeReply = agent !== 'codex' && last?.role === 'user' && kind !== 'permission';
  const showTyping = loaded && !lastIsRunningTool && !showCompacting && !showError
    && !activeStreamMessage && (kind === 'working' || inferredClaudeReply);

  const scrollRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null); // .chat-view — positioning context for the copy callout
  const stickBottomRef = useRef(true); // was the user near the bottom just before this render's messages changed?
  const followModeRef = useRef<'revealing' | 'reading' | 'following'>('following');
  const lastStreamTurnRef = useRef<string | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastScrollGestureAtRef = useRef(0);
  const prevScrollHeightRef = useRef<number | null>(null);
  const pendingPrependRef = useRef(false); // true only while a loadOlder() round-trip is in flight, so a
  // recent-window poll landing mid-flight doesn't consume the stale prevScrollHeight and jump the view.
  const lastNewestIdRef = useRef<string | null>(null);
  const lastOptimisticIdRef = useRef<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // ── Long-press copy. Native selection is disabled on .chat-scroll (CSS) so the browser's ugly system copy
  // menu never appears; instead a still ~480ms hold surfaces OUR callout (拷贝 / 复制全部) over the pressed
  // block. Touch-only (mouse/right-click keep native behaviour on desktop). The pressed block's text is
  // captured into state up front, so a background poll re-render can't strip the copy even if it drops the
  // highlight. Any new touch, a scroll, or a move past the slop cancels/dismisses.
  const [copyUI, setCopyUI] = useState<CopyUI | null>(null);
  const hlRef = useRef<HTMLElement | null>(null);
  const lpRef = useRef<LongPressState>({ timer: null, x: 0, y: 0, fired: false });

  // Tool detail sheet: store the tool message's key (not the object) so the sheet stays LIVE as polls update
  // the tool (a running tool gains its result). Resolve the current message each render; if it scrolls out of
  // the loaded window it's gone → the sheet self-closes.
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const [planSheet, setPlanSheet] = useState<CodexPlanView | null>(null);
  const [goalSheet, setGoalSheet] = useState<CodexGoal | null>(null);
  const sheetMsg = sheetKey != null ? messages.find((m) => m.type === 'tool' && messageIdentity(m) === sheetKey) : null;
  useEffect(() => { if (sheetKey != null && !sheetMsg) setSheetKey(null); }, [sheetKey, sheetMsg]);
  useEffect(() => { setPlanSheet(null); }, [pane]);

  // Android/browser Back must close the sheet and land back on the chat lens — not navigate the app away
  // (or trip the exit-confirm guard). Same overlay contract as FileManager/GitPanel: push ONE history entry
  // above useExitConfirm's guard while the sheet is open; the popstate from Back closes it. Closing via
  // ✕/backdrop/Esc/pane-switch unwinds the entry we still own — never pushState inside the popstate handler
  // (some Android WebViews drop it, unbalancing the stack).
  const sheetOpen = sheetMsg != null;
  const sheetDepthRef = useRef(0);
  useHistoryLayer(sheetOpen, () => { sheetDepthRef.current = 0; setSheetKey(null); });
  useEffect(() => {
    if (!sheetOpen) return undefined;
    window.history.pushState({ chatToolSheet: true }, '');
    sheetDepthRef.current = 1;
    return () => {
      if (sheetDepthRef.current > 0) { unwindHistory(sheetDepthRef.current); sheetDepthRef.current = 0; }
    };
  }, [sheetOpen]);

  const clearHighlight = (): void => {
    if (hlRef.current) {
      hlRef.current.classList.remove('chat-copy-hl');
      hlRef.current = null;
    }
  };
  const dismissCopy = (): void => { clearHighlight(); setCopyUI(null); };
  useBackButton(!!copyUI, dismissCopy);
  const cancelLongPress = (): void => {
    const lp = lpRef.current;
    if (lp.timer) { clearTimeout(lp.timer); lp.timer = null; }
  };

  const fireLongPress = (x: number, y: number, target: EventTarget | null): void => {
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

  const onCopyDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    dismissCopy(); // a fresh touch always clears a showing callout
    lpRef.current.fired = false;
    if (e.pointerType === 'mouse') return; // desktop keeps native selection/right-click
    const lp = lpRef.current;
    lp.x = e.clientX; lp.y = e.clientY;
    lastScrollGestureAtRef.current = Date.now();
    const { target } = e;
    cancelLongPress();
    lp.timer = setTimeout(() => fireLongPress(lp.x, lp.y, target), 480);
  };
  // A long-press fired → swallow the synthetic click it would spawn (capture phase, before the tool head's
  // onClick), so the copy callout stays up instead of the tap also opening the tool sheet.
  const onCopyClickCapture = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (lpRef.current.fired) { lpRef.current.fired = false; e.stopPropagation(); e.preventDefault(); }
  };
  const onCopyMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const lp = lpRef.current;
    if (e.pointerType !== 'mouse') lastScrollGestureAtRef.current = Date.now();
    if (lp.timer && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) cancelLongPress(); // moved → scroll, not a hold
  };

  const doCopy = async (text: string): Promise<void> => {
    try { await navigator.clipboard.writeText(text); navigator.vibrate?.(8); }
    catch { /* clipboard blocked (insecure ctx / denied) — nothing else we can do */ }
    dismissCopy();
  };

  useEffect(() => cancelLongPress, []); // clear a pending hold on unmount
  useEffect(() => {
    dismissCopy();
    setSheetKey(null);
    setPlanSheet(null);
    setGoalSheet(null);
  }, [pane]); // pane switch drops any callout / sheet

  // Gate backdrop scope: the dim must cover ONLY the chat lens (messages + composer), never the topbar /
  // window tabs above — those stay visible and tappable while a question is pending. Measure .chat-view's
  // box relative to .app (both rects in viewport coords → the difference is layout-true even when .app is
  // translateY-lifted by the Android keyboard, which also re-anchors position:fixed to .app). Re-measure on
  // viewport churn (keyboard, rotate). Falls back to full-screen (CSS inset:0) when unmeasurable (jsdom).
  const [gateMask, setGateMask] = useState<GateMask | null>(null);
  const gateUp = !!(prompt || fb || codexApproval || codexInput || sessionGate);
  useEffect(() => {
    if (!gateUp) { setGateMask(null); return; }
    const measure = (): void => {
      const view = viewRef.current;
      const app = view?.closest<HTMLElement>('.app');
      if (!view || !app) return;
      const vr = view.getBoundingClientRect();
      const ar = app.getBoundingClientRect();
      const height = ar.bottom - vr.top;
      setGateMask(height > 0 ? { top: vr.top - ar.top, height } : null);
    };
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [gateUp]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    cancelLongPress();
    if (copyUI) dismissCopy(); // scrolling dismisses the callout (its anchor is moving)
    const previousTop = lastScrollTopRef.current;
    const movingUp = el.scrollTop < previousTop - 1;
    const movingDown = el.scrollTop > previousTop + 1;
    lastScrollTopRef.current = el.scrollTop;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (movingUp && !near) {
      followModeRef.current = 'reading';
      stickBottomRef.current = false;
    } else if (near && movingDown && Date.now() - lastScrollGestureAtRef.current < 1_500) {
      followModeRef.current = 'following';
      stickBottomRef.current = true;
    } else if (followModeRef.current !== 'reading') {
      stickBottomRef.current = near;
    }
    setAtBottom(near && followModeRef.current !== 'reading');
    if (el.scrollTop < NEAR_TOP_PX && hasMoreOlder && !loadingOlder) {
      prevScrollHeightRef.current = el.scrollHeight;
      pendingPrependRef.current = true;
      void loadOlder();
    }
  };

  const scrollToBottom = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
    followModeRef.current = 'following';
    stickBottomRef.current = true;
    setAtBottom(true);
  };

  useEffect(() => {
    if (actionError?.id) scrollToBottom();
    // A new composer failure belongs at the live tail, just like the message the user attempted to send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionError?.id]);

  const onOutputLinkClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const anchor = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>('.chat-md a') : null;
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    // Every surviving anchor is app-owned. Prevent native navigation even if a malformed target somehow
    // reaches this boundary or the caller has no link handler.
    event.preventDefault();
    event.stopPropagation();
    const link = outputLinkFromAnchor(anchor);
    if (!link || !onDocLinkTap) return;
    onDocLinkTap(link, event.clientX ?? 0, event.clientY ?? 0);
  };

  // A new answer first reveals its opening. Once that bubble fills the viewport and reaches the safe top,
  // freeze there so a long stream cannot drag a reader to its ending. The existing jump button explicitly
  // opts back into following; an upward gesture always returns to reading mode.
  useEffect(() => {
    const turnId = activeStreamMessage?.turnId || null;
    if (!turnId || lastStreamTurnRef.current === turnId) return;
    lastStreamTurnRef.current = turnId;
    if (stickBottomRef.current) followModeRef.current = 'revealing';
  }, [activeStreamMessage?.turnId]);

  // Default view is pinned to the bottom (newest), like a normal chat. Priority on each messages change:
  //   1. a loadOlder() prepend just landed (pendingPrependRef set) → restore the visual position (scroll
  //      delta) so the view doesn't jump — this must win over everything else, it's mid-flight state.
  //   2. the newest message is a NEWLY-ARRIVED user message (new stable id, role==='user') — the
  //      user just sent it via the composer below (ChatView can't see the send itself) → force bottom
  //      regardless of where the view was scrolled.
  //   3. otherwise, if the view was already near the bottom → keep it stuck there.
  //   4. otherwise leave the scroll position alone.
  useEffect(() => {
    const el = scrollRef.current;
    const newest = messages.length ? messages[messages.length - 1] : null;
    const newestId = newest ? messageIdentity(newest) : null;
    const isNewTrailingUser = newest && newest.role === 'user'
      && lastNewestIdRef.current != null && newestId != null && newestId !== lastNewestIdRef.current;

    if (!el) return;
    if (pendingPrependRef.current) {
      // Do NOT advance lastNewestIdRef here: this run is preempted by the in-flight prepend restore, so it
      // never evaluates isNewTrailingUser for real. Leaving lastNewestIdRef stale means the very next
      // (non-prepend) run still sees a trailing new user message as new and force-scrolls to bottom —
      // otherwise a message sent while scrolled up (mid-prepend) would be silently marked "already seen"
      // and permanently strand the user off-screen after their own send.
      const previousHeight = prevScrollHeightRef.current;
      if (previousHeight !== null) el.scrollTop += el.scrollHeight - previousHeight;
      prevScrollHeightRef.current = null;
      pendingPrependRef.current = false;
      return;
    }
    if (newestId != null) lastNewestIdRef.current = newestId;
    if (isNewTrailingUser) {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
      followModeRef.current = 'following';
      stickBottomRef.current = true;
      setAtBottom(true);
      return;
    }
    if (!stickBottomRef.current || followModeRef.current === 'reading') return;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;

    if (followModeRef.current !== 'revealing' || !activeStreamMessage) return;
    const bubble = Array.from(el.querySelectorAll<HTMLElement>('[data-codex-stream="active"]')).at(-1);
    const viewport = el.getBoundingClientRect();
    const rect = bubble?.getBoundingClientRect();
    // jsdom has no layout (all zeroes); real geometry is required before changing this user-visible state.
    if (!rect || rect.height <= 0 || viewport.height <= 0 || rect.top > viewport.top + 12) return;
    followModeRef.current = 'reading';
    stickBottomRef.current = false;
    setAtBottom(false);
  }, [messages, showTyping, activeStreamMessage]);

  const newestOptimisticId = visibleOptimistic.at(-1)?.id || null;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && newestOptimisticId && newestOptimisticId !== lastOptimisticIdRef.current) {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
      followModeRef.current = 'following';
      stickBottomRef.current = true;
      setAtBottom(true);
    }
    lastOptimisticIdRef.current = newestOptimisticId;
  }, [newestOptimisticId]);

  // Auto-fill: when every loaded message is small the whole window is shorter than the viewport, so the
  // user CAN'T scroll up to trigger loadOlder — the page just sits half-empty with older history
  // unreachable. Pull the previous page ourselves until the viewport fills or history runs out. A first
  // measurement can legitimately be 0 while the lens/layout settles, so observe later viewport resizes too;
  // otherwise that one missed measurement leaves history unreachable for the whole mount.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const fill = () => {
      if (loadingOlder || !hasMoreOlder || messages.length === 0) return;
      if (el.clientHeight > 0 && el.scrollHeight <= el.clientHeight) {
        prevScrollHeightRef.current = el.scrollHeight;
        pendingPrependRef.current = true;
      void loadOlder();
      }
    };
    fill();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(fill);
    observer.observe(el);
    return () => observer.disconnect();
  }, [messages, hasMoreOlder, loadingOlder, loadOlder]);

  // First mount / pane switch: land at the bottom immediately (no animation to fight).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    }
    followModeRef.current = 'following';
    stickBottomRef.current = true;
    lastStreamTurnRef.current = null;
    lastScrollGestureAtRef.current = 0;
    setAtBottom(true);
    lastNewestIdRef.current = null;
  }, [pane]);

  return (
    <div className="chat-view" ref={viewRef} onClick={onOutputLinkClick}>
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}
        onPointerDown={onCopyDown} onPointerMove={onCopyMove}
        onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress}
        onWheel={() => { lastScrollGestureAtRef.current = Date.now(); }}
        onClickCapture={onCopyClickCapture}>
        {!loaded && <LensBoot hint={t('boot.loading')} />}
        {/* The first poll uses the same neutral loading view as the terminal. Only show a nudge after the
            response confirms the session is genuinely empty; never flash a fake assistant reply. */}
        {messages.length === 0 && visibleOptimistic.length === 0 && !actionError && !sessionGate && loaded
          && <div className="chat-new">{t('boot.chat_empty')}</div>}
        {messages.map((m, idx) => {
          if (m.type === 'thinking') return null; // dropped (see Bubble) — no bubble, no time
          if (m.type === 'plan') return null;
          if (m.type === 'compact' && idx !== latestCompactIndex) return null;
          const label = tsIdx.has(idx) ? fmtTime(m.ts) : null;
          const turnPlan = historicalPlans.get(idx);
          return (
            <Fragment key={messageIdentity(m)}>
              <Bubble m={m} running={toolRunning && idx === messages.length - 1}
                onOpenTool={(msg) => setSheetKey(messageIdentity(msg))}
                onOpenGoal={setGoalSheet} />
              {label && <div className={'chat-ts ' + (m.role === 'user' ? 'ts-me' : 'ts-them')}>{label}</div>}
              {turnPlan && <CodexPlanSummary plan={turnPlan} onOpen={() => setPlanSheet(turnPlan)} />}
            </Fragment>
          );
        })}
        {visibleOptimistic.map((item) => {
          const label = item.status === 'sending' ? t('chat.outgoing.sending')
            : item.status === 'accepted' ? t('chat.outgoing.sent')
              : item.status === 'steered' ? t('chat.outgoing.steered')
                : item.status === 'queued' ? t('chat.outgoing.queued') : '';
          return (
            <Fragment key={item.id}>
              <div className={`chat-bubble chat-me chat-optimistic is-${item.status}`}>{item.text}</div>
              {label && <div className={`chat-optimistic-state is-${item.status}`} role="status">{label}</div>}
            </Fragment>
          );
        })}
        {actionError && (() => {
          const fallback = actionError.kind === 'stop' ? t('chat.stopFailed')
            : actionError.kind === 'queue' ? t('chat.queue.actionFailed') : t('chat.sendFailed');
          const text = actionError.detail && actionError.detail !== fallback
            ? `${fallback}：${actionError.detail}` : fallback;
          return <div className="chat-turn-error chat-action-error" role="status">{text}</div>;
        })()}
        {slashEcho && !echoCovered && (
          <div className="chat-slash-cmd">{slashEcho.name}{slashEcho.args ? ' ' + slashEcho.args : ''}</div>
        )}
        {showCompacting && (
          <div className="chat-compacting" aria-live="polite">
            <span className="chat-compacting-label">正在压缩上下文</span>
            <TypingDots />
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
        <button type="button" className="new-output" aria-label={t('chat.scroll.latest')} onClick={scrollToBottom}>
          {t(activeStreamMessage ? 'chat.scroll.answer' : 'chat.scroll.bottom')}
        </button>
      )}

      {sheetMsg?.tool && (
        <ToolSheet
          tool={sheetMsg.tool}
          running={toolRunning && sheetMsg === messages[messages.length - 1]}
          onClose={() => setSheetKey(null)}
        />
      )}

      <CodexPlanSheet open={!!planSheet} title={t('chat.plan.historyTitle')} plan={planSheet}
        onClose={() => setPlanSheet(null)} />
      <CodexGoalMenu open={!!goalSheet} pane={pane} goalSnapshot={goalSheet}
        onClose={() => setGoalSheet(null)} {...(onAuthFail ? { onAuthFail } : {})} />

      {/* The gate (rich or fallback) is a modal bottom sheet: the backdrop dims the chat lens and,
         critically, covers the composer — a SHORT gate (e.g. the 提交/取消 review card) would otherwise leave
         the composer's quick-reply chips peeking out AND tappable above the card. Scoped to the lens (from
         .chat-view's top edge down): the topbar and window/lens tabs above stay visible and usable. */}
      {gateUp && <div className="chat-gate-backdrop"
        style={gateMask ? { top: gateMask.top + 'px', height: gateMask.height + 'px', bottom: 'auto' } : undefined} />}
      {prompt && <PromptGate pane={pane} prompt={prompt} onAct={refetch}
        {...(onAuthFail ? { onAuthFail } : {})} />}
      {fb && (
        <div className="chat-gate">
          <div className="chat-gate-prompt">{fb.prompt}</div>
          <div className="chat-gate-actions chat-gate-decisions">
            {fb.options.map((o, i) => (
              <button key={i} type="button" className="chat-gate-btn" onClick={() => sendKeys(pane, o.keys)}>
                <span className="chat-gate-btn-label">{o.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {codexApproval && <CodexApprovalGate key={codexApproval.id} pane={pane} approval={codexApproval}
        {...(onAuthFail ? { onAuthFail } : {})} />}
      {codexInput && <CodexInputGate key={codexInput.id} pane={pane} input={codexInput}
        {...(onAuthFail ? { onAuthFail } : {})} />}
      {sessionGate && (
        <div className="chat-gate chat-terminal-gate">
          <div className="chat-gate-prompt">{sessionIssue === 'session-unmanaged'
            ? t('chat.session.unmanagedTitle')
            : sessionIssue === 'app-server-unavailable' ? t('chat.session.connectionTitle') : t('chat.session.unboundTitle')}</div>
          <div className="chat-gate-hint">{sessionIssue === 'session-unmanaged'
            ? t('chat.session.unmanagedHint')
            : sessionIssue === 'app-server-unavailable'
              ? `${t('chat.session.connectionHint')}${sessionIssueDetail ? ` (${sessionIssueDetail})` : ''}`
              : t('chat.session.unboundHint')}</div>
        </div>
      )}
    </div>
  );
}
