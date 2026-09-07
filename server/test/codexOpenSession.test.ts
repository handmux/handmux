import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { inspectCodexOpenRootSession } from '../src/agents/codexOpenSession.js';

const ROOT_ID = '12345678-1234-1234-1234-123456789abc';
const OTHER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function sessionMeta(id: string, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    timestamp: '2026-09-06T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      session_id: id,
      id,
      cwd: '/repo',
      originator: 'codex-tui',
      source: 'cli',
      thread_source: 'user',
      ...overrides,
    },
  })}\n`;
}

function rollout(root: string, id: string, content = sessionMeta(id)): string {
  const directory = path.join(root, '2026', '09', '06');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-09-06T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, content);
  return file;
}

function lsof(...files: string[]): string {
  return files.map((file, index) => `f${40 + index}\nn${file}\n`).join('');
}

describe('Codex foreground open-session identity', () => {
  it('selects the one root TUI rollout while the same PID holds subagent rollouts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-open-'));
    const main = rollout(root, ROOT_ID);
    const subagent = rollout(root, OTHER_ID, sessionMeta(OTHER_ID, {
      session_id: ROOT_ID,
      parent_thread_id: ROOT_ID,
      source: { subagent: { thread_spawn: { parent_thread_id: ROOT_ID } } },
      thread_source: 'subagent',
    }));
    const run = vi.fn(async () => lsof(main, subagent));

    await expect(inspectCodexOpenRootSession(123, root, { platform: 'darwin', run }))
      .resolves.toMatchObject({
        sessionId: ROOT_ID, file: fs.realpathSync(main), cwd: '/repo', fd: '40',
      });
    expect(run).toHaveBeenCalledWith('lsof', ['-a', '-p', '123', '-Fn']);
  });

  it('binds two same-cwd native processes to their own open root rollout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-open-'));
    const first = rollout(root, ROOT_ID);
    const second = rollout(root, OTHER_ID);
    const run = vi.fn(async (_command: string, args: string[]) => (
      args.includes('101') ? lsof(first) : lsof(second)
    ));

    await expect(inspectCodexOpenRootSession(101, root, { platform: 'darwin', run }))
      .resolves.toMatchObject({ sessionId: ROOT_ID });
    await expect(inspectCodexOpenRootSession(202, root, { platform: 'darwin', run }))
      .resolves.toMatchObject({ sessionId: OTHER_ID });
  });

  it('accepts a Handmux/editor-born root rollout held by a native codex resume process', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-open-'));
    const resumed = rollout(root, ROOT_ID, sessionMeta(ROOT_ID, {
      originator: 'handmux',
      source: 'vscode',
    }));

    await expect(inspectCodexOpenRootSession(2048, root, {
      platform: 'darwin', run: async () => lsof(resumed),
    })).resolves.toMatchObject({
      sessionId: ROOT_ID,
      file: fs.realpathSync(resumed),
      cwd: '/repo',
      fd: '40',
    });
  });

  it('fails closed for zero roots, multiple roots, empty files, and lsof failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-open-'));
    const first = rollout(root, ROOT_ID);
    const second = rollout(root, OTHER_ID);
    const empty = rollout(root, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '');

    await expect(inspectCodexOpenRootSession(1, root, {
      platform: 'darwin', run: async () => '',
    })).resolves.toBeNull();
    await expect(inspectCodexOpenRootSession(1, root, {
      platform: 'darwin', run: async () => lsof(first, second),
    })).resolves.toBeNull();
    await expect(inspectCodexOpenRootSession(1, root, {
      platform: 'darwin', run: async () => lsof(empty),
    })).resolves.toBeNull();
    await expect(inspectCodexOpenRootSession(1, root, {
      platform: 'darwin', run: async () => { throw new Error('unavailable'); },
    })).resolves.toBeNull();
  });

  it('rejects files outside the canonical sessions root and non-root metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-open-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-other-'));
    const outside = rollout(other, ROOT_ID);
    const child = rollout(root, OTHER_ID, sessionMeta(OTHER_ID, { parent_thread_id: ROOT_ID }));

    await expect(inspectCodexOpenRootSession(1, root, {
      platform: 'darwin', run: async () => lsof(outside, child),
    })).resolves.toBeNull();
  });

  it('uses /proc fd links on Linux and fails closed when proc enumeration is unavailable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-open-'));
    const main = rollout(root, ROOT_ID);
    const linuxFs = {
      ...fsp,
      readdir: vi.fn(async () => ['42']),
      readlink: vi.fn(async () => main),
    } as unknown as Parameters<typeof inspectCodexOpenRootSession>[2] extends { fs?: infer T } ? T : never;
    await expect(inspectCodexOpenRootSession(123, root, {
      platform: 'linux', fs: linuxFs,
    })).resolves.toMatchObject({ sessionId: ROOT_ID, fd: '42' });

    const failedFs = {
      ...fsp,
      readdir: vi.fn(async () => { throw new Error('no proc'); }),
    } as unknown as typeof linuxFs;
    await expect(inspectCodexOpenRootSession(123, root, {
      platform: 'linux', fs: failedFs,
    })).resolves.toBeNull();
  });
});
