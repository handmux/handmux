import { describe, expect, it, vi } from 'vitest';
import {
  resolveAgentIdentity,
  validateAgentAdapters,
} from '../src/agent-runtime/adapter.js';
import type {
  AgentAdapter,
  AgentProcessIdentity,
  LivePane,
  ProcessContext,
} from '../src/agent-runtime/adapter.js';
import {
  AGENTS,
  BUILTIN_AGENT_ADAPTERS,
  BUILTIN_AGENT_ADAPTER_VALIDATION,
  getAgentAdapter,
} from '../src/agents/index.js';

const pane: LivePane = {
  paneId: '%1',
  sessionName: 'main',
  windowId: '@1',
  windowName: 'agent',
  currentCommand: 'agent',
  tty: '/dev/ttys001',
};

const context: ProcessContext = {
  inspectForeground: vi.fn(async () => ({
    pid: 42,
    tty: '/dev/ttys001',
    executable: '/opt/agent/bin/agent',
  })),
};

function testAdapter(id: string, process: AgentProcessIdentity): AgentAdapter {
  return {
    adapterApiVersion: 1,
    id,
    label: id,
    process,
    capabilities: {},
  };
}

describe('built-in AgentAdapter registry', () => {
  it('loads Claude, Codex and Pi from one valid static registry', () => {
    expect(BUILTIN_AGENT_ADAPTER_VALIDATION.issues).toEqual([]);
    expect(BUILTIN_AGENT_ADAPTERS.map((adapter) => adapter.id)).toEqual(['claude', 'codex', 'pi']);
    expect(BUILTIN_AGENT_ADAPTER_VALIDATION.available).toEqual(BUILTIN_AGENT_ADAPTERS);
    expect(getAgentAdapter('pi')).toMatchObject({
      label: 'Pi',
      process: { commands: ['pi'], ambiguousCommands: ['node'] },
      capabilities: {},
      presentation: { iconId: 'pi' },
    });
  });

  it('keeps the old driver list as a same-object compatibility projection', () => {
    expect(AGENTS.map((adapter) => adapter.id)).toEqual(['claude', 'codex']);
    for (const driver of AGENTS) expect(BUILTIN_AGENT_ADAPTERS).toContain(driver);
  });

  it('recognizes a native Claude binary whose tmux command is its version', async () => {
    const nativeClaudePane: LivePane = {
      ...pane,
      currentCommand: '2_1_196',
    };
    const nativeClaudeContext: ProcessContext = {
      inspectForeground: vi.fn(async () => ({
        pid: 42,
        tty: '/dev/ttys001',
        executable: '/Users/test/.local/share/claude/versions/2.1.196',
      })),
    };

    await expect(resolveAgentIdentity(
      nativeClaudePane,
      BUILTIN_AGENT_ADAPTERS,
      nativeClaudeContext,
    )).resolves.toMatchObject({
      kind: 'matched',
      adapter: { id: 'claude' },
    });

    await expect(resolveAgentIdentity(
      nativeClaudePane,
      BUILTIN_AGENT_ADAPTERS,
      {
        inspectForeground: vi.fn(async () => ({
          pid: 42, tty: '/dev/ttys001', executable: '/opt/foreign/2.1.196',
        })),
      },
    )).resolves.toEqual({ kind: 'none' });

    await expect(resolveAgentIdentity(
      nativeClaudePane,
      BUILTIN_AGENT_ADAPTERS,
      {
        // A transient lsof/proc miss is absence of evidence, not proof that the versioned process
        // belongs to another program. Consumers must retain the last confirmed pane owner.
        inspectForeground: vi.fn(async () => ({ pid: 42, tty: '/dev/ttys001' })),
      },
    )).resolves.toEqual({ kind: 'unknown', candidateIds: ['claude'] });
  });
});

describe('AgentAdapter contract validation', () => {
  it('fails every owner closed when exact commands overlap', () => {
    const first = testAdapter('first', { commands: ['shared'] });
    const second = testAdapter('second', { commands: ['shared'] });
    const result = validateAgentAdapters([first, second]);
    expect(result.available).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'duplicate-command',
      command: 'shared',
      adapterIds: ['first', 'second'],
    }));
  });

  it('rejects ambiguous commands that cover another adapter exact command', () => {
    const exact = testAdapter('exact', { commands: ['node'] });
    const ambiguous = testAdapter('ambiguous', {
      commands: ['agent'],
      ambiguousCommands: ['node'],
      verify: async () => true,
    });
    const result = validateAgentAdapters([ambiguous, exact]);
    expect(result.available).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'ambiguous-exact-conflict',
      command: 'node',
      adapterIds: ['ambiguous', 'exact'],
    }));
  });

  it('keeps unrelated valid adapters available when one contract is malformed', () => {
    const valid = testAdapter('valid', { commands: ['valid'] });
    const malformed = { ...testAdapter('broken', { commands: ['broken'] }), adapterApiVersion: 2 };
    const result = validateAgentAdapters([valid, malformed]);
    expect(result.available).toEqual([valid]);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'invalid-adapter',
      adapterIds: ['broken'],
    }));
  });

  it('rejects the retired Adapter-owned conversationQueue capability', () => {
    const retired = {
      ...testAdapter('retired-queue', { commands: ['retired-queue'] }),
      capabilities: { conversationQueue: { apiVersion: 1 } },
    };
    const result = validateAgentAdapters([retired]);
    expect(result.available).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'invalid-adapter', adapterIds: ['retired-queue'],
    }));
  });
});

describe('deterministic Agent identity', () => {
  it.each([
    'pi ',
    'node /opt/node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
  ])('distinguishes native Pi (%s) from Codex when tmux reports their shared node launcher', async (commandLine) => {
    const nodePane = { ...pane, currentCommand: 'node' };
    const nativePi: ProcessContext = {
      inspectForeground: async () => ({
        pid: 42,
        executable: '/usr/local/bin/node',
        commandLine,
      }),
    };
    await expect(resolveAgentIdentity(nodePane, BUILTIN_AGENT_ADAPTERS, nativePi))
      .resolves.toMatchObject({ kind: 'matched', adapter: { id: 'pi' } });

    const unrelatedNode: ProcessContext = {
      inspectForeground: async () => ({
        pid: 43,
        executable: '/usr/local/bin/node',
        commandLine: 'node /opt/apps/pipeline/dist/cli.js',
      }),
    };
    await expect(resolveAgentIdentity(nodePane, BUILTIN_AGENT_ADAPTERS, unrelatedNode))
      .resolves.toEqual({ kind: 'none' });
  });

  it('accepts a unique exact command without invoking ambiguous verification', async () => {
    const verify = vi.fn(async () => true);
    const exact = testAdapter('exact', { commands: ['agent'] });
    const ambiguous = testAdapter('ambiguous', {
      commands: ['other'],
      ambiguousCommands: ['agent'],
      verify,
    });
    const result = await resolveAgentIdentity(pane, [exact, ambiguous], context);
    expect(result).toEqual({ kind: 'matched', adapter: exact });
    expect(verify).not.toHaveBeenCalled();
  });

  it('accepts an ambiguous command only when exactly one verifier succeeds', async () => {
    const rejected = testAdapter('rejected', {
      commands: ['rejected-exact'],
      ambiguousCommands: ['agent'],
      verify: async () => false,
    });
    const accepted = testAdapter('accepted', {
      commands: ['accepted-exact'],
      ambiguousCommands: ['agent'],
      verify: async () => true,
    });
    expect(await resolveAgentIdentity(pane, [rejected, accepted], context))
      .toEqual({ kind: 'matched', adapter: accepted });
  });

  it('fails closed rather than using load order when multiple verifiers succeed', async () => {
    const zed = testAdapter('zed', {
      commands: ['zed-exact'], ambiguousCommands: ['agent'], verify: async () => true,
    });
    const alpha = testAdapter('alpha', {
      commands: ['alpha-exact'], ambiguousCommands: ['agent'], verify: async () => true,
    });
    expect(await resolveAgentIdentity(pane, [zed, alpha], context))
      .toEqual({ kind: 'conflict', candidateIds: ['alpha', 'zed'] });
  });

  it('keeps synchronous errors, rejected promises and timeouts distinct from confirmed rejection', async () => {
    const syncThrow = testAdapter('sync-throw', {
      commands: ['sync-exact'],
      ambiguousCommands: ['agent'],
      verify: () => { throw new Error('synchronous probe failure'); },
    });
    const throws = testAdapter('throws', {
      commands: ['throws-exact'],
      ambiguousCommands: ['agent'],
      verify: async () => { throw new Error('probe failed'); },
    });
    const hangs = testAdapter('hangs', {
      commands: ['hangs-exact'],
      ambiguousCommands: ['agent'],
      verify: () => new Promise(() => {}),
    });
    expect(await resolveAgentIdentity(pane, [syncThrow, throws, hangs], context, { verifyTimeoutMs: 5 }))
      .toEqual({ kind: 'unknown', candidateIds: ['hangs', 'sync-throw', 'throws'] });

    const rejected = testAdapter('rejected', {
      commands: ['rejected-exact'], ambiguousCommands: ['agent'], verify: async () => false,
    });
    expect(await resolveAgentIdentity(pane, [rejected], context))
      .toEqual({ kind: 'none' });
  });

  it('does not claim a unique owner while another matching verifier is unavailable', async () => {
    const accepted = testAdapter('accepted', {
      commands: ['accepted-exact'], ambiguousCommands: ['agent'], verify: async () => true,
    });
    const unavailable = testAdapter('unavailable', {
      commands: ['unavailable-exact'], ambiguousCommands: ['agent'],
      verify: async () => { throw new Error('probe unavailable'); },
    });
    expect(await resolveAgentIdentity(pane, [accepted, unavailable], context))
      .toEqual({ kind: 'unknown', candidateIds: ['accepted', 'unavailable'] });
  });
});
