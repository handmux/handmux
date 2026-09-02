import { BUILTIN_AGENT_ADAPTERS } from '../agents/index.js';
import { createClaudeConversationAdapter } from '../agents/claudeConversation.js';
import type { ClaudeConversationControl } from '../agents/claudeConversation.js';
import { createClaudeInteractionAdapter } from '../agents/claudeInteraction.js';
import type { ClaudeInteractionControl } from '../agents/claudeInteraction.js';
import { NativeInboxCoordinator } from '../agents/nativeInbox.js';
import {
  createCodexNativeInboxSource,
} from '../agents/nativeInboxSources.js';
import { createCodexConversationAdapter } from '../agents/codexConversation.js';
import { createCodexInteractionAdapter } from '../agents/codexInteraction.js';
import {
  createPiConversationActivityReader,
  createPiConversationAdapter,
} from '../agents/piConversation.js';
import { createPiConversationContextAdapter } from '../agents/piConversationContext.js';
import { createPiSessionControlAdapter } from '../agents/piSessionControl.js';
import { createCodexSessionControlAdapter } from '../agents/codexSessionControl.js';
import { createCodexConversationControls } from '../agents/codexConversationControls.js';
import { resolveCodexRollout, sessionsDir as codexSessionsDir } from '../agents/codex.js';
import { readLatestContextUsage } from '../codexUsageSnapshot.js';
import { createCodexConversationActivationController } from '../agents/codexConversationActivation.js';
import type { CodexActivationCommands } from '../agents/codexConversationActivation.js';
import { createClaudeSubscriptionUsageAdapter } from '../agents/claudeSubscriptionUsage.js';
import { createCodexSubscriptionUsageAdapter } from '../agents/codexSubscriptionUsage.js';
import {
  BridgeInboxCoordinator,
  PiInboxBridgeCoordinator,
} from '../agents/piInboxBridge.js';
import {
  AgentRuntime,
} from './runtime.js';
import type {
  AgentRuntimeAdapterFactory,
  AgentRuntimeOptions,
} from './runtime.js';
import type { AgentConversationActivityReader } from './conversationActivity.js';

export type CodexRuntimeApp =
  Parameters<typeof createCodexConversationAdapter>[0]['app']
  & Parameters<typeof createCodexInteractionAdapter>[0]
  & Parameters<typeof createCodexSessionControlAdapter>[0]
  & Parameters<typeof createCodexConversationControls>[0]
  & Parameters<typeof createCodexNativeInboxSource>[0];

export interface BuiltinAgentRuntimeOptions
  extends Omit<AgentRuntimeOptions, 'adapters' | 'adapterFactories'> {
  home?: string;
  claudeEvents?: Partial<NonNullable<Parameters<typeof createClaudeConversationAdapter>[0]>['sessions']>
    & {
      paneKind?(paneId: string): 'done' | 'working' | 'permission' | 'compacting' | 'error' | 'end' | 'idle' | null;
      paneCompletionToken?(paneId: string): string | null;
    };
  claudeProjectsRoot?: string;
  claudeConversationControl?: ClaudeConversationControl;
  claudeInteractionControl?: ClaudeInteractionControl;
  codexApp?: CodexRuntimeApp;
  codexClear?: (pane: string, threadId: string) => Promise<void>;
  codexActivationCommands?: CodexActivationCommands;
  codexSessionsRoot?: string;
  piSessionsRoot?: string;
}

export function createClaudeConversationActivityReader(
  events: NonNullable<BuiltinAgentRuntimeOptions['claudeEvents']> | undefined,
): AgentConversationActivityReader {
  return {
    async read(run) {
      const kind = events?.paneKind?.(run.ref.paneId) ?? null;
      const activity = kind === 'working' ? 'working'
        : kind === 'permission' ? 'waiting'
          : kind === 'compacting' ? 'compacting'
            : kind === 'done' || kind === 'idle' || kind === 'end' || kind === 'error'
              ? 'idle' : 'unknown';
      const completionToken = events?.paneCompletionToken?.(run.ref.paneId) ?? null;
      return {
        activity,
        activeTurn: activity === 'idle' ? { state: 'none' as const }
          : activity === 'unknown' ? { state: 'unknown' as const }
            : { state: 'active' as const, nativeTurnId: `claude-run:${run.ref.runId}` },
        ...(completionToken ? { completionToken } : {}),
      };
    },
  };
}

export function createCodexConversationActivityReader(
  app: CodexRuntimeApp,
): AgentConversationActivityReader {
  return {
    async read(run) {
      if (!run.ref.sessionId) {
        return { activity: 'unknown' as const, activeTurn: { state: 'unknown' as const } };
      }
      const raw = await app.status(run.ref.paneId, run.ref.sessionId);
      const status = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const native = status.status && typeof status.status === 'object'
        ? status.status as Record<string, unknown> : {};
      if (status.managed !== true || (native.type !== 'active' && native.type !== 'idle')) {
        return { activity: 'unknown' as const, activeTurn: { state: 'unknown' as const } };
      }
      const flags = Array.isArray(native.activeFlags) ? native.activeFlags : [];
      const activity = status.activityKind === 'compacting' ? 'compacting'
        : flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')
          || (Array.isArray(status.approvals) && status.approvals.length)
          || (Array.isArray(status.userInputs) && status.userInputs.length) ? 'waiting'
          : native.type === 'active' ? 'working' : 'idle';
      const activeTurnId = typeof status.activeTurnId === 'string' && status.activeTurnId
        ? status.activeTurnId : null;
      const lastTurn = status.lastTurn && typeof status.lastTurn === 'object'
        ? status.lastTurn as Record<string, unknown> : {};
      const terminalTurnId = typeof lastTurn.id === 'string' && lastTurn.id
        && ['completed', 'failed', 'interrupted'].includes(String(lastTurn.status))
        ? lastTurn.id : null;
      return {
        activity,
        activeTurn: activeTurnId
          ? { state: 'active' as const, nativeTurnId: activeTurnId }
          : activity === 'idle' ? { state: 'none' as const } : { state: 'unknown' as const },
        ...(!activeTurnId && terminalTurnId
          ? { completionToken: `codex-completed:${terminalTurnId}:${String(lastTurn.status)}` }
          : {}),
      };
    },
  };
}

// Built-in wiring is deliberately static and product-owned. This is not a plugin loader: Agent identity
// still comes only from BUILTIN_AGENT_ADAPTERS, while factories close over local provider clients/Bridge.
export function createBuiltinAgentRuntime({
  home,
  claudeEvents,
  claudeProjectsRoot,
  claudeConversationControl,
  claudeInteractionControl,
  codexApp,
  codexClear,
  codexActivationCommands,
  codexSessionsRoot,
  piSessionsRoot,
  ...runtimeOptions
}: BuiltinAgentRuntimeOptions): AgentRuntime {
  const factories: Record<string, AgentRuntimeAdapterFactory> = {
    claude: (context) => {
      const subscriptionUsage = createClaudeSubscriptionUsageAdapter({
        ...(home === undefined ? {} : { home }),
      });
      const inbox = new BridgeInboxCoordinator({
        host: context.bridge,
        projector: context.inbox,
        agentId: 'claude',
        sourceId: 'claude.hooks',
        label: 'Claude',
      });
      const conversationSessions = claudeEvents && typeof claudeEvents.paneSession === 'function'
        ? claudeEvents as NonNullable<Parameters<typeof createClaudeConversationAdapter>[0]>['sessions']
        : undefined;
      return {
        inbox: true,
        conversation: createClaudeConversationAdapter({
          ...(conversationSessions === undefined ? {} : { sessions: conversationSessions }),
          ...(claudeProjectsRoot === undefined ? {} : { projectsRoot: claudeProjectsRoot }),
          ...(claudeConversationControl === undefined ? {} : { control: claudeConversationControl }),
        }),
        conversationActivity: createClaudeConversationActivityReader(claudeEvents),
        ...(claudeInteractionControl === undefined ? {} : {
          interaction: createClaudeInteractionAdapter(
            claudeInteractionControl,
            750,
            (availability, message) => context.health.report({
              capability: 'interaction', availability,
              ...(message ? { message } : {}),
              ...(availability === 'ready' ? { lastSuccessAt: Date.now() } : {}),
            }),
          ),
        }),
        subscriptionUsage,
        subscriptionUsageLegacy: subscriptionUsage,
        start: () => {
          inbox.start();
          return () => inbox.close();
        },
        onBridgeConnected: (lease) => inbox.bind(lease).then(() => undefined),
      };
    },
    pi: (context) => {
      const inbox = new PiInboxBridgeCoordinator({
        host: context.bridge,
        projector: context.inbox,
      });
      return {
        inbox: true,
        conversation: createPiConversationAdapter({
          host: context.bridge,
          ...(piSessionsRoot === undefined ? {} : { sessionsRoot: piSessionsRoot }),
        }),
        conversationActivity: createPiConversationActivityReader(context.bridge),
        conversationContext: createPiConversationContextAdapter({ host: context.bridge }),
        sessionControl: createPiSessionControlAdapter({ host: context.bridge }),
        start: () => {
          inbox.start();
          return () => inbox.close();
        },
        onBridgeConnected: (lease) => inbox.bind(lease).then(() => undefined),
      };
    },
    codex: (context) => {
      const resolvedCodexSessionsRoot = codexSessionsRoot ?? codexSessionsDir(home);
      const subscriptionUsage = createCodexSubscriptionUsageAdapter({
        ...(home === undefined ? {} : { home }),
      });
      if (codexApp === undefined) {
        return { subscriptionUsage, subscriptionUsageLegacy: subscriptionUsage };
      }
      const sessionControl = typeof codexApp.models === 'function'
        && typeof codexApp.status === 'function'
        && typeof codexApp.updateSettings === 'function'
        ? createCodexSessionControlAdapter(codexApp) : undefined;
      const conversationControls = codexClear
        ? createCodexConversationControls(codexApp, codexClear, {
          sessionsRoot: resolvedCodexSessionsRoot,
          findRollout: resolveCodexRollout,
          reader: readLatestContextUsage,
        }) : undefined;
      const conversationActivation = codexActivationCommands
        ? createCodexConversationActivationController({
          panes: context.panes, process: context.process, commands: codexActivationCommands,
        }) : undefined;
      const inbox = new NativeInboxCoordinator({
        agentId: 'codex', sourceId: 'codex.app-server', context,
        source: createCodexNativeInboxSource(codexApp),
      });
      return {
        inbox: true,
        conversation: createCodexConversationAdapter({
          app: codexApp,
          sessionsRoot: resolvedCodexSessionsRoot,
        }),
        conversationActivity: createCodexConversationActivityReader(codexApp),
        interaction: createCodexInteractionAdapter(codexApp),
        ...(conversationActivation === undefined ? {} : { conversationActivation }),
        ...(conversationControls === undefined ? {} : {
          conversationGoal: conversationControls.goal,
          conversationPlan: conversationControls.plan,
          conversationContext: conversationControls.context,
          conversationPermission: conversationControls.permission,
          conversationCommands: conversationControls.commands,
        }),
        ...(sessionControl === undefined ? {} : { sessionControl }),
        subscriptionUsage,
        subscriptionUsageLegacy: subscriptionUsage,
        start: () => inbox.start(),
      };
    },
  };
  return new AgentRuntime({
    ...runtimeOptions,
    adapters: BUILTIN_AGENT_ADAPTERS,
    adapterFactories: factories,
  });
}
