import AuthFrame from './AuthFrame.js';
import { t } from '../i18n';

/** Shown after an authenticated request is rejected because this browser used an untrusted origin. */
export default function OriginRejectedPrompt({ onRetry }: { onRetry: () => void }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return <AuthFrame title={t('auth.originRejectedTitle')} showHelp={false}>
    <section className="token-prompt auth-origin-prompt" aria-live="polite">
      <p className="auth-origin-summary">{t('auth.originRejected')}</p>
      <div className="auth-origin-options">
        <div className="auth-origin-option"><strong>{t('auth.originRejectedOpenLabel')}</strong><span>{t('auth.originRejectedOpenHint')}</span></div>
        <div className="auth-origin-option"><strong>{t('auth.originRejectedRegisterLabel')}</strong>{origin && <code className="auth-origin-command">handmux auth trusted-origin set {origin}</code>}</div>
      </div>
      <button type="button" className="auth-primary" onClick={onRetry}>{t('auth.retry')}</button>
    </section>
  </AuthFrame>;
}
