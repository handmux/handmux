import { describe, expect, it, vi } from 'vitest';
import { clearCodexConversationThroughTui } from '../src/agents/codexTerminalControl.js';

describe('Codex terminal conversation control', () => {
  it('runs /clear through the TUI and waits for App Server to confirm the new thread', async () => {
    let threadId = 'thread-1';
    const discover = vi.fn(async () => ({ managed: true, threadId }));
    const commands = {
      exitCopyModeIfActive: vi.fn(async () => {}),
      sendKey: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
      sendEnter: vi.fn(async () => { threadId = 'thread-2'; }),
    };

    await expect(clearCodexConversationThroughTui(
      { discover }, commands, '%1', 'thread-1', async () => {},
    )).resolves.toEqual({ threadId: 'thread-2' });
    expect(commands.exitCopyModeIfActive).toHaveBeenCalledWith('%1');
    expect(commands.sendKey).toHaveBeenCalledWith('%1', 'C-u');
    expect(commands.sendText).toHaveBeenCalledWith('%1', '/clear');
    expect(commands.sendEnter).toHaveBeenCalledWith('%1');
  });

  it('fails instead of splitting Conversation from a terminal that did not switch sessions', async () => {
    const discover = vi.fn(async () => ({ managed: true, threadId: 'thread-1' }));
    const commands = {
      exitCopyModeIfActive: vi.fn(async () => {}),
      sendKey: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
      sendEnter: vi.fn(async () => {}),
    };

    await expect(clearCodexConversationThroughTui(
      { discover }, commands, '%1', 'thread-1', async () => {},
    )).rejects.toThrow(
      'Codex terminal did not accept /clear; switch to the terminal, close any open panel, and try again',
    );
    expect(discover).toHaveBeenCalledTimes(60);
  });
});
