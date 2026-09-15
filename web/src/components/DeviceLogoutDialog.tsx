import { useRef } from 'react';
import { useModalFocusTrap } from '../hooks/useModalFocusTrap.js';
import { useBackButton } from '../hooks/useBackButton.js';
import { t } from '../i18n';

export default function DeviceLogoutDialog({ busy, error, onClose, onConfirm }: {
  busy: boolean; error: string; onClose: () => void; onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const close = () => { if (!busy) onClose(); };
  useBackButton(true, close);
  useModalFocusTrap({
    active: true, dialogRef, initialFocusRef: cancelRef, returnFocusRef: triggerRef,
    onClose: close,
  });
  return <div className="auth-logout-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialogRef} className="auth-logout-dialog" role="alertdialog" aria-modal="true" aria-labelledby="auth-logout-title" aria-describedby="auth-logout-description" tabIndex={-1}>
      <h3 id="auth-logout-title">{t('auth.logoutTitle')}</h3>
      <p id="auth-logout-description">{t('auth.logoutDescription')}</p>
      {error && <p role="alert">{error}</p>}
      <div className="auth-logout-actions">
        <button type="button" ref={cancelRef} disabled={busy} onClick={close}>{t('common.cancel')}</button>
        <button type="button" disabled={busy} onClick={onConfirm}>{t(busy ? 'common.loading' : 'auth.logoutTitle')}</button>
      </div>
    </section>
  </div>;
}
