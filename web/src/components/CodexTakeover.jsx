import { useState } from 'react';
import { takeoverCodexSession, UnauthorizedError } from '../api.js';
import { t } from '../i18n';
import { BotIcon } from './icons.jsx';

function takeoverError(error) {
  if (error?.serverError === 'codex-session-unbound') return t('chat.takeover.unbound');
  if (error?.serverError === 'codex-pane-unavailable') return t('chat.takeover.paneChanged');
  return t('chat.takeover.failed');
}

export default function CodexTakeover({ pane, onTakenOver, onTerminal, onAuthFail }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const takeover = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await takeoverCodexSession(pane);
      onTakenOver?.();
    } catch (err) {
      if (err instanceof UnauthorizedError) onAuthFail?.();
      else setError(takeoverError(err));
      setBusy(false);
    }
  };

  return (
    <div className="codex-takeover">
      <div className="codex-takeover-icon" aria-hidden="true"><BotIcon /></div>
      <h2>{t('chat.takeover.title')}</h2>
      <p>{t('chat.takeover.hint')}</p>
      <button type="button" className="codex-takeover-primary" disabled={busy} onClick={() => void takeover()}>
        {busy ? t('chat.takeover.working') : t('chat.takeover.action')}
      </button>
      {error && <div className="codex-takeover-error" role="status">{error}</div>}
      <button type="button" className="codex-takeover-terminal" disabled={busy} onClick={onTerminal}>
        {t('chat.session.openTerminal')}
      </button>
    </div>
  );
}
