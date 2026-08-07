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
const RUNTIME_ID_PATTERNS = {
  sessions: /^\$\d+$/,
  windows: /^@\d+$/,
  panes: /^%\d+$/,
};
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
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
export const setBrowserAccessEnabled = (enabled) => {
  if (enabled) localStorage.setItem(BROWSER_ACCESS_KEY, '1');
  else localStorage.removeItem(BROWSER_ACCESS_KEY);
};

// Bound sessions live only in the browser — the server never knows which sessions a given
// device has pinned. We store names (not ids): a tmux name is stable and user-chosen, while
// the id ($0) churns across tmux restarts.
export function getBoundSessions() {
  try {
    const value = JSON.parse(localStorage.getItem(BOUND_KEY));
    return Array.isArray(value) ? value.filter((name) => typeof name === 'string') : [];
  }
  catch { return []; }
}
export function addBoundSession(name) {
  const list = getBoundSessions();
  if (!list.includes(name)) list.push(name);
  localStorage.setItem(BOUND_KEY, JSON.stringify(list));
  return list;
}
export function removeBoundSession(name) {
  const list = getBoundSessions().filter((n) => n !== name);
  localStorage.setItem(BOUND_KEY, JSON.stringify(list));
  return list;
}

export function removeRestoredSessionBindings(results) {
  const restoredNames = new Set((Array.isArray(results) ? results : [])
    .filter((row) => row?.status === 'restored' && typeof row.targetName === 'string' && row.targetName)
    .map((row) => row.targetName));
  const list = getBoundSessions().filter((name) => !restoredNames.has(name));
  localStorage.setItem(BOUND_KEY, JSON.stringify(list));
  return list;
}

// Rename a bound session in place: swap the name in tw_bound (keeping its list position) and carry
// its recent-command history (tw_recent is keyed by NAME) to the new name. tw_win is keyed by
// session id, which rename-session does NOT change, so it needs no migration.
export function renameBoundSession(oldName, newName) {
  const list = getBoundSessions().map((n) => (n === oldName ? newName : n));
  localStorage.setItem(BOUND_KEY, JSON.stringify(list));
  // Recent-command history and ideas are both keyed by session NAME — carry each whole sub-tree across.
  recentStore.renameSession(oldName, newName);
  ideasStore.renameSession(oldName, newName);
  return list;
}

function readMap(key) {
  // Must return a PLAIN OBJECT. A legacy value that parses to an array (e.g. tw_git_repos was once a
  // global flat array, before per-window keying) would otherwise be returned as-is — then writeMapEntry
  // sets arr[windowId]=… as a non-index property, which JSON.stringify silently DROPS, so every write
  // vanishes. Coerce anything that isn't a plain object back to {}.
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function writeMapEntry(key, k, v) {
  const m = readMap(key);
  m[k] = v;
  localStorage.setItem(key, JSON.stringify(m));
}

function writeWorkspacePrompt(checkpointId, patch) {
  if (!checkpointId) return {};
  const all = readMap(WORKSPACE_PROMPT_KEY);
  const current = all[checkpointId];
  all[checkpointId] = {
    ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
    ...patch,
  };
  localStorage.setItem(WORKSPACE_PROMPT_KEY, JSON.stringify(all));
  return all[checkpointId];
}

export const getWorkspacePromptState = (checkpointId) => {
  if (!checkpointId) return {};
  const value = readMap(WORKSPACE_PROMPT_KEY)[checkpointId];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
export const markWorkspaceAutoShown = (checkpointId) =>
  writeWorkspacePrompt(checkpointId, { autoShown: true });
export const ignoreWorkspaceCheckpoint = (checkpointId) =>
  writeWorkspacePrompt(checkpointId, { ignored: true, autoShown: true });

function getAppliedWorkspaceMappings() {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_APPLIED_MAPPINGS_KEY));
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
  } catch { return []; }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateWorkspaceMapping(mapping) {
  try {
    if (!isPlainObject(mapping) || typeof mapping.id !== 'string' || !SAFE_MAPPING_ID.test(mapping.id)) return null;
    if (mapping.runtime !== undefined && !isPlainObject(mapping.runtime)) return null;
    if (mapping.names !== undefined && !isPlainObject(mapping.names)) return null;

    const rawRuntime = mapping.runtime || {};
    if (Object.keys(rawRuntime).some((kind) => !hasOwn(RUNTIME_ID_PATTERNS, kind))) return null;
    const runtime = { sessions: {}, windows: {}, panes: {} };
    for (const [kind, pattern] of Object.entries(RUNTIME_ID_PATTERNS)) {
      const rawKind = rawRuntime[kind];
      if (rawKind === undefined) continue;
      if (!isPlainObject(rawKind)) return null;
      for (const [source, actual] of Object.entries(rawKind)) {
        if (!pattern.test(source) || typeof actual !== 'string' || !pattern.test(actual)) return null;
        runtime[kind][source] = actual;
      }
    }

    const names = {};
    for (const [source, actual] of Object.entries(mapping.names || {})) {
      if (!source || typeof actual !== 'string' || !actual) return null;
      names[source] = actual;
    }
    const hasEntries = Object.keys(names).length > 0
      || Object.values(runtime).some((kind) => Object.keys(kind).length > 0);
    return hasEntries ? { id: mapping.id, runtime, names } : null;
  } catch { return null; }
}

function readStoredPlainMap(key) {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    return isPlainObject(value) ? { raw, value } : null;
  } catch { return null; }
}

function remapMapKey(key, keyMapping, valueMapping = {}) {
  const stored = readStoredPlainMap(key);
  if (!stored) return;
  const current = stored.value;
  const matched = Object.keys(keyMapping).filter((oldKey) => hasOwn(current, oldKey));
  if (matched.length === 0) return;
  const next = {};
  for (const [oldKey, oldValue] of Object.entries(current)) {
    if (hasOwn(keyMapping, oldKey)) continue;
    next[oldKey] = oldValue;
  }
  for (const oldKey of matched) {
    const actualKey = keyMapping[oldKey];
    const oldValue = current[oldKey];
    next[actualKey] = typeof oldValue === 'string' && hasOwn(valueMapping, oldValue)
      ? valueMapping[oldValue]
      : oldValue;
  }
  const serialized = JSON.stringify(next);
  if (serialized !== stored.raw) localStorage.setItem(key, serialized);
}

function remapKnownWorkspaceKeys(runtime) {
  const { sessions, windows, panes } = runtime;

  if (Object.keys(sessions).length > 0) {
    const lastSession = localStorage.getItem(LAST_SESSION_KEY);
    if (lastSession && hasOwn(sessions, lastSession)) {
      localStorage.setItem(LAST_SESSION_KEY, sessions[lastSession]);
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

export function applyWorkspaceRestoreMapping(mapping) {
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
function nestedMapStore(key) {
  const wins = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return {
    get(session, window) {
      if (!session || !window) return [];
      return wins(readMap(key)[session])[window] ?? [];
    },
    set(session, window, list) {
      const all = readMap(key);
      const w = wins(all[session]);
      if (list && list.length) w[window] = list;
      else delete w[window];
      if (Object.keys(w).length) all[session] = w;
      else delete all[session];
      localStorage.setItem(key, JSON.stringify(all));
      return list ?? [];
    },
    renameWindow(session, oldWindow, newWindow) {
      if (!session || !oldWindow || !newWindow || oldWindow === newWindow) return;
      const all = readMap(key);
      const w = wins(all[session]);
      if (w[oldWindow] == null) return;
      w[newWindow] = w[oldWindow];
      delete w[oldWindow];
      all[session] = w;
      localStorage.setItem(key, JSON.stringify(all));
    },
    renameSession(oldSession, newSession) {
      const all = readMap(key);
      if (all[oldSession] == null) return;
      all[newSession] = all[oldSession];
      delete all[oldSession];
      localStorage.setItem(key, JSON.stringify(all));
    },
  };
}
const recentStore = nestedMapStore(RECENT_KEY);
const ideasStore = nestedMapStore(IDEAS_KEY);

// Inbox read-state: the ts of the last event the user viewed per pane. A pane's idle/permission
// counts as unread only while its event ts exceeds this. Viewing a pane bumps it (see App).
export const getInboxSeen = () => readMap(INBOX_SEEN_KEY);
export function markInboxSeen(pane, ts) {
  writeMapEntry(INBOX_SEEN_KEY, pane, ts);
  return readMap(INBOX_SEEN_KEY);
}

// High-water mark (a server-side ts) below which "done" rows count as history, not new. null = unset
// (first run); App seeds it to the current max ts so the cold-start backlog never floods in.
export const getInboxReadTs = () => { const v = localStorage.getItem(INBOX_READ_TS_KEY); return v == null ? null : Number(v); };
export const setInboxReadTs = (ts) => localStorage.setItem(INBOX_READ_TS_KEY, String(ts));

// Inbox "new stuff" high-water: the newest notification ts the user has SEEN by opening the inbox page.
// Drives the top red dot (gear + 通知记录 row) — once you've opened the page, the dot clears even if
// individual messages inside are still unread; a newer notification relights it. Separate from the
// per-message read-id set below (which drives the in-page unread count / per-row blue dot).
const NOTIF_SEEN_TS_KEY = 'tw_notif_seen_ts';
export const getNotifSeenTs = () => { const v = localStorage.getItem(NOTIF_SEEN_TS_KEY); return v == null ? 0 : Number(v); };
export const setNotifSeenTs = (ts) => localStorage.setItem(NOTIF_SEEN_TS_KEY, String(ts));

// Per-message inbox read-state: id-based set (in-page unread count / per-row marker).
const NOTIF_READ_IDS_KEY = 'tw_notif_read_ids'; // ids of manual-push notifications already opened (per-device)
export const getReadInboxIds = () => {
  try { const v = JSON.parse(localStorage.getItem(NOTIF_READ_IDS_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
};
export const addReadInboxId = (id) => {
  const cur = getReadInboxIds();
  if (!cur.includes(id)) localStorage.setItem(NOTIF_READ_IDS_KEY, JSON.stringify([...cur, id]));
};
export const pruneReadInboxIds = (currentIds) => {
  const keep = getReadInboxIds().filter((id) => currentIds.includes(id));
  localStorage.setItem(NOTIF_READ_IDS_KEY, JSON.stringify(keep));
  return keep;
};

// Last-browsed directory per window (file sheet). Keyed by window id so each window reopens where you
// left off; absent (a window's first open) → the caller falls back to the pane's cwd. Absolute path.
export const getBrowseDir = (windowId) => (windowId ? readMap(BROWSE_DIR_KEY)[windowId] ?? null : null);
export const setBrowseDir = (windowId, path) => { if (windowId && path) writeMapEntry(BROWSE_DIR_KEY, windowId, path); };

// Last static-preview dir per window — so the picker reopens on it next time (the user usually
// re-previews the same build dir). Falls back to the pane cwd when absent. Absolute path.
export const getPreviewDir = (windowId) => (windowId ? readMap(PREVIEW_DIR_KEY)[windowId] ?? null : null);
export const setPreviewDir = (windowId, path) => { if (windowId && path) writeMapEntry(PREVIEW_DIR_KEY, windowId, path); };

export const getLastSession = () => localStorage.getItem(LAST_SESSION_KEY);
export const getLastWindow = (sessionId) => readMap(WIN_BY_SESSION_KEY)[sessionId] ?? null;
export const getLastPane = (windowId) => readMap(PANE_BY_WINDOW_KEY)[windowId] ?? null;

// Persist wherever we just landed: the last session, that session's last window, and that
// window's last pane. Each piece is optional so callers can record just what changed (e.g. a
// pane switch passes only { windowId, paneId }).
export function remember({ sessionId, windowId, paneId } = {}) {
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
export const setFont = (n) => localStorage.setItem(FONT_KEY, String(n));
// Drop the manual size so the terminal returns to height auto-fit.
export const clearFont = () => localStorage.removeItem(FONT_KEY);

// 对话-lens colour tone — a user preference (default 暖夜/dusk). Applied as `data-chat-tone` on `.app`,
// consumed by the `--ct-*` token blocks in styles.css. All three tones are warm (see styles.css). Unknown/
// absent → the default tone.
export const CHAT_TONES = ['dusk', 'ink', 'light'];
export const getChatTone = () => {
  const v = localStorage.getItem(CHAT_TONE_KEY);
  return CHAT_TONES.includes(v) ? v : 'dusk';
};
export const setChatTone = (tone) => {
  if (CHAT_TONES.includes(tone)) localStorage.setItem(CHAT_TONE_KEY, tone);
};

// Claude and Codex have independent chat-view opt-ins. Existing installs inherit the old shared value until
// each new switch is changed; explicit '0' is retained so turning one agent off never falls back to legacy '1'.
const getAgentChatLensEnabled = (key) => {
  const value = localStorage.getItem(key);
  return value == null ? localStorage.getItem(CHAT_LENS_KEY) === '1' : value === '1';
};
const setAgentChatLensEnabled = (key, on) => localStorage.setItem(key, on ? '1' : '0');
export const getClaudeChatLensEnabled = () => getAgentChatLensEnabled(CLAUDE_CHAT_LENS_KEY);
export const setClaudeChatLensEnabled = (on) => setAgentChatLensEnabled(CLAUDE_CHAT_LENS_KEY, on);
export const getCodexChatLensEnabled = () => getAgentChatLensEnabled(CODEX_CHAT_LENS_KEY);
export const setCodexChatLensEnabled = (on) => setAgentChatLensEnabled(CODEX_CHAT_LENS_KEY, on);

// Chat composer draft — mirrored on every change (send/fill clear the box, which removes the key),
// so whatever was typed when the app was killed comes back on the next open.
export const getChatDraft = () => localStorage.getItem(CHAT_DRAFT_KEY) || '';
export const setChatDraft = (v) => {
  if (v) localStorage.setItem(CHAT_DRAFT_KEY, v);
  else localStorage.removeItem(CHAT_DRAFT_KEY);
};

// Favorite commands — a global, user-curated list (no session scoping), stored as a plain array
// like the bound-session names.
export function getFavorites() {
  try { return JSON.parse(localStorage.getItem(FAVS_KEY)) || []; }
  catch { return []; }
}
export function addFavorite(cmd) {
  const c = cmd.trim();
  const list = getFavorites();
  if (c && !list.includes(c)) list.push(c);
  localStorage.setItem(FAVS_KEY, JSON.stringify(list));
  return list;
}
export function removeFavorite(cmd) {
  const list = getFavorites().filter((c) => c !== cmd);
  localStorage.setItem(FAVS_KEY, JSON.stringify(list));
  return list;
}

// Last startup command picked when creating a new window/session, so it defaults to your usual next
// time (e.g. "claude"). '' = plain shell. Stored globally; not session-scoped.
export const getLastStartupCmd = () => localStorage.getItem(STARTUP_CMD_KEY) || '';
export const setLastStartupCmd = (cmd) => localStorage.setItem(STARTUP_CMD_KEY, cmd || '');

// Orphan-takeover: whether to SIGTERM the original process after resuming it in tmux. Defaults ON
// (a resumed session shares the same jsonl with no lock — two writers corrupt history), remembered
// per device. Only an explicit '0' turns it off.
const ORPHAN_KILL_KEY = 'tw_orphan_kill';
export const getOrphanKill = () => localStorage.getItem(ORPHAN_KILL_KEY) !== '0';
export const setOrphanKill = (on) => localStorage.setItem(ORPHAN_KILL_KEY, on ? '1' : '0');

// Terminal doc-path highlight (the soft blue wash behind tappable file paths). OFF by default — the
// paths stay tappable either way; this is purely the visual cue. Only an explicit '1' turns it on.
const DOC_HIGHLIGHT_KEY = 'tw_doc_highlight';
export const getDocHighlight = () => localStorage.getItem(DOC_HIGHLIGHT_KEY) === '1';
export const setDocHighlight = (on) => localStorage.setItem(DOC_HIGHLIGHT_KEY, on ? '1' : '0');

// Recent (sent) commands scoped per session NAME + WINDOW — the composer history is window-level, so each
// tmux window keeps its own send log. Stored nested { [session]: { [window]: [...] } } like ideas, via the
// shared nestedMapStore (which owns the legacy-flat-array coercion + husk-dropping). pushRecent dedupes to
// the front and caps the list.
export const getRecent = (session, window) => recentStore.get(session, window);
const setRecent = (session, window, list) => recentStore.set(session, window, list);
export function pushRecent(session, window, cmd) {
  const c = (cmd || '').trim();
  const cur = getRecent(session, window);
  if (!c || !session || !window) return cur; // a bare Enter / blank send isn't worth recording
  return setRecent(session, window, [c, ...cur.filter((x) => x !== c)].slice(0, RECENT_CAP));
}
export function removeRecent(session, window, cmd) {
  if (!session || !window) return getRecent(session, window);
  return setRecent(session, window, getRecent(session, window).filter((x) => x !== cmd));
}

const RECENT_DOCS_KEY = 'tw_recent_docs'; // [{ path, name, type, ts }] — recently opened docs, global
const PANE_BASE_KEY = 'tw_pane_base';     // { [paneId]: baseDir } — default base for relative paths
const RECENT_DOCS_CAP = 30;

export function getRecentDocs() {
  try { return JSON.parse(localStorage.getItem(RECENT_DOCS_KEY)) || []; }
  catch { return []; }
}
// Dedupe by path, newest first, capped — same shape as the command recents.
export function pushRecentDoc({ path, name, type, ts = Date.now() }) {
  const next = [{ path, name, type, ts }, ...getRecentDocs().filter((d) => d.path !== path)].slice(0, RECENT_DOCS_CAP);
  localStorage.setItem(RECENT_DOCS_KEY, JSON.stringify(next));
  return next;
}
export function removeRecentDoc(path) {
  const next = getRecentDocs().filter((d) => d.path !== path);
  localStorage.setItem(RECENT_DOCS_KEY, JSON.stringify(next));
  return next;
}

export const getPaneBase = (paneId) => readMap(PANE_BASE_KEY)[paneId] ?? null;
export const setPaneBase = (paneId, dir) => writeMapEntry(PANE_BASE_KEY, paneId, dir);

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
export const setDocFontIndex = (i) =>
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
export const setDiffFontIndex = (i) =>
  localStorage.setItem(DIFF_FONT_KEY, String(Math.min(DOC_FONT_SIZES.length - 1, Math.max(0, i))));

// Per-window idea list (a lightweight todo), keyed by session NAME + window NAME so it survives a
// tmux restart (ids churn, names don't). Shape: { [session]: { [window]: Idea[] } }, Idea = {id,text}.
export const getIdeas = (session, window) => ideasStore.get(session, window);
// Overwrite the whole list for one window — add/edit/delete/reorder all funnel through here. An
// empty list drops the window key (and an emptied session key) so storage doesn't accrete husks.
export function setIdeas(session, window, list) {
  if (!session || !window) return [];
  return ideasStore.set(session, window, list);
}
// Changelog read-state: the id of the latest entry the user has opened. The "new features" entry
// shows an unread dot while the newest changelog id differs from this.
export const getChangelogSeen = () => localStorage.getItem(CHANGELOG_SEEN_KEY);
export const setChangelogSeen = (v) => { if (v) localStorage.setItem(CHANGELOG_SEEN_KEY, v); };

// The npm "latest" version the user has already acknowledged (opening Settings once). The gear's update dot
// stays off for this version even if they never upgrade — it only relights when npm publishes a newer one.
export const getVersionSeen = () => localStorage.getItem(VERSION_SEEN_KEY);
export const setVersionSeen = (v) => { if (v) localStorage.setItem(VERSION_SEEN_KEY, v); };

// Window rename: tmux keeps the window id but the name (our key) changes, so move the ideas across.
export function renameWindowIdeas(session, oldWindow, newWindow) {
  ideasStore.renameWindow(session, oldWindow, newWindow);
}

// 绑定的 git 仓库(绝对路径数组),顺序即 tab 顺序。按 window 隔离:每个 window 各有一套
// 仓库 tab(像「适配宽度」「目录浏览」一样以 windowId 为键),互不串味。
export function getGitRepos(windowId) {
  if (!windowId) return [];
  const v = readMap(GIT_REPOS_KEY)[windowId];
  return Array.isArray(v) ? v : [];
}
export function addGitRepos(windowId, paths) {
  if (!windowId) return [];
  const next = [...getGitRepos(windowId)];
  for (const p of paths) if (p && !next.includes(p)) next.push(p);
  writeMapEntry(GIT_REPOS_KEY, windowId, next);
  return next;
}
export function removeGitRepo(windowId, path) {
  if (!windowId) return [];
  const next = getGitRepos(windowId).filter((p) => p !== path);
  writeMapEntry(GIT_REPOS_KEY, windowId, next);
  return next;
}
export function getGitDirs(windowId) {
  if (!windowId) return [];
  const v = readMap(GIT_DIRS_KEY)[windowId];
  return Array.isArray(v) ? v : [];
}
export function addGitDir(windowId, dir) {
  if (!windowId || !dir) return [];
  const next = [dir, ...getGitDirs(windowId).filter(d => d !== dir)].slice(0, 10);
  writeMapEntry(GIT_DIRS_KEY, windowId, next);
  return next;
}
