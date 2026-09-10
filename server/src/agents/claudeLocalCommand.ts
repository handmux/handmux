import fs from 'node:fs';
import path from 'node:path';
import { isSessionUuid } from './scanUtils.js';

const METADATA = new Set(['last-prompt', 'ai-title', 'mode', 'permission-mode', 'file-history-snapshot']);
const record = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

// undefined: no native evidence newer than the Hook. null: newer history is not a proven completion.
// Keeping those separate prevents falling back from a native completion token to an older Hook token
// while another user turn is being appended, which would look like an additional completion to Core.
export function claudeLocalCommandCompletion(
  payload: Record<string, unknown>, after: number, now: number,
): string | null | undefined {
  const sessionId = payload.session_id;
  const file = payload.transcript_path;
  if (!isSessionUuid(sessionId) || typeof file !== 'string'
    || path.basename(file) !== `${sessionId}.jsonl`) return undefined;
  let lines: string[];
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, 65536);
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, size - length);
      const text = buffer.subarray(0, read).toString('utf8');
      if (text && !text.endsWith('\n')) return null;
      lines = text.split('\n');
      if (size > length) lines.shift();
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const native: Record<string, unknown>[] = [];
  for (let index = lines.length - 1; index >= 0 && native.length < 2; index--) {
    if (!lines[index]?.trim()) continue;
    let item;
    try { item = record(JSON.parse(lines[index]!)); } catch { return null; }
    if (!item) return null;
    if (typeof item.type === 'string' && METADATA.has(item.type)) continue;
    const timestamp = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN;
    if (!Number.isFinite(timestamp)) return null;
    if (timestamp <= after && !native.length) return undefined;
    if (timestamp > now) return null;
    native.unshift(item);
  }
  if (!native.length) return undefined;
  if (native.length !== 2) return null;
  const [command, output] = native as [Record<string, unknown>, Record<string, unknown>];
  for (const item of native) {
    if (item.type !== 'user' || item.sessionId !== sessionId || item.isMeta === true
      || item.isCompactSummary === true || item.isSidechain === true || !isSessionUuid(item.uuid)
      || record(item.message)?.role !== 'user') return null;
  }
  const commandText = record(command.message)?.content;
  const outputText = record(output.message)?.content;
  if (typeof commandText !== 'string' || typeof outputText !== 'string'
    || !/^\s*<command-name>\/[a-z][\w-]*<\/command-name>(?:\s*<command-message>[^<>]*<\/command-message>)?(?:\s*<command-args>[^<>]*<\/command-args>)?\s*$/i.test(commandText)
    || !/^\s*<local-command-stdout>[\s\S]+<\/local-command-stdout>\s*$/.test(outputText)
    || output.parentUuid !== command.uuid
    || Date.parse(String(output.timestamp)) < Date.parse(String(command.timestamp))) return null;
  if (Date.parse(String(command.timestamp)) <= after) {
    // PostCompact already supplies the completion edge before /compact's stdout is appended.
    return /^\s*<command-name>\/compact<\/command-name>/i.test(commandText) ? undefined : null;
  }
  return `claude-local-command:${sessionId}:${output.uuid}`;
}
