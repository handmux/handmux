import type { LocalAgentBridgeHost } from '../agent-runtime/bridgeTypes.js';
import type {
  AgentConversationContextControllerV1,
  ConversationContextSnapshot,
} from '../agent-runtime/conversationControls.js';

const PI_CONTEXT_IMPLEMENTATION_VERSION = 7;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function contextSnapshot(value: unknown): ConversationContextSnapshot {
  const snapshot = record(value);
  if (!snapshot || !['idle', 'working', 'waiting', 'compacting', 'unknown']
    .includes(String(snapshot.activity))) {
    throw new Error('Pi Extension returned an invalid Conversation Context snapshot');
  }
  const hasUsedTokens = snapshot.usedTokens !== undefined;
  const hasTotalTokens = snapshot.totalTokens !== undefined;
  if (hasUsedTokens !== hasTotalTokens
    || (hasUsedTokens && (!finite(snapshot.usedTokens)
      || !finite(snapshot.totalTokens) || snapshot.totalTokens <= 0))) {
    throw new Error('Pi Extension returned invalid context usage');
  }
  if (snapshot.cwd !== undefined
    && (typeof snapshot.cwd !== 'string' || !snapshot.cwd.trim())) {
    throw new Error('Pi Extension returned an invalid working directory');
  }
  return {
    activity: snapshot.activity as ConversationContextSnapshot['activity'],
    ...(hasUsedTokens ? {
      usedTokens: snapshot.usedTokens as number,
      totalTokens: snapshot.totalTokens as number,
    } : {}),
    ...(typeof snapshot.cwd === 'string' ? { cwd: snapshot.cwd } : {}),
  };
}

export function createPiConversationContextAdapter({
  host,
}: {
  host: LocalAgentBridgeHost;
}): AgentConversationContextControllerV1 {
  if (!host || typeof host.request !== 'function') {
    throw new TypeError('Pi Conversation Context adapter requires LocalAgentBridgeHost');
  }
  return {
    apiVersion: 1,
    async read(run) {
      // Context is optional for pre-v7 Connectors. Avoid probing an unregistered handler so their
      // otherwise healthy Conversation and Inbox capabilities remain usable until Pi is reloaded.
      if ((run.ref.implementationVersion ?? 1) < PI_CONTEXT_IMPLEMENTATION_VERSION) return null;
      return contextSnapshot(await host.request(
        run,
        'conversation',
        'context',
        {},
        { timeoutMs: 8_000, signal: run.signal },
      ));
    },
  };
}
