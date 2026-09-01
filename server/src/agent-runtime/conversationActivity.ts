import type { AgentRunLease } from './run.js';
import type {
  ConversationActivity,
  ConversationActivitySnapshot,
  ConversationActivitySource,
} from './conversationTypes.js';

export interface AgentConversationActivityReader {
  read(run: AgentRunLease): Promise<{
    activity: ConversationActivity;
    activeTurn?: { state: 'active'; nativeTurnId: string } | { state: 'none' } | { state: 'unknown' };
    completionToken?: string;
  }>;
}

function key(run: AgentRunLease): string {
  return `${run.ref.agentId}\0${run.ref.sessionId ?? ''}`;
}

function validActivity(value: unknown): value is ConversationActivity {
  return value === 'idle' || value === 'working' || value === 'waiting'
    || value === 'compacting' || value === 'unknown';
}

function normalizeActiveTurn(value: unknown): ConversationActivitySnapshot['activeTurn'] {
  if (!value || typeof value !== 'object') return { state: 'unknown' };
  const record = value as Record<string, unknown>;
  if (record.state === 'none') return { state: 'none' };
  if (record.state === 'active' && typeof record.nativeTurnId === 'string' && record.nativeTurnId) {
    return { state: 'active', nativeTurnId: record.nativeTurnId };
  }
  return { state: 'unknown' };
}

/** Runtime-owned normalization: provider readers never own revisions or dispatch state. */
export class RuntimeConversationActivitySource implements ConversationActivitySource {
  readonly #readers: ReadonlyMap<string, AgentConversationActivityReader>;
  readonly #snapshots = new Map<string, ConversationActivitySnapshot>();
  readonly #readGenerations = new Map<string, number>();

  constructor(readers: Readonly<Record<string, AgentConversationActivityReader>>) {
    this.#readers = new Map(Object.entries(readers));
  }

  async read(run: AgentRunLease): Promise<ConversationActivitySnapshot> {
    const owner = key(run);
    const epoch = run.ref.runId;
    const generation = (this.#readGenerations.get(owner) ?? 0) + 1;
    this.#readGenerations.set(owner, generation);
    const reader = this.#readers.get(run.ref.agentId);
    let activity: ConversationActivity = 'unknown';
    let activeTurn: ConversationActivitySnapshot['activeTurn'] = { state: 'unknown' };
    let completionToken: string | undefined;
    try {
      const raw = await reader?.read(run);
      if (raw && validActivity(raw.activity)) {
        activity = raw.activity;
        activeTurn = normalizeActiveTurn(raw.activeTurn);
        if (typeof raw.completionToken === 'string' && raw.completionToken
          && raw.completionToken.length <= 1024) completionToken = raw.completionToken;
      }
    } catch { /* an unreadable provider snapshot is explicitly unknown */ }
    const current = this.#snapshots.get(owner);
    if (run.signal.aborted || run.ref.runId !== epoch || key(run) !== owner
      || this.#readGenerations.get(owner) !== generation) {
      return structuredClone(current ?? {
        activity: 'unknown', activeTurn: { state: 'unknown' }, revision: 1, epoch,
      });
    }
    const previous = current;
    const semantic = `${activity}\0${activeTurn.state}\0${activeTurn.state === 'active' ? activeTurn.nativeTurnId : ''}\0${completionToken ?? ''}`;
    const previousSemantic = previous
      ? `${previous.activity}\0${previous.activeTurn.state}\0${previous.activeTurn.state === 'active'
        ? previous.activeTurn.nativeTurnId : ''}\0${previous.completionToken ?? ''}` : '';
    const revision = previous?.epoch === epoch
      ? previous.revision + (semantic === previousSemantic ? 0 : 1)
      : 1;
    const snapshot: ConversationActivitySnapshot = {
      activity, activeTurn, revision, epoch,
      ...(completionToken === undefined ? {} : { completionToken }),
    };
    this.#snapshots.set(owner, snapshot);
    return structuredClone(snapshot);
  }
}
