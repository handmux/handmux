import { useEffect, useRef, useState } from 'react';
import type { ComponentType, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { fetchDir, downloadFile, uploadFile, createDir, UploadAbort } from '../api.js';
import { startUpload, updateUpload, finishUpload } from '../uploadJob.js';
import { UPLOAD_ACCEPT, splitUploadable } from '../uploadTypes.js';
import { joinPath } from '../docPath.js';
import { FolderIcon, FileIcon, ImageIcon, ArrowUpIcon, DownloadIcon, LocateIcon, FolderPlusIcon, UploadIcon, CopyIcon } from './icons.jsx';
import ActionSheet from './ActionSheet.jsx';
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
}

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

interface FileActionSheetProps {
  open: boolean;
  title: string;
  actions: { key: string; label: string; onClick: () => void }[];
  onClose: () => void;
}

// ActionSheet remains JSX in this migration stage; isolate its inferred `never[]` default here.
const FileActionSheet = ActionSheet as unknown as ComponentType<FileActionSheetProps>;

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
      || !(entry.size === undefined || (typeof entry.size === 'number' && Number.isFinite(entry.size)))) {
      throw new Error('Directory API returned an invalid entry');
    }
    return { name: entry.name, type: entry.type, size: entry.size as number | undefined };
  });
  return {
    path: listing.path,
    home: listing.home,
    roots: listing.roots as string[] | undefined,
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

// Bytes → short human string. <1KB shows bytes; KB rounded; MB to 1 decimal.
const fmtSize = (size: number | null | undefined): string => (
  size == null ? '' : size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
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
  refreshKey = 0,
  overlayActive = true,
}: FileBrowserProps) {
  const [input, setInput] = useState('');   // the path text box — relative to the current root
  const [dir, setDir] = useState<DirectoryListing | null>(null); // loaded { path, parent, entries }
  const [rootMenuOpen, setRootMenuOpen] = useState(false); // the root-prefix dropdown (~ / tmp / TMPDIR)
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');     // transient, friendly hint (not an error) — fades on its own
  const [saved, setSaved] = useState('');        // last downloaded filename — persistent box w/ "打开下载目录" (null/'' = none)
  const [confirmName, setConfirmName] = useState<string | null>(null); // file awaiting download confirmation (null = no sheet)
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
  useBackButton(overlayActive && !!confirmName, () => setConfirmName(null));
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
  // Actual download — only reached after the user confirms in the ActionSheet (never directly from a
  // row tap), so an accidental tap can't pull a file.
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
  const confirmDownload = (): void => {
    const name = confirmName;
    setConfirmName(null);
    if (name) void doDownload(name);
  };
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
      if (rejected.length) setErr(t('filebrowser.uploadRejected', { names: rejected.join('、') }));
      return rejected;
    }
    if (!dir) return [...list.map((file) => file.name), ...rejected];
    setUploading(true);
    setErr('');
    const total = list.length;
    const failed: { name: string; reason: string }[] = [];
    // Active-transfer progress + Cancel live in the app-wide <UploadOverlay/> (uploadJob store); one
    // AbortController for the batch so Cancel aborts the in-flight file and breaks the loop. Download
    // keeps its own inline `progress` bar — only uploads move to the overlay.
    const ac = new AbortController();
    startUpload(ac, t('filebrowser.uploading', { name: list[0].name, tag: total > 1 ? `（1/${total}）` : '' }));
    try {
      for (let i = 0; i < total; i++) {
        if (ac.signal.aborted) break;
        const file = list[i];
        const tag = total > 1 ? `（${i + 1}/${total}）` : '';
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
    if (failed.length) setErr(failed.map((x) => `${x.name}：${x.reason}`).join('；'));
    else if (rejected.length) setErr(t('filebrowser.uploadRejected', { names: rejected.join('、') }));
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

  const frag = splitPath(input).frag.toLowerCase();
  const matched = (dir?.entries || []).filter(
    (e) => (!pickMode || e.type === 'dir') && (!frag || e.name.toLowerCase().includes(frag)));
  const entries = matched.length > MAX_ROWS ? matched.slice(0, MAX_ROWS) : matched;
  const overflow = matched.length - entries.length; // >0 when the listing was capped

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
      <div className="browse-list">
        {entries.length === 0 && !err && <div className="browse-empty">{t('filebrowser.noMatches')}</div>}
        {entries.map((e) => (
          <div key={e.name} className="browse-entry-row">
            <button
              className="browse-entry"
              onClick={() => (
                e.type === 'dir' ? enter(e.name)
                  : (e.type === 'doc' || e.type === 'image') ? open(e.name)
                    : showNotice(t('filebrowser.previewUnsupported'))
              )}
            >
              <span className="browse-entry-icon">{e.type === 'dir' ? <FolderIcon /> : e.type === 'image' ? <ImageIcon /> : <FileIcon />}</span>
              <span className="browse-entry-name">{e.name}</span>
              {e.type !== 'dir' && <span className="browse-entry-size">{fmtSize(e.size)}</span>}
            </button>
            {e.type !== 'dir' && (
              <button className="browse-copy" aria-label={t('filebrowser.copyAbsPath')} title={t('filebrowser.copyAbsPath')} onClick={() => copyPath(e.name)}>
                <CopyIcon />
              </button>
            )}
            {e.type !== 'dir' && (
              <button className="browse-dl" aria-label={t('filebrowser.download')} onClick={() => setConfirmName(e.name)}>
                <DownloadIcon />
              </button>
            )}
          </div>
        ))}
        {overflow > 0 && (
          <div className="browse-overflow">{t('filebrowser.tooMany', { shown: entries.length, total: matched.length })}</div>
        )}
      </div>
      {pickMode && dir && (
        <div className="browse-pick-bar">
          <button className="browse-pick-confirm" onClick={() => onPick?.(dir.path)}>
            {t('filebrowser.pickThisDir', { path: toRel(dir.path, dir.home) ? `~/${toRel(dir.path, dir.home)}` : '~' })}
          </button>
        </div>
      )}
      <FileActionSheet
        open={!!confirmName}
        title={confirmName ? t('filebrowser.downloadConfirm', { name: confirmName }) : ''}
        actions={[{ key: 'dl', label: t('filebrowser.download'), onClick: confirmDownload }]}
        onClose={() => setConfirmName(null)}
      />
    </div>
  );
}
