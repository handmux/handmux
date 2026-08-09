import { useEffect, useRef, useState } from 'react';
import { takeoverCodexSession, UnauthorizedError } from '../api.js';
import { t } from '../i18n';
import { BotIcon } from './icons.jsx';
import type { CodexSessionSnapshot } from '../hooks/useCodexSession.js';

const TERMINAL_HINT_MS = 10_000;

interface CodexManagedGuideProps {
  pane: string;
  session?: Partial<CodexSessionSnapshot> | null;
  onTerminal: () => void;
  onAuthFail?: () => void;
  onTakeoverChange?: (pane: string, takingOver: boolean) => void;
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

export default function CodexManagedGuide({
  pane, session, onTerminal, onAuthFail, onTakeoverChange,
}: CodexManagedGuideProps) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localStarting, setLocalStarting] = useState(false);
  const [showTerminalHint, setShowTerminalHint] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const requestSeqRef = useRef(0);
  const timedOut = session?.takeover?.state === 'timed-out';
  const starting = (!!session?.takeover || localStarting) && !timedOut;

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

  const start = async (): Promise<void> => {
    if (!pane || submittingRef.current || starting) return;
    const requestSeq = ++requestSeqRef.current;
    submittingRef.current = true;
    onTakeoverChange?.(pane, true);
    setConfirming(false);
    setSubmitting(true);
    setErrorCode(null);
    try {
      const result = recordOf(await takeoverCodexSession(pane));
      if (requestSeqRef.current !== requestSeq) return;
      setLocalStarting(true);
      if (recordOf(result?.takeover)?.needsTerminal === true) setShowTerminalHint(true);
    } catch (error) {
      if (error instanceof UnauthorizedError) onAuthFail?.();
      else if (requestSeqRef.current === requestSeq) {
        const code = recordOf(error)?.serverError;
        setErrorCode(typeof code === 'string' && code ? code : 'codex-takeover-failed');
      }
    } finally {
      if (requestSeqRef.current === requestSeq) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  const unbound = errorCode != null
    && ['codex-session-unbound', 'codex-session-unconfirmed', 'codex-exit-blocked'].includes(errorCode);
  const manual = unbound || timedOut;
  const paneGone = errorCode === 'codex-pane-gone' || errorCode === 'codex-pane-changed';
  const title = starting ? t('chat.managedGuide.startingTitle')
    : timedOut ? t('chat.managedGuide.timeoutTitle')
      : unbound ? t('chat.managedGuide.manualTitle')
      : paneGone ? t('chat.managedGuide.goneTitle')
        : t('chat.managedGuide.title');
  const hint = starting
    ? (showTerminalHint ? t('chat.managedGuide.terminalHint') : t('chat.managedGuide.startingHint'))
    : timedOut ? t('chat.managedGuide.timeoutHint')
      : unbound ? t('chat.managedGuide.manualHint')
      : paneGone ? t('chat.managedGuide.goneHint')
        : errorCode ? t('chat.managedGuide.failedHint')
          : t('chat.managedGuide.hint');

  return (
    <div className="codex-managed-guide" aria-live="polite">
      <div className={`codex-managed-guide-icon ${starting ? 'starting' : ''}`} aria-hidden="true"><BotIcon /></div>
      <h2>{title}</h2>
      <p>{hint}</p>
      {!starting && !manual && !paneGone && (
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
      {confirming && (
        <div className="settings-confirm-backdrop" onClick={() => setConfirming(false)}>
          <div className="settings-confirm" role="alertdialog" aria-modal="true"
            aria-labelledby="codex-takeover-title" aria-describedby="codex-takeover-hint"
            onClick={(event) => event.stopPropagation()}>
            <h2 id="codex-takeover-title">{t('chat.managedGuide.confirmTitle')}</h2>
            <p id="codex-takeover-hint">{t('chat.managedGuide.confirmHint')}</p>
            <div className="settings-confirm-actions">
              <button type="button" autoFocus onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
              <button type="button" className="danger" onClick={() => void start()}>
                {t('chat.managedGuide.confirmAction')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
