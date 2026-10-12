import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { BotIcon } from './icons.jsx';
import RecoveryCommand from './RecoveryCommand.js';

const TERMINAL_HINT_MS = 30_000;

interface ConversationRecoveryGuideController {
  status: 'idle' | 'loading' | 'ready' | 'recovering' | 'waiting' | 'error' | 'unknown' | 'restarting';
  receipt: {
    operationId?: string;
    recovery: { command: string };
    phase?: 'prepared' | 'interrupted' | 'stopped' | 'resuming' | 'ready';
    state: 'current' | 'stale' | 'unknown';
    canResume: boolean;
  } | null;
  recover(): Promise<void>;
}

export default function ConversationRecoveryGuide({
  controller,
  operation,
  onTerminal,
}: {
  controller: ConversationRecoveryGuideController;
  operation: 'activation' | 'restart';
  onTerminal: () => void;
}) {
  const receipt = controller.receipt;
  // A durable `resuming` receipt means the automatic command was already sent. Keep presenting
  // restart progress until the controller observes the replacement run ready; do not imply the
  // user needs to start recovery a second time.
  const restartPending = operation === 'restart' && (controller.status === 'restarting'
    || (receipt?.phase === 'resuming' && controller.status !== 'recovering' && controller.status !== 'waiting'));
  const pending = restartPending || controller.status === 'recovering' || controller.status === 'waiting';
  const pendingOperation = pending
    ? restartPending ? 'restart-pending' : receipt?.operationId ?? null : null;
  const [hintedOperation, setHintedOperation] = useState<string | null>(null);
  useEffect(() => {
    setHintedOperation(null);
    if (!pendingOperation) return undefined;
    const timer = window.setTimeout(() => setHintedOperation(pendingOperation), TERMINAL_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [pendingOperation]);
  const showTerminalHint = pendingOperation !== null && hintedOperation === pendingOperation;
  if (!receipt && !pending) return null;

  const stale = receipt?.state === 'stale';
  const unverified = receipt?.state === 'unknown';
  return <div className="codex-managed-guide" aria-live="polite">
    <div className={`codex-managed-guide-icon ${pending ? 'starting' : ''}`} aria-hidden="true">
      <BotIcon />
    </div>
    <h2>{pending
      ? t(restartPending ? 'chat.restart.inProgressTitle' : 'chat.managedGuide.startingTitle')
      : unverified ? t('chat.managedGuide.recoveryUnknownTitle')
        : stale ? t('chat.managedGuide.recoveryStaleTitle')
        : t('chat.managedGuide.recoveryTitle')}</h2>
    <p>{pending
      ? t(showTerminalHint ? 'chat.managedGuide.terminalHint'
        : restartPending ? 'chat.restart.inProgressHint' : 'chat.managedGuide.startingHint')
      : unverified ? t('chat.managedGuide.recoveryUnknownHint')
        : stale ? t('chat.managedGuide.recoveryStaleHint')
        : receipt?.canResume ? t('chat.managedGuide.recoveryReadyHint')
          : t('chat.managedGuide.recoveryManualHint')}</p>
    {restartPending && <p className="codex-managed-guide-note">{t('chat.restart.manualPromptHint')}</p>}
    {receipt && !restartPending && <div className="codex-managed-guide-recovery">
      <span>{t('chat.managedGuide.recoveryHint')}</span>
      <RecoveryCommand command={receipt.recovery.command} />
    </div>}
    {!pending && receipt?.canResume && (
      <button type="button" className="codex-managed-guide-primary"
        onClick={() => { void controller.recover(); }}>
        {t('chat.managedGuide.retryRecovery')}
      </button>
    )}
    {(!restartPending || showTerminalHint) && (
      <button type="button" className="codex-managed-guide-secondary" onClick={onTerminal}>
        {t('chat.session.openTerminal')}
      </button>
    )}
    {restartPending && !showTerminalHint && <div className="codex-managed-guide-space" />}
  </div>;
}
