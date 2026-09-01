import type { AgentAdapter } from '../agent-runtime/adapter.js';

function isNativePiCommandLine(value: string): boolean {
  const trimmed = value.trim();
  if (/^pi(?:\s|$)/i.test(trimmed)) return true;
  return /(?:^|[\s"'])[^\s"']*\/node_modules\/@mariozechner\/pi-coding-agent\/dist\/cli\.js(?:[\s"']|$)/i
    .test(trimmed);
}

export const piAgentAdapter: AgentAdapter = {
  adapterApiVersion: 1,
  id: 'pi',
  label: 'Pi',
  process: {
    commands: ['pi'],
    ambiguousCommands: ['node'],
    verify: async (pane, context) => {
      const foreground = await context.inspectForeground(pane);
      if (!foreground?.commandLine) throw new Error('Pi foreground command line is unavailable');
      return isNativePiCommandLine(foreground.commandLine);
    },
  },
  capabilities: {
    inbox: { apiVersion: 1 },
    conversation: { apiVersion: 1, experimental: true },
    sessionControl: { apiVersion: 1 },
  },
  presentation: { iconId: 'pi' },
};
