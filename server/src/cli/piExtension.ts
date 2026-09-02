import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MANAGED_MARK = '// handmux-managed-pi-extension:v1';
const ENTRY_MARK = '// handmux-entry:';
const NATIVE_IMPORT_MODULE_URL = 'data:text/javascript;base64,'
  + 'ZXhwb3J0IGZ1bmN0aW9uIGltcG9ydFBpQ29ubmVjdG9yKHNwZWNpZmllcikgeyByZXR1cm4gaW1wb3J0KHNwZWNpZmllcik7IH0K';

export type PiExtensionStatus = 'absent' | 'installed' | 'stale' | 'conflict';

export class PiExtensionInstallError extends Error {
  constructor(
    readonly code: 'conflict' | 'entry_missing' | 'invalid_entry',
    message: string,
  ) {
    super(message);
    this.name = 'PiExtensionInstallError';
  }
}

export interface PiExtensionInstallOptions {
  entryFile: string;
}

export interface PiExtensionInstallResult {
  status: 'installed';
  changed: boolean;
  file: string;
  entryFile: string;
}

function extensionDirectory(home: string): string {
  return path.join(home, '.pi', 'agent', 'extensions', 'handmux');
}

export function piExtensionFile(home: string = homedir()): string {
  return path.join(extensionDirectory(home), 'index.ts');
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function readManaged(file: string): { content: string; entryUrl: string } | null | 'conflict' {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return 'conflict';
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    if (lines[0] !== MANAGED_MARK || !lines[1]?.startsWith(ENTRY_MARK)) return 'conflict';
    const entryUrl = lines[1].slice(ENTRY_MARK.length);
    if (!entryUrl.startsWith('file:')) return 'conflict';
    try { fileURLToPath(entryUrl); } catch { return 'conflict'; }
    return { content, entryUrl };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function expectedEntryUrl(entryFile: string): string {
  try {
    return pathToFileURL(fs.realpathSync(entryFile)).href;
  } catch {
    return pathToFileURL(path.resolve(entryFile)).href;
  }
}

function wrapper(entryFile: string): string {
  const entryUrl = expectedEntryUrl(entryFile);
  const fingerprint = createHash('sha256').update(fs.readFileSync(entryFile)).digest('hex');
  const importUrl = `${entryUrl}?handmux=${fingerprint}`;
  return [
    MANAGED_MARK,
    `${ENTRY_MARK}${entryUrl}`,
    '// This tiny wrapper is owned by Handmux. Pi loads it from its documented global extension path.',
    '// Native ESM import preserves the fingerprint that Pi\'s jiti strips from static re-exports.',
    `import { importPiConnector } from ${JSON.stringify(NATIVE_IMPORT_MODULE_URL)};`,
    'export default async function handmux(api) {',
    `  const connector = await importPiConnector(${JSON.stringify(importUrl)});`,
    '  return connector.default(api);',
    '}',
    '',
  ].join('\n');
}

function validateEntry(entryFile: string): string {
  if (!path.isAbsolute(entryFile)) {
    throw new PiExtensionInstallError('invalid_entry', 'Pi Extension entry must be absolute');
  }
  try {
    const resolved = fs.realpathSync(entryFile);
    if (!fs.statSync(resolved).isFile()) throw new Error('not a file');
    return resolved;
  } catch {
    throw new PiExtensionInstallError('entry_missing', 'Bundled Pi Extension entry is unavailable');
  }
}

function referencedEntryExists(entryUrl: string): boolean {
  try { return fs.statSync(fileURLToPath(entryUrl)).isFile(); } catch { return false; }
}

export function piExtensionStatus(
  home: string = homedir(),
  options?: Partial<PiExtensionInstallOptions>,
): PiExtensionStatus {
  const installed = readManaged(piExtensionFile(home));
  if (installed === null) return 'absent';
  if (installed === 'conflict') return 'conflict';
  if (!referencedEntryExists(installed.entryUrl)) return 'stale';
  if (options?.entryFile !== undefined
    && installed.entryUrl !== expectedEntryUrl(options.entryFile)) return 'stale';
  return 'installed';
}

function writeAtomic(file: string, content: string): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

export function installPiExtension(
  home: string = homedir(),
  { entryFile }: PiExtensionInstallOptions,
): PiExtensionInstallResult {
  const resolvedEntry = validateEntry(entryFile);
  const file = piExtensionFile(home);
  const existing = readManaged(file);
  if (existing === 'conflict') {
    throw new PiExtensionInstallError(
      'conflict',
      'Pi Extension target exists and is not owned by Handmux',
    );
  }
  const content = wrapper(resolvedEntry);
  const changed = existing?.content !== content;
  if (changed) writeAtomic(file, content);
  return { status: 'installed', changed, file, entryFile: resolvedEntry };
}

export function syncPiExtension(
  home: string = homedir(),
  options: PiExtensionInstallOptions,
): PiExtensionInstallResult | null {
  const status = piExtensionStatus(home, options);
  if (status === 'absent' || status === 'conflict') return null;
  return installPiExtension(home, options);
}

export function uninstallPiExtension(home: string = homedir()): { changed: boolean; file: string } {
  const file = piExtensionFile(home);
  const existing = readManaged(file);
  if (existing === null) return { changed: false, file };
  if (existing === 'conflict') {
    throw new PiExtensionInstallError(
      'conflict',
      'Pi Extension target exists and is not owned by Handmux',
    );
  }
  fs.unlinkSync(file);
  try { fs.rmdirSync(path.dirname(file)); } catch { /* preserve non-empty/user-owned directory */ }
  return { changed: true, file };
}
