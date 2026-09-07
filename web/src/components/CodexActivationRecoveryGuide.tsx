import { useEffect, useState } from 'react';
import type { ConversationActivationRecoveryController } from '../hooks/useConversationActivationRecovery.js';
import { t } from '../i18n';
import { BotIcon } from './icons.jsx';
import CodexRecoveryCommand from './CodexRecoveryCommand.js';

const TERMINAL_HINT_MS = 30_000;

export default function CodexActivationRecoveryGuide({
  controller,
  onTerminal,
}: {
  controller: ConversationActivationRecoveryController;
  onTerminal: () => void;
}) {
  const receipt = controller.receipt;
  const pending = controller.status === 'recovering' || controller.status === 'waiting';
  const pendingOperation = pending ? receipt?.operationId ?? null : null;
  const [hintedOperation, setHintedOperation] = useState<string | null>(null);
  useEffect(() => {
    setHintedOperation(null);
    if (!pendingOperation) return undefined;
    const timer = window.setTimeout(() => setHintedOperation(pendingOperation), TERMINAL_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [pendingOperation]);
  const showTerminalHint = pendingOperation !== null && hintedOperation === pendingOperation;
  if (!receipt) return null;

  const stale = receipt.state === 'stale';
  return <div className="codex-managed-guide" aria-live="polite">
    <div className={`codex-managed-guide-icon ${pending ? 'starting' : ''}`} aria-hidden="true">
      <BotIcon />
    </div>
    <h2>{pending
      ? t('chat.managedGuide.startingTitle')
      : stale ? t('chat.managedGuide.recoveryStaleTitle')
        : t('chat.managedGuide.recoveryTitle')}</h2>
    <p>{pending
      ? t(showTerminalHint ? 'chat.managedGuide.terminalHint' : 'chat.managedGuide.startingHint')
      : stale ? t('chat.managedGuide.recoveryStaleHint')
        : receipt.canResume ? t('chat.managedGuide.recoveryReadyHint')
          : t('chat.managedGuide.recoveryManualHint')}</p>
    <div className="codex-managed-guide-recovery">
      <span>{t('chat.managedGuide.recoveryHint')}</span>
      <CodexRecoveryCommand command={receipt.recovery.command} />
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
