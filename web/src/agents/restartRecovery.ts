import type { AgentRunRef } from '../agentCatalog.js';
import type { ConversationRestartRecoveryView } from '../hooks/useConversationRestart.js';
import { codexRestartManualRecovery } from './codexRestartRecovery.js';

const manualRecoveryByAgent: Readonly<Record<string, (run: AgentRunRef) => ConversationRestartRecoveryView | null>> = {
  codex: codexRestartManualRecovery,
};

export function manualConversationRestartRecovery(run: AgentRunRef): ConversationRestartRecoveryView | null {
  return manualRecoveryByAgent[run.agentId]?.(run) ?? null;
}
