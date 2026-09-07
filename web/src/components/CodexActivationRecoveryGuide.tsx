import { useEffect, useState } from 'react';
import { copyText } from '../clipboard.js';
import type { ConversationActivationRecoveryController } from '../hooks/useConversationActivationRecovery.js';
import { t } from '../i18n';
import { BotIcon } from './icons.jsx';

export default function CodexActivationRecoveryGuide({
  controller,
  onTerminal,
}: {
  controller: ConversationActivationRecoveryController;
  onTerminal: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const receipt = controller.receipt;
  const pending = controller.status === 'recovering' || controller.status === 'waiting';
  useEffect(() => setCopied(false), [receipt?.recovery.command]);
  if (!receipt) return null;

  const stale = receipt.state === 'stale';
  const copy = async (): Promise<void> => setCopied(await copyText(receipt.recovery.command));
  return <div className="codex-managed-guide" aria-live="polite">
    <div className={`codex-managed-guide-icon ${pending ? 'starting' : ''}`} aria-hidden="true">
      <BotIcon />
    </div>
    <h2>{pending
      ? t('chat.managedGuide.startingTitle')
      : stale ? t('chat.managedGuide.recoveryStaleTitle')
        : t('chat.managedGuide.recoveryTitle')}</h2>
    <p>{pending
      ? t('chat.managedGuide.startingHint')
      : stale ? t('chat.managedGuide.recoveryStaleHint')
        : receipt.canResume ? t('chat.managedGuide.recoveryReadyHint')
          : t('chat.managedGuide.recoveryManualHint')}</p>
    <div className="codex-managed-guide-recovery">
      <span>{t('chat.managedGuide.recoveryHint')}</span>
      <code>{receipt.recovery.command}</code>
      <button type="button" onClick={() => { void copy(); }}>
        {copied ? t('chat.status.copied') : t('chat.managedGuide.copyRecovery')}
      </button>
    </div>
    {!pending && receipt.canResume && (
      <button type="button" className="codex-managed-guide-primary"
        onClick={() => { void controller.recover(); }}>
        {t('chat.managedGuide.retryRecovery')}
      </button>
    )}
    <button type="button" className="codex-managed-guide-secondary" onClick={onTerminal}>
      {t('chat.session.openTerminal')}
    </button>
  </div>;
}
