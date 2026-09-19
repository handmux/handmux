import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_AGENT_ADAPTERS } from '../src/agents/index.js';
import { isCodeBuddyCommandLine, verifyCodeBuddyProcess } from '../src/agents/codebuddy.js';
import { resolveAgentIdentity } from '../src/agent-runtime/adapter.js';
import type { ForegroundProcessIdentity, LivePane, ProcessContext } from '../src/agent-runtime/adapter.js';

const pane: LivePane = {
  paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'agent',
  currentCommand: 'node', tty: '/dev/ttys001',
};

function context(
  group: readonly ForegroundProcessIdentity[],
  leaf: ForegroundProcessIdentity | null = null,
): ProcessContext {
  return {
    inspectForeground: async () => leaf,
    inspectForegroundGroup: async () => group,
  };
}

// The shapes below are the ones a real install produces: the npm launcher reached through its global symlink
// (what tmux/argv actually show — the symlink is NOT resolved to the package path) and the resolved package
// entry. Freezing both is what stops a later "tightening" from rejecting the layout users really have.
describe('CodeBuddy launch shapes', () => {
  it('accepts the documented launcher and package entries', () => {
    for (const commandLine of [
      'node /usr/local/bin/codebuddy --no-session-persistence',
      'node /usr/local/bin/codebuddy-code',
      'node /usr/local/bin/cbc --resume',
      'node /Users/test/.nvm/versions/node/v22.1.0/bin/codebuddy',
      'node /opt/app/node_modules/.bin/codebuddy',
      'node /usr/local/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy --continue',
      '/usr/local/bin/codebuddy',
      '/opt/codebuddy/bin/codebuddy',
      'cbc --continue',
    ]) {
      expect(isCodeBuddyCommandLine(commandLine), commandLine).toBe(true);
    }
  });

  it('rejects an unrelated Node process that merely mentions the name', () => {
    for (const commandLine of [
      '',
      'node /opt/app/server.js',
      'node /opt/tools/codebuddy-helper.js',
      'node /opt/tools/codebuddy.js',
      'node dist/index.js --agent codebuddy',
      'node /opt/app/main.js cbc',
      'node cbc',
      'vim codebuddy.md',
      'ruby /opt/tools/update.rb',
      'npm list',
    ]) {
      expect(isCodeBuddyCommandLine(commandLine), commandLine).toBe(false);
    }
  });
});

describe('CodeBuddy process verification', () => {
  it('matches from the foreground group even when a transient tool child holds the leaf', async () => {
    // Live on 2.154.0 the CLI spawns `npm list` / `ruby` / `brew list` update checks in its own foreground
    // group, and the single-leaf view prefers that non-launcher descendant — so the group is the only way to
    // see CodeBuddy, and the row it finds is what the Runtime must anchor the lease on.
    const live = context([
      {
        pid: 400, ppid: 90, startedAt: 1_000, tty: '/dev/ttys001',
        commandLine: 'node /usr/local/bin/codebuddy --no-session-persistence',
      },
      { pid: 401, ppid: 400, startedAt: 1_001, tty: '/dev/ttys001', commandLine: 'npm list' },
    ], { pid: 401, commandLine: 'npm list', executable: '/usr/local/bin/node' });

    await expect(verifyCodeBuddyProcess(pane, live)).resolves.toMatchObject({
      pid: 400, commandLine: 'node /usr/local/bin/codebuddy --no-session-persistence',
    });

    const identity = await resolveAgentIdentity(pane, BUILTIN_AGENT_ADAPTERS, live);
    expect(identity).toMatchObject({ kind: 'matched', adapter: { id: 'codebuddy' } });
    // The verifier's own process must survive resolution: it is the anchor, not the leaf (pid 401).
    expect(identity.kind === 'matched' ? identity.process?.pid : null).toBe(400);
  });

  it('never claims a plain Node pane, whatever the leaf looks like', async () => {
    const plain = context([
      { pid: 500, ppid: 90, commandLine: 'node /opt/app/server.js' },
      { pid: 501, ppid: 500, commandLine: 'node /opt/app/worker.js' },
    ], { pid: 500, commandLine: 'node /opt/app/server.js', executable: '/usr/local/bin/node' });

    await expect(verifyCodeBuddyProcess(pane, plain)).resolves.toBe(false);
    await expect(resolveAgentIdentity(pane, BUILTIN_AGENT_ADAPTERS, plain))
      .resolves.toEqual({ kind: 'none' });
  });

  it('stays inconclusive for Codex and Pi when the host cannot supply the group', async () => {
    // No group means no CodeBuddy answer, but that answer must not be contagious: an inconclusive verdict
    // downgrades the whole pane, which would take Codex/Pi down with it on such a host.
    const codex = {
      inspectForeground: vi.fn(async () => ({
        pid: 600, tty: '/dev/ttys001', executable: '/opt/codex/bin/codex', commandLine: 'codex',
      })),
    };
    await expect(resolveAgentIdentity(pane, BUILTIN_AGENT_ADAPTERS, codex))
      .resolves.toMatchObject({ kind: 'matched', adapter: { id: 'codex' } });
  });
});
