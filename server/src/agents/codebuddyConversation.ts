// The CodeBuddy Conversation adapter: the binding between a CodeBuddy session's JSONL log and the shared
// conversation model. Everything generic is reused — the append-aware reader (transcriptReader), the item
// model and its safety clipping (conversationProjectionSafety), the pump/Core in agent-runtime/conversation
// — so this module answers only what is CodeBuddy's: where its logs live, how they parse, and what a
// delivery or an interrupt means for its pane.
//
// The shape mirrors Claude's adapter on purpose: same page/cursor semantics, same live-poll reconciliation
// (a CodeBuddy session writes its JSONL itself, so there is no push channel to subscribe to), same receipt
// vocabulary for a send. Two deliberate differences:
//   - No diff is read from a structured patch: CodeBuddy logs no patch. Its Edit result DOES carry the
//     provider's own `renderer: {type:'diff'}` plus the call's old/new strings, so a diff item is derived
//     from those — a file RENDERED as a diff by the provider, never a guess about what changed.
//   - No history reordering: CodeBuddy appends in display order (Claude needs an adjacency fix for its
//     compaction scaffold), so the session id alone is the view epoch.
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AgentRunRef, AgentSessionRef } from '../agent-runtime/run.js';
import type {
  AgentConversationAdapterV1,
  ConversationAdapterEventSink,
  ConversationAdapterPage,
  ConversationDispatchGuard,
  ConversationDispatchReceipt,
  ConversationItem,
  ConversationPromptRequest,
  InterruptReceipt,
} from '../agent-runtime/conversationTypes.js';
import { createCodeBuddyTranscriptParser } from './codebuddyTranscriptParse.js';
import type { TranscriptMessage, TranscriptTool } from '../transcriptParse.js';
import { transcriptReader } from '../transcriptReader.js';
import type { TranscriptReader } from '../transcriptReader.js';
import { codebuddyProjectsDir } from './codebuddy.js';
import { isSessionUuid } from './scanUtils.js';
import {
  clipConversationText as clipped,
  safeProviderDiffPath,
  sanitizeToolInputWithMetadata,
  sanitizeToolResultText,
} from './conversationProjectionSafety.js';

export interface CodeBuddyConversationSessionBinding {
  sessionId?: string | null;
  transcriptPath?: string | null;
  cwd?: string | null;
  agent?: string | null;
}

export interface CodeBuddyConversationSessionSource {
  paneSession(paneId: string): CodeBuddyConversationSessionBinding | null;
}

export interface CodeBuddyConversationControl {
  sendPrompt(paneId: string, text: string, guard?: ConversationDispatchGuard): Promise<unknown>;
  interrupt(paneId: string): Promise<unknown>;
}

export interface CodeBuddyConversationAdapterOptions {
  projectsRoot?: string;
  sessions?: CodeBuddyConversationSessionSource | null;
  reader?: TranscriptReader;
  findSessionFile?: (root: string, sessionId: string) => Promise<string | null>;
  control?: CodeBuddyConversationControl;
  livePollMs?: number;
}

function isRun(target: AgentSessionRef | AgentRunRef): target is AgentRunRef {
  return 'runId' in target;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

async function safeRoot(root: string): Promise<string | null> {
  try {
    const resolved = await fsp.realpath(root);
    return (await fsp.stat(resolved)).isDirectory() ? resolved : null;
  } catch { return null; }
}

async function safeBoundFile(
  root: string,
  sessionId: string,
  candidate: string,
): Promise<string | null> {
  if (!path.isAbsolute(candidate) || path.basename(candidate) !== `${sessionId}.jsonl`) return null;
  const resolvedRoot = await safeRoot(root);
  if (!resolvedRoot) return null;
  try {
    const parent = await fsp.realpath(path.dirname(candidate));
    if (!inside(resolvedRoot, parent)) return null;
    try {
      const resolvedFile = await fsp.realpath(candidate);
      const stat = await fsp.stat(resolvedFile);
      return stat.isFile() && inside(resolvedRoot, resolvedFile) ? resolvedFile : null;
    } catch {
      // The session can be bound just before CodeBuddy creates its JSONL: the verified parent and the exact
      // UUID filename still make this a safe empty history, and a later read picks the file up.
      return path.join(parent, path.basename(candidate));
    }
  } catch { return null; }
}

// CodeBuddy stores one session per encoded-cwd project directory, exactly like Claude. Discovery scans for
// the exact UUID filename and rejects ambiguity rather than guessing by cwd or mtime.
export async function findCodeBuddySessionFile(root: string, sessionId: string): Promise<string | null> {
  if (!isSessionUuid(sessionId)) return null;
  const resolvedRoot = await safeRoot(root);
  if (!resolvedRoot) return null;
  let projects;
  try { projects = await fsp.readdir(resolvedRoot, { withFileTypes: true }); } catch { return null; }
  const matches: string[] = [];
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const candidate = path.join(resolvedRoot, project.name, `${sessionId}.jsonl`);
    try {
      const resolved = await fsp.realpath(candidate);
      if (inside(resolvedRoot, resolved) && (await fsp.stat(resolved)).isFile()) matches.push(resolved);
    } catch { /* not this project */ }
    if (matches.length > 1) return null;
  }
  return matches[0] ?? null;
}

function sourceViewId(sessionId: string): string {
  return `codebuddy-session:${sessionId}`;
}

function sourceTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function itemBase(message: TranscriptMessage, sessionId: string, id: string) {
  const createdAt = sourceTime(message.ts);
  return {
    id,
    sessionId,
    status: 'complete' as const,
    ...(createdAt === undefined ? {} : { sourceCreatedAt: createdAt }),
  };
}

function textItem(
  message: TranscriptMessage,
  sessionId: string,
  id: string,
  role: 'user' | 'assistant',
  value: string,
): ConversationItem {
  const output = clipped(value);
  return {
    ...itemBase(message, sessionId, id),
    kind: 'message',
    role,
    content: [{ type: 'text', text: output.text }],
    ...(output.truncated ? {
      status: 'truncated' as const,
      truncation: { reason: 'size_limit' as const, originalBytes: output.originalBytes },
    } : {}),
  };
}

// The call's own old/new strings, in the same +/- line shape Claude's structured patch produces, so the
// shared diff chip renders it without a provider-specific branch.
function derivedPatch(oldText: string, newText: string): string {
  const lines: string[] = [];
  for (const line of oldText.split('\n')) if (line) lines.push(`-${line}`);
  for (const line of newText.split('\n')) if (line) lines.push(`+${line}`);
  return lines.join('\n');
}

function editedStrings(input: unknown): { oldText: string; newText: string } | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const fields = input as Record<string, unknown>;
  const oldText = typeof fields.old_string === 'string' ? fields.old_string : null;
  const newText = typeof fields.new_string === 'string' ? fields.new_string : null;
  // Only a replacement carries both halves; a Write/create has content only, and inventing the "before"
  // side of a new file would be a guess, so it stays a plain tool call.
  if (oldText === null || newText === null) return null;
  return { oldText, newText };
}

function toolItems(
  message: TranscriptMessage,
  sessionId: string,
  id: string,
  tool: TranscriptTool,
): ConversationItem[] {
  const callId = `${id}:call`;
  const name = clipped(tool.name || 'tool', 512).text || 'tool';
  const inputProjection = sanitizeToolInputWithMetadata(tool.input);
  const input = inputProjection.value;
  const items: ConversationItem[] = [{
    ...itemBase(message, sessionId, callId),
    kind: 'tool_call',
    callId,
    name,
    ...(input === undefined ? {} : { input }),
    ...(inputProjection.truncated ? {
      status: 'truncated' as const,
      truncation: { reason: 'size_limit' as const, originalBytes: inputProjection.originalBytes },
    } : {}),
  }];
  if (tool.result !== null && tool.result.length > 0) {
    const output = sanitizeToolResultText(tool.result);
    items.push({
      ...itemBase(message, sessionId, `${id}:result`),
      kind: 'tool_result',
      callId,
      content: [{ type: 'text', text: output.text }],
      ...(tool.isError ? { isError: true } : {}),
      ...(output.truncated ? {
        status: 'truncated' as const,
        truncation: { reason: 'size_limit' as const, originalBytes: output.originalBytes },
      } : {}),
    });
  }
  const edited = editedStrings(tool.input);
  if (edited && !tool.isError) {
    const rawPath = (tool.input as Record<string, unknown>).file_path;
    const providerPath = safeProviderDiffPath(rawPath);
    const patch = sanitizeToolResultText(derivedPatch(edited.oldText, edited.newText));
    const removed = edited.oldText.split('\n').filter((line) => line).length;
    const added = edited.newText.split('\n').filter((line) => line).length;
    items.push({
      ...itemBase(message, sessionId, `${id}:diff`),
      kind: 'diff',
      ...(providerPath === undefined ? {} : { path: providerPath }),
      ...(patch.text ? { patch: patch.text } : {}),
      summary: `+${added} -${removed}`,
      ...(patch.truncated ? {
        status: 'truncated' as const,
        truncation: { reason: 'size_limit' as const, originalBytes: patch.originalBytes },
      } : {}),
    });
  }
  return items;
}

function projectMessage(
  message: TranscriptMessage,
  sessionId: string,
  ordinal: number,
): ConversationItem[] {
  const id = `codebuddy:${message.i}:${ordinal}:${message.type}`;
  // The parser keeps a public reasoning projection, but the shared model has no place to show it (Claude's
  // adapter drops thinking for the same reason), so it never becomes an item.
  if (message.type === 'thinking') return [];
  if (message.type === 'text' && message.role && typeof message.text === 'string' && message.text) {
    return [textItem(message, sessionId, id, message.role, message.text)];
  }
  if (message.type === 'tool' && message.tool) return toolItems(message, sessionId, id, message.tool);
  if (message.type === 'compact') {
    const summary = typeof message.summary === 'string' && message.summary
      ? clipped(message.summary) : null;
    const truncated = message.summaryTruncated === true || summary?.truncated === true;
    const originalBytes = typeof message.summaryOriginalBytes === 'number'
      ? message.summaryOriginalBytes : summary?.originalBytes;
    return [{
      ...itemBase(message, sessionId, id), kind: 'compaction',
      ...(summary ? { summary: summary.text } : {}),
      ...(truncated ? {
        status: 'truncated' as const,
        truncation: { reason: 'size_limit' as const, originalBytes: originalBytes ?? 0 },
      } : {}),
    }];
  }
  if (message.type === 'slash') {
    const command = `${message.name ?? '/command'}${message.args ? ` ${message.args}` : ''}`;
    // /compact begins as the user's own message: keeping that role lets the Core replace the optimistic
    // local bubble with the canonical occurrence, exactly as Claude's adapter does.
    if (message.name?.toLowerCase() === '/compact') {
      return [textItem(message, sessionId, id, 'user', command)];
    }
    return [{
      ...itemBase(message, sessionId, id), kind: 'notice', level: 'info',
      code: 'slash_command', message: clipped(command, 4096).text,
    }];
  }
  return [];
}

export function createCodeBuddyConversationAdapter({
  projectsRoot = codebuddyProjectsDir(),
  sessions = null,
  reader = transcriptReader,
  findSessionFile = findCodeBuddySessionFile,
  control,
  livePollMs = 750,
}: CodeBuddyConversationAdapterOptions = {}): AgentConversationAdapterV1 {
  if (!path.isAbsolute(projectsRoot)) {
    throw new TypeError('CodeBuddy Conversation adapter requires an absolute projects root');
  }
  if (!Number.isFinite(livePollMs) || livePollMs <= 0) {
    throw new TypeError('CodeBuddy Conversation adapter requires a positive live poll interval');
  }
  const boundFiles = new Map<string, string>();

  async function fileForSession(sessionId: string): Promise<string | null> {
    const bound = boundFiles.get(sessionId);
    if (bound) return bound;
    return findSessionFile(projectsRoot, sessionId);
  }

  async function discoverFile(target: AgentSessionRef | AgentRunRef): Promise<string | null> {
    if (!isSessionUuid(target.sessionId)) return null;
    if (!isRun(target)) return fileForSession(target.sessionId);
    const binding = sessions?.paneSession(target.paneId);
    if (!binding || (binding.agent !== undefined && binding.agent !== null && binding.agent !== 'codebuddy')) {
      return null;
    }
    const bindingId = binding.sessionId
      ?? (binding.transcriptPath ? path.basename(binding.transcriptPath, '.jsonl') : null);
    if (bindingId !== target.sessionId) return null;
    if (!binding.transcriptPath) return fileForSession(target.sessionId);
    const file = await safeBoundFile(projectsRoot, target.sessionId, binding.transcriptPath);
    if (file) boundFiles.set(target.sessionId, file);
    return file;
  }

  function project(messages: readonly TranscriptMessage[], sessionId: string) {
    return messages.flatMap((message, ordinal) => projectMessage(message, sessionId, ordinal));
  }

  async function readPage(
    session: AgentSessionRef,
    request: { beforeSourceCursor?: string; limit: number },
  ): Promise<ConversationAdapterPage> {
    const file = await fileForSession(session.sessionId);
    const parsed = file ? await reader.read(file, createCodeBuddyTranscriptParser) : [];
    const all = project(parsed, session.sessionId);
    let end = all.length;
    if (request.beforeSourceCursor !== undefined) {
      if (!/^\d+$/.test(request.beforeSourceCursor)) throw new Error('Invalid CodeBuddy source cursor');
      const cursor = Number(request.beforeSourceCursor);
      if (!Number.isSafeInteger(cursor)) throw new Error('Invalid CodeBuddy source cursor');
      end = Math.min(cursor, all.length);
    }
    const start = Math.max(0, end - request.limit);
    return {
      sessionId: session.sessionId,
      sourceViewId: sourceViewId(session.sessionId),
      sourceHistoryToken: createHash('sha256').update(JSON.stringify(all)).digest('hex'),
      items: all.slice(start, end),
      ...(start > 0 ? { previousSourceCursor: String(start) } : {}),
      hasMore: start > 0,
    };
  }

  return {
    apiVersion: 1,
    async discoverNative(target) {
      if (target.agentId !== 'codebuddy' || !target.sessionId) return null;
      const file = await discoverFile(target);
      if (!file) return null;
      boundFiles.set(target.sessionId, file);
      return {
        session: { agentId: 'codebuddy', sessionId: target.sessionId },
        ...(isRun(target) ? { run: target } : {}),
        sourceViewId: sourceViewId(target.sessionId),
        capabilities: isRun(target) && control ? {
          history: true, live: 'settled', sendable: true, send: ['prompt'], interrupt: true,
          // Verified live on 2.156.0: a prompt typed while a tool is running is accepted by the editor and
          // the TUI reports "Messages to be submitted after next tool call", then submits it into the same
          // turn. So an ordinary send does not have to wait for idle.
          promptWhileActive: true,
        } : { history: true, live: 'poll' },
      };
    },
    readNativePage: readPage,
    ...(control ? {
      async observeNative(run, sink: ConversationAdapterEventSink) {
        const sessionId = run.ref.sessionId;
        if (!sessionId) throw new Error('CodeBuddy Conversation run has no session');
        const session = { agentId: 'codebuddy', sessionId } as const;
        const baseline = await readPage(session, { limit: 1 });
        let sourceSequence = 0;
        let historyToken = baseline.sourceHistoryToken;
        let closed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let tail = Promise.resolve();
        const close = (): void => {
          closed = true;
          if (timer) clearTimeout(timer);
          timer = undefined;
        };
        const schedule = (): void => {
          if (closed || run.signal.aborted) return;
          timer = setTimeout(() => {
            tail = tail.then(async () => {
              if (closed || run.signal.aborted) return;
              const next = await readPage(session, { limit: 1 });
              if (next.sourceViewId !== baseline.sourceViewId) {
                close();
                await sink({
                  type: 'stream.gap', sourceSequence: ++sourceSequence,
                  afterSourceSequence: sourceSequence - 1,
                });
                return;
              }
              if (next.sourceHistoryToken !== historyToken) {
                historyToken = next.sourceHistoryToken;
                await sink({
                  type: 'history.committed',
                  sourceSequence: ++sourceSequence,
                  sourceViewId: next.sourceViewId,
                  sourceHistoryToken: next.sourceHistoryToken,
                });
              }
            }).catch(async () => {
              if (closed || run.signal.aborted) return;
              await Promise.resolve(sink({
                type: 'stream.gap', sourceSequence: ++sourceSequence,
                afterSourceSequence: Math.max(0, sourceSequence - 1),
              })).catch(close);
            }).finally(schedule);
          }, livePollMs);
          timer.unref?.();
        };
        const onAbort = (): void => close();
        run.signal.addEventListener('abort', onAbort, { once: true });
        schedule();
        return {
          checkpoint: { sourceViewId: baseline.sourceViewId, sourceSequence },
          close() {
            run.signal.removeEventListener('abort', onAbort);
            close();
          },
        };
      },
      async dispatchPrompt(
        run,
        request: ConversationPromptRequest,
        guard,
      ): Promise<ConversationDispatchReceipt> {
        try {
          const result = await (guard
            ? control.sendPrompt(run.ref.paneId, request.text, guard)
            : control.sendPrompt(run.ref.paneId, request.text));
          if (result && typeof result === 'object'
            && (result as { nativeMutation?: unknown }).nativeMutation === false) {
            if ((result as { reason?: unknown }).reason === 'terminal_draft_conflict') {
              return { outcome: 'rejected', nativeMutation: false, reason: 'terminal_draft_conflict' };
            }
            return { outcome: 'busy', nativeMutation: false };
          }
          return { outcome: 'accepted' };
        } catch {
          return { outcome: 'unknown', nativeMutation: 'unknown', reason: 'delivery_unconfirmed' };
        }
      },
      async dispatchInterrupt(run): Promise<InterruptReceipt> {
        await control.interrupt(run.ref.paneId);
        return { status: 'accepted' };
      },
    } : {}),
  };
}
