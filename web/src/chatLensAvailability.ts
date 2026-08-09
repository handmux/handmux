import type { ClaudeHooksStatus } from './hooks/useServerConfig.js';

type HookStatus = ClaudeHooksStatus | null | undefined;

export function canEnableClaudeChatLens(hooksStatus: HookStatus): boolean {
  return hooksStatus == null || hooksStatus === 'installed';
}

export function canUseChatLens(agent: string | null | undefined, hooksStatus: HookStatus): boolean {
  if (agent === 'claude') return hooksStatus === 'installed';
  // A plain Codex pane still gets the switch so its chat surface can explain how to restart safely in
  // managed mode. Management gates chat operations, not discoverability.
  if (agent === 'codex') return true;
  return false;
}
