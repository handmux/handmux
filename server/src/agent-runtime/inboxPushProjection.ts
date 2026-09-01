import type { LivePane, ReadonlyPaneSource } from './adapter.js';
import type { InboxService } from './inbox.js';
import type { InboxUserNotificationEvent } from './inboxTypes.js';
import type { AgentRunRegistry } from './run.js';

interface InboxPushTarget {
  sendToSession(
    session: string,
    payload: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface InboxPushProjectionOptions {
  inbox: Pick<InboxService, 'subscribeNotifications'>;
  runs: AgentRunRegistry;
  panes: Pick<ReadonlyPaneSource, 'list'>;
  push: InboxPushTarget;
}

const LABELS = {
  waiting: '需要你',
  done: '已完成',
  error: '出错',
} as const;

function body(event: InboxUserNotificationEvent): string {
  // `reason` belongs to the machine contract, not notification copy.
  const value = (event.message || LABELS[event.state]).replace(/\s+/g, ' ').trim();
  return value.slice(0, 240) || LABELS[event.state];
}

function paneFor(event: InboxUserNotificationEvent, panes: readonly LivePane[]): LivePane | undefined {
  return panes.find((pane) => pane.paneId === event.run.paneId && pane.sessionName.length > 0);
}

// Delivery-only projection. Inbox Core owns persistence, acceptedAt, unread, and deduplication; tmux is
// consulted only for the current device subscription scope and presentation location.
export class InboxPushProjection {
  readonly #inbox: Pick<InboxService, 'subscribeNotifications'>;
  readonly #runs: AgentRunRegistry;
  readonly #panes: Pick<ReadonlyPaneSource, 'list'>;
  readonly #push: InboxPushTarget;
  #unsubscribe: (() => void) | undefined;

  constructor({ inbox, runs, panes, push }: InboxPushProjectionOptions) {
    if (!inbox || !runs || !panes || !push || typeof push.sendToSession !== 'function') {
      throw new TypeError('Inbox push projection requires Core, run, pane, and push dependencies');
    }
    this.#inbox = inbox;
    this.#runs = runs;
    this.#panes = panes;
    this.#push = push;
  }

  start(): () => void {
    if (!this.#unsubscribe) {
      this.#unsubscribe = this.#inbox.subscribeNotifications((event) => this.#deliver(event));
    }
    return () => this.close();
  }

  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async #deliver(event: InboxUserNotificationEvent): Promise<void> {
    const lease = this.#runs.resolve(event.run);
    if (!lease) return;
    const pane = paneFor(event, await this.#panes.list());
    if (!pane || this.#runs.resolve(event.run) !== lease) return;
    const label = LABELS[event.state];
    await this.#push.sendToSession(pane.sessionName, {
      title: `${label} · ${pane.sessionName}`,
      body: body(event),
      tag: `pane-${event.run.paneId}`,
      data: {
        session: pane.sessionName,
        window: pane.windowId,
        pane: event.run.paneId,
        agentId: event.run.agentId,
        runId: event.run.runId,
        ...(event.run.sessionId === undefined ? {} : { sessionId: event.run.sessionId }),
        ...(event.terminalNotificationId === undefined
          ? {} : { terminalNotificationId: event.terminalNotificationId }),
      },
    }, {
      topic: `pane-${event.run.paneId}`,
      ttl: event.state === 'waiting' ? 14_400 : 1_800,
      urgency: event.state === 'waiting' ? 'high' : 'normal',
    });
  }
}
