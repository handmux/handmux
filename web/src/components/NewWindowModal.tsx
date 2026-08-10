import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { fetchPaneCwd } from '../api.js';
import { getLastStartupCmd, setLastStartupCmd } from '../storage.js';
import DirPicker from './DirPicker.jsx';
import StartupCmdPicker from './StartupCmdPicker.jsx';
import { useBackButton } from '../hooks/useBackButton.js';

const NAME_RE = /^[A-Za-z0-9-]{1,16}$/; // mirrors the server (optional — blank = auto-name)

export interface NewWindowModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, cwd?: string, command?: string) => void | Promise<void>;
  paneId?: string | null;
  inset?: number;
}

const cwdOf = (value: unknown): string | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const cwd = (value as Record<string, unknown>).cwd;
  return typeof cwd === 'string' && cwd ? cwd : null;
};

const startupCommand = (): string => {
  const value: unknown = getLastStartupCmd();
  return typeof value === 'string' ? value : '';
};

// Create a new window. The name is optional: blank → the server lets tmux auto-name the window;
// a non-blank name must match the same rule as session names. onCreate(name, cwd) does the actual
// create+switch (in App) and may throw — we re-enable the button so the user can retry.
// cwd=undefined means "inherit the pane's current dir" (same as today's behavior when not picked).
export default function NewWindowModal({ open, onClose, onCreate, paneId, inset = 0 }: NewWindowModalProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cwd, setCwd] = useState<string | null>(null); // null → server inherits the pane's dir
  const [defaultCwd, setDefaultCwd] = useState(''); // pane cwd, shown as the default label
  const [cmd, setCmd] = useState<string>(startupCommand); // startup command; sticky to your last choice
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setName(''); setError(''); setBusy(false); setCwd(null); setDefaultCwd(''); setPickerOpen(false);
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 0);
    if (paneId) fetchPaneCwd(paneId).then((response) => {
      const paneCwd = cwdOf(response);
      if (!cancelled) setDefaultCwd(paneCwd || '');
    }).catch(() => {});
    return () => { cancelled = true; clearTimeout(focusTimer); };
  }, [open, paneId]);
  useBackButton(open && pickerOpen, () => setPickerOpen(false));

  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (busy) return;
    const n = name.trim();
    if (n && !NAME_RE.test(n)) { setError(t('newwindow.name_rule')); return; }
    setBusy(true);
    setError('');
    setLastStartupCmd(cmd); // remember so next new-window defaults to your usual launcher
    try {
      await onCreate(n, cwd || undefined, cmd || undefined); // '' → auto-name; cwd/cmd null → undefined
    } catch {
      setBusy(false); // onCreate handles auth; a generic failure just re-enables the button
    }
  };

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <div
        className="settings-card"
        style={{ transform: `translate(-50%, calc(-50% + ${inset / 2}px))` }}
        role="dialog" aria-label={t('newwindow.title')} aria-modal="true"
      >
        <div className="settings-head">
          <span className="settings-title">{t('newwindow.title')}</span>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="settings-section">
          <div className="opt">
            <div className="settings-label">{t('newwindow.window_name')}</div>
            <input
              ref={inputRef}
              className="bind-input"
              value={name}
              placeholder={t('newwindow.name_placeholder')}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            />
            {error && <div className="bind-error">{error}</div>}
          </div>
          <div className="opt">
            <div className="settings-label">{t('newwindow.start_dir')}</div>
            <button type="button" className="field cwd-field" onClick={() => setPickerOpen(true)}>
              <span className="cwd-path">{cwd || (defaultCwd ? t('newwindow.session_dir_named', { dir: defaultCwd }) : t('newwindow.session_dir_default'))}</span>
              <span className="cwd-action">{t('newwindow.choose')}</span>
            </button>
            {cwd && <button type="button" className="cwd-reset" onClick={() => setCwd(null)}>{t('newwindow.reset_to_session_dir')}</button>}
          </div>
          <div className="opt">
            <StartupCmdPicker value={cmd} onChange={setCmd} />
          </div>
          <div className="settings-btns bind-actions">
            <button className="fontbtn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="fontbtn bind-confirm" onClick={submit} disabled={busy}>
              {busy ? t('newwindow.creating') : t('common.create')}
            </button>
          </div>
        </div>
      </div>
      <DirPicker
        open={pickerOpen}
        seedCwd={cwd || defaultCwd || null}
        pane={paneId ?? null}
        allowMkdir
        onPick={(p) => { setCwd(p); setPickerOpen(false); }}
        onClose={() => setPickerOpen(false)}
        inset={inset}
      />
    </>
  );
}
