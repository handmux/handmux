// web/src/components/GitPanel.jsx
import { useEffect, useState, useCallback, useRef } from 'react';
import { fetchPaneCwd, gitRepos as apiRepos, gitStatus, gitLog, gitBranches, gitDiff, gitCommit } from '../api.js';
import { getGitRepos, addGitRepos, removeGitRepo, getDiffFontIndex, setDiffFontIndex, DOC_FONT_SIZES } from '../storage.js';
import { parseDiff } from '../gitDiff.js';
import DirPicker from './DirPicker.jsx';
import { ChevronDownIcon, GitIcon } from './icons.jsx';
import { t } from '../i18n';
import { useBackButton, useHistoryLayer, unwindHistory } from '../hooks/useBackButton.js';
import { OverlayPortal } from '../overlays/OverlayHost.js';

// basename of an absolute path (the repo-tab label). Exported for the unit test.
export const basename = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || p;

// A git porcelain status code → a one-letter badge. '?' is untracked, '!' ignored; otherwise the
// first non-space of x/y (staged/worktree) wins (M/A/D/R/C/U).
function statusBadge(x, y) {
  const code = (x && x !== ' ' ? x : y) || '?';
  return code === '?' ? '?' : code;
}

// Full-screen git viewer — same portal-on-<body> + .file-sheet slide-up shell as FileManager, so the
// app's keyboard-inset transform can't drag it off-screen. READ-ONLY: the repo home shows two
// collapsible zones (VS Code source-control style) — 变更 (sized to content, top) and 提交 (the elastic
// middle, paged 20-at-a-time on scroll) — plus a top-right branch dropdown; it drills into per-file
// diffs / commit details. Picking a branch only re-points 提交 at that branch's log (git log <ref>);
// it never checks out, so the shared work tree is safe.
export default function GitPanel({ open, pane, windowId, inset = 0, onClose }) {
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const [repos, setRepos] = useState([]);
  const [active, setActive] = useState(null);
  // Drill-down navigation stack: each frame is {kind:'diff',path,commit?,staged?} | {kind:'commit',hash}.
  // The top frame is the page on screen; [] is the repo home (the combined sections page).
  const [stack, setStack] = useState([]);
  const drill = stack.length ? stack[stack.length - 1] : null;
  const [pickOpen, setPickOpen] = useState(false);
  const [seedCwd, setSeedCwd] = useState(null);       // DirPicker start dir (the pane's cwd)
  // Always-fresh windowId ref — onPick is async and captures a closure; using the ref means we
  // always write to storage under the windowId that's valid at the time the pick resolves, not the
  // stale one from when the callback was created (e.g. when current was briefly null).
  const windowIdRef = useRef(windowId);
  useEffect(() => { windowIdRef.current = windowId; }, [windowId]);

  // Home data, fetched as a bundle. `changes`/`branches` follow the work tree (not branch-specific);
  // `commits` follows `viewedBranch` (null = current HEAD). null = still loading.
  const [changes, setChanges] = useState(null);
  const [branches, setBranches] = useState(null);
  const [commits, setCommits] = useState(null);
  const [viewedBranch, setViewedBranch] = useState(null); // which branch's log the 提交 section shows
  const [commitLimit, setCommitLimit] = useState(20);     // 提交 grows by 20 as you scroll to the bottom
  const [loadingMore, setLoadingMore] = useState(false);
  // Home zones (both collapsible): 变更 = top, 提交 = elastic middle. 分支 isn't a zone — it's a
  // top-right dropdown that re-points 提交 at the picked branch (read-only).
  const [expanded, setExpanded] = useState({ changes: true, commits: true });
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const commitsBodyRef = useRef(null);

  const [data, setData] = useState(null);   // drill payload { key, payload } — tagged with its viewKey
  const [error, setError] = useState(null);
  // A soft, non-error note (grey, not red): e.g. the directory you picked simply has no git repo in it —
  // that's an expected outcome, not a failure, so it must never look like the red error line.
  const [notice, setNotice] = useState(null);

  // Hardware/browser Back steps back ONE level and only closes the panel at the repo home — never
  // blows the whole app away mid-navigation. We MIRROR the navigation depth into browser history:
  // one entry for the open panel, one more per drill level (and one for the DirPicker). Back pops one
  // entry → we pop one level; at the base (home) Back closes the panel. The popstate handler only
  // *reads* state and decrements a counter — it never pushState()s (some Android WebViews drop a
  // pushState made inside a popstate handler, which would unbalance history and exit the app). A
  // close-by-button unwinds the remaining entries in the cleanup. The on-screen ‹ and the DirPicker's
  // dismiss both route through window.history.back() so every level change flows through this one path.
  const stackRef = useRef(stack); stackRef.current = stack;
  const pickOpenRef = useRef(pickOpen); pickOpenRef.current = pickOpen;
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const depthRef = useRef(0);   // # of our live history entries (base + drills + picker)
  const pushHist = () => { window.history.pushState({ gitOverlay: true }, ''); depthRef.current += 1; };
  const pushDrill = (frame) => { pushHist(); setStack((s) => [...s, frame]); };
  const openPicker = () => { pushHist(); setPickOpen(true); };
  useBackButton(open && branchMenuOpen, () => setBranchMenuOpen(false));
  useHistoryLayer(open, () => {
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (pickOpenRef.current) { setPickOpen(false); return; }
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
    const stored = getGitRepos(windowId);
    if (stored.length) {
      setRepos(stored);
      setActive((a) => (a && stored.includes(a) ? a : stored[0]));
      return () => { cancelled = true; };
    }
    setRepos([]); setActive(null);
    (async () => {
      try {
        if (!pane) return;
        const { cwd } = await fetchPaneCwd(pane);
        if (!cwd) return;
        const { repos: found = [] } = await apiRepos(cwd);
        if (cancelled || !found.length) return;
        const next = addGitRepos(windowId, found.map((r) => r.path));
        if (cancelled) return;
        setRepos(next);
        setActive(next[0] ?? null);
      } catch (e) {
        if (cancelled) return;
        // "outside home" isn't a failure — the repo just sits outside the area handmux can browse.
        // Explain why (and what's reachable) in the soft grey note, not the red error line.
        if (e?.message === 'outside home') setNotice(t('git.outsideRoots'));
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
    fetchPaneCwd(pane).then(({ cwd }) => { if (!cancelled && cwd) setSeedCwd(cwd); }).catch(() => {});
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
        const [st, br] = await Promise.all([gitStatus(active), gitBranches(active)]);
        if (cancelled) return;
        setChanges(st.changes ?? []);
        setBranches(br.branches ?? []);
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
        const { commits: list = [] } = await gitLog(active, { ref: viewedBranch || undefined, limit: commitLimit });
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
        let payload;
        if (drill.kind === 'diff') {
          const { diff, truncated } = await gitDiff(active, { path: drill.path, commit: drill.commit, staged: drill.staged });
          payload = { files: parseDiff(diff), truncated };
        } else {
          payload = await gitCommit(active, drill.hash);
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

  const switchRepo = (p) => { setActive(p); setStack([]); setViewedBranch(null); };
  const onPick = async (dir) => {
    window.history.back();   // dismiss the picker (pops its history entry → onPop closes it)
    setNotice(null);
    try {
      const { repos: found = [] } = await apiRepos(dir);
      if (!mountedRef.current) return;
      if (!found.length) { setNotice(t('git.noRepoInDir')); return; }
      const foundPaths = found.map((r) => r.path);
      // Use the ref so we always write to the current windowId even if the prop was stale in this closure.
      const wid = windowIdRef.current;
      const next = wid ? addGitRepos(wid, foundPaths) : foundPaths;
      // Functional updater: append to whatever the current list is (avoids stale-closure overwrite).
      setRepos((prev) => {
        const merged = [...prev];
        for (const p of next) if (!merged.includes(p)) merged.push(p);
        return merged;
      });
      const firstNew = foundPaths.find((p) => !repos.includes(p)) || foundPaths[0];
      switchRepo(firstNew);
    } catch (e) {
      if (!mountedRef.current) return;
      if (e?.message === 'outside home') setNotice(t('git.outsideRoots'));
      else setError(t('git.errReadDir'));
    }
  };
  const unbind = (p) => {
    const next = removeGitRepo(windowId, p);
    setRepos(next);
    if (active === p) { setActive(next[0] ?? null); setStack([]); setViewedBranch(null); }
  };

  const currentBranch = (branches || []).find((b) => b.current) || null;
  // Pick a branch → point 提交 at it (the current branch maps to null = HEAD). Picking the branch
  // already on screen is a NO-OP: clearing commits without changing viewedBranch/commitLimit would
  // leave the fetch effect's deps unchanged, so it'd never re-run and 提交 would hang on 加载中.
  const selectBranch = (name) => {
    const next = name === currentBranch?.name ? null : name;
    if (next === viewedBranch) return;
    setViewedBranch(next);
    setCommits(null); setCommitLimit(20);
  };
  const toggle = (k) => setExpanded((e) => ({ ...e, [k]: !e[k] }));

  // 提交 is the middle zone with its own scroll: near the bottom, pull the next 20 (only while the
  // last page came back full — a short page means we've reached the end).
  const commitsHasMore = commits != null && commits.length >= commitLimit;
  const onCommitsScroll = (e) => {
    if (!commitsHasMore || loadingMore) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
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
  const shown = data && data.key === viewKey ? data.payload : null;
  const drilledIn = !!drill;
  const title = drill?.kind === 'commit' ? t('git.commitDetail')
    : drill?.kind === 'diff' ? (drill.path || t('git.diff'))
    : '';

  return (
    <OverlayPortal keyboardInset={inset}>
      <div className={`file-sheet git-sheet ${open ? 'open' : ''}`} aria-hidden={!open} style={{ '--kb-inset': `${inset}px` }}>
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
              : drill.kind === 'diff' ? <DiffView data={shown} />
              : <CommitView data={shown} onOpenFile={(path) => pushDrill({ kind: 'diff', path, commit: drill.hash })} />}
          </div>
        )}

        {/* Home: 变更 sizes to its content (capped) at the top; 提交 is the elastic middle that fills the
            rest and scrolls (load-more). Both collapse independently. 分支 lives in the header dropdown. */}
        {!drilledIn && active && !error && (
          <>
            <Section variant="top" title={t('git.changes')} count={changes?.length} expanded={expanded.changes} onToggle={() => toggle('changes')}>
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
        pane={pane}
        inset={inset}
        hint={t('git.pickerHint')}
        onPick={onPick}
        onClose={() => window.history.back()}
      />
    </div>
    </OverlayPortal>
  );
}

// One home zone. `variant` (top|mid) fixes where it sits and how it flexes. A tap-to-toggle caret
// header hides the body when collapsed; the body scrolls internally (the middle zone also wires a
// scroll handler for the 提交 load-more) so the zones keep their positions as content grows/shrinks.
function Section({ variant, title, subtitle, count, expanded, onToggle, onScroll, bodyRef, children }) {
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

function ChangesView({ data, onOpenFile }) {
  const changes = data?.changes ?? [];
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

function CommitsView({ data, onOpen }) {
  const commits = data?.commits ?? [];
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

function CommitView({ data, onOpenFile }) {
  if (!data) return null;
  const files = data.files ?? [];
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

const DIFF_FONT_LAST = DOC_FONT_SIZES.length - 1;

function DiffView({ data }) {
  const [fontIdx, setFontIdx] = useState(() => getDiffFontIndex());
  const bump = (d) => { const n = Math.min(DIFF_FONT_LAST, Math.max(0, fontIdx + d)); setFontIdx(n); setDiffFontIndex(n); };
  if (!data) return null;
  const files = data.files ?? [];
  if (!files.length) return <div className="git-empty">{t('git.noDiff')}</div>;
  return (
    <div className="git-diff-wrap" style={{ fontSize: `${DOC_FONT_SIZES[fontIdx]}px` }}>
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
