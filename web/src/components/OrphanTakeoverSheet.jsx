import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { getSessions } from '../api.js';
import { getOrphanKill, setOrphanKill } from '../storage.js';

// Takeover sheet for an orphan Claude session (running outside tmux). Choose WHERE to resume it —
// a brand-new tmux session, or a new window inside an existing session — and whether to SIGTERM the
// original afterwards (default ON, remembered per device: a resumed session shares the same jsonl with
// no lock, so two live writers corrupt history — see server/src/orphans.js). onConfirm performs the
// takeover (App navigates into the new pane + closes on success) and throws on failure so we can show it.
// Native <select> is avoided per project convention — targets are a fontbtn group with aria-pressed.
export default function OrphanTakeoverSheet({ open, orphan, onConfirm, onClose, inset = 0 }) {
  const [sessions, setSessions] = useState([]);
  const [target, setTarget] = useState('new'); // 'new' | sessionId ($n)
  const [name, setName] = useState('');        // new-session name (editable; prefilled with the server default)
  const [kill, setKill] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTarget('new'); setName(orphan?.suggestedName || ''); setKill(getOrphanKill()); setBusy(false); setError('');
    getSessions().then((s) => setSessions(Array.isArray(s) ? s : [])).catch(() => setSessions([]));
  }, [open, orphan]);

  if (!open || !orphan) return null;

  // The name the computer command shows — the editable field for a new session, else the picked session's name.
  const displayName = target === 'new'
    ? (name.trim() || orphan.suggestedName || '')
    : (sessions.find((s) => s.id === target)?.name || '');

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError('');
    setOrphanKill(kill); // remember the choice for next time
    const tgt = target === 'new' ? { mode: 'new' } : { mode: 'window', session: target };
    try { await onConfirm({ target: tgt, kill, name: target === 'new' ? name.trim() : undefined }); } // success → App closes this sheet
    catch { setBusy(false); setError(t('inbox.orphans.failed')); }
  };

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <div
        className="settings-card"
        style={{ transform: `translate(-50%, calc(-50% + ${inset / 2}px))` }}
        role="dialog" aria-label={t('inbox.orphans.takeover')} aria-modal="true"
      >
        <div className="settings-head">
          <span className="settings-title">{t('inbox.orphans.takeover')}</span>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="settings-section">
          <div className="opt">
            <div className="settings-label">{orphan.cwdLabel || orphan.cwd}</div>
            {orphan.snippet && <div className="inbox-msg">{orphan.snippet}</div>}
          </div>
          <div className="opt">
            <div className="settings-label">{t('inbox.orphans.targetLabel')}</div>
            <div className="orphan-targets">
              <button className="fontbtn" aria-pressed={target === 'new'} onClick={() => setTarget('new')}>
                {t('inbox.orphans.targetNew')}
              </button>
              {sessions.map((s) => (
                <button key={s.id} className="fontbtn" aria-pressed={target === s.id} onClick={() => setTarget(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          {target === 'new' && (
            <div className="opt">
              <div className="settings-label">{t('inbox.orphans.nameLabel')}</div>
              <input
                className="bind-input"
                value={name}
                placeholder={t('inbox.orphans.namePlaceholder')}
                onChange={(e) => { setName(e.target.value); setError(''); }}
              />
            </div>
          )}
          <div className="opt">
            <div className="settings-label">{t('inbox.orphans.killTitle')}</div>
            <div className="orphan-targets orphan-kill">
              <button className="fontbtn" aria-pressed={kill} onClick={() => setKill(true)}>
                {t('inbox.orphans.killEnd')}<span className="orphan-reco">{t('inbox.orphans.recommended')}</span>
              </button>
              <button className="fontbtn" aria-pressed={!kill} onClick={() => setKill(false)}>
                {t('inbox.orphans.killKeep')}
              </button>
            </div>
            <div className="orphan-help">{t('inbox.orphans.killWhy')}</div>
            <div className="orphan-help">
              {t('inbox.orphans.reopenPre')}{' '}
              <code className="orphan-cmd">handmux open {displayName || t('inbox.orphans.namePlaceholder')}</code>
            </div>
          </div>
          {error && <div className="bind-error">{error}</div>}
          <div className="settings-btns bind-actions">
            <button className="fontbtn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="fontbtn bind-confirm" onClick={submit} disabled={busy}>
              {busy ? t('inbox.orphans.working') : t('inbox.orphans.takeover')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
