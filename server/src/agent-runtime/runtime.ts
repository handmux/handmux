import crypto from 'node:crypto';
import path from 'node:path';
import { PrivateStateStore } from '../privateStateStore.js';
import {
  resolveAgentIdentity,
  validateAgentAdapters,
} from './adapter.js';
import type {
  AdapterAvailability,
  AdapterHealthReporter,
  AdapterLogger,
  AgentAdapter,
  AgentAdapterContext,
  AgentAdapterIssue,
  ForegroundProcessIdentity,
  LivePane,
  ProcessContext,
  ReadonlyPaneSource,
} from './adapter.js';
import { BridgeContractError, LocalAgentBridge } from './bridge.js';
import { FileBridgeStateStore } from './bridgeStore.js';
import {
  LocalAgentBridgeTransportServer,
} from './bridgeTransport.js';
import type { LocalAgentBridgeConnection, LocalAgentBridgeHost } from './bridgeTypes.js';
import { ConversationService } from './conversation.js';
import {
  RuntimeConversationActivitySource,
} from './conversationActivity.js';
import type { AgentConversationActivityReader } from './conversationActivity.js';
import { AgentConversationControlService } from './conversationControls.js';
import { AgentConversationActivationService } from './conversationActivation.js';
import type { AgentConversationActivationControllerV1 } from './conversationActivation.js';
import type {
  AgentConversationCommandControllerV1,
  AgentConversationContextControllerV1,
  AgentConversationGoalControllerV1,
  AgentConversationPlanControllerV1,
  AgentConversationPermissionControllerV1,
  AgentConversationControlBindings,
} from './conversationControls.js';
import { FileConversationStateStore } from './conversationStore.js';
import type { AgentConversationAdapterV1 } from './conversationTypes.js';
import { InboxContractError, InboxService } from './inbox.js';
import { FileInboxStateStore } from './inboxStore.js';
import type { InboxOrderedProjector } from './inboxTypes.js';
import { InteractionContractError, InteractionService } from './interaction.js';
import { FileInteractionStateStore } from './interactionStore.js';
import type { AgentInteractionAdapterV1 } from './interactionTypes.js';
import { AgentResourceService } from './resources.js';
import { AgentSessionControlService } from './sessionControl.js';
import type { AgentSessionControlAdapterV1 } from './sessionControl.js';
import { SubscriptionUsageService } from './subscriptionUsage.js';
import type { AgentSubscriptionUsageAdapterV1 } from './subscriptionUsage.js';
import { DeprecatedSubscriptionUsageFacade } from './subscriptionUsageLegacy.js';
import type { DeprecatedSubscriptionUsageLegacyProjector } from './subscriptionUsageLegacy.js';
import { AgentRunRuntime } from './run.js';
import type {
  AgentAttachmentCandidate,
  AgentRunLease,
  AgentRunRef,
  RunRevokeReason,
  ScopedAgentRunController,
} from './run.js';

const DEFAULT_ACTIVATION_TIMEOUT_MS = 5_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,1024}$/;

interface StoredBridgeCredential {
  version: 1;
  authToken: string;
}

interface TrackedRun {
  adapter: AgentAdapter;
  lease: AgentRunLease;
  candidate: AgentAttachmentCandidate;
  bridgeGenerationId?: string;
}

interface AdapterLifecycle {
  adapter: AgentAdapter;
  abort: AbortController;
  cleanup: Array<() => void | Promise<void>>;
}

export interface AgentRuntimeCapabilityContext extends AgentAdapterContext {
  inbox: InboxOrderedProjector;
  process: ProcessContext;
}

export interface AgentRuntimeAdapterBinding {
  inbox?: true;
  conversation?: AgentConversationAdapterV1;
  conversationActivity?: AgentConversationActivityReader;
  conversationActivation?: AgentConversationActivationControllerV1;
  conversationGoal?: AgentConversationGoalControllerV1;
  conversationPlan?: AgentConversationPlanControllerV1;
  conversationContext?: AgentConversationContextControllerV1;
  conversationPermission?: AgentConversationPermissionControllerV1;
  conversationCommands?: AgentConversationCommandControllerV1;
  interaction?: AgentInteractionAdapterV1;
  sessionControl?: AgentSessionControlAdapterV1;
  subscriptionUsage?: AgentSubscriptionUsageAdapterV1;
  subscriptionUsageLegacy?: DeprecatedSubscriptionUsageLegacyProjector;
  start?(): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
  onBridgeConnected?(lease: AgentRunLease, connection: LocalAgentBridgeConnection): void | Promise<void>;
}

export type AgentRuntimeAdapterFactory = (
  context: AgentRuntimeCapabilityContext,
) => AgentRuntimeAdapterBinding;

export interface AgentRuntimeHealthEntry {
  adapterId: string;
  capability?: string;
  availability: AdapterAvailability | 'starting';
  message?: string;
  lastSuccessAt?: number;
}

export interface AgentCapabilityDescriptor {
  id: string;
  label: string;
  iconId?: string;
  capabilities: {
    inbox: boolean;
    conversation: boolean;
    conversationActivation: boolean;
    conversationGoal: boolean;
    conversationPlan: boolean;
    conversationContext: boolean;
    conversationPermission: boolean;
    conversationCommands: boolean;
    interaction: boolean;
    sessionControl: boolean;
    subscriptionUsage: boolean;
  };
  capabilityMetadata?: {
    conversation?: { experimental: boolean };
  };
}

export interface AgentRuntimeOptions {
  adapters: readonly AgentAdapter[];
  panes: ReadonlyPaneSource;
  process: ProcessContext;
  stateDirectory: string;
  adapterFactories?: Readonly<Record<string, AgentRuntimeAdapterFactory>>;
  adapterOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  allowedResourceRoots?: Readonly<Record<string, readonly string[]>>;
  logger?: AdapterLogger;
  socketPath?: string;
  authToken?: string;
  activationTimeoutMs?: number;
  verifyTimeoutMs?: number;
  newRunId?: () => string;
  newBridgeConnectionId?: () => string;
  newBridgeAuthToken?: () => string;
  /** Fail closed without quarantining state when a prerequisite migration could not be verified. */
  conversationStartupBlockReason?: string;
}

const NOOP_LOGGER: AdapterLogger = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});

function cloneCandidate(candidate: AgentAttachmentCandidate): AgentAttachmentCandidate {
  return structuredClone(candidate);
}

function validConversationAdapter(value: unknown): value is AgentConversationAdapterV1 {
  const adapter = value as Partial<AgentConversationAdapterV1> | null;
  return adapter !== null && typeof adapter === 'object' && adapter.apiVersion === 1
    && typeof adapter.discoverNative === 'function' && typeof adapter.readNativePage === 'function'
    && (adapter.dispatchPrompt === undefined || typeof adapter.dispatchPrompt === 'function')
    && (adapter.dispatchSteer === undefined || typeof adapter.dispatchSteer === 'function');
}

function validController(
  value: unknown,
  methods: readonly string[],
): value is { apiVersion: 1 } {
  const controller = value as Record<string, unknown> | null;
  return controller !== null && typeof controller === 'object' && controller.apiVersion === 1
    && methods.every((method) => typeof controller[method] === 'function');
}

function validInteractionAdapter(value: unknown): value is AgentInteractionAdapterV1 {
  const adapter = value as Partial<AgentInteractionAdapterV1> | null;
  return adapter !== null && typeof adapter === 'object' && adapter.apiVersion === 1
    && typeof adapter.observeNative === 'function' && typeof adapter.dispatchResponse === 'function';
}

function validSessionControlAdapter(value: unknown): value is AgentSessionControlAdapterV1 {
  const adapter = value as Partial<AgentSessionControlAdapterV1> | null;
  return adapter !== null && typeof adapter === 'object' && adapter.apiVersion === 1
    && typeof adapter.readModelControl === 'function'
    && (adapter.updateModelControl === undefined || typeof adapter.updateModelControl === 'function');
}

export function validSubscriptionUsageAdapter(
  value: unknown,
): value is AgentSubscriptionUsageAdapterV1 {
  const adapter = value as Partial<AgentSubscriptionUsageAdapterV1> | null;
  return adapter !== null && typeof adapter === 'object' && adapter.apiVersion === 1
    && typeof adapter.snapshot === 'function';
}

function sameProcess(
  candidate: AgentAttachmentCandidate,
  pane: LivePane,
  foreground: ForegroundProcessIdentity,
): boolean {
  if (foreground.pid !== candidate.process.pid) return false;
  if (pane.foregroundPid !== undefined && pane.foregroundPid !== candidate.process.pid) return false;
  if (candidate.process.startedAt !== undefined
    && foreground.startedAt !== candidate.process.startedAt) return false;
  const observedTty = foreground.tty ?? pane.tty;
  return candidate.process.tty === undefined || observedTty === candidate.process.tty;
}

function recoverCorruptState<T>({
  file,
  kind,
  logger,
  create,
  isContractError,
}: {
  file: string;
  kind: string;
  logger: AdapterLogger;
  create: () => T;
  isContractError: (error: unknown) => boolean;
}): T {
  try {
    return create();
  } catch (error) {
    if (!(error instanceof SyntaxError) && !isContractError(error)) throw error;
    const quarantinedFile = new PrivateStateStore(file).quarantine();
    try {
      logger.warn('Corrupt Agent Runtime state was quarantined', {
        kind,
        file,
        quarantinedFile,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch { /* diagnostics must not prevent recovery */ }
    return create();
  }
}

function credential(
  file: string,
  requested: string | undefined,
  create: () => string,
): string {
  const store = new PrivateStateStore<StoredBridgeCredential>(file);
  const existing = store.readStrict();
  if (existing !== null) {
    if (existing.version !== 1 || !TOKEN_RE.test(existing.authToken)) {
      throw new Error('Agent Runtime Bridge credential is corrupt');
    }
    if (requested !== undefined && requested !== existing.authToken) {
      throw new Error('Agent Runtime Bridge credential does not match persisted state');
    }
    return existing.authToken;
  }
  const authToken = requested ?? create();
  if (!TOKEN_RE.test(authToken)) throw new Error('Agent Runtime Bridge credential is invalid');
  store.write({ version: 1, authToken });
  return authToken;
}

async function lifecycleWithin<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class AgentRuntime {
  readonly adapters: readonly AgentAdapter[];
  readonly issues: readonly AgentAdapterIssue[];
  readonly runs: AgentRunRuntime;
  readonly bridge: LocalAgentBridge;
  readonly inbox: InboxService;
  readonly conversation: ConversationService | null;
  readonly conversationActivation: AgentConversationActivationService | null;
  readonly conversationControls: AgentConversationControlService | null;
  readonly interaction: InteractionService | null;
  readonly sessionControl: AgentSessionControlService | null;
  readonly subscriptionUsage: SubscriptionUsageService | null;
  readonly deprecatedSubscriptionUsage: DeprecatedSubscriptionUsageFacade | null;
  readonly resources: AgentResourceService;
  readonly socketPath: string;
  readonly bridgeAuthToken: string;

  readonly #panes: ReadonlyPaneSource;
  readonly #process: ProcessContext;
  readonly #logger: AdapterLogger;
  readonly #adapterOptions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly #activationTimeoutMs: number;
  readonly #verifyTimeoutMs: number;
  readonly #controllers = new Map<string, ScopedAgentRunController>();
  readonly #bindings = new Map<string, AgentRuntimeAdapterBinding>();
  readonly #startedBindings = new Set<string>();
  readonly #lifecycles = new Map<string, AdapterLifecycle>();
  readonly #tracked = new Map<string, TrackedRun>();
  readonly #authorizationQueues = new Map<string, Promise<void>>();
  readonly #health = new Map<string, AgentRuntimeHealthEntry>();
  readonly #transport: LocalAgentBridgeTransportServer;
  #unsubscribePanes: (() => void) | undefined;
  #reconcileTail: Promise<void> = Promise.resolve();
  #startPromise: Promise<void> | undefined;
  #started = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor({
    adapters,
    panes,
    process,
    stateDirectory,
    adapterFactories = {},
    adapterOptions = {},
    allowedResourceRoots = {},
    logger = NOOP_LOGGER,
    socketPath = path.join(stateDirectory, 'bridge', 'agent.sock'),
    authToken,
    activationTimeoutMs = DEFAULT_ACTIVATION_TIMEOUT_MS,
    verifyTimeoutMs,
    newRunId,
    newBridgeConnectionId,
    newBridgeAuthToken = () => crypto.randomBytes(32).toString('base64url'),
    conversationStartupBlockReason,
  }: AgentRuntimeOptions) {
    if (!path.isAbsolute(stateDirectory) || !path.isAbsolute(socketPath) || !panes || !process
      || !Number.isSafeInteger(activationTimeoutMs) || activationTimeoutMs <= 0) {
      throw new TypeError('AgentRuntime requires absolute private paths, panes, and process context');
    }
    const validation = validateAgentAdapters(adapters);
    if (!validation.available.length) throw new Error('AgentRuntime has no valid Agent adapters');
    this.adapters = Object.freeze([...validation.available]);
    this.issues = Object.freeze(structuredClone(validation.issues));
    this.#panes = panes;
    this.#process = process;
    this.#logger = logger;
    this.#adapterOptions = adapterOptions;
    this.#activationTimeoutMs = activationTimeoutMs;
    this.#verifyTimeoutMs = Math.max(1, verifyTimeoutMs ?? 1_000);
    this.runs = new AgentRunRuntime({
      verifyTimeoutMs: this.#verifyTimeoutMs,
      ...(newRunId === undefined ? {} : { newRunId }),
    });
    const adapterIds = this.adapters.map((adapter) => adapter.id);
    this.resources = new AgentResourceService({ allowedFileRoots: allowedResourceRoots });
    const bridgeStateFile = path.join(stateDirectory, 'bridge-state.json');
    this.bridge = recoverCorruptState({
      file: bridgeStateFile,
      kind: 'bridge',
      logger,
      isContractError: (error) => error instanceof BridgeContractError,
      create: () => new LocalAgentBridge({
        runs: this.runs,
        adapterIds,
        store: new FileBridgeStateStore(bridgeStateFile),
        ...(newBridgeConnectionId === undefined ? {} : { newConnectionId: newBridgeConnectionId }),
      }),
    });
    const inboxStateFile = path.join(stateDirectory, 'inbox-state.json');
    this.inbox = recoverCorruptState({
      file: inboxStateFile,
      kind: 'inbox',
      logger,
      isContractError: (error) => error instanceof InboxContractError,
      create: () => new InboxService({
        runs: this.runs,
        adapterIds,
        store: new FileInboxStateStore(inboxStateFile),
      }),
    });

    for (const adapter of this.adapters) {
      const raw = this.runs.controller(
        adapter.id,
        (candidate) => this.#verifyAttachment(adapter, candidate),
      );
      this.#controllers.set(adapter.id, this.#trackedController(adapter, raw));
      this.#lifecycles.set(adapter.id, { adapter, abort: new AbortController(), cleanup: [] });
      this.#health.set(`${adapter.id}\0`, {
        adapterId: adapter.id,
        availability: 'starting',
      });
    }

    for (const factoryId of Object.keys(adapterFactories)) {
      if (!this.#controllers.has(factoryId)) {
        throw new Error(`Agent Runtime factory has no static adapter: ${factoryId}`);
      }
    }
    const conversations: Record<string, AgentConversationAdapterV1> = {};
    const conversationActivities: Record<string, AgentConversationActivityReader> = {};
    const conversationActivations: Record<string, AgentConversationActivationControllerV1> = {};
    const conversationControlBindings: Record<string, AgentConversationControlBindings> = {};
    const interactions: Record<string, AgentInteractionAdapterV1> = {};
    const sessionControls: Record<string, AgentSessionControlAdapterV1> = {};
    const subscriptionUsageAdapters: Record<string, AgentSubscriptionUsageAdapterV1> = {};
    const subscriptionUsageLegacy: Record<string, DeprecatedSubscriptionUsageLegacyProjector> = {};
    for (const adapter of this.adapters) {
      const factory = adapterFactories[adapter.id];
      if (!factory) continue;
      try {
        const binding = factory(this.#context(adapter, adapterOptions[adapter.id] ?? {}));
        if (!binding || typeof binding !== 'object'
          || (binding.inbox !== undefined && binding.inbox !== true)
          || (binding.start !== undefined && typeof binding.start !== 'function')
          || (binding.onBridgeConnected !== undefined
            && typeof binding.onBridgeConnected !== 'function')) {
          throw new Error('factory returned an invalid binding');
        }
        this.#bindings.set(adapter.id, binding);
        if (binding.conversation) {
          if (adapter.capabilities.conversation?.apiVersion === 1
            && validConversationAdapter(binding.conversation)) {
            conversations[adapter.id] = binding.conversation;
          } else {
            this.#report(adapter.id, {
              capability: 'conversation', availability: 'unavailable',
              message: 'invalid Conversation adapter',
            });
          }
        } else if (adapter.capabilities.conversation?.apiVersion === 1) {
          this.#report(adapter.id, {
            capability: 'conversation', availability: 'unavailable',
            message: 'Conversation binding is missing',
          });
        }
        if (binding.conversationActivity) conversationActivities[adapter.id] = binding.conversationActivity;
        if (binding.conversationActivation) {
          if (adapter.capabilities.conversationActivation?.apiVersion === 1
            && validController(binding.conversationActivation, ['describe', 'activate'])) {
            conversationActivations[adapter.id] = binding.conversationActivation;
          } else {
            this.#report(adapter.id, {
              capability: 'conversationActivation', availability: 'unavailable',
              message: 'invalid Conversation activation controller',
            });
          }
        } else if (adapter.capabilities.conversationActivation?.apiVersion === 1) {
          this.#report(adapter.id, {
            capability: 'conversationActivation', availability: 'unavailable',
            message: 'Conversation activation binding is missing',
          });
        }
        const controlBinding: AgentConversationControlBindings = {};
        const controlSpecs = [
          ['conversationGoal', 'goal', ['read']],
          ['conversationPlan', 'plan', ['read']],
          ['conversationContext', 'context', ['read']],
          ['conversationPermission', 'permission', ['read']],
          ['conversationCommands', 'commands', ['execute']],
        ] as const;
        for (const [capability, slot, methods] of controlSpecs) {
          const declared = adapter.capabilities[capability]?.apiVersion === 1;
          const controller = binding[capability];
          const commandsValid = capability !== 'conversationCommands'
            || (Array.isArray(binding.conversationCommands?.commands)
              && binding.conversationCommands.commands.every((command) => (
                command === 'compact' || command === 'clear'
              )));
          if (controller && declared && validController(controller, methods) && commandsValid) {
            Object.assign(controlBinding, { [slot]: controller });
          } else if (controller || declared) {
            this.#report(adapter.id, {
              capability, availability: 'unavailable',
              message: controller ? `invalid ${capability} controller` : `${capability} binding is missing`,
            });
          }
        }
        if (Object.keys(controlBinding).length) conversationControlBindings[adapter.id] = controlBinding;
        if (binding.interaction) {
          if (adapter.capabilities.interaction?.apiVersion === 1
            && validInteractionAdapter(binding.interaction)) {
            interactions[adapter.id] = binding.interaction;
          } else {
            this.#report(adapter.id, {
              capability: 'interaction', availability: 'unavailable',
              message: 'invalid Interaction adapter',
            });
          }
        } else if (adapter.capabilities.interaction?.apiVersion === 1) {
          this.#report(adapter.id, {
            capability: 'interaction', availability: 'unavailable',
            message: 'Interaction binding is missing',
          });
        }
        if (binding.sessionControl) {
          if (adapter.capabilities.sessionControl?.apiVersion === 1
            && validSessionControlAdapter(binding.sessionControl)) {
            sessionControls[adapter.id] = binding.sessionControl;
          } else {
            this.#report(adapter.id, {
              capability: 'sessionControl', availability: 'unavailable',
              message: 'invalid Session Control adapter',
            });
          }
        } else if (adapter.capabilities.sessionControl?.apiVersion === 1) {
          this.#report(adapter.id, {
            capability: 'sessionControl', availability: 'unavailable',
            message: 'Session Control binding is missing',
          });
        }
        if (binding.subscriptionUsage) {
          if (adapter.capabilities.subscriptionUsage?.apiVersion === 1
            && validSubscriptionUsageAdapter(binding.subscriptionUsage)) {
            subscriptionUsageAdapters[adapter.id] = binding.subscriptionUsage;
            if (binding.subscriptionUsageLegacy
              && typeof binding.subscriptionUsageLegacy.legacySnapshot === 'function') {
              subscriptionUsageLegacy[adapter.id] = binding.subscriptionUsageLegacy;
            }
          } else {
            this.#report(adapter.id, {
              capability: 'subscriptionUsage', availability: 'unavailable',
              message: 'invalid Subscription Usage adapter',
            });
          }
        } else if (adapter.capabilities.subscriptionUsage?.apiVersion === 1) {
          this.#report(adapter.id, {
            capability: 'subscriptionUsage', availability: 'unavailable',
            message: 'Subscription Usage binding is missing',
          });
        }
      } catch (error) {
        this.#report(adapter.id, {
          capability: 'factory',
          availability: 'unavailable',
          message: `capability factory failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const conversationStateFile = path.join(stateDirectory, 'conversation-state.json');
    const createConversation = (): ConversationService => new ConversationService({
        runs: this.runs,
        adapters: conversations,
        activitySource: new RuntimeConversationActivitySource(conversationActivities),
        store: new FileConversationStateStore(conversationStateFile),
        ...(conversationStartupBlockReason === undefined ? {} : {
          dispatchFences: { codex: conversationStartupBlockReason },
        }),
      });
    if (!Object.keys(conversations).length) this.conversation = null;
    else {
      try { this.conversation = createConversation(); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try { logger.error('Conversation state is invalid; dispatch is disabled', {
          kind: 'conversation', file: conversationStateFile, error: message,
        }); } catch { /* diagnostics cannot weaken fail-closed startup */ }
        for (const adapterId of Object.keys(conversations)) this.#report(adapterId, {
          capability: 'conversation', availability: 'unavailable', message,
        });
        this.conversation = null;
      }
    }
    if (this.conversation && conversationStartupBlockReason && conversations.codex) {
      this.#report('codex', {
        capability: 'conversationDispatch', availability: 'unavailable',
        message: conversationStartupBlockReason,
      });
    }
    this.conversationActivation = Object.keys(conversationActivations).length
      ? new AgentConversationActivationService(conversationActivations) : null;
    this.conversationControls = Object.keys(conversationControlBindings).length
      ? new AgentConversationControlService(conversationControlBindings) : null;
    const interactionStateFile = path.join(stateDirectory, 'interaction-state.json');
    this.interaction = Object.keys(interactions).length ? recoverCorruptState({
      file: interactionStateFile,
      kind: 'interaction',
      logger,
      isContractError: (error) => error instanceof InteractionContractError,
      create: () => new InteractionService({
        runs: this.runs,
        adapters: interactions,
        store: new FileInteractionStateStore(interactionStateFile),
      }),
    }) : null;
    this.sessionControl = Object.keys(sessionControls).length
      ? new AgentSessionControlService(sessionControls) : null;
    this.subscriptionUsage = Object.keys(subscriptionUsageAdapters).length
      ? new SubscriptionUsageService({
        adapters: subscriptionUsageAdapters,
        descriptors: Object.fromEntries(this.adapters.map((adapter) => [adapter.id, {
          label: adapter.label,
          ...(adapter.presentation === undefined ? {} : { presentation: adapter.presentation }),
        }])),
        reportHealth: (adapterId, update) => this.#report(adapterId, {
          capability: 'subscriptionUsage', ...update,
        }),
      }) : null;
    this.deprecatedSubscriptionUsage = this.subscriptionUsage
      && Object.keys(subscriptionUsageLegacy).length
      ? new DeprecatedSubscriptionUsageFacade({
        usage: this.subscriptionUsage, projectors: subscriptionUsageLegacy,
      }) : null;

    this.socketPath = socketPath;
    this.bridgeAuthToken = credential(
      path.join(stateDirectory, 'bridge-credential.json'),
      authToken,
      newBridgeAuthToken,
    );
    this.#transport = new LocalAgentBridgeTransportServer({
      socketPath,
      authToken: this.bridgeAuthToken,
      bridge: this.bridge,
      authorize: (adapterId, candidate, generation) => this.#authorize(adapterId, candidate, generation),
      connected: (lease, connection) => this.#bridgeConnected(lease, connection),
    });
  }

  runControlFor(adapterId: string): ScopedAgentRunController {
    const controller = this.#controllers.get(adapterId);
    if (!controller) throw new Error(`Unknown Agent adapter: ${adapterId}`);
    return controller;
  }

  bridgeHostFor(adapterId: string): LocalAgentBridgeHost {
    return this.bridge.hostFor(adapterId);
  }

  capabilities(): AgentCapabilityDescriptor[] {
    return this.adapters.map((adapter) => {
      const binding = this.#bindings.get(adapter.id);
      return {
        id: adapter.id,
        label: adapter.label,
        ...(adapter.presentation?.iconId === undefined ? {} : { iconId: adapter.presentation.iconId }),
        capabilities: {
          inbox: adapter.capabilities.inbox?.apiVersion === 1 && binding?.inbox === true,
          conversation: adapter.capabilities.conversation?.apiVersion === 1
            && validConversationAdapter(binding?.conversation),
          conversationActivation: adapter.capabilities.conversationActivation?.apiVersion === 1
            && validController(binding?.conversationActivation, ['describe', 'activate']),
          conversationGoal: adapter.capabilities.conversationGoal?.apiVersion === 1
            && validController(binding?.conversationGoal, ['read']),
          conversationPlan: adapter.capabilities.conversationPlan?.apiVersion === 1
            && validController(binding?.conversationPlan, ['read']),
          conversationContext: adapter.capabilities.conversationContext?.apiVersion === 1
            && validController(binding?.conversationContext, ['read']),
          conversationPermission: adapter.capabilities.conversationPermission?.apiVersion === 1
            && validController(binding?.conversationPermission, ['read']),
          conversationCommands: adapter.capabilities.conversationCommands?.apiVersion === 1
            && validController(binding?.conversationCommands, ['execute'])
            && Array.isArray(binding?.conversationCommands?.commands),
          interaction: adapter.capabilities.interaction?.apiVersion === 1
            && validInteractionAdapter(binding?.interaction),
          sessionControl: adapter.capabilities.sessionControl?.apiVersion === 1
            && validSessionControlAdapter(binding?.sessionControl),
          subscriptionUsage: adapter.capabilities.subscriptionUsage?.apiVersion === 1
            && validSubscriptionUsageAdapter(binding?.subscriptionUsage),
        },
        ...(adapter.capabilities.conversation?.apiVersion === 1
          && validConversationAdapter(binding?.conversation)
          ? { capabilityMetadata: {
            conversation: { experimental: adapter.capabilities.conversation.experimental === true },
          } } : {}),
      };
    });
  }

  health(): AgentRuntimeHealthEntry[] {
    return [...this.#health.values()].map((entry) => structuredClone(entry));
  }

  activeRuns(): AgentRunRef[] {
    return [...this.#tracked.values()]
      .filter((tracked) => !tracked.lease.signal.aborted
        && this.runs.resolve(tracked.lease.ref) === tracked.lease)
      .map((tracked) => structuredClone(tracked.lease.ref))
      .sort((first, second) => first.paneId.localeCompare(second.paneId)
      || first.agentId.localeCompare(second.agentId));
  }

  async identifyPanes(panes: readonly LivePane[]): Promise<Record<string, string | null>> {
    const activeAdapters = this.adapters.filter((adapter) => (
      !this.#lifecycles.get(adapter.id)?.abort.signal.aborted
    ));
    const resolved = await Promise.all(panes.map(async (
      pane,
    ): Promise<[string, string | null] | null> => {
      let inspected: Promise<ForegroundProcessIdentity | null> | undefined;
      const context: ProcessContext = {
        inspectForeground: () => {
          inspected ??= this.#process.inspectForeground(pane);
          return inspected;
        },
      };
      const identity = await resolveAgentIdentity(pane, activeAdapters, context, {
        verifyTimeoutMs: this.#verifyTimeoutMs,
      });
      if (identity.kind === 'matched') return [pane.paneId, identity.adapter.id];
      if (identity.kind === 'conflict') {
        this.#logger.warn('Agent pane identity conflict', {
          paneId: pane.paneId,
          candidateIds: identity.candidateIds,
        });
        return [pane.paneId, null];
      }
      // Unknown means the verifier failed or timed out. Omitting the pane preserves the last confirmed
      // owner in consumers; only an explicit `none` is authoritative evidence that the Agent exited.
      return identity.kind === 'none' ? [pane.paneId, null] : null;
    }));
    return Object.fromEntries(resolved.filter(
      (entry): entry is [string, string | null] => entry !== null,
    ));
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('AgentRuntime is closed');
    if (this.#started) return;
    if (this.#startPromise) return this.#startPromise;
    const operation = this.#start();
    this.#startPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#startPromise === operation) this.#startPromise = undefined;
    }
  }

  async #start(): Promise<void> {
    let unsubscribe: (() => void) | undefined;
    try {
      // Establish the only fallible shared prerequisite before adapters acquire resources. Connections
      // arriving inside this short starting window fail closed and can retry once #started is committed.
      await this.#transport.start();
      if (this.#closed) throw new Error('AgentRuntime is closed');
      unsubscribe = this.#panes.subscribe((snapshot) => {
        const operation = this.#reconcileTail.then(() => this.#reconcile(snapshot));
        this.#reconcileTail = operation.catch((error) => {
          this.#logger.warn('Agent pane reconciliation failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
      this.#unsubscribePanes = unsubscribe;
      for (const adapter of this.adapters) {
        if (this.#closed) throw new Error('AgentRuntime is closed');
        await this.#startAdapter(adapter);
      }
      if (this.#closed) throw new Error('AgentRuntime is closed');
      this.#started = true;
    } catch (error) {
      unsubscribe?.();
      if (this.#unsubscribePanes === unsubscribe) this.#unsubscribePanes = undefined;
      await this.#transport.close();
      if (!this.#closed) {
        const message = error instanceof Error ? error.message : String(error);
        for (const adapter of this.adapters) this.#report(adapter.id, {
          availability: 'unavailable', message,
        });
      }
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#startPromise?.catch(() => {});
    this.#unsubscribePanes?.();
    this.#unsubscribePanes = undefined;
    await this.#reconcileTail.catch(() => {});
    await this.#transport.close();
    await this.runs.shutdown();
    await this.interaction?.shutdown();
    for (const lifecycle of [...this.#lifecycles.values()].reverse()) {
      lifecycle.abort.abort('runtime_shutdown');
      await this.#cleanupLifecycle(lifecycle);
    }
    await this.bridge.close();
  }

  async #startAdapter(adapter: AgentAdapter): Promise<void> {
    const lifecycle = this.#lifecycles.get(adapter.id)!;
    try {
      if (adapter.activate) {
        const cleanup = await lifecycleWithin(
          Promise.resolve().then(() => adapter.activate!(
            this.#context(adapter, this.#adapterOptions[adapter.id] ?? {}),
          )),
          this.#activationTimeoutMs,
          `${adapter.id} activation`,
        );
        if (cleanup) lifecycle.cleanup.push(cleanup);
      }
    } catch (error) {
      lifecycle.abort.abort('adapter_start_failed');
      await this.runs.revokeAdapter(adapter.id);
      await this.#cleanupLifecycle(lifecycle);
      this.#report(adapter.id, {
        availability: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const binding = this.#bindings.get(adapter.id);
    try {
      if (binding?.start) {
        const cleanup = await lifecycleWithin(
          Promise.resolve().then(() => binding.start!()),
          this.#activationTimeoutMs,
          `${adapter.id} capability start`,
        );
        if (cleanup) lifecycle.cleanup.push(cleanup);
      }
      if (binding) this.#startedBindings.add(adapter.id);
    } catch (error) {
      this.#report(adapter.id, {
        capability: binding?.inbox ? 'inbox' : 'binding',
        availability: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.#report(adapter.id, { availability: 'ready', lastSuccessAt: Date.now() });
  }

  async #cleanupLifecycle(lifecycle: AdapterLifecycle): Promise<void> {
    for (const cleanup of lifecycle.cleanup.splice(0).reverse()) {
      try {
        await lifecycleWithin(Promise.resolve().then(cleanup), this.#activationTimeoutMs, 'Agent cleanup');
      } catch (error) {
        this.#logger.warn('Agent cleanup failed', {
          adapterId: lifecycle.adapter.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  #context(
    adapter: AgentAdapter,
    options: Readonly<Record<string, unknown>>,
  ): AgentRuntimeCapabilityContext {
    const lifecycle = this.#lifecycles.get(adapter.id)!;
    return Object.freeze({
      runs: this.runs,
      runControl: this.#controllers.get(adapter.id)!,
      panes: this.#panes,
      process: this.#process,
      bridge: this.bridge.hostFor(adapter.id),
      resources: this.resources.forAdapter(adapter.id),
      logger: this.#logger,
      health: this.#healthReporter(adapter.id),
      options: Object.freeze({ ...options }),
      signal: lifecycle.abort.signal,
      inbox: this.inbox.projectorFor(adapter.id),
    });
  }

  #healthReporter(adapterId: string): AdapterHealthReporter {
    return Object.freeze({
      report: (update: Parameters<AdapterHealthReporter['report']>[0]) => (
        this.#report(adapterId, update)
      ),
    });
  }

  #report(
    adapterId: string,
    update: Omit<AgentRuntimeHealthEntry, 'adapterId'>,
  ): void {
    const key = `${adapterId}\0${update.capability ?? ''}`;
    this.#health.set(key, { adapterId, ...structuredClone(update) });
  }

  #trackedController(
    adapter: AgentAdapter,
    raw: ScopedAgentRunController,
  ): ScopedAgentRunController {
    return Object.freeze({
      attach: async (candidate: AgentAttachmentCandidate) => (
        this.#track(adapter, await raw.attach(candidate), candidate)
      ),
      associateSession: async (lease: AgentRunLease, sessionId: string) => {
        const ref = await raw.associateSession(lease, sessionId);
        const tracked = this.#tracked.get(ref.runId);
        if (tracked && tracked.lease === lease) tracked.candidate.sessionId = sessionId;
        return ref;
      },
      replace: async (
        current: AgentRunLease,
        candidate: AgentAttachmentCandidate,
        reason: RunRevokeReason,
      ) => (
        this.#track(adapter, await raw.replace(current, candidate, reason), candidate)
      ),
      revoke: (lease: AgentRunLease, reason: RunRevokeReason) => raw.revoke(lease, reason),
    });
  }

  #track(
    adapter: AgentAdapter,
    lease: AgentRunLease,
    candidate: AgentAttachmentCandidate,
  ): AgentRunLease {
    const tracked: TrackedRun = { adapter, lease, candidate: cloneCandidate(candidate) };
    this.#tracked.set(lease.ref.runId, tracked);
    const remove = (): void => {
      if (this.#tracked.get(lease.ref.runId) === tracked) this.#tracked.delete(lease.ref.runId);
    };
    if (lease.signal.aborted) remove(); else lease.signal.addEventListener('abort', remove, { once: true });
    return lease;
  }

  async #authorize(
    adapterId: string,
    candidate: AgentAttachmentCandidate,
    generation?: { id: string; replace: true },
  ): Promise<AgentRunLease> {
    if (!this.#started || this.#closed) throw new Error('AgentRuntime is unavailable');
    const previous = this.#authorizationQueues.get(candidate.paneId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => current);
    this.#authorizationQueues.set(candidate.paneId, queued);
    await previous.catch(() => {});
    try {
      return await this.#authorizeGeneration(adapterId, candidate, generation);
    } finally {
      release();
      if (this.#authorizationQueues.get(candidate.paneId) === queued) {
        this.#authorizationQueues.delete(candidate.paneId);
      }
    }
  }

  async #authorizeGeneration(
    adapterId: string,
    candidate: AgentAttachmentCandidate,
    generation?: { id: string; replace: true },
  ): Promise<AgentRunLease> {
    const controller = this.runControlFor(adapterId);
    const current = this.runs.currentForPane(candidate.paneId);
    if (!generation || !current || current.ref.agentId !== adapterId) {
      const lease = await controller.attach(candidate);
      if (generation) this.#tracked.get(lease.ref.runId)!.bridgeGenerationId = generation.id;
      return lease;
    }
    const tracked = this.#tracked.get(current.ref.runId);
    if (tracked?.bridgeGenerationId === generation.id) {
      return controller.attach(candidate);
    }
    const lease = await controller.replace(current, candidate, 'session_replaced');
    this.#tracked.get(lease.ref.runId)!.bridgeGenerationId = generation.id;
    return lease;
  }

  async #bridgeConnected(lease: AgentRunLease, connection: LocalAgentBridgeConnection): Promise<void> {
    const binding = this.#bindings.get(lease.ref.agentId);
    if (!binding?.onBridgeConnected || !this.#startedBindings.has(lease.ref.agentId)) return;
    try {
      await binding.onBridgeConnected(lease, connection);
      this.#report(lease.ref.agentId, {
        capability: 'bridge', availability: 'ready', lastSuccessAt: Date.now(),
      });
    } catch (error) {
      this.#report(lease.ref.agentId, {
        capability: 'bridge', availability: 'degraded',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #verifyAttachment(
    adapter: AgentAdapter,
    candidate: AgentAttachmentCandidate,
  ): Promise<boolean> {
    let panes: readonly LivePane[];
    try { panes = await this.#panes.list(); } catch { return false; }
    const pane = panes.find((value) => value.paneId === candidate.paneId);
    return pane ? (await this.#verifyAgainst(adapter, candidate, pane)) === 'valid' : false;
  }

  async #verifyAgainst(
    adapter: AgentAdapter,
    candidate: AgentAttachmentCandidate,
    pane: LivePane,
  ): Promise<'valid' | 'invalid' | 'unknown'> {
    let inspected: Promise<ForegroundProcessIdentity | null> | undefined;
    const context: ProcessContext = {
      inspectForeground: () => {
        inspected ??= this.#process.inspectForeground(pane);
        return inspected;
      },
    };
    try {
      return await lifecycleWithin((async (): Promise<'valid' | 'invalid' | 'unknown'> => {
        const identity = await resolveAgentIdentity(pane, this.adapters, context, {
          verifyTimeoutMs: this.#verifyTimeoutMs,
        });
        if (identity.kind === 'unknown') return 'unknown';
        if (identity.kind !== 'matched' || identity.adapter.id !== adapter.id) return 'invalid';
        const foreground = await context.inspectForeground(pane);
        if (foreground === null) return 'unknown';
        return sameProcess(candidate, pane, foreground) ? 'valid' : 'invalid';
      })(), this.#verifyTimeoutMs, 'Agent process verification');
    } catch { return 'unknown'; }
  }

  async #reconcile(snapshot: readonly LivePane[]): Promise<void> {
    const panes = new Map(snapshot.map((pane) => [pane.paneId, pane]));
    for (const tracked of [...this.#tracked.values()]) {
      if (this.#closed) return;
      if (tracked.lease.signal.aborted || this.runs.resolve(tracked.lease.ref) !== tracked.lease) continue;
      const pane = panes.get(tracked.lease.ref.paneId);
      const verdict = pane
        ? await this.#verifyAgainst(tracked.adapter, tracked.candidate, pane)
        : 'invalid';
      if (verdict === 'invalid' && this.runs.resolve(tracked.lease.ref) === tracked.lease) {
        await this.runs.revokePane(tracked.lease.ref.paneId, pane ? 'process_exit' : 'pane_detached');
      }
    }
  }
}
