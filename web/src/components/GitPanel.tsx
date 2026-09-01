import { useEffect, useState, useCallback, useRef } from 'react';
import type { CSSProperties, ReactNode, RefObject, UIEvent as ReactUIEvent } from 'react';
import { fetchPaneCwd, gitRepos as apiRepos, gitStatus, gitLog, gitBranches, gitDiff, gitCommit } from '../api.js';
import { getGitRepos, addGitRepos, removeGitRepo, getDiffFontIndex, setDiffFontIndex, DOC_FONT_SIZES } from '../storage.js';
import { parseDiff } from '../gitDiff.js';
import DirPicker from './DirPicker.jsx';
import { ChevronDownIcon, GitIcon } from './icons.jsx';
import { t } from '../i18n';
import { useBackButton, useHistoryLayer, unwindHistory } from '../hooks/useBackButton.js';
import { OverlayPortal } from '../overlays/OverlayHost.js';
import {
  parseGitBranches,
  parseGitCommit,
  parseGitDiff as parseGitDiffResponse,
  parseGitLog,
  parseGitRepos,
  parseGitStatus,
} from '../gitContracts.js';
import type { GitBranch, GitChange, GitCommitDetail, GitCommitSummary } from '../gitContracts.js';
import type { GitDiffFile } from '../gitDiff.js';

type DrillFrame =
  | { kind: 'diff'; path: string; commit?: string; staged?: boolean }
  | { kind: 'commit'; hash: string };

type ExpandedSection = 'changes' | 'commits';

interface DiffPayload {
  kind: 'diff';
  files: GitDiffFile[];
  truncated: boolean;
}

interface CommitPayload extends GitCommitDetail {
  kind: 'commit';
}

type DrillPayload = DiffPayload | CommitPayload;

interface DrillData {
  key: string;
  payload: DrillPayload;
}

export interface GitPanelProps {
  open: boolean;
  pane?: string | null;
  windowId?: string | null;
  inset?: number;
  onClose: () => void;
}

const cwdOf = (value: unknown): string | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const cwd = (value as Record<string, unknown>).cwd;
  return typeof cwd === 'string' && cwd ? cwd : null;
};

const stringList = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
);

const errorMessage = (value: unknown): string => value instanceof Error ? value.message : '';

// basename of an absolute path (the repo-tab label). Exported for the unit test.
export const basename = (path: string | null | undefined): string => (
  String(path || '').replace(/\/+$/, '').split('/').pop() || path || ''
);

// A git porcelain status code → a one-letter badge. '?' is untracked, '!' ignored; otherwise the
// first non-space of x/y (staged/worktree) wins (M/A/D/R/C/U).
function statusBadge(x: string | null | undefined, y: string | null | undefined): string {
  const code = (x && x !== ' ' ? x : y) || '?';
  return code === '?' ? '?' : code;
}

// Full-screen git viewer — same portal-on-<body> + .file-sheet slide-up shell as FileManager, so the
// app's keyboard-inset transform can't drag it off-screen. READ-ONLY: the repo home shows two
// collapsible zones (VS Code source-control style) — 变更 (sized to content, top) and 提交 (the elastic
// middle, paged 20-at-a-time on scroll) — plus a top-right branch dropdown; it drills into per-file
// diffs / commit details. Picking a branch only re-points 提交 at that branch's log (git log <ref>);
// it never checks out, so the shared work tree is safe.
export default function GitPanel({ open, pane, windowId, inset = 0, onClose }: GitPanelProps) {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const [repos, setRepos] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // Drill-down navigation stack: each frame is {kind:'diff',path,commit?,staged?} | {kind:'commit',hash}.
  // The top frame is the page on screen; [] is the repo home (the combined sections page).
  const [stack, setStack] = useState<DrillFrame[]>([]);
  const drill = stack.at(-1) ?? null;
  const [pickOpen, setPickOpen] = useState(false);
  const [seedCwd, setSeedCwd] = useState<string | null>(null); // DirPicker start dir
  // Always-fresh windowId ref — onPick is async and captures a closure; using the ref means we
  // always write to storage under the windowId that's valid at the time the pick resolves, not the
  // stale one from when the callback was created (e.g. when current was briefly null).
  const windowIdRef = useRef(windowId);
  useEffect(() => { windowIdRef.current = windowId; }, [windowId]);

  // Home data, fetched as a bundle. `changes`/`branches` follow the work tree (not branch-specific);
  // `commits` follows `viewedBranch` (null = current HEAD). null = still loading.
  const [changes, setChanges] = useState<GitChange[] | null>(null);
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [commits, setCommits] = useState<GitCommitSummary[] | null>(null);
  const [viewedBranch, setViewedBranch] = useState<string | null>(null); // branch whose log is shown
  const [commitLimit, setCommitLimit] = useState(20);     // 提交 grows by 20 as you scroll to the bottom
  const [loadingMore, setLoadingMore] = useState(false);
  // Home zones (both collapsible): 变更 = top, 提交 = elastic middle. 分支 isn't a zone — it's a
  // top-right dropdown that re-points 提交 at the picked branch (read-only).
  const [expanded, setExpanded] = useState<Record<ExpandedSection, boolean>>({ changes: true, commits: true });
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const commitsBodyRef = useRef<HTMLDivElement | null>(null);

  const [data, setData] = useState<DrillData | null>(null); // payload tagged with its viewKey
  const [error, setError] = useState<string | null>(null);
  // A soft, non-error note (grey, not red): e.g. the directory you picked simply has no git repo in it —
  // that's an expected outcome, not a failure, so it must never look like the red error line.
  const [notice, setNotice] = useState<string | null>(null);

  // Hardware/browser Back steps back ONE level and only closes the panel at the repo home — never
  // blows the whole app away mid-navigation. We MIRROR the navigation depth into browser history:
  // one entry for the open panel and one more per drill level. DirPicker owns its own history layer,
  // so opening it here must not push a second entry for the same visible overlay. Back pops one
  // entry → we pop one level; at the base (home) Back closes the panel. The popstate handler only
  // *reads* state and decrements a counter — it never pushState()s (some Android WebViews drop a
  // pushState made inside a popstate handler, which would unbalance history and exit the app). A
  // close-by-button unwinds the remaining entries in the cleanup. The on-screen ‹ routes through
  // window.history.back(); DirPicker balances its own Back/close lifecycle independently.
  const stackRef = useRef(stack); stackRef.current = stack;
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const depthRef = useRef(0);   // # of our live history entries (base + drills)
  const pushHist = (): void => { window.history.pushState({ gitOverlay: true }, ''); depthRef.current += 1; };
  const pushDrill = (frame: DrillFrame): void => { pushHist(); setStack((current) => [...current, frame]); };
  const openPicker = (): void => { setPickOpen(true); };
  useBackButton(open && branchMenuOpen, () => setBranchMenuOpen(false));
  useHistoryLayer(open, () => {
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (stackRef.current.length) { setStack((s) => s.slice(0, -1)); return; }
    onCloseRef.current?.();
  });
  useEffect(() => {
    if (!open) return undefined;
    pushHist();                       // base entry for the open panel
    return () => {
      // Closed by a button (not Back): drop whatever entries we still own so history stays balanced.
      if (depthRef.current > 0) { unwindHistory(depthRef.current); depthRef.current = 0; }
    };
  }, [open]);

  // On open: load bound repos. If none and a pane is given, discover repos under the pane's cwd and
  // bind them. Guard every setState behind a cancelled flag (the discovery is async → may resolve
  // after the panel closes / unmounts).
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setStack([]); setViewedBranch(null); setError(null); setNotice(null);
    const stored = stringList(getGitRepos(windowId));
    if (stored.length) {
      setRepos(stored);
      setActive((current) => (current && stored.includes(current) ? current : stored[0] ?? null));
      return () => { cancelled = true; };
    }
    setRepos([]); setActive(null);
    (async () => {
      try {
        if (!pane) return;
        const cwd = cwdOf(await fetchPaneCwd(pane));
        if (!cwd) return;
        const found = parseGitRepos(await apiRepos(cwd));
        if (cancelled || !found.length) return;
        const next = stringList(addGitRepos(windowId, found.map((repo) => repo.path)));
        if (cancelled) return;
        setRepos(next);
        setActive(next[0] ?? null);
      } catch (caught) {
        if (cancelled) return;
        // "outside home" isn't a failure — the repo just sits outside the area handmux can browse.
        // Explain why (and what's reachable) in the soft grey note, not the red error line.
        if (errorMessage(caught) === 'outside home') setNotice(t('git.outsideRoots'));
        else setError(t('git.errReadRepo'));
      }
    })();
    return () => { cancelled = true; };
  }, [open, pane, windowId]);

  // Seed the bind-repo picker at the pane's LIVE cwd whenever the panel is open. The discovery effect
  // above only learns the cwd when NO repos are bound yet; once a window has repos it returns early, so
  // without this the picker (opened by "+ bind repo") would land on $HOME instead of the current dir.
  useEffect(() => {
    if (!open || !pane) return undefined;
    let cancelled = false;
    fetchPaneCwd(pane).then((response) => {
      const cwd = cwdOf(response);
      if (!cancelled && cwd) setSeedCwd(cwd);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, pane]);

  // Home bundle: work-tree changes + branch list. Not branch-specific → keyed on (open, active).
  // Switching repo resets the viewed branch back to HEAD.
  useEffect(() => {
    if (!open || !active) { setChanges(null); setBranches(null); return undefined; }
    let cancelled = false;
    // Switching repo resets the viewed branch and the commits paging back to the first page.
    setChanges(null); setBranches(null); setCommits(null); setViewedBranch(null); setCommitLimit(20); setError(null); setNotice(null);
    (async () => {
      try {
        const [statusResponse, branchesResponse] = await Promise.all([gitStatus(active), gitBranches(active)]);
        if (cancelled) return;
        const nextChanges = parseGitStatus(statusResponse);
        const nextBranches = parseGitBranches(branchesResponse);
        setChanges(nextChanges);
        setBranches(nextBranches);
      } catch {
        if (!cancelled) setError(t('git.errLoad'));
      }
    })();
    return () => { cancelled = true; };
  }, [open, active]);

  // Commits for the viewed branch (null = current HEAD), capped at commitLimit. Re-fetches when the
  // branch selection changes OR the limit grows (scroll-to-load-more). We DON'T null the list here —
  // context changes clear it elsewhere, so a load-more keeps the current rows visible while extending.
  useEffect(() => {
    if (!open || !active) { setCommits(null); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const list = parseGitLog(await gitLog(active, {
          limit: commitLimit,
          ...(viewedBranch ? { ref: viewedBranch } : {}),
        }));
        if (!cancelled) setCommits(list);
      } catch {
        if (!cancelled) setCommits([]);
      } finally {
        if (!cancelled) setLoadingMore(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, active, viewedBranch, commitLimit]);

  // Identity of the drill page on screen (or '' at home). `data` is tagged with this key; the render
  // only shows data whose key matches — so a fast switch (commit-detail → file diff) can't briefly
  // feed one view the previous frame's differently-shaped payload.
  const viewKey = !active || !drill ? ''
    : drill.kind === 'diff' ? `${active}|diff|${drill.path}|${drill.commit || ''}|${drill.staged ? 1 : 0}`
    : `${active}|commit|${drill.hash}`;

  // Fetch the drill page's data. Re-fetches whenever viewKey changes; cancelled-guarded.
  useEffect(() => {
    if (!open || !active || !drill) { setData(null); return undefined; }
    let cancelled = false;
    setError(null); setData(null);
    (async () => {
      try {
        let payload: DrillPayload;
        if (drill.kind === 'diff') {
          const response = parseGitDiffResponse(await gitDiff(active, {
            path: drill.path,
            ...(drill.commit !== undefined ? { commit: drill.commit } : {}),
            ...(drill.staged !== undefined ? { staged: drill.staged } : {}),
          }));
          payload = { kind: 'diff', files: parseDiff(response.diff), truncated: response.truncated };
        } else {
          payload = { kind: 'commit', ...parseGitCommit(await gitCommit(active, drill.hash)) };
        }
        if (!cancelled) setData({ key: viewKey, payload });
      } catch {
        if (!cancelled) setError(t('git.errLoad'));
      }
    })();
    return () => { cancelled = true; };
  }, [open, viewKey]);

  // Both the on-screen ‹ and hardware Back go through history so they share the one back path above.
  const goBack = useCallback(() => { window.history.back(); }, []);

  const switchRepo = (path: string): void => { setActive(path); setStack([]); setViewedBranch(null); };
  const onPick = async (dir: string): Promise<void> => {
    setPickOpen(false);      // DirPicker cleanup balances the history entry it owns.
    setNotice(null);
    try {
      const found = parseGitRepos(await apiRepos(dir));
      if (!mountedRef.current) return;
      if (!found.length) { setNotice(t('git.noRepoInDir')); return; }
      const foundPaths = found.map((repo) => repo.path);
      // Use the ref so we always write to the current windowId even if the prop was stale in this closure.
      const wid = windowIdRef.current;
      const next = wid ? stringList(addGitRepos(wid, foundPaths)) : foundPaths;
      // Functional updater: append to whatever the current list is (avoids stale-closure overwrite).
      setRepos((prev) => {
        const merged = [...prev];
        for (const p of next) if (!merged.includes(p)) merged.push(p);
        return merged;
      });
      const firstNew = foundPaths.find((path) => !repos.includes(path)) ?? foundPaths[0];
      if (firstNew) switchRepo(firstNew);
    } catch (caught) {
      if (!mountedRef.current) return;
      if (errorMessage(caught) === 'outside home') setNotice(t('git.outsideRoots'));
      else setError(t('git.errReadDir'));
    }
  };
  const unbind = (path: string): void => {
    const next = stringList(removeGitRepo(windowId, path));
    setRepos(next);
    if (active === path) { setActive(next[0] ?? null); setStack([]); setViewedBranch(null); }
  };

  const currentBranch = (branches || []).find((b) => b.current) || null;
  // Pick a branch → point 提交 at it (the current branch maps to null = HEAD). Picking the branch
  // already on screen is a NO-OP: clearing commits without changing viewedBranch/commitLimit would
  // leave the fetch effect's deps unchanged, so it'd never re-run and 提交 would hang on 加载中.
  const selectBranch = (name: string): void => {
    const next = name === currentBranch?.name ? null : name;
    if (next === viewedBranch) return;
    setViewedBranch(next);
    setCommits(null); setCommitLimit(20);
  };
  const toggle = (key: ExpandedSection): void => setExpanded((current) => ({ ...current, [key]: !current[key] }));

  // 提交 is the middle zone with its own scroll: near the bottom, pull the next 20 (only while the
  // last page came back full — a short page means we've reached the end).
  const commitsHasMore = commits != null && commits.length >= commitLimit;
  const onCommitsScroll = (event: ReactUIEvent<HTMLDivElement>): void => {
    if (!commitsHasMore || loadingMore) return;
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 80) {
      setLoadingMore(true);
      setCommitLimit((l) => l + 20);
    }
  };
  // The branch the 提交 section is showing (viewed override, else current HEAD) + its info for the
  // dropdown trigger label.
  const shownBranch = viewedBranch || currentBranch?.name || null;
  const viewingOther = !!viewedBranch && viewedBranch !== currentBranch?.name;
  const shownBranchInfo = viewedBranch ? (branches || []).find((b) => b.name === viewedBranch) : currentBranch;

  // Stay mounted while closed (translated off-screen) so opening slides up via the .file-sheet
  // transition, exactly like the file browser — returning null would mount already-open and skip it.
  // Only surface drill data that belongs to the page on screen (see viewKey).
  const shown: DrillPayload | null = data && data.key === viewKey ? data.payload : null;
  const drilledIn = !!drill;
  const title = drill?.kind === 'commit' ? t('git.commitDetail')
    : drill?.kind === 'diff' ? (drill.path || t('git.diff'))
    : '';
  const sheetStyle: CSSProperties & { '--kb-inset': string } = { '--kb-inset': `${inset}px` };

  return (
    <OverlayPortal keyboardInset={inset}>
      <div
        className={`file-sheet git-sheet ${open ? 'open' : ''}`}
        aria-hidden={!open}
        style={sheetStyle}
      >
      {/* Top row, FileManager-style: repo switching + 绑定 on the left (scrolls), collapse at top-right.
          When drilled into a diff/commit, the left area becomes a back button + the file/commit title. */}
      <div className="file-tabs git-head">
        {drilledIn ? (
          <div className="git-drill-head">
            <button className="git-back" aria-label={t('common.back')} title={t('common.back')} onClick={goBack}>‹</button>
            <span className="git-drill-title"><GitIcon /><span className="git-title-text">{title}</span></span>
          </div>
        ) : (
          <div className="git-tabs-scroll">
            <button className="git-tab-add" aria-label={t('git.bindRepo')} title={t('git.bindRepo')} onClick={openPicker}>＋</button>
            {repos.map((p) => (
              <div key={p} className={`git-tab ${p === active ? 'active' : ''}`}>
                <button className="git-tab-label" onClick={() => switchRepo(p)}>{basename(p)}</button>
                <button className="git-tab-x" aria-label={t('common.close')} title={t('common.close')} onClick={() => unbind(p)}>✕</button>
              </div>
            ))}
          </div>
        )}
        <button className="file-min" aria-label={t('git.collapse')} title={t('git.collapse')} onClick={() => onClose?.()}><ChevronDownIcon /></button>
      </div>

      {/* Second row under the header: current branch on the left, a switch-branch dropdown on the right.
          The menu lists every branch with its upstream / ahead-behind and re-points 提交 at the picked
          one (read-only — never a checkout). */}
      {!drilledIn && active && (
        <div className="git-branch-bar">
          {/* Left: the branch 提交 is currently showing (follows the dropdown). Tagged 「当前分支」 when
              it's the repo's actual HEAD. */}
          <span className="git-branch-bar-name">
            <span className="git-branch-glyph">⎇</span> {shownBranch || '—'}
            {!viewingOther && shownBranch && <span className="git-branch-cur-tag">{t('git.currentBranch')}</span>}
            {shownBranchInfo && (shownBranchInfo.ahead || shownBranchInfo.behind) ? (
              <span className="git-branch-bar-track">
                {shownBranchInfo.ahead ? <span className="git-ahead">↑{shownBranchInfo.ahead}</span> : null}
                {shownBranchInfo.behind ? <span className="git-behind">↓{shownBranchInfo.behind}</span> : null}
              </span>
            ) : null}
          </span>
          <div className="git-branch-dd">
            <button className={`git-branch-trigger ${viewingOther ? 'other' : ''}`} onClick={() => setBranchMenuOpen((o) => !o)}
              aria-haspopup="listbox" aria-expanded={branchMenuOpen} title={t('git.switchViewedBranch')}>
              <span className="git-branch-trigger-name">{t('git.switchBranch')}</span>
              <span className="git-branch-caret"><ChevronDownIcon /></span>
            </button>
            {branchMenuOpen && (
              <>
                <div className="git-dd-backdrop" onClick={() => setBranchMenuOpen(false)} />
                <div className="git-dd-menu" role="listbox">
                  {(branches || []).length === 0 && <div className="git-empty">{t('git.noBranches')}</div>}
                  {(branches || []).map((b) => {
                    const viewing = viewedBranch ? b.name === viewedBranch : b.current;
                    return (
                      <button key={b.name} role="option" aria-selected={viewing}
                        className={`git-dd-item ${b.current ? 'current' : ''} ${viewing ? 'viewing' : ''}`}
                        onClick={() => { selectBranch(b.name); setBranchMenuOpen(false); }}>
                        <span className="git-branch-dot">{b.current ? '●' : ''}</span>
                        <span className="git-row-path">{b.name}</span>
                        {b.upstream && (
                          <span className="git-branch-up">{b.upstream}
                            {b.ahead ? <span className="git-ahead"> ↑{b.ahead}</span> : null}
                            {b.behind ? <span className="git-behind"> ↓{b.behind}</span> : null}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="git-body">
        {error && <div className="git-error">{error}</div>}
        {notice && !error && !drilledIn && <div className="git-notice">{notice}</div>}
        {!active && !error && !notice && (
          <div className="git-empty">{t('git.noRepoBound')}</div>
        )}

        {drilledIn && active && !error && (
          <div className="git-scroll">
            {!shown ? <div className="git-loading">{t('common.loading')}</div>
              : shown.kind === 'diff' ? <DiffView data={shown} />
              : <CommitView
                  data={shown}
                  onOpenFile={(path) => pushDrill({
                    kind: 'diff',
                    path,
                    ...(drill.kind === 'commit' ? { commit: drill.hash } : {}),
                  })}
                />}
          </div>
        )}

        {/* Home: 变更 sizes to its content (capped) at the top; 提交 is the elastic middle that fills the
            rest and scrolls (load-more). Both collapse independently. 分支 lives in the header dropdown. */}
        {!drilledIn && active && !error && (
          <>
            <Section variant="top" title={t('git.changes')} expanded={expanded.changes} onToggle={() => toggle('changes')}
              {...(changes ? { count: changes.length } : {})}>
              {changes == null ? <div className="git-loading">{t('common.loading')}</div>
                : <ChangesView data={{ changes }} onOpenFile={(path, staged) => pushDrill({ kind: 'diff', path, staged })} />}
            </Section>
            <Section variant="mid" title={t('git.commits')} subtitle={viewingOther ? shownBranch : null} expanded={expanded.commits} onToggle={() => toggle('commits')}
              bodyRef={commitsBodyRef} onScroll={onCommitsScroll}>
              {commits == null ? <div className="git-loading">{t('common.loading')}</div>
                : (
                  <>
                    <CommitsView data={{ commits }} onOpen={(hash) => pushDrill({ kind: 'commit', hash })} />
                    {commitsHasMore && <div className="git-more">{loadingMore ? t('common.loading') : t('git.pullToLoadMore')}</div>}
                  </>
                )}
            </Section>
          </>
        )}
      </div>

      <DirPicker
        open={pickOpen}
        seedCwd={seedCwd}
        pane={pane ?? null}
        inset={inset}
        hint={t('git.pickerHint')}
        onPick={onPick}
        onClose={() => setPickOpen(false)}
      />
    </div>
    </OverlayPortal>
  );
}

// One home zone. `variant` (top|mid) fixes where it sits and how it flexes. A tap-to-toggle caret
// header hides the body when collapsed; the body scrolls internally (the middle zone also wires a
// scroll handler for the 提交 load-more) so the zones keep their positions as content grows/shrinks.
interface SectionProps {
  variant: 'top' | 'mid';
  title: string;
  subtitle?: string | null;
  count?: number;
  expanded: boolean;
  onToggle: () => void;
  onScroll?: (event: ReactUIEvent<HTMLDivElement>) => void;
  bodyRef?: RefObject<HTMLDivElement>;
  children: ReactNode;
}

function Section({
  variant,
  title,
  subtitle,
  count,
  expanded,
  onToggle,
  onScroll,
  bodyRef,
  children,
}: SectionProps) {
  return (
    <div className={`git-section git-section--${variant} ${expanded ? 'open' : ''}`}>
      <button className="git-section-head" onClick={onToggle} aria-expanded={expanded}>
        <span className="git-section-caret"><ChevronDownIcon /></span>
        <span className="git-section-title">{title}</span>
        {subtitle && <span className="git-section-sub">{subtitle}</span>}
        {count != null && <span className="git-section-count">{count}</span>}
      </button>
      {expanded && <div className="git-section-body" ref={bodyRef} onScroll={onScroll}>{children}</div>}
    </div>
  );
}

interface ChangesViewProps {
  data: { changes: GitChange[] };
  onOpenFile: (path: string, staged: boolean) => void;
}

function ChangesView({ data, onOpenFile }: ChangesViewProps) {
  const changes = data.changes;
  if (!changes.length) return <div className="git-empty">{t('git.cleanTree')}</div>;
  return (
    <div className="git-list">
      {changes.map((c, i) => {
        const staged = !!(c.x && c.x !== ' ' && c.x !== '?');
        return (
          <button key={`${c.path}-${i}`} className="git-row" onClick={() => onOpenFile(c.path, staged)}>
            <span className={`git-badge git-badge-${statusBadge(c.x, c.y).toLowerCase().replace('?', 'q')}`}>{statusBadge(c.x, c.y)}</span>
            <span className="git-row-path">{c.path}</span>
          </button>
        );
      })}
    </div>
  );
}

interface CommitsViewProps {
  data: { commits: GitCommitSummary[] };
  onOpen: (hash: string) => void;
}

function CommitsView({ data, onOpen }: CommitsViewProps) {
  const commits = data.commits;
  if (!commits.length) return <div className="git-empty">{t('git.noCommits')}</div>;
  return (
    <div className="git-list">
      {commits.map((c) => (
        <button key={c.hash} className="git-row git-commit-row" onClick={() => onOpen(c.hash)}>
          <span className="git-hash">{c.short}</span>
          <span className="git-commit-main">
            <span className="git-row-path">{c.subject}</span>
            <span className="git-commit-meta">{c.author} · {c.relDate}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

interface CommitViewProps {
  data: CommitPayload;
  onOpenFile: (path: string) => void;
}

function CommitView({ data, onOpenFile }: CommitViewProps) {
  const files = data.files;
  return (
    <div className="git-commit-detail">
      {data.message && <pre className="git-commit-msg">{data.message}</pre>}
      <div className="git-list">
        {files.map((f, i) => (
          <button key={`${f.path}-${i}`} className="git-row" onClick={() => onOpenFile(f.path)}>
            <span className={`git-badge git-badge-${statusBadge(f.x, f.y).toLowerCase().replace('?', 'q')}`}>{statusBadge(f.x, f.y)}</span>
            <span className="git-row-path">{f.path}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const rawDiffFontSizes: unknown = DOC_FONT_SIZES;
const DIFF_FONT_SIZES: readonly number[] = Array.isArray(rawDiffFontSizes)
  && rawDiffFontSizes.length > 0
  && rawDiffFontSizes.every((value) => typeof value === 'number' && Number.isFinite(value))
  ? rawDiffFontSizes
  : [10, 11, 12, 13, 14, 16, 18, 20, 22];
const DIFF_FONT_LAST = DIFF_FONT_SIZES.length - 1;

const readDiffFontIndex = (): number => {
  const value: unknown = getDiffFontIndex();
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= DIFF_FONT_LAST
    ? value
    : Math.min(2, DIFF_FONT_LAST);
};

function DiffView({ data }: { data: DiffPayload }) {
  const [fontIdx, setFontIdx] = useState<number>(readDiffFontIndex);
  const bump = (delta: number): void => {
    const next = Math.min(DIFF_FONT_LAST, Math.max(0, fontIdx + delta));
    setFontIdx(next);
    setDiffFontIndex(next);
  };
  const files = data.files;
  if (!files.length) return <div className="git-empty">{t('git.noDiff')}</div>;
  return (
    <div className="git-diff-wrap" style={{ fontSize: `${DIFF_FONT_SIZES[fontIdx]}px` }}>
      <div className="git-diff-zoom">
        <button className="doc-zoom-btn" onClick={() => bump(-1)} disabled={fontIdx <= 0} aria-label={t('git.fontSmaller')}>A−</button>
        <button className="doc-zoom-btn" onClick={() => bump(1)} disabled={fontIdx >= DIFF_FONT_LAST} aria-label={t('git.fontLarger')}>A+</button>
      </div>
      {data.truncated && <div className="git-diff-trunc">{t('git.diffTruncated')}</div>}
      {files.map((f, fi) => (
        <div key={`${f.path}-${fi}`} className="git-diff-file">
          {files.length > 1 && <div className="git-diff-fname">{f.path}</div>}
          <div className="git-diff">
            {f.hunks.map((h, hi) => (
              <div key={hi} className="git-diff-hunk-block">
                <div className="git-diff-line git-diff-hunk">{h.header}</div>
                {h.lines.map((ln, li) => (
                  <div key={li} className={`git-diff-line git-diff-${ln.type}`}>
                    {ln.type === 'add' ? '+' : ln.type === 'del' ? '-' : ' '}{ln.text}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
