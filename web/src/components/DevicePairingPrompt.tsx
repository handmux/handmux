import { useCallback, useEffect, useRef, useState } from 'react';
import { applyAuthStatus, authRequest, AuthRequestError, type AuthStatus } from '../authSession.js';
import { t } from '../i18n';
import TokenPrompt from './TokenPrompt.js';
import AuthFrame from './AuthFrame.js';

const errorCopy = (error: unknown) => t(error instanceof AuthRequestError && error.status === 429
  ? 'auth.rateLimit' : error instanceof AuthRequestError && error.code === 'TOKEN_REQUIRED'
    ? 'auth.tokenRequired' : error instanceof AuthRequestError && error.code === 'AUTH_ORIGIN_REJECTED'
      ? 'auth.originRejected' : 'auth.connectionError');

const needsPairing = (status: AuthStatus): boolean => status.mode === 'trusted-device'
  && !status.authenticated
  && (status.tokenEnabled !== true || status.tokenAuthenticated === true)
  && !status.pairing;

export default function DevicePairingPrompt({ onSaved }: { onSaved: () => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [copyHint, setCopyHint] = useState('');
  const [now, setNow] = useState(Date.now());
  const offset = useRef(0);
  const epoch = useRef(0);
  const active = useRef(true);
  const changing = useRef(false);
  const saved = useRef(onSaved);
  saved.current = onSaved;
  const codeText = useRef<HTMLElement>(null);
  const copyScope = useRef('');
  const requestRef = useRef<(method?: 'GET' | 'POST' | 'DELETE') => Promise<void>>(async () => {});

  const accept = useCallback((next: AuthStatus) => {
    offset.current = next.serverTime - Date.now();
    setNow(next.serverTime);
    setStatus(next);
    const nextScope = `${next.pairing?.id}:${next.pairing?.state}:${next.pairing?.code}`;
    if (copyScope.current !== nextScope) { copyScope.current = nextScope; setCopyHint(''); }
    applyAuthStatus(next);
    if (next.authenticated) saved.current();
  }, []);

  const request = useCallback(async (method: 'GET' | 'POST' | 'DELETE' = 'GET'): Promise<void> => {
    const generation = ++epoch.current;
    changing.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await authRequest('/api/auth/pairing', method, method === 'DELETE' ? status?.pairing?.id : undefined);
      if (active.current && generation === epoch.current) {
        accept(next);
        if (method === 'GET' && needsPairing(next)) void requestRef.current('POST');
      }
    } catch (requestError) {
      if (active.current && generation === epoch.current) setError(errorCopy(requestError));
    } finally {
      if (active.current && generation === epoch.current) setBusy(false);
      changing.current = false;
    }
  }, [accept, status?.pairing?.id]);
  requestRef.current = request;

  useEffect(() => {
    active.current = true;
    let polling = false;
    const poll = async () => {
      if (document.hidden || polling || changing.current) return;
      polling = true;
      const generation = epoch.current;
      try {
        const next = await authRequest('/api/auth/pairing');
        if (active.current && generation === epoch.current) {
          accept(next);
          setError('');
          setBusy(false);
          if (needsPairing(next)) void requestRef.current('POST');
        }
      } catch (requestError) {
        if (active.current && generation === epoch.current) { setError(errorCopy(requestError)); setBusy(false); }
      } finally { polling = false; }
    };
    void poll();
    const pollTimer = setInterval(() => { void poll(); }, 1500);
    const clockTimer = setInterval(() => setNow(Date.now() + offset.current), 250);
    const resume = () => { if (!document.hidden) { setNow(Date.now() + offset.current); void poll(); } };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      active.current = false;
      epoch.current += 1;
      clearInterval(pollTimer); clearInterval(clockTimer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [accept]);

  const pairing = status?.pairing;
  const waiting = pairing?.state === 'waiting';
  const configuring = pairing?.state === 'configuring';
  const remaining = Math.max(0, Math.ceil(((pairing?.expiresAt ?? now) - now) / 1000));
  const usableCode = waiting && remaining > 0 && /^\d{6}$/.test(pairing?.code ?? '') ? pairing?.code : null;
  const expired = pairing?.state === 'expired' || waiting && remaining === 0;

  const copyCode = async () => {
    if (!usableCode) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(usableCode);
      setCopyHint(t('auth.copied'));
    } catch {
      const element = codeText.current;
      if (element) {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      }
      setCopyHint(t('auth.manualCopy'));
    }
  };

  // The first status request decides whether this browser needs the Token factor and whether an
  // existing pairing can be resumed. Rendering pairing controls before that decision creates a
  // misleading second login path and lets a fast tap send a Token-less POST (401 TOKEN_REQUIRED).
  if (!status) return <AuthFrame title={t('auth.connecting')} showHelp={false}>
    <section className="token-prompt pairing-prompt" aria-live="polite"><p>{error || t('common.loading')}</p></section>
  </AuthFrame>;
  if (status.mode === 'token') return <TokenPrompt onSaved={onSaved} />;
  // A missing or rejected Token never falls through to pairing. The user must complete the first
  // factor before the server creates a pairing request.
  if (status.tokenEnabled && !status.tokenAuthenticated) {
    return <TokenPrompt onSaved={() => { void request('GET'); }} error={t('auth.tokenInvalid')} />;
  }

  return <AuthFrame title={t('auth.deviceRequired')} showHelp={false}>
    <section className="token-prompt pairing-prompt" aria-live="polite">
      {!pairing && busy && <p className="pairing-loading">{t('auth.preparingCode')}</p>}
      {usableCode && <>
        <div className="pairing-code-card">
          <span className="pairing-code-label">{t('auth.verificationCode')}</span>
          <strong className="pairing-code" ref={codeText}>{usableCode}</strong>
          <div className="pairing-code-meta">
            <span className="pairing-countdown">{t('auth.codeRemaining', { seconds: remaining })}</span>
            <button type="button" className="pairing-copy" onClick={() => { void copyCode(); }}>{t('auth.copyCode')}</button>
          </div>
          <progress className="pairing-progress" max={60} value={Math.min(60, remaining)} aria-label={t('auth.codeRemaining', { seconds: remaining })} />
        </div>
        <p className="pairing-help">{t('auth.authorizeWithDevice')}</p>
        <p className="pairing-cli-hint">{t('auth.authorizeWithCli')} <code>handmux auth add</code></p>
        {copyHint && <p className="auth-secondary" role="status">{copyHint}</p>}
      </>}
      {configuring && <div className="pairing-state"><p>{t('auth.pending')}</p><p className="auth-secondary">{t(pairing?.source === 'web' ? 'auth.finishWeb' : 'auth.finishCli')}</p></div>}
      {expired && <div className="pairing-state"><p>{t('auth.expired')}</p></div>}
      {pairing?.state === 'canceled' && <div className="pairing-state"><p>{t('auth.canceled')}</p></div>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      {busy && pairing && <p className="auth-secondary" role="status">{t('common.loading')}</p>}
      {(waiting || configuring) && <button type="button" className="pairing-cancel" disabled={busy} onClick={() => { void request('DELETE'); }}>{t('auth.cancelPairing')}</button>}
      {(!pairing || expired || pairing.state === 'canceled') && <button type="button" className="auth-primary pairing-new-code" disabled={busy} onClick={() => { void request('POST'); }}>{t('auth.requestNewCode')}</button>}
    </section>
  </AuthFrame>;
}
