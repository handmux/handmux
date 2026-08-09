import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { t } from '../i18n';

const NAME_RE = /^[A-Za-z0-9-]{1,16}$/; // mirrors the server; rename requires a non-blank valid name

// Rename a session or a window. Prefilled with the current name; the new name must match the same
// rule as creation (≤16, letters/digits/hyphens). onSubmit(name) does the work in App and may
// throw — its message is shown inline and the button re-enables for a retry. On success App closes
// the modal (open → false).
interface RenameModalProps {
  open: boolean;
  title: string;
  currentName?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void> | void;
  inset?: number;
}

export default function RenameModal({
  open, title, currentName = '', onClose, onSubmit, inset = 0,
}: RenameModalProps) {
  const [name, setName] = useState(currentName);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    setName(currentName); setError(''); setBusy(false);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [open, currentName]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (busy) return;
    const n = name.trim();
    if (!NAME_RE.test(n)) { setError(t('rename.name_rule')); return; }
    setBusy(true); setError('');
    try { await onSubmit(n); }
    catch (error: unknown) {
      setError(error instanceof Error && error.message ? error.message : t('rename.failed'));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <div
        className="settings-card"
        style={{ transform: `translate(-50%, calc(-50% + ${inset / 2}px))` }}
        role="dialog" aria-label={title} aria-modal="true"
      >
        <div className="settings-head">
          <span className="settings-title">{title}</span>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="settings-section">
          <div className="settings-label">{t('rename.new_name')}</div>
          <input
            ref={inputRef}
            className="bind-input"
            value={name}
            placeholder={t('rename.name_rule')}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setName(event.target.value); setError('');
            }}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') void submit();
            }}
          />
          {error && <div className="bind-error">{error}</div>}
          <div className="settings-btns bind-actions">
            <button className="fontbtn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="fontbtn bind-confirm" onClick={() => void submit()} disabled={busy}>
              {busy ? t('rename.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
