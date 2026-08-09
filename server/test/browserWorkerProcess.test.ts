import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
    const child = fork(WORKER, [], {
      env: { ...process.env, HANDMUX_BROWSER_INTERNAL_TOKEN: 'process-secret' },
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
      if (child.exitCode == null) child.kill('SIGKILL');
    }
  }, 20_000);
});
