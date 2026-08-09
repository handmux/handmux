import { useUploadJob, cancelUpload } from '../uploadJob.js';
import { t } from '../i18n';
import { useEscapeLayer } from '../hooks/useEscapeLayer.js';
import { OverlayPortal } from '../overlays/OverlayHost.js';

// App-wide upload lock: while a file is uploading, a full-screen backdrop swallows every tap so the
// user can't stumble into other actions mid-transfer — the ONLY control is Cancel. Two phases:
// 'sending' shows a real % bar (bytes leaving the browser); once the body is flushed it flips to
// 'processing' — an indeterminate spinner labelled "receiving on server", because past 100%-sent the
// remaining wait (server write + response, often behind nginx/a tunnel) has nothing left to measure.
export default function UploadOverlay() {
  const job = useUploadJob();
  useEscapeLayer(job.active, cancelUpload);
  if (!job.active) return null;
  const sending = job.phase === 'sending';
  const pct = Math.round((job.pct || 0) * 100);
  return (
    <OverlayPortal>
      <div className="upload-overlay" role="alertdialog" aria-modal="true" aria-label={t('upload.title')}>
        <div className="upload-card">
          {job.label && <div className="upload-card-label">{job.label}</div>}
          {sending ? (
            <>
              <div className="upload-bar"><div className="upload-bar-fill" style={{ width: `${pct}%` }} /></div>
              <div className="upload-card-sub">{pct}%</div>
            </>
          ) : (
            <>
              <div className="upload-spinner" aria-hidden="true" />
              <div className="upload-card-sub">{t('upload.processing')}</div>
            </>
          )}
          <button type="button" className="upload-cancel" onClick={cancelUpload}>{t('common.cancel')}</button>
        </div>
      </div>
    </OverlayPortal>
  );
}
