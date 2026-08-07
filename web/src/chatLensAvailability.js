export function canEnableClaudeChatLens(hooksStatus) {
  return hooksStatus == null || hooksStatus === 'installed';
}

export function canUseChatLens(agent, hooksStatus) {
  if (agent === 'claude') return hooksStatus === 'installed';
  // A plain Codex pane still gets the switch so its chat surface can explain how to restart safely in
  // managed mode. Management gates chat operations, not discoverability.
  if (agent === 'codex') return true;
  return false;
}
