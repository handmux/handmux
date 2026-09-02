import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  installPiExtension,
  PiExtensionInstallError,
  piExtensionFile,
  piExtensionStatus,
  syncPiExtension,
  uninstallPiExtension,
} from '../src/cli/piExtension.js';
import { tmpHome } from './tmphome.js';

function entry(home: string, name = 'pi-entry.js'): string {
  const file = path.join(home, name);
  fs.writeFileSync(file, 'export default function handmux() {}\n');
  return file;
}

describe('managed Pi Extension installer', () => {
  it('installs one owned global wrapper and is idempotent', () => {
    const home = tmpHome('hm-pi-ext-');
    const source = entry(home);
    expect(piExtensionStatus(home, { entryFile: source })).toBe('absent');

    const first = installPiExtension(home, { entryFile: source });
    expect(first.changed).toBe(true);
    expect(first.file).toBe(path.join(home, '.pi/agent/extensions/handmux/index.ts'));
    const content = fs.readFileSync(first.file, 'utf8');
    const entryUrl = pathToFileURL(first.entryFile).href;
    const fingerprint = createHash('sha256').update(fs.readFileSync(first.entryFile)).digest('hex');
    expect(content).toContain('// handmux-managed-pi-extension:v1');
    expect(content).toContain(`// handmux-entry:${entryUrl}\n`);
    expect(content).toContain(
      `export { default } from ${JSON.stringify(`${entryUrl}?handmux=${fingerprint}`)}`,
    );
    expect(fs.statSync(first.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(first.file)).mode & 0o777).toBe(0o700);
    expect(piExtensionStatus(home, { entryFile: source })).toBe('installed');

    expect(installPiExtension(home, { entryFile: source }).changed).toBe(false);
  });

  it('refreshes the import URL when package content changes at the same path', () => {
    const home = tmpHome('hm-pi-ext-');
    const source = entry(home);
    installPiExtension(home, { entryFile: source });
    const file = piExtensionFile(home);
    const before = fs.readFileSync(file, 'utf8');
    const entryUrl = pathToFileURL(fs.realpathSync(source)).href;

    fs.writeFileSync(source, 'export default function handmuxV2() {}\n');
    expect(piExtensionStatus(home, { entryFile: source })).toBe('installed');
    const result = syncPiExtension(home, { entryFile: source });
    const after = fs.readFileSync(file, 'utf8');

    expect(result?.changed).toBe(true);
    expect(after).not.toBe(before);
    expect(after).toContain(`// handmux-entry:${entryUrl}\n`);
    expect(after).toContain(
      `export { default } from ${JSON.stringify(
        `${entryUrl}?handmux=${createHash('sha256').update(fs.readFileSync(source)).digest('hex')}`,
      )}`,
    );
    expect(piExtensionStatus(home, { entryFile: source })).toBe('installed');
    expect(syncPiExtension(home, { entryFile: source })?.changed).toBe(false);
  });

  it('detects and repairs an owned wrapper after the package entry moves', () => {
    const home = tmpHome('hm-pi-ext-');
    const first = entry(home, 'first.js');
    const second = entry(home, 'second.js');
    installPiExtension(home, { entryFile: first });
    expect(piExtensionStatus(home, { entryFile: second })).toBe('stale');

    const result = syncPiExtension(home, { entryFile: second });
    expect(result?.changed).toBe(true);
    expect(fs.readFileSync(piExtensionFile(home), 'utf8')).toContain(
      pathToFileURL(fs.realpathSync(second)).href,
    );
    expect(piExtensionStatus(home, { entryFile: second })).toBe('installed');
  });

  it('marks a removed package target stale and removes only its owned wrapper', () => {
    const home = tmpHome('hm-pi-ext-');
    const source = entry(home);
    installPiExtension(home, { entryFile: source });
    fs.unlinkSync(source);
    expect(piExtensionStatus(home)).toBe('stale');
    const extra = path.join(path.dirname(piExtensionFile(home)), 'notes.txt');
    fs.writeFileSync(extra, 'keep');

    expect(uninstallPiExtension(home).changed).toBe(true);
    expect(fs.existsSync(piExtensionFile(home))).toBe(false);
    expect(fs.readFileSync(extra, 'utf8')).toBe('keep');
    expect(uninstallPiExtension(home).changed).toBe(false);
  });

  it('never overwrites or deletes an unowned Pi extension', () => {
    const home = tmpHome('hm-pi-ext-');
    const source = entry(home);
    const file = piExtensionFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export default function userExtension() {}\n');
    expect(piExtensionStatus(home, { entryFile: source })).toBe('conflict');

    for (const operation of [
      () => installPiExtension(home, { entryFile: source }),
      () => uninstallPiExtension(home),
    ]) {
      expect(operation).toThrowError(PiExtensionInstallError);
    }
    expect(fs.readFileSync(file, 'utf8')).toContain('userExtension');
    expect(syncPiExtension(home, { entryFile: source })).toBeNull();
  });

  it('treats symlink and non-file targets as conflicts', () => {
    const home = tmpHome('hm-pi-ext-');
    const source = entry(home);
    const file = piExtensionFile(home);
    const foreign = path.join(home, 'foreign.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(foreign, 'export default function foreign() {}\n');
    fs.symlinkSync(foreign, file);

    expect(piExtensionStatus(home, { entryFile: source })).toBe('conflict');
    expect(() => installPiExtension(home, { entryFile: source }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }));
    expect(() => uninstallPiExtension(home))
      .toThrowError(expect.objectContaining({ code: 'conflict' }));
    expect(fs.readFileSync(foreign, 'utf8')).toContain('function foreign');

    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect(piExtensionStatus(home, { entryFile: source })).toBe('conflict');
    expect(syncPiExtension(home, { entryFile: source })).toBeNull();
  });

  it('rejects a missing or relative bundled entry before touching Pi files', () => {
    const home = tmpHome('hm-pi-ext-');
    expect(() => installPiExtension(home, { entryFile: 'relative.js' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_entry' }));
    expect(() => installPiExtension(home, { entryFile: path.join(home, 'missing.js') }))
      .toThrowError(expect.objectContaining({ code: 'entry_missing' }));
    expect(piExtensionStatus(home)).toBe('absent');
  });
});
