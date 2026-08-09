import { useSyncExternalStore } from 'react';

export type UploadPhase = 'sending' | 'processing' | null;

export interface UploadJobState {
  active: boolean;
  phase: UploadPhase;
  pct: number;
  label: string;
}

// A single app-wide upload job. Uploads are exclusive (the ＋ button disables while one runs), so one
// slot suffices. <UploadOverlay/> (mounted once in App) subscribes; BottomDock / FileBrowser drive it
// via start/update/finish. `controller` is the batch AbortController so the overlay's Cancel can abort
// the in-flight request AND let the caller's loop break out.
const IDLE: UploadJobState = { active: false, phase: null, pct: 0, label: '' };
let state: UploadJobState = IDLE;
let controller: AbortController | null = null;
const subs = new Set<() => void>();
const emit = (): void => { for (const subscriber of [...subs]) subscriber(); };

export function startUpload(abortController: AbortController, label = ''): void {
  controller = abortController;
  state = { active: true, phase: 'sending', pct: 0, label };
  emit();
}
export function updateUpload(patch: Partial<UploadJobState>): void { state = { ...state, ...patch }; emit(); }
export function finishUpload(): void { controller = null; state = IDLE; emit(); }
export function cancelUpload(): void { controller?.abort(); }   // → xhr.onabort rejects with UploadAbort

const subscribe = (callback: () => void): (() => void) => {
  subs.add(callback);
  return () => { subs.delete(callback); };
};
const getSnapshot = (): UploadJobState => state;
export function useUploadJob(): UploadJobState { return useSyncExternalStore(subscribe, getSnapshot); }
