import { useRef } from 'react';
import { useModalFocusTrap } from '../hooks/useModalFocusTrap.js';
import { t } from '../i18n';

export default function DeviceLogoutDialog({ busy, error, onClose, onConfirm }: {
  busy: boolean; error: string; onClose: () => void; onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useModalFocusTrap({
    active: true, dialogRef, initialFocusRef: cancelRef, returnFocusRef: triggerRef,
    onClose: () => { if (!busy) onClose(); },
  });
  return <div className="auth-logout-backdrop" role="presentation">
    <section ref={dialogRef} className="auth-logout-dialog" role="alertdialog" aria-modal="true" aria-labelledby="auth-logout-title" aria-describedby="auth-logout-description" tabIndex={-1}>
      <h3 id="auth-logout-title">{t('auth.logoutTitle')}</h3>
      <p id="auth-logout-description">{t('auth.logoutDescription')}</p>
      {error && <p role="alert">{error}</p>}
      <div className="auth-logout-actions">
        <button ref={cancelRef} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        <button disabled={busy} onClick={onConfirm}>{t(busy ? 'common.loading' : 'auth.logoutTitle')}</button>
      </div>
    </section>
  </div>;
}
