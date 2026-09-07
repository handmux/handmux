import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { defaultRun, isSessionUuid } from './scanUtils.js';
import { rolloutSessionId } from './codex.js';
import type { RunCommand } from './scanUtils.js';

interface JsonRecord { [key: string]: unknown }

export interface CodexOpenSession {
  sessionId: string;
  file: string;
  cwd: string;
  fd: string;
  device: string;
  inode: string;
}

interface OpenFile {
  fd: string;
  file: string;
}

export interface CodexOpenSessionOptions {
  platform?: NodeJS.Platform;
  run?: RunCommand;
  fs?: Pick<typeof fsp, 'readdir' | 'readlink' | 'realpath' | 'stat' | 'open'>;
}

const MAX_SESSION_META_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function lsofOpenFiles(value: unknown): OpenFile[] {
  const files: OpenFile[] = [];
  let fd = '';
  for (const line of String(value || '').split('\n')) {
    if (line[0] === 'f') {
      fd = line.slice(1).trim();
      continue;
    }
    if (line[0] === 'n' && fd) files.push({ fd, file: line.slice(1) });
  }
  return files;
}

async function procOpenFiles(
  pid: number,
  fs: Pick<typeof fsp, 'readdir' | 'readlink'>,
): Promise<OpenFile[]> {
  const directory = `/proc/${pid}/fd`;
  let names: string[];
  try { names = await fs.readdir(directory); } catch { return []; }
  const files: OpenFile[] = [];
  for (const fd of names) {
    if (!/^\d+$/.test(fd)) continue;
    try {
      const file = await fs.readlink(path.join(directory, fd));
      // Linux appends this marker after the original path once the directory entry is gone. A deleted
      // rollout cannot be resumed by id, so it is never a takeover candidate.
      if (file && !file.endsWith(' (deleted)')) files.push({ fd, file });
    } catch { /* the descriptor closed while enumerating */ }
  }
  return files;
}

async function readFirstLine(
  file: string,
  fs: Pick<typeof fsp, 'open'>,
): Promise<string | null> {
  let handle;
  try { handle = await fs.open(file, 'r'); } catch { return null; }
  try {
    const buffer = Buffer.alloc(MAX_SESSION_META_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return null;
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0 && bytesRead > MAX_SESSION_META_BYTES) return null;
    return buffer.subarray(0, newline < 0 ? bytesRead : newline).toString('utf8').replace(/\r$/, '');
  } finally {
    await handle.close();
  }
}

function rootSessionMeta(line: string | null, sessionId: string): { cwd: string } | null {
  if (!line) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!isRecord(value) || value.type !== 'session_meta' || !isRecord(value.payload)) return null;
  const meta = value.payload;
  if (meta.id !== sessionId || meta.session_id !== sessionId
    || (meta.parent_thread_id !== undefined && meta.parent_thread_id !== null)
    || meta.thread_source !== 'user'
    || typeof meta.cwd !== 'string' || !meta.cwd) return null;
  return { cwd: meta.cwd };
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

// Resolve the exact root conversation owned by one already-verified foreground Codex process. The process
// may also hold many subagent rollouts; metadata, not cwd or mtime, distinguishes the single TUI root.
// Every uncertainty fails closed before activation can interrupt the process.
export async function inspectCodexOpenRootSession(
  pid: number,
  sessionsRoot: string,
  {
    platform = process.platform,
    run = defaultRun,
    fs = fsp,
  }: CodexOpenSessionOptions = {},
): Promise<CodexOpenSession | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !path.isAbsolute(sessionsRoot)) return null;
  let canonicalRoot: string;
  try { canonicalRoot = await fs.realpath(sessionsRoot); } catch { return null; }

  let openFiles: OpenFile[];
  if (platform === 'linux') {
    openFiles = await procOpenFiles(pid, fs);
  } else {
    let output = '';
    try { output = await run('lsof', ['-a', '-p', String(pid), '-Fn']); } catch { return null; }
    openFiles = lsofOpenFiles(output);
  }
  if (!openFiles.length) return null;

  const candidates = new Map<string, CodexOpenSession>();
  for (const open of openFiles) {
    let canonicalFile: string;
    try { canonicalFile = await fs.realpath(open.file); } catch { continue; }
    if (!inside(canonicalRoot, canonicalFile)) continue;
    const sessionId = rolloutSessionId(path.basename(canonicalFile));
    if (!sessionId || !isSessionUuid(sessionId)) continue;
    let stat;
    try { stat = await fs.stat(canonicalFile); } catch { continue; }
    if (!stat.isFile()) continue;
    const meta = rootSessionMeta(await readFirstLine(canonicalFile, fs), sessionId);
    if (!meta) continue;
    const candidate: CodexOpenSession = {
      sessionId: sessionId.toLowerCase(),
      file: canonicalFile,
      cwd: meta.cwd,
      fd: open.fd,
      device: String(stat.dev),
      inode: String(stat.ino),
    };
    const key = `${candidate.device}:${candidate.inode}`;
    candidates.set(key, candidate);
  }
  return candidates.size === 1 ? [...candidates.values()][0] ?? null : null;
}

export function sameCodexOpenSession(
  first: CodexOpenSession,
  second: CodexOpenSession,
): boolean {
  return first.sessionId === second.sessionId && first.file === second.file
    && first.fd === second.fd && first.device === second.device && first.inode === second.inode;
}
