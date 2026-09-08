import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { setToken } from '../storage.js';
import { t } from '../i18n';
import AuthFrame from './AuthFrame.js';

export default function TokenPrompt({ onSaved }: { onSaved: () => void }) {
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
      <p className="auth-warning">{t('auth.tokenWarning')}</p>
      {window.location.protocol === 'http:' && <p className="auth-warning">{t('auth.httpWarning')}</p>}
      <label className="auth-input-label" htmlFor="auth-token">Token</label>
      <input id="auth-token" type="password" autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        value={value} onChange={(event: ChangeEvent<HTMLInputElement>) => setValue(event.target.value)} placeholder={t('token.placeholder')} />
      <button className="auth-primary" type="submit" disabled={!value.trim()}>{t('auth.login')}</button>
    </form>
    </AuthFrame>
  );
}
