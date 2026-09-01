import type { ReactNode } from 'react';
import { t } from '../i18n';
import {
  BotIcon,
  CheckIcon,
  CommandIcon,
  FileIcon,
  FilePenIcon,
  GlobeIcon,
  ListChecksIcon,
  PuzzleIcon,
  SearchIcon,
  WrenchIcon,
  XIcon,
} from './icons.jsx';
import { TypingDots } from './ConversationEntry.js';
import type {
  ConversationDiff,
  ConversationDiffHunk,
  ConversationToolProjection,
} from '../conversationTimelineTypes.js';
export type {
  ConversationDiff,
  ConversationDiffHunk,
  ConversationToolProjection,
} from '../conversationTimelineTypes.js';

type ToolInput = Record<string, unknown>;

function toolInput(tool: ConversationToolProjection): ToolInput {
  return Array.isArray(tool.input) ? {} : tool.input;
}

function inputText(input: ToolInput, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof input[key] === 'string') return input[key];
  }
  return '';
}

function displayCommand(command: unknown): string {
  if (Array.isArray(command)) {
    if (command.length === 3 && command[0] === '/bin/zsh' && command[1] === '-lc') {
      return String(command[2] || '');
    }
    return command.map((part) => displayCommand(part)).filter(Boolean).join('\n');
  }
  const raw = String(command || '');
  const match = raw.match(/^\/bin\/zsh\s+-lc\s+([\s\S]+)$/);
  if (!match) return raw;
  const shellArg = (match[1] ?? '').trim();
  if (shellArg.length >= 2 && shellArg[0] === "'" && shellArg.at(-1) === "'") {
    return shellArg.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (shellArg.length >= 2 && shellArg[0] === '"' && shellArg.at(-1) === '"') {
    try { return JSON.parse(shellArg) as string; } catch { return shellArg.slice(1, -1); }
  }
  return shellArg;
}

function toolSummary(tool: ConversationToolProjection): string {
  const name = tool.name || t('conversationTool.tool');
  const input = toolInput(tool);
  if (name === 'Bash') return displayCommand(input.command)
    ? t('conversationTool.runValue', { value: displayCommand(input.command) }) : t('conversationTool.run');
  if (name === 'exec_command') return displayCommand(input.cmd)
    ? t('conversationTool.runValue', { value: displayCommand(input.cmd) }) : t('conversationTool.run');
  if (name === 'apply_patch') {
    const filename = String(input.file_path || '').split(/[\\/]/).filter(Boolean).pop();
    return filename ? t('conversationTool.editValue', { value: filename }) : t('conversationTool.edit');
  }
  if (name === 'web__run') return t('conversationTool.web');
  if (name === 'view_image') return t('conversationTool.imageValue', { value: input.path || '' }).trim();
  if (name === 'wait') return t('conversationTool.wait');
  if (name === 'write_stdin') return t('conversationTool.continue');
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') {
    return t(name === 'Write' ? 'conversationTool.writeValue' : 'conversationTool.editValue',
      { value: input.file_path || '' }).trim();
  }
  if (name === 'Read') return t('conversationTool.readValue', { value: input.file_path || input.notebook_path || '' }).trim();
  if (name === 'NotebookEdit') return t('conversationTool.editValue', { value: input.notebook_path || '' }).trim();
  if (name === 'Grep') return t('conversationTool.searchValue', { value: input.pattern || '' }).trim();
  if (name === 'Glob') return t('conversationTool.findValue', { value: input.pattern || '' }).trim();
  if (name === 'WebSearch') return t('conversationTool.webSearchValue', { value: input.query || '' }).trim();
  if (name === 'WebFetch') return t('conversationTool.webReadValue', { value: input.url || '' }).trim();
  if (name === 'TodoWrite') return t('conversationTool.todo');
  if (name === 'Skill') return t('conversationTool.skillValue', { value: input.command || input.skill || '' }).trim();
  if (name === 'Task' || name === 'Agent') {
    return t('conversationTool.agentValue', {
      value: `${input.subagent_type ? `(${input.subagent_type})` : ''}: ${input.description || ''}`,
    }).trim();
  }
  return t('conversationTool.callValue', { value: name });
}

function toolIcon(name: string): ReactNode {
  if (name === 'Bash' || name === 'exec_command' || name === 'write_stdin') return <CommandIcon />;
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch'].includes(name)) return <FilePenIcon />;
  if (name === 'Read' || name === 'view_image') return <FileIcon />;
  if (name === 'Grep' || name === 'Glob') return <SearchIcon />;
  if (name === 'WebSearch' || name === 'WebFetch' || name === 'web__run') return <GlobeIcon />;
  if (name === 'TodoWrite') return <ListChecksIcon />;
  if (name === 'Skill') return <PuzzleIcon />;
  if (name === 'Task' || name === 'Agent') return <BotIcon />;
  return <WrenchIcon />;
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch']);

function DiffStat({ diff }: { diff?: ConversationDiff }): ReactNode {
  if (!diff || (!diff.added && !diff.removed)) return null;
  return (
    <span className="chat-tool-stat" aria-label={t('conversationTool.diffStat', {
      added: diff.added, removed: diff.removed,
    })}>
      {diff.added > 0 && <span className="cts-add">+{diff.added}</span>}
      {diff.removed > 0 && <span className="cts-del">−{diff.removed}</span>}
    </span>
  );
}

function ToolBody({ tool }: { tool: ConversationToolProjection }): ReactNode {
  if (tool.diff?.hunks?.length) {
    return (
      <div className="chat-diff">
        {tool.diff.hunks.map((hunk, hunkIndex) => (
          <div className="chat-diff-hunk" key={hunkIndex}>
            {hunk.lines.map((line, lineIndex) => {
              const tone = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
              return <div className={`chat-diff-line cd-${tone}`} key={lineIndex}>{line || ' '}</div>;
            })}
          </div>
        ))}
      </div>
    );
  }
  return tool.result != null ? <pre className="chat-tool-body">{tool.result}</pre> : null;
}

function ToolStatus({ tool }: { tool: ConversationToolProjection }): ReactNode {
  if (tool.outcome === 'declined') {
    return <span className="chat-tool-status neutral" aria-label={t('conversationTool.declined')}>
      {t('conversationTool.declined')}</span>;
  }
  if (tool.outcome === 'completed' && FILE_EDIT_TOOLS.has(tool.name)) return null;
  if (tool.outcome === 'completed') {
    return <span className="chat-tool-status neutral" aria-label={t('conversationTool.completed')}>
      {t('conversationTool.completed')}</span>;
  }
  if (tool.isError) return <span className="chat-tool-status err"
    aria-label={t('conversationTool.failed')}><XIcon /></span>;
  const hasDiff = !!(tool.diff && (tool.diff.added || tool.diff.removed));
  const succeeded = tool.outcome === 'success' || (tool.outcome == null && tool.result != null);
  return succeeded && !hasDiff
    ? <span className="chat-tool-status ok" aria-label={t('conversationTool.success')}><CheckIcon /></span> : null;
}

export function ToolChip({
  tool,
  running,
  onOpen,
}: {
  tool: ConversationToolProjection;
  running: boolean;
  onOpen: () => void;
}) {
  return (
    <div className={`chat-tool${tool.isError ? ' chat-tool-err' : ''}${running ? ' chat-tool-running' : ''}`}>
      <button type="button" className="chat-tool-head" onClick={onOpen}>
        <span className="chat-tool-ic">{toolIcon(tool.name)}</span>
        <span className="chat-tool-head-text">{toolSummary(tool)}</span>
        <DiffStat {...(tool.diff ? { diff: tool.diff } : {})} />
        {running
          ? <span className="chat-tool-head-running"><TypingDots /></span>
          : <ToolStatus tool={tool} />}
      </button>
    </div>
  );
}

function toolMode(name: string): string {
  const labels: Record<string, string> = {
    Bash: 'run', Edit: 'edit', MultiEdit: 'edit', Write: 'write', Read: 'read',
    exec_command: 'run', apply_patch: 'edit', web__run: 'web', view_image: 'image',
    wait: 'waitShort', write_stdin: 'continueShort', NotebookEdit: 'edit', Grep: 'search',
    Glob: 'find', WebSearch: 'webSearch', WebFetch: 'webRead', TodoWrite: 'todo',
    Skill: 'skill', Task: 'agent', Agent: 'agent',
  };
  return t(`conversationTool.${labels[name] || 'call'}`);
}

function toolCommandText(tool: ConversationToolProjection): string {
  const input = toolInput(tool);
  const name = tool.name;
  if (name === 'Bash') return displayCommand(input.command);
  if (name === 'exec_command') return displayCommand(input.cmd || input.script);
  if (name === 'apply_patch') return inputText(input, 'patch', 'script');
  if (name === 'view_image') return inputText(input, 'path') || JSON.stringify(input, null, 2);
  if (['Read', 'Edit', 'MultiEdit', 'Write'].includes(name)) return inputText(input, 'file_path');
  if (name === 'NotebookEdit') return inputText(input, 'notebook_path');
  if (name === 'Grep' || name === 'Glob') return inputText(input, 'pattern');
  if (name === 'WebSearch') return inputText(input, 'query');
  if (name === 'WebFetch') return inputText(input, 'url');
  if (name === 'Skill') return inputText(input, 'command', 'skill');
  if (name === 'Task' || name === 'Agent') return inputText(input, 'prompt', 'description');
  return Object.keys(input).length ? JSON.stringify(input, null, 2) : '';
}

function fileParts(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf('/');
  return index >= 0
    ? { dir: path.slice(0, index + 1), name: path.slice(index + 1) }
    : { dir: '', name: path };
}

function DiffView({ hunks }: { hunks: ConversationDiffHunk[] }) {
  return (
    <div className="dv">
      {hunks.map((hunk, hunkIndex) => {
        const numbered = Number.isInteger(hunk.oldStart) && Number.isInteger(hunk.newStart);
        let oldLine = Number.isInteger(hunk.oldStart) ? hunk.oldStart as number : null;
        let newLine = Number.isInteger(hunk.newStart) ? hunk.newStart as number : null;
        return (
          <div className="dv-hunk" key={hunkIndex}>
            {hunkIndex > 0 && <div className="dv-gap"><span>⋯</span></div>}
            {hunk.lines.map((line, lineIndex) => {
              const sign = line[0] || ' ';
              const text = line.slice(1);
              let number: number | null;
              let tone: 'add' | 'del' | 'ctx';
              if (sign === '+') {
                number = numbered && newLine !== null ? newLine++ : null;
                tone = 'add';
              } else if (sign === '-') {
                number = numbered && oldLine !== null ? oldLine++ : null;
                tone = 'del';
              }
              else {
                number = numbered && newLine !== null ? newLine++ : null;
                if (numbered && oldLine !== null) oldLine++;
                tone = 'ctx';
              }
              return (
                <div className={`dv-row dv-${tone}`} key={lineIndex}>
                  <span className="dv-ln">{number}</span>
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

function toolState(tool: ConversationToolProjection, running: boolean): { txt: string; cls: string } | null {
  if (running) return { txt: t('conversationTool.running'), cls: 'run' };
  if (tool.outcome === 'declined') return { txt: t('conversationTool.declined'), cls: 'idle' };
  if (tool.outcome === 'completed' && FILE_EDIT_TOOLS.has(tool.name)) return null;
  if (tool.outcome === 'completed') return { txt: t('conversationTool.completed'), cls: 'idle' };
  if (tool.isError) return { txt: t('conversationTool.failed'), cls: 'err' };
  if (tool.outcome === 'success' || (tool.outcome == null && tool.result != null)) {
    return { txt: t('conversationTool.success'), cls: 'ok' };
  }
  return { txt: t('conversationTool.noReturn'), cls: 'idle' };
}

function EditSheetBody({ tool, running }: { tool: ConversationToolProjection; running: boolean }) {
  const input = toolInput(tool);
  const { dir, name } = fileParts(typeof input.file_path === 'string' ? input.file_path : '');
  const state = toolState(tool, running);
  const hunks = tool.diff?.hunks;
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
          {state && <span className={`tool-sheet-state ${state.cls}`}>{state.txt}</span>}
          <DiffStat {...(tool.diff ? { diff: tool.diff } : {})} />
        </div>
        {hunks?.length
          ? <div className="es-diff"><DiffView hunks={hunks} /></div>
          : tool.diff?.created
            ? <div className="es-note">{t('conversationTool.createdFile', { added: tool.diff.added || 0 })}</div>
            : running
              ? <div className="tool-sheet-empty">{t('conversationTool.runningEllipsis')}</div>
              : <div className="tool-sheet-empty">{t('conversationTool.noChanges')}</div>}
      </div>
    </>
  );
}

export function ToolSheet({
  tool,
  running,
  onClose,
}: {
  tool: ConversationToolProjection | null;
  running: boolean;
  onClose: () => void;
}) {
  if (!tool) return null;
  const edit = !!(tool.diff && (tool.diff.hunks?.length || tool.diff.created));
  const command = toolCommandText(tool);
  const state = toolState(tool, running);
  return (
    <>
      <div className="tool-sheet-backdrop" onClick={onClose} />
      <div className={`tool-sheet${edit ? ' tool-sheet-edit' : ''}`} role="dialog" aria-modal="true">
        <div className="tool-sheet-grip" />
        <button type="button" className="cmd-close tool-sheet-x" aria-label={t('common.close')} onClick={onClose}>
          <XIcon />
        </button>
        {edit ? <EditSheetBody tool={tool} running={running} /> : (
          <>
            <div className="tool-sheet-head">
              <span className="tool-sheet-ic">{toolIcon(tool.name)}</span>
              <span className="tool-sheet-title">{tool.name || t('conversationTool.tool')}</span>
            </div>
            <div className="tool-sheet-body">
              <section className="tool-sheet-sec">
                <div className="tool-sheet-label">{t('conversationTool.mode')}</div>
                <div className="tool-sheet-mode-row">
                  <span className="tool-sheet-mode-val">{toolMode(tool.name)}</span>
                  {state && <span className={`tool-sheet-state ${state.cls}`}>{state.txt}</span>}
                </div>
              </section>
              {command && (
                <section className="tool-sheet-sec">
                  <div className="tool-sheet-label">{t('conversationTool.command')}</div>
                  <pre className="tool-sheet-cmd">{command}</pre>
                </section>
              )}
              <section className="tool-sheet-sec tool-sheet-out">
                <div className="tool-sheet-label"><span>{t('conversationTool.output')}</span></div>
                {tool.result != null
                  ? <ToolBody tool={tool} />
                  : <div className="tool-sheet-empty">{running
                    ? t('conversationTool.runningEllipsis') : t('conversationTool.noOutput')}</div>}
              </section>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export interface CopyBlock {
  el: HTMLElement;
  text: string;
}

export function resolveConversationCopyBlock(target: EventTarget | null): CopyBlock | null {
  if (!(target instanceof Element)) return null;
  const copy = (element: HTMLElement): CopyBlock => ({
    el: element,
    text: element.innerText || element.textContent || '',
  });
  const pre = target.closest<HTMLElement>('.chat-md pre');
  if (pre) return copy(pre);
  const body = target.closest<HTMLElement>('.chat-tool-body, .chat-diff');
  if (body) return copy(body);
  const error = target.closest<HTMLElement>([
    '.chat-turn-error',
    '.agent-conversation-item-error',
    '.chat-history-retry',
    '.agent-conversation-empty.is-error',
  ].join(', '));
  if (error) return copy(error);
  const bubble = target.closest<HTMLElement>('.chat-bubble');
  if (bubble) return copy(bubble);
  const notice = target.closest<HTMLElement>('.chat-turn-notice, .chat-interrupt');
  if (notice) return copy(notice);
  const tool = target.closest<HTMLElement>('.chat-tool');
  return tool ? copy(tool) : null;
}
