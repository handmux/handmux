import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { setToken } from '../storage.js';
import { t } from '../i18n';
import AuthFrame from './AuthFrame.js';

export default function TokenPrompt({ onSaved, error, busy = false }: { onSaved: () => void; error?: string; busy?: boolean }) {
  const [value, setValue] = useState('');
  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const tok = value.trim();
    if (!tok) return;
    setToken(tok);
    onSaved();
  };
  return (
    <AuthFrame title={t('token.title')} mode="token">
    <form className="token-prompt" onSubmit={save}>
      <p className="auth-warning">{t('auth.dualRequirement')}</p>
      {window.location.protocol === 'http:' && <p className="auth-warning">{t('auth.httpWarning')}</p>}
      <label className="auth-input-label" htmlFor="auth-token">Token</label>
      <input id="auth-token" type="password" autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        value={value} onChange={(event: ChangeEvent<HTMLInputElement>) => setValue(event.target.value)} placeholder={t('token.placeholder')} />
      <button className="auth-primary" type="submit" disabled={busy || !value.trim()}>{busy ? t('common.loading') : t('auth.login')}</button>
      {error && <p className="auth-error" role="alert">{error}</p>}
    </form>
    </AuthFrame>
  );
}
