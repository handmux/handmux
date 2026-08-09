import type { CodexDiff, CodexDiffHunk, CodexToolProjection } from './codexToolProtocol.js';

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface AppServerChange {
  path?: unknown;
  diff?: unknown;
  kind?: { type?: unknown } | null;
}

interface AppServerItem {
  type?: unknown;
  changes?: AppServerChange[] | null;
}

interface AppServerTurn {
  id?: unknown;
  items?: AppServerItem[] | null;
}

interface AppServerThread {
  turns?: AppServerTurn[] | null;
}

export interface CodexMessageProjection {
  [key: string]: unknown;
  turnId?: unknown;
  tool?: CodexToolProjection | null;
}

function changedLines(lines: string[]): string[] {
  return lines.filter((line) => /^[+-]/.test(line)
    && !line.startsWith('+++') && !line.startsWith('---'));
}

export function parseUnifiedDiff(value: unknown, { created = false }: { created?: boolean } = {}): CodexDiff {
  const lines = String(value || '').split('\n');
  let added = 0;
  let removed = 0;
  const hunks: CodexDiffHunk[] = [];
  let current: CodexDiffHunk | null = null;
  const flush = () => {
    if (current?.lines.length) hunks.push(current);
    current = null;
  };

  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      flush();
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    if (current && /^[ +\-]/.test(line) && !line.startsWith('+++') && !line.startsWith('---')) {
      current.lines.push(line);
    }
  }
  flush();
  return {
    added,
    removed,
    hunks: hunks.length ? hunks : null,
    ...(created ? { created: true } : {}),
  };
}

function applyPatchSection(value: unknown, path: string): string[] {
  const lines = String(value || '').split('\n');
  let active = false;
  const section = [];
  for (const line of lines) {
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      if (active) break;
      active = header[1].trim() === path;
      continue;
    }
    if (active && line === '*** End Patch') break;
    if (active) section.push(line);
  }
  return section;
}

function diffKey(lines: string[]): string {
  return changedLines(lines).join('\0');
}

function sameFilePath(left: unknown, right: unknown): boolean {
  const a = String(left || '').replaceAll('\\', '/').replace(/^\.\//, '');
  const b = String(right || '').replaceAll('\\', '/').replace(/^\.\//, '');
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function candidateDiffs(thread: AppServerThread | null | undefined) {
  const candidates: Array<{ turnId: string | null; path: string; key: string; diff: CodexDiff }> = [];
  for (const turn of thread?.turns || []) {
    for (const item of turn?.items || []) {
      if (item?.type !== 'fileChange') continue;
      for (const change of item.changes || []) {
        const diff = parseUnifiedDiff(change?.diff, { created: change?.kind?.type === 'add' });
        if (!diff.hunks) continue;
        candidates.push({
          turnId: typeof turn.id === 'string' && turn.id ? turn.id : null,
          path: typeof change?.path === 'string' ? change.path : '',
          key: diffKey(String(change?.diff || '').split('\n')),
          diff,
        });
      }
    }
  }
  return candidates;
}

export function enrichCodexFileDiffs<T extends CodexMessageProjection>(
  messages: T[],
  thread: AppServerThread | null | undefined,
): T[] {
  const candidates = candidateDiffs(thread);
  const used = new Set<number>();
  return messages.map((message) => {
    const tool = message?.tool;
    const positioned = tool?.diff?.hunks?.length
      && tool.diff.hunks.every((hunk) => Number.isInteger(hunk.oldStart) && Number.isInteger(hunk.newStart));
    if (tool?.name !== 'apply_patch' || !tool.diff || positioned) return message;
    const targetDiff = tool.diff;
    const input = Array.isArray(tool.input) ? null : tool.input;
    const path = typeof input?.file_path === 'string' ? input.file_path : '';
    const key = diffKey(applyPatchSection(input?.patch, path));
    const matches = (candidate: (typeof candidates)[number], index: number) => !used.has(index)
      && sameFilePath(candidate.path, path)
      && candidate.diff.added === targetDiff.added
      && candidate.diff.removed === targetDiff.removed
      && (!message.turnId || !candidate.turnId || candidate.turnId === message.turnId);
    let index = candidates.findIndex((candidate, candidateIndex) => matches(candidate, candidateIndex)
      && (!key || !candidate.key || candidate.key === key));
    if (index < 0 && !key) index = candidates.findIndex(matches);
    if (index < 0) return message;
    used.add(index);
    return { ...message, tool: { ...tool, diff: candidates[index].diff } } as T;
  });
}
