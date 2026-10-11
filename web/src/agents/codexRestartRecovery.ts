import type { AgentRunRef } from '../agentCatalog.js';
import type { ConversationRestartRecoveryView } from '../hooks/useConversationRestart.js';

// Display-only fallback for a lost HTTP response. It never authorizes an automatic pane command.
export function codexRestartManualRecovery(run: AgentRunRef): ConversationRestartRecoveryView | null {
  const sessionId = run.sessionId;
  if (!sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return null;
  }
  return {
    agentId: run.agentId, paneId: run.paneId,
    recovery: { kind: 'codex_resume', sessionId, command: `handmux codex resume ${sessionId}` },
    phase: 'prepared', state: 'unknown', canResume: false,
  };
}
