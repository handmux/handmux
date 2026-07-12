const TOKEN_KEY = 'tw_token';
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
const IDEAS_KEY = 'tw_ideas';               // { [sessionName]: { [windowName]: Idea[] } } — per-window todo list
const CHANGELOG_SEEN_KEY = 'tw_changelog_seen'; // the latest changelog entry id (v) the user has opened
const VERSION_SEEN_KEY = 'tw_version_seen';     // the npm "latest" version already acknowledged in Settings
const GIT_REPOS_KEY = 'tw_git_repos';          // { [windowId]: absPath[] } —
const GIT_DIRS_KEY = 'tw_git_dirs';            // { [windowId]: absPath[] } — dirs the user picked repos from (history, newest first) bound git repos per window absolute paths (order = tab order)

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

// Bound sessions live only in the browser — the server never knows which sessions a given
// device has pinned. We store names (not ids): a tmux name is stable and user-chosen, while
// the id ($0) churns across tmux restarts.
export function getBoundSessions() {
  try { return JSON.parse(localStorage.getItem(BOUND_KEY)) || []; }
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

// Rename a bound session in place: swap the name in tw_bound (keeping its list position) and carry
// its recent-command history (tw_recent is keyed by NAME) to the new name. tw_win is keyed by
// session id, which rename-session does NOT change, so it needs no migration.
export function renameBoundSession(oldName, newName) {
  const list = getBoundSessions().map((n) => (n === oldName ? newName : n));
  localStorage.setItem(BOUND_KEY, JSON.stringify(list));
  const recents = readMap(RECENT_KEY);
  if (recents[oldName] != null) {
    recents[newName] = recents[oldName];
    delete recents[oldName];
    localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
  }
  // Ideas are keyed by session name too — carry the whole window→ideas sub-tree to the new name.
  const ideas = readMap(IDEAS_KEY);
  if (ideas[oldName] != null) {
    ideas[newName] = ideas[oldName];
    delete ideas[oldName];
    localStorage.setItem(IDEAS_KEY, JSON.stringify(ideas));
  }
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

// Recent (sent) commands scoped per session NAME + WINDOW — the composer history is window-level, so each
// tmux window keeps its own send log. Stored nested { [session]: { [window]: [...] } } like ideas.
// pushRecent dedupes to the front and caps the list.
const winMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
export function getRecent(session, window) {
  if (!session || !window) return [];
  return winMap(readMap(RECENT_KEY)[session])[window] ?? [];
}
// Overwrite one window's list (add/delete funnel through here); an empty list drops the window key (and
// an emptied session key) so storage doesn't accrete husks — same shape as setIdeas.
// NOTE: coerce all[session] through winMap. Recent used to be flat ({ [session]: string[] }) before it
// became window-scoped, so an upgraded user can have a legacy ARRAY under a session key. Writing
// arr[windowId]=… would set a non-index property that JSON.stringify SILENTLY DROPS — so every send
// vanished on reload (visible in memory, gone after restart). Treat a non-object session value as empty.
function setRecent(session, window, list) {
  const all = readMap(RECENT_KEY);
  const wins = winMap(all[session]);
  if (list && list.length) wins[window] = list;
  else delete wins[window];
  if (Object.keys(wins).length) all[session] = wins;
  else delete all[session];
  localStorage.setItem(RECENT_KEY, JSON.stringify(all));
  return list ?? [];
}
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
export function getIdeas(session, window) {
  if (!session || !window) return [];
  return readMap(IDEAS_KEY)[session]?.[window] ?? [];
}
// Overwrite the whole list for one window — add/edit/delete/reorder all funnel through here. An
// empty list drops the window key (and an emptied session key) so storage doesn't accrete husks.
export function setIdeas(session, window, list) {
  if (!session || !window) return [];
  const all = readMap(IDEAS_KEY);
  const wins = all[session] || {};
  if (list && list.length) wins[window] = list;
  else delete wins[window];
  if (Object.keys(wins).length) all[session] = wins;
  else delete all[session];
  localStorage.setItem(IDEAS_KEY, JSON.stringify(all));
  return list ?? [];
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
  if (!session || !oldWindow || !newWindow || oldWindow === newWindow) return;
  const all = readMap(IDEAS_KEY);
  const wins = all[session];
  if (!wins || wins[oldWindow] == null) return;
  wins[newWindow] = wins[oldWindow];
  delete wins[oldWindow];
  localStorage.setItem(IDEAS_KEY, JSON.stringify(all));
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
