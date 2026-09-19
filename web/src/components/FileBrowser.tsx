import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { fetchDir, downloadFile, uploadFile, createDir, UploadAbort } from '../api.js';
import { startUpload, updateUpload, finishUpload } from '../uploadJob.js';
import { UPLOAD_ACCEPT, splitUploadable } from '../uploadTypes.js';
import { joinPath } from '../docPath.js';
import { formatBytes, formatRelativeTime } from '../format.js';
import { getBrowserSort, setBrowserSort, getBrowserCollapseHidden, setBrowserCollapseHidden, type BrowserSort } from '../storage.js';
import { FolderIcon, FileIcon, FileTextIcon, ImageIcon, ArrowUpIcon, ArrowUpDownIcon, DownloadIcon, LocateIcon, FolderPlusIcon, UploadIcon, CopyIcon, MoreHorizontalIcon } from './icons.jsx';
import ActionSheet from './ActionSheet.jsx';
import type { ActionSheetItem } from './ActionSheet.jsx';
import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';

const DOC_EXT_RE = /\.(?:md|markdown|html|htm|txt|log|sh)$/i;

// A very full directory (thousands of files) is both slow to render every row and hard to scan.
// We render at most this many rows; when more match, a hint nudges the user to type into the path
// box (which live-filters the trailing fragment) to narrow down.
const MAX_ROWS = 300;

type DirectoryEntryType = 'dir' | 'doc' | 'image' | 'file';

interface DirectoryEntry {
  name: string;
  type: DirectoryEntryType;
  size?: number;
  mtimeMs?: number;
}

// Entries the "收起隐藏项" switch tucks away: dotfiles (`.git`, `.DS_Store`, `.env`) and the one heavy
// generated dir that is never dot-prefixed. Only well-known noise — a name like `dist` or `build` is
// often something the user actually wants to open. Default is OFF, so a folder lists as it is.
const isHiddenEntry = (name: string): boolean => name.startsWith('.') || name === 'node_modules';

interface DirectoryListing {
  path: string;
  home: string;
  roots?: string[];
  parent: string | null;
  entries: DirectoryEntry[];
}

interface TransferState {
  label: string;
  pct: number;
}

interface LoadOptions {
  sync?: boolean;
  notify?: boolean;
  fallbackHome?: boolean;
}

export interface FileBrowserProps {
  path?: string | null;
  onNavigate?: (path: string) => void;
  onOpenDoc: (path: string) => void;
  onJumpToCwd?: (() => void | Promise<void>) | null;
  pendingFile?: File | null;
  onPendingConsumed?: () => void;
  pickMode?: boolean;
  allowMkdir?: boolean;
  onPick?: (dir: string) => void | Promise<void>;
  pickDisabled?: boolean;
  refreshKey?: number;
  overlayActive?: boolean;
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const isEntryType = (value: unknown): value is DirectoryEntryType => (
  value === 'dir' || value === 'doc' || value === 'image' || value === 'file'
);

function parseDirectoryListing(value: unknown): DirectoryListing {
  const listing = recordOf(value);
  if (!listing
    || typeof listing.path !== 'string'
    || typeof listing.home !== 'string'
    || !(listing.parent === null || typeof listing.parent === 'string')
    || !Array.isArray(listing.entries)
    || !(listing.roots === undefined
      || (Array.isArray(listing.roots) && listing.roots.every((root) => typeof root === 'string')))) {
    throw new Error('Directory API returned an invalid listing');
  }
  const entries = listing.entries.map((value): DirectoryEntry => {
    const entry = recordOf(value);
    if (!entry
      || typeof entry.name !== 'string'
      || !isEntryType(entry.type)
      || !(entry.size === undefined || (typeof entry.size === 'number' && Number.isFinite(entry.size)))
      || !(entry.mtimeMs === undefined || (typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs)))) {
      throw new Error('Directory API returned an invalid entry');
    }
    return {
      name: entry.name,
      type: entry.type,
      ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
      ...(typeof entry.mtimeMs === 'number' ? { mtimeMs: entry.mtimeMs } : {}),
    };
  });
  return {
    path: listing.path,
    home: listing.home,
    ...(Array.isArray(listing.roots) ? { roots: listing.roots as string[] } : {}),
    parent: listing.parent,
    entries,
  };
}

// Split a typed path into its directory part (everything up to & including the last '/') and the
// trailing fragment the user is filtering by. "/a/b/c" → { dir:"/a/b/", frag:"c" };
// "/a/b/" → { dir:"/a/b/", frag:"" }; "foo" → { dir:"", frag:"foo" }.
export function splitPath(input: string): { dir: string; frag: string } {
  const i = input.lastIndexOf('/');
  if (i < 0) return { dir: '', frag: input };
  return { dir: input.slice(0, i + 1), frag: input.slice(i + 1) };
}

const stripSlash = (path: string): string => path.replace(/\/+$/, '') || '/';

// abs (under `root`) → root-relative; the root itself → ''.
const toRel = (abs: string, root: string | null | undefined): string => (
  abs === root ? '' : root && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs
);

// The allowed root (home or an extra root like /tmp) that contains `abs` — longest match wins.
// Falls back to `home` when nothing matches (or no roots were reported by an older server).
const rootOf = (
  abs: string | null | undefined,
  roots: readonly string[] | null | undefined,
  home: string | null | undefined,
): string | null => {
  let best: string | null = null;
  for (const root of roots || []) {
    if ((abs === root || abs?.startsWith(`${root}/`)) && (!best || root.length > best.length)) best = root;
  }
  return best || home || null;
};

// Row order. Directories always come first in both modes — that is the file-browser convention and
// it keeps navigation stable; within a group, "name" is A→Z and "modified" is newest-first. Entries
// whose stat failed have no mtime and sort last rather than jumping to the top under a 1970 date.
const sortEntries = (list: readonly DirectoryEntry[], mode: BrowserSort): DirectoryEntry[] => (
  [...list].sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1)
    || (mode === 'modified'
      ? (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)
      : a.name.localeCompare(b.name)))
);

// The path browser. CONTROLLED on the current directory: `path` is the dir to show (null → $HOME),
// and `onNavigate(absPath)` reports every directory change up to the parent, which persists it. That
// persistence is what lets the user open a file (which swaps in a doc tab) and come back to the SAME
// directory — on remount we reload `path` instead of resetting to $HOME.
//
// The server only ever serves paths under $HOME, so the box holds a HOME-RELATIVE path behind a
// fixed `~/` prefix rendered outside the input — the home part can't be edited or deleted away.
// Two-way bound within a directory: tapping a folder rewrites the path box; typing in the box
// refetches the named dir (debounced) and live-filters its entries by the trailing fragment. Tapping
// a file (or Enter on a doc path) opens it via onOpenDoc — always an absolute path.
export default function FileBrowser({
  path,
  onNavigate,
  onOpenDoc,
  onJumpToCwd,
  pendingFile,
  onPendingConsumed,
  pickMode = false,
  allowMkdir = !pickMode,
  onPick,
  pickDisabled = false,
  refreshKey = 0,
  overlayActive = true,
}: FileBrowserProps) {
  const [input, setInput] = useState('');   // the path text box — relative to the current root
  const [dir, setDir] = useState<DirectoryListing | null>(null); // loaded { path, parent, entries }
  const [sort, setSort] = useState<BrowserSort>(getBrowserSort); // row order (persisted): name | modified
  const [collapseHidden, setCollapseHidden] = useState<boolean>(getBrowserCollapseHidden); // see isHiddenEntry: off by default
  const [, setClock] = useState(0); // bumped every minute so the relative "3 分钟前" columns stay true
  const [rootMenuOpen, setRootMenuOpen] = useState(false); // the root-prefix dropdown (~ / tmp / TMPDIR)
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');     // transient, friendly hint (not an error) — fades on its own
  const [saved, setSaved] = useState('');        // last downloaded filename — persistent box w/ "打开下载目录" (null/'' = none)
  const [menuFor, setMenuFor] = useState<{ name: string; type: DirectoryEntryType } | null>(null); // row awaiting its ⋯ menu
  const [uploading, setUploading] = useState(false);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [progress, setProgress] = useState<TransferState | null>(null); // active transfer, else null
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadedRef = useRef<string | false>(false); // real path of the dir currently loaded (false = none yet)
  const refreshRef = useRef(refreshKey);    // last refreshKey acted on — a bump forces a re-fetch even if the path is unchanged
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootDdRef = useRef<HTMLDivElement | null>(null); // root-prefix dropdown container (for outside-tap close)

  const clearTimer = (timer: { current: ReturnType<typeof setTimeout> | null }): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  // Fetch a directory. sync=true (taps, ↑, restore) rewrites the box to the real path + trailing
  // slash; notify=true (user-driven navigation) reports the new real path so the parent persists it.
  const load = async (
    reqPath: string | null | undefined,
    { sync = false, notify = false, fallbackHome = false }: LoadOptions = {},
  ): Promise<void> => {
    setErr('');
    try {
      const d = parseDirectoryListing(await fetchDir(reqPath ?? undefined));
      loadedRef.current = d.path;
      setDir(d);
      if (sync) {
        // Box shows the path RELATIVE to whichever root we're in; the root itself is the dropdown prefix.
        const rel = toRel(d.path, rootOf(d.path, d.roots, d.home));
        setInput(rel ? `${rel}/` : '');
      }
      if (notify) { onNavigate?.(d.path); setMkdirOpen(false); setMkdirName(''); } // leaving this dir → drop a half-typed new-folder row
    } catch {
      if (fallbackHome && reqPath != null) { await load(null, { sync: true }); return; } // seeded dir gone → $HOME
      setErr(t('filebrowser.openDirFailed'));
    }
  };

  // Load on mount and whenever the persisted `path` changes from outside (restore on remount). Our
  // own navigations set loadedRef to the same value first, so this no-ops for them (no double fetch).
  useEffect(() => {
    // A refreshKey bump (panel reopened) forces a re-fetch even when `path` is unchanged — the sheet
    // stays mounted while minimized, so the guard below would otherwise keep the stale listing.
    const forced = refreshKey !== refreshRef.current;
    refreshRef.current = refreshKey;
    if (path === loadedRef.current && !forced) return;
    // sync (rewrite the box) but NOT notify: prop-driven loads (restore-on-remount, open-seed,
    // jump-to-cwd) must not report back — a notify here would let the initial null→$HOME load clobber
    // a just-seeded cwd via onNavigate, and persist $HOME over the window's real remembered dir.
    // Persistence happens only on USER navigation (enter/up/onType already pass notify:true).
    load(path, { sync: true, fallbackHome: pickMode });
  }, [path, refreshKey]);
  useEffect(() => () => { clearTimer(debounceRef); clearTimer(noticeTimerRef); }, []);
  // A relative timestamp only stays honest if something re-renders: the sheet stays mounted while
  // minimized, so without this a row opened at 09:00 still says "刚刚" at 09:30. Once a minute is
  // plenty for minute-granularity text.
  useEffect(() => {
    const timer = setInterval(() => setClock((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Close the root dropdown when a tap lands outside it (capture phase, like Dropdown.jsx).
  useEffect(() => {
    if (!rootMenuOpen) return undefined;
    const onDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !rootDdRef.current?.contains(event.target)) setRootMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [rootMenuOpen]);
  useBackButton(overlayActive && rootMenuOpen, () => setRootMenuOpen(false));
  useBackButton(overlayActive && !!menuFor, () => setMenuFor(null));
  useBackButton(overlayActive && mkdirOpen, () => { setMkdirOpen(false); setMkdirName(''); });

  // Friendly transient hint (e.g. unsupported preview) — distinct from the red error, fades on its own.
  const showNotice = (msg: string): void => {
    setNotice(msg);
    clearTimer(noticeTimerRef);
    noticeTimerRef.current = setTimeout(() => setNotice(''), 2500);
  };

  const onType = (val: string): void => {
    const home = dir?.home;
    if (!home) { setInput(val); return; }
    const roots = dir?.roots || [home];
    let v = val;
    if (v === '~' || v.startsWith('~/')) v = home + v.slice(1); // ~ → home absolute, folded below
    // The box is relative to a "base" root: the root an absolute path lives under (so pasting an
    // absolute path jumps roots), else the currently-shown root. Then v is made relative to it.
    let base = rootOf(dir?.path, roots, home) ?? home;
    if (v.startsWith('/')) {
      base = rootOf(v, roots, home) ?? home;
      v = v === base ? '' : v.startsWith(`${base}/`) ? v.slice(base.length + 1) : v.replace(/^\/+/, '');
    }
    setInput(v);
    const target = stripSlash(`${base}/${splitPath(v).dir}`); // '' dir part → the base root itself
    if (target === loadedRef.current) return; // same dir → pure client-side filter
    clearTimer(debounceRef);
    debounceRef.current = setTimeout(() => {
      if (target !== loadedRef.current) load(target, { notify: true });
    }, 250);
  };

  // Copy a file's absolute path to the clipboard (to paste into a terminal). On https the async
  // clipboard works inside this tap; if it's unavailable/blocked, show the path so it can be
  // long-pressed to copy by hand.
  const copyPath = async (name: string): Promise<void> => {
    if (!dir) return;
    const abs = joinPath(dir.path, name);
    try {
      await navigator.clipboard.writeText(abs);
      showNotice(t('filebrowser.copiedPath', { abs }));
    } catch {
      showNotice(abs);
    }
  };

  const open = (name: string): void => { if (dir) onOpenDoc(joinPath(dir.path, name)); };
  const enter = (name: string): void => { if (dir) void load(joinPath(dir.path, name), { sync: true, notify: true }); };
  const up = (): void => { if (dir?.parent) void load(dir.parent, { sync: true, notify: true }); };
  const submitMkdir = async (): Promise<void> => {
    const nm = mkdirName.trim();
    if (!nm || !dir) return;
    setErr('');
    try {
      await createDir(dir.path, nm);
      await load(dir.path, {}); // refresh listing so the new folder shows
      setMkdirOpen(false); setMkdirName('');
    } catch { setErr(t('filebrowser.mkdirFailed')); }
  };
  // Actual download — only reached from the row's ⋯ menu, and only after the download action has been
  // armed with a second tap there, so an accidental tap can't pull a file.
  const doDownload = async (name: string): Promise<void> => {
    if (!dir) return;
    setErr('');
    setProgress({ label: t('filebrowser.downloading', { name }), pct: 0 });
    try {
      await downloadFile(joinPath(dir.path, name), (pct) => setProgress({ label: t('filebrowser.downloading', { name }), pct }));
      setSaved(name);
    } catch { setErr(t('filebrowser.downloadFailed')); }
    finally { setProgress(null); }
  };
  // The per-row ⋯ menu: every entry can copy its path, and everything but a directory can download.
  // The sheet closes first so the transfer's progress bar isn't hidden behind it.
  const rowActions = (entry: { name: string; type: DirectoryEntryType }): ActionSheetItem[] => [
    {
      key: 'copy',
      label: t('filebrowser.copyAbsPath'),
      icon: <CopyIcon />,
      onClick: () => { setMenuFor(null); return copyPath(entry.name); },
    },
    ...(entry.type === 'dir' ? [] : [{
      key: 'download',
      label: t('filebrowser.download'),
      icon: <DownloadIcon />,
      confirm: true,
      confirmLabel: t('filebrowser.downloadConfirm', { name: entry.name }),
      onClick: () => { setMenuFor(null); return doDownload(entry.name); },
    }]),
  ];
  // The allowed roots the server reported (home + any extra roots like /tmp, $TMPDIR), and which one
  // the loaded dir currently sits in. Older servers omit `roots` → just home.
  const home = dir?.home;
  const roots = dir?.roots || (home ? [home] : []);
  const curRoot = rootOf(dir?.path, roots, home);
  // Friendly label for the root prefix: home → ~, the system temp dir → tmp, $TMPDIR → TMPDIR, else basename.
  const rootLabel = (root: string | null): string => (
    root === home ? '~'
      : !root ? '/'
        : /\/tmp$/.test(root) ? 'tmp'
          : root.includes('/var/folders/') ? 'TMPDIR'
            : (root.split('/').filter(Boolean).pop() || '/')
  );
  const goRoot = (root: string): void => {
    setRootMenuOpen(false);
    if (root !== curRoot) void load(root, { sync: true, notify: true });
  };

  // Upload is allowed into a non-hidden directory below an allowed root — but never the $HOME root
  // itself (don't litter the home dir); an extra root like /tmp IS uploadable directly. Mirrors the
  // server's resolveUploadDir so the button's disabled state matches. Hidden = a segment (relative
  // to the current root) starting with '.'.
  const relHasDot = (abs: string | null | undefined, root: string | null | undefined): boolean => {
    if (!abs || !root || abs === root) return false;
    const rel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
    return rel.split('/').some((segment) => segment.startsWith('.'));
  };
  const canUpload = !!dir && dir.path !== home && !relHasDot(dir.path, curRoot);
  // Upload one or more files into the current dir, sequentially (the server takes one file per
  // request). Accepts a single File or an array; returns the names that failed (empty = all ok).
  // With multiple files the progress label carries a (n/total) counter and a partial failure lists
  // the offenders; a single file keeps its specific server error (e.g. 文件过大).
  const doUpload = async (files: File | readonly File[] | FileList): Promise<string[]> => {
    const { allowed: list, rejected } = splitUploadable(files);
    if (!list.length) {
      if (rejected.length) setErr(t('filebrowser.uploadRejected', { names: rejected.join(t('common.listSeparator')) }));
      return rejected;
    }
    if (!dir) return [...list.map((file) => file.name), ...rejected];
    const firstFile = list[0];
    if (!firstFile) return rejected;
    setUploading(true);
    setErr('');
    const total = list.length;
    const failed: { name: string; reason: string }[] = [];
    // Active-transfer progress + Cancel live in the app-wide <UploadOverlay/> (uploadJob store); one
    // AbortController for the batch so Cancel aborts the in-flight file and breaks the loop. Download
    // keeps its own inline `progress` bar — only uploads move to the overlay.
    const ac = new AbortController();
    startUpload(ac, t('filebrowser.uploading', { name: firstFile.name, tag: total > 1 ? t('common.batchProgress', { done: 1, total }) : '' }));
    try {
      for (let i = 0; i < total; i++) {
        if (ac.signal.aborted) break;
        const file = list[i];
        if (!file) continue;
        const tag = total > 1 ? t('common.batchProgress', { done: i + 1, total }) : '';
        updateUpload({ label: t('filebrowser.uploading', { name: file.name, tag }), phase: 'sending', pct: 0 });
        try {
          await uploadFile(dir.path, file, (pct, phase) => updateUpload({ pct, phase }), false, { signal: ac.signal });
        } catch (e) {
          if (e instanceof UploadAbort) break;      // canceled → stop, keep already-uploaded files
          // Keep the specific reason (too large / bad type / …) so the error explains why, not just "failed".
          failed.push({ name: file.name, reason: e instanceof Error && e.message ? e.message : t('filebrowser.uploadFailed') });
        }
      }
    } finally {
      finishUpload();
    }
    await load(dir.path, {}); // refresh listing so the new files show
    setUploading(false);
    if (failed.length) setErr(failed.map((x) => t('common.nameWithReason', { name: x.name, reason: x.reason })).join(t('common.messageSeparator')));
    else if (rejected.length) setErr(t('filebrowser.uploadRejected', { names: rejected.join(t('common.listSeparator')) }));
    return [...failed.map((x) => x.name), ...rejected];
  };
  // A file shared in via the system share sheet (Web Share Target) → upload it to the CURRENT dir,
  // then clear it. Only clears on success, so a failure leaves it for a retry elsewhere.
  const uploadPending = async (): Promise<void> => {
    if (pendingFile && (await doUpload(pendingFile)).length === 0) onPendingConsumed?.();
  };

  // Enter on a path that names a doc → open it directly (input is home-relative).
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (pickMode || event.key !== 'Enter') return;
    const v = input.trim();
    if (v && DOC_EXT_RE.test(v) && dir?.home) onOpenDoc(joinPath(dir.home, v));
  };

  const all = dir?.entries || [];
  const visible = collapseHidden ? all.filter((e) => !isHiddenEntry(e.name)) : all;
  const frag = splitPath(input).frag.toLowerCase();
  const matched = visible.filter(
    (e) => (!pickMode || e.type === 'dir') && (!frag || e.name.toLowerCase().includes(frag)));
  // Sort BEFORE capping: with up to MAX_ROWS rows rendered, capping the server's order would hide the
  // very entries the chosen order puts first.
  const sorted = sortEntries(matched, sort);
  const entries = sorted.length > MAX_ROWS ? sorted.slice(0, MAX_ROWS) : sorted;
  const overflow = sorted.length - entries.length; // >0 when the listing was capped
  // Three different nothings: an empty directory, everything filtered as noise, nothing matching the
  // typed fragment. Saying "没有匹配" for an empty folder is what the old listing did.
  const emptyText = all.length === 0 ? t('filebrowser.emptyDir')
    : visible.length === 0 ? t('filebrowser.onlyHidden')
      : t('filebrowser.noMatches');

  const toggleSort = (): void => {
    const next: BrowserSort = sort === 'name' ? 'modified' : 'name';
    setSort(next);
    setBrowserSort(next);
  };
  const toggleCollapseHidden = (): void => {
    const next = !collapseHidden;
    setCollapseHidden(next);
    setBrowserCollapseHidden(next);
  };

  return (
    <div className="browse-view">
      <div className="browse-bar">
        {onJumpToCwd && (
          <button className="browse-cwd" aria-label={t('filebrowser.sessionDir')} title={t('filebrowser.jumpToSessionDir')} onClick={onJumpToCwd}>
            <LocateIcon />
          </button>
        )}
        <button className="browse-up" aria-label={t('filebrowser.parentDir')} disabled={!dir?.parent} onClick={up}>
          <ArrowUpIcon />
        </button>
        <div className="browse-path">
          {/* The fixed root prefix. With extra roots (e.g. /tmp) it's a dropdown to switch root; the
              home "~" can't be typed away either way. The box always holds a path RELATIVE to it. */}
          {roots.length > 1 ? (
            <div className="dd browse-root-dd" ref={rootDdRef}>
              <button
                type="button" className="browse-root" aria-haspopup="listbox" aria-expanded={rootMenuOpen}
                aria-label={t('filebrowser.rootSelect')} onClick={() => setRootMenuOpen((o) => !o)}
              >
                <span>{rootLabel(curRoot)}/</span>
                <span className={`dd-caret${rootMenuOpen ? ' open' : ''}`} aria-hidden="true">▾</span>
              </button>
              {rootMenuOpen && (
                <div className="dd-menu" role="listbox">
                  {roots.map((r) => (
                    <button
                      key={r} type="button" role="option" aria-selected={r === curRoot} title={r}
                      className={`dd-option${r === curRoot ? ' is-selected' : ''}`} onClick={() => goRoot(r)}
                    >
                      <span className="dd-option-label">{rootLabel(r)}/</span>
                      {r === curRoot && <span className="dd-check" aria-hidden="true">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <span className="browse-home" aria-hidden="true">~/</span>
          )}
          <input
            className="browse-input" value={input} placeholder={t('filebrowser.pathPlaceholder')}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={(e) => onType(e.target.value)} onKeyDown={onKeyDown}
          />
        </div>
        {allowMkdir && (
          <button
            className="browse-mkdir" aria-label={t('filebrowser.newFolder')} title={t('filebrowser.newFolder')}
            disabled={!dir}
            onClick={() => { setMkdirOpen((v) => !v); setMkdirName(''); }}
          >
            <FolderPlusIcon />
          </button>
        )}
        {!pickMode && (
          <button
            className="browse-upload"
            aria-label={t('filebrowser.uploadFile')}
            title={canUpload ? t('filebrowser.uploadToCurrentDir') : t('filebrowser.enterSubdirToUpload')}
            disabled={!canUpload || uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadIcon />
          </button>
        )}
        {/* Off-screen (NOT hidden/display:none) so a programmatic .click() reliably opens the native
            file picker on iOS Safari — see .browse-file-input in styles.css. */}
        {!pickMode && (
          <input
            ref={fileInputRef}
            className="browse-file-input"
            type="file"
            multiple
            accept={UPLOAD_ACCEPT}
            onChange={(e) => { doUpload(Array.from(e.target.files || [])); e.target.value = ''; }}
          />
        )}
      </div>
      {mkdirOpen && (
        <div className="browse-newfolder">
          <input
            className="browse-newfolder-input" autoFocus value={mkdirName}
            placeholder={t('filebrowser.folderNamePlaceholder')} autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={(e) => setMkdirName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitMkdir(); }}
          />
          <button className="browse-newfolder-ok" onClick={submitMkdir}>{t('filebrowser.createBtn')}</button>
          <button className="browse-newfolder-x" aria-label={t('common.cancel')} onClick={() => { setMkdirOpen(false); setMkdirName(''); }}>✕</button>
        </div>
      )}
      {!pickMode && pendingFile && (
        <div className="browse-pending">
          <span className="browse-pending-text">
            {t('filebrowser.uploadPendingTo', { name: pendingFile.name })}
            {!canUpload && <em className="browse-pending-hint">{t('filebrowser.enterSubdirFirst')}</em>}
          </span>
          <button className="browse-pending-btn" disabled={!canUpload || uploading} onClick={uploadPending}>{t('filebrowser.upload')}</button>
        </div>
      )}
      {err && <div className="bind-error browse-err">{err}</div>}
      {notice && <div className="browse-notice">{notice}</div>}
      {!pickMode && saved && (
        <div className="browse-saved">
          <span className="browse-saved-text">{t('filebrowser.savedToDownloads', { name: saved })}</span>
          <button className="browse-saved-close" aria-label={t('common.close')} onClick={() => setSaved('')}>×</button>
        </div>
      )}
      {!pickMode && progress && (
        <div className="browse-progress">
          <span className="browse-progress-label">{progress.label} {Math.round(progress.pct * 100)}%</span>
          <span className="browse-progress-track">
            <span className="browse-progress-fill" style={{ width: `${Math.round(progress.pct * 100)}%` }} />
          </span>
        </div>
      )}
      {/* List bar: how much is here (and, when a listing is capped, how much of it you are seeing),
          then what is hidden — with the sort control parked on the right. */}
      {all.length > 0 && (
        <div className="browse-listbar">
          <span className="browse-count">
            {overflow > 0
              ? t('filebrowser.tooMany', { shown: entries.length, total: sorted.length })
              : t('filebrowser.itemCount', { count: sorted.length })}
          </span>
          <span className="browse-actions">
            <button className="browse-chip" aria-pressed={collapseHidden} onClick={toggleCollapseHidden}>
              {t('filebrowser.collapseHidden')}
            </button>
            {visible.length > 1 && (
              <button className="browse-chip browse-chip-sort" onClick={toggleSort}>
                <ArrowUpDownIcon />
                {t(sort === 'name' ? 'filebrowser.sortName' : 'filebrowser.sortModified')}
              </button>
            )}
          </span>
        </div>
      )}
      <div className="browse-list" aria-busy={!dir && !err}>
        {!dir && !err && (
          <div className="browse-skeleton" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className="browse-skeleton-row" />)}
          </div>
        )}
        {dir && entries.length === 0 && !err && <div className="browse-empty">{emptyText}</div>}
        {entries.map((e) => {
          const time = formatRelativeTime(e.mtimeMs);
          const size = e.type === 'dir' ? '' : formatBytes(e.size, '');
          return (
            <div key={e.name} className="browse-entry-row">
              <button
                className="browse-entry"
                onClick={() => (
                  e.type === 'dir' ? enter(e.name)
                    : (e.type === 'doc' || e.type === 'image') ? open(e.name)
                      : showNotice(t('filebrowser.previewUnsupported'))
                )}
              >
                <span className="browse-entry-icon">{e.type === 'dir' ? <FolderIcon /> : e.type === 'image' ? <ImageIcon /> : e.type === 'doc' ? <FileTextIcon /> : <FileIcon />}</span>
                <span className="browse-entry-name">{e.name}</span>
                {(time || size) && (
                  <span className="browse-entry-meta">
                    {size && <span className="browse-entry-size">{size}</span>}
                    {time && <span className="browse-entry-time">{time}</span>}
                  </span>
                )}
              </button>
              {/* One ⋯ per row, whatever the kind: it keeps the row's right edge identical for a
                  directory and a file (so the time/size columns line up) and holds the actions that
                  differ by kind — copy path for anything, download as well for a file. */}
              {!pickMode && (
                <button
                  className="browse-more" aria-label={t('filebrowser.rowActions', { name: e.name })}
                  aria-haspopup="dialog" onClick={() => setMenuFor({ name: e.name, type: e.type })}
                >
                  <MoreHorizontalIcon />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {pickMode && dir && (
        <div className="browse-pick-bar">
          <button className="browse-pick-confirm" disabled={pickDisabled}
            onClick={() => onPick?.(dir.path)}>
            {t('filebrowser.pickThisDir', { path: toRel(dir.path, dir.home) ? `~/${toRel(dir.path, dir.home)}` : '~' })}
          </button>
        </div>
      )}
      <ActionSheet
        open={!!menuFor}
        title={menuFor?.name ?? ''}
        actions={menuFor ? rowActions(menuFor) : []}
        onClose={() => setMenuFor(null)}
      />
    </div>
  );
}
