import { useEffect, useRef } from 'react';
import type { AgentRunRef } from '../agentCatalog.js';
import { t } from '../i18n';
import type { AgentConversationActivationController } from '../hooks/useAgentConversationActivation.js';

export default function AgentConversationActivationGuide({
  controller,
  onCancel,
  run,
  onActivationChange,
}: {
  controller: AgentConversationActivationController;
  onCancel: () => void;
  run?: AgentRunRef;
  onActivationChange?: (run: AgentRunRef, active: boolean) => void;
}) {
  const activatingRef = useRef(false);
  const runRef = useRef(run);
  runRef.current = run;
  const pending = controller.status === 'activating' || controller.status === 'waiting';
  const unavailable = controller.status === 'unavailable';
  const failed = controller.status === 'error';
  const message = controller.error === 'stale_run'
    ? t('chat.activation.stale')
    : controller.error === 'discovery_timeout'
      ? t('chat.activation.timeout')
      : failed ? t('chat.activation.failed')
        : unavailable ? t('chat.activation.unavailable')
          : pending ? t(controller.status === 'activating'
            ? 'chat.activation.activating' : 'chat.activation.waiting')
            : t('chat.activation.body');
  useEffect(() => {
    if (controller.status === 'error' && controller.error !== 'discovery_timeout' && runRef.current) {
      onActivationChange?.(runRef.current, false);
    }
  }, [controller.error, controller.status, onActivationChange]);
  const activate = async (): Promise<void> => {
    if (activatingRef.current) return;
    activatingRef.current = true;
    if (runRef.current) onActivationChange?.(runRef.current, true);
    try { await controller.activate(); }
    finally { activatingRef.current = false; }
  };
  return <div className="chat-view conversation-activation-surface">
    <div className="settings-confirm-backdrop conversation-activation-backdrop">
      <section className="settings-confirm conversation-activation-dialog" role="alertdialog"
        aria-modal="true" aria-label={t('chat.activation.title')}>
        <h2>{t('chat.activation.title')}</h2>
        <p>{message}</p>
        <div className="settings-confirm-actions">
          <button type="button" onClick={onCancel}>{t('chat.activation.terminal')}</button>
          {failed || unavailable ? <button type="button" disabled={pending}
            onClick={controller.retry}>{t('common.retry')}</button>
            : <button type="button" disabled={controller.status !== 'ready'}
              onClick={() => { void activate(); }}>
              {pending ? t('chat.activation.working') : t('common.continue')}
            </button>}
        </div>
      </section>
    </div>
  </div>;
}
