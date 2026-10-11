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
  onTerminal,
}: {
  controller: ConversationRecoveryGuideController;
  onTerminal: () => void;
}) {
  const receipt = controller.receipt;
  const restarting = controller.status === 'restarting';
  const pending = restarting || controller.status === 'recovering' || controller.status === 'waiting';
  const pendingOperation = pending ? receipt?.operationId ?? (restarting ? 'restart-pending' : null) : null;
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
      ? t(restarting ? 'chat.restart.inProgressTitle' : 'chat.managedGuide.startingTitle')
      : unverified ? t('chat.managedGuide.recoveryUnknownTitle')
        : stale ? t('chat.managedGuide.recoveryStaleTitle')
        : t('chat.managedGuide.recoveryTitle')}</h2>
    <p>{pending
      ? t(showTerminalHint ? 'chat.managedGuide.terminalHint'
        : restarting ? 'chat.restart.inProgressHint' : 'chat.managedGuide.startingHint')
      : unverified ? t('chat.managedGuide.recoveryUnknownHint')
        : stale ? t('chat.managedGuide.recoveryStaleHint')
        : receipt?.canResume ? t('chat.managedGuide.recoveryReadyHint')
          : t('chat.managedGuide.recoveryManualHint')}</p>
    {receipt && <div className="codex-managed-guide-recovery">
      <span>{t('chat.managedGuide.recoveryHint')}</span>
      <RecoveryCommand command={receipt.recovery.command} />
    </div>}
    {!pending && receipt?.canResume && (
      <button type="button" className="codex-managed-guide-primary"
        onClick={() => { void controller.recover(); }}>
        {t('chat.managedGuide.retryRecovery')}
      </button>
    )}
    {(!restarting || showTerminalHint) && (
      <button type="button" className="codex-managed-guide-secondary" onClick={onTerminal}>
        {t('chat.session.openTerminal')}
      </button>
    )}
    {restarting && !showTerminalHint && <div className="codex-managed-guide-space" />}
  </div>;
}
