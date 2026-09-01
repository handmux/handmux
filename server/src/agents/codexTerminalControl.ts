export interface CodexTerminalControlApp {
  discover(pane: string): Promise<{ managed: boolean; threadId?: string | null } | null>;
}

export interface CodexTerminalControlCommands {
  exitCopyModeIfActive(pane: string): Promise<unknown>;
  sendKey(pane: string, key: string): Promise<unknown>;
  sendText(pane: string, text: string): Promise<unknown>;
  sendEnter(pane: string): Promise<unknown>;
}

type Wait = (ms: number) => Promise<unknown>;

const INPUT_SETTLE_MS = 100;
const CLEAR_SWITCH_ATTEMPTS = 60;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Codex's /clear replaces the active TUI chat widget as well as the App Server thread. Driving that
// native action keeps terminal and Conversation on one session; a direct thread/start would split them.
export async function clearCodexConversationThroughTui(
  codexApp: CodexTerminalControlApp,
  commands: CodexTerminalControlCommands,
  pane: string,
  previousThreadId: string,
  wait: Wait = pause,
): Promise<{ threadId: string }> {
  await commands.exitCopyModeIfActive(pane);
  await commands.sendKey(pane, 'C-u');
  await wait(INPUT_SETTLE_MS);
  await commands.sendText(pane, '/clear');
  await wait(INPUT_SETTLE_MS);
  await commands.sendEnter(pane);

  for (let attempt = 0; attempt < CLEAR_SWITCH_ATTEMPTS; attempt += 1) {
    const discovered = await codexApp.discover(pane);
    if (!discovered?.managed) throw new Error('Codex session is no longer managed by Handmux');
    if (discovered.threadId && discovered.threadId !== previousThreadId) {
      return { threadId: discovered.threadId };
    }
    await wait(INPUT_SETTLE_MS);
  }
  throw new Error(
    'Codex terminal did not accept /clear; switch to the terminal, close any open panel, and try again',
  );
}
