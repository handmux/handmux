import { useCallback, useEffect, useRef, useState } from 'react';
import { applyAuthStatus, authRequest, AuthRequestError, type AuthStatus } from '../authSession.js';
import { t } from '../i18n';
import TokenPrompt from './TokenPrompt.js';
import AuthFrame from './AuthFrame.js';

const errorCopy = (error: unknown) => t(error instanceof AuthRequestError && error.status === 429
  ? 'auth.rateLimit' : 'auth.connectionError');

export default function DevicePairingPrompt({ onSaved, onSwitch }: { onSaved: () => void; onSwitch?: () => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [copyHint, setCopyHint] = useState('');
  const [method, setMethod] = useState<'cli' | 'web'>('cli');
  const methodRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [now, setNow] = useState(Date.now());
  const offset = useRef(0);
  const epoch = useRef(0);
  const active = useRef(true);
  const changing = useRef(false);
  const saved = useRef(onSaved);
  saved.current = onSaved;
  const codeText = useRef<HTMLElement>(null);
  const commandText = useRef<HTMLElement>(null);
  const copyScope = useRef('');
  const accept = useCallback((next: AuthStatus) => {
    offset.current = next.serverTime - Date.now();
    setNow(next.serverTime);
    setStatus(next);
    const nextScope = `${next.pairing?.id}:${next.pairing?.state}:${next.pairing?.code}`;
    if (copyScope.current !== nextScope) { copyScope.current = nextScope; setCopyHint(''); }
    if (next.mode === 'token' || next.authenticated) {
      applyAuthStatus(next);
      if (next.authenticated) saved.current();
    }
  }, []);
  const request = useCallback(async (method = 'GET') => {
    const generation = ++epoch.current;
    changing.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await authRequest('/api/auth/pairing', method, method === 'DELETE' ? status?.pairing?.id : undefined);
      if (active.current && generation === epoch.current) accept(next);
    } catch (error) {
      if (active.current && generation === epoch.current) setError(errorCopy(error));
    } finally {
      if (active.current && generation === epoch.current) setBusy(false);
      changing.current = false;
    }
  }, [accept, status?.pairing?.id]);

  useEffect(() => {
    active.current = true;
    let polling = false;
    const poll = async () => {
      if (document.hidden || polling || changing.current) return;
      polling = true;
      const generation = epoch.current;
      try {
        const next = await authRequest('/api/auth/pairing');
        if (active.current && generation === epoch.current) { accept(next); setError(''); setBusy(false); }
      } catch (error) {
        if (active.current && generation === epoch.current) { setError(errorCopy(error)); setBusy(false); }
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
  const copy = async (text: string, element: HTMLElement | null) => {
    if (!usableCode) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopyHint(t('auth.copied'));
    } catch {
      if (element) {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      }
      setCopyHint(t('auth.manualCopy'));
    }
  };
  if (status?.mode === 'token') return <TokenPrompt onSaved={onSaved} />;
  return <AuthFrame mode="trusted-device" title={t(configuring ? 'auth.paired' : waiting && remaining > 0 ? 'auth.waiting' : 'auth.title')}>
    <section className="token-prompt pairing-prompt">
    {window.location.protocol === 'http:' && <p className="auth-warning">{t('auth.httpWarning')}</p>}
    <div aria-live="polite">
      {configuring && <><p>{t('auth.pending')}</p><p>{t(pairing?.source === 'web' ? 'auth.finishWeb' : 'auth.finishCli')}</p>
        <p className="auth-secondary">{t('auth.setupRemaining', { seconds: remaining })}</p></>}
      {(pairing?.state === 'expired' || waiting && remaining === 0) && <p>{t('auth.expired')}</p>}
      {pairing?.state === 'canceled' && <p>{t('auth.canceled')}</p>}
    </div>
    {usableCode && <>
      <div className="pairing-code-row"><strong className="pairing-code" ref={codeText}>{usableCode}</strong>
        <button onClick={() => { void copy(usableCode, codeText.current); }}>{t('auth.copyCode')}</button></div>
      <p className="auth-secondary pairing-countdown">{t('auth.codeRemaining', { seconds: remaining })}</p>
      <div className="pairing-methods" role="tablist" aria-label={t('auth.methodLabel')}>
        {(['cli', 'web'] as const).map((value, index) => <button key={value} ref={node => { methodRefs.current[index] = node; }}
          role="tab" id={`pairing-tab-${value}`} aria-controls={`pairing-panel-${value}`} aria-selected={method === value} tabIndex={method === value ? 0 : -1}
          onClick={() => setMethod(value)} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
            setMethod(next === 0 ? 'cli' : 'web'); methodRefs.current[next]?.focus();
          }}>{t(value === 'cli' ? 'auth.cliMethod' : 'auth.webMethod')}</button>)}
      </div>
      <div role="tabpanel" id={`pairing-panel-${method}`} aria-labelledby={`pairing-tab-${method}`}>
        {method === 'cli' ? <><p>{t('auth.cliInstructions')}</p>
          <code className="pairing-command" ref={commandText}>handmux auth add {usableCode}</code>
          <button onClick={() => { void copy(`handmux auth add ${usableCode}`, commandText.current); }}>{t('auth.copyCommand')}</button>
          <p className="auth-secondary">{t('auth.cliNext')}</p></>
          : <><p>{t('auth.webInstructions')}</p><p className="pairing-web-path">{t('auth.webPath')}</p>
            <p>{t('auth.webNext')}</p><p className="auth-secondary">{t('auth.webFallback')}</p></>}
      </div>
    </>}
    {!waiting && !configuring && <p className="auth-secondary">{t('auth.browserScope')}</p>}
    <p className="auth-secondary">{t('auth.antiPhishing')}</p>
    {usableCode && copyHint && <p role="status">{copyHint}</p>}
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">{t('common.loading')}</p>}
    {(waiting || configuring) && <button className="pairing-cancel" disabled={busy} onClick={() => { void request('DELETE'); }}>{t('auth.cancelPairing')}</button>}
    {(!pairing || pairing.state === 'expired' || pairing.state === 'canceled') && <button className="auth-primary" disabled={busy} onClick={() => { void request('POST'); }}>{t('auth.request')}</button>}
    {waiting && remaining === 0 && <button className="auth-primary" disabled={busy} onClick={() => { void request('POST'); }}>{t('auth.request')}</button>}
    {onSwitch && <button type="button" className="auth-secondary" onClick={onSwitch}>{t('auth.useToken')}</button>}
  </section></AuthFrame>;
}
