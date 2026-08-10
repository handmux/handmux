// Shared throwaway-dir factory for tests. Call tmpHome(prefix) instead of fs.mkdtempSync(...) directly:
// every dir it hands out is tracked and removed in the afterEach below (auto-registered per importing test
// file). Suites that spin up a throwaway $HOME / state dir per test otherwise leak hundreds of dirs into
// the system tmp over a run — which once filled a small harness tmpfs (ENOSPC). Returns the dir path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const created: string[] = [];

export function tmpHome(prefix = 'hm-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    if (!dir) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});
