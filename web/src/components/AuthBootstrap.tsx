import { useEffect, useState, type ReactNode } from 'react';
import { applyAuthStatus, authRequest, AuthRequestError } from '../authSession.js';
import { t } from '../i18n';
import OriginRejectedPrompt from './OriginRejectedPrompt.js';
import DevicePairingPrompt from './DevicePairingPrompt.js';

// Shown only while the server has not yet said whether this origin needs authentication (and when that
// question could not be asked at all). It deliberately carries NO authentication chrome — no brand, no card,
// no mode: rendering the auth frame here made a slow first paint look like a login screen flashing by, with
// its brand image still in flight (an empty logo). The auth screens belong to a decided state.
function AuthPending({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return <main className="auth-pending">
    {failed ? <>
      <p>{t('auth.connectionError')}</p>
      <button type="button" onClick={onRetry}>{t('auth.retry')}</button>
    </> : <span className="spinner" role="status" aria-label={t('common.loading')} />}
  </main>;
}

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
  return <AuthPending failed={failed} onRetry={() => setRetry((value) => value + 1)} />;
}
