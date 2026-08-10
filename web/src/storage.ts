import { parseIdeas, type Idea } from './ideas';

type PlainMap = Record<string, unknown>;
type StringMap = Record<string, string>;
type RuntimeKind = 'sessions' | 'windows' | 'panes';
type RuntimeMapping = Record<RuntimeKind, StringMap>;

export interface WorkspacePromptState {
  autoShown?: boolean;
  ignored?: boolean;
}

export interface WorkspaceRestoreMapping {
  id?: unknown;
  runtime?: unknown;
  names?: unknown;
}

interface ValidatedWorkspaceRestoreMapping {
  id: string;
  runtime: RuntimeMapping;
  names: StringMap;
}

interface RememberedLocation {
  sessionId?: string | null;
  windowId?: string | null;
  paneId?: string | null;
}

export interface RecentDoc {
  path: string;
  name: string;
  type: string;
  ts: number;
}

const TOKEN_KEY = 'tw_token';
const BROWSER_DEVICE_KEY = 'hm_browser_device1';
const BROWSER_ACCESS_KEY = 'hm_browser_access1';
const FONT_KEY = 'tw_font';
const BOUND_KEY = 'tw_bound';               // string[] of session NAMES the user has bound (client-only)
const LAST_SESSION_KEY = 'tw_last_session'; // sessionId of the last-opened session (boot fallback)
const WIN_BY_SESSION_KEY = 'tw_win';        // { [sessionId]: windowId }  — last window per session
const PANE_BY_WINDOW_KEY = 'tw_pane';       // { [windowId]: paneId }     — last pane per window
const FAVS_KEY = 'tw_favs';                 // string[] of favorite command strings (global)
const RECENT_KEY = 'tw_recent';             // { [sessionName]: string[] } — recent sent commands per session
const RECENT_CAP = 30;                      // max recent entries kept per session
const INBOX_SEEN_KEY = 'tw_inbox_seen';     // { [pane]: ts } — last inbox ts the user viewed per pane
const INBOX_READ_TS_KEY = 'tw_inbox_read_ts'; // server-ts high-water mark: done with ts <= this is history
const BROWSE_DIR_KEY = 'tw_browse_dir';     // { [windowId]: absPath } — last browsed dir per window (file sheet)
const PREVIEW_DIR_KEY = 'tw_preview_dir';   // { [windowId]: absPath } — last static-preview dir per window
const STARTUP_CMD_KEY = 'tw_startup_cmd';   // last startup command chosen in new window/session (e.g. "claude")
const CHAT_DRAFT_KEY = 'tw_chat_draft';     // the chat composer's unsent text — survives an app exit/kill
const CHAT_TONE_KEY = 'tw_chat_tone';       // the 对话-lens colour tone the user picked (ink | light | dusk)
const CHAT_LENS_KEY = 'tw_chat_lens';       // legacy shared opt-in; read only as a migration fallback
const CLAUDE_CHAT_LENS_KEY = 'tw_chat_lens_claude';
const CODEX_CHAT_LENS_KEY = 'tw_chat_lens_codex';
const IDEAS_KEY = 'tw_ideas';               // { [sessionName]: { [windowName]: Idea[] } } — per-window todo list
const CHANGELOG_SEEN_KEY = 'tw_changelog_seen'; // the latest changelog entry id (v) the user has opened
const VERSION_SEEN_KEY = 'tw_version_seen';     // the npm "latest" version already acknowledged in Settings
const GIT_REPOS_KEY = 'tw_git_repos';          // { [windowId]: absPath[] } —
const GIT_DIRS_KEY = 'tw_git_dirs';            // { [windowId]: absPath[] } — dirs the user picked repos from (history, newest first) bound git repos per window absolute paths (order = tab order)
const WORKSPACE_PROMPT_KEY = 'tw_workspace_prompt';
const WORKSPACE_APPLIED_MAPPINGS_KEY = 'tw_workspace_applied_mappings';
const SAFE_MAPPING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RUNTIME_ID_PATTERNS: Record<RuntimeKind, RegExp> = {
  sessions: /^\$\d+$/,
  windows: /^@\d+$/,
  panes: /^%\d+$/,
};
const hasOwn = (object: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(object, key);

function parseStoredJson(key: string): unknown {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try { return JSON.parse(raw) as unknown; }
  catch { return null; }
}

function isPlainObject(value: unknown): value is PlainMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

// Opaque per-install identity for isolating authenticated Browser sessions between phones. It is not an
// account credential: the normal Handmux token is still required for every API request.
export function getBrowserDeviceId() {
  const stored = localStorage.getItem(BROWSER_DEVICE_KEY);
  if (/^[A-Za-z0-9_-]{32,128}$/.test(stored || '')) return stored;
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const value = `device_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  localStorage.setItem(BROWSER_DEVICE_KEY, value);
  return value;
}
export const isBrowserAccessEnabled = () => localStorage.getItem(BROWSER_ACCESS_KEY) === '1';
export const setBrowserAccessEnabled = (enabled: boolean) => {
  if (enabled) localStorage.setItem(BROWSER_ACCESS_KEY, '1');
  else localStorage.removeItem(BROWSER_ACCESS_KEY);
};

// Bound sessions live only in the browser — the server never knows which sessions a given
// device has pinned. We store names (not ids): a tmux name is stable and user-chosen, while
// the id ($0) churns across tmux restarts.
export function getBoundSessions() {
  try {
    return stringList(parseStoredJson(BOUND_KEY));
  }
  catch { return []; }
}
export function addBoundSession(name: string): string[] {
  const list = getBoundSessions();
  if (!list.includes(name)) list.push(name);
  localStorage.setItem(BOUND_KEY, JSON.stringify(list));
  return list;
}
export function removeBoundSession(name: string): string[] {
  const list = getBoundSessions().filter((n) => n !== name);
  localStorage.setItem(BOUND_KEY, JSON.stringify(list));
  return list;
}

export function removeRestoredSessionBindings(results: unknown): string[] {
  const restoredNames = new Set((Array.isArray(results) ? results : [])
    .flatMap((candidate): string[] => {
      if (!isPlainObject(candidate)) return [];
      return candidate.status === 'restored' && typeof candidate.targetName === 'string' && candidate.targetName
        ? [candidate.targetName] : [];
    }));
  const list = getBoundSessions().filter((name) => !restoredNames.has(name));
  localStorage.setItem(BOUND_KEY, JSON.stringify(list));
  return list;
}

// Rename a bound session in place: swap the name in tw_bound (keeping its list position) and carry
// its recent-command history (tw_recent is keyed by NAME) to the new name. tw_win is keyed by
// session id, which rename-session does NOT change, so it needs no migration.
export function renameBoundSession(oldName: string, newName: string): string[] {
  const list = getBoundSessions().map((n) => (n === oldName ? newName : n));
  localStorage.setItem(BOUND_KEY, JSON.stringify(list));
  // Recent-command history and ideas are both keyed by session NAME — carry each whole sub-tree across.
  recentStore.renameSession(oldName, newName);
  ideasStore.renameSession(oldName, newName);
  return list;
}

function readMap(key: string): PlainMap {
  // Must return a PLAIN OBJECT. A legacy value that parses to an array (e.g. tw_git_repos was once a
  // global flat array, before per-window keying) would otherwise be returned as-is — then writeMapEntry
  // sets arr[windowId]=… as a non-index property, which JSON.stringify silently DROPS, so every write
  // vanishes. Coerce anything that isn't a plain object back to {}.
  try {
    const value = parseStoredJson(key);
    return isPlainObject(value) ? value : {};
  } catch { return {}; }
}
function writeMapEntry(key: string, entryKey: string, value: unknown): void {
  const m = readMap(key);
  m[entryKey] = value;
  localStorage.setItem(key, JSON.stringify(m));
}

function writeWorkspacePrompt(checkpointId: string, patch: WorkspacePromptState): WorkspacePromptState {
  if (!checkpointId) return {};
  const all = readMap(WORKSPACE_PROMPT_KEY);
  const current = all[checkpointId];
  all[checkpointId] = {
    ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
    ...patch,
  };
  localStorage.setItem(WORKSPACE_PROMPT_KEY, JSON.stringify(all));
  return all[checkpointId] as WorkspacePromptState;
}

export const getWorkspacePromptState = (checkpointId: string | null | undefined): WorkspacePromptState => {
  if (!checkpointId) return {};
  const value = readMap(WORKSPACE_PROMPT_KEY)[checkpointId];
  if (!isPlainObject(value)) return {};
  return {
    ...(typeof value.autoShown === 'boolean' ? { autoShown: value.autoShown } : {}),
    ...(typeof value.ignored === 'boolean' ? { ignored: value.ignored } : {}),
  };
};
export const markWorkspaceAutoShown = (checkpointId: string) =>
  writeWorkspacePrompt(checkpointId, { autoShown: true });
export const ignoreWorkspaceCheckpoint = (checkpointId: string) =>
  writeWorkspacePrompt(checkpointId, { ignored: true, autoShown: true });

function getAppliedWorkspaceMappings(): string[] {
  try {
    return stringList(parseStoredJson(WORKSPACE_APPLIED_MAPPINGS_KEY));
  } catch { return []; }
}

function validateWorkspaceMapping(mapping: unknown): ValidatedWorkspaceRestoreMapping | null {
  try {
    if (!isPlainObject(mapping) || typeof mapping.id !== 'string' || !SAFE_MAPPING_ID.test(mapping.id)) return null;
    if (mapping.runtime !== undefined && !isPlainObject(mapping.runtime)) return null;
    if (mapping.names !== undefined && !isPlainObject(mapping.names)) return null;

    const rawRuntime = isPlainObject(mapping.runtime) ? mapping.runtime : {};
    if (Object.keys(rawRuntime).some((kind) => !hasOwn(RUNTIME_ID_PATTERNS, kind))) return null;
    const runtime: RuntimeMapping = { sessions: {}, windows: {}, panes: {} };
    for (const kind of Object.keys(RUNTIME_ID_PATTERNS) as RuntimeKind[]) {
      const pattern = RUNTIME_ID_PATTERNS[kind];
      const rawKind = rawRuntime[kind];
      if (rawKind === undefined) continue;
      if (!isPlainObject(rawKind)) return null;
      for (const [source, actual] of Object.entries(rawKind)) {
        if (!pattern.test(source) || typeof actual !== 'string' || !pattern.test(actual)) return null;
        runtime[kind][source] = actual;
      }
    }

    const names: StringMap = {};
    const rawNames = isPlainObject(mapping.names) ? mapping.names : {};
    for (const [source, actual] of Object.entries(rawNames)) {
      if (!source || typeof actual !== 'string' || !actual) return null;
      names[source] = actual;
    }
    const hasEntries = Object.keys(names).length > 0
      || Object.values(runtime).some((kind) => Object.keys(kind).length > 0);
    return hasEntries ? { id: mapping.id, runtime, names } : null;
  } catch { return null; }
}

function readStoredPlainMap(key: string): { raw: string; value: PlainMap } | null {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return isPlainObject(value) ? { raw, value } : null;
  } catch { return null; }
}

function remapMapKey(key: string, keyMapping: StringMap, valueMapping: StringMap = {}): void {
  const stored = readStoredPlainMap(key);
  if (!stored) return;
  const current = stored.value;
  const matched = Object.keys(keyMapping).filter((oldKey) => hasOwn(current, oldKey));
  if (matched.length === 0) return;
  const next: PlainMap = {};
  for (const [oldKey, oldValue] of Object.entries(current)) {
    if (hasOwn(keyMapping, oldKey)) continue;
    next[oldKey] = oldValue;
  }
  for (const oldKey of matched) {
    const actualKey = keyMapping[oldKey];
    if (actualKey === undefined) continue;
    const oldValue = current[oldKey];
    next[actualKey] = typeof oldValue === 'string' && hasOwn(valueMapping, oldValue)
      ? valueMapping[oldValue]
      : oldValue;
  }
  const serialized = JSON.stringify(next);
  if (serialized !== stored.raw) localStorage.setItem(key, serialized);
}

function remapKnownWorkspaceKeys(runtime: RuntimeMapping): void {
  const { sessions, windows, panes } = runtime;

  if (Object.keys(sessions).length > 0) {
    const lastSession = localStorage.getItem(LAST_SESSION_KEY);
    if (lastSession && hasOwn(sessions, lastSession)) {
      const mappedSession = sessions[lastSession];
      if (mappedSession !== undefined) localStorage.setItem(LAST_SESSION_KEY, mappedSession);
    }
    remapMapKey(WIN_BY_SESSION_KEY, sessions, windows);
  }
  if (Object.keys(windows).length > 0) {
    remapMapKey(PANE_BY_WINDOW_KEY, windows, panes);
    for (const key of [GIT_REPOS_KEY, GIT_DIRS_KEY, BROWSE_DIR_KEY, PREVIEW_DIR_KEY]) {
      remapMapKey(key, windows);
    }
  }
  if (Object.keys(panes).length > 0) {
    for (const key of [PANE_BASE_KEY, INBOX_SEEN_KEY]) remapMapKey(key, panes);
  }
}

export function applyWorkspaceRestoreMapping(mapping: unknown): boolean {
  const validated = validateWorkspaceMapping(mapping);
  if (!validated) return false;
  const applied = getAppliedWorkspaceMappings();
  if (applied.includes(validated.id)) return false;

  remapKnownWorkspaceKeys(validated.runtime);
  if (Object.keys(validated.names).length > 0) {
    const bound = getBoundSessions();
    for (const [source, actual] of Object.entries(validated.names)) {
      if (bound.includes(source)) addBoundSession(actual);
    }
  }
  localStorage.setItem(WORKSPACE_APPLIED_MAPPINGS_KEY, JSON.stringify([...applied, validated.id]));
  return true;
}

// A localStorage-backed nested map { [session]: { [window]: T[] } } — the shape shared by recent commands
// and per-window ideas. Coerces a legacy non-object session value back to {} (recent was once a flat
// { [session]: string[] } before it became window-scoped), so a per-window write can't be a non-index
// property that JSON.stringify SILENTLY DROPS. Empty lists drop the window key (and an emptied session key)
// so storage never accretes husks. rename{Window,Session} carry a sub-tree when a tmux name changes.
interface NestedMapStore<T> {
  get(session: string, windowName: string): T[];
  set(session: string, windowName: string, list: readonly T[] | null | undefined): T[];
  renameWindow(session: string, oldWindow: string, newWindow: string): void;
  renameSession(oldSession: string, newSession: string): void;
}

function nestedMapStore<T>(key: string, parseList: (value: unknown) => T[]): NestedMapStore<T> {
  const wins = (value: unknown): PlainMap => (isPlainObject(value) ? value : {});
  return {
    get(session: string, windowName: string): T[] {
      if (!session || !windowName) return [];
      return parseList(wins(readMap(key)[session])[windowName]);
    },
    set(session: string, windowName: string, list: readonly T[] | null | undefined): T[] {
      const all = readMap(key);
      const w = wins(all[session]);
      if (list && list.length) w[windowName] = [...list];
      else delete w[windowName];
      if (Object.keys(w).length) all[session] = w;
      else delete all[session];
      localStorage.setItem(key, JSON.stringify(all));
      return list ? [...list] : [];
    },
    renameWindow(session: string, oldWindow: string, newWindow: string): void {
      if (!session || !oldWindow || !newWindow || oldWindow === newWindow) return;
      const all = readMap(key);
      const w = wins(all[session]);
      if (w[oldWindow] == null) return;
      w[newWindow] = w[oldWindow];
      delete w[oldWindow];
      all[session] = w;
      localStorage.setItem(key, JSON.stringify(all));
    },
    renameSession(oldSession: string, newSession: string): void {
      const all = readMap(key);
      if (all[oldSession] == null) return;
      all[newSession] = all[oldSession];
      delete all[oldSession];
      localStorage.setItem(key, JSON.stringify(all));
    },
  };
}
const recentStore = nestedMapStore(RECENT_KEY, stringList);
const ideasStore = nestedMapStore(IDEAS_KEY, parseIdeas);

// Inbox read-state: the ts of the last event the user viewed per pane. A pane's idle/permission
// counts as unread only while its event ts exceeds this. Viewing a pane bumps it (see App).
export const getInboxSeen = (): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const [pane, value] of Object.entries(readMap(INBOX_SEEN_KEY))) {
    if (typeof value === 'number' && Number.isFinite(value)) result[pane] = value;
  }
  return result;
};
export function markInboxSeen(pane: string, ts: number): Record<string, number> {
  writeMapEntry(INBOX_SEEN_KEY, pane, ts);
  return getInboxSeen();
}

// High-water mark (a server-side ts) below which "done" rows count as history, not new. null = unset
// (first run); App seeds it to the current max ts so the cold-start backlog never floods in.
export const getInboxReadTs = () => { const v = localStorage.getItem(INBOX_READ_TS_KEY); return v == null ? null : Number(v); };
export const setInboxReadTs = (ts: number) => localStorage.setItem(INBOX_READ_TS_KEY, String(ts));

// Inbox "new stuff" high-water: the newest notification ts the user has SEEN by opening the inbox page.
// Drives the top red dot (gear + 通知记录 row) — once you've opened the page, the dot clears even if
// individual messages inside are still unread; a newer notification relights it. Separate from the
// per-message read-id set below (which drives the in-page unread count / per-row blue dot).
const NOTIF_SEEN_TS_KEY = 'tw_notif_seen_ts';
export const getNotifSeenTs = () => { const v = localStorage.getItem(NOTIF_SEEN_TS_KEY); return v == null ? 0 : Number(v); };
export const setNotifSeenTs = (ts: number) => localStorage.setItem(NOTIF_SEEN_TS_KEY, String(ts));

// Per-message inbox read-state: id-based set (in-page unread count / per-row marker).
const NOTIF_READ_IDS_KEY = 'tw_notif_read_ids'; // ids of manual-push notifications already opened (per-device)
export const getReadInboxIds = (): string[] => {
  try { return stringList(parseStoredJson(NOTIF_READ_IDS_KEY)); }
  catch { return []; }
};
export const addReadInboxId = (id: string): void => {
  const cur = getReadInboxIds();
  if (!cur.includes(id)) localStorage.setItem(NOTIF_READ_IDS_KEY, JSON.stringify([...cur, id]));
};
export const pruneReadInboxIds = (currentIds: readonly string[]): string[] => {
  const keep = getReadInboxIds().filter((id) => currentIds.includes(id));
  localStorage.setItem(NOTIF_READ_IDS_KEY, JSON.stringify(keep));
  return keep;
};

// Last-browsed directory per window (file sheet). Keyed by window id so each window reopens where you
// left off; absent (a window's first open) → the caller falls back to the pane's cwd. Absolute path.
export const getBrowseDir = (windowId: string | null | undefined): string | null => {
  const value = windowId ? readMap(BROWSE_DIR_KEY)[windowId] : null;
  return typeof value === 'string' ? value : null;
};
export const setBrowseDir = (windowId: string | null | undefined, path: string | null | undefined): void => {
  if (windowId && path) writeMapEntry(BROWSE_DIR_KEY, windowId, path);
};

// Last static-preview dir per window — so the picker reopens on it next time (the user usually
// re-previews the same build dir). Falls back to the pane cwd when absent. Absolute path.
export const getPreviewDir = (windowId: string | null | undefined): string | null => {
  const value = windowId ? readMap(PREVIEW_DIR_KEY)[windowId] : null;
  return typeof value === 'string' ? value : null;
};
export const setPreviewDir = (windowId: string | null | undefined, path: string | null | undefined): void => {
  if (windowId && path) writeMapEntry(PREVIEW_DIR_KEY, windowId, path);
};

export const getLastSession = () => localStorage.getItem(LAST_SESSION_KEY);
export const getLastWindow = (sessionId: string): string | null => {
  const value = readMap(WIN_BY_SESSION_KEY)[sessionId];
  return typeof value === 'string' ? value : null;
};
export const getLastPane = (windowId: string): string | null => {
  const value = readMap(PANE_BY_WINDOW_KEY)[windowId];
  return typeof value === 'string' ? value : null;
};

// Persist wherever we just landed: the last session, that session's last window, and that
// window's last pane. Each piece is optional so callers can record just what changed (e.g. a
// pane switch passes only { windowId, paneId }).
export function remember({ sessionId, windowId, paneId }: RememberedLocation = {}): void {
  if (sessionId) localStorage.setItem(LAST_SESSION_KEY, sessionId);
  if (sessionId && windowId) writeMapEntry(WIN_BY_SESSION_KEY, sessionId, windowId);
  if (windowId && paneId) writeMapEntry(PANE_BY_WINDOW_KEY, windowId, paneId);
}

// Manual terminal font size (A−/A+). null = auto (height-fit default); a number = the
// user picked an explicit size, which then overrides auto-fit and persists across panes.
export function getFont() {
  const v = Number(localStorage.getItem(FONT_KEY));
  return Number.isFinite(v) && v > 0 ? v : null;
}
export const setFont = (n: number) => localStorage.setItem(FONT_KEY, String(n));
// Drop the manual size so the terminal returns to height auto-fit.
export const clearFont = () => localStorage.removeItem(FONT_KEY);

// 对话-lens colour tone — a user preference (default 暖夜/dusk). Applied as `data-chat-tone` on `.app`,
// consumed by the `--ct-*` token blocks in styles.css. All three tones are warm (see styles.css). Unknown/
// absent → the default tone.
export const CHAT_TONES = ['dusk', 'ink', 'light'] as const;
export type ChatTone = typeof CHAT_TONES[number];
const isChatTone = (value: unknown): value is ChatTone => (
  typeof value === 'string' && (CHAT_TONES as readonly string[]).includes(value)
);
export const getChatTone = (): ChatTone => {
  const v = localStorage.getItem(CHAT_TONE_KEY);
  return isChatTone(v) ? v : 'dusk';
};
export const setChatTone = (tone: ChatTone): void => {
  if (isChatTone(tone)) localStorage.setItem(CHAT_TONE_KEY, tone);
};

// Claude and Codex have independent chat-view opt-ins. Existing installs inherit the old shared value until
// each new switch is changed; explicit '0' is retained so turning one agent off never falls back to legacy '1'.
const getAgentChatLensEnabled = (key: string): boolean => {
  const value = localStorage.getItem(key);
  return value == null ? localStorage.getItem(CHAT_LENS_KEY) === '1' : value === '1';
};
const setAgentChatLensEnabled = (key: string, on: boolean): void => localStorage.setItem(key, on ? '1' : '0');
export const getClaudeChatLensEnabled = () => getAgentChatLensEnabled(CLAUDE_CHAT_LENS_KEY);
export const setClaudeChatLensEnabled = (on: boolean) => setAgentChatLensEnabled(CLAUDE_CHAT_LENS_KEY, on);
export const getCodexChatLensEnabled = () => getAgentChatLensEnabled(CODEX_CHAT_LENS_KEY);
export const setCodexChatLensEnabled = (on: boolean) => setAgentChatLensEnabled(CODEX_CHAT_LENS_KEY, on);

// Chat composer draft — mirrored on every change (send/fill clear the box, which removes the key),
// so whatever was typed when the app was killed comes back on the next open.
export const getChatDraft = () => localStorage.getItem(CHAT_DRAFT_KEY) || '';
export const setChatDraft = (v: string): void => {
  if (v) localStorage.setItem(CHAT_DRAFT_KEY, v);
  else localStorage.removeItem(CHAT_DRAFT_KEY);
};

// Favorite commands — a global, user-curated list (no session scoping), stored as a plain array
// like the bound-session names.
export function getFavorites(): string[] {
  try { return stringList(parseStoredJson(FAVS_KEY)); }
  catch { return []; }
}
export function addFavorite(cmd: string): string[] {
  const c = cmd.trim();
  const list = getFavorites();
  if (c && !list.includes(c)) list.push(c);
  localStorage.setItem(FAVS_KEY, JSON.stringify(list));
  return list;
}
export function removeFavorite(cmd: string): string[] {
  const list = getFavorites().filter((c) => c !== cmd);
  localStorage.setItem(FAVS_KEY, JSON.stringify(list));
  return list;
}

// Last startup command picked when creating a new window/session, so it defaults to your usual next
// time (e.g. "claude"). '' = plain shell. Stored globally; not session-scoped.
export const getLastStartupCmd = () => localStorage.getItem(STARTUP_CMD_KEY) || '';
export const setLastStartupCmd = (cmd: string) => localStorage.setItem(STARTUP_CMD_KEY, cmd || '');

// Orphan-takeover: whether to SIGTERM the original process after resuming it in tmux. Defaults ON
// (a resumed session shares the same jsonl with no lock — two writers corrupt history), remembered
// per device. Only an explicit '0' turns it off.
const ORPHAN_KILL_KEY = 'tw_orphan_kill';
export const getOrphanKill = () => localStorage.getItem(ORPHAN_KILL_KEY) !== '0';
export const setOrphanKill = (on: boolean) => localStorage.setItem(ORPHAN_KILL_KEY, on ? '1' : '0');

// Terminal doc-path highlight (the soft blue wash behind tappable file paths). OFF by default — the
// paths stay tappable either way; this is purely the visual cue. Only an explicit '1' turns it on.
const DOC_HIGHLIGHT_KEY = 'tw_doc_highlight';
export const getDocHighlight = () => localStorage.getItem(DOC_HIGHLIGHT_KEY) === '1';
export const setDocHighlight = (on: boolean) => localStorage.setItem(DOC_HIGHLIGHT_KEY, on ? '1' : '0');

// Recent (sent) commands scoped per session NAME + WINDOW — the composer history is window-level, so each
// tmux window keeps its own send log. Stored nested { [session]: { [window]: [...] } } like ideas, via the
// shared nestedMapStore (which owns the legacy-flat-array coercion + husk-dropping). pushRecent dedupes to
// the front and caps the list.
export const getRecent = (session: string, windowName: string): string[] => recentStore.get(session, windowName);
const setRecent = (session: string, windowName: string, list: readonly string[]): string[] => (
  recentStore.set(session, windowName, list)
);
export function pushRecent(session: string, windowName: string, cmd: string): string[] {
  const c = (cmd || '').trim();
  const cur = getRecent(session, windowName);
  if (!c || !session || !windowName) return cur; // a bare Enter / blank send isn't worth recording
  return setRecent(session, windowName, [c, ...cur.filter((x) => x !== c)].slice(0, RECENT_CAP));
}
export function removeRecent(session: string, windowName: string, cmd: string): string[] {
  if (!session || !windowName) return getRecent(session, windowName);
  return setRecent(session, windowName, getRecent(session, windowName).filter((x) => x !== cmd));
}

const RECENT_DOCS_KEY = 'tw_recent_docs'; // [{ path, name, type, ts }] — recently opened docs, global
const PANE_BASE_KEY = 'tw_pane_base';     // { [paneId]: baseDir } — default base for relative paths
const RECENT_DOCS_CAP = 30;

export function getRecentDocs(): RecentDoc[] {
  try {
    const value = parseStoredJson(RECENT_DOCS_KEY);
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate): RecentDoc[] => {
      if (!isPlainObject(candidate)
        || typeof candidate.path !== 'string'
        || typeof candidate.name !== 'string'
        || typeof candidate.type !== 'string'
        || typeof candidate.ts !== 'number'
        || !Number.isFinite(candidate.ts)) return [];
      return [{ path: candidate.path, name: candidate.name, type: candidate.type, ts: candidate.ts }];
    });
  }
  catch { return []; }
}
// Dedupe by path, newest first, capped — same shape as the command recents.
export function pushRecentDoc({ path, name, type, ts = Date.now() }: Omit<RecentDoc, 'ts'> & { ts?: number }): RecentDoc[] {
  const next = [{ path, name, type, ts }, ...getRecentDocs().filter((d) => d.path !== path)].slice(0, RECENT_DOCS_CAP);
  localStorage.setItem(RECENT_DOCS_KEY, JSON.stringify(next));
  return next;
}
export function removeRecentDoc(path: string): RecentDoc[] {
  const next = getRecentDocs().filter((d) => d.path !== path);
  localStorage.setItem(RECENT_DOCS_KEY, JSON.stringify(next));
  return next;
}

export const getPaneBase = (paneId: string): string | null => {
  const value = readMap(PANE_BASE_KEY)[paneId];
  return typeof value === 'string' ? value : null;
};
export const setPaneBase = (paneId: string, dir: string): void => writeMapEntry(PANE_BASE_KEY, paneId, dir);

// Markdown reading font size, shared across docs, as a discrete 9-level ladder (px). Index 4 (14px)
// is the medium default; A−/A+ in DocView step the level — 4 notches smaller, 4 larger. Fine steps
// on the small side, bolder jumps on the large side. The chosen level is persisted.
export const DOC_FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20, 22];
export const DOC_FONT_DEFAULT_INDEX = 4; // 14px
const DOC_FONT_KEY = 'tw_doc_font';
export function getDocFontIndex() {
  const raw = localStorage.getItem(DOC_FONT_KEY); // null when unset — Number(null) is 0, so guard it
  const v = Number(raw);
  return raw !== null && Number.isInteger(v) && v >= 0 && v < DOC_FONT_SIZES.length ? v : DOC_FONT_DEFAULT_INDEX;
}
export const setDocFontIndex = (i: number) =>
  localStorage.setItem(DOC_FONT_KEY, String(Math.min(DOC_FONT_SIZES.length - 1, Math.max(0, i))));

// Git diff font — same ladder as docs, its own persisted level. Default 12px (index 2) matches the
// original fixed .git-diff size, so the view is unchanged until the user steps A−/A+.
export const DIFF_FONT_DEFAULT_INDEX = 2; // 12px
const DIFF_FONT_KEY = 'tw_diff_font';
export function getDiffFontIndex() {
  const raw = localStorage.getItem(DIFF_FONT_KEY);
  const v = Number(raw);
  return raw !== null && Number.isInteger(v) && v >= 0 && v < DOC_FONT_SIZES.length ? v : DIFF_FONT_DEFAULT_INDEX;
}
export const setDiffFontIndex = (i: number) =>
  localStorage.setItem(DIFF_FONT_KEY, String(Math.min(DOC_FONT_SIZES.length - 1, Math.max(0, i))));

// Per-window idea list (a lightweight todo), keyed by session NAME + window NAME so it survives a
// tmux restart (ids churn, names don't). Shape: { [session]: { [window]: Idea[] } }, Idea = {id,text}.
export const getIdeas = (session: string, windowName: string): Idea[] => ideasStore.get(session, windowName);
// Overwrite the whole list for one window — add/edit/delete/reorder all funnel through here. An
// empty list drops the window key (and an emptied session key) so storage doesn't accrete husks.
export function setIdeas(session: string, windowName: string, list: readonly Idea[]): Idea[] {
  if (!session || !windowName) return [];
  return ideasStore.set(session, windowName, list);
}
// Changelog read-state: the id of the latest entry the user has opened. The "new features" entry
// shows an unread dot while the newest changelog id differs from this.
export const getChangelogSeen = () => localStorage.getItem(CHANGELOG_SEEN_KEY);
export const setChangelogSeen = (v: string): void => { if (v) localStorage.setItem(CHANGELOG_SEEN_KEY, v); };

// The npm "latest" version the user has already acknowledged (opening Settings once). The gear's update dot
// stays off for this version even if they never upgrade — it only relights when npm publishes a newer one.
export const getVersionSeen = () => localStorage.getItem(VERSION_SEEN_KEY);
export const setVersionSeen = (v: string): void => { if (v) localStorage.setItem(VERSION_SEEN_KEY, v); };

// Window rename: tmux keeps the window id but the name (our key) changes, so move the ideas across.
export function renameWindowIdeas(session: string, oldWindow: string, newWindow: string): void {
  ideasStore.renameWindow(session, oldWindow, newWindow);
}

// 绑定的 git 仓库(绝对路径数组),顺序即 tab 顺序。按 window 隔离:每个 window 各有一套
// 仓库 tab(像「适配宽度」「目录浏览」一样以 windowId 为键),互不串味。
export function getGitRepos(windowId: string | null | undefined): string[] {
  if (!windowId) return [];
  const v = readMap(GIT_REPOS_KEY)[windowId];
  return stringList(v);
}
export function addGitRepos(windowId: string | null | undefined, paths: readonly string[]): string[] {
  if (!windowId) return [];
  const next = [...getGitRepos(windowId)];
  for (const p of paths) if (p && !next.includes(p)) next.push(p);
  writeMapEntry(GIT_REPOS_KEY, windowId, next);
  return next;
}
export function removeGitRepo(windowId: string | null | undefined, path: string): string[] {
  if (!windowId) return [];
  const next = getGitRepos(windowId).filter((p) => p !== path);
  writeMapEntry(GIT_REPOS_KEY, windowId, next);
  return next;
}
export function getGitDirs(windowId: string | null | undefined): string[] {
  if (!windowId) return [];
  const v = readMap(GIT_DIRS_KEY)[windowId];
  return stringList(v);
}
export function addGitDir(windowId: string | null | undefined, dir: string): string[] {
  if (!windowId || !dir) return [];
  const next = [dir, ...getGitDirs(windowId).filter(d => d !== dir)].slice(0, 10);
  writeMapEntry(GIT_DIRS_KEY, windowId, next);
  return next;
}
