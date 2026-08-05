export function canEnableChatLens(hooksStatus, managedCodexAvailable) {
  return hooksStatus == null || hooksStatus === 'installed' || !!managedCodexAvailable;
}

export function canUseChatLens(agent, hooksStatus) {
  if (agent === 'claude') return hooksStatus === 'installed';
  // A plain Codex pane still gets the switch: its chat surface offers one-click takeover instead of
  // making the control disappear. Management gates chat operations, not discoverability.
  if (agent === 'codex') return true;
  return false;
}
