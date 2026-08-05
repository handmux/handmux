export function canEnableChatLens(hooksStatus, managedCodexAvailable) {
  return hooksStatus == null || hooksStatus === 'installed' || !!managedCodexAvailable;
}

export function canUseChatLens(agent, hooksStatus, codexSession) {
  if (agent === 'claude') return hooksStatus === 'installed';
  if (agent === 'codex') return !!(codexSession?.loaded && codexSession?.managed);
  return false;
}
