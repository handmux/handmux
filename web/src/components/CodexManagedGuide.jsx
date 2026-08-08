import { useEffect, useRef, useState } from 'react';
import { takeoverCodexSession, UnauthorizedError } from '../api.js';
import { t } from '../i18n';
import ActionSheet from './ActionSheet.jsx';
import { BotIcon } from './icons.jsx';

const TERMINAL_HINT_MS = 5_000;

export default function CodexManagedGuide({ pane, session, onTerminal, onAuthFail, onTakeoverChange }) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localStarting, setLocalStarting] = useState(false);
  const [showTerminalHint, setShowTerminalHint] = useState(false);
  const [errorCode, setErrorCode] = useState(null);
  const submittingRef = useRef(false);
  const requestSeqRef = useRef(0);
  const starting = !!session?.takeover || localStarting;

  useEffect(() => {
    requestSeqRef.current += 1; // invalidate a response started for the previously displayed pane
    setConfirming(false);
    setSubmitting(false);
    setLocalStarting(false);
    setShowTerminalHint(false);
    setErrorCode(null);
    submittingRef.current = false;
    return () => { requestSeqRef.current += 1; };
  }, [pane]);

  useEffect(() => {
    if (!starting) { setShowTerminalHint(false); return undefined; }
    if (session?.takeover?.needsTerminal) { setShowTerminalHint(true); return undefined; }
    const timer = setTimeout(() => setShowTerminalHint(true), TERMINAL_HINT_MS);
    return () => clearTimeout(timer);
  }, [starting, session?.takeover?.needsTerminal]);

  const start = async () => {
    if (!pane || submittingRef.current || starting) return;
    const requestSeq = ++requestSeqRef.current;
    submittingRef.current = true;
    onTakeoverChange?.(pane, true);
    setConfirming(false);
    setSubmitting(true);
    setErrorCode(null);
    try {
      const result = await takeoverCodexSession(pane);
      if (requestSeqRef.current !== requestSeq) return;
      setLocalStarting(true);
      if (result?.takeover?.needsTerminal) setShowTerminalHint(true);
    } catch (error) {
      onTakeoverChange?.(pane, false);
      if (error instanceof UnauthorizedError) onAuthFail?.();
      else if (requestSeqRef.current === requestSeq) {
        setErrorCode(error?.serverError || 'codex-takeover-failed');
      }
    } finally {
      if (requestSeqRef.current === requestSeq) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  const unbound = ['codex-session-unbound', 'codex-session-unconfirmed', 'codex-exit-blocked'].includes(errorCode);
  const paneGone = errorCode === 'codex-pane-gone' || errorCode === 'codex-pane-changed';
  const title = starting ? t('chat.managedGuide.startingTitle')
    : unbound ? t('chat.managedGuide.manualTitle')
      : paneGone ? t('chat.managedGuide.goneTitle')
        : t('chat.managedGuide.title');
  const hint = starting
    ? (showTerminalHint ? t('chat.managedGuide.terminalHint') : t('chat.managedGuide.startingHint'))
    : unbound ? t('chat.managedGuide.manualHint')
      : paneGone ? t('chat.managedGuide.goneHint')
        : errorCode ? t('chat.managedGuide.failedHint')
          : t('chat.managedGuide.hint');

  return (
    <div className="codex-managed-guide" aria-live="polite">
      <div className={`codex-managed-guide-icon ${starting ? 'starting' : ''}`} aria-hidden="true"><BotIcon /></div>
      <h2>{title}</h2>
      <p>{hint}</p>
      {!starting && !unbound && !paneGone && (
        <button type="button" className="codex-managed-guide-primary"
          disabled={submitting} onClick={() => setConfirming(true)}>
          {submitting ? t('chat.managedGuide.submitting') : t('chat.managedGuide.start')}
        </button>
      )}
      {(starting ? showTerminalHint : true) && (
        <button type="button" className="codex-managed-guide-secondary" onClick={onTerminal}>
          {t('chat.session.openTerminal')}
        </button>
      )}
      {starting && !showTerminalHint && <div className="codex-managed-guide-space" />}
      <ActionSheet
        open={confirming}
        title={t('chat.managedGuide.confirmTitle')}
        subtitle={t('chat.managedGuide.confirmHint')}
        actions={[{
          key: 'takeover', danger: true, label: t('chat.managedGuide.confirmAction'), onClick: start,
        }]}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
