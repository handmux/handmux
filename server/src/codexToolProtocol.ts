export interface CodexDiffHunk {
  oldStart: number | null;
  newStart: number | null;
  lines: string[];
}

export interface CodexDiff {
  [key: string]: unknown;
  added: number;
  removed: number;
  hunks: CodexDiffHunk[] | null;
  created?: true;
}

export type CodexToolOutcome = 'running' | 'success' | 'failed' | 'declined' | 'completed';
export type CodexToolInput = Record<string, unknown> | unknown[];

export interface CodexToolProjection {
  [key: string]: unknown;
  name: string;
  input: CodexToolInput;
  result: string | null;
  isError: boolean;
  outcome?: CodexToolOutcome;
  diff?: CodexDiff;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positionOf(value: unknown): number | null | undefined {
  return value === null ? null : Number.isInteger(value) ? value as number : undefined;
}

export function parseCodexDiff(value: unknown): CodexDiff | null {
  const record = recordOf(value);
  if (!record || !Number.isInteger(record.added) || !Number.isInteger(record.removed)
    || (record.added as number) < 0 || (record.removed as number) < 0) return null;
  let hunks: CodexDiffHunk[] | null = null;
  if (record.hunks !== null) {
    if (!Array.isArray(record.hunks)) return null;
    hunks = [];
    for (const candidate of record.hunks) {
      const hunk = recordOf(candidate);
      if (!hunk) return null;
      const oldStart = positionOf(hunk.oldStart);
      const newStart = positionOf(hunk.newStart);
      if (oldStart === undefined || newStart === undefined
        || !Array.isArray(hunk.lines) || hunk.lines.some((line) => typeof line !== 'string')) return null;
      hunks.push({ oldStart, newStart, lines: hunk.lines });
    }
  }
  if (record.created != null && record.created !== true) return null;
  return {
    ...record,
    added: record.added as number,
    removed: record.removed as number,
    hunks,
    ...(record.created === true ? { created: true } : {}),
  } as CodexDiff;
}

export function parseCodexToolProjection(value: unknown): CodexToolProjection | null {
  const record = recordOf(value);
  if (!record || typeof record.name !== 'string' || !record.name
    || typeof record.isError !== 'boolean'
    || (record.result !== null && typeof record.result !== 'string')) return null;
  const input = Array.isArray(record.input) ? record.input : recordOf(record.input);
  if (!input) return null;
  const outcomes: readonly CodexToolOutcome[] = ['running', 'success', 'failed', 'declined', 'completed'];
  const outcome = record.outcome == null
    ? undefined
    : outcomes.find((candidate) => candidate === record.outcome);
  if (record.outcome != null && !outcome) return null;
  const diff = record.diff == null ? undefined : parseCodexDiff(record.diff);
  if (record.diff != null && !diff) return null;
  return {
    ...record,
    name: record.name,
    input,
    result: record.result,
    isError: record.isError,
    ...(outcome ? { outcome } : {}),
    ...(diff ? { diff } : {}),
  } as CodexToolProjection;
}
