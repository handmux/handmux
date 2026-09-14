import { useEffect, useState, type ReactNode } from 'react';
import { applyAuthStatus, authRequest, AuthRequestError } from '../authSession.js';
import { t } from '../i18n';
import AuthFrame from './AuthFrame.js';
import OriginRejectedPrompt from './OriginRejectedPrompt.js';
import DevicePairingPrompt from './DevicePairingPrompt.js';

// Resolve the server's current authentication policy before mounting protected content.
export default function AuthBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [authorizeOrigin, setAuthorizeOrigin] = useState(false);
  const [originRejected, setOriginRejected] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    setErrorCode(null);
    setOriginRejected(false);
    void authRequest().then((status) => {
      if (!active) return;
      applyAuthStatus(status);
      if (status.originTrusted === false) { setOriginRejected(true); return; }
      setReady(true);
    }).catch((error) => { if (active) { setErrorCode(error instanceof AuthRequestError ? error.code : null); setFailed(true); } });
    return () => { active = false; };
  }, [retry]);
  if (ready) return children;
  if (authorizeOrigin) return <DevicePairingPrompt onSaved={() => { setAuthorizeOrigin(false); setReady(true); }} />;
  if (originRejected) return <OriginRejectedPrompt onRetry={() => setRetry((value) => value + 1)} onAuthorize={() => setAuthorizeOrigin(true)} />;
  if (failed && errorCode === 'AUTH_ORIGIN_REJECTED') return <OriginRejectedPrompt onRetry={() => setRetry((value) => value + 1)} onAuthorize={() => setAuthorizeOrigin(true)} />;
  return <AuthFrame title={t('auth.connecting')} showHelp={false}><section className="token-prompt" aria-live="polite">
    <p>{t(failed && errorCode === 'AUTH_ORIGIN_REJECTED' ? 'auth.originRejected' : failed ? 'auth.connectionError' : 'common.loading')}</p>
    {failed && <button onClick={() => setRetry((value) => value + 1)}>{t('auth.retry')}</button>}
  </section></AuthFrame>;
}
