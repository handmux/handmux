import { useEffect, useState, type ReactNode } from 'react';
import { applyAuthStatus, authRequest, AuthRequestError } from '../authSession.js';
import { t } from '../i18n';
import AuthFrame from './AuthFrame.js';

// Resolve the server's fixed mode before mounting anything that can send a saved legacy token.
export default function AuthBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    setErrorCode(null);
    void authRequest().then((status) => {
      if (!active) return;
      applyAuthStatus(status);
      setReady(true);
    }).catch((error) => { if (active) { setErrorCode(error instanceof AuthRequestError ? error.code : null); setFailed(true); } });
    return () => { active = false; };
  }, [retry]);
  if (ready) return children;
  return <AuthFrame title={t('auth.connecting')} showHelp={false}><section className="token-prompt" aria-live="polite">
    <p>{t(failed && errorCode === 'AUTH_ORIGIN_REJECTED' ? 'auth.originRejected' : failed ? 'auth.connectionError' : 'common.loading')}</p>
    {failed && <button onClick={() => setRetry((value) => value + 1)}>{t('auth.retry')}</button>}
  </section></AuthFrame>;
}
