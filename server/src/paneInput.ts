interface PaneInputCommands {
  exitCopyModeIfActive(paneId: string): Promise<unknown>;
  sendText(paneId: string, text: string): Promise<unknown>;
  sendEnter(paneId: string): Promise<unknown>;
  sendKey(paneId: string, key: string): Promise<unknown>;
}

interface PaneInputGuard {
  validate(): boolean | Promise<boolean>;
}

export interface PanePromptResult {
  nativeMutation: boolean;
}

const SUBMIT_GAP_MS = 120;
const paneInputTails = new Map<string, Promise<void>>();
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Every product surface that writes to a tmux pane shares this one per-pane critical section. Keeping
// text + submit in the same operation prevents two clients from interleaving `paste-buffer` and Enter.
export async function serializePaneInput<T>(paneId: string, operation: () => Promise<T>): Promise<T> {
  const previous = paneInputTails.get(paneId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const tail = current.then(() => {}, () => {});
  paneInputTails.set(paneId, tail);
  try {
    return await current;
  } finally {
    if (paneInputTails.get(paneId) === tail) paneInputTails.delete(paneId);
  }
}

export function sendPanePrompt(
  commands: PaneInputCommands,
  paneId: string,
  text: string,
  guard?: PaneInputGuard,
): Promise<PanePromptResult> {
  return serializePaneInput(paneId, async () => {
    if (guard && !await guard.validate()) return { nativeMutation: false };
    await commands.exitCopyModeIfActive(paneId);
    await commands.sendText(paneId, text);
    if (text) await delay(SUBMIT_GAP_MS);
    await commands.sendEnter(paneId);
    return { nativeMutation: true };
  });
}

export function interruptPane(commands: PaneInputCommands, paneId: string): Promise<void> {
  return serializePaneInput(paneId, async () => {
    await commands.exitCopyModeIfActive(paneId);
    await commands.sendKey(paneId, 'C-c');
  });
}

export function sendPaneChoice(
  commands: PaneInputCommands,
  paneId: string,
  choice: string,
): Promise<void> {
  return serializePaneInput(paneId, async () => {
    await commands.exitCopyModeIfActive(paneId);
    await commands.sendText(paneId, choice);
  });
}
