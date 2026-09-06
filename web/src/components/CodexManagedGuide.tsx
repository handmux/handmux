import { useEffect, useRef, useState } from 'react';
import type { AgentRunRef } from '../agentCatalog.js';
import type { AgentConversationActivationController } from '../hooks/useAgentConversationActivation.js';
import { t } from '../i18n';
import { copyText } from '../clipboard.js';
import { BotIcon } from './icons.jsx';

const TERMINAL_HINT_MS = 10_000;

interface CodexManagedGuideProps {
  run: AgentRunRef;
  controller: AgentConversationActivationController;
  onTerminal: () => void;
  onActivationChange: (run: AgentRunRef, takingOver: boolean) => void;
}

export default function CodexManagedGuide({
  run, controller, onTerminal, onActivationChange,
}: CodexManagedGuideProps) {
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showTerminalHint, setShowTerminalHint] = useState(false);
  const submittingRef = useRef(false);
  const runRef = useRef(run);
  runRef.current = run;
  const timedOut = controller.error === 'discovery_timeout';
  const starting = (controller.status === 'activating' || controller.status === 'waiting') && !timedOut;

  useEffect(() => {
    setConfirming(false);
    setShowTerminalHint(false);
    submittingRef.current = false;
  }, [run.agentId, run.paneId, run.runId]);

  useEffect(() => {
    if (!starting) { setShowTerminalHint(false); return undefined; }
    const timer = window.setTimeout(() => setShowTerminalHint(true), TERMINAL_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [starting]);

  useEffect(() => {
    if (controller.status === 'error' && !timedOut) {
      onActivationChange(runRef.current, false);
    }
  }, [controller.status, onActivationChange, timedOut]);
  useEffect(() => setCopied(false), [controller.recovery?.command]);

  const copyRecovery = async (): Promise<void> => {
    const command = controller.recovery?.command;
    if (!command) return;
    setCopied(await copyText(command));
  };

  const start = async (): Promise<void> => {
    if (submittingRef.current || starting || !controller.descriptor) return;
    submittingRef.current = true;
    setConfirming(false);
    onActivationChange(runRef.current, true);
    try { await controller.activate(); }
    finally { submittingRef.current = false; }
  };

  const unbound = controller.status === 'unavailable';
  const paneGone = controller.error === 'stale_run';
  const title = starting ? t('chat.managedGuide.startingTitle')
    : timedOut ? t('chat.managedGuide.timeoutTitle')
      : unbound ? t('chat.session.connectionTitle')
        : paneGone ? t('chat.managedGuide.goneTitle')
          : t('chat.managedGuide.title');
  const hint = starting
    ? (showTerminalHint ? t('chat.managedGuide.terminalHint') : t('chat.managedGuide.startingHint'))
    : timedOut ? t('chat.managedGuide.timeoutHint')
      : unbound ? t('chat.session.connectionHint')
        : paneGone ? t('chat.managedGuide.goneHint')
          : controller.error ? t('chat.managedGuide.failedHint')
            : t('chat.managedGuide.hint');

  return (
    <div className="codex-managed-guide" aria-live="polite">
      <div className={`codex-managed-guide-icon ${starting ? 'starting' : ''}`} aria-hidden="true">
        <BotIcon />
      </div>
      <h2>{title}</h2>
      <p>{hint}</p>
      {(controller.error === 'activation_failed' || controller.error === 'discovery_timeout')
        && controller.recovery && (
        <div className="codex-managed-guide-recovery">
          <span>{t('chat.managedGuide.recoveryHint')}</span>
          <code>{controller.recovery.command}</code>
          <button type="button" onClick={() => { void copyRecovery(); }}>
            {copied ? t('chat.status.copied') : t('chat.managedGuide.copyRecovery')}
          </button>
        </div>
      )}
      {!starting && !timedOut && !unbound && !paneGone && (
        <button type="button" className="codex-managed-guide-primary"
          disabled={controller.status === 'loading'}
          onClick={() => {
            if (controller.descriptor) setConfirming(true);
            else controller.retry();
          }}>
          {controller.status === 'loading'
            ? t('chat.managedGuide.submitting') : t('chat.managedGuide.start')}
        </button>
      )}
      {(starting ? showTerminalHint : true) && (
        <button type="button" className="codex-managed-guide-secondary" onClick={onTerminal}>
          {t('chat.session.openTerminal')}
        </button>
      )}
      {starting && !showTerminalHint && <div className="codex-managed-guide-space" />}
      {confirming && (
        <div className="settings-confirm-backdrop" onClick={() => setConfirming(false)}>
          <div className="settings-confirm" role="alertdialog" aria-modal="true"
            aria-labelledby="codex-takeover-title" aria-describedby="codex-takeover-hint"
            onClick={(event) => event.stopPropagation()}>
            <h2 id="codex-takeover-title">{t('chat.managedGuide.confirmTitle')}</h2>
            <p id="codex-takeover-hint">{t('chat.managedGuide.confirmHint')}</p>
            <div className="settings-confirm-actions">
              <button type="button" autoFocus onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
              <button type="button" className="danger" onClick={() => { void start(); }}>
                {t('chat.managedGuide.confirmAction')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
