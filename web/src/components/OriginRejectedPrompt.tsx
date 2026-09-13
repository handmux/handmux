import AuthFrame from './AuthFrame.js';
import { t } from '../i18n';

/** Shown after an authenticated request is rejected because this browser used an untrusted origin. */
export default function OriginRejectedPrompt({ onRetry, onAuthorize }: { onRetry: () => void; onAuthorize: () => void }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return <AuthFrame title={t('auth.originRejectedTitle')} showHelp={false}>
    <section className="token-prompt auth-origin-prompt" aria-live="polite">
      <p className="auth-origin-summary">{t('auth.originRejectedAddress', { origin })}</p>
      <div className="auth-origin-options">
        <div className="auth-origin-option"><strong>{t('auth.originRejectedOpenLabel')}</strong><span>{t('auth.originRejectedOpenHint')}</span></div>
        <div className="auth-origin-option auth-origin-authorize">
          <strong>{t('auth.originRejectedAuthorizeLabel')}</strong>
          <span>{t('auth.originRejectedAuthorizeHint')}</span>
          <button type="button" className="auth-primary" onClick={onAuthorize}>{t('auth.originRejectedAuthorizeButton')}</button>
        </div>
      </div>
      <button type="button" className="auth-origin-retry" onClick={onRetry}>{t('auth.originRejectedRetry')}</button>
    </section>
  </AuthFrame>;
}
