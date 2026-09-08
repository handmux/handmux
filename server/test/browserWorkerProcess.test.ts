import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKER = fileURLToPath(new URL('../dist/src/browser/worker.js', import.meta.url));

function readyMessage(value: unknown): { type: string; port: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid worker ready message');
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || typeof record.port !== 'number') throw new Error('invalid worker ready message');
  return { type: record.type, port: record.port };
}

describe('browser worker process', () => {
  it('announces readiness and exits cleanly on SIGTERM', async () => {
    const testHome = await mkdtemp(join(tmpdir(), 'handmux-browser-worker-test-'));
    // Isolate homedir() in this test subprocess without changing the user's environment or product defaults.
    const isolateHome = `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => ${JSON.stringify(testHome)}; syncBuiltinESMExports();`;
    const child = fork(WORKER, [], {
      env: { ...process.env, HANDMUX_BROWSER_INTERNAL_TOKEN: 'process-secret' },
      execArgv: ['--import', `data:text/javascript,${encodeURIComponent(isolateHome)}`],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    try {
      const ready = readyMessage(await new Promise<unknown>((resolve, reject) => {
        child.once('message', (message) => resolve(message));
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`worker exited before ready: ${code}`)));
      }));
      expect(ready).toMatchObject({ type: 'handmux-browser-ready' });
      expect(Number.isInteger(ready.port)).toBe(true);

      const health = await fetch(`http://127.0.0.1:${ready.port}/_browser-worker/health`, {
        headers: { 'x-handmux-browser-internal': 'process-secret' },
      });
      expect(health.status).toBe(200);

      const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
      child.kill('SIGTERM');
      await expect(exited).resolves.toBe(0);
    } finally {
      if (child.exitCode == null) {
        const stopped = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await stopped;
      }
      await rm(testHome, { recursive: true, force: true });
    }
  }, 20_000);
});
