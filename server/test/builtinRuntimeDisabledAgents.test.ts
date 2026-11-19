import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReadonlyPaneSource } from '../src/agent-runtime/adapter.js';
import { createBuiltinAgentRuntime } from '../src/agent-runtime/builtinRuntime.js';
import type { AgentRuntime } from '../src/agent-runtime/runtime.js';

const AUTH_TOKEN = 'disabled-agents-auth-token-that-is-at-least-32-bytes';
const directories: string[] = [];
const runtimes: AgentRuntime[] = [];

const panes: ReadonlyPaneSource = {
  async list() { return []; },
  subscribe() { return () => {}; },
};

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function runtime(disabledAgents?: readonly string[]): AgentRuntime {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-disabled-agents-'));
  directories.push(stateDirectory);
  const value = createBuiltinAgentRuntime({
    panes,
    process: { inspectForeground: async () => null },
    stateDirectory,
    authToken: AUTH_TOKEN,
    ...(disabledAgents === undefined ? {} : { disabledAgents }),
  });
  runtimes.push(value);
  return value;
}

describe('createBuiltinAgentRuntime disabledAgents', () => {
  it('registers every built-in Agent by default', () => {
    expect(runtime().adapters.map((adapter) => adapter.id)).toContain('codebuddy');
  });

  it('drops a disabled Agent together with its factory and still starts', async () => {
    const value = runtime(['codebuddy']);
    expect(value.adapters.map((adapter) => adapter.id)).not.toContain('codebuddy');
    await value.start();
    expect(value.health().map((entry) => entry.adapterId)).not.toContain('codebuddy');
  });
});
