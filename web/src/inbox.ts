// Pure helpers for the in-app inbox: turn the server's pane-state map (GET /api/states) into the
// roster of all Claude panes, collapse the four raw kinds into three display "views", and apply the
// done-history high-water mark. No I/O — unit-tested.
import { t } from './i18n';

// Raw server kind → display view. idle is just an aged done; permission is the "needs you" bucket
// (covers tool-permission, AskUserQuestion, ExitPlanMode — all fire permission_prompt).
// compacting (context compaction) is a busy state → reads as 进行中. `error` (a turn that died on an API
// error) is a terminal result with the same canonical unread lifecycle as done, but a distinct red state.
export type InboxView = 'working' | 'done' | 'needs' | 'error';

export interface PaneInboxState {
  kind?: string | null;
  session?: string | null;
  window?: string | null;
  windowName?: string | null;
  msg?: string | null;
  ts?: number | null;
  agent?: string | null;
  terminalUnread?: boolean;
  terminalNotificationId?: string;
}

export interface InboxRow {
  pane: string;
  session: string;
  window: string;
  windowName: string;
  view: InboxView;
  msg: string;
  ts: number;
  agent: string | null;
  terminalNotificationId?: string;
}

export type InboxCounts = Record<InboxView, number>;

const VIEW: Record<string, InboxView | undefined> = {
  working: 'working', compacting: 'working', done: 'done', idle: 'done', permission: 'needs', error: 'error',
};
// Urgency for ordering within a session AND for the topbar dot's colour: error > needs > done > working.
const VIEW_RANK: Record<InboxView, number> = { error: 4, needs: 3, done: 2, working: 1 };

export const VIEW_LABEL: Record<InboxView, string> = {
  working: t('inbox.view.working'),
  done: t('inbox.view.done'),
  needs: t('inbox.view.needs'),
  error: t('inbox.view.error'),
};

// One row per Claude pane, grouped-sortable. `done` rows are HISTORY-FILTERED: a done shows only when
// its ts beats both the device high-water mark (readTs) and the per-pane seen ts. working/needs are
// current state and never filtered. Sort: session asc, then needs>working>done, then most-recent.
export function inboxRows(
  states: Record<string, PaneInboxState> = {},
  seen: Record<string, number> = {},
  readTs = 0,
): InboxRow[] {
  const rows: InboxRow[] = [];
  for (const [pane, st] of Object.entries(states)) {
    const view = typeof st.kind === 'string' ? VIEW[st.kind] : undefined;
    if (!view) continue;
    const ts = st.ts || 0;
    if ((view === 'done' || view === 'error') && (st.terminalUnread === false
      || (st.terminalUnread === undefined && !(ts > Math.max(readTs || 0, seen[pane] || 0))))) continue;
    rows.push({
      pane,
      session: st.session || '',
      window: st.window || '',
      windowName: st.windowName || '',
      view,
      msg: st.msg || '',
      ts,
      // Compatibility is limited to legacy rows that predate the `agent` field. A present but empty
      // identity is not evidence of Claude and must stay visually neutral.
      agent: Object.hasOwn(st, 'agent') ? (st.agent || null) : 'claude',
      ...(st.terminalNotificationId === undefined
        ? {} : { terminalNotificationId: st.terminalNotificationId }),
    });
  }
  rows.sort((a, b) => (
    a.session < b.session ? -1
      : a.session > b.session ? 1
        : (VIEW_RANK[b.view] - VIEW_RANK[a.view]) || (b.ts - a.ts)
  ));
  return rows;
}

// Count rows per display view for the inbox header summary (进行中 / 已完成 / 需要你). Takes the
// already-filtered rows, so 已完成 matches the dones actually shown (history-suppressed ones aren't
// counted) — the header numbers line up exactly with the list below.
export function viewCounts(rows: readonly InboxRow[]): InboxCounts {
  const c: InboxCounts = { working: 0, done: 0, needs: 0, error: 0 };
  for (const row of rows) c[row.view] += 1;
  return c;
}

// Topbar dot colour = the single highest-priority view present in the roster (needs > done > working),
// or null when empty. Takes the already-filtered rows so a history-suppressed done never lights green.
export function topView(rows: readonly InboxRow[]): InboxView | null {
  let best: InboxView | null = null;
  let rank = 0;
  for (const r of rows) {
    const k = VIEW_RANK[r.view] || 0;
    if (k > rank) { rank = k; best = r.view; }
  }
  return best;
}

// Largest ts across all panes — seeds / advances the read-ts high-water mark (server-clock based).
export function maxTs(states: Record<string, PaneInboxState>): number {
  let m = 0;
  for (const st of Object.values(states)) {
    const ts = typeof st.ts === 'number' && Number.isFinite(st.ts) ? st.ts : 0;
    if (ts > m) m = ts;
  }
  return m;
}

export function applyTerminalReads(
  states: Record<string, PaneInboxState>,
  notificationIds: ReadonlySet<string>,
): Record<string, PaneInboxState> {
  let changed = false;
  const next = Object.fromEntries(Object.entries(states).map(([pane, state]) => {
    if (!state.terminalUnread || !state.terminalNotificationId
      || !notificationIds.has(state.terminalNotificationId)) return [pane, state];
    changed = true;
    return [pane, { ...state, terminalUnread: false }];
  }));
  return changed ? next : states;
}

export function visibleCurrentPaneState(
  rootView: 'session' | 'project',
  pane: string | null | undefined,
  states: Record<string, PaneInboxState>,
): PaneInboxState | null {
  if (rootView !== 'session' || !pane) return null;
  return states[pane] ?? null;
}

// Humanise a ms-epoch timestamp as a short "x 秒/分钟/小时/天前" relative to now (ms-epoch).
export function relTime(ts: number, now: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return t('time.secAgo', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('time.minAgo', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('time.hourAgo', { n: h });
  return t('time.dayAgo', { n: Math.round(h / 24) });
}
