import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  installPiExtension,
  PiExtensionInstallError,
  piExtensionStatus,
  uninstallPiExtension,
} from './piExtension.js';
import { hooksHealthStatus, hooksStatus, installHooks, uninstallHooks } from './claudeHooks.js';
import { statusLineStatus, uninstallStatusLine } from './statusLine.js';

export const AGENT_NAMES = ['codex', 'pi', 'claude'] as const;
export type AgentName = typeof AGENT_NAMES[number];
export type AgentIntegrationStatus =
  | 'ready'
  | 'not-installed'
  | 'not-enabled'
  | 'needs-repair'
  | 'conflict';

export interface AgentIntegrationContext {
  home: string;
  piEntryFile: string;
  hooksSrcDir: string;
  claudeStateFile: string;
  executableAvailable: (command: string) => boolean;
}

export interface AgentIntegrationResult {
  name: AgentName;
  status: AgentIntegrationStatus;
  changed: boolean;
}

const AGENT_NAME_SET: ReadonlySet<string> = new Set(AGENT_NAMES);

export function agentName(value: unknown): AgentName | null {
  return typeof value === 'string' && AGENT_NAME_SET.has(value) ? value as AgentName : null;
}

// Resolve from PATH without running the Agent. This keeps `agent status/list` read-only and avoids startup
// output, prompts, config migrations, or other behavior an upstream CLI may attach to `--version`.
export function executableOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!command || command.includes('/') || command.includes('\\')) return false;
  const pathValue = env.PATH;
  if (!pathValue) return false;
  const extensions = platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, platform === 'win32' ? `${command}${extension}` : command);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) {
          fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
          return true;
        }
      } catch { /* keep searching */ }
    }
  }
  return false;
}

export function defaultAgentIntegrationContext({
  home = homedir(),
  piEntryFile,
  hooksSrcDir,
  claudeStateFile,
}: Omit<AgentIntegrationContext, 'home' | 'executableAvailable'> & { home?: string }): AgentIntegrationContext {
  return {
    home,
    piEntryFile,
    hooksSrcDir,
    claudeStateFile,
    executableAvailable: (command) => executableOnPath(command),
  };
}

export function agentIntegrationStatus(
  name: AgentName,
  context: AgentIntegrationContext,
): AgentIntegrationStatus {
  if (!context.executableAvailable(name)) return 'not-installed';
  if (name === 'codex') return 'ready';
  if (name === 'claude') {
    // PATH determines whether Claude Code itself is installed. Its first run creates ~/.claude; until then
    // the Agent exists but the integration is not enableable, and installHooks must still never create it.
    const status = hooksHealthStatus(context.home);
    if (status === 'no-claude') return 'not-enabled';
    if (status === 'stale') return 'needs-repair';
    return status === 'installed' ? 'ready' : 'not-enabled';
  }
  let status: ReturnType<typeof piExtensionStatus>;
  try { status = piExtensionStatus(context.home, { entryFile: context.piEntryFile }); }
  catch { return 'needs-repair'; }
  if (status === 'installed') return 'ready';
  if (status === 'stale') return 'needs-repair';
  if (status === 'conflict') return 'conflict';
  return 'not-enabled';
}

// Setup may offer Claude integration only after Claude itself has initialized ~/.claude. An executable on
// PATH without that directory is `not-enabled` for status purposes, but is not yet safely enableable.
export function shouldOfferClaudeIntegration(context: AgentIntegrationContext): boolean {
  return agentIntegrationStatus('claude', context) === 'not-enabled'
    && hooksStatus(context.home) === 'absent';
}

export function enableAgentIntegration(
  name: AgentName,
  context: AgentIntegrationContext,
): AgentIntegrationResult {
  const before = agentIntegrationStatus(name, context);
  if (before === 'not-installed' || before === 'conflict') {
    return { name, status: before, changed: false };
  }
  if (name === 'codex') return { name, status: 'ready', changed: false };
  if (name === 'claude') {
    const installed = installHooks(context.home, {
      srcDir: context.hooksSrcDir,
      stateFile: context.claudeStateFile,
    });
    const status = agentIntegrationStatus(name, context);
    return { name, status, changed: installed.status === 'installed' && before !== 'ready' };
  }
  try {
    const result = installPiExtension(context.home, { entryFile: context.piEntryFile });
    return { name, status: 'ready', changed: result.changed };
  } catch (error) {
    if (error instanceof PiExtensionInstallError && error.code === 'conflict') {
      return { name, status: 'conflict', changed: false };
    }
    throw error;
  }
}

export function disableAgentIntegration(
  name: AgentName,
  context: AgentIntegrationContext,
): AgentIntegrationResult {
  if (name === 'codex') return { name, status: 'ready', changed: false };
  if (name === 'claude') {
    const changed = hooksStatus(context.home) === 'installed'
      || statusLineStatus(context.home) === 'ours';
    uninstallHooks(context.home);
    uninstallStatusLine(context.home);
    return { name, status: 'not-enabled', changed };
  }
  try {
    const result = uninstallPiExtension(context.home);
    return { name, status: 'not-enabled', changed: result.changed };
  } catch (error) {
    if (error instanceof PiExtensionInstallError && error.code === 'conflict') {
      return { name, status: 'conflict', changed: false };
    }
    throw error;
  }
}
