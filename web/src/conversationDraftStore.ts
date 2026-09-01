const MAX_SESSION_DRAFTS = 20;
const DRAFT_STORAGE_KEY = 'tw_agent_conversation_drafts_v1';

function loadSessionDrafts(): Map<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '[]') as unknown;
    if (!Array.isArray(value)) return new Map();
    return new Map(value.slice(-MAX_SESSION_DRAFTS).flatMap((entry) => (
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
        && entry[0].length <= 1_152 && typeof entry[1] === 'string' && entry[1].length <= 262_144
        ? [[entry[0], entry[1]] as [string, string]] : []
    )));
  } catch { return new Map(); }
}

const drafts = loadSessionDrafts();
const key = (agentId: string, sessionId: string): string => `${agentId}\0${sessionId}`;

function persist(): void {
  try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify([...drafts])); }
  catch { /* private browsing/storage pressure: the in-memory fallback remains usable */ }
}

export function getConversationDraft(agentId: string, sessionId: string): string {
  return drafts.get(key(agentId, sessionId)) ?? '';
}

export function saveConversationDraft(agentId: string, sessionId: string, value: string): void {
  const identity = key(agentId, sessionId);
  drafts.delete(identity);
  if (value) drafts.set(identity, value);
  while (drafts.size > MAX_SESSION_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
  persist();
}

export function mergeConversationDraftAfterFailure(sent: string, current: string): string {
  if (!current) return sent;
  if (!sent || current.includes(sent)) return current;
  return `${sent}\n${current}`;
}

export function appendConversationDraft(current: string, fragment: string): string {
  if (!fragment || current.includes(fragment)) return current;
  if (!current) return fragment;
  return `${current}\n${fragment}`;
}
