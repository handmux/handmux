import { t } from '../i18n';
import { BotIcon } from './icons.jsx';

export default function CodexManagedGuide({ onTerminal }) {
  return (
    <div className="codex-managed-guide">
      <div className="codex-managed-guide-icon" aria-hidden="true"><BotIcon /></div>
      <h2>{t('chat.managedGuide.title')}</h2>
      <p>{t('chat.managedGuide.hint')}</p>
      <ol>
        <li>{t('chat.managedGuide.exit')}</li>
        <li>{t('chat.managedGuide.run')} <code>handmux codex resume</code></li>
        <li>{t('chat.managedGuide.finish')}</li>
      </ol>
      <p className="codex-managed-guide-note">{t('chat.managedGuide.note')}</p>
      <button type="button" className="codex-managed-guide-terminal" onClick={onTerminal}>
        {t('chat.session.openTerminal')}
      </button>
    </div>
  );
}
