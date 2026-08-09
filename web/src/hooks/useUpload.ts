import { useState, useRef, useEffect } from 'react';
import { uploadFile, UnauthorizedError, UploadAbort } from '../api.js';
import { startUpload, updateUpload, finishUpload } from '../uploadJob.js';
import { splitUploadable } from '../uploadTypes.js';
import { t } from '../i18n';
import type { UploadPhase } from '../uploadJob.js';

export interface UploadNote {
  label: string;
  error?: boolean;
}

export interface UseUploadOptions {
  cwd?: string | null;
  onAuthFail?: () => void;
  onPaths: (paths: string[]) => void;
}

export interface UploadController {
  upload: UploadNote | null;
  uploadFiles: (files: File[]) => Promise<void>;
}

interface FailedUpload {
  name: string;
  reason: string;
}

const responsePath = (value: unknown): string | null => (
  value !== null && typeof value === 'object'
    && 'path' in value && typeof value.path === 'string'
    ? value.path
    : null
);

// The dock's ＋ multi-select upload pipeline, lifted out of BottomDock verbatim. It owns only the transient
// post-run note state (`upload` = { label, pct, error } | null) and its auto-dismiss timer; the active-
// transfer progress lives in the app-wide UploadOverlay (uploadJob store). Deliberately independent of the
// dock's gesture/keyboard/composer state machine — composer integration is one callback, `onPaths(paths[])`,
// which BottomDock implements (append the uploaded absolute paths into the box). `cwd` = the pane's dir the
// files land under; `onAuthFail` bubbles a 401.
export function useUpload({ cwd, onAuthFail, onPaths }: UseUploadOptions): UploadController {
  const [upload, setUpload] = useState<UploadNote | null>(null);
  const upTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearUploadTimer = (): void => {
    if (upTimerRef.current !== null) clearTimeout(upTimerRef.current);
    upTimerRef.current = null;
  };
  useEffect(() => () => clearUploadTimer(), []); // 卸载时清掉上传提示自动消失的定时器

  // ＋ upload: native multi-select → upload each file sequentially into this cwd's space under
  // ~/.handmux/uploads (server creates it; kept out of the project tree so nothing gets committed).
  // Progress shows per-file with an (n/total) counter; a partial failure leaves a red note that
  // self-clears. Succeeded paths (absolute) get pasted into the box via onPaths.
  const uploadFiles = async (files: File[]): Promise<void> => {
    const { allowed: list, rejected } = splitUploadable(files);
    if (!list.length) {
      if (rejected.length) {
        clearUploadTimer();
        setUpload({ label: t('dock.upload.rejected', { names: rejected.join('、') }), error: true });
        upTimerRef.current = setTimeout(() => setUpload(null), 3500);
      }
      return;
    }
    clearUploadTimer();
    setUpload(null);                                  // the inline note is only for post-run errors now
    const total = list.length;
    const paths: string[] = [];
    const failed: FailedUpload[] = [];
    // One AbortController for the whole batch → the overlay's Cancel aborts the in-flight file and we
    // break out of the loop. Active-transfer feedback lives in the app-wide overlay (uploadJob store).
    const ac = new AbortController();
    startUpload(ac, t('dock.upload.progress', { name: list[0].name, tag: total > 1 ? `（1/${total}）` : '' }));
    try {
      for (let i = 0; i < total; i++) {
        if (ac.signal.aborted) break;
        const f = list[i];
        const tag = total > 1 ? `（${i + 1}/${total}）` : '';
        updateUpload({ label: t('dock.upload.progress', { name: f.name, tag }), phase: 'sending', pct: 0 });
        try {
          const response: unknown = await uploadFile(
            cwd || '',
            f,
            (pct: number, phase: UploadPhase) => updateUpload({ pct, phase }),
            true,
            { signal: ac.signal },
          );
          const path = responsePath(response);
          if (path) paths.push(path);
        } catch (error: unknown) {
          if (error instanceof UploadAbort) break;      // user canceled → stop the batch, keep done files
          if (error instanceof UnauthorizedError) { onAuthFail?.(); finishUpload(); setUpload(null); return; }
          // Keep the SPECIFIC reason (uploadFile maps it: too large / bad type / …) so the note explains why.
          failed.push({
            name: f.name,
            reason: error instanceof Error && error.message ? error.message : t('api.uploadFailed'),
          });
        }
      }
    } finally {
      finishUpload();
    }
    if (paths.length) onPaths(paths);
    if (failed.length || rejected.length) {
      // Each failure carries its own reason (name：why); rejected types keep their one-line note.
      const parts = failed.map((x) => `${x.name}：${x.reason}`);
      if (rejected.length) parts.push(t('dock.upload.rejected', { names: rejected.join('、') }));
      setUpload({ label: parts.join('；'), error: true });
      upTimerRef.current = setTimeout(() => setUpload(null), 5000);
    } else {
      setUpload(null);
    }
  };

  return { upload, uploadFiles };
}
