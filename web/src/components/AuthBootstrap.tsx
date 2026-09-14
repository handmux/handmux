import { useEffect, useState, type ReactNode } from 'react';
import { applyAuthStatus, authRequest, normalizeAuthStatus } from '../authSession.js';
import { t } from '../i18n';
import AuthFrame from './AuthFrame.js';

// Resolve the server's fixed mode before mounting anything that can send a saved legacy token.
export default function AuthBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void authRequest().then((status) => {
      if (!active) return;
      // `authenticated` also covers a pairing candidate for compatibility. Do not mount the app as
      // logged in until a formal device cookie or an explicitly accepted fixed Token is present.
      applyAuthStatus(normalizeAuthStatus(status));
      setReady(true);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [retry]);
  if (ready) return children;
  return <AuthFrame title={t('auth.connecting')}><section className="token-prompt" aria-live="polite">
    <p>{t(failed ? 'auth.connectionError' : 'common.loading')}</p>
    {failed && <button onClick={() => setRetry((value) => value + 1)}>{t('auth.retry')}</button>}
  </section></AuthFrame>;
}
