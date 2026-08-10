import { useEffect, useRef, useState } from 'react';
import { getSessions, createSession, UnauthorizedError } from '../api.js';
import { getLastStartupCmd, setLastStartupCmd } from '../storage.js';
import { t } from '../i18n';
import DirPicker from './DirPicker.jsx';
import StartupCmdPicker from './StartupCmdPicker.jsx';
import { useBackButton } from '../hooks/useBackButton.js';

// Mirrors the server's isValidSessionName: letters, digits, hyphens, 1-16 chars. Applied only when
// CREATING a session — binding picks from a list of existing names (which may contain spaces), so no
// regex is needed on that path.
const NEW_NAME_RE = /^[A-Za-z0-9-]{1,16}$/;

type BindMode = 'new' | 'existing';

interface HostSession {
  id?: string;
  name: string;
}

export interface BindSessionProps {
  open: boolean;
  onClose: () => void;
  onBound: (name: string) => void | Promise<void>;
  bound: readonly string[];
  onAuthFail?: () => void;
  inset?: number;
}

const parseSessions = (value: unknown): HostSession[] => {
  if (!Array.isArray(value)) throw new Error('Sessions API returned an invalid response');
  return value.map((entry): HostSession => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Sessions API returned an invalid entry');
    }
    const session = entry as Record<string, unknown>;
    if (typeof session.name !== 'string' || !(session.id === undefined || typeof session.id === 'string')) {
      throw new Error('Sessions API returned an invalid entry');
    }
    return {
      name: session.name,
      ...(typeof session.id === 'string' ? { id: session.id } : {}),
    };
  });
};

const startupCommand = (): string => {
  const value: unknown = getLastStartupCmd();
  return typeof value === 'string' ? value : '';
};

// Bind a session by PICKING it. Instead of typing a name, we list the sessions that exist on the host
// and aren't already bound on this device (a fontbtn group, per project convention — no native <select>).
// A "＋ new" entry flips the card into create mode: name + start dir + startup command, then create+open.
export default function BindSession({ open, onClose, onBound, bound, onAuthFail, inset = 0 }: BindSessionProps) {
  const [sessions, setSessions] = useState<HostSession[]>([]);
  const [mode, setMode] = useState<BindMode>('new');
  const [target, setTarget] = useState<string | null>(null); // null · 'new' · existing name
  const [name, setName] = useState('');        // new-session name (create mode)
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cwd, setCwd] = useState<string | null>(null);
  const [cmd, setCmd] = useState<string>(startupCommand); // command for a newly-created session
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setName(''); setError(''); setBusy(false); setCwd(null); setPickerOpen(false);
    setMode('new'); setTarget('new'); // provisional; flips to "existing" below if there are bindable sessions
    getSessions()
      .then((response) => {
        const list = parseSessions(response);
        if (cancelled) return;
        setSessions(list);
        // Default to picking an existing session when there is one to bind (that's the common case);
        // fall back to create mode only when nothing is bindable.
        if (list.some((x) => !bound.includes(x.name))) { setMode('existing'); setTarget(null); }
      })
      .catch((caught) => {
        if (cancelled) return;
        if (caught instanceof UnauthorizedError) onAuthFail?.(); else setError(t('bind.checkFailed'));
      });
    return () => { cancelled = true; };
  }, [open]);

  // Focus the name field the moment we enter create mode so the soft keyboard pops right up.
  useEffect(() => {
    if (target !== 'new') return undefined;
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [target]);
  useBackButton(open && pickerOpen, () => setPickerOpen(false));

  if (!open) return null;

  const avail = sessions.filter((s) => !bound.includes(s.name)); // 已绑定的不再展示

  const submit = async (): Promise<void> => {
    if (busy || !target) return;

    // Existing session picked → it already exists, just open it (spaced names welcome).
    if (target !== 'new') { void onBound(target); return; }

    // Create mode: validate, create, then open.
    const n = name.trim();
    if (!n) return;
    if (bound.includes(n) || sessions.some((s) => s.name === n)) { setError(t('bind.alreadyExists')); return; }
    if (!NEW_NAME_RE.test(n)) { setError(t('bind.invalidName')); return; }
    setBusy(true); setError('');
    setLastStartupCmd(cmd); // remember the launcher for next time
    try {
      await createSession(n, cwd || undefined, cmd || undefined);
      void onBound(n); // session is now live → bindSession/selectSession opens it
    } catch (caught) {
      if (caught instanceof UnauthorizedError) onAuthFail?.();
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
            {/* New-vs-existing is a genuine either/or MODE, so it's a segmented control — not a row of
                pills that each read like a fire-now action ("＋ New session" used to look tappable-to-create). */}
            <div className="bind-mode" role="tablist" aria-label={t('bind.pickSession')}>
              <button
                className="seg" role="tab" aria-pressed={mode === 'new'}
                onClick={() => { setMode('new'); setTarget('new'); setError(''); }}
              >
                {t('bind.modeNew')}
              </button>
              <button
                className="seg" role="tab" aria-pressed={mode === 'existing'} disabled={!avail.length}
                onClick={() => { setMode('existing'); setTarget(null); setError(''); }}
              >
                {t('bind.modeExisting')}
              </button>
            </div>
          </div>
          {mode === 'existing' && (
            <div className="opt">
              <div className="settings-label">{t('bind.pickSession')}</div>
              <div className="orphan-targets">
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
          )}
          {mode === 'new' && (
            <>
              <div className="opt">
                <div className="settings-label">{t('bind.sessionName')}</div>
                <input
                  ref={inputRef}
                  className="bind-input"
                  value={name}
                  placeholder={t('bind.invalidName')}
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
