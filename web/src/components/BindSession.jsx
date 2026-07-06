import { useEffect, useRef, useState } from 'react';
import { getSessions, createSession, UnauthorizedError } from '../api.js';
import { getLastStartupCmd, setLastStartupCmd } from '../storage.js';
import { t } from '../i18n';
import DirPicker from './DirPicker.jsx';
import StartupCmdPicker from './StartupCmdPicker.jsx';

// Mirrors the server's isValidSessionName: letters, digits, hyphens, 1-16 chars. Applied only when
// CREATING a session — binding picks from a list of existing names (which may contain spaces), so no
// regex is needed on that path.
const NEW_NAME_RE = /^[A-Za-z0-9-]{1,16}$/;

// Bind a session by PICKING it. Instead of typing a name, we list the sessions that exist on the host
// and aren't already bound on this device (a fontbtn group, per project convention — no native <select>).
// A "＋ new" entry flips the card into create mode: name + start dir + startup command, then create+open.
export default function BindSession({ open, onClose, onBound, bound, onAuthFail, inset = 0 }) {
  const [sessions, setSessions] = useState([]);
  const [target, setTarget] = useState(null); // null = nothing picked · 'new' · existing session name
  const [name, setName] = useState('');        // new-session name (create mode)
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cwd, setCwd] = useState(null);
  const [cmd, setCmd] = useState(getLastStartupCmd()); // startup command for a newly-created session
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setTarget(null); setName(''); setError(''); setBusy(false); setCwd(null); setPickerOpen(false);
    getSessions()
      .then((s) => setSessions(Array.isArray(s) ? s : []))
      .catch((e) => { if (e instanceof UnauthorizedError) onAuthFail?.(); else setError(t('bind.checkFailed')); });
  }, [open]);

  // Focus the name field the moment we enter create mode so the soft keyboard pops right up.
  useEffect(() => { if (target === 'new') setTimeout(() => inputRef.current?.focus(), 0); }, [target]);

  if (!open) return null;

  const avail = sessions.filter((s) => !bound.includes(s.name)); // 已绑定的不再展示

  const submit = async () => {
    if (busy || !target) return;

    // Existing session picked → it already exists, just open it (spaced names welcome).
    if (target !== 'new') { onBound(target); return; }

    // Create mode: validate, create, then open.
    const n = name.trim();
    if (!n) return;
    if (bound.includes(n) || sessions.some((s) => s.name === n)) { setError(t('bind.alreadyExists')); return; }
    if (!NEW_NAME_RE.test(n)) { setError(t('bind.invalidName')); return; }
    setBusy(true); setError('');
    setLastStartupCmd(cmd); // remember the launcher for next time
    try {
      await createSession(n, cwd || undefined, cmd || undefined);
      onBound(n); // session is now live → bindSession/selectSession opens it
    } catch (e) {
      if (e instanceof UnauthorizedError) onAuthFail?.();
      else setError(t('bind.createFailed'));
      setBusy(false);
    }
  };

  const confirmLabel = target === 'new'
    ? (busy ? t('bind.creating') : t('bind.createAndOpen'))
    : (busy ? t('bind.checking') : t('bind.bind'));

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      {/* The app slides up by `inset` when the keyboard opens; since this fixed card lives inside
          that transformed container it gets dragged up too. Add inset/2 back so the card lands
          centered in the area ABOVE the keyboard — high enough not to be covered, no higher. */}
      <div
        className="settings-card"
        style={{ transform: `translate(-50%, calc(-50% + ${inset / 2}px))` }}
        role="dialog" aria-label={t('bind.title')} aria-modal="true"
      >
        <div className="settings-head">
          <span className="settings-title">{t('bind.title')}</span>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="settings-section">
          <div className="opt">
            <div className="settings-label">{t('bind.pickSession')}</div>
            <div className="orphan-targets">
              <button className="fontbtn" aria-pressed={target === 'new'} onClick={() => { setTarget('new'); setError(''); }}>
                {t('bind.newSession')}
              </button>
              {avail.map((s) => (
                <button
                  key={s.id || s.name}
                  className="fontbtn"
                  aria-pressed={target === s.name}
                  onClick={() => { setTarget(s.name); setError(''); }}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          {target === 'new' && (
            <>
              <div className="opt">
                <div className="settings-label">{t('bind.sessionName')}</div>
                <input
                  ref={inputRef}
                  className="bind-input"
                  value={name}
                  placeholder={t('bind.namePlaceholder')}
                  onChange={(e) => { setName(e.target.value); setError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                />
              </div>
              <div className="opt">
                <div className="settings-label">{t('bind.startDir')}</div>
                <button type="button" className="field cwd-field" onClick={() => setPickerOpen(true)}>
                  <span className="cwd-path">{cwd || t('bind.homeDirDefault')}</span>
                  <span className="cwd-action">{t('bind.choose')}</span>
                </button>
                {cwd && <button type="button" className="cwd-reset" onClick={() => setCwd(null)}>{t('bind.reset')}</button>}
              </div>
              <div className="opt">
                <StartupCmdPicker value={cmd} onChange={setCmd} />
              </div>
            </>
          )}
          {error && <div className="bind-error">{error}</div>}
          {/* Teach the reverse direction right where sessions are born: any session here (incl. ones
              created from the phone) is one command away on the computer. */}
          <div className="settings-hint">{t('bind.desktopHint')}</div>
          <div className="settings-btns bind-actions">
            <button className="fontbtn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="fontbtn bind-confirm" onClick={submit} disabled={busy || !target}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
      <DirPicker
        open={pickerOpen}
        seedCwd={cwd}
        allowMkdir
        onPick={(p) => { setCwd(p); setPickerOpen(false); }}
        onClose={() => setPickerOpen(false)}
        inset={inset}
      />
    </>
  );
}
