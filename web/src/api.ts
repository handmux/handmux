import { getBrowserDeviceId, getToken } from './storage.js';
import { mimeFromName } from './mime.js';
import { t } from './i18n';
import { UnauthorizedError } from './apiErrors.js';
import { parseCodexToolProjection } from '../../server/src/codexToolProtocol.js';
import { requestJson as req } from './apiRequest.js';
import type {
  AsrSignResponse,
  JsonRequestOptions,
  TerminalHistoryResponse,
} from './apiRequest.js';
import {
  parseWorkspaceRecoveryPlan,
  parseWorkspaceRestoreOperation,
} from './workspaceRecovery.js';
import type { WorkspaceRecoveryPlan, WorkspaceRestoreOperation } from './workspaceRecovery.js';

export { ApiError, UnauthorizedError } from './apiErrors.js';
export {
  answerCodexApproval,
  answerCodexInput,
  beginCodexQueuedEdit,
  cancelCodexQueuedEdit,
  clearCodexGoal,
  clearCodexSession,
  commitCodexQueuedEdit,
  compactCodexSession,
  getCodexGoal,
  getCodexModels,
  getCodexSession,
  interruptCodexSession,
  parseSseFrames,
  removeCodexQueuedMessage,
  renewCodexQueuedEdit,
  sendCodexMessage,
  steerCodexQueuedMessage,
  streamCodexMessages,
  takeoverCodexSession,
  updateCodexGoal,
  updateCodexSettings,
} from './codexApi.js';

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface TmuxSession {
  id: string;
  name: string;
}

export interface TmuxWindow {
  id: string;
  name: string;
  panes: number;
  active?: boolean;
  width?: number;
  activePaneId?: string;
}

export interface TmuxPane {
  id: string;
  active?: boolean;
  command?: string | null;
  agent?: string | null;
  left?: number | null;
  top?: number | null;
  width?: number | null;
  height?: number | null;
}

const finiteOrUndefined = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

function parseSessions(value: unknown): TmuxSession[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): TmuxSession[] => {
    const session = recordOf(candidate);
    return typeof session?.id === 'string' && typeof session.name === 'string'
      ? [{ id: session.id, name: session.name }] : [];
  });
}

function parseWindows(value: unknown): TmuxWindow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): TmuxWindow[] => {
    const win = recordOf(candidate);
    if (!win || typeof win.id !== 'string') return [];
    return [{
      id: win.id,
      name: typeof win.name === 'string' ? win.name : win.id,
      panes: finiteOrUndefined(win.panes) ?? 0,
      ...(typeof win.active === 'boolean' ? { active: win.active } : {}),
      ...(finiteOrUndefined(win.width) !== undefined ? { width: finiteOrUndefined(win.width) } : {}),
      ...(typeof win.activePaneId === 'string' ? { activePaneId: win.activePaneId } : {}),
    }];
  });
}

function parsePanes(value: unknown): TmuxPane[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): TmuxPane[] => {
    const pane = recordOf(candidate);
    if (!pane || typeof pane.id !== 'string') return [];
    return [{
      id: pane.id,
      ...(typeof pane.active === 'boolean' ? { active: pane.active } : {}),
      ...(typeof pane.command === 'string' || pane.command === null ? { command: pane.command } : {}),
      ...(typeof pane.agent === 'string' || pane.agent === null ? { agent: pane.agent } : {}),
      ...(finiteOrUndefined(pane.left) !== undefined ? { left: finiteOrUndefined(pane.left) } : {}),
      ...(finiteOrUndefined(pane.top) !== undefined ? { top: finiteOrUndefined(pane.top) } : {}),
      ...(finiteOrUndefined(pane.width) !== undefined ? { width: finiteOrUndefined(pane.width) } : {}),
      ...(finiteOrUndefined(pane.height) !== undefined ? { height: finiteOrUndefined(pane.height) } : {}),
    }];
  });
}

export const getSessions = async (): Promise<TmuxSession[]> => parseSessions(await req('/api/sessions'));
export const getUsage = (): Promise<unknown> => req('/api/usage');
export const getWindows = async (session: string): Promise<TmuxWindow[]> => (
  parseWindows(await req(`/api/windows?session=${encodeURIComponent(session)}`))
);
export const getPanes = async (window: string): Promise<TmuxPane[]> => (
  parsePanes(await req(`/api/panes?window=${encodeURIComponent(window)}`, { timeoutMs: 8_000 }))
);
export const getHistory = (
  pane: string,
  lines = 1_500,
  since?: string | null,
): Promise<TerminalHistoryResponse> => (
  req<TerminalHistoryResponse>(
    `/api/history?pane=${encodeURIComponent(pane)}&lines=${lines}${since ? `&since=${since}` : ''}`,
    { timeoutMs: 8_000 },
  )
);
// The 对话 lens's transcript: same req()-based conditional-poll convention as getHistory (8s timeout),
// but translates the 204 { unchanged: true } into a plain null — a simpler "keep last" contract for
// useTranscript's polling consumer. Paginated (Task 10): the RECENT window is `{since, limit}` (hash-gated
// conditional poll), a HISTORY page is `{before, limit}` (page back from the current ordinal cursor `k`,
// no hash — always returns whatever's there). limit defaults to 10 so the client never asks for more than
// one page at a time (it never holds/requests the whole transcript).
export interface TranscriptRequestOptions {
  since?: string;
  before?: number;
  limit?: number;
  agent?: string;
}

export async function fetchTranscript(
  pane: string,
  { since, before, limit = 10, agent = 'claude' }: TranscriptRequestOptions = {},
): Promise<unknown | null> {
  let url = `/api/transcript?pane=${encodeURIComponent(pane)}&agent=${encodeURIComponent(agent)}&limit=${encodeURIComponent(limit)}`;
  if (since) url += `&since=${encodeURIComponent(since)}`;
  if (before != null) url += `&before=${encodeURIComponent(before)}`;
  const response = await req<unknown>(url, { timeoutMs: 8_000 });
  const page = recordOf(response);
  if (page?.unchanged === true) return null;
  if (!page || agent !== 'codex' || !Array.isArray(page.messages)) return response;
  const messages = page.messages.flatMap((candidate) => {
    const message = recordOf(candidate);
    if (!message || message.type !== 'tool') return [candidate];
    const tool = parseCodexToolProjection(message.tool);
    return tool ? [{ ...message, tool }] : [];
  });
  return { ...page, messages };
}
// The pane's current context-window state: { model, usedPercent } — either may be null when the statusLine
// capturer isn't opted in / the session hasn't rendered. Polled by the 对话 composer to show a small chip.
export const getPaneContext = (pane: string, agent = 'claude'): Promise<unknown> => (
  req(`/api/context?pane=${encodeURIComponent(pane)}&agent=${encodeURIComponent(agent)}`, {
    timeoutMs: 8_000,
  })
);
// The pending interactive prompt (AskUserQuestion / permission menu) scraped off the pane, or null when no
// gate is up. Polled by the 对话 lens only while a gate is up (kind==='permission').
export async function getPendingPrompt(pane: string, agent = 'claude'): Promise<unknown | null> {
  const response = await req<unknown>(
    `/api/pending-prompt?pane=${encodeURIComponent(pane)}&agent=${encodeURIComponent(agent)}`,
    { timeoutMs: 8_000 },
  );
  return recordOf(response)?.prompt || null;
}
export const sendText = (pane: string, text: string, enter = true): Promise<unknown> =>
  req('/api/send', { method: 'POST', body: JSON.stringify({ pane, text, enter }) });
export const sendKeys = (pane: string, keys: unknown): Promise<unknown> =>
  req('/api/keys', { method: 'POST', body: JSON.stringify({ pane, keys }) });
export const sendInput = (pane: string, hex: string): Promise<unknown> =>
  req('/api/input', { method: 'POST', body: JSON.stringify({ pane, hex }) });
// Forward a swipe over a full-screen (alt-screen) pane as `lines` wheel notches; the server injects the
// mouse-wheel events the app scrolls on (no-op reply when the app isn't mouse-reporting — see /scroll).
export const scrollPane = (pane: string, dir: string, lines = 1): Promise<unknown> =>
  req('/api/scroll', { method: 'POST', body: JSON.stringify({ pane, dir, lines }) });
export const resizeWindow = (window: string, cols: number, rows?: number): Promise<unknown> =>
  req('/api/resize', { method: 'POST', body: JSON.stringify({ window, cols, rows }) });
export const resizePane = (pane: string, cols: number): Promise<unknown> =>
  req('/api/resize', { method: 'POST', body: JSON.stringify({ pane, cols }) });
export const getWindowLayout = (window: string): Promise<unknown> =>
  req(`/api/layout?window=${encodeURIComponent(window)}`);
export const applyWindowLayout = (window: string, layout: unknown): Promise<unknown> =>
  req('/api/layout', { method: 'POST', body: JSON.stringify({ window, layout }) });
export const restoreWindowSize = (window: string, layout?: unknown): Promise<unknown> =>
  req('/api/resize', { method: 'POST', body: JSON.stringify({ window, auto: true, layout }) });
export const createSession = (name: string, cwd?: string, cmd?: string): Promise<unknown> =>
  req('/api/sessions', { method: 'POST', body: JSON.stringify({ name, cwd, cmd }) });
export interface TmuxLocationResult {
  id?: string;
  session?: string;
  name?: string;
  window?: string;
  pane?: string;
}

const parseTmuxLocation = (value: unknown): TmuxLocationResult => {
  const result = recordOf(value);
  return result ? {
    ...(typeof result.id === 'string' ? { id: result.id } : {}),
    ...(typeof result.session === 'string' ? { session: result.session } : {}),
    ...(typeof result.name === 'string' ? { name: result.name } : {}),
    ...(typeof result.window === 'string' ? { window: result.window } : {}),
    ...(typeof result.pane === 'string' ? { pane: result.pane } : {}),
  } : {};
};

export const createWindow = async (
  session: string,
  pane: string,
  name?: string,
  cwd?: string,
  cmd?: string,
): Promise<TmuxLocationResult> => parseTmuxLocation(await req(
  '/api/windows', { method: 'POST', body: JSON.stringify({ session, pane, name, cwd, cmd }) },
));
export const renameSession = (id: string, name: string): Promise<unknown> =>
  req('/api/sessions', { method: 'PATCH', body: JSON.stringify({ id, name }) });
export const renameWindow = (id: string, name: string): Promise<unknown> =>
  req('/api/windows', { method: 'PATCH', body: JSON.stringify({ id, name }) });
export const deleteWindow = (id: string): Promise<unknown> =>
  req(`/api/windows?window=${encodeURIComponent(id)}`, { method: 'DELETE' });
export const swapWindows = (a: string, b: string): Promise<unknown> =>
  req('/api/windows/swap', { method: 'POST', body: JSON.stringify({ a, b }) });
export const splitPane = (pane: string, dir: string): Promise<unknown> =>
  req('/api/panes/split', { method: 'POST', body: JSON.stringify({ pane, dir }) });
export const closePane = (pane: string): Promise<unknown> =>
  req(`/api/panes?pane=${encodeURIComponent(pane)}`, { method: 'DELETE' });
export const createDir = (dir: string, name: string): Promise<unknown> =>
  req('/api/dir', { method: 'POST', body: JSON.stringify({ dir, name }) });

// `sinceMtime` (ms) makes it a conditional GET: an unchanged file comes back as { notModified: true }
// (no content) so revisiting a doc doesn't refetch/re-render when nothing changed. Omit for a full read.
export type DocumentResponse = { notModified: true } | {
  type: string;
  name: string;
  content: unknown;
  mtimeMs?: number | null;
};
export const fetchDoc = async (path: string, sinceMtime: number | null = null): Promise<DocumentResponse> => {
  const value = recordOf(await req(
    `/api/file?path=${encodeURIComponent(path)}${sinceMtime != null ? `&mtime=${encodeURIComponent(sinceMtime)}` : ''}`,
    { timeoutMs: 8_000 },
  ));
  if (value?.notModified === true) return { notModified: true };
  if (!value || typeof value.type !== 'string' || typeof value.name !== 'string') {
    throw new Error('file response is invalid');
  }
  return {
    type: value.type,
    name: value.name,
    content: value.content,
    ...(value.mtimeMs === null ? { mtimeMs: null }
      : typeof value.mtimeMs === 'number' && Number.isFinite(value.mtimeMs) ? { mtimeMs: value.mtimeMs } : {}),
  };
};
export const fetchDir = (path?: string): Promise<unknown> =>
  req(`/api/dir${path ? `?path=${encodeURIComponent(path)}` : ''}`, { timeoutMs: 8_000 });
// A pane's current working directory (absolute) — used to land the file browser on the session's dir.
export const fetchPaneCwd = (pane: string): Promise<unknown> =>
  req(`/api/pane-cwd?pane=${encodeURIComponent(pane)}`, { timeoutMs: 8_000 });
// Mint a short-lived signed iFlytek IAT WebSocket URL (server holds the secret). The browser then
// connects to iFlytek directly. 8s timeout so a hung sign call doesn't freeze the mic press.
export async function signAsr(): Promise<AsrSignResponse> {
  const response = recordOf(await req('/api/asr/sign', { timeoutMs: 8_000 }));
  if (!response || typeof response.url !== 'string' || typeof response.appId !== 'string') {
    throw new Error('ASR sign returned an invalid response');
  }
  return { url: response.url, appId: response.appId };
}

// Which optional integrations this install has configured (e.g. { asr: true }). Drives the UI hiding
// controls that can't work — voice/ASR ships disabled on open-source installs without iFlytek keys.
export const getConfig = (): Promise<unknown> => req('/api/config', { timeoutMs: 8_000 });
// { current, latest, updateAvailable } — is the installed CLI behind the latest npm release? Checked once
// per app launch; when true the phone hints the user to run `handmux update` on their computer.
export interface ServerVersionInfo {
  current?: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
  whatsNew?: { version: string; zh?: string; en?: string }[];
}

export const getServerVersion = async (): Promise<ServerVersionInfo> => {
  const value = recordOf(await req('/api/version', { timeoutMs: 8_000 }));
  const whatsNew = Array.isArray(value?.whatsNew) ? value.whatsNew.flatMap((candidate) => {
    const release = recordOf(candidate);
    return typeof release?.version === 'string' ? [{
      version: release.version,
      ...(typeof release.zh === 'string' ? { zh: release.zh } : {}),
      ...(typeof release.en === 'string' ? { en: release.en } : {}),
    }] : [];
  }) : undefined;
  return value ? {
    ...(typeof value.current === 'string' || value.current === null ? { current: value.current } : {}),
    ...(typeof value.latest === 'string' || value.latest === null ? { latest: value.latest } : {}),
    ...(typeof value.updateAvailable === 'boolean' ? { updateAvailable: value.updateAvailable } : {}),
    ...(whatsNew ? { whatsNew } : {}),
  } : {};
};
export const getWorkspaceProtectionStatus = async (): Promise<{ status?: string; errorCode?: string | null }> => {
  const value = recordOf(await req('/api/workspace/status', { timeoutMs: 8_000 }));
  return value ? {
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    ...(typeof value.errorCode === 'string' || value.errorCode === null ? { errorCode: value.errorCode } : {}),
  } : {};
};
export const getWorkspaceRestorePlan = async (checkpointId = 'latest'): Promise<WorkspaceRecoveryPlan | null> => (
  parseWorkspaceRecoveryPlan(await req(
    `/api/workspace/restore-plan?checkpoint=${encodeURIComponent(checkpointId)}`,
    { timeoutMs: 8_000 },
  ))
);
export interface WorkspaceRestoreStart {
  operationId?: string;
  status?: string;
}
export const startWorkspaceRestore = async (
  body: Record<string, unknown> = { checkpointId: 'latest' },
): Promise<WorkspaceRestoreStart> => {
  const value = recordOf(await req(
    '/api/workspace/restore', { method: 'POST', body: JSON.stringify(body), timeoutMs: 8_000 },
  ));
  return value ? {
    ...(typeof value.operationId === 'string' ? { operationId: value.operationId } : {}),
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
  } : {};
};
export const getWorkspaceRestoreOperation = async (
  operationId: string,
): Promise<(WorkspaceRestoreOperation & { id?: string }) | null> => parseWorkspaceRestoreOperation(await req(
  `/api/workspace/restore/${encodeURIComponent(operationId)}`,
  { timeoutMs: 8_000 },
));
// Enable the Claude Code lifecycle hooks on the host (one-tap from the inbox). Token-gated like every API;
// 15s timeout covers the file copy + settings merge. Returns { ok, status }.
export const installClaudeHooks = (): Promise<unknown> => (
  req('/api/hooks/install', { method: 'POST', timeoutMs: 15_000 })
);
// Scope the inbox roster to the sessions this device has bound — the server returns only those panes.
export interface PaneStateResponse {
  kind?: string | null;
  session?: string | null;
  window?: string | null;
  windowName?: string | null;
  msg?: string | null;
  ts?: number | null;
  agent?: string | null;
}

export const getStates = async (sessions: string[] = []): Promise<Record<string, PaneStateResponse>> => {
  const response = recordOf(await req(
    `/api/states?sessions=${encodeURIComponent(sessions.join(','))}`,
    { timeoutMs: 4_000 },
  ));
  const result: Record<string, PaneStateResponse> = {};
  for (const [pane, candidate] of Object.entries(response || {})) {
    const state = recordOf(candidate);
    if (!state) continue;
    result[pane] = {
      ...(typeof state.kind === 'string' || state.kind === null ? { kind: state.kind } : {}),
      ...(typeof state.session === 'string' || state.session === null ? { session: state.session } : {}),
      ...(typeof state.window === 'string' || state.window === null ? { window: state.window } : {}),
      ...(typeof state.windowName === 'string' || state.windowName === null ? { windowName: state.windowName } : {}),
      ...(typeof state.msg === 'string' || state.msg === null ? { msg: state.msg } : {}),
      ...(typeof state.ts === 'number' && Number.isFinite(state.ts) ? { ts: state.ts } : {}),
      ...(typeof state.agent === 'string' || state.agent === null ? { agent: state.agent } : {}),
    };
  }
  return result;
};

const browserReq = (path: string, options: JsonRequestOptions = {}): Promise<unknown> => req(path, {
  timeoutMs: 15_000,
  ...options,
  headers: { ...(options.headers || {}), 'X-Handmux-Browser-Device': getBrowserDeviceId() ?? '' },
});
export const acquireBrowserProxyLease = (
  tabId: string,
  url: string,
  siteVersion = 'mobile',
): Promise<unknown> =>
  browserReq(`/api/browser-proxy/leases/${encodeURIComponent(tabId)}`, {
    method: 'PUT',
    body: JSON.stringify({ url, siteVersion }),
  });
export const navigateBrowserProxyLease = (
  tabId: string,
  url: string,
  siteVersion = 'mobile',
): Promise<unknown> =>
  browserReq(`/api/browser-proxy/leases/${encodeURIComponent(tabId)}/navigate`, {
    method: 'POST',
    body: JSON.stringify({ url, siteVersion }),
  });
export const deleteBrowserProxyLease = (tabId: string): Promise<unknown> =>
  browserReq(`/api/browser-proxy/leases/${encodeURIComponent(tabId)}`, { method: 'DELETE' });
export const getBrowserProxyStatus = (): Promise<unknown> => browserReq('/api/browser-proxy/status');
export const setBrowserProxyProfilePrefs = (prefs: unknown): Promise<unknown> =>
  browserReq('/api/browser-proxy/profile', { method: 'PUT', body: JSON.stringify(prefs) });
export const clearBrowserProxyProfile = (origin: string | null = null): Promise<unknown> =>
  browserReq('/api/browser-proxy/profile/clear', {
    method: 'POST',
    body: JSON.stringify({ origin }),
  });

// Orphan Claude sessions running outside tmux (see server/src/orphans.js). getOrphans returns the roster;
// takeoverOrphan spawns `claude --resume` in tmux and (default) SIGTERMs the original. Takeover involves a
// process scan + tmux spawn + up-poll, so it gets a longer timeout.
export interface OrphanProcess {
  pid: number;
  cwd: string;
  cwdLabel?: string;
  sessionId?: string | null;
  state?: string;
  snippet?: string;
  agentLabel?: string;
  suggestedName?: string;
  startedAt?: number | null;
  lastActivity?: number | null;
}

export const getOrphans = async (): Promise<OrphanProcess[]> => {
  const value = await req<unknown>('/api/orphans', { timeoutMs: 8_000 });
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): OrphanProcess[] => {
    const orphan = recordOf(candidate);
    if (!orphan || typeof orphan.pid !== 'number' || !Number.isFinite(orphan.pid)
      || typeof orphan.cwd !== 'string') return [];
    return [{
      pid: orphan.pid,
      cwd: orphan.cwd,
      ...(typeof orphan.cwdLabel === 'string' ? { cwdLabel: orphan.cwdLabel } : {}),
      ...(typeof orphan.sessionId === 'string' || orphan.sessionId === null ? { sessionId: orphan.sessionId } : {}),
      ...(typeof orphan.state === 'string' ? { state: orphan.state } : {}),
      ...(typeof orphan.snippet === 'string' ? { snippet: orphan.snippet } : {}),
      ...(typeof orphan.agentLabel === 'string' ? { agentLabel: orphan.agentLabel } : {}),
      ...(typeof orphan.suggestedName === 'string' ? { suggestedName: orphan.suggestedName } : {}),
      ...(finiteOrUndefined(orphan.startedAt) !== undefined ? { startedAt: finiteOrUndefined(orphan.startedAt) } : {}),
      ...(finiteOrUndefined(orphan.lastActivity) !== undefined ? { lastActivity: finiteOrUndefined(orphan.lastActivity) } : {}),
    }];
  });
};
export const takeoverOrphan = async (body: unknown): Promise<TmuxLocationResult> => parseTmuxLocation(await req(
  '/api/orphans/takeover', { method: 'POST', body: JSON.stringify(body), timeoutMs: 15_000 },
));

// --- git viewer (read-only) ---
export const gitRepos = (dir: string): Promise<unknown> => (
  req(`/api/git/repos?dir=${encodeURIComponent(dir)}`, { timeoutMs: 8_000 })
);
export const gitStatus = (repo: string): Promise<unknown> => (
  req(`/api/git/status?repo=${encodeURIComponent(repo)}`, { timeoutMs: 8_000 })
);
export interface GitLogOptions {
  limit?: number;
  ref?: string;
}
export const gitLog = (repo: string, { limit = 50, ref }: GitLogOptions = {}): Promise<unknown> => {
  let url = `/api/git/log?repo=${encodeURIComponent(repo)}&limit=${limit}`;
  if (ref) url += `&ref=${encodeURIComponent(ref)}`;
  return req(url, { timeoutMs: 8_000 });
};
export const gitBranches = (repo: string): Promise<unknown> => (
  req(`/api/git/branches?repo=${encodeURIComponent(repo)}`, { timeoutMs: 8_000 })
);
export interface GitDiffOptions {
  path?: string;
  commit?: string;
  staged?: boolean;
}
export const gitDiff = (
  repo: string,
  { path, commit, staged }: GitDiffOptions = {},
): Promise<unknown> => {
  let url = `/api/git/diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path ?? '')}`;
  if (commit) url += `&commit=${encodeURIComponent(commit)}`;
  if (staged) url += '&staged=1';
  return req(url, { timeoutMs: 8_000 });
};
export const gitCommit = (repo: string, hash: string): Promise<unknown> =>
  req(`/api/git/commit?repo=${encodeURIComponent(repo)}&hash=${encodeURIComponent(hash)}`, { timeoutMs: 8_000 });

// Download a file under $HOME. Can't use a plain <a href> (no Authorization header, and the token
// would leak into the URL / history / access log), so XHR with the Bearer header, then save the
// blob via a throwaway object-URL anchor. onProgress(fraction 0..1) fires as bytes arrive (XHR, not
// fetch, so we get progress events for free). 50MB cap is enforced server-side.
export type TransferProgress = (fraction: number) => void;

export function downloadFile(path: string, onProgress?: TransferProgress): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const token = getToken();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/api/download?path=${encodeURIComponent(path)}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token ?? ''}`);
    xhr.responseType = 'blob';
    xhr.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new Error('download failed'));
    xhr.onload = () => {
      if (xhr.status === 401) return reject(new UnauthorizedError());
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`download -> ${xhr.status}`));
      const name = path.split('/').pop() || 'download';
      // Re-tag the blob from its extension when the server's type is generic/empty, so the OS records
      // the right MIME and "Open" launches the gallery/viewer instead of showing raw bytes.
      let blob = xhr.response as Blob;
      const mime = mimeFromName(name);
      if (mime && blob && blob.type !== mime) blob = blob.slice(0, blob.size, mime);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // iOS Safari / Android Chrome 异步读取 blob URL：立刻 revoke 会下载到空文件。延迟到下载已开始
      // 再释放(blob 仅占内存,延迟无害)。
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      resolve();
    };
    xhr.send();
  });
}

// Fetch an image file under $HOME for INLINE viewing — reuses /api/download (which streams any file
// with the right Content-Type, 50MB cap) but keeps the bytes as a blob instead of saving. XHR with the
// Bearer header (an <img src> can't send Authorization, and we won't leak the token into a URL); the
// blob is re-tagged from the extension when the server's type is generic, then turned into an
// object-URL the caller assigns to <img> (and must revokeObjectURL when done).
//
// Resolves { url, mtimeMs } (mtimeMs from the X-Mtime header, for the next conditional check). Passing
// `sinceMtime` makes it a conditional GET: an unchanged image comes back 304 → resolves { notModified:
// true } with no new blob, so re-viewing an unchanged image neither re-downloads nor reloads the <img>.
export type ImageUrlResponse = { notModified: true } | {
  url: string;
  mtimeMs: number | null;
};

export function fetchImageUrl(
  path: string,
  sinceMtime: number | null = null,
): Promise<ImageUrlResponse> {
  return new Promise<ImageUrlResponse>((resolve, reject) => {
    const token = getToken();
    const xhr = new XMLHttpRequest();
    const q = sinceMtime != null ? `&mtime=${encodeURIComponent(sinceMtime)}` : '';
    xhr.open('GET', `/api/download?path=${encodeURIComponent(path)}${q}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token ?? ''}`);
    xhr.responseType = 'blob';
    xhr.onerror = () => reject(new Error(t('api.loadFailed')));
    xhr.onload = () => {
      if (xhr.status === 304) return resolve({ notModified: true });
      if (xhr.status === 401) return reject(new UnauthorizedError());
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`image -> ${xhr.status}`));
      let blob = xhr.response as Blob;
      const mime = mimeFromName(path.split('/').pop() || '');
      if (mime && blob && blob.type !== mime) blob = blob.slice(0, blob.size, mime);
      const m = Number(xhr.getResponseHeader('X-Mtime'));
      resolve({ url: URL.createObjectURL(blob), mtimeMs: Number.isFinite(m) ? m : null });
    };
    xhr.send();
  });
}

// Static preview URLs are issued by the server with an independent runtime capability. Never derive one
// from the main Handmux token on the device.
export const previewUrl = (entry: unknown): string | null => {
  const preview = recordOf(entry);
  return typeof preview?.url === 'string' ? preview.url : null;
};
export const createPreview = (name: string, { dir }: { dir?: string } = {}): Promise<unknown> =>
  req('/api/previews', { method: 'POST', body: JSON.stringify({ name, dir }) });
export const getPreviews = (): Promise<unknown> => req('/api/previews');
export const deletePreview = (name: string): Promise<unknown> =>
  req(`/api/previews/${encodeURIComponent(name)}`, { method: 'DELETE' });

// Upload one file into `dir` (an absolute path under $HOME). `dir` is appended BEFORE the file so
// the server sees the field before the file part (busboy emits parts in order). XHR (not fetch) so
// upload progress is reportable via onProgress(fraction 0..1). We do NOT set Content-Type — the
// browser adds multipart/form-data with the correct boundary.
// stash=true → 传到 ~/.handmux/uploads 下按 cwd 分的空间(服务端按需创建,dir 此时是会话 cwd);
// 返回体含文件绝对路径。文件落在家目录、不进项目树,避免被误提交。
// Thrown when the caller aborts an upload via its AbortSignal — a normal outcome (user hit Cancel),
// NOT a failure, so callers should swallow it silently rather than show a red error.
export class UploadAbort extends Error {
  constructor() {
    super('upload aborted');
    this.name = 'UploadAbort';
  }
}

// onProgress(fraction 0..1, phase) — phase is 'sending' while bytes stream out, then 'processing' once
// the browser has flushed the whole body to the socket/proxy. IMPORTANT: 'sending' 100% does NOT mean
// done — over nginx/a tunnel the body is buffered at the edge fast, then the real wait (server receive
// + disk write + response) happens with nothing left to report. We surface that as the indeterminate
// 'processing' phase so the UI stops sitting at a frozen, misleading 100%. `signal` cancels in flight.
export type UploadPhase = 'sending' | 'processing';
export type UploadProgress = (fraction: number, phase: UploadPhase) => void;
export interface UploadFileOptions {
  signal?: AbortSignal;
}

export function uploadFile(
  dir: string,
  file: File,
  onProgress?: UploadProgress,
  stash = false,
  { signal }: UploadFileOptions = {},
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (signal?.aborted) return reject(new UploadAbort());
    const token = getToken();
    const fd = new FormData();
    fd.append('dir', dir);
    if (stash) fd.append('stash', '1');
    fd.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Authorization', `Bearer ${token ?? ''}`);
    xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total, 'sending'); };
    // Body fully handed off — the browser is done sending; what's left is server-side and unreportable.
    xhr.upload.onload = () => { onProgress?.(1, 'processing'); };
    const onAbort = () => xhr.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    xhr.onabort = () => { cleanup(); reject(new UploadAbort()); };
    xhr.onerror = () => { cleanup(); reject(new Error(t('api.uploadFailed'))); };
    xhr.onload = () => {
      cleanup();
      if (xhr.status === 401) return reject(new UnauthorizedError());
      if (xhr.status >= 200 && xhr.status < 300) {
        try { return resolve(JSON.parse(xhr.responseText)); } catch { return resolve({}); }
      }
      const messages: Record<number, string> = {
        400: t('api.uploadBadDir'),
        409: t('api.uploadDuplicate'),
        413: t('api.uploadTooLarge'),
        415: t('api.uploadBadType'),
      };
      const msg = messages[xhr.status] || t('api.uploadFailed');
      reject(new Error(msg));
    };
    xhr.send(fd);
  });
}
