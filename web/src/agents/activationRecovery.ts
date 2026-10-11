// The legacy activation receipt predates the Agent identity field. Keep this provider mapping
// at the Agent integration boundary until that older contract is migrated.
export function activationRecoveryAgentId(recovery: { kind: string }): string | null {
  return recovery.kind === 'codex_resume' ? 'codex' : null;
}
